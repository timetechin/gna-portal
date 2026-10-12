const { chromium } = require("playwright");
const XLSX = require("xlsx");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const connection =
  process.env.GNA_TEST_DATABASE_URL ||
  "postgresql://postgres@127.0.0.1:55432/gna_test";
const parsed = new URL(connection);
if (
  !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
  parsed.pathname != "/gna_test"
)
  throw Error("Browser checks require the isolated loopback gna_test database");
const server = spawn(process.env.BUN_EXECUTABLE || "bun", ["src/server.ts"], {
  cwd: require("node:path").resolve(__dirname, ".."),
  env: { ...process.env, DATABASE_URL: connection, PORT: "3303" },
  stdio: "ignore",
});
process.on("exit", () => server.kill());
(async () => {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch("http://127.0.0.1:3303/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error("PAGE ERROR:", e.message);
  });
  await page.route(
    "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
    (r) =>
      r.fulfill({
        path: require.resolve("xlsx/dist/xlsx.full.min.js"),
        contentType: "application/javascript",
      }),
  );
  await page.goto("http://127.0.0.1:3303");
  await page.locator("#username").fill("admin");
  await page.locator("#password").fill("test-password-123");
  await page.getByRole("button", { name: "Giriş Yap" }).click();
  await page.locator("#app").waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: "Bayi Carileri", exact: true })
    .click();
  await page.locator("#dealerRows .dealer-card").first().waitFor();
  assert.equal(
    await page.locator("#dealerRows").innerText(),
    "Girne Çarşı\nYenikent",
  );
  assert.equal(await page.locator("#productlist").isVisible(), false);
  await page.locator("#dealerSearch").fill("Girne");
  assert.equal(await page.locator("#dealerRows .dealer-card").count(), 1);
  await page.getByRole("button", { name: "Girne Çarşı", exact: true }).click();
  assert.equal(await page.locator("#dealerTitle").innerText(), "Girne Çarşı");
  const text = await page.locator("#itemtable").innerText();
  assert(text.includes("G1"));
  assert(!text.includes("Yenikent"));
  assert(!text.includes("Y1"));
  await page.getByRole("button", { name: "← Bayilere dön" }).click();
  assert.equal(await page.locator("#productlist").isVisible(), false);
  await page.getByRole("button", { name: "Ana Cariler", exact: true }).click();
  await page
    .locator("#accountRows .dealer-card")
    .filter({ hasText: "Ortak Ana Cari" })
    .click();
  assert(
    (await page.locator("#accountCards").innerText()).includes("Girne Çarşı"),
  );
  await page.locator("#attachDealer").selectOption("Yenikent");
  await page.getByRole("button", { name: "Bağla", exact: true }).click();
  await page
    .locator("#accountCards .customer-row")
    .filter({ hasText: "Yenikent" })
    .waitFor();
  await page
    .getByRole("button", { name: "Müşteri Cari Kartları", exact: true })
    .click();
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["MusteriKisaAd", "MusteriKod", "MusteriUnvan"],
    ["Excel Müşterisi", 123, "Excel Müşterisi Ltd."],
  ]);
  ws.B2.z = "000000";
  XLSX.utils.book_append_sheet(wb, ws, "Data");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  await page
    .locator("#customerFile")
    .setInputFiles({
      name: "279663-test.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer,
    });
  await page.getByRole("button", { name: "Müşteri Kartlarını Aktar" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#customerImportMessage")
      .textContent.includes("Yeni kart: 1"),
  );
  await page.locator("#customerSearch").fill("000123");
  assert(
    (await page.locator("#customerRows").innerText()).includes(
      "Excel Müşterisi Ltd.",
    ),
  );
  await page.getByRole("button", { name: "Müşteri Kartlarını Aktar" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#customerImportMessage")
      .textContent.includes("Yeni kart: 0"),
  );
  require("node:fs").mkdirSync(
    require("node:path").resolve(__dirname, "../artifacts"),
    { recursive: true },
  );
  await page.screenshot({
    path: require("node:path").resolve(
      __dirname,
      "../artifacts/customer-screen.png",
    ),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "İşlem Kayıtları", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector("#auditRows")
      .textContent.includes("Müşteri kartları aktarıldı"),
  );
  await page.getByRole("button", { name: "Çıkış", exact: true }).click();
  await page.locator("#username").fill("dealer");
  await page.locator("#password").fill("test-password-123");
  await page.getByRole("button", { name: "Giriş Yap" }).click();
  await page.locator("#app").waitFor({ state: "visible" });
  assert.equal(
    await page
      .getByRole("button", { name: "Ana Cariler", exact: true })
      .isVisible(),
    false,
  );
  await page
    .getByRole("button", { name: "Bayi Carileri", exact: true })
    .click();
  assert.equal(await page.locator("#dealerRows").innerText(), "Girne Çarşı");
  assert.deepEqual(errors, []);
  await browser.close();
  console.log(
    "PASS: dealer list/search/detail/back, main-account attach, real XLSX Data import with zero-padded code, repeat import, audit, dealer isolation and hidden admin controls.",
  );
})().finally(() => server.kill()).catch((e) => {
  console.error(e);
  process.exit(1);
});
