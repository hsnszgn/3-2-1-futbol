# Staging: kurulum ve doğrulama

Bu belge staging ortamının **nasıl kurulacağını ve neyle doğrulanacağını** adım
adım yazar. Buradaki hiçbir adım henüz staging'de çalıştırılmadı: staging
ortamı, alarm kanalı ve izleyicinin çalışacağı yer henüz yok. Koddan
yapılabilen her şey yapıldı ve yerel PostgreSQL ile test edildi (aşağıda her
adımın yanında "yerelde kanıtlanan" satırı var). Sağlayıcı paneli, sır veya
bütçe gerektiren adımlar **en sondaki tek listede** toplandı.

**Bu belge neyi yapmaz:** üretime deploy, üretimde ölçümü açma, canlı
veritabanında silme, ücretli kaynak oluşturma. Her biri ayrı onaya gelir.

Açık kalan ve bu belgenin kapatmadığı işler: **D3/D4 kapasite**, **D7 yedekten
geri dönüş**, **D8 sürüm geri alma** (bkz. son bölüm).

---

## 0. Staging'de kullanılan komutlar

| Komut | Ne yapar | Yazar mı? |
|---|---|---|
| `npm run staging:check` | Ön kontrol: ortam etiketi, TLS politikası, gerçek doğrulamalı el sıkışma, üretimden ayrım, veritabanında başka ortam olayı var mı | Hayır (yalnız `SELECT`) |
| `npm run beta:watch -- --test-alert` | Alarm kanalına tek deneme uyarısı | Yalnız kanala |
| `npm run beta:watch -- --once` | Tek izleyici kontrolü; çıkış 0 sağlıklı / 1 kesinti / 2 izleyici çalışamadı | Alarm durum satırları (`telemetry_reports`) |
| `npm run beta:watch -- --interval-ms 60000` | Sürekli izleyici döngüsü | Aynı |
| `npm run beta:retention` | Saklama: silinecekleri **sayar**, silmez | Hayır |
| `npm run beta:retention -- --apply` | Saklama: siler | **Evet** |
| `npm run beta:report -- ... --gate` | Rapor + 72 saat kapısı; PASS değilse sıfır olmayan çıkış | Hayır |

Bağlantı adresleri her zaman ortam değişkeninden okunur, komut satırından
asla. `staging:check` bilerek `DATABASE_URL`'i **okumaz**, yalnız
`STAGING_DATABASE_URL`'i okur: kabukta kalmış bir üretim adresi yanlışlıkla
"staging" diye kontrol edilemez.

---

## 1. Veritabanı / üretim ayrımı

**Kural:** staging ayrı bir veritabanına yazar; üretim veritabanı staging
servisine, izleyiciye veya staging komutlarına hiçbir zaman verilmez.

1. Neon'da staging için **ayrı bir veritabanı uç noktası** hazırlanır (ayrı
   proje veya ayrı dal). Dikkat: üretim dalından açılan bir Neon dalı üretim
   verisinin kopyasıyla başlar, yani **canlı kullanıcı verisi içerir**. Bu
   yüzden staging için boş bir veritabanı istenir; hangi yolun mevcut
   (ücretsiz) planda mümkün olduğu panelde görülecek — plan değişikliği
   gerekiyorsa yapılmaz, onaya gelir (karar listesi #1).
2. Staging servisinin ortam değişkenleri:

   | Değişken | Değer |
   |---|---|
   | `DATABASE_URL` | staging veritabanı |
   | `DB_SSL` | **boş** (doğrulama açık). `no-verify` kabul edilmez |
   | `TELEMETRY_ENABLED` | `1` |
   | `TELEMETRY_ENVIRONMENT` | `staging` |
   | `TELEMETRY_TRAFFIC_KIND` | `manual_qa` (staging'de insan betası yok) |
   | `TELEMETRY_HEARTBEAT_MS` | boş (5 dk) |
   | `BETA_ALERT_WEBHOOK_URL` | alarm kanalı (karar #2); yoksa alarmlar `NOT_CONFIGURED` saklanır |

3. Ayrımın kanıtı, bir makineden:

   ```sh
   STAGING_DATABASE_URL='<staging adresi>' \
   PRODUCTION_DATABASE_HOST='<üretimin yalnız ana makine adı, ep-....neon.tech>' \
   TELEMETRY_ENVIRONMENT=staging npm run staging:check
   ```

   Beklenen: `separation PASS` (iki ana makine farklı), `measurement_isolation
   PASS` (veritabanında `staging` dışında etiketli olay yok), `sonuç: PASS`.
   `PRODUCTION_DATABASE_HOST` verilmezse ayrım `UNKNOWN` olur ve sonuç
   `NOT_READY` kalır — kontrol edilmemiş ayrım geçmiş sayılmaz. Buraya URL
   değil yalnız ana makine adı yazılır; URL verilirse kontrol FAIL olur ve
   değeri ekrana yazmaz. `row_counts` satırı yalnız bilgidir: staging'de çok
   sayıda hesap görünürse veritabanı üretimin kopyası olabilir, durup bakılır.

**Yerelde kanıtlanan** (`test/staging-check.test.js`): `STAGING_DATABASE_URL`
yokken `DATABASE_URL`'e düşmüyor (çıkış 2); aynı ana makine FAIL, farklı PASS,
URL verilirse FAIL ve yankılanmıyor; `TELEMETRY_ENVIRONMENT=production` FAIL;
veritabanında `production` etiketli olay varsa FAIL; parola çıktıda yok.

---

## 2. Neon TLS (B3)

B3 **açık kalıyor**; bu adım onu kapatmak için gereken staging kanıtını üretir.
Sertifika doğrulamasını kapatmak çözüm değildir: `DB_SSL=no-verify` ile ön
kontrol her zaman FAIL verir.

1. Staging servisi `DB_SSL` **boş** iken açılır. Açılış logunda
   `Database ready` görünmeli, `Database TLS verification is OFF` satırı
   **görünmemeli**.
2. Aynı adresle `npm run staging:check`: `tls_policy PASS` (doğrulama açık,
   SNI = ana makine adı, CA = sistem deposu veya `DB_CA_CERT`) ve
   `tls_handshake PASS` (sunucunun `pg_stat_ssl` kaydına göre gerçekten
   şifreli, TLS sürümü ve şifre takımıyla). URL'deki `sslmode=...` yok sayılır
   ve bu satırda yazılır.
3. Başarısızsa hata kodu yazılır (ör. `SELF_SIGNED_CERT_IN_CHAIN`,
   `UNABLE_TO_VERIFY_LEAF_SIGNATURE`); çözüm doğrulamayı kapatmak değil,
   sağlayıcının kök sertifikasını `DB_CA_CERT_PATH` ile vermektir.

**B3'ü kapatacak kanıt:** hem ön kontrolün `tls_handshake PASS` çıktısı hem de
staging servisinin kendi açılış logu (servis ayrı bir ağdan bağlanır; ikisi
aynı şey değildir). Ön kontrolün PASS dalı yerelde gösterilemez: yerel
PostgreSQL'de gerçek bir sertifika zinciri yok.

**Yerelde kanıtlanan:** yerel/şifresiz bağlantı `tls_policy` ve
`tls_handshake` FAIL; `DB_SSL=on` ile TLS'siz sunucuya bağlantı reddediliyor;
uzak ana makinede doğrulama açıkken `tls_policy PASS` ve URL'deki
`sslmode=no-verify` yok sayılıyor; `DB_SSL=no-verify` FAIL.

---

## 3. Saklama işi

Ham olaylar 30 gün, raporlar/alarmlar 90 gün. Sunucu `TELEMETRY_ENABLED=1`
iken bunu kendisi siler; komut, ölçüm kapatıldıktan sonra kalan satırlar içindir.

1. Deneme (siler **değil**, sayar):

   ```sh
   REPORT_DATABASE_URL='<staging adresi>' npm run beta:retention
   ```
2. Çıktıdaki sayılar kaydedilir. İlk günlerde 0 beklenir (30 günden eski
   olay yok); 0 olması "çalışmadı" değil, "silinecek yok" demektir.
3. `--apply` staging'de **onaydan sonra** çalıştırılır (karar #6); öncesi ve
   sonrası sayılar yol haritasına yazılır. Üretimde çalıştırılmaz.

**Yerelde kanıtlanan** (`test/telemetry-retention.test.js`): sınırdaki
satırlar, deneme modunun hiçbir şey silmemesi, `--now` ile `--apply`'ın uzak
veritabanında reddedilmesi.

---

## 4. Alarm teslimi

İki kaynak aynı kanala yazar:

- **Oyun süreci içindeki monitör** (`server/betaMonitor.js`): skor/kayıt
  tutarsızlığı, çökme (bir sonraki süreç açılınca), ölçüm kaybı.
- **Bağımsız izleyici** (`scripts/beta-watch.js`): oyun **kapalıyken** de
  çalışır. Sağlık ucu (`/healthz`) yanıt vermiyorsa veya son kalp atışı iki
  aralık + 1 dakikadan eskiyse `service_outage`; servis dönünce o kesintiyi
  adıyla kapatan tek `service_recovered`. Veritabanına ulaşamazsa sessiz
  kalmaz, kanala doğrudan `watcher_db_unreachable` gönderir.

Aynı teslim kodu kullanılır (`server/alerts.js`): bir olay bir kez; gönderilemeyen
alarm `DELIVERY_FAILED` olarak saklanır, artan beklemeyle yeniden denenir,
24 denemeden sonra `DELIVERY_ABANDONED` olarak görünür kapanır. Kanal yalnız
HTTPS olabilir.

Adımlar:

1. Kanal seçilir ve HTTPS webhook adresi alınır (karar #2). Adresin sahibi
   veri envanterine üçüncü taraf olarak eklenir (alarm gövdesi: tür, anahtar,
   kısa özet — oyuncu adı, jeton veya olay ayrıntısı yok).
2. Kanal testi: `BETA_ALERT_WEBHOOK_URL=... npm run beta:watch -- --test-alert`
   → çıkış 0 ve kanalda "izleyici kanal testi" mesajı.
3. İzleyici yerleştirilir (karar #3) ve şu ortamla çalışır:
   `REPORT_DATABASE_URL` (staging), `BETA_WATCH_HEALTH_URL`
   (`https://<staging>/healthz`), `BETA_ALERT_WEBHOOK_URL`,
   `TELEMETRY_ENVIRONMENT=staging`.
   Elle deneme için `.github/workflows/staging-watch.yml` hazır: yalnız elle
   başlatılır (zamanlaması **yok**), yalnız `STAGING_*` sırlarını okur. Sırlar
   tanımlanmadan çalıştırılırsa başarısız biter, "sağlıklı" demez.
4. **Kesinti tatbikatı** (onaydan sonra, karar #5): staging servisi panelden
   durdurulur → bir izleyici aralığı içinde kanalda tek `service_outage`;
   servis açılır → tek `service_recovered`. Zamanlar kaydedilir.

**Yerelde kanıtlanan** (`test/beta-watch.test.js`, oyun, izleyici ve alıcı üç
ayrı süreç): oyun sağlıklıyken alarm yok; oyun SIGKILL ile öldürülüp **yeniden
başlatılmadan** tek `service_outage`, sonraki kontrollerde tekrar yok; dönünce
tek `service_recovered`; ikinci kesinti yeni alarm; süreç kalp atışı yazarken
sağlık ucu bozuksa 7 kalp atışı boyunca tek alarm; kanal kapalıyken başlayıp
kanal düzelmeden biten kısa kesinti sonradan bir kez, kurtarma bildiriminden
önce teslim; servis ayakta ama ölçüm yazmıyorsa kalp atışı gerekçeli kesinti;
veritabanına ulaşılamazsa doğrudan uyarı ve çıkış 2; yavaş kanal ve yavaş
sağlık ucunda kontroller üst üste binmiyor, tek alarm; `--test-alert` başarısız
kanalda çıkış 1. On bir mutasyonun hepsi test tarafından yakalandı.

**Yerelde kanıtlanamayan:** gerçek kanala teslim; izleyicinin oyundan ayrı bir
makinede çalışması; GitHub Actions zamanlamasının gecikmesi.

---

## 5. 72 saatlik aday gözlemi

**Aday:** CI'da iki Node sürümünde yeşil olan tek bir commit SHA.

1. Aday staging'e deploy edilir (karar #4; üretime değil). `RELEASE_SHA`
   Render'da `RENDER_GIT_COMMIT`'ten kendiliğinden gelir.
2. Açılışta: `npm run staging:check` → PASS; `--test-alert` → teslim.
3. Gözlem boyunca izleyici çalışır; staging servisi **uyumamalıdır**. Render
   ücretsiz katmanı boşta servisi uyutur; bu doğru biçimde gözlem boşluğu
   olarak görünür ve kapı geçmez (karar #4).
4. Staging'de insan betası olmadığından trafik `manual_qa`'dır. 72 saat
   dolunca:

   ```sh
   REPORT_DATABASE_URL='<staging adresi>' npm run beta:report -- \
     --environment staging --release <SHA> --traffic-kind manual_qa \
     --min-games <kararlaştırılan sayı> --to <gözlem sonu, ISO> --gate
   ```

   PASS için: 72 saat boyunca kesintisiz kalp atışı kanıtı, pencerede gerçek
   maç, hiçbir tutarsızlık/ölçüm arızası. Boşluk, veri yokluğu veya başarısız
   sorgu PASS üretmez (M6'da test edildi).
5. Gözlem sonucu, izleyicinin gönderdiği alarmlar (veya hiç alarm olmadığı) ve
   ön kontrol çıktısı yol haritasına SHA ile yazılır.

Bu gözlem **staging adayı** içindir; beta kapısının yerini tutmaz. Beta kapısı
`human_beta` trafiği ve gerçek katılımcı ister (Aşama E).

---

## 6. Açık kalan işler (bu belge kapatmaz)

| Kart | Durum | Staging'den ne bekliyor |
|---|---|---|
| D3/D4 kapasite | Açık | Hedef eşzamanlı oyuncu sayısı ve bütçe kararı; staging'de yük deneyi |
| D7 yedekten geri dönüş | Açık | Sağlayıcıdaki gerçek yedek ayarı; staging'e (üretime değil) geri yükleme provası ve süresi |
| D8 sürüm geri alma | Açık | Staging'de bir önceki SHA'ya dönüş provası: ölçüm şeması ve alarm durumu dönüşte bozulmuyor mu, izleyici dönüşü kesinti/kurtarma olarak doğru raporluyor mu |
| B3 Neon TLS | Açık | Bölüm 2'deki kanıt |

---

## 7. Onay gerektiren kararlar (tek liste)

| # | Karar | Tür | Neden gerekli |
|---|---|---|---|
| 1 | Staging veritabanı: Neon'da boş, ayrı proje/dal — mevcut planda mümkün mü | Erişim (Neon paneli), bütçe (plan değişmeyecek) | Bölüm 1; üretimden açılan dal canlı veri kopyalar |
| 2 | Alarm kanalı ve HTTPS webhook adresi (Slack/Discord/e-posta köprüsü vb.) | Kanal | Bölüm 4; veri envanterine üçüncü taraf olarak girer |
| 3 | İzleyicinin çalışacağı yer ve sıklığı: GitHub Actions zamanlaması (dakika tüketir, gecikebilir), ayrı küçük sunucu, veya dış erişilebilirlik servisi | Erişim, bütçe | Oyun kapalıyken alarm için oyundan ayrı çalışmalı |
| 4 | Staging barındırma: uyumayan bir plan (72 saat için şart) | Bütçe | Ücretsiz katman uyur, gözlem geçemez |
| 5 | Staging'de kesinti tatbikatı (servisi durdurup açma) | Onay | Bölüm 4.4 |
| 6 | Staging'de `beta:retention -- --apply` | Onay | Bölüm 3.3 |
| 7 | GitHub'da `STAGING_*` sırlarının tanımlanması | Erişim (repo ayarları) | Elle izleyici iş akışı |
| 8 | Üretime deploy, üretimde `TELEMETRY_ENABLED=1`, canlıda silme | Onay | Bu belgenin sonuçlarından sonra, ayrı ayrı |
