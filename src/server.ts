import { SQL } from "bun";
const db = new SQL(Bun.env.DATABASE_URL);
const run = (q, p = []) => db.unsafe(q, p);
const digest = async (p) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(p)),
  ).toString("hex");
const secret = Bun.env.ADMIN_BOOTSTRAP_PASSWORD;
await run(
  "CREATE TABLE IF NOT EXISTS gna_users(username text primary key,shop text not null,role text not null,salt text not null,password_hash text not null)",
);
await run(
  "CREATE TABLE IF NOT EXISTS gna_sessions(tokenhash text primary key,username text not null,expires timestamptz not null)",
);
await run(
  "CREATE TABLE IF NOT EXISTS gna_items(id bigserial primary key,serial text not null,shop text not null,product text,invoice text,price numeric default 0,shipped text,paid_on text,campaign text,sold text,unique(serial,shop))",
);
await run(
  "CREATE TABLE IF NOT EXISTS gna_import_log(id bigserial primary key,kind text,filename text,added integer,skipped integer,username text,created_at timestamptz default now())",
);
await run(
  "CREATE TABLE IF NOT EXISTS gna_import_changes(upload_id bigint not null,item_id bigint not null,field text not null,old_value text,new_value text,primary key(upload_id,item_id,field))",
);
await run(
  "CREATE TABLE IF NOT EXISTS gna_shop_aliases(shop text not null,alias text unique not null)",
);
await run(
  "CREATE TABLE IF NOT EXISTS gna_upload_history(id bigserial primary key,kind text,filename text,created_at timestamptz default now())",
);
// Additive migration: existing GNA rows and identities remain unchanged.
await db.begin(async (tx) => {
  await tx.unsafe(
    "CREATE TABLE IF NOT EXISTS gna_main_accounts(id bigserial primary key,name text not null,created_at timestamptz not null default now())",
  );
  await tx.unsafe(
    "CREATE UNIQUE INDEX IF NOT EXISTS gna_main_accounts_name_unique ON gna_main_accounts(lower(name))",
  );
  await tx.unsafe(
    "CREATE TABLE IF NOT EXISTS gna_dealer_accounts(shop text primary key,account_id bigint not null references gna_main_accounts(id),updated_at timestamptz not null default now())",
  );
  await tx.unsafe(
    "CREATE INDEX IF NOT EXISTS gna_dealer_accounts_account_idx ON gna_dealer_accounts(account_id)",
  );
  await tx.unsafe(
    "CREATE TABLE IF NOT EXISTS gna_customers(code text primary key,short_name text not null,title text not null,created_at timestamptz not null default now())",
  );
  await tx.unsafe(
    "CREATE TABLE IF NOT EXISTS gna_audit_log(id bigserial primary key,username text not null,action text not null,details jsonb not null,created_at timestamptz not null default now())",
  );
});
if (!(await run("SELECT username FROM gna_users LIMIT 1")).length) {
  if (!secret) throw Error("Bootstrap password missing");
  const salt = crypto.randomUUID();
  await run("INSERT INTO gna_users VALUES($1,$2,$3,$4,$5)", [
    "admin",
    "Tekinler Yönetim",
    "admin",
    salt,
    await digest(salt + secret),
  ]);
}
const clean = (v, max = 200) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
const audit = (tx, u, action, details) =>
  tx.unsafe(
    "INSERT INTO gna_audit_log(username,action,details) VALUES($1,$2,$3::jsonb)",
    [u.username, action, details],
  );
const html = await Bun.file(
  new URL("../public/index.html", import.meta.url),
).text();
const out = (v, status = 200, headers = {}) =>
  new Response(JSON.stringify(v), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
const bad = (s, status = 400) => out({ error: s }, status);
async function actor(req) {
  const t = req.headers.get("cookie")?.match(/(?:^|;\s*)gna=([^;]+)/)?.[1];
  if (!t) return null;
  const a = await run(
    "SELECT u.username,u.shop,u.role FROM gna_sessions s JOIN gna_users u ON u.username=s.username WHERE s.tokenhash=$1 AND s.expires>now()",
    [await digest(t)],
  );
  return a[0] || null;
}
Bun.serve({
  port: Number(Bun.env.PORT || 3000),
  async fetch(req) {
    const path = new URL(req.url).pathname;
    try {
      if (path === "/")
        return new Response(html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      if (path === "/health") {
        await run("SELECT 1");
        return out({ ok: true, database: "connected" });
      }
      if (!path.startsWith("/api/")) return bad("Bulunamadı", 404);
      if (path === "/api/login" && req.method === "POST") {
        const b = await req.json();
        const a = await run("SELECT * FROM gna_users WHERE username=$1", [
          String(b.username || ""),
        ]);
        if (
          !a[0] ||
          a[0].password_hash !==
            (await digest(a[0].salt + String(b.password || "")))
        )
          return bad("Kullanıcı adı veya şifre hatalı", 401);
        const t = crypto.randomUUID() + crypto.randomUUID();
        await run(
          "INSERT INTO gna_sessions VALUES($1,$2,now()+interval '7 days')",
          [await digest(t), a[0].username],
        );
        return out({ ok: true }, 200, {
          "set-cookie":
            "gna=" +
            t +
            "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800",
        });
      }
      const u = await actor(req);
      if (!u) return bad("Oturum açmanız gerekiyor", 401);
      if (path === "/api/logout" && req.method === "POST") {
        const t = req.headers.get("cookie")?.match(/gna=([^;]+)/)?.[1];
        if (t)
          await run("DELETE FROM gna_sessions WHERE tokenhash=$1", [
            await digest(t),
          ]);
        return out({ ok: true }, 200, {
          "set-cookie":
            "gna=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
        });
      }
      if (path === "/api/me") return out(u);
      if (path === "/api/imports")
        return out(
          await run(
            "SELECT id,kind,filename,created_at FROM gna_upload_history ORDER BY id DESC LIMIT 100",
          ),
        );
      if (path === "/api/dealers" && req.method === "GET")
        return out(
          await run(
            u.role === "admin"
              ? "SELECT shop,count(*)::int AS count FROM gna_items GROUP BY shop ORDER BY shop"
              : "SELECT shop,count(*)::int AS count FROM gna_items WHERE shop=$1 GROUP BY shop ORDER BY shop",
            u.role === "admin" ? [] : [u.shop],
          ),
        );
      if (path === "/api/items")
        return out(
          await run(
            u.role === "admin"
              ? "SELECT * FROM gna_items ORDER BY id DESC"
              : "SELECT * FROM gna_items WHERE shop=$1 ORDER BY id DESC",
            u.role === "admin" ? [] : [u.shop],
          ),
        );
      if (path === "/api/aliases" && req.method === "GET")
        return out(
          await run(
            u.role === "admin"
              ? "SELECT shop,alias FROM gna_shop_aliases ORDER BY shop,alias"
              : "SELECT shop,alias FROM gna_shop_aliases WHERE shop=$1 ORDER BY alias",
            u.role === "admin" ? [] : [u.shop],
          ),
        );
      if (u.role !== "admin") return bad("Yönetici yetkisi gerekli", 403);
      if (path === "/api/aliases" && req.method === "GET")
        return out(
          await run(
            "SELECT shop,alias FROM gna_shop_aliases ORDER BY shop,alias",
          ),
        );
      if (path === "/api/aliases" && req.method === "POST") {
        const b = await req.json();
        const shop = String(b.shop || "").trim(),
          alias = String(b.alias || "").trim();
        if (!shop || !alias || shop.length > 200 || alias.length > 200)
          return bad("Bayi ve şube adı gerekli");
        if (
          !(await run("SELECT 1 FROM gna_items WHERE shop=$1 LIMIT 1", [shop]))
            .length
        )
          return bad("Bayi bulunamadı");
        if (
          (
            await run(
              "SELECT 1 FROM gna_items WHERE lower(shop)=lower($1) AND shop<>$2 LIMIT 1",
              [alias, shop],
            )
          ).length
        )
          return bad("Bu ad başka bir bayiye ait");
        await run(
          "INSERT INTO gna_shop_aliases(shop,alias) VALUES($1,$2) ON CONFLICT(alias) DO UPDATE SET shop=EXCLUDED.shop WHERE gna_shop_aliases.shop=EXCLUDED.shop",
          [shop, alias],
        );
        return out({ ok: true });
      }

      if (path === "/api/accounts" && req.method === "GET")
        return out(
          await run(`SELECT a.id,a.name,
 count(i.id)::int AS product_count, count(i.id) FILTER(WHERE i.campaign IS NOT NULL)::int AS sale_count,
 count(i.id) FILTER(WHERE i.paid_on IS NOT NULL)::int AS payment_count,
 coalesce(sum(i.price),0) AS product_total,
 coalesce(sum(i.price) FILTER(WHERE i.campaign IS NOT NULL),0) AS sales_total,
 coalesce(sum(i.price) FILTER(WHERE i.paid_on IS NOT NULL),0) AS payments_total,
 coalesce(sum(i.price) FILTER(WHERE i.paid_on IS NOT NULL AND i.campaign='Tarifeye Ek'),0) AS receivable_total,
 (SELECT count(*)::int FROM gna_dealer_accounts d WHERE d.account_id=a.id) AS dealer_count
 FROM gna_main_accounts a LEFT JOIN gna_dealer_accounts d ON d.account_id=a.id LEFT JOIN gna_items i ON i.shop=d.shop GROUP BY a.id ORDER BY a.name`),
        );
      if (path === "/api/dealer-accounts" && req.method === "GET")
        return out(
          await run(
            "SELECT d.shop,d.account_id,a.name AS account_name FROM gna_dealer_accounts d JOIN gna_main_accounts a ON a.id=d.account_id ORDER BY d.shop",
          ),
        );
      if (path === "/api/accounts" && req.method === "POST") {
        const b = await req.json(),
          name = clean(b.name);
        if (!name || String(b.name).trim().length > 200)
          return bad("Ana cari adı gerekli (en fazla 200 karakter)");
        const a = await db.begin(async (tx) => {
          const rows = await tx.unsafe(
            "INSERT INTO gna_main_accounts(name) VALUES($1) ON CONFLICT DO NOTHING RETURNING id,name",
            [name],
          );
          if (rows.length) await audit(tx, u, "account.create", rows[0]);
          return rows[0];
        });
        return a ? out(a, 201) : bad("Bu ana cari zaten mevcut", 409);
      }
      if (path === "/api/dealer-accounts" && req.method === "PUT") {
        const b = await req.json(),
          shop = clean(b.shop);
        const id = b.account_id;
        if (
          !shop ||
          String(b.shop).trim().length > 200 ||
          (id !== null && !/^[1-9][0-9]*$/.test(String(id)))
        )
          return bad("Geçerli bayi ve ana cari seçin");
        const result = await db.begin(async (tx) => {
          await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [shop]);
          if (
            !(
              await tx.unsafe("SELECT 1 FROM gna_items WHERE shop=$1 LIMIT 1", [
                shop,
              ])
            ).length
          )
            return { error: "Bayi bulunamadı", status: 404 };
          if (
            id !== null &&
            !(
              await tx.unsafe("SELECT 1 FROM gna_main_accounts WHERE id=$1", [
                id,
              ])
            ).length
          )
            return { error: "Ana cari bulunamadı", status: 404 };
          const old =
            (
              await tx.unsafe(
                "SELECT account_id FROM gna_dealer_accounts WHERE shop=$1",
                [shop],
              )
            )[0]?.account_id ?? null;
          if (String(old) === String(id)) return { ok: true, changed: false };
          if (id === null)
            await tx.unsafe("DELETE FROM gna_dealer_accounts WHERE shop=$1", [
              shop,
            ]);
          else
            await tx.unsafe(
              "INSERT INTO gna_dealer_accounts(shop,account_id) VALUES($1,$2) ON CONFLICT(shop) DO UPDATE SET account_id=EXCLUDED.account_id,updated_at=now()",
              [shop, id],
            );
          await audit(tx, u, "dealer.account.change", {
            shop,
            old_account_id: old,
            new_account_id: id,
          });
          return { ok: true, changed: true };
        });
        return result.error ? bad(result.error, result.status) : out(result);
      }
      if (path === "/api/audit" && req.method === "GET")
        return out(
          await run(
            "SELECT id,username,action,details,created_at FROM gna_audit_log ORDER BY id DESC LIMIT 200",
          ),
        );
      if (path === "/api/customers" && req.method === "GET")
        return out(
          await run(
            "SELECT code,short_name,title FROM gna_customers ORDER BY short_name,code",
          ),
        );
      if (path === "/api/customers/import" && req.method === "POST") {
        const b = await req.json();
        if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 10000)
          return bad("1–10.000 müşteri satırı gerekli");
        if (
          b.rows.some(
            (x) =>
              !x ||
              typeof x.code !== "string" ||
              !x.code.trim() ||
              x.code.trim().length > 100 ||
              typeof x.short_name !== "string" ||
              !x.short_name.trim() ||
              x.short_name.trim().length > 200 ||
              typeof x.title !== "string" ||
              !x.title.trim() ||
              x.title.trim().length > 500,
          )
        )
          return bad(
            "MusteriKod, MusteriKisaAd ve MusteriUnvan alanları gerekli; kodlar metin olmalı",
          );
        const result = await db.begin(async (tx) => {
          let added = 0,
            skipped = 0;
          const conflicts = [];
          for (const x of b.rows) {
            const code = x.code.trim(),
              short_name = x.short_name.trim(),
              title = x.title.trim();
            const rows = await tx.unsafe(
              "INSERT INTO gna_customers(code,short_name,title) VALUES($1,$2,$3) ON CONFLICT(code) DO NOTHING RETURNING code",
              [code, short_name, title],
            );
            if (rows.length) added++;
            else {
              skipped++;
              const old = (
                await tx.unsafe(
                  "SELECT short_name,title FROM gna_customers WHERE code=$1",
                  [code],
                )
              )[0];
              if (
                (old.short_name !== short_name || old.title !== title) &&
                conflicts.length < 100
              )
                conflicts.push(code);
            }
          }
          await audit(tx, u, "customers.import", {
            filename: clean(b.filename, 255),
            added,
            skipped,
            conflicts,
          });
          return { added, skipped, conflicts };
        });
        return out(result);
      }

      if (path === "/api/users" && req.method === "GET")
        return out(
          await run(
            "SELECT username,shop,role FROM gna_users ORDER BY username",
          ),
        );
      if (path === "/api/users" && req.method === "POST") {
        const b = await req.json();
        if (!b.shop || !b.username || String(b.password || "").length < 12)
          return bad(
            "SHOP, kullanıcı adı ve en az 12 karakterli şifre gerekli",
          );
        const salt = crypto.randomUUID();
        await run("INSERT INTO gna_users VALUES($1,$2,'dealer',$3,$4)", [
          String(b.username).trim(),
          String(b.shop).trim(),
          salt,
          await digest(salt + String(b.password)),
        ]);
        return out({ ok: true });
      }
      if (path === "/api/import" && req.method === "POST") {
        const b = await req.json();
        if (
          !["stock", "payment", "activation"].includes(b.kind) ||
          !Array.isArray(b.rows) ||
          !b.rows.length ||
          b.rows.length > 10000
        )
          return bad("Geçersiz dosya veya 10.000 satır sınırı");
        if (b.kind === "payment" && b.rows.some((x) => !x.paid_on))
          return bad("Ödeme tarihi eksik; dosya işlenmedi");
        if (
          b.kind === "stock" &&
          b.rows.some((x) => !x.shop || !Number.isFinite(Number(x.price)))
        )
          return bad("Bayi veya fiyat eksik; dosya işlenmedi");
        let added = 0,
          skipped = 0;
        for (const x of b.rows) {
          const sn = String(x.serial || "")
            .trim()
            .slice(0, 100);
          if (!sn) {
            skipped++;
            continue;
          }
          if (b.kind === "stock") {
            const price = Number(x.price);
            if (!x.shop || !Number.isFinite(price) || price < 0) {
              skipped++;
              continue;
            }
            const r = await run(
              "INSERT INTO gna_items(serial,shop,product,price) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id",
              [
                sn,
                String(x.shop).slice(0, 200),
                String(x.product || "").slice(0, 300),
                price,
              ],
            );
            r.length ? added++ : skipped++;
          } else {
            const n = await run(
              "SELECT count(*)::int n FROM gna_items WHERE serial=$1",
              [sn],
            );
            if (n[0].n !== 1) {
              skipped++;
              continue;
            }
            if (b.kind === "activation" && !x.campaign) {
              skipped++;
              continue;
            }
            let r = [];
            if (b.kind === "payment" && x.paid_on)
              r = await run(
                "UPDATE gna_items SET paid_on=$1 WHERE serial=$2 AND paid_on IS NULL RETURNING id",
                [String(x.paid_on).slice(0, 50), sn],
              );
            if (
              b.kind === "activation" &&
              ["Tarifeye Ek", "Peşin Satış"].includes(x.campaign)
            )
              r = await run(
                "UPDATE gna_items SET campaign=$1 WHERE serial=$2 AND campaign IS NULL RETURNING id",
                [x.campaign, sn],
              );
            r.length ? added++ : skipped++;
          }
        }
        await run("INSERT INTO gna_import_log(kind,filename) VALUES($1,$2)", [
          b.kind,
          String(b.filename || "").slice(0, 255),
        ]);
        await run(
          "INSERT INTO gna_upload_history(kind,filename) VALUES($1,$2)",
          [b.kind, String(b.filename || "").slice(0, 255)],
        );
        return out({ added, skipped });
      }
      return bad("Bulunamadı", 404);
    } catch (e) {
      console.error(e);
      return bad(
        "İşlem tamamlanamadı; dosya veya kayıt biçimini kontrol edin",
        500,
      );
    }
  },
});
