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
  originalItems = originalItems.map((row) => ({ ...row, vf_paid_on: null }));
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
  expect(r.data).toMatchObject({ added: 2, skipped: 1, conflicts: [] });
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

test("directory shows main accounts and each accessible sub-dealer without cross-dealer leakage", async () => {
  const admin = (await api("directory")).data;
  expect(admin.groups.some((g) => String(g.id) === String(account1))).toBe(
    true,
  );
  expect(admin.dealers.find((d) => d.shop === "Girne Çarşı").account_id).toBe(
    String(account1),
  );
  const own = (await api("directory", "GET", undefined, dealerCookie)).data;
  expect(own.dealers.map((d) => d.shop)).toEqual(["Girne Çarşı"]);
  expect(own.groups).toHaveLength(1);
});
test("multi-chunk upload has one file history and reverses all created serials atomically", async () => {
  const batch = (
    await api("uploads", "POST", { kind: "stock", filename: "multi.xlsx" })
  ).data.batch_id;
  for (const serial of ["UNDO-A", "UNDO-B"])
    expect(
      (
        await api("import", "POST", {
          kind: "stock",
          batch_id: batch,
          rows: [
            {
              serial,
              shop: "Yenikent",
              product: "Undo Phone",
              price: 100,
              shipped: "12.10.2026",
            },
          ],
        })
      ).data.added,
    ).toBe(1);
  expect((await api("uploads/" + batch + "/complete", "POST")).status).toBe(
    200,
  );
  const history = (await api("imports")).data.filter((h) => h.id === batch);
  expect(history).toHaveLength(1);
  expect(history[0].changed_count).toBe(2);
  const payment = (
    await api("import", "POST", {
      kind: "payment",
      filename: "after.xlsx",
      rows: [{ serial: "UNDO-A", paid_on: "2026-10-13" }],
    })
  ).data.batch_id;
  expect((await api("uploads/" + batch + "/undo", "POST")).status).toBe(409);
  expect(
    (await api("items")).data.filter((x) =>
      ["UNDO-A", "UNDO-B"].includes(x.serial),
    ),
  ).toHaveLength(2);
  expect((await api("uploads/" + payment + "/undo", "POST")).data.undone).toBe(
    1,
  );
  expect((await api("uploads/" + batch + "/undo", "POST")).data.undone).toBe(2);
  expect(
    (await api("items")).data.some(
      (x) => x.serial === "UNDO-A" || x.serial === "UNDO-B",
    ),
  ).toBe(false);
  expect(
    (await api("uploads/" + batch + "/undo", "POST")).data.already_reverted,
  ).toBe(true);
  expect(
    (await api("audit")).data.some(
      (a) => a.action === "upload.undo" && a.details.batch_id === batch,
    ),
  ).toBe(true);
});
test("activation corrects existing status and date; undo restores the exact earlier values", async () => {
  const before = (await api("items")).data.find((x) => x.serial === "G1");
  const r = await api("import", "POST", {
    kind: "activation",
    filename: "change.xlsx",
    rows: [{ serial: "G1", campaign: "Peşin Satış", sold: "14.10.2026" }],
  });
  expect(r.data.added).toBe(1);
  let row = (await api("items")).data.find((x) => x.serial === "G1");
  expect(row.campaign).toBe("Peşin Satış");
  expect(row.sold).toBe("2026-10-14");
  expect(
    (await api("uploads/" + r.data.batch_id + "/undo", "POST")).data.undone,
  ).toBe(2);
  row = (await api("items")).data.find((x) => x.serial === "G1");
  expect(row).toEqual(before);
});
test("acquisition date backfill does not alter price and is reversible", async () => {
  const before = (await api("items")).data.find((x) => x.serial === "Y2");
  const r = await api("import", "POST", {
    kind: "stock",
    rows: [
      {
        serial: "Y2",
        shop: "Yenikent",
        product: "Should not overwrite",
        price: 999,
        shipped: "2026-10-12",
      },
    ],
  });
  expect(r.data.added).toBe(1);
  const now = (await api("items")).data.find((x) => x.serial === "Y2");
  expect(now.shipped).toBe("2026-10-12");
  expect(now.price).toBe(before.price);
  expect(now.product).toBe(before.product);
  expect(
    (await api("uploads/" + r.data.batch_id + "/undo", "POST")).status,
  ).toBe(200);
  expect((await api("items")).data.find((x) => x.serial === "Y2")).toEqual(
    before,
  );
});
test("VDM then tariff activation then VF payment preserves serial history and permits independent reversal", async () => {
  const r = await api("import", "POST", {
    kind: "stock",
    rows: [
      {
        serial: "PIPE",
        shop: "Girne Çarşı",
        product: "Pipeline Phone",
        price: 120,
      },
    ],
  });
  const stock = r.data.batch_id;
  const payment = (
    await api("import", "POST", { kind: "payment", rows: [{ serial: "PIPE" }] })
  ).data.batch_id;
  let row = (await api("items")).data.find((x) => x.serial === "PIPE");
  expect(row.paid_on).toBe("Ödendi");
  const stockVf = await api("import", "POST", {kind:"vf_payment", rows:[{serial:"PIPE",paid_on:"2026-10-14"}]});
  expect(stockVf.data.added).toBe(1);
  expect((await api("items")).data.find(x=>x.serial==="PIPE").vf_paid_on).toBe("2026-10-14");
  expect((await api("uploads/"+stockVf.data.batch_id+"/undo","POST")).status).toBe(200);
  expect((await api("items")).data.find(x=>x.serial==="PIPE").vf_paid_on).toBeNull();
  const activation = (
    await api("import", "POST", {
      kind: "activation",
      rows: [{ serial: "PIPE", campaign: "Tarifeye Ek", sold: "2026-10-12" }],
    })
  ).data.batch_id;
  const vf = (
    await api("import", "POST", {
      kind: "vf_payment",
      rows: [{ serial: "PIPE", paid_on: "2026-10-15" }],
    })
  ).data.batch_id;
  row = (await api("items")).data.find((x) => x.serial === "PIPE");
  expect(row.vf_paid_on).toBe("2026-10-15");
  expect(row.campaign).toBe("Tarifeye Ek");
  expect(row.serial).toBe("PIPE");
  expect((await api("uploads/" + vf + "/undo", "POST")).status).toBe(200);
  expect(
    (await api("items")).data.find((x) => x.serial === "PIPE").vf_paid_on,
  ).toBeNull();
  expect((await api("uploads/" + activation + "/undo", "POST")).status).toBe(
    200,
  );
  expect((await api("uploads/" + payment + "/undo", "POST")).status).toBe(200);
  expect((await api("uploads/" + stock + "/undo", "POST")).status).toBe(200);
});
test("ambiguous serials are not paid indiscriminately across different dealers", async () => {
  const stock = (
    await api("import", "POST", {
      kind: "stock",
      rows: [
        {
          serial: "DUP",
          shop: "Girne Çarşı",
          product: "Same serial",
          price: 10,
        },
        { serial: "DUP", shop: "Yenikent", product: "Same serial", price: 10 },
      ],
    })
  ).data.batch_id;
  const r = await api("import", "POST", {
    kind: "payment",
    rows: [{ serial: "DUP" }],
  });
  expect(r.data.added).toBe(0);
  expect(r.data.skipped).toBe(1);
  expect(
    (await api("items")).data
      .filter((x) => x.serial === "DUP")
      .every((x) => x.paid_on === null),
  ).toBe(true);
  await api("uploads/" + stock + "/undo", "POST");
});
test("customer upload reversal removes only newly created cards and protects later manual edits", async () => {
  const r = await api("customers/import", "POST", {
    filename: "new-customers.xlsx",
    rows: [
      { code: "C-UNDO", short_name: "Undo Customer", title: "Undo Ltd." },
      { code: "001234", short_name: "Müşteri A", title: "Müşteri A Ltd." },
    ],
  });
  expect(r.data.added).toBe(1);
  await api("customers/C-UNDO", "PATCH", {
    short_name: "Changed",
    title: "Undo Ltd.",
    active: true,
  });
  expect(
    (await api("uploads/" + r.data.batch_id + "/undo", "POST")).status,
  ).toBe(409);
  await api("customers/C-UNDO", "PATCH", {
    short_name: "Undo Customer",
    title: "Undo Ltd.",
    active: true,
  });
  expect(
    (await api("uploads/" + r.data.batch_id + "/undo", "POST")).status,
  ).toBe(200);
  expect((await api("customers")).data.some((c) => c.code === "001234")).toBe(
    true,
  );
  expect((await api("customers")).data.some((c) => c.code === "C-UNDO")).toBe(
    false,
  );
});
test("settings rename and close accounts without changing historical item identities", async () => {
  const before = (await api("items")).data;
  expect(
    (
      await api("accounts/" + account1, "PATCH", {
        name: "Renamed Account",
        active: false,
      })
    ).status,
  ).toBe(200);
  expect(
    (await api("directory")).data.groups.find(
      (g) => String(g.id) === String(account1),
    ).active,
  ).toBe(false);
  expect(
    (
      await api("dealer-accounts", "PUT", {
        shop: "Yenikent",
        account_id: account1,
      })
    ).status,
  ).toBe(404);
  await api("accounts/" + account1, "PATCH", {
    name: "Ortak Ana Cari",
    active: true,
  });
  expect(
    (
      await api("dealer-profiles", "PUT", {
        shop: "Yenikent",
        display_name: "Yenikent Şubesi",
        active: false,
      })
    ).status,
  ).toBe(200);
  expect((await api("items")).data).toEqual(before);
  await api("dealer-profiles", "PUT", {
    shop: "Yenikent",
    display_name: "Yenikent",
    active: true,
  });
  expect(
    (
      await api("dealer-profiles", "PUT", {
        shop: "Empty Shop",
        display_name: "New Empty Shop",
        active: true,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await api("dealer-accounts", "PUT", {
        shop: "Empty Shop",
        account_id: account2,
      })
    ).status,
  ).toBe(200);
});
test("pricing calculates cash margin and tariff unit profit by activation month", async () => {
  expect(
    (
      await api("prices", "PUT", {
        product: "Telefon A",
        purchase_price: 100,
        cash_sale_price: 160,
        tariff_profit: 25,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await api("prices", "PUT", {
        product: "Telefon B",
        purchase_price: null,
        cash_sale_price: 260,
        tariff_profit: 35,
      })
    ).status,
  ).toBe(200);
  let r = (
    await api(
      "profitability?shop=" +
        encodeURIComponent("Girne Çarşı") +
        "&month=2026-09",
    )
  ).data;
  expect(r.totals.profit_total).toBe("25.00");
  expect(r.rows.map((x) => x.serial)).toEqual(["G1"]);
  expect(r.months).toContain("2026-09");
  r = (await api("profitability?shop=Yenikent&month=2026-10")).data;
  expect(r.totals.profit_total).toBe("60.00");
  expect(r.totals.missing_price_count).toBe(0);
  expect(r.undated_count).toBe(1); // existing NEW sale has no activation date
  expect(
    (await api("profitability?shop=Yenikent", "GET", undefined, dealerCookie))
      .status,
  ).toBe(403);
  expect(
    (
      await api(
        "profitability?shop=" +
          encodeURIComponent("Girne Çarşı") +
          "&month=2026-13",
      )
    ).status,
  ).toBe(400);
});
test("undated sales and missing prices are reported instead of fabricated profit", async () => {
  const stock = (
    await api("import", "POST", {
      kind: "stock",
      rows: [
        {
          serial: "NO-DATE",
          shop: "Girne Çarşı",
          product: "No pricing",
          price: 10,
        },
      ],
    })
  ).data.batch_id;
  const act = (
    await api("import", "POST", {
      kind: "activation",
      rows: [{ serial: "NO-DATE", campaign: "Tarifeye Ek" }],
    })
  ).data.batch_id;
  const r = (
    await api("profitability?shop=" + encodeURIComponent("Girne Çarşı"))
  ).data;
  expect(r.undated_count).toBe(1);
  expect(r.totals.missing_price_count).toBe(1);
  expect(r.rows.find((x) => x.serial === "NO-DATE").profit).toBeNull();
  expect(
    (
      await api(
        "profitability?shop=" +
          encodeURIComponent("Girne Çarşı") +
          "&month=2026-09",
      )
    ).data.rows.some((x) => x.serial === "NO-DATE"),
  ).toBe(false);
  await api("uploads/" + act + "/undo", "POST");
  await api("uploads/" + stock + "/undo", "POST");
});
test("legacy uploads cannot be guessed and new management/undo routes require administrator", async () => {
  await db.unsafe(
    "INSERT INTO gna_upload_history(kind,filename) VALUES('stock','old-history.xlsx')",
  );
  const history = (await api("imports")).data.find(
    (r) => r.filename === "old-history.xlsx",
  );
  expect(history.reversible).toBe(false);
  expect((await api("uploads/" + history.id + "/undo", "POST")).status).toBe(
    409,
  );
  for (const [path, method, body] of [
    ["accounts/" + account1, "PATCH", { name: "No", active: false }],
    [
      "prices",
      "PUT",
      { product: "X", purchase_price: 1, cash_sale_price: 2, tariff_profit: 3 },
    ],
    ["dealer-profiles", "PUT", { shop: "X", display_name: "X", active: true }],
    ["uploads", "POST", { kind: "stock", filename: "no.xlsx" }],
    ["imports", "GET", undefined],
  ])
    expect(
      (await api(path as string, method as string, body, dealerCookie)).status,
    ).toBe(403);
});
test("unreadable dates do not block activation or erase existing dates; conflicting campaigns remain atomic", async () => {
  const before = (await api("items")).data.find(x => x.serial === "G1");
  const r = await api("import", "POST", {
    kind: "activation", rows: [{serial:"G1", campaign:"Peşin Satış", sold:"2026-02-30"}],
  });
  expect(r.status).toBe(200);
  expect(r.data.issues[0].reason).toContain("Tarih okunamadı");
  const changed = (await api("items")).data.find(x => x.serial === "G1");
  expect(changed.sold).toBe(before.sold);
  expect(changed.campaign).toBe("Peşin Satış");
  expect((await api("import", "POST", {kind:"activation",rows:[
    {serial:"G1",campaign:"Tarifeye Ek"},{serial:"G1",campaign:"Peşin Satış"}
  ]})).status).toBe(409);
  expect((await api("items")).data.find(x=>x.serial==="G1")).toEqual(changed);
  expect((await api("uploads/"+r.data.batch_id+"/undo","POST")).status).toBe(200);
});
test("common Excel dates are normalized automatically and stay reversible", async () => {
  for (const [input, expected] of [["12/10/2026 14:30","2026-10-12"],["12-10-26","2026-10-12"],["2026/10/12","2026-10-12"],["12 Ekim 2026","2026-10-12"],["12 Şubat 2026","2026-02-12"],["46307,9999","2026-10-12"]]) {
    const before=(await api("items")).data.find(x=>x.serial==="G1");
    const r=await api("import","POST",{kind:"activation",rows:[{serial:"G1",campaign:"Peşin Satış",sold:input}]});
    expect(r.status).toBe(200);
    expect((await api("items")).data.find(x=>x.serial==="G1").sold).toBe(expected);
    expect((await api("uploads/"+r.data.batch_id+"/undo","POST")).status).toBe(200);
    expect((await api("items")).data.find(x=>x.serial==="G1")).toEqual(before);
  }
});
test("optional prefix filter is enforced for the entire file and can be disabled", async () => {
  const batch = (
    await api("uploads", "POST", {
      kind: "stock",
      filename: "prefix.xlsx",
      only_prefix_2: true,
    })
  ).data.batch_id;
  const r = await api("import", "POST", {
    kind: "stock",
    batch_id: batch,
    only_prefix_2: false,
    rows: [
      {
        serial: "212345",
        shop: "Girne Çarşı",
        product: "Prefix Phone",
        price: 10,
      },
      {
        serial: "912345",
        shop: "Girne Çarşı",
        product: "Other Phone",
        price: 10,
      },
    ],
  });
  expect(r.data.added).toBe(1);
  expect(r.data.skipped).toBe(1);
  await api("uploads/" + batch + "/complete", "POST");
  expect((await api("items")).data.some((x) => x.serial === "912345")).toBe(
    false,
  );
  expect(
    (await api("imports")).data.find((x) => x.id === batch).only_prefix_2,
  ).toBe(true);
  await api("uploads/" + batch + "/undo", "POST");
  const all = await api("import", "POST", {
    kind: "stock",
    only_prefix_2: false,
    rows: [
      {
        serial: "912345",
        shop: "Girne Çarşı",
        product: "Other Phone",
        price: 10,
      },
    ],
  });
  expect(all.data.added).toBe(1);
  await api("uploads/" + all.data.batch_id + "/undo", "POST");
});

test("only admins create users with validated roles and passwords never appear in lists", async () => {
  expect((await api("users","POST",{username:"unauthorized",shop:"Girne Çarşı",password:"test-password-123",role:"admin"},dealerCookie)).status).toBe(403);
  expect((await api("users","POST",{username:"badrole",shop:"Girne Çarşı",password:"test-password-123",role:"owner"})).status).toBe(400);
  for(const role of ["dealer","admin"]) {
    const username="new-"+role;
    expect((await api("users","POST",{username,shop:"Girne Çarşı",password:"test-password-123",role})).status).toBe(200);
    const login=await api("login","POST",{username,password:"test-password-123"},"");
    expect(login.status).toBe(200);
    const cookie=login.headers.get("set-cookie").split(";")[0];
    expect((await api("me","GET",undefined,cookie)).data.role).toBe(role);
    expect((await api("users","GET",undefined,cookie)).status).toBe(role==="admin"?200:403);
  }
  const users=(await api("users")).data;
  expect(users.find(x=>x.username==="new-admin")).toEqual({username:"new-admin",shop:"Girne Çarşı",role:"admin"});
  expect(JSON.stringify(users)).not.toContain("test-password-123");
});

test("admins edit old users, retain blank passwords, invalidate sessions and protect the final admin",async()=>{
  const draft=(await api("users")).data.find(x=>x.pending&&x.shop==="Yenikent");expect(draft.pending).toBe(true);
  const body={original_username:"new-dealer",username:"edited-dealer",shop:"Yenikent",role:"admin",password:""};
  expect((await api("users","PATCH",body,dealerCookie)).status).toBe(403);
  expect((await api("users","PATCH",body)).status).toBe(200);
  const login=await api("login","POST",{username:"edited-dealer",password:"test-password-123"},"");expect(login.status).toBe(200);
  const cookie=login.headers.get("set-cookie").split(";")[0];expect((await api("me","GET",undefined,cookie)).data.role).toBe("admin");
  expect((await api("users","PATCH",{...body,original_username:"edited-dealer",password:"changed-password-123",role:"dealer"})).status).toBe(200);
  expect((await api("me","GET",undefined,cookie)).status).toBe(401);
  expect((await api("login","POST",{username:"edited-dealer",password:"test-password-123"},"")).status).toBe(401);
  expect((await api("login","POST",{username:"edited-dealer",password:"changed-password-123"},"")).status).toBe(200);
  await api("users","PATCH",{original_username:"new-admin",username:"new-admin",shop:"Girne Çarşı",role:"dealer"});
  expect((await api("users","PATCH",{original_username:"admin",username:"admin",shop:"Tekinler Yönetim",role:"dealer"})).status).toBe(409);
});
test("all unmatched serials are returned for complete Excel error reports",async()=>{
  const r=await api("import","POST",{kind:"payment",rows:Array.from({length:125},(_,i)=>({serial:"missing-"+i,source_row:i+2}))});
  expect(r.status).toBe(200);expect(r.data.issues.length).toBe(125);expect(r.data.issues[124]).toEqual({serial:"missing-124",reason:"Seri bulunamadı",row:126});
});

test("bulk prices validate the whole list before atomically saving and reject dealers",async()=>{
 const rows=[{product:"Bulk A",purchase_price:100,cash_sale_price:150,tariff_profit:20},{product:"Bulk B",purchase_price:50,cash_sale_price:90,tariff_profit:10}];
 expect((await api("prices/bulk","PUT",{rows},dealerCookie)).status).toBe(403);
 expect((await api("prices/bulk","PUT",{rows:[rows[0],{...rows[1],purchase_price:-1}]})).status).toBe(400);
 expect((await api("prices")).data.some(x=>x.product==="Bulk A")).toBe(false);
 expect((await api("prices/bulk","PUT",{rows})).data.saved).toBe(2);
 expect(Number((await api("prices")).data.find(x=>x.product==="Bulk B").tariff_profit)).toBe(10);
});
test("main account users see only their linked shops, with membership changes enforced immediately",async()=>{
 const stock=await api("import","POST",{kind:"stock",rows:["Scope A","Scope B","Scope Outside"].map((shop,i)=>({serial:"2SCOPE-"+i,shop,product:"Scope Phone",price:10}))});
 const parent=(await api("accounts","POST",{name:"Scope Parent"})).data.id;
 for(const shop of ["Scope A","Scope B"])expect((await api("dealer-accounts","PUT",{shop,account_id:parent})).status).toBe(200);
 expect((await api("users","POST",{username:"scope-parent",shop:"Scope Parent",account_id:parent,role:"dealer",password:"test-password-123"})).status).toBe(200);
 const logged=await api("login","POST",{username:"scope-parent",password:"test-password-123"},"");
 const cookie=logged.headers.get("set-cookie").split(";")[0];
 expect((await api("items","GET",undefined,cookie)).data.map(x=>x.shop).sort()).toEqual(["Scope A","Scope B"]);
 expect((await api("directory","GET",undefined,cookie)).data.groups.length).toBe(1);
 expect((await api("profitability?shop=Scope Outside","GET",undefined,cookie)).status).toBe(403);
 expect((await api("users","GET",undefined,cookie)).status).toBe(403);
 await api("dealer-accounts","PUT",{shop:"Scope B",account_id:null});
 expect((await api("items","GET",undefined,cookie)).data.map(x=>x.shop)).toEqual(["Scope A"]);
 await api("accounts/"+parent,"PATCH",{name:"Scope Parent",active:false});
 expect((await api("items","GET",undefined,cookie)).data).toEqual([]);
 await db.unsafe("DELETE FROM gna_sessions WHERE username='scope-parent'");await db.unsafe("DELETE FROM gna_users WHERE username='scope-parent'");await db.unsafe("DELETE FROM gna_dealer_accounts WHERE account_id=$1",[parent]);await db.unsafe("DELETE FROM gna_main_accounts WHERE id=$1",[parent]);
 expect((await api("uploads/"+stock.data.batch_id+"/undo","POST")).status).toBe(200);
});
test("admin preview is scoped to a dealer and cannot write, while dealer headers cannot widen access",async()=>{
 const request=async(path,method="GET",cookie=adminCookie,header={"x-gna-preview-shop":encodeURIComponent("Girne Çarşı")},body=undefined)=>{const r=await fetch(base+"/api/"+path,{method,headers:{Cookie:cookie,"content-type":"application/json",...header},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 expect((await request("me")).data.role).toBe("dealer");
 expect((await request("items")).data.every(x=>x.shop==="Girne Çarşı")).toBe(true);
 expect((await request("prices/bulk","PUT",adminCookie,undefined,{rows:[]})).status).toBe(403);
 expect((await request("items","GET",dealerCookie,{"x-gna-preview-shop":encodeURIComponent("Yenikent")})).data.every(x=>x.shop==="Girne Çarşı")).toBe(true);
});
test("admins edit and delete product rows; dealer changes and duplicate serials are rejected",async()=>{
 const stock=await api("import","POST",{kind:"stock",rows:[{serial:"2MANUAL",shop:"Girne Çarşı",product:"Manual Phone",price:10,shipped:"2026-01-01"}]});
 const item=(await api("items")).data.find(x=>x.serial==="2MANUAL");
 const body={...item,price:25,product:"Edited Phone",campaign:"Peşin Satış",sold:"2026-10-12",paid:true,vf_paid:false};
 expect((await api("items/"+item.id,"PATCH",body,dealerCookie)).status).toBe(403);
 expect((await api("items/"+item.id,"PATCH",body)).status).toBe(200);
 expect((await api("uploads/"+stock.data.batch_id+"/undo","POST")).status).toBe(409);
 expect((await api("items")).data.find(x=>x.id===item.id).product).toBe("Edited Phone");
 expect((await api("items/"+item.id,"DELETE",undefined,dealerCookie)).status).toBe(403);
 expect((await api("items/"+item.id,"DELETE")).status).toBe(200);
 expect((await api("items")).data.some(x=>x.id===item.id)).toBe(false);
});

test("payment serial formatting is normalized and a supplied dealer resolves an ambiguous match",async()=>{
 const stock=await api("import","POST",{kind:"stock",rows:[{serial:"200000400020106",shop:"Pay A",product:"Payment Test",price:1},{serial:"200000400020106",shop:"Pay B",product:"Payment Test",price:1},{serial:"200 000 400020107",shop:"Pay A",product:"Payment Test",price:1}]});
 const payment=await api("import","POST",{kind:"payment",rows:[{serial:"'2.00000400020106E+14",shop:"Pay B",paid_on:"12.10.26"},{serial:"200000400020107.0",paid_on:""}]});
 expect(payment.status).toBe(200);expect(payment.data.added).toBe(2);
 const rows=(await api("items")).data;
 expect(rows.find(x=>x.shop==="Pay A"&&x.serial==="200000400020106").paid_on).toBe(null);
 expect(rows.find(x=>x.shop==="Pay B"&&x.serial==="200000400020106").paid_on).toBe("2026-10-12");
 expect(rows.find(x=>x.serial==="200 000 400020107").paid_on).toBe("Ödendi");
 expect((await api("uploads/"+payment.data.batch_id+"/undo","POST")).status).toBe(200);
 expect((await api("uploads/"+stock.data.batch_id+"/undo","POST")).status).toBe(200);
});

test("stock reuploads preserve legacy serial spelling and avoid duplicate products",async()=>{
 const stock=await api("import","POST",{kind:"stock",rows:[{serial:"200 000 400021000",shop:"Spacing Shop",product:"Spacing Phone",price:10}]});
 const refill=await api("import","POST",{kind:"stock",rows:[{serial:"200000400021000",shop:"Spacing Shop",product:"Changed Product",price:20,shipped:"2026-10-12"}]});
 const items=(await api("items")).data.filter(x=>x.shop==="Spacing Shop");expect(items.length).toBe(1);expect(items[0].serial).toBe("200 000 400021000");expect(Number(items[0].price)).toBe(10);expect(items[0].product).toBe("Spacing Phone");expect(items[0].shipped).toBe("2026-10-12");
 expect((await api("uploads/"+refill.data.batch_id+"/undo","POST")).status).toBe(200);
 expect((await api("uploads/"+stock.data.batch_id+"/undo","POST")).status).toBe(200);
});


test("list rules persist for all users, restrict writes to admins, and reject invalid full updates",async()=>{
 const initial=await api("list-settings");expect(initial.status).toBe(200);
 expect(initial.data.rules.paid.sales).toEqual(["stock","cash"]);
 expect(initial.data.rules.paid.showVodafone).toBe(false);
 const rules=structuredClone(initial.data.rules);rules.paid.sales=["stock"];rules.vf.sales=["stock","tariff"];
 expect((await api("list-settings","PUT",{rules},dealerCookie)).status).toBe(403);
 const badRules=structuredClone(rules);badRules.paid.vdm="invalid";
 expect((await api("list-settings","PUT",{rules:badRules})).status).toBe(400);
 expect((await api("list-settings")).data.rules).toEqual(initial.data.rules);
 expect((await api("list-settings","PUT",{rules})).status).toBe(200);
 expect((await api("list-settings","GET",undefined,dealerCookie)).data.rules).toEqual(rules);
 expect((await db.unsafe("SELECT rules FROM gna_list_settings WHERE id=1"))[0].rules).toEqual(rules);
 expect((await api("list-settings","PUT",{rules:initial.data.defaults})).status).toBe(200);
});
