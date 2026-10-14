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
  const confirmTargets = async () => {
    await page.locator("#uploadTargetDialog").waitFor();
    const selects = page.locator("#uploadTargetDialog select");
    for(let i=0;i<await selects.count();i++) {
      if(!await selects.nth(i).inputValue()) await selects.nth(i).selectOption("Girne Çarşı");
    }
    await page.locator("#uploadTargetDialog button[type=submit]").click();
  };
  const upload = async (kind, name, rows) => {
    await nav("Excel Yükle");
    const original = workbook(rows);
    await page.locator("#" + kind + "file").setInputFiles({
      name,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: original,
    });
    await page
      .locator("button[onclick=\"uploadFile('" + kind + "')\"]")
      .click();
    if(kind === "stock" || kind === "payment") await confirmTargets();
    await page.waitForFunction(
      (k) =>
        document
          .getElementById(k + "msg")
          .textContent.startsWith("Güncellendi:"),
      kind,
    );
    const history=page.locator("#importhistory tr").filter({has:page.locator("td")}).filter({hasText:name}).first();
    const [download]=await Promise.all([page.waitForEvent("download"),history.getByRole("link",{name:"Excel’i İndir",exact:true}).click()]);
    assert.equal(download.suggestedFilename(),name);
    assert.deepEqual(fs.readFileSync(await download.path()),original);
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
  assert.equal(await page.locator("#dealerlist").getByRole("button",{name:"Mükerrer Kayıtları Göster",exact:true}).count(),0);
  const duplicateSeed=await page.evaluate(async()=>{
    const response=await fetch("/api/import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"stock",filename:"duplicate-browser.xlsx",rows:[{serial:"2BROWSER-DUPLICATE",shop:"Girne Çarşı",product:"Duplicate Browser",price:1},{serial:"'2BROWSER-DUPLICATE",shop:"Girne Çarşı",product:"Duplicate Browser",price:1},{serial:"2BROWSER-DUPLICATE",shop:"Yenikent",product:"Duplicate Browser",price:1}]})});
    if(!response.ok)throw Error("Duplicate fixture failed");return response.json();
  });
  await openDealer("Girne Çarşı");
  assert.equal(await page.locator("#productlist #showDuplicateRecordsButton").isVisible(),true);
  await page.getByRole("button",{name:"Mükerrer Kayıtları Göster",exact:true}).click();
  await page.locator("#duplicateRecordsSearch").fill("2BROWSER-DUPLICATE");
  await page.waitForFunction(()=>document.querySelectorAll("#duplicateRecordsTable tbody tr").length===2);
  assert((await page.locator("#duplicateRecordsTable").innerText()).includes("Girne Çarşı"));
  assert(!(await page.locator("#duplicateRecordsTable").innerText()).includes("Yenikent"));
  const [duplicateDownload]=await Promise.all([page.waitForEvent("download"),page.locator("#duplicateRecordsDialog").getByRole("button",{name:"Excel’e Aktar",exact:true}).click()]);
  const duplicateWB=XLSX.readFile(await duplicateDownload.path());
  assert.equal(XLSX.utils.sheet_to_json(duplicateWB.Sheets[duplicateWB.SheetNames[0]]).length,2);
  await page.locator("#duplicateRecordsSearch").fill("NO-MATCH-DUPLICATE");
  assert((await page.locator("#duplicateRecordsTable").innerText()).includes("Aramaya uygun kayıt bulunamadı"));
  await page.locator("#duplicateRecordsDialog [data-close]").click();
  await page.evaluate(async id=>{const r=await fetch("/api/uploads/"+id+"/undo",{method:"POST"});if(!r.ok)throw Error("Duplicate fixture undo failed");},duplicateSeed.batch_id);
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
  await page.locator('#productViews button[data-bucket="active"]').click();
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
  // Opening the confirmation and cancelling must not create an upload or change items.
  const beforeCancel = await read("imports");
  await page.locator("button[onclick=\"uploadFile('stock')\"]").click();
  await page.locator("#uploadTargetDialog").waitFor();
  assert.equal((await read("imports")).length, beforeCancel.length);
  await page.locator("#uploadTargetDialog [data-cancel]").click();
  await page.waitForFunction(() => stockmsg.textContent.includes("Yükleme iptal edildi"));
  assert.equal((await read("imports")).length, beforeCancel.length);
  assert.equal(await page.locator("#stockfile").isEnabled(), true);
  // Explicit stock remapping uses the selected dealer, with reversible provenance.
  await page.locator("#stockfile").setInputFiles({name:"mapped-stock.xlsx",mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",buffer:workbook([["SeriNo","MusteriKisaAd","Urun","BirimFiyat"],["2TARGET-REMAP","Excel Bayi Adı","Target Phone",10]])});
  await page.locator("button[onclick=\"uploadFile('stock')\"]").click();
  await page.locator("#uploadTargetDialog select").selectOption("Girne Çarşı");
  assert((await page.locator("#uploadTargetDialog select").innerText()).includes("Ana Cari:"));
  await page.locator("#uploadTargetDialog button[type=submit]").click();
  await page.waitForFunction(() => stockmsg.textContent.startsWith("Güncellendi:"));
  assert.equal((await read("items")).find(x => x.serial === "2TARGET-REMAP").shop,"Girne Çarşı");
  await undo("mapped-stock.xlsx");
  assert(!(await read("items")).some(x => x.serial === "2TARGET-REMAP"));
  // A serial belonging to another dealer must never be paid through the selected dealer.
  await nav("Excel Yükle");
  await page.locator("#paymentfile").setInputFiles({name:"wrong-dealer-payment.xlsx",mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",buffer:workbook([["SeriNo"],["2BROWSER-TARIFF"]])});
  await page.locator("button[onclick=\"uploadFile('payment')\"]").click();
  await page.locator("#uploadTargetDialog select").selectOption("Girne Çarşı");
  await page.locator("#uploadTargetDialog button[type=submit]").click();
  await page.waitForFunction(() => paymentmsg.textContent.startsWith("Güncellendi:"));
  assert(!(await read("items")).find(x => x.serial === "2BROWSER-TARIFF").paid_on);
  assert((await page.locator("#paymentmsg").innerText()).includes("Güncellendi: 0"));

  await nav("Excel Yükle");
  await page.locator("#onlyPrefix2").uncheck();
  await upload("stock", "browser-other.xlsx", [
    ["SeriNo", "MusteriKisaAd", "Urun", "BirimFiyat", "IslemTarihi"],
    ["9BROWSER-OTHER", "Yenikent", "Other Phone", 100, "12.10.2026"],
  ]);
  assert((await read("items")).some((x) => x.serial === "9BROWSER-OTHER"));
  await undo("browser-other.xlsx");
  const undoneArchive=page.locator("#importhistory tr").filter({has:page.locator("td")}).filter({hasText:"browser-other.xlsx"}).first();
  assert((await undoneArchive.innerText()).includes("Geri alındı"));
  assert.equal(await undoneArchive.getByRole("link",{name:"Excel’i İndir",exact:true}).count(),1);

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
  assert((await page.locator("#dealerDashboard").innerText()).includes("Eldeki Ürün Adedi"));
  await page.locator("#dateMonth").fill("2026-11");
  await page.locator("#dateMonth").dispatchEvent("change");
  assert.equal(await page.locator("#itemtable tbody tr").count(),0);
  await page.getByRole("button",{name:"Tarihleri temizle",exact:true}).click();
  await page.locator("#filter-serial summary").click();
  await page.locator("#filter-serial").getByRole("button",{name:"Bu sütunu gizle",exact:true}).click();
  assert.equal(await page.locator("#filter-serial").count(),0);
  await page.getByRole("button",{name:"Gizli sütunları göster",exact:true}).click();
  const productDownloadPromise=page.waitForEvent("download");
  await page.getByRole("button",{name:"Excel’e Aktar",exact:true}).click();
  const productDownload=await productDownloadPromise;
  const productWB=XLSX.readFile(await productDownload.path());
  const productRows=XLSX.utils.sheet_to_json(productWB.Sheets[productWB.SheetNames[0]]);
  assert(productRows.some(x=>x.Seri==="2BROWSER-CASH"));
  await nav("Excel Yükle");
  await page.locator("#activationfile").setInputFiles({name:"custom-campaign.xlsx",mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",buffer:workbook([["Aktivasyon Tarihi","Cihaz Kampanya Adı","Cihaz IMEI"],["14.10.2026","Özel Kampanya","2BROWSER-CASH"]])});
  await page.locator('.campaign-choice[data-campaign="Özel Kampanya"]').waitFor({state:"attached"});
  await page.locator('#activationCriteria summary').click();
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
  assert.equal(errorRows.length,125);assert.equal(errorRows[124]["Seri / IMEI"],"MISSING-BROWSER-124");assert.equal(errorRows[124].Sebep,"Seri teyit edilen bayide bulunamadı · Girne Çarşı");
  await undo("missing-report.xlsx");
  await upload("payment","generic-payment-headers.xlsx",[
    ["Ödeme raporu"],
    ["Column1","Column2","Column3","Column4","Column5","Column6"],
    ["Girne Çarşı",46100,"Browser Phone","2BROWSER-CASH",100,"TARİFEYE EK"]
  ]);
  assert.equal(await page.locator("#paymentSerial").inputValue(),"3");
  assert.equal(await page.locator("#paymentHeader").inputValue(),"2");
  assert.equal((await read("items")).find(x=>x.serial==="2BROWSER-CASH").paid_on,"Ödendi");
  await undo("generic-payment-headers.xlsx");
  if(process.env.GNA_PAYMENT_SAMPLE){
    const sampleWB=XLSX.readFile(process.env.GNA_PAYMENT_SAMPLE);const sampleData=XLSX.utils.sheet_to_json(sampleWB.Sheets["ANA VERILER"],{header:1,raw:true}).slice(1);
    const seed=await page.evaluate(async rows=>{const r=await fetch("/api/import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"stock",filename:"payment-sample-seed.xlsx",rows})});if(!r.ok)throw Error("Sample fixture failed");return r.json();},sampleData.map(row=>({serial:String(row[3]),shop:"Payment Sample Fixture",product:"Sample Test",price:1})));
    await nav("Excel Yükle");await page.locator("#paymentfile").setInputFiles(process.env.GNA_PAYMENT_SAMPLE);
    await page.waitForFunction(()=>document.getElementById("paymentSerial")?.value==="3"&&document.getElementById("paymentSheet")?.value==="ANA VERILER");
    assert.equal(await page.locator("#paymentSheet").inputValue(),"ANA VERILER");
    const parsed=await page.evaluate(()=>readPaymentRows("payment"));assert.equal(parsed.rows.length,798);assert.equal(parsed.rows[0].source_row,2);
    await page.locator("button[onclick=\"uploadFile('payment')\"]").click();await confirmTargets();await page.waitForFunction(()=>paymentmsg.textContent.startsWith("Güncellendi:"));assert((await page.locator("#paymentmsg").innerText()).includes("Güncellendi: 798"));
    await undo(require("node:path").basename(process.env.GNA_PAYMENT_SAMPLE));
    const sampleItems=(await read("items")).filter(x=>x.shop==="Payment Sample Fixture");assert.equal(sampleItems.length,798);assert(sampleItems.every(x=>!x.paid_on));
    await page.evaluate(async id=>{const r=await fetch("/api/uploads/"+id+"/undo",{method:"POST"});if(!r.ok)throw Error("Sample fixture undo failed");},seed.batch_id);
  }
  await nav('Excel Yükle');
  const wideWB=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wideWB,XLSX.utils.aoa_to_sheet([['Ödeme listesi'],[],['Bayi'],['Girne Çarşı','','','','','','','2BROWSER-CASH']]),' VF Ödemeleri ');
  await page.locator('#vf_paymentfile').setInputFiles({name:'vf-wide-columns.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:XLSX.write(wideWB,{type:'buffer',bookType:'xlsx'})});
  await page.waitForSelector('#vf_paymentSerial');
  assert(await page.locator('#vf_paymentCriteria').evaluate(el=>el.open));
  assert.equal(await page.locator('#vf_paymentSerial option').count(),8);
  await page.locator('#vf_paymentNoHeader').check();await page.locator('#vf_paymentHeader').fill('4');await page.locator('#vf_paymentHeader').dispatchEvent('change');
  await page.locator('#vf_paymentSerial').selectOption('7');
  assert((await page.locator('#vf_paymentDetected').innerText()).includes('Seri sütunu: H'));
  assert((await page.locator('#vf_paymentDetected').innerText()).includes('2BROWSER-CASH'));
  const vfParsed=await page.evaluate(()=>readPaymentRows('vf_payment'));assert.equal(vfParsed.rows[0].serial,'2BROWSER-CASH');
  assert.equal(await page.locator('#vf_paymentSheet').inputValue(),' VF Ödemeleri ');
  if(process.env.GNA_VF_PAYMENT_SAMPLE){
    await page.locator('#vf_paymentfile').setInputFiles(process.env.GNA_VF_PAYMENT_SAMPLE);
    await page.waitForFunction(()=>document.querySelector('#vf_paymentSheet')?.value==='GNA Fatura ' && document.querySelector('#vf_paymentSerial')?.value==='3');
    const actualVf=await page.evaluate(()=>readPaymentRows('vf_payment'));
    const vfBook=XLSX.readFile(process.env.GNA_VF_PAYMENT_SAMPLE),expected=XLSX.utils.sheet_to_json(vfBook.Sheets['GNA Fatura '],{header:1,raw:true}).slice(1);
    assert.equal(actualVf.rows.length,1881);assert.equal(actualVf.issues.length,0);
    assert.deepEqual(actualVf.rows.map(r=>r.serial),expected.map(r=>String(r[3])));
    assert.equal(actualVf.rows[0].source_row,2);
  }


  const activationRouteWB=XLSX.utils.book_new();XLSX.utils.book_append_sheet(activationRouteWB,XLSX.utils.aoa_to_sheet([['Cihaz Satış Dönemi','Cihaz Satış Tarihi','Cihaz Satıcı','Cihaz Kaydı Yapan','Cihaz Kampanya Adı','Cihaz Tür','Cihaz Marka','Cihaz IMEI'],['202603',46090,'DEREBOYU SHOP','Test','GNA BAYI CIHAZ KAMPANYASI','AKSESUAR','Phone',200000400026239]]),'Data');
  await nav('Excel Yükle');
  await page.locator('#paymentfile').setInputFiles({name:'activation-in-payment.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:XLSX.write(activationRouteWB,{type:'buffer',bookType:'xlsx'})});
  await page.getByRole('button',{name:'Vodafone Aktivasyonlarında Aç',exact:true}).waitFor();
  await page.locator("button[onclick=\"uploadFile('payment')\"]").click();
  await page.waitForFunction(()=>paymentmsg.textContent.includes('Bu dosya aktivasyon raporu'));
  await page.getByRole('button',{name:'Vodafone Aktivasyonlarında Aç',exact:true}).click();
  await page.waitForSelector('#activation-serial');
  assert.equal(await page.evaluate(()=>activationCampaign('PESIN   SATIS KAMPANYASI')),'Tarifeye Ek');
  assert.equal(await page.evaluate(()=>activationCampaign('Peşin Satış Kampanyası')),'Tarifeye Ek');
  const route=await page.evaluate(row=>({serial:activationColumn(row,'serial',['Cihaz IMEI'],7),campaign:chosenCampaign(activationColumn(row,'campaign',['Cihaz Kampanya Adı'],4))}),{'Cihaz IMEI':200000400026239,'Cihaz Kampanya Adı':'GNA BAYI CIHAZ KAMPANYASI'});
  assert.equal(String(route.serial),'200000400026239');assert.equal(route.campaign,'Peşin Satış');
  if(process.env.GNA_ACTIVATION_SAMPLE){
    await page.locator('#activationfile').setInputFiles(process.env.GNA_ACTIVATION_SAMPLE);
    await page.waitForFunction(()=>document.querySelector('#activationSheet')?.value==='Data' && document.querySelector('#activation-serial'));
    await page.evaluate(()=>previewActivation());
    const sampleActualWB=XLSX.readFile(process.env.GNA_ACTIVATION_SAMPLE);const sampleActualRows=XLSX.utils.sheet_to_json(sampleActualWB.Sheets['Data'],{raw:true});
    const parsedActual=await page.evaluate(rows=>rows.map(o=>({serial:String(activationColumn(o,'serial',['Cihaz IMEI'],7)),campaign:chosenCampaign(activationColumn(o,'campaign',['Cihaz Kampanya Adı'],4)),sold:activationColumn(o,'date',['Cihaz Satış Tarihi'],1)})).filter(x=>x.serial),sampleActualRows);
    assert.equal(parsedActual.length,1);assert.deepEqual(parsedActual[0],{serial:'200000400026239',campaign:'Peşin Satış',sold:46090});
  }
  await upload("payment", "browser-vdm.xlsx", [
    ["SeriNo"],
    ["2BROWSER-CASH"],
    ["2BROWSER-TARIFF"],
  ]);
  await openDealer("Girne Çarşı");
  assert(
    (await page.locator("#itemtable tbody").innerText()).includes(
      "2BROWSER-CASH",
    ),
  );
  assert((await page.locator('#itemtable tbody tr').filter({hasText:'2BROWSER-CASH'}).innerText()).includes('VDM’ye Ödendi'));
  await page.locator('#productViews button[data-bucket="paid"]').click();
  assert(
    (await page.locator("#itemtable tbody").innerText()).includes(
      "2BROWSER-CASH",
    ),
  );
  await page.locator('#productViews button[data-bucket="vf"]').click();
  const stockWaiting = page.locator('#itemtable tbody tr').filter({hasText:'2BROWSER-CASH'});
  assert((await stockWaiting.innerText()).includes('Stokta'));
  assert((await stockWaiting.innerText()).includes('VF’den Ödeme Bekleniyor'));
  assert((await stockWaiting.innerText()).includes('VDM’ye Ödendi'));
  await page.evaluate(()=>hideColumn('paid'));
  assert.equal(await page.locator('#filter-paid').count(),1);
  await page.evaluate(()=>restoreColumns());
  await page.locator('#productViews button[data-bucket="paid"]').click();
  assert((await page.locator('#itemtable tbody').innerText()).includes('2BROWSER-CASH'));
  assert.equal(await page.locator('#filter-vf').count(),0);
  const [paidExport]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Excel’e Aktar',exact:true}).click()]);
  const paidExportBook=XLSX.readFile(await paidExport.path());
  assert(!XLSX.utils.sheet_to_json(paidExportBook.Sheets[paidExportBook.SheetNames[0]],{header:1})[0].includes('Vodafone'));
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
    (await page.locator("#itemtable tbody").innerText()).includes(
      "2BROWSER-CASH",
    ),
  );
  await nav("Ayarlar");
  await page.waitForSelector('[data-rule="paid"] [data-sale="cash"]');
  assert(await page.locator('[data-rule="paid"] [data-sale="cash"]').isChecked());
  for(const key of ['vf','closed']){assert(await page.locator(`[data-rule="${key}"] [data-vdm-required]`).isChecked());assert(await page.locator(`[data-rule="${key}"] [data-vdm-required]`).isDisabled());}
  await page.locator('[data-rule="paid"] [data-sale="cash"]').uncheck();
  await page.getByRole('button',{name:'Toplu Kaydet',exact:true}).click();
  await page.waitForFunction(()=>listRulesMessage.textContent.includes('kaydedildi'));
  await page.reload();await page.waitForFunction(()=>document.querySelector('#userlist table'));await nav('Ayarlar');await page.waitForSelector('[data-rule="paid"]');
  assert(!(await page.locator('[data-rule="paid"] [data-sale="cash"]').isChecked()));
  await openDealer('Girne Çarşı');await page.locator('#productViews button[data-bucket="paid"]').click();
  assert(!(await page.locator('#itemtable tbody').innerText()).includes('2BROWSER-CASH'));
  await nav('Ayarlar');await page.waitForSelector('[data-rule="paid"]');
  await page.getByRole('button',{name:'Varsayılanları forma getir',exact:true}).click();
  await page.getByRole('button',{name:'Toplu Kaydet',exact:true}).click();
  await page.waitForFunction(()=>listRulesMessage.textContent.includes('kaydedildi'));
  await openDealer('Girne Çarşı');await page.locator('#productViews button[data-bucket="paid"]').click();
  assert((await page.locator('#itemtable tbody').innerText()).includes('2BROWSER-CASH'));
  await page.locator('#productViews button[data-bucket="closed"]').click();
  assert(
    (await page.locator("#itemtable tbody").innerText()).includes(
      "2BROWSER-CASH",
    ),
  );
  await openDealer("Yenikent");
  assert((await page.locator('#itemtable tbody tr').filter({hasText:'2BROWSER-TARIFF'}).innerText()).includes('VDM’ye Ödendi'));
  await page.locator('#productViews button[data-bucket="paid"]').click();
  assert(!(await page.locator('#itemtable tbody').innerText()).includes('2BROWSER-TARIFF'));
  await page.locator('#productViews button[data-bucket="vf"]').click();
  assert(!(await page.locator('#itemtable tbody').innerText()).includes('2BROWSER-TARIFF'));
  await page.locator('#productViews button[data-bucket="active"]').click();
  assert((await page.locator('#itemtable tr.tariff-row .tariff-badge').count())>0);
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
    document.querySelector("#profitContent").textContent.includes("124,00"),
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
    !(await page.locator("#itemtable tbody").innerText()).includes(
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
  await nav("Fiyatlama Listesi");
  await page.locator("#priceSearch").fill("Bulk A");
  const bulkRow=page.locator('#priceRows tr[data-product="Bulk A"]');
  await bulkRow.locator(".price-cash").fill("210");
  await page.locator("#priceSearch").fill("Bulk B");
  await page.locator('#priceRows tr[data-product="Bulk B"] .price-cash').fill("120");
  await page.getByRole("button",{name:"Toplu Kaydet",exact:true}).click();
  await page.waitForFunction(()=>priceMessage.textContent.includes("2 fiyat toplu kaydedildi"));
  const bulkPrices=await read("prices");assert.equal(Number(bulkPrices.find(x=>x.product==="Bulk A").cash_sale_price),210);assert.equal(Number(bulkPrices.find(x=>x.product==="Bulk B").cash_sale_price),120);
  await upload("stock","browser-manual.xlsx",[["SeriNo","MusteriKisaAd","Urun","BirimFiyat","IslemTarihi"],["2BROWSER-MANUAL","Girne Çarşı","Edit Browser Phone",100,"01.01.2026"]]);
  await openDealer("Girne Çarşı");
  assert.equal(await page.locator("#productfilter").isVisible(),false);
  const manualId=(await read("items")).find(x=>x.serial==="2BROWSER-MANUAL").id;
  let manualRow=page.locator('#itemtable tr[data-id="'+manualId+'"]');
  assert.equal((await manualRow.locator(".age-badge").innerText()),"45 gün geçti");
  assert.equal(await page.locator("#topExcelDownload").isVisible(),false);
  await manualRow.locator('input[type="checkbox"]').check();
  const selectedDownloadPromise=page.waitForEvent("download");
  await page.getByRole("button",{name:"Excel’e Aktar",exact:true}).click();
  const selectedDownload=await selectedDownloadPromise;const selectedWB=XLSX.readFile(await selectedDownload.path());const selectedRows=XLSX.utils.sheet_to_json(selectedWB.Sheets[selectedWB.SheetNames[0]]);assert.equal(selectedRows.length,1);assert.equal(selectedRows[0].Seri,"2BROWSER-MANUAL");
  await page.locator("#filter-product summary").click();
  assert.equal(await page.locator("#filter-product .column-menu").evaluate(el=>getComputedStyle(el).position),"absolute");
  await page.locator("#filter-product summary").click();
  await manualRow.getByRole("button",{name:"Düzenle",exact:true}).click();
  await page.locator("#editItemProduct").fill("UI Edited Product");
  await page.locator('#itemEditor button[onclick="saveProductEdit()"]').click();
  await page.locator("#itemEditor").waitFor({state:"hidden"});
  await page.waitForFunction(()=>document.querySelector("#itemtable").innerText.includes("UI Edited Product"));
  manualRow=page.locator('#itemtable tr[data-id="'+manualId+'"]');await manualRow.getByRole("button",{name:"Sil",exact:true}).click();
  await page.waitForFunction(id=>!document.querySelector('#itemtable tr[data-id="'+id+'"]'),manualId);
  assert(!(await read("items")).some(x=>String(x.id)===String(manualId)));
  await nav("Excel Yükle");
  const boxes=await page.locator(".uploadgrid > .uploadbox").evaluateAll(els=>els.map(el=>({x:el.getBoundingClientRect().x,y:el.getBoundingClientRect().y})));
  assert.equal(boxes.length,4);assert(boxes.every(box=>Math.abs(box.y-boxes[0].y)<2));assert(boxes[3].x>boxes[0].x);
  await page.screenshot({path:path.resolve(__dirname,"../artifacts/upload-cards.png"),fullPage:true});
  assert.equal(await page.locator("#defaultTariff").isVisible(),true);assert.equal(await page.locator("#defaultCash").isVisible(),true);
  const beforeWidth=await page.locator("main").evaluate(el=>el.getBoundingClientRect().width);
  await page.locator("#menuToggle").click();assert.equal(await page.locator("#sidebar").isVisible(),true);await page.waitForFunction(()=>document.getElementById("sidebar").getBoundingClientRect().width<100);assert((await page.locator("#sidebar").evaluate(el=>el.getBoundingClientRect().width))<100);assert((await page.locator("main").evaluate(el=>el.getBoundingClientRect().width))>beforeWidth);await page.locator("#menuToggle").click();
  await page.locator("#previewSelect").selectOption("shop:Girne Çarşı");await page.getByRole("button",{name:"Görüntüle",exact:true}).click();await page.locator("#previewNotice").waitFor({state:"visible"});
  assert.equal(await page.locator("nav").getByRole("button",{name:"Fiyatlama Listesi",exact:true}).isVisible(),false);await nav("Bayi Carileri");assert(!(await page.locator("#dealerRows").innerText()).includes("Yenikent"));
  await page.getByRole("button",{name:"Yönetici görünümüne dön",exact:true}).click();await page.locator("#previewNotice").waitFor({state:"hidden"});
  await nav("Kullanıcı Yönetimi");await page.locator('#userlist button[data-user]').first().waitFor();
  await page.locator('#users button[onclick="cancelUserEdit()"]').click();await page.locator("#newaccount").selectOption(String(common.id));await page.locator("#newname").fill("browser-parent");await page.locator("#newpass").fill("test-password-123");await page.locator('#users button[onclick="createUser()"]').click();await page.waitForFunction(()=>usermsg.textContent.includes("oluşturuldu"));
  await nav("Çıkış");await login("browser-parent");await nav("Bayi Carileri");assert((await page.locator("#dealerRows").innerText()).includes("Yenikent"));assert((await page.locator("#dealerRows").innerText()).includes("Girne Çarşı"));
  await nav("Çıkış");await login("admin");
  const dueFixture=await page.evaluate(async()=>{
    const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Bucharest'}).format(new Date());
    const day=age=>new Date(Date.parse(today+'T00:00:00Z')-age*86400000).toISOString().slice(0,10);
    const post=async(path,body,method='POST')=>{const r=await fetch('/api/'+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error('Due fixture request failed');return r.json();};
    const rows=[['2DUE-45',45],['2DUE-46',46],['2DUE-44',44],['2DUE-CASH',0],['2DUE-TARIFF',46],['2DUE-PAID-STOCK',46],['2DUE-PAID-CASH',0],['2DUE-UNDATED',null]].map(([serial,age])=>({serial,shop:'Due Fixture',product:'Due Phone',price:10,shipped:age===null?null:day(age)}));
    const stock=await post('import',{kind:'stock',filename:'due-fixture-stock.xlsx',rows});
    const activation=await post('import',{kind:'activation',filename:'due-fixture-activation.xlsx',rows:[{serial:'2DUE-CASH',campaign:'Peşin Satış',sold:today},{serial:'2DUE-PAID-CASH',campaign:'Peşin Satış',sold:today},{serial:'2DUE-TARIFF',campaign:'Tarifeye Ek',sold:today}]});
    const sale=await post('import',{kind:'sale_price',filename:'due-sale-prices.xlsx',rows:[{serial:'2DUE-CASH',cash_sale_price:70},{serial:'2DUE-PAID-CASH',cash_sale_price:40}]});
    await post('prices',{product:'Due Phone',purchase_price:999,cash_sale_price:null,tariff_profit:25},'PUT');
    const paid=await post('import',{kind:'payment',filename:'due-fixture-payment.xlsx',rows:[{serial:'2DUE-PAID-STOCK'},{serial:'2DUE-PAID-CASH'}]});
    await refresh();return {stock:stock.batch_id,activation:activation.batch_id,sale:sale.batch_id,paid:paid.batch_id,today};
  });
  await openDealer('Due Fixture');await page.locator('#productViews button[data-bucket="due"]').click();
  for(const [key,value] of [['cash-profit','90,00'],['tariff-profit','25,00'],['profit-total','115,00'],['due-cash','10,00'],['due-stock','20,00'],['due-total','30,00'],['stock-count','5 ürün']])assert((await page.locator('#dealerDashboard [data-metric="'+key+'"]').innerText()).includes(value));
  await page.locator('#dealerDashboard').getByRole('button',{name:/45 Günü Dolan Stok/}).click();assert.equal(await page.locator('#itemtable tbody tr').count(),2);
  await page.locator('#dealerDashboard').getByRole('button',{name:/Peşin Satılan/}).click();assert.equal(await page.locator('#itemtable tbody tr').count(),1);
  await page.locator('#dealerDashboard').getByRole('button',{name:/Toplam Ödenecek/}).click();assert.equal(await page.locator('#itemtable tbody tr').count(),3);

  assert((await page.locator('#productViews button[data-bucket="due"]').innerText()).includes('(3)'));
  const dueText=await page.locator('#itemtable tbody').innerText();
  for(const serial of ['2DUE-45','2DUE-46','2DUE-CASH'])assert(dueText.includes(serial));
  for(const serial of ['2DUE-44','2DUE-TARIFF','2DUE-PAID-STOCK','2DUE-PAID-CASH','2DUE-UNDATED'])assert(!dueText.includes(serial));
  assert.equal(await page.locator('#filter-paid').count(),1);
  assert.equal(await page.locator('#filter-salePrice').count(),0);
  const [dueExport]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Excel’e Aktar',exact:true}).click()]);
  const dueBook=XLSX.readFile(await dueExport.path()),dueReport=XLSX.utils.sheet_to_json(dueBook.Sheets[dueBook.SheetNames[0]]);
  assert.equal(dueReport.length,3);assert(dueReport.every(row=>row['Ödeme']==='Ödenmedi'));assert(!Object.keys(dueReport[0]).includes('Peşin Satış Fiyatı'));
  await page.locator('#dateFrom').fill(dueFixture.today);await page.locator('#dateFrom').dispatchEvent('change');
  assert.equal(await page.locator('#itemtable tbody tr').count(),1);assert((await page.locator('#itemtable tbody').innerText()).includes('2DUE-CASH'));
  await page.getByRole('button',{name:'Tarihleri temizle',exact:true}).click();
  const latePayment=await page.evaluate(async()=>{const r=await fetch('/api/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'payment',filename:'due-late-payment.xlsx',rows:[{serial:'2DUE-45'}]})});if(!r.ok)throw Error('Payment failed');const data=await r.json();await refreshProductList();return data.batch_id;});
  assert(!(await page.locator('#itemtable tbody').innerText()).includes('2DUE-45'));
  assert((await page.locator('#productViews button[data-bucket="due"]').innerText()).includes('(2)'));
  await page.locator('#productViews button[data-bucket="paid"]').click();assert((await page.locator('#itemtable tbody').innerText()).includes('2DUE-45'));assert.equal(await page.locator('#filter-salePrice').count(),1);
  await page.evaluate(async id=>{const r=await fetch('/api/uploads/'+id+'/undo',{method:'POST'});if(!r.ok)throw Error('Payment undo failed');await refreshProductList();},latePayment);
  await page.locator('#productViews button[data-bucket="due"]').click();assert((await page.locator('#itemtable tbody').innerText()).includes('2DUE-45'));
  await nav('Ayarlar');await page.waitForSelector('[data-rule="due"]');
  assert.equal(await page.locator('[data-rule="due"] [data-condition="vdm"]').inputValue(),'unpaid');
  assert(await page.locator('[data-rule="due"] [data-condition="vdm"]').isDisabled());
  await page.locator('[data-rule="due"] [data-sale="cash"]').uncheck();await page.getByRole('button',{name:'Toplu Kaydet',exact:true}).click();await page.waitForFunction(()=>listRulesMessage.textContent.includes('kaydedildi'));
  await openDealer('Due Fixture');await page.locator('#productViews button[data-bucket="due"]').click();assert(!(await page.locator('#itemtable tbody').innerText()).includes('2DUE-CASH'));
  await nav('Ayarlar');await page.waitForSelector('[data-rule="due"]');await page.getByRole('button',{name:'Varsayılanları forma getir',exact:true}).click();await page.getByRole('button',{name:'Toplu Kaydet',exact:true}).click();await page.waitForFunction(()=>listRulesMessage.textContent.includes('kaydedildi'));
  await page.evaluate(async ids=>{for(const id of ids){const r=await fetch('/api/uploads/'+id+'/undo',{method:'POST'});if(!r.ok)throw Error('Due fixture cleanup failed');}await refresh();},[dueFixture.paid,dueFixture.sale,dueFixture.activation,dueFixture.stock]);

  await page.evaluate(async()=>{const r=await fetch('/api/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'stock',rows:['A','B','C'].map(x=>({serial:'2BROWSER-BULK-'+x,shop:'Bulk Fixture',product:'Bulk test',price:10}))})});if(!r.ok)throw Error('Bulk fixture failed');await refresh();});
  await openDealer('Bulk Fixture');
  assert(await page.locator('#bulkDeleteProducts').isDisabled());
  await page.getByRole('checkbox',{name:'Ürün seç 2BROWSER-BULK-A',exact:true}).check();
  await page.getByRole('checkbox',{name:'Ürün seç 2BROWSER-BULK-B',exact:true}).check();
  await page.locator('#bulkDeleteProducts').click();
  await page.waitForFunction(()=>document.querySelector('#itemtable tbody tr')?.textContent.includes('2BROWSER-BULK-C')&&document.querySelectorAll('#itemtable tbody tr').length===1);
  assert((await page.locator('#selectionCount').innerText()).includes('0 seçili'));
  await page.evaluate(async()=>{const rows=await api('items');const row=rows.find(x=>x.serial==='2BROWSER-BULK-C');await api('items/'+row.id,'DELETE');await refresh();});

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
  assert.equal(await page.getByRole("button",{name:"Mükerrer Kayıtları Göster",exact:true}).count(),0);
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
