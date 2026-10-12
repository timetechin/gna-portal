# GNA güvenli geçiş

## Kapsam ve kaynak

Yalnızca timetechin/gna-portal, Railway GNA Portalı projesi 1143770f-184e-46e7-8180-9c783ba0552d, production ortamı d36c9cb7-9209-40d6-9a4b-20741205a12f ve gna-web servisi a853cf05-61ff-4d09-81a1-0151b5db538c.

Eski başarılı dağıtım: d0e70c11-9c4d-47c5-944b-17bb722a8494. Kaynak, mevcut Railway Function başlangıç komutundan kurtarıldı. Veritabanı bağlantısı, servis kimliği ve Function imajı korunur. VDM kapsamında hiçbir işlem yapılmaz.

## Veritabanı

Canlı şema başlangıçtaki CREATE TABLE tanımlarından farklıdır: gna_items içinde created_at vardır, invoice/shipped/sold sütunları yoktur; gna_import_log tarihi imported_at sütunundadır. Bu alanlar değiştirilmez. Mevcut gna_dealers tablosu da korunur.

Yeni sürüm yalnızca gna_main_accounts, gna_dealer_accounts, gna_customers ve gna_audit_log tablolarını ve bunların indekslerini ekler. Geçiş tek transaction içinde ve yeniden çalıştırılabilir. Bayi bağlama, ayırma ve taşıma işlemleri gna_items veya eski satış/ödeme alanlarına yazmaz; ayrı bağlantı tablosunu değiştirir. Değişiklik ve audit kaydı aynı transaction içindedir.

Ürün/satış/ödeme tutarları mevcut ürün fiyatlarından hesaplanır; bağımsız ödeme hareketi tablosu mevcut uygulamada yoktur. Vodafone alacağı mevcut kuralla hesaplanır: paid_on dolu ve campaign = Tarifeye Ek. Müşteri kartları ürün sahipliğini değiştirmez. MusteriKod metin ve benzersiz anahtardır; baştaki sıfırlar korunur. Aynı kod farklı bilgilerle yeniden gelirse mevcut kart korunur ve çakışma raporlanır.

## Yedek, doğrulama ve geri dönüş

GNA servisinin resmi HTTPS terminal relay protokolü üzerinden PostgreSQL repeatable-read, read-only transaction ile yalnızca public.gna_* tabloları yedeklenir. Yedek sütunları, kısıtları, indeksleri, sequence durumunu ve satırları içerir. Dosya /workspace/gna-onboarding/backups altında 0600 izinle, klasör 0700 izinle tutulur; Git'e eklenmez. SHA-256 manifest ile doğrulanır.

2026-10-12 yedeği ayrı yerel gna_restore veritabanına geri yüklendi. Sekiz eski GNA tablosunun tüm satırları karşılaştırıldı. Yeni sürümün başlangıcı ve API istekleri geri yüklenen gerçek şemada doğrulandı; eski satırların tamamı değişmeden kaldı. İşlev testleri ayrıca sentetik, izole gna_test veritabanında çalıştırılır.

Yayın öncesi yedek yenilenir. Yayın sonrası eski GNA tablolarının kayıtları yeniden karşılaştırılır; eşzamanlı kullanıcı işlemleri varsa farkların kaynağı incelenir. Sağlık, bayi/ürün listeleri ve yeni sayfalar kontrol edilir. Sadece üretim GNA servisi yeniden dağıtılır.

Uygulama geri dönüşünde eski başlangıç komutu ve Function imajı kullanılır. Yeni tablolar silinmez; eski uygulama bunları kullanmadığı için mevcut tablo yapısıyla uyumludur. Veri geri yükleme yalnızca gerçek veri kaybı durumunda, son kullanıcı işlemleri değerlendirilerek GNA kapsamına uygulanır; tüm veritabanı körlemesine silinmez.

Gerçek 279663 Excel dosyası bu oturuma sağlanmadı. Aynı Data başlıklarıyla hazırlanmış XLSX dosyasında sayısal/formattan gelen sıfırlı müşteri kodları ve tekrar aktarım tarayıcıyla test edildi. Gerçek müşteri kartlarını oluşturmak için yönetici Müşteri Cari Kartları ekranından gerçek dosyayı yükler.

## Yayın sonucu

2026-10-12: yeni Railway dağıtımı 20189cdb-8f3a-46e6-911b-76243064be8e SUCCESS durumunda. Canlı /health, mevcut yönetici girişi ve ilgili API'ler doğrulandı. Sekiz eski GNA tablosunun tüm içerikleri yayın öncesi yedekle aynı: 383 ürün, 41 eski içe aktarma kaydı, 40 yükleme geçmişi kaydı, mevcut kullanıcı ve oturumlar korundu. Kontrol oturumu kapatıldı; canlıda örnek müşteri veya ana cari kaydı oluşturulmadı. Bun 1.4.0 üzerinde 11 entegrasyon testi ve tarayıcı işlev kontrolü geçti.

## Cari, fiyatlama ve dosya işlemleri güncellemesi

- Bayi Carileri, ana cari → alt bayi gezinmesi ile doğrudan bayi seçimini birlikte sunar. Yönetim işlemleri Cari Kayıt Ayarları bölümündedir. Ana cari/müşteri aktiflik alanları ve gna_dealer_profiles eklenir; kapatma kayıtları silmez, bayi adını düzeltme ürünlerdeki eski shop kimliğini değiştirmez.
- gna_items üzerine shipped, sold ve vf_paid_on nullable alanları eklenir. Eski tarihler uydurulmaz. Tarihi eksik eski stok için aynı alım dosyası yeniden yüklenebilir; sadece eksik tarih doldurulur ve geri alınabilir. Aktivasyon tarihlerinde ISO veya Türkçe gün/ay/yıl biçimi doğrulanır.
- Aktivasyon Excel'inde E / Cihaz Kampanya Adı ve H / Seri-IMEI kullanılır. AYLIK TAAHHUTLU KAMPANYALAR = Tarifeye Ek; GNA BAYI CIHAZ KAMPANYASI = Peşin Satış. Tanınmış yeni kampanya mevcut sınıflamayı değiştirebilir; eski değer işlem kaydında saklanır. Belirsiz veya bulunamayan seri değiştirilmez.
- VDM ödeme dosyası tüm bayilerde eşleşen serileri işaretler. VDM’ye ödenmiş peşin satışlar tamamlananlar görünümüne geçer; tarifeye ek satışlar VF ödeme bekleyenlerde görünür. VF ödeme dosyası bekleyen eşleşmeleri tamamlananlara taşır. Bu dosyalar işlenirken seri kayıtları silinmez; işlem ve kârlılık geçmişi korunur. Tarih bulunmayan ödeme dosyasında tarih uydurulmaz, Ödendi işareti saklanır.
- Tekinler çıkışlarında sadece 2 ile başlayan serileri alma seçeneği varsayılan seçilidir. Tercih gna_upload_batches üzerinde saklanır ve dosyanın tüm parçalarında sunucuda uygulanır. Seçenek kapalıysa diğer seriler de alınabilir; önceki stoklar otomatik silinmez.
- gna_product_prices; alış, peşin satış ve tarifeye ek birim kârını tutar. Peşin kâr = satış − alış. Alış fiyatı boşsa serinin kayıtlı fiyatı kullanılır. Tarifeye ek kâr listede verilen birim tutardır. Rapor güncel listeyle hesaplanır, geçmiş aylarda sabitlenmiş gerçek satış fiyatı olduğunu iddia etmez. Aktivasyon ayına göre süzülür; eksik tarih ve fiyat ayrı raporlanır, eksik tutar sıfır kâr sayılmaz.
- Yeni dosyalar gna_upload_batches ve gna_upload_effects ile dosya bazında izlenir. Çok parçalı yükleme tek dosyadır. Eklenen kayıtların anlık görüntüsü ve değişen alanların önceki/sonraki değerleri saklanır. Geri alma tek transaction içinde yapılır. Sonraki etkin yükleme aynı alanı değiştirmişse veya kayıt sonradan değiştirilmişse geri alma tamamen engellenir; kullanıcı önce ilgili sonraki işlemi geri alır. İlgisiz alanlar ve eski kayıtlar korunur.
- Geçmiş gna_upload_history dosyalarında seri/alan eşleştirmesi bulunmadığından eski yüklemeler tahminle geri alınmaz. Arayüz bunları açıkça desteklenmeyen eski yükleme olarak gösterir.
- Yedek biçimi, sayıları ve zaman damgalarını PostgreSQL metin gösterimiyle korur. Foreign key bağlantıları da izole geri yüklemede doğrulanmıştır. 24 entegrasyon testi ve son minified Function paketindeki tarayıcı işlev kontrolleri geçti. PostgreSQL bağlantı havuzu sınırlandı; geliştirme yeniden başlatması --watch ile yapılır.

2026-10-12 son doğrulama: 1fc6fa55-5cc3-4e0a-a965-7fe0f84182d0 dağıtımı SUCCESS. Canlı sağlık, yönetici girişi, cari dizini, fiyatlama ve kârlılık API'leri doğrulandı. Son yedekteki 16 GNA tablosunun eski alan değerleri birebir korundu; 383 ürün, 1 ana cari ve 3 bayi bağlantısı değişmedi. Canlıda örnek dosya/fiyat kaydı oluşturulmadı. E/H eşleştirmesi, başka bir SeriNo sütunu bulunması durumunda da test edildi. VDM deposu veya uygulaması üzerinde işlem yapılmadı.
