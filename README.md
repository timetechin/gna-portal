# GNA Portalı

Recovered from the active `gna-web` Railway Function deployment on 2026-10-12. This is the existing GNA application, not a replacement application.

Scope: `timetechin/gna-portal` only. Do not modify `timetechin/tekinler-vdm-hesap` or deploy to VDM services.

Runtime: Bun 1.4.0 (production pin), PostgreSQL. No third-party server dependencies. Playwright and XLSX are development dependencies for browser smoke checks. Existing tables and user/password/session conventions are preserved.

Copy `.env.example` to `.env` for local development, set a password for the first administrator only if the development database is empty, then run `bun run dev`. Never use the production database for tests. `bun test` uses `GNA_TEST_DATABASE_URL` and rejects non-loopback databases.

Each cloud task already runs in isolation. Use the existing checkout; do not create a Git worktree unless explicitly requested.

The production service uses `ghcr.io/railwayapp/function-bun:1.4.0` and `./run.sh` with inline source. `bun run railway:bundle` prepares the same format without deploying. The generated artifact contains source only, no credentials. Publication requires a verified GNA database backup, passing tests, and explicit service/environment IDs. Do not overwrite Railway variables or change the existing database connection.

Validation: run `npm ci --ignore-scripts`, then `bun test`, then `npm run test:browser` (Chromium must be installed; CHROMIUM_EXECUTABLE can select it). Browser checks use the fixtures prepared by `bun test`. Do not run both suites concurrently against the same test database.

Current workflow: administer records and dealer links in Cari Kayıt Ayarları; manage purchase/cash/tariff pricing in Fiyatlama Listesi. Profitability uses activation months and current configured prices. New uploads are reversible from Excel Yükle history; historical files without per-record provenance cannot be safely reversed. See MIGRATION.md for payment queues, import classification and backup rules.

To verify the actual Railway bundle, run `bun run railway:bundle`, `bun test`, then `GNA_BROWSER_SERVER=artifacts/server.ts npm run test:browser`. The bundle preserves public inline-handler names and stays below the runner's argument size limit.

2026-10-12 ekran güncellemesi: VDM görseline göre bordo menü, kompakt üst çubuk, çerçeveli kartlar ve sütun açılır filtreleri. Her ekranda Excel indirme, alım/aktivasyon tarih aralığı ve ay süzgeci, bayi konsinye/peşin/tarife özetleri; özel aktivasyon kampanyalarının kullanıcı tarafından sınıflandırılması. Hata sayısı ve tüm sorunlu seri/satır/sebepleri içeren Excel raporu. Müşteri Cari Kartları, Vodafone Alacakları ve İşlem Kayıtları menüleri kaldırıldı; veri ve geri alma kayıtları korunur.

Kullanıcı Yönetimi: carilerin erişim taslakları ve kullanıcı adı önerileri otomatik oluşturulur; şifre kaydedilene kadar erişimleri yoktur. Yönetici mevcut kullanıcı adını, bayi bağlantısını, rolünü ve şifresini düzenleyebilir. Boş şifre mevcut şifreyi korur; değişiklik ilgili kullanıcının oturumlarını kapatır. Son yönetici korunur. Şifreler yalnızca girilirken gösterilebilir; kayıtta okunabilir şifre tutulmaz.

Son ekran düzenlemesi: Fiyatlama Listesi’nde Toplu Kaydet, arama sırasında kaybolmayan fiyat taslakları; dört Excel yükleme kartı geniş ekranda yan yana; başlığa bağlı küçük filtre açılırları; açılıp kapanan menü; SEÇ kutuları ve bayi ürün listesindeki Excel’e Aktar. Yönetici ürünleri düzenleyebilir ve onayla silebilir. Çıkış/alım tarihinden 45 gün geçen ürün kırmızı işaretlenir. Peşin ve tarifeye ek satışların Vodafone sütunu “Vodafone’dan alacak yok” gösterir; önceki ödeme/aktivasyon kayıtları korunur.

Kullanıcı Yönetimi’nde tek bayi veya Ana Cari bağlantısı seçilebilir. Ana Cari kullanıcılarının erişimi her istekte mevcut bağlı bayiler üzerinden hesaplanır; cari kapanır veya bayi taşınırsa eski erişim devam etmez. Yönetici Bayi Tarafını Görüntüle ile bayi veya ana cari ekranını inceleyebilir; inceleme modunda yönetici yazma işlemleri kapalıdır. Aktivasyon eşleştirmelerinin varsayılanları dosya seçmeden önce de seçimlidir; İşleme Alma seçilen satırlar değişiklik yapılmadan atlanır.

Railway Function paketi gzip ile sıkıştırılır ve Bun üzerinden açılır; bu çalışma biçimi paketlenen gerçek sunucuyla tarayıcı ve veritabanı kontrollerinden geçer. Sıkıştırılmamış kaynak yalnızca yerel artifacts altında üretilir.

Ödeme Excel düzeltmesi: ödeme/VF ödeme dosyalarında farklı sayfalar, üst açıklama satırları, başlıksız listeler ve Column1–Column6 gibi genel başlıklar desteklenir. Seri sütunu başlıklardan ve kayıt örneklerinden algılanır; sayfa, başlık/ilk veri satırı, seri, tarih ve bayi alanları kullanıcı tarafından değiştirilebilir. Tarih seçilmezse tarihi uydurmak yerine Ödendi işaretlenir. Ödemeler 250 satırlık parçalarla, tek geri alınabilir dosya işlemi altında yüklenir. Kullanıcının sağladığı 798 satırlık gerçek dosya test ortamında yüklenip geri alınarak doğrulanır; örnek dosya Git’e eklenmez.

Tekinler çıkışları, aktivasyon ve müşteri aktarımında da sayfa/başlık/sütun seçimi vardır. Tekinler alış fiyatına %16 KDV ekleme seçimi önceki davranışı koruyarak varsayılan açık gelir. Eski boşluklu seri yazımları yeniden stok oluşturmaz. Menü daraltıldığında simgeler kalır; 45 gün etiketi yalnızca “45 gün geçti” yazar. Tarifeye ek ürünler yeşil işaretlenir. Bayi ürün ekranındaki tek indirme düğmesi Excel’e Aktar’dır.

VF bekleme kuralı: VDM’ye ödenmiş ve VF ödemesi bulunmayan stok ürünleri VF Ödeme Bekleyenler listesine dahil edilir. Ödenmiş stok aynı zamanda VDM’ye Ödenenler listesinde kalır; peşin ve Tarifeye Ek satışlar VF bekleyenlere dahil edilmez. VDM’ye Ödenenler tablosunda ve Excel çıktısında Vodafone sütunu gösterilmez. VF ödeme yüklemesi stok ürünlerini de eşleştirir; VF bekleyen listesi, durum etiketi ve filtreler stok kuralına uyar; ana cari alacak toplamı ödeme geçmişini korur.

Ayarlar → Liste Kuralları: yönetici dört ürün listesinin satış türü, VDM/VF ödeme koşulu, tamamlanma koşulu ve Vodafone sütunu görünürlüğünü toplu kaydeder. Kurallar gna_list_settings tablosunda saklanır; bayi hesapları okuyabilir ancak değiştiremez. Seçili satış türleri VE ödeme koşulları uygulanır; listeler örtüşebilir. Varsayılan VDM listesi ödenmiş stok ve peşin satışları içerir. Ayarlar mevcut ürün/ödeme geçmişini değiştirmez; açık diğer oturumlar yenilenince güncellenir.

Yükleme/geri alma işlemleri tek bağlantılı ayrı yazma havuzunda yürür. Giriş ve okuma havuzu bu işlemlerin kilit kuyruğundan etkilenmez. Yükleme kilitlerinde 15 saniye bekleme sınırı uygulanır; zaman aşımında işlem parçası transaction ile geri alınır.

Excel sayfa adları baştaki/sondaki boşluklarıyla aynen korunur. VF ödeme dosyasındaki GNA Fatura sayfasında 1.881 seri, gerçek dosyayla tarayıcıda D sütunundan okunarak doğrulanır (GNA_VF_PAYMENT_SAMPLE). Örnek dosya Git’e eklenmez.

Seri satış fiyatları: gna_items.cash_sale_price nullable alanı satış fiyatını alış maliyetinden ayrı saklar. sale_price yüklemeleri seri+baying kaydına eşleşir, yalnızca bu alanı günceller ve dosya geçmişinden geri alınabilir. Peşin kâr = seriye ait satış fiyatı (yoksa listedeki satış fiyatı) − her zaman serinin tarihsel price maliyeti. Fiyatlama Listesi’ndeki purchase_price artık geçmiş seri maliyetinin yerine geçmez. Eski yüklemelerin yeni alanı içermeyen stok snapshotları, seri satış fiyatı boş kaldığı sürece geri alınabilir.

VDM’ye Ödenmesi Gerekenler: bayi ürünlerinde ek bir liste; VDM’ye ödenmemiş peşin satışlar ile alım tarihinden 45 gün veya daha fazla geçmiş stok kayıtlarını gösterir. Ödenmiş, tarifeye ek ve tarih bilgisi olmayan stoklar dahil edilmez. Ödeme ve geri alma sonrası durum yeniden hesaplanır; tarih/sütun filtreleri, Excel dışa aktarımı ve bayi kapsamı korunur. Ayarlar’da stok/peşin seçimleri bulunur; ödeme koşulu daima ödenmemiştir. Eski dört liste ayarları korunarak yeni liste varsayılanlarla eklenir.

Üst özet kartları: güncel ay (Europe/Bucharest, aktivasyon ayı) için peşin kâr, tarifeye ek kâr ve toplam kâr; VDM’ye ödenecek peşin satış ve 45 günü dolan stok için ayrı adet/tutar ve dip toplam; eldeki stok adedi gösterilir. Aylık kâr serinin kendi alış maliyeti ve satış fiyatıyla, tarifeye ek kâr kayıtlı birim kârla hesaplanır. Eksik fiyat/tarihler açıkça belirtilir. VDM borcu serinin kayıtlı alış tutarıdır; ödeme yapılmış ürünler hariçtir. Kartlar seçili bayi/ana cari kapsamındadır; ana panel erişilebilir bayileri toplar. Liste tarih filtreleri karttaki güncel ay/bakiyeyi değiştirmez.

Cari/bayi yükleme teyidi: Tekinler satış Excel’i ve VDM’ye Ödenenler dosyasında kayıt başlamadan önce her bayi grubu için hedef bayi ve bağlı ana cari gösterilir. Kullanıcı hedefi değiştirebilir; Onayla ve Yükle veya İptal seçer. Bayisi olmayan ödeme satırlarında seri kaydından bayi önerilir; belirsiz satırlar için seçim zorunludur. Ödeme eşleşmesi sunucuda teyit edilen bayiyle sınırlandırılır, başka bayideki tek eşleşmeye geri dönmez. Kapalı bayi veya ana cari hedefleri reddedilir. Tekinler dosyasındaki yeni bayi adı açık teyitle açılabilir.

Orijinal Excel arşivi: yeni XLS/XLSX yüklemelerinde (20 MB’a kadar) dosyanın aslı işleme başlamadan önce gna_upload_files tablosunda kalıcı saklanır. Excel Yükle → yükleme geçmişindeki Excel’i İndir, aynı ad ve dosya içeriğini indirir. Müşteri Excel aktarımları da dahildir. Dosyalar yalnızca yöneticilere açıktır, mevcut arşiv değiştirilemez, yükleme geri alınsa bile dosya korunur. Eski yüklemelerde saklanmamış dosyalar için “Dosyanın aslı saklanmamış” gösterilir.

Bayi Carileri → Mükerrer Kayıtları Göster yalnızca yönetici ekranında bulunur; API de bayi ve yönetici bayi inceleme oturumlarına kapalıdır. Seçili bayinin kendi kayıtlarında aynı seri/IMEI’ye sahip kayıtlar listelenir; boşluk, baştaki kesme işareti ve güvenli sayısal Excel yazımları normalleştirilir. Ortak seri, kayıtlı seri, kayıt numarası, bayi/ana cari, ürün ve tarihler karşılaştırılabilir; arama ve Excel’e Aktar bulunur. Kayıtlar otomatik değiştirilmez.

Mükerrer Kayıtları Göster düğmesi bayi ürün tablosunun üstünde Sütun filtrelerini temizle yanında yer alır; bayi seçilmemiş toplu görünümlerde kapalıdır. API de zorunlu bayi parametresiyle sorgular ve başka bayilerin kayıtlarını rapora dahil etmez.
