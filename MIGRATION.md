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
