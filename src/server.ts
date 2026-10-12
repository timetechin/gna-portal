import { SQL } from "bun";
const db = new SQL(Bun.env.DATABASE_URL, { max: 4 });
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
    "ALTER TABLE gna_items ADD COLUMN IF NOT EXISTS vf_paid_on text",
  );
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
  await tx.unsafe(
    "ALTER TABLE gna_items ADD COLUMN IF NOT EXISTS shipped text",
  );
  await tx.unsafe("ALTER TABLE gna_items ADD COLUMN IF NOT EXISTS sold text");
  await tx.unsafe(
    "CREATE TABLE IF NOT EXISTS gna_product_prices(product text PRIMARY KEY,purchase_price numeric(18,2),cash_sale_price numeric(18,2),tariff_profit numeric(18,2),updated_at timestamptz NOT NULL DEFAULT now())",
  );
  await tx.unsafe(
    "ALTER TABLE gna_main_accounts ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true",
  );
  await tx.unsafe(
    "ALTER TABLE gna_customers ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true",
  );
  await tx.unsafe(
    "CREATE TABLE IF NOT EXISTS gna_dealer_profiles(shop text PRIMARY KEY,display_name text NOT NULL,active boolean NOT NULL DEFAULT true)",
  );
  await tx.unsafe(
    "CREATE TABLE IF NOT EXISTS gna_upload_batches(id uuid PRIMARY KEY,kind text NOT NULL,filename text NOT NULL,username text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,reverted_at timestamptz,reverted_by text)",
  );
  await tx.unsafe(
    "CREATE TABLE IF NOT EXISTS gna_upload_effects(id bigserial PRIMARY KEY,batch_id uuid NOT NULL REFERENCES gna_upload_batches(id),entity text NOT NULL,record_key text NOT NULL,field text NOT NULL,old_value jsonb,new_value jsonb,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(batch_id,entity,record_key,field))",
  );
  await tx.unsafe("ALTER TABLE gna_users ADD COLUMN IF NOT EXISTS account_id bigint REFERENCES gna_main_accounts(id)");
  await tx.unsafe("CREATE INDEX IF NOT EXISTS gna_items_serial_normalized_idx ON gna_items(regexp_replace(serial,'[[:space:]]','','g'))");
  await tx.unsafe(
    "ALTER TABLE gna_upload_batches ADD COLUMN IF NOT EXISTS only_prefix_2 boolean NOT NULL DEFAULT false",
  );
  await tx.unsafe(
    "CREATE INDEX IF NOT EXISTS gna_upload_effects_record_idx ON gna_upload_effects(entity,record_key,id)",
  );
});
if (!(await run("SELECT username FROM gna_users LIMIT 1")).length) {
  if (!secret) throw Error("Bootstrap password missing");
  const salt = crypto.randomUUID();
  await run("INSERT INTO gna_users(username,shop,role,salt,password_hash) VALUES($1,$2,$3,$4,$5)", [
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
function importDate(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  // Excel serials include a fractional time; keep the calendar day.
  if (/^\d{5}(?:[.,]\d+)?$/.test(text)) {
    const n = Number(text.replace(",", "."));
    if (n >= 20000 && n < 90000)
      return new Date((Math.floor(n) - 25569) * 86400000).toISOString().slice(0, 10);
  }
  let m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/);
  if (!m) {
    const tr = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:[ T].*)?$/);
    if (tr) m = [tr[0], tr[3].length === 2 ? "20" + tr[3] : tr[3], tr[2], tr[1]];
  }
  if (!m) {
    const months = ["ocak", "subat", "mart", "nisan", "mayis", "haziran", "temmuz", "agustos", "eylul", "ekim", "kasim", "aralik"];
    const normalized = text.toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i");
    const tr = normalized.match(/^(\d{1,2})[ .-]+([a-z]+)[ .-]+(\d{4})(?:\s.*)?$/);
    if (tr) {
      const month = months.findIndex(name => name === tr[2] || name.slice(0, 3) === tr[2]);
      if (month >= 0) m = [tr[0], tr[3], String(month + 1), tr[1]];
    }
  }
  if (!m) return null;
  const iso = m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
  const date = new Date(iso + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}
const uploadKinds = [
  "stock",
  "payment",
  "vf_payment",
  "activation",
  "customers",
];
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
async function uploadLock(tx) {
  await tx.unsafe("SELECT pg_advisory_xact_lock(719263001)");
}
async function getBatch(tx, u, b, kind) {
  await uploadLock(tx);
  if (b.batch_id) {
    if (!uuidPattern.test(String(b.batch_id)))
      throw new UserError("Yükleme kimliği geçersiz");
    const batch = (
      await tx.unsafe(
        "SELECT * FROM gna_upload_batches WHERE id=$1 FOR UPDATE",
        [b.batch_id],
      )
    )[0];
    if (!batch || batch.kind !== kind)
      throw new UserError("Yükleme bulunamadı", 404);
    if (batch.completed_at || batch.reverted_at)
      throw new UserError("Bu yükleme kapatılmış; yeni dosya yükleyin", 409);
    return batch;
  }
  const id = crypto.randomUUID();
  return (
    await tx.unsafe(
      "INSERT INTO gna_upload_batches(id,kind,filename,username,only_prefix_2) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [
        id,
        kind,
        clean(b.filename, 255) || "Excel",
        u.username,
        kind === "stock" && b.only_prefix_2 === true,
      ],
    )
  )[0];
}
async function effect(tx, id, entity, key, field, oldValue, newValue) {
  const logged = await tx.unsafe(
    "SELECT id FROM gna_upload_effects WHERE batch_id=$1 AND entity=$2 AND record_key=$3 AND field=$4",
    [id, entity, String(key), field],
  );
  if (logged.length)
    throw new UserError(
      "Aynı dosyada aynı seri/alan için çelişkili değerler var; ilgili dosya parçası işlenmedi",
      409,
    );
  await tx.unsafe(
    "INSERT INTO gna_upload_effects(batch_id,entity,record_key,field,old_value,new_value) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)",
    [id, entity, String(key), field, oldValue, newValue],
  );
}
async function completeBatch(tx, u, id) {
  const batch = (
    await tx.unsafe("SELECT * FROM gna_upload_batches WHERE id=$1 FOR UPDATE", [
      id,
    ])
  )[0];
  if (!batch) throw new UserError("Yükleme bulunamadı", 404);
  if (batch.reverted_at) throw new UserError("Yükleme geri alınmış", 409);
  if (batch.completed_at) return;
  await tx.unsafe(
    "UPDATE gna_upload_batches SET completed_at=now() WHERE id=$1",
    [id],
  );
  if (batch.kind !== "customers")
    await tx.unsafe("INSERT INTO gna_import_log(kind,filename) VALUES($1,$2)", [
      batch.kind,
      batch.filename,
    ]);
  await audit(tx, u, "upload.complete", {
    batch_id: id,
    kind: batch.kind,
    filename: batch.filename,
  });
}
async function undoBatch(tx, u, id) {
  await uploadLock(tx);
  const batch = (
    await tx.unsafe("SELECT * FROM gna_upload_batches WHERE id=$1 FOR UPDATE", [
      id,
    ])
  )[0];
  if (!batch) throw new UserError("Yükleme bulunamadı", 404);
  if (batch.reverted_at) return { ok: true, already_reverted: true, undone: 0 };
  const effects = await tx.unsafe(
    "SELECT * FROM gna_upload_effects WHERE batch_id=$1 ORDER BY id DESC",
    [id],
  );
  // Preflight the entire file: no partial reversals when one serial has a later dependency.
  for (const e of effects) {
    const later = await tx.unsafe(
      "SELECT 1 FROM gna_upload_effects e JOIN gna_upload_batches b ON b.id=e.batch_id WHERE e.entity=$1 AND e.record_key=$2 AND e.id>$3 AND e.batch_id<>$4 AND b.reverted_at IS NULL AND ($5='__created__' OR e.field=$5 OR e.field='__created__') LIMIT 1",
      [e.entity, e.record_key, e.id, id, e.field],
    );
    if (later.length)
      throw new UserError(
        "Bu dosyanın kayıtlarına sonraki bir yükleme işlem yapmış. Önce ilgili sonraki yüklemeyi geri alın.",
        409,
      );
    const table =
      e.entity === "item"
        ? "gna_items"
        : e.entity === "customer"
          ? "gna_customers"
          : null;
    if (!table) throw Error("Invalid effect entity");
    const key = e.entity === "item" ? "id" : "code";
    const rows = await tx.unsafe(
      `SELECT to_jsonb(r) snapshot FROM ${table} r WHERE ${key}=$1 FOR UPDATE`,
      [e.record_key],
    );
    if (!rows.length)
      throw new UserError(
        "Dosyanın bir kaydı daha sonra silinmiş veya değişmiş; geri alma durduruldu.",
        409,
      );
    const matches = await tx.unsafe(
      `SELECT 1 FROM ${table} r JOIN gna_upload_effects e ON e.id=$2 WHERE r.${key}=$1 AND (CASE WHEN e.field='__created__' THEN to_jsonb(r) ELSE to_jsonb(r)->e.field END) IS NOT DISTINCT FROM e.new_value`,
      [e.record_key, e.id],
    );
    if (!matches.length)
      throw new UserError(
        "Dosyanın bir kaydı sonradan değiştirilmiş. Sonraki değişikliği korumak için geri alma durduruldu.",
        409,
      );
  }
  for (const e of effects) {
    if (e.field === "__created__")
      await tx.unsafe(
        e.entity === "item"
          ? "DELETE FROM gna_items WHERE id=$1"
          : "DELETE FROM gna_customers WHERE code=$1",
        [e.record_key],
      );
    else {
      if (
        e.entity !== "item" ||
        !["paid_on", "vf_paid_on", "campaign", "shipped", "sold"].includes(
          e.field,
        )
      )
        throw Error("Invalid effect field");
      await tx.unsafe(`UPDATE gna_items SET ${e.field}=$1 WHERE id=$2`, [
        e.old_value,
        e.record_key,
      ]);
    }
  }
  await tx.unsafe(
    "UPDATE gna_upload_batches SET reverted_at=now(),reverted_by=$2 WHERE id=$1",
    [id, u.username],
  );
  await audit(tx, u, "upload.undo", {
    batch_id: id,
    kind: batch.kind,
    filename: batch.filename,
    undone: effects.length,
  });
  return { ok: true, undone: effects.length };
}
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
    "SELECT u.username,u.shop,u.role,u.account_id FROM gna_sessions s JOIN gna_users u ON u.username=s.username WHERE s.tokenhash=$1 AND s.expires>now()",
    [await digest(t)],
  );
  if(!a[0])return null;
  const u=a[0], preview=req.headers.get("x-gna-preview-shop"), previewAccount=req.headers.get("x-gna-preview-account");
  if(previewAccount&&u.role==="admin"){
    if(!/^\d+$/.test(previewAccount))throw new UserError("Geçersiz ana cari");
    const [account]=await run("SELECT id,name FROM gna_main_accounts WHERE id=$1 AND active",[previewAccount]);
    if(!account)throw new UserError("Ana cari bulunamadı");
    u.shop=account.name;u.role="dealer";u.account_id=account.id;u.preview=true;
  }
  if(preview&&u.role==="admin"){u.shop=decodeURIComponent(preview);u.role="dealer";u.account_id=null;u.preview=true;}
  u.shops=u.account_id ? (await run("SELECT d.shop FROM gna_dealer_accounts d JOIN gna_main_accounts a ON a.id=d.account_id WHERE a.active AND d.account_id=$1",[u.account_id])).map(x=>x.shop) : [u.shop];
  return u;
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
      if (path === "/api/imports" && req.method === "GET") {
        if (u.role !== "admin") return bad("Yönetici yetkisi gerekli", 403);
        return out(
          await run(`SELECT * FROM (
       SELECT id::text id,kind,filename,created_at,completed_at,reverted_at,username,true reversible,(SELECT count(*)::int FROM gna_upload_effects e WHERE e.batch_id=b.id) changed_count,only_prefix_2 FROM gna_upload_batches b
       UNION ALL SELECT 'legacy:'||id::text,kind,filename,created_at,created_at,NULL::timestamptz,NULL::text,false,NULL::int,false FROM gna_upload_history) h ORDER BY created_at DESC,id DESC LIMIT 300`),
        );
      }
      if (path === "/api/directory" && req.method === "GET") {
        const entries = await run(
          `SELECT s.shop,coalesce(p.display_name,s.shop) display_name,coalesce(p.active,true) active,d.account_id FROM (SELECT DISTINCT shop FROM gna_items UNION SELECT shop FROM gna_dealer_accounts UNION SELECT shop FROM gna_dealer_profiles) s LEFT JOIN gna_dealer_profiles p ON p.shop=s.shop LEFT JOIN gna_dealer_accounts d ON d.shop=s.shop ${u.role === "admin" ? "" : "WHERE s.shop IN (SELECT jsonb_array_elements_text($1::jsonb))"} ORDER BY s.shop`,
          u.role === "admin" ? [] : [u.shops],
        );
        const groups = await run(
          u.role === "admin"
            ? "SELECT id,name,active FROM gna_main_accounts ORDER BY name"
            : "SELECT DISTINCT a.id,a.name,a.active FROM gna_main_accounts a JOIN gna_dealer_accounts d ON d.account_id=a.id WHERE d.shop IN (SELECT jsonb_array_elements_text($1::jsonb))",
          u.role === "admin" ? [] : [u.shops],
        );
        return out({ dealers: entries, groups });
      }
      if (path === "/api/profitability" && req.method === "GET") {
        const params = new URL(req.url).searchParams,
          shop = params.get("shop") || u.shop,
          month = params.get("month") || "";
        if (u.role !== "admin" && !u.shops.includes(shop))
          return bad("Başka bayinin kârlılığı görüntülenemez", 403);
        if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
          return bad("Ay biçimi YYYY-AA olmalı");
        const months = (
          await run(
            "SELECT DISTINCT left(sold,7) month_key FROM gna_items WHERE shop=$1 AND campaign IN ('Tarifeye Ek','Peşin Satış') AND sold ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' ORDER BY month_key DESC",
            [shop],
          )
        ).map((r) => r.month_key);
        const rows = await run(
          `SELECT i.id,i.shop,i.product,i.serial,i.campaign,i.sold,i.shipped,round(coalesce(p.purchase_price,i.price),2) purchase_price,p.cash_sale_price,p.tariff_profit,
       CASE WHEN i.campaign='Peşin Satış' AND p.cash_sale_price IS NOT NULL AND coalesce(p.purchase_price,i.price) IS NOT NULL THEN round(p.cash_sale_price-coalesce(p.purchase_price,i.price),2) WHEN i.campaign='Tarifeye Ek' THEN p.tariff_profit ELSE NULL END profit
       FROM gna_items i LEFT JOIN gna_product_prices p ON p.product=i.product WHERE i.shop=$1 AND i.campaign IN ('Tarifeye Ek','Peşin Satış') AND ($2='' OR left(i.sold,7)=$2) ORDER BY i.sold DESC NULLS LAST,i.id DESC`,
          [shop, month],
        );
        const undated = (
          await run(
            "SELECT count(*)::int n FROM gna_items WHERE shop=$1 AND campaign IN ('Tarifeye Ek','Peşin Satış') AND (sold IS NULL OR sold !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')",
            [shop],
          )
        )[0].n;
        let cents = 0n,
          priced = 0;
        for (const r of rows) {
          if (r.profit === null) continue;
          priced++;
          const text = String(r.profit),
            negative = text.startsWith("-"),
            parts = text.replace(/^-/, "").split(".");
          const n =
            BigInt(parts[0]) * 100n +
            BigInt((parts[1] || "").padEnd(2, "0").slice(0, 2));
          cents += negative ? -n : n;
        }
        const abs = cents < 0n ? -cents : cents,
          total =
            (cents < 0n ? "-" : "") +
            String(abs / 100n) +
            "." +
            String(abs % 100n).padStart(2, "0");
        return out({
          rows,
          months,
          undated_count: undated,
          totals: {
            sale_count: rows.length,
            priced_count: priced,
            missing_price_count: rows.length - priced,
            profit_total: total,
          },
        });
      }
      if (path === "/api/dealers" && req.method === "GET")
        return out(
          await run(
            u.role === "admin"
              ? "SELECT shop,count(*)::int AS count FROM gna_items GROUP BY shop ORDER BY shop"
              : "SELECT shop,count(*)::int AS count FROM gna_items WHERE shop IN (SELECT jsonb_array_elements_text($1::jsonb)) GROUP BY shop ORDER BY shop",
            u.role === "admin" ? [] : [u.shops],
          ),
        );
      if (path === "/api/items" && req.method === "GET")
        return out(
          await run(
            u.role === "admin"
              ? "SELECT * FROM gna_items ORDER BY id DESC"
              : "SELECT * FROM gna_items WHERE shop IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY id DESC",
            u.role === "admin" ? [] : [u.shops],
          ),
        );
      if (path === "/api/aliases" && req.method === "GET")
        return out(
          await run(
            u.role === "admin"
              ? "SELECT shop,alias FROM gna_shop_aliases ORDER BY shop,alias"
              : "SELECT shop,alias FROM gna_shop_aliases WHERE shop IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY alias",
            u.role === "admin" ? [] : [u.shops],
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
          await run(`SELECT a.id,a.name,a.active,
 count(i.id)::int AS product_count, count(i.id) FILTER(WHERE i.campaign IS NOT NULL)::int AS sale_count,
 count(i.id) FILTER(WHERE i.paid_on IS NOT NULL)::int AS payment_count,
 coalesce(sum(i.price),0) AS product_total,
 coalesce(sum(i.price) FILTER(WHERE i.campaign IS NOT NULL),0) AS sales_total,
 coalesce(sum(i.price) FILTER(WHERE i.paid_on IS NOT NULL),0) AS payments_total,
 coalesce(sum(i.price) FILTER(WHERE i.paid_on IS NOT NULL AND (coalesce(i.campaign,'')='' OR i.campaign='Tarifeye Ek') AND i.vf_paid_on IS NULL),0) AS receivable_total,
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
              await tx.unsafe(
                "SELECT 1 FROM (SELECT shop FROM gna_items UNION SELECT shop FROM gna_dealer_profiles) s WHERE shop=$1 AND NOT EXISTS(SELECT 1 FROM gna_dealer_profiles p WHERE p.shop=s.shop AND NOT p.active) LIMIT 1",
                [shop],
              )
            ).length
          )
            return { error: "Bayi bulunamadı", status: 404 };
          if (
            id !== null &&
            !(
              await tx.unsafe(
                "SELECT 1 FROM gna_main_accounts WHERE id=$1 AND active",
                [id],
              )
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
            "SELECT code,short_name,title,active FROM gna_customers ORDER BY short_name,code",
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
          const batch = await getBatch(tx, u, b, "customers");
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
            if (rows.length) {
              added++;
              const snapshot = (
                await tx.unsafe(
                  "SELECT to_jsonb(c) snapshot FROM gna_customers c WHERE code=$1",
                  [code],
                )
              )[0].snapshot;
              await effect(
                tx,
                batch.id,
                "customer",
                code,
                "__created__",
                null,
                snapshot,
              );
            } else {
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
          if (!b.batch_id) await completeBatch(tx, u, batch.id);
          return { added, skipped, conflicts, batch_id: batch.id };
        });
        return out(result);
      }

      if (path === "/api/prices" && req.method === "GET")
        return out(
          await run(
            `SELECT products.product,p.purchase_price,p.cash_sale_price,p.tariff_profit,p.updated_at,(SELECT min(price) FROM gna_items i WHERE i.product=products.product) stock_min,(SELECT max(price) FROM gna_items i WHERE i.product=products.product) stock_max FROM (SELECT DISTINCT product FROM gna_items WHERE product IS NOT NULL AND product<>'' UNION SELECT product FROM gna_product_prices) products LEFT JOIN gna_product_prices p ON p.product=products.product ORDER BY products.product`,
          ),
        );
      if (path === "/api/prices/bulk" && req.method === "PUT") {
        const b=await req.json(), rows=b.rows;
        if(!Array.isArray(rows)||!rows.length||rows.length>2000)return bad("1–2000 fiyat satırı gerekli");
        const names=new Set();
        for(const row of rows){
          if(!row||typeof row.product!=="string"||!row.product.trim()||row.product.length>300||names.has(row.product.trim()))return bad("Ürünler geçerli ve tekil olmalı");
          names.add(row.product.trim());
          for(const key of ["purchase_price","cash_sale_price","tariff_profit"])
            if(row[key]!==null&&(typeof row[key]!=="number"||!Number.isFinite(row[key])||Math.abs(row[key])>1e9||(key!=="tariff_profit"&&row[key]<0)))return bad("Fiyatlar sayısal olmalı; eksik fiyat için boş bırakın");
        }
        await db.begin(async tx=>{
          await tx.unsafe("SELECT pg_advisory_xact_lock(719263003)");
          for(const row of rows)await tx.unsafe("INSERT INTO gna_product_prices(product,purchase_price,cash_sale_price,tariff_profit) VALUES($1,$2,$3,$4) ON CONFLICT(product) DO UPDATE SET purchase_price=EXCLUDED.purchase_price,cash_sale_price=EXCLUDED.cash_sale_price,tariff_profit=EXCLUDED.tariff_profit,updated_at=now()",[row.product.trim(),row.purchase_price,row.cash_sale_price,row.tariff_profit]);
          await audit(tx,u,"prices.bulk",{products:[...names],count:rows.length});
        });return out({ok:true,saved:rows.length});
      }
      const itemAction=path.match(/^\/api\/items\/(\d+)$/);
      if(itemAction&&["PATCH","DELETE"].includes(req.method)){
        const b=req.method==="PATCH"?await req.json():null;
        const result=await db.begin(async tx=>{
          await uploadLock(tx);
          const [old]=await tx.unsafe("SELECT * FROM gna_items WHERE id=$1 FOR UPDATE",[itemAction[1]]);
          if(!old)throw new UserError("Ürün bulunamadı",404);
          if(!b){await tx.unsafe("DELETE FROM gna_items WHERE id=$1",[old.id]);await audit(tx,u,"item.delete",{old});return {ok:true};}
          const serial=clean(b.serial,100),shop=clean(b.shop),product=clean(b.product,300),price=Number(b.price);
          if(!serial||!shop||!product||!Number.isFinite(price)||price<0||price>1e9||!["","Peşin Satış","Tarifeye Ek"].includes(b.campaign))throw new UserError("Seri, bayi, ürün, fiyat ve satış durumu geçerli olmalı");
          if((await tx.unsafe("SELECT 1 FROM gna_items WHERE serial=$1 AND shop=$2 AND id<>$3",[serial,shop,old.id])).length)throw new UserError("Bu seri bayide zaten var",409);
          const shipped=importDate(b.shipped),sold=importDate(b.sold);
          if((b.shipped&&!shipped)||(b.sold&&!sold))throw new UserError("Geçerli tarih seçin");
          await tx.unsafe("UPDATE gna_items SET serial=$1,shop=$2,product=$3,price=$4,shipped=$5,sold=$6,campaign=$7,paid_on=$8,vf_paid_on=$9 WHERE id=$10",[serial,shop,product,price,shipped,sold,b.campaign||null,b.paid?old.paid_on||"Ödendi":null,b.vf_paid?old.vf_paid_on||"Ödendi":null,old.id]);
          await audit(tx,u,"item.edit",{id:old.id,old});return {ok:true};
        });return out(result);
      }
      if (path === "/api/prices" && req.method === "PUT") {
        const b = await req.json();
        if (
          typeof b.product !== "string" ||
          !b.product.trim() ||
          b.product.trim().length > 300
        )
          return bad("Ürün adı gerekli");
        for (const key of [
          "purchase_price",
          "cash_sale_price",
          "tariff_profit",
        ])
          if (
            b[key] !== null &&
            (typeof b[key] !== "number" ||
              !Number.isFinite(b[key]) ||
              Math.abs(b[key]) > 1000000000 ||
              (key !== "tariff_profit" && b[key] < 0))
          )
            return bad("Fiyatlar sayısal olmalı; eksik fiyat için boş bırakın");
        await db.begin(async (tx) => {
          await tx.unsafe("SELECT pg_advisory_xact_lock(719263003)");
          const old =
            (
              await tx.unsafe(
                "SELECT * FROM gna_product_prices WHERE product=$1 FOR UPDATE",
                [b.product.trim()],
              )
            )[0] || null;
          await tx.unsafe(
            "INSERT INTO gna_product_prices(product,purchase_price,cash_sale_price,tariff_profit) VALUES($1,$2,$3,$4) ON CONFLICT(product) DO UPDATE SET purchase_price=EXCLUDED.purchase_price,cash_sale_price=EXCLUDED.cash_sale_price,tariff_profit=EXCLUDED.tariff_profit,updated_at=now()",
            [
              b.product.trim(),
              b.purchase_price,
              b.cash_sale_price,
              b.tariff_profit,
            ],
          );
          await audit(tx, u, "price.edit", {
            product: b.product.trim(),
            old,
            new_values: {
              purchase_price: b.purchase_price,
              cash_sale_price: b.cash_sale_price,
              tariff_profit: b.tariff_profit,
            },
          });
        });
        return out({ ok: true });
      }
      const accountEdit = path.match(/^\/api\/accounts\/([1-9][0-9]*)$/);
      if (accountEdit && req.method === "PATCH") {
        const b = await req.json();
        if (
          typeof b.name !== "string" ||
          !b.name.trim() ||
          b.name.trim().length > 200 ||
          typeof b.active !== "boolean"
        )
          return bad("Ana cari adı ve açık/kapalı durumu gerekli");
        const result = await db.begin(async (tx) => {
          await tx.unsafe("SELECT pg_advisory_xact_lock(719263002)");
          const old = (
            await tx.unsafe(
              "SELECT * FROM gna_main_accounts WHERE id=$1 FOR UPDATE",
              [accountEdit[1]],
            )
          )[0];
          if (!old) throw new UserError("Ana cari bulunamadı", 404);
          if (
            (
              await tx.unsafe(
                "SELECT 1 FROM gna_main_accounts WHERE lower(name)=lower($1) AND id<>$2",
                [b.name.trim(), old.id],
              )
            ).length
          )
            throw new UserError("Bu ana cari adı kullanılıyor", 409);
          await tx.unsafe(
            "UPDATE gna_main_accounts SET name=$1,active=$2 WHERE id=$3",
            [b.name.trim(), b.active, old.id],
          );
          await audit(tx, u, "account.edit", {
            id: old.id,
            old_name: old.name,
            new_name: b.name.trim(),
            old_active: old.active,
            new_active: b.active,
          });
          return { ok: true };
        });
        return out(result);
      }
      if (path === "/api/dealer-profiles" && req.method === "PUT") {
        const b = await req.json();
        if (
          typeof b.shop !== "string" ||
          !b.shop.trim() ||
          b.shop.trim().length > 200 ||
          typeof b.display_name !== "string" ||
          !b.display_name.trim() ||
          b.display_name.trim().length > 200 ||
          typeof b.active !== "boolean"
        )
          return bad("Bayi kimliği, adı ve açık/kapalı durumu gerekli");
        const result = await db.begin(async (tx) => {
          await tx.unsafe("SELECT pg_advisory_xact_lock(719263002)");
          const shop = b.shop.trim(),
            name = b.display_name.trim();
          if (
            (
              await tx.unsafe(
                "SELECT 1 FROM gna_dealer_profiles WHERE lower(display_name)=lower($1) AND shop<>$2 UNION SELECT 1 FROM gna_items WHERE lower(shop)=lower($1) AND shop<>$2 LIMIT 1",
                [name, shop],
              )
            ).length
          )
            throw new UserError(
              "Bu bayi adı başka bir kayıtta kullanılıyor",
              409,
            );
          const old = (
            await tx.unsafe(
              "SELECT * FROM gna_dealer_profiles WHERE shop=$1 FOR UPDATE",
              [shop],
            )
          )[0] ?? { shop, display_name: shop, active: true };
          await tx.unsafe(
            "INSERT INTO gna_dealer_profiles(shop,display_name,active) VALUES($1,$2,$3) ON CONFLICT(shop) DO UPDATE SET display_name=EXCLUDED.display_name,active=EXCLUDED.active",
            [shop, name, b.active],
          );
          await audit(tx, u, "dealer.edit", {
            shop,
            old_name: old.display_name,
            new_name: name,
            old_active: old.active,
            new_active: b.active,
          });
          return { ok: true };
        });
        return out(result);
      }
      if (path === "/api/customers" && req.method === "POST") {
        const b = await req.json();
        if (
          typeof b.code !== "string" ||
          !b.code.trim() ||
          b.code.trim().length > 100 ||
          typeof b.short_name !== "string" ||
          !b.short_name.trim() ||
          b.short_name.trim().length > 200 ||
          typeof b.title !== "string" ||
          !b.title.trim() ||
          b.title.trim().length > 500
        )
          return bad("Müşteri kodu, kısa adı ve ünvanı gerekli");
        const r = await db.begin(async (tx) => {
          await uploadLock(tx);
          const rows = await tx.unsafe(
            "INSERT INTO gna_customers(code,short_name,title) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING code",
            [b.code.trim(), b.short_name.trim(), b.title.trim()],
          );
          if (!rows.length) throw new UserError("Müşteri kodu zaten var", 409);
          await audit(tx, u, "customer.create", { code: b.code.trim() });
          return { ok: true };
        });
        return out(r, 201);
      }
      const customerEdit = path.match(/^\/api\/customers\/([^/]+)$/);
      if (customerEdit && req.method === "PATCH") {
        const code = decodeURIComponent(customerEdit[1]),
          b = await req.json();
        if (
          typeof b.short_name !== "string" ||
          !b.short_name.trim() ||
          b.short_name.trim().length > 200 ||
          typeof b.title !== "string" ||
          !b.title.trim() ||
          b.title.trim().length > 500 ||
          typeof b.active !== "boolean"
        )
          return bad("Müşteri adı, ünvanı ve durumu gerekli");
        const r = await db.begin(async (tx) => {
          await uploadLock(tx);
          const old = (
            await tx.unsafe(
              "SELECT * FROM gna_customers WHERE code=$1 FOR UPDATE",
              [code],
            )
          )[0];
          if (!old) throw new UserError("Müşteri bulunamadı", 404);
          await tx.unsafe(
            "UPDATE gna_customers SET short_name=$1,title=$2,active=$3 WHERE code=$4",
            [b.short_name.trim(), b.title.trim(), b.active, code],
          );
          await audit(tx, u, "customer.edit", {
            code,
            old_name: old.short_name,
            new_name: b.short_name.trim(),
            old_title: old.title,
            new_title: b.title.trim(),
            old_active: old.active,
            new_active: b.active,
          });
          return { ok: true };
        });
        return out(r);
      }
      if (path === "/api/uploads" && req.method === "POST") {
        const b = await req.json();
        if (!uploadKinds.includes(b.kind) || !clean(b.filename, 255))
          return bad("Dosya adı ve yükleme türü gerekli");
        const id = crypto.randomUUID();
        await run(
          "INSERT INTO gna_upload_batches(id,kind,filename,username,only_prefix_2) VALUES($1,$2,$3,$4,$5)",
          [
            id,
            b.kind,
            clean(b.filename, 255),
            u.username,
            b.kind === "stock" && b.only_prefix_2 === true,
          ],
        );
        return out({ batch_id: id }, 201);
      }
      const uploadAction = path.match(
        /^\/api\/uploads\/([^/]+)\/(complete|undo)$/,
      );
      if (uploadAction && req.method === "POST") {
        const id = uploadAction[1];
        if (!uuidPattern.test(id))
          return bad(
            "Eski dosyada işlem/seri eşleştirme kaydı yok; güvenli geri alma yapılamaz.",
            409,
          );
        return out(
          await db.begin(async (tx) => {
            await uploadLock(tx);
            if (uploadAction[2] === "undo") return await undoBatch(tx, u, id);
            await completeBatch(tx, u, id);
            return { ok: true };
          }),
        );
      }
      if (path === "/api/users" && req.method === "GET") {
        const users = await run("SELECT username,shop,role,account_id FROM gna_users ORDER BY username");
        const shops = await run("SELECT DISTINCT shop FROM (SELECT shop FROM gna_items UNION SELECT shop FROM gna_dealer_profiles UNION SELECT shop FROM gna_dealer_accounts) s WHERE NOT EXISTS(SELECT 1 FROM gna_users u WHERE u.shop=s.shop) ORDER BY shop");
        for(const user of users)if(!user.account_id)delete user.account_id;
        const names=new Set(users.map(x=>x.username));
        const groups=await run("SELECT id,name FROM gna_main_accounts a WHERE active AND NOT EXISTS(SELECT 1 FROM gna_users u WHERE u.account_id=a.id) ORDER BY name");
        const drafts=groups.map(a=>{let name=a.name,n=2;while(names.has(name))name=a.name+"-"+n++;names.add(name);return {username:name,shop:a.name,account_id:a.id,role:"dealer",pending:true};});
        return out([...users,...drafts,...shops.map(x=>{let name=x.shop,n=2;while(names.has(name))name=x.shop+"-"+n++;names.add(name);return {username:name,shop:x.shop,role:"dealer",pending:true};})]);
      }
      if (path === "/api/users" && req.method === "PATCH") {
        const b=await req.json(), old=clean(b.original_username), name=clean(b.username), shop=clean(b.shop), role=b.role;
        if (!old || !name || !shop || !["dealer","admin"].includes(role)) return bad("Kullanıcı, bayi ve geçerli yetki gerekli");
        if (b.password && (typeof b.password!=="string" || b.password.length<12)) return bad("Yeni şifre en az 12 karakter olmalı");
        const result=await db.begin(async tx=>{
          await tx.unsafe("SELECT pg_advisory_xact_lock(719263004)");
          const [target]=await tx.unsafe("SELECT * FROM gna_users WHERE username=$1 FOR UPDATE",[old]);
          if (!target) throw new UserError("Kullanıcı bulunamadı",404);
          if (target.role==="admin" && role!=="admin" && Number((await tx.unsafe("SELECT count(*) n FROM gna_users WHERE role='admin'"))[0].n)<=1) throw new UserError("Son yöneticinin yetkisi kaldırılamaz",409);
          if (old!==name && (await tx.unsafe("SELECT 1 FROM gna_users WHERE username=$1",[name])).length) throw new UserError("Kullanıcı adı zaten mevcut",409);
          const account=Object.hasOwn(b,"account_id")?b.account_id:target.account_id;
          if(account!=null&&account!==""&&(!/^\d+$/.test(String(account))||!(await tx.unsafe("SELECT 1 FROM gna_main_accounts WHERE id=$1 AND active",[String(account)])).length))throw new UserError("Ana cari bulunamadı veya kapalı");
          const accountId=account==null||account===""?null:String(account);
          const salt=b.password?crypto.randomUUID():target.salt;
          const hash=b.password?await digest(salt+b.password):target.password_hash;
          await tx.unsafe("UPDATE gna_users SET username=$1,shop=$2,role=$3,salt=$4,password_hash=$5,account_id=$7 WHERE username=$6",[name,shop,role,salt,hash,old,accountId]);
          const changedIdentity=old!==name||shop!==target.shop||role!==target.role||String(accountId??"")!==String(target.account_id??"")||!!b.password;
          if(changedIdentity)await tx.unsafe("DELETE FROM gna_sessions WHERE username=$1",[old]);
          await audit(tx,u,"user.edit",{original_username:old,username:name,shop,role,account_id:accountId,password_changed:!!b.password});
          return {ok:true,relogin:changedIdentity&&u.username===old};
        });return out(result);
      }
      if (path === "/api/users" && req.method === "POST") {
        const b = await req.json();
        if (!b.shop || !b.username || String(b.password || "").length < 12)
          return bad(
            "SHOP, kullanıcı adı ve en az 12 karakterli şifre gerekli",
          );
        const role = b.role || "dealer";
        if (!["dealer", "admin"].includes(role)) return bad("Geçersiz kullanıcı rolü");
        if ((await run("SELECT 1 FROM gna_users WHERE username=$1", [String(b.username).trim()])).length) return bad("Bu kullanıcı adı zaten mevcut", 409);
        const account=b.account_id==null||b.account_id===""?null:String(b.account_id);
        if(account&&(!/^\d+$/.test(account)||!(await run("SELECT 1 FROM gna_main_accounts WHERE id=$1 AND active",[account])).length))return bad("Ana cari bulunamadı veya kapalı");
        const salt = crypto.randomUUID();
        await run("INSERT INTO gna_users(username,shop,role,salt,password_hash,account_id) VALUES($1,$2,$3,$4,$5,$6)", [
          String(b.username).trim(),
          String(b.shop).trim(),
          role,
          salt,
          await digest(salt + String(b.password)),
          account,
        ]);
        return out({ ok: true });
      }
      if (path === "/api/import" && req.method === "POST") {
        const b = await req.json();
        if (
          !["stock", "payment", "vf_payment", "activation"].includes(b.kind) ||
          !Array.isArray(b.rows) ||
          !b.rows.length ||
          b.rows.length > 10000 ||
          b.rows.some((x) => !x || typeof x !== "object")
        )
          return bad("Geçersiz dosya veya 10.000 satır sınırı");
        if (
          b.kind === "stock" &&
          b.rows.some((x) => !x.shop || !Number.isFinite(Number(x.price)))
        )
          return bad("Bayi veya fiyat eksik; dosya işlenmedi");
        const result = await db.begin(async (tx) => {
          const batch = await getBatch(tx, u, b, b.kind);
          let added = 0,
            skipped = 0;
          const issues = [];
          let sourceRow = null;
          const report = (serial, reason) => {
            issues.push({ serial, reason, row: sourceRow });
          };
          for (const x of b.rows) {
            sourceRow = Number.isInteger(x.source_row) ? x.source_row : null;
            if(b.kind==="activation"&&x.ignore===true){skipped++;continue;}
            const rawSerial=String(x.serial||"").trim().slice(0,100);
            let serial=rawSerial;
            if(b.kind!=="stock"){
              serial=serial.replace(/^'/,"").replace(/[\s\u200b\ufeff]/g,"");
              if(/^\d+[.,]0+$/.test(serial))serial=serial.replace(/[.,]0+$/,"");
              if(/^\d+(?:[.,]\d+)?e[+-]?\d+$/i.test(serial)){const number=Number(serial.replace(",","."));if(Number.isSafeInteger(number))serial=String(number);}
            }
            if (!serial) {
              skipped++;
              continue;
            }
            const dateField = b.kind === "stock" ? "shipped" : b.kind === "activation" ? "sold" : "paid_on";
            const rawDate = x[dateField];
            const parsedDate = importDate(rawDate);
            if (rawDate !== undefined && rawDate !== null && String(rawDate).trim() && !parsedDate)
              report(serial, "Tarih okunamadı; tarih boş bırakıldı, varsa mevcut tarih korundu");
            // Work on a copy so an unreadable date cannot erase an existing date.
            x[dateField] = parsedDate;
            let changed = false;
            if (
              b.kind === "stock" &&
              batch.only_prefix_2 &&
              !serial.startsWith("2")
            ) {
              skipped++;
              continue;
            }
            if (b.kind === "stock") {
              const price = Number(x.price),
                shop = String(x.shop).slice(0, 200);
              if (!Number.isFinite(price) || price < 0) {
                skipped++;
                continue;
              }
              const sameSerial=await tx.unsafe("SELECT serial FROM gna_items WHERE shop=$1 AND (serial=$2 OR regexp_replace(serial,'[[:space:]]','','g')=$3) FOR UPDATE",[shop,serial,serial.replace(/\s/g,"")]);
              if(sameSerial.length>1){report(serial,"Aynı bayide farklı yazımla birden fazla seri bulundu");skipped++;continue;}
              if(sameSerial.length)serial=sameSerial[0].serial;
              const created = await tx.unsafe(
                "INSERT INTO gna_items(serial,shop,product,price,shipped) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id",
                [
                  serial,
                  shop,
                  String(x.product || "").slice(0, 300),
                  price,
                  importDate(x.shipped),
                ],
              );
              if (created.length) {
                const id = created[0].id,
                  snapshot = (
                    await tx.unsafe(
                      "SELECT to_jsonb(i) snapshot FROM gna_items i WHERE id=$1",
                      [id],
                    )
                  )[0].snapshot;
                await effect(
                  tx,
                  batch.id,
                  "item",
                  id,
                  "__created__",
                  null,
                  snapshot,
                );
                changed = true;
              } else if (x.shipped) {
                const row = (
                  await tx.unsafe(
                    "SELECT * FROM gna_items WHERE serial=$1 AND shop=$2 FOR UPDATE",
                    [serial, shop],
                  )
                )[0];
                if (row && !row.shipped) {
                  const value = importDate(x.shipped);
                  await tx.unsafe(
                    "UPDATE gna_items SET shipped=$1 WHERE id=$2",
                    [value, row.id],
                  );
                  await effect(
                    tx,
                    batch.id,
                    "item",
                    row.id,
                    "shipped",
                    row.shipped,
                    value,
                  );
                  changed = true;
                }
              }
            } else {
              let matches = await tx.unsafe("SELECT * FROM gna_items WHERE serial=$1 OR serial=$2 FOR UPDATE",[serial,rawSerial]);
              if(!matches.length)matches=await tx.unsafe("SELECT * FROM gna_items WHERE regexp_replace(serial,'[[:space:]]','','g')=$1 FOR UPDATE",[serial]);
              if(matches.length>1&&x.shop){const narrowed=matches.filter(row=>row.shop===String(x.shop).trim());if(narrowed.length)matches=narrowed;}
              if (matches.length !== 1) {
                report(
                  serial,
                  matches.length
                    ? "Seri birden fazla bayide bulundu · "+matches.map(row=>row.shop).join(", ")+(x.shop?" · Dosyadaki bayi: "+String(x.shop):"")
                    : "Seri bulunamadı",
                );
                skipped++;
                continue;
              }
              const row = matches[0];
              if (b.kind === "payment" && !row.paid_on) {
                const value = importDate(x.paid_on) || "Ödendi";
                await tx.unsafe("UPDATE gna_items SET paid_on=$1 WHERE id=$2", [
                  value,
                  row.id,
                ]);
                await effect(
                  tx,
                  batch.id,
                  "item",
                  row.id,
                  "paid_on",
                  row.paid_on,
                  value,
                );
                changed = true;
              }
              if (
                b.kind === "vf_payment" &&
                row.paid_on &&
                (!row.campaign || row.campaign === "Tarifeye Ek") &&
                !row.vf_paid_on
              ) {
                const value = importDate(x.paid_on) || "Ödendi";
                await tx.unsafe(
                  "UPDATE gna_items SET vf_paid_on=$1 WHERE id=$2",
                  [value, row.id],
                );
                await effect(
                  tx,
                  batch.id,
                  "item",
                  row.id,
                  "vf_paid_on",
                  row.vf_paid_on,
                  value,
                );
                changed = true;
              }
              if (
                b.kind === "activation" &&
                ["Tarifeye Ek", "Peşin Satış"].includes(x.campaign)
              ) {
                if (row.campaign !== x.campaign) {
                  await tx.unsafe(
                    "UPDATE gna_items SET campaign=$1 WHERE id=$2",
                    [x.campaign, row.id],
                  );
                  await effect(
                    tx,
                    batch.id,
                    "item",
                    row.id,
                    "campaign",
                    row.campaign,
                    x.campaign,
                  );
                  changed = true;
                }
                if (x.sold && row.sold !== importDate(x.sold)) {
                  const value = importDate(x.sold);
                  await tx.unsafe("UPDATE gna_items SET sold=$1 WHERE id=$2", [
                    value,
                    row.id,
                  ]);
                  await effect(
                    tx,
                    batch.id,
                    "item",
                    row.id,
                    "sold",
                    row.sold,
                    value,
                  );
                  changed = true;
                }
              }
            }
            if (
              !changed &&
              b.kind === "activation" &&
              !["Tarifeye Ek", "Peşin Satış"].includes(x.campaign)
            )
              report(serial, "Kampanya tanınmadı; E sütununu kontrol edin");
            changed ? added++ : skipped++;
          }
          if (!b.batch_id) await completeBatch(tx, u, batch.id);
          return { added, skipped, batch_id: batch.id, issues };
        });
        return out(result);
      }
      return bad("Bulunamadı", 404);
    } catch (e) {
      if (e instanceof UserError) return bad(e.message, e.status);
      console.error(e);
      return bad(
        "İşlem tamamlanamadı; dosya veya kayıt biçimini kontrol edin",
        500,
      );
    }
  },
});
