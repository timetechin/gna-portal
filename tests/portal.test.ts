import { beforeAll, afterAll, test, expect } from "bun:test";
import { SQL } from "bun";
const connection =
  Bun.env.GNA_TEST_DATABASE_URL ||
  "postgresql://postgres@127.0.0.1:55432/gna_test";
const url = new URL(connection);
if (
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
  url.pathname !== "/gna_test"
)
  throw Error("Tests require the dedicated loopback gna_test database");
const db = new SQL(connection);
let server,
  adminCookie = "",
  dealerCookie = "",
  originalItems,
  account1,
  account2;
const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
const testPort = String(reservation.port);
reservation.stop(true);
const base = "http://127.0.0.1:" + testPort;
async function api(path, method = "GET", body?, cookie = adminCookie) {
  const r = await fetch(base + "/api/" + path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json(), headers: r.headers };
}
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + "/health");
      if (r.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw Error("Server startup failed");
}
const hash = async (s) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
  ).toString("hex");
beforeAll(async () => {
  await db.unsafe("DROP SCHEMA public CASCADE");
  await db.unsafe("CREATE SCHEMA public");
  // Legacy records exist before the new additive migration.
  await db.unsafe(
    "CREATE TABLE gna_items(id bigserial primary key,serial text not null,shop text not null,product text,invoice text,price numeric default 0,shipped text,paid_on text,campaign text,sold text,unique(serial,shop))",
  );
  await db.unsafe(
    "CREATE TABLE gna_users(username text primary key,shop text not null,role text not null,salt text not null,password_hash text not null)",
  );
  for (const [username, shop, role] of [
    ["admin", "Tekinler Yönetim", "admin"],
    ["dealer", "Girne Çarşı", "dealer"],
  ])
    await db.unsafe("INSERT INTO gna_users VALUES($1,$2,$3,$4,$5)", [
      username,
      shop,
      role,
      "fixture",
      await hash("fixturetest-password-123"),
    ]);
  await db.unsafe(
    "INSERT INTO gna_items(serial,shop,product,price,paid_on,campaign,invoice,shipped,sold) VALUES ('G1','Girne Çarşı','Telefon A',100,'2026-10-01','Tarifeye Ek','INV1','2026-09-01','2026-09-30'),('Y1','Yenikent','Telefon B',200,NULL,'Peşin Satış','INV2','2026-09-02','2026-10-02'),('Y2','Yenikent','Telefon C',300,NULL,NULL,NULL,NULL,NULL)",
  );
  originalItems = JSON.parse(
    JSON.stringify(await db.unsafe("SELECT * FROM gna_items ORDER BY id")),
  );
  server = Bun.spawn([process.execPath, "src/server.ts"], {
    env: {
      ...Bun.env,
      DATABASE_URL: connection,
      PORT: testPort,
      ADMIN_BOOTSTRAP_PASSWORD: "",
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  await waitReady();
  for (const username of ["admin", "dealer"]) {
    const r = await api(
      "login",
      "POST",
      { username, password: "test-password-123" },
      "",
    );
    expect(r.status).toBe(200);
    const cookie = r.headers.get("set-cookie")!.split(";")[0];
    if (username === "admin") adminCookie = cookie;
    else dealerCookie = cookie;
  }
}, 15000);
afterAll(async () => {
  server?.kill();
  if (server) await server.exited;
  await db.close();
});
test("legacy identities and complete item records survive startup", async () => {
  expect(
    JSON.parse(
      JSON.stringify(await db.unsafe("SELECT * FROM gna_items ORDER BY id")),
    ),
  ).toEqual(originalItems);
  expect((await api("me")).data.username).toBe("admin");
  expect(
    (await api("me", "GET", undefined, "other=value; " + adminCookie)).status,
  ).toBe(200);
});
test("unauthenticated access is rejected and dealers see only their own products", async () => {
  expect((await api("items", "GET", undefined, "")).status).toBe(401);
  const r = await api("items", "GET", undefined, dealerCookie);
  expect(r.status).toBe(200);
  expect(r.data.map((x) => x.shop)).toEqual(["Girne Çarşı"]);
  expect((await api("aliases", "GET", undefined, dealerCookie)).status).toBe(
    200,
  );
});
test("create main accounts, prevent duplicate names, and log administrator", async () => {
  let r = await api("accounts", "POST", { name: "Ortak Ana Cari" });
  expect(r.status).toBe(201);
  account1 = r.data.id;
  r = await api("accounts", "POST", { name: "Diğer Cari" });
  account2 = r.data.id;
  expect(
    (await api("accounts", "POST", { name: "ortak ana cari" })).status,
  ).toBe(409);
  expect(
    (await api("audit")).data.some(
      (x) => x.action === "account.create" && x.username === "admin",
    ),
  ).toBe(true);
});
test("Girne Çarşı and Yenikent share a main account with accurate sums", async () => {
  for (const shop of ["Girne Çarşı", "Yenikent"])
    expect(
      (await api("dealer-accounts", "PUT", { shop, account_id: account1 }))
        .status,
    ).toBe(200);
  const a = (await api("accounts")).data.find(
    (a) => String(a.id) === String(account1),
  );
  expect(a.dealer_count).toBe(2);
  expect(a.product_count).toBe(3);
  expect(a.sale_count).toBe(2);
  expect(a.payment_count).toBe(1);
  expect(Number(a.product_total)).toBe(600);
  expect(Number(a.sales_total)).toBe(300);
  expect(Number(a.payments_total)).toBe(100);
  expect(Number(a.receivable_total)).toBe(100);
});
test("non-admin cannot manage accounts, read other customer cards or view audit", async () => {
  for (const path of ["accounts", "dealer-accounts", "audit", "customers"])
    expect((await api(path, "GET", undefined, dealerCookie)).status).toBe(403);
  expect(
    (
      await api(
        "dealer-accounts",
        "PUT",
        { shop: "Yenikent", account_id: null },
        dealerCookie,
      )
    ).status,
  ).toBe(403);
  expect(
    (await api("accounts", "POST", { name: "Forbidden" }, dealerCookie)).status,
  ).toBe(403);
  expect(
    (await api("customers/import", "POST", { rows: [] }, dealerCookie)).status,
  ).toBe(403);
});
test("move and detach dealers without touching any existing item", async () => {
  expect(
    (
      await api("dealer-accounts", "PUT", {
        shop: "Yenikent",
        account_id: account2,
      })
    ).data.changed,
  ).toBe(true);
  let a = (await api("accounts")).data.find(
    (a) => String(a.id) === String(account1),
  );
  expect(a.product_count).toBe(1);
  expect(Number(a.receivable_total)).toBe(100);
  expect(
    (
      await api("dealer-accounts", "PUT", {
        shop: "Yenikent",
        account_id: null,
      })
    ).data.changed,
  ).toBe(true);
  expect((await api("dealer-accounts")).data.map((x) => x.shop)).toEqual([
    "Girne Çarşı",
  ]);
  expect(
    JSON.parse(
      JSON.stringify(await db.unsafe("SELECT * FROM gna_items ORDER BY id")),
    ),
  ).toEqual(originalItems);
  const log = (await api("audit")).data.find(
    (x) =>
      x.action === "dealer.account.change" && x.details.new_account_id === null,
  );
  expect(log.details.shop).toBe("Yenikent");
  expect(String(log.details.old_account_id)).toBe(String(account2));
});
test("invalid link changes leave data and audit unchanged; repeated assignment is a no-op", async () => {
  const before = (await api("audit")).data.length;
  expect(
    (
      await api("dealer-accounts", "PUT", {
        shop: "Girne Çarşı",
        account_id: "999999",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await api("dealer-accounts", "PUT", {
        shop: "Nonexistent",
        account_id: account1,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await api("dealer-accounts", "PUT", {
        shop: "Girne Çarşı",
        account_id: account1,
      })
    ).data.changed,
  ).toBe(false);
  expect((await api("audit")).data.length).toBe(before);
});
test("customer imports preserve leading zeros, deduplicate and report conflicting names", async () => {
  const row = {
    code: "001234",
    short_name: "Müşteri A",
    title: "Müşteri A Ltd.",
  };
  let r = await api("customers/import", "POST", {
    filename: "279663.xlsx",
    rows: [
      row,
      row,
      { code: "0002", short_name: "Müşteri B", title: "B Ltd." },
    ],
  });
  expect(r.data).toEqual({ added: 2, skipped: 1, conflicts: [] });
  r = await api("customers/import", "POST", {
    filename: "279663.xlsx",
    rows: [row, { ...row, title: "Changed" }],
  });
  expect(r.data.added).toBe(0);
  expect(r.data.skipped).toBe(2);
  expect(r.data.conflicts).toEqual(["001234"]);
  const cards = (await api("customers")).data;
  expect(cards).toHaveLength(2);
  expect(cards.find((c) => c.code === "001234").title).toBe(row.title);
});
test("invalid customer batches do not partially import", async () => {
  const before = (await api("customers")).data;
  expect(
    (
      await api("customers/import", "POST", {
        rows: [
          { code: "new", short_name: "Valid", title: "Valid Ltd." },
          { code: 123, short_name: "Bad", title: "Bad" },
        ],
      })
    ).status,
  ).toBe(400);
  expect((await api("customers")).data).toEqual(before);
});
test("existing stock, payment and activation imports still work", async () => {
  expect(
    (
      await api("import", "POST", {
        kind: "stock",
        filename: "stock.xlsx",
        rows: [
          { serial: "NEW", shop: "Yenikent", product: "Telefon D", price: 400 },
        ],
      })
    ).data.added,
  ).toBe(1);
  expect(
    (
      await api("import", "POST", {
        kind: "payment",
        filename: "paid.xlsx",
        rows: [{ serial: "NEW", paid_on: "2026-10-12" }],
      })
    ).data.added,
  ).toBe(1);
  expect(
    (
      await api("import", "POST", {
        kind: "activation",
        filename: "activation.xlsx",
        rows: [{ serial: "NEW", campaign: "Tarifeye Ek" }],
      })
    ).data.added,
  ).toBe(1);
  const row = (await api("items")).data.find((x) => x.serial === "NEW");
  expect(row.paid_on).toBe("2026-10-12");
  expect(row.campaign).toBe("Tarifeye Ek");
});
test("migration is repeatable without altering existing customer or dealer data", async () => {
  const before = JSON.parse(
    JSON.stringify(await db.unsafe("SELECT * FROM gna_items ORDER BY id")),
  );
  server.kill();
  await server.exited;
  server = Bun.spawn([process.execPath, "src/server.ts"], {
    env: { ...Bun.env, DATABASE_URL: connection, PORT: testPort },
    stdout: "ignore",
    stderr: "inherit",
  });
  await waitReady();
  expect(
    JSON.parse(
      JSON.stringify(await db.unsafe("SELECT * FROM gna_items ORDER BY id")),
    ),
  ).toEqual(before);
  expect((await api("customers")).data).toHaveLength(2);
  expect((await api("dealer-accounts")).data).toHaveLength(1);
});
