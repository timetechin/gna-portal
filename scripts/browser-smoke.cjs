const { chromium } = require("playwright"),
  XLSX = require("xlsx"),
  assert = require("node:assert/strict"),
  { spawn } = require("node:child_process"),
  path = require("node:path"),
  fs = require("node:fs");
const connection =
    process.env.GNA_TEST_DATABASE_URL ||
    "postgresql://postgres@127.0.0.1:55432/gna_test",
  parsed = new URL(connection);
if (
  !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
  parsed.pathname != "/gna_test"
)
  throw Error("Browser checks require the isolated loopback gna_test database");
const server = spawn(
  process.env.BUN_EXECUTABLE || "bun",
  [process.env.GNA_BROWSER_SERVER || "src/server.ts"],
  {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: connection, PORT: "3303" },
    stdio: "inherit",
  },
);
let browser;
process.on("exit", () => server.kill());
const workbook = (rows) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Data");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
};
(async () => {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch("http://127.0.0.1:3303/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error("PAGE ERROR:", e.message);
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.route(
    "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
    (r) =>
      r.fulfill({
        path: require.resolve("xlsx/dist/xlsx.full.min.js"),
        contentType: "application/javascript",
      }),
  );
  const login = async (username) => {
    await page.locator("#username").fill(username);
    await page.locator("#password").fill("test-password-123");
    await page.getByRole("button", { name: "Giriş Yap", exact: true }).click();
    await page
      .locator("#dealerRows .dealer-card")
      .first()
      .waitFor({ state: "attached" });
  };
  const nav = async (name) =>
    page.locator("nav").getByRole("button", { name, exact: true }).click();
  const read = async (endpoint) =>
    page.evaluate(async (p) => {
      const r = await fetch("/api/" + p);
      if (!r.ok) throw Error("HTTP " + r.status);
      return r.json();
    }, endpoint);
  const openDealer = async (shop) => {
    await nav("Bayi Carileri");
    await page
      .locator("#dealerRows .dealer-card[data-shop]")
      .filter({ hasText: shop })
      .click();
  };
  const upload = async (kind, name, rows) => {
    await nav("Excel Yükle");
    await page.locator("#" + kind + "file").setInputFiles({
      name,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: workbook(rows),
    });
    await page
      .locator("button[onclick=\"uploadFile('" + kind + "')\"]")
      .click();
    await page.waitForFunction(
      (k) =>
        document
          .getElementById(k + "msg")
          .textContent.startsWith("Güncellendi:"),
      kind,
    );
  };
  const undo = async (name) => {
    await nav("Excel Yükle");
    await page
      .locator("#importhistory tr:has(td)")
      .filter({ hasText: name })
      .getByRole("button", { name: "Geri Al", exact: true })
      .first()
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector("#undoMessage")
        ?.textContent.includes("Dosya geri alındı"),
    );
  };
  await page.goto("http://127.0.0.1:3303");
  await login("admin");
  await nav("Bayi Carileri");
  assert(
    (await page.locator("#dealerRows").innerText()).includes("Ortak Ana Cari"),
  );
  assert(
    (await page.locator("#dealerRows").innerText()).includes("Girne Çarşı"),
  );
  await page
    .locator("#dealerRows .dealer-card[data-id]")
    .filter({ hasText: "Ortak Ana Cari" })
    .click();
  assert.equal(await page.locator("#groupDealerRows .dealer-card").count(), 1);
  await page.locator("#groupDealerRows .dealer-card").click();
  await page.locator('#productViews button[data-bucket="paid"]').click();
  assert((await page.locator("#itemtable tbody").innerText()).includes("G1"));
  assert(
    !(await page.locator("#itemtable tbody").innerText()).includes("Yenikent"),
  );
  assert(
    (await page.locator("#itemtable thead").innerText()).includes(
      "Alım Tarihi",
    ),
  );
  assert(
    (await page.locator("#itemtable thead").innerText()).includes(
      "Aktivasyon Tarihi",
    ),
  );
  await page.locator("#filter-campaign summary").click();
  await page
    .locator("#filter-campaign")
    .getByRole("button", { name: "Seçimi kaldır", exact: true })
    .click();
  await page
    .locator("#filter-campaign")
    .getByRole("button", { name: "Tamam", exact: true })
    .click();
  assert.equal(await page.locator("#itemtable tbody tr").count(), 0);
  await page
    .getByRole("button", { name: "Sütun filtrelerini temizle" })
    .click();
  assert.equal(await page.locator("#itemtable tbody tr").count(), 1);
  await nav("Cari Kayıt Ayarları");
  assert.equal(
    await page
      .getByRole("button", { name: "Ana Cari Aç", exact: true })
      .isVisible(),
    true,
  );
  const groups = (await read("directory")).groups;
  const common = groups.find((g) => g.name === "Ortak Ana Cari");
  const yen = page.locator('#cariSettings tr[data-shop="Yenikent"]');
  await yen.locator(".setting-account").selectOption(String(common.id));
  await yen.getByRole("button", { name: "Bağlantıyı Kaydet" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#settingsMessage")
      .textContent.includes("kaydedildi"),
  );
  await nav("Bayi Carileri");
  await page
    .locator("#dealerRows .dealer-card[data-id]")
    .filter({ hasText: "Ortak Ana Cari" })
    .click();
  assert.equal(await page.locator("#groupDealerRows .dealer-card").count(), 2);
  await nav("Cari Kayıt Ayarları");
  const customerWB = XLSX.utils.book_new(),
    sheet = XLSX.utils.aoa_to_sheet([
      ["MusteriKisaAd", "MusteriKod", "MusteriUnvan"],
      ["Excel Müşterisi", 123, "Excel Müşterisi Ltd."],
    ]);
  sheet.B2.z = "000000";
  XLSX.utils.book_append_sheet(customerWB, sheet, "Data");
  await page.locator("#customerFile").setInputFiles({
    name: "279663-browser.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: XLSX.write(customerWB, { type: "buffer", bookType: "xlsx" }),
  });
  await page.getByRole("button", { name: "Müşteri Kartlarını Aktar" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#customerImportMessage")
      .textContent.includes("Yeni kart: 1"),
  );
  assert(
    (await page.locator("#customerSettingRows").innerText()).includes("000123"),
  );
  await page.getByRole("button", { name: "Müşteri Kartlarını Aktar" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#customerImportMessage")
      .textContent.includes("Yeni kart: 0"),
  );
  assert.equal(await page.locator("nav").getByRole("button",{name:"Müşteri Cari Kartları",exact:true}).count(),0);
  assert.equal(await page.locator("nav").getByRole("button",{name:"Vodafone Alacakları",exact:true}).count(),0);
  assert.equal(await page.locator("nav").getByRole("button",{name:"İşlem Kayıtları",exact:true}).count(),0);
  await nav("Excel Yükle");
  assert.equal(await page.locator("#onlyPrefix2").isChecked(), true);
  await upload("stock", "browser-stock.xlsx", [
    ["SeriNo", "MusteriKisaAd", "Urun", "BirimFiyat", "IslemTarihi"],
    ["2BROWSER-CASH", "Girne Çarşı", "Browser Phone", 100, "12.10.2026"],
    ["2BROWSER-TARIFF", "Yenikent", "Browser Phone", 100, "12.10.2026"],
    ["9BROWSER-IGNORED", "Yenikent", "Other Phone", 100, "12.10.2026"],
  ]);
  assert(!(await read("items")).some((x) => x.serial === "9BROWSER-IGNORED"));
  await nav("Excel Yükle");
  await page.locator("#onlyPrefix2").uncheck();
  await upload("stock", "browser-other.xlsx", [
    ["SeriNo", "MusteriKisaAd", "Urun", "BirimFiyat", "IslemTarihi"],
    ["9BROWSER-OTHER", "Yenikent", "Other Phone", 100, "12.10.2026"],
  ]);
  assert((await read("items")).some((x) => x.serial === "9BROWSER-OTHER"));
  await undo("browser-other.xlsx");
  await page.locator("#onlyPrefix2").check();
  await openDealer("Girne Çarşı");
  assert(
    (await page.locator("#itemtable tbody").innerText()).includes(
      "2BROWSER-CASH",
    ),
  );
  assert(
    (await page.locator("#itemtable tbody").innerText()).includes("12.10.2026"),
  );
  assert((await page.locator("#dealerDashboard").innerText()).includes("Eldeki Konsinye"));
  await page.locator("#dateMonth").fill("2026-11");
  await page.locator("#dateMonth").dispatchEvent("change");
  assert.equal(await page.locator("#itemtable tbody tr").count(),0);
  await page.getByRole("button",{name:"Tarihleri temizle",exact:true}).click();
  await page.locator("#filter-serial summary").click();
  await page.locator("#filter-serial").getByRole("button",{name:"Bu sütunu gizle",exact:true}).click();
  assert.equal(await page.locator("#filter-serial").count(),0);
  await page.getByRole("button",{name:"Gizli sütunları göster",exact:true}).click();
  const productDownloadPromise=page.waitForEvent("download");
  await page.getByRole("button",{name:"Excel İndir",exact:false}).click();
  const productDownload=await productDownloadPromise;
  const productWB=XLSX.readFile(await productDownload.path());
  const productRows=XLSX.utils.sheet_to_json(productWB.Sheets[productWB.SheetNames[0]]);
  assert(productRows.some(x=>x.Seri==="2BROWSER-CASH"));
  await nav("Excel Yükle");
  await page.locator("#activationfile").setInputFiles({name:"custom-campaign.xlsx",mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",buffer:workbook([["Aktivasyon Tarihi","Cihaz Kampanya Adı","Cihaz IMEI"],["14.10.2026","Özel Kampanya","2BROWSER-CASH"]])});
  await page.locator('.campaign-choice[data-campaign="Özel Kampanya"]').waitFor();
  await page.locator('.campaign-choice[data-campaign="Özel Kampanya"]').selectOption("Tarifeye Ek");
  await page.locator("button[onclick=\"uploadFile('activation')\"]").click();
  await page.waitForFunction(()=>activationmsg.textContent.startsWith("Güncellendi:"));
  assert.equal((await read("items")).find(x=>x.serial==="2BROWSER-CASH").campaign,"Tarifeye Ek");
  await undo("custom-campaign.xlsx");
  await upload("payment","missing-report.xlsx",[["SeriNo"],...Array.from({length:125},(_,i)=>["MISSING-BROWSER-"+i])]);
  assert((await page.locator("#paymentmsg").innerText()).includes("Hata: 125"));
  assert(!(await page.locator("#paymentmsg").innerText()).includes("MISSING-BROWSER"));
  const errorDownloadPromise=page.waitForEvent("download");
  await page.locator("#paymentReport").click();
  const errorDownload=await errorDownloadPromise;
  const errorWB=XLSX.readFile(await errorDownload.path());
  const errorRows=XLSX.utils.sheet_to_json(errorWB.Sheets[errorWB.SheetNames[0]]);
  assert.equal(errorRows.length,125);assert.equal(errorRows[124]["Seri / IMEI"],"MISSING-BROWSER-124");assert.equal(errorRows[124].Sebep,"Seri bulunamadı");
  await undo("missing-report.xlsx");
  await upload("payment", "browser-vdm.xlsx", [
    ["SeriNo"],
    ["2BROWSER-CASH"],
    ["2BROWSER-TARIFF"],
  ]);
  await openDealer("Girne Çarşı");
  assert(
    !(await page.locator("#itemtable tbody").innerText()).includes(
      "2BROWSER-CASH",
    ),
  );
  await page.locator('#productViews button[data-bucket="paid"]').click();
  assert(
    (await page.locator("#itemtable tbody").innerText()).includes(
      "2BROWSER-CASH",
    ),
  );
  await upload("activation", "browser-activation.xlsx", [
    [
      "SeriNo",
      "Aktivasyon Tarihi",
      "Bayi Adı",
      "D",
      "Cihaz Kampanya Adı",
      "Yanlış F",
      "G",
      "Cihaz IMEI",
    ],
    [
      "NOT-H-SERIAL",
      "14.10.2026",
      "Girne Çarşı",
      "",
      " gna   bayi cihaz kampanyasi ",
      "AYLIK TAAHHUTLU KAMPANYALAR",
      "",
      "2BROWSER-CASH",
    ],
    [
      "NOT-H-SERIAL",
      "14.10.2026",
      "Yenikent",
      "",
      " AYLIK   TAAHHUTLU KAMPANYALAR ",
      "GNA BAYI CIHAZ KAMPANYASI",
      "",
      "2BROWSER-TARIFF",
    ],
  ]);
  const actual = await read("items");
  assert.equal(
    actual.find((x) => x.serial === "2BROWSER-CASH").campaign,
    "Peşin Satış",
  );
  assert.equal(
    actual.find((x) => x.serial === "2BROWSER-TARIFF").campaign,
    "Tarifeye Ek",
  );
  assert.equal(
    actual.find((x) => x.serial === "2BROWSER-CASH").sold,
    "2026-10-14",
  );
  await openDealer("Girne Çarşı");
  await page.locator('#productViews button[data-bucket="paid"]').click();
  assert(
    !(await page.locator("#itemtable tbody").innerText()).includes(
      "2BROWSER-CASH",
    ),
  );
  await page.locator('#productViews button[data-bucket="closed"]').click();
  assert(
    (await page.locator("#itemtable tbody").innerText()).includes(
      "2BROWSER-CASH",
    ),
  );
  await openDealer("Yenikent");
  await page.locator('#productViews button[data-bucket="vf"]').click();
  assert(
    (await page.locator("#itemtable tbody").innerText()).includes(
      "2BROWSER-TARIFF",
    ),
  );
  assert(
    (await page.locator("#itemtable tbody").innerText()).includes(
      "VF’den Ödeme Bekleniyor",
    ),
  );
  await nav("Fiyatlama Listesi");
  const priceRow = page.locator('#priceRows tr[data-product="Browser Phone"]');
  await priceRow.locator(".price-purchase").fill("100");
  await priceRow.locator(".price-cash").fill("240");
  await priceRow.locator(".price-tariff").fill("40");
  await priceRow.getByRole("button", { name: "Kaydet", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector("#priceMessage").textContent.includes("kaydedildi"),
  );
  await openDealer("Girne Çarşı");
  await page.getByRole("button", { name: "Kârlılık", exact: true }).click();
  await page.locator("#profitMonth").selectOption("2026-10");
  await page.waitForFunction(() =>
    document.querySelector("#profitContent").textContent.includes("140,00"),
  );
  assert(
    (await page.locator("#profitContent").innerText()).includes(
      "2BROWSER-CASH",
    ),
  );
  await upload("vf_payment", "browser-vf.xlsx", [
    ["IMEI", "Ödeme Tarihi"],
    ["2BROWSER-TARIFF", "16.10.2026"],
  ]);
  await openDealer("Yenikent");
  await page.locator('#productViews button[data-bucket="vf"]').click();
  assert(
    !(await page.locator("#itemtable tbody").innerText()).includes(
      "2BROWSER-TARIFF",
    ),
  );
  assert((await read("items")).some((x) => x.serial === "2BROWSER-TARIFF"));
  await undo("browser-vf.xlsx");
  await openDealer("Yenikent");
  await page.locator('#productViews button[data-bucket="vf"]').click();
  assert(
    (await page.locator("#itemtable tbody").innerText()).includes(
      "2BROWSER-TARIFF",
    ),
  );
  for (const file of [
    "browser-activation.xlsx",
    "browser-vdm.xlsx",
    "browser-stock.xlsx",
  ])
    await undo(file);
  assert(!(await read("items")).some((x) => x.serial.startsWith("2BROWSER-")));
  await nav("Excel Yükle");
  const old = page
    .locator("#importhistory tr:has(td)")
    .filter({ hasText: "old-history.xlsx" });
  assert((await old.innerText()).includes("Geri alma desteklenmiyor"));
  assert.equal(await old.getByRole("button", { name: "Geri Al" }).count(), 0);
  await undo("279663-browser.xlsx");
  await undo("279663-browser.xlsx");
  assert(!(await read("customers")).some((c) => c.code === "000123"));
  await nav("Bayi Carileri");
  fs.mkdirSync(path.resolve(__dirname, "../artifacts"), { recursive: true });
  await page.screenshot({
    path: path.resolve(__dirname, "../artifacts/dealer-groups.png"),
    fullPage: true,
  });
  await nav("Kullanıcı Yönetimi");
  const edit=page.locator('#userlist button[data-user="edited-dealer"]');
  await edit.click();
  await page.locator("#newrole").selectOption("admin");
  await page.locator("#newpass").fill("ui-password-123");
  await page.getByRole("button",{name:"Şifreyi göster",exact:true}).click();
  assert.equal(await page.locator("#newpass").getAttribute("type"),"text");
  await page.locator('#users button[onclick="createUser()"]').click();
  await page.waitForFunction(()=>usermsg.textContent.includes("güncellendi"));
  assert.equal((await read("users")).find(x=>x.username==="edited-dealer").role,"admin");
  await nav("Çıkış");
  await login("dealer");
  assert.equal(
    await page
      .locator("nav")
      .getByRole("button", { name: "Cari Kayıt Ayarları", exact: true })
      .isVisible(),
    false,
  );
  assert.equal(
    await page
      .locator("nav")
      .getByRole("button", { name: "Fiyatlama Listesi", exact: true })
      .isVisible(),
    false,
  );
  await nav("Bayi Carileri");
  assert(!(await page.locator("#dealerRows").innerText()).includes("Yenikent"));
  assert.deepEqual(errors, []);
  console.log(
    "PASS: main/sub-dealer navigation, settings isolation, column multiselect filters, actual E/H XLSX classification, date import, monthly profit, VDM/VF queues, full file undo, zero-padded customer import, legacy safeguards and dealer permissions.",
  );
})()
  .finally(async () => {
    if (browser) await browser.close();
    server.kill();
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
