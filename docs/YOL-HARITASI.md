# Beta ve yayın yol haritası — iş kartları

Yol haritası belgesinin (19 Eylül 2026, rev. 2) iş kartlarına çevrilmiş hâli.
Teknik başlangıç: `cc6005e`.

**Bu dosya ne değildir:** yapılmış işin kaydı olmayan hiçbir satır burada
"kapalı" yazmaz. Kapalı bir kart için commit ve o commit'te koşan test vardır.
Çalıştırılmamış bir madde "doğrulanmadı" kalır ve yeşil toplamın içinde
gösterilmez.

## Durumlar

`açık` → `uygulanıyor` → `kanıt bekliyor` → `incelemede` → `kapalı`

## Sahiplik sınırı

| Sahip | Ne |
|---|---|
| Claude / geliştirici | Kod, migration, otomasyon, regresyon, kanıtın commit'le ilişkilendirilmesi |
| Bağımsız inceleme | Kabul şartına ve etkilenen ortak akışlara göre değerlendirme |
| Hasan | Oyun kuralları, beta kapsamı, sağlayıcı hesapları, bütçe, katılımcılar, yayın kararı |
| CI / ayrı ortam | Temiz checkout, atılabilir PostgreSQL, gerçek tarayıcı — tekrarlanabilir |

**Bu depodan yapılamayanlar** (kart açık kalır, sahibi Hasan):
canlı Render panelinin gerçek ayarları, ücretli plan kararı, Neon yedek/geri
yükleme provası, alarm kanalı, beta katılımcı listesi, marka/mağaza taraması,
gerçek cihaz (iPhone Safari / Android Chrome) denemeleri.

---

## Aşama A — Kapsam ve çalışma ortamı

| Kimlik | İş | Durum | Kanıt / not |
|---|---|---|---|
| A1 | Desteklenen Node LTS'e geç, kurulumu lockfile'a bağla | **kapalı** | `render.yaml`: `NODE_VERSION 20.11.0 → 24.21.0`, `npm install → npm ci`; `package.json` `engines: >=22`. Node 20 gerçekten destek dışı (nodejs.org/dist + Release/schedule.json ile kontrol edildi); Node 24 "Krypton" aktif LTS, bitiş 2028-04-30. Regresyon: Node 24.21.0 üzerinde temiz `npm ci` + tam paket koşuldu |
| A2 | Playwright/Chromium kurulumunu tekrarlanabilir kıl | **kısmen** | README'de komutlar ve doğrulanmış sürümler (Playwright 1.56.1 / Chromium 141.0.7390.37) yazılı, koşucu her koşuda sürümleri basıyor. `package.json`'a pin **eklenmedi**: üretim imajının test tarayıcısı indirmesi istenmiyor. CI'da pin CI kartına ait |
| A3 | Gerçek PostgreSQL + tarayıcı çalıştıran CI | **açık** | Bu depoda CI tanımı yok. Sahibi: Hasan + CI ortamı |
| A4 | Staging/üretim sırlarının ve veritabanlarının ayrılması | **açık** | Panel işi; depodan doğrulanamaz |
| A5 | İlk sürüm oyun kurallarının yazılı kesinleşmesi | **açık** | Sahibi Hasan. Kararı olmayan davranışın testi de belirsiz |
| A6 | Beta hesaplarının genel yayına taşınıp taşınmayacağı | **açık** | Sahibi Hasan; katılımcıya baştan söylenmeli |

## Aşama B — Bilinen açıkların kapanması

| Kimlik | İş | Durum | Kanıt |
|---|---|---|---|
| B1 | Yapılandırılmış ↔ kullanıma hazır ayrımı | **kapalı** | `db.isReady()` eklendi; `/api/config` `accountsEnabled`/`accountsConfigured` ayrı; `503 accounts_disabled` ↔ `503 accounts_unavailable`; bağlantı/sorgu zaman aşımları; başarısız migration yeniden deneniyor. `test/account-readiness.test.js` (5 senaryo) + `test/account-integrity.test.js` 9. senaryo (kilitli tabloda 1.5s'de 500) |
| B2 | Futbolcu adı eşleştirmesi | **kapalı** | `"de de"` reddediliyor; `test/name-matching.test.js` 20 kabul + 18 ret örneği |
| B3 | DB TLS doğrulaması | **açık** | Hedef sağlayıcının zinciri belirlenmeden yapılmamalı; `node-postgres` bazı bağlantı URL'si SSL seçeneklerinin `ssl` nesnesini ezebildiğini belgeliyor |
| B4 | Gerçek tarayıcı recovery testi | **açık** | `phaseSync` yolu şu an yalnız socket seviyesinde doğrulanmış |
| B5 | Fontların yerelleştirilmesi + README düzeltmesi | **kapalı** | `public/fonts/` (16 woff2, latin+latin-ext), SIL OFL 1.1 metinleri, CSP'den dış kaynaklar kaldırıldı. `test/browser/fonts-local.spec.js` gerçek ağı izliyor; 8 yüzün tamamında Türkçe glif kapsaması fontTools ile doğrulandı |
| B6 | Debug jetonu yalnız başlıkta | **kapalı** | `?key=` kaldırıldı; `test/account-readiness.test.js` son senaryo |

## Aşama C — Birleşik doğrulama

| Kimlik | İş | Durum |
|---|---|---|
| C1 | Normal oyun akışlarının bir arada doğrulanması | **kısmen** — socket + tarayıcı paketleri var; karma (misafir/hesap) eşleşme ayrı senaryo olarak yok |
| C2 | Yarış senaryoları | **kapalı sayılabilir** — `round-timing`, `recovery`, `session-revocation`, `pending-join`, `double-match` |
| C3 | Hesap yaşam döngüsü | **kısmen** — `browser/account-rights`, `browser/auth-security`, `account-integrity`; süresi dolan oturum ayrı test edilmedi |
| C4 | Dış veri (snapshot yok/eski, Wikidata yavaş/hatalı) | **kısmen** — gecikme knob'u var, "erişilemez" ve "eski snapshot" ayrı senaryo değil |
| C5 | Gerçek cihaz | **açık** — sahibi Hasan |

## Aşama D — Yayın ortamı ve kurtarma provası

D1 tek süreç sınırı · D2 barındırma planı · D3 kapasite deneyi · D4 ölçüm ·
D5 kesinti politikası · D6 gözlem/alarm · D7 yedek + geri yükleme provası ·
D8 sürüm geri dönüşü · D9 ürün metinleri · D10 marka/haklar — **hepsi açık**.
D1 dışında hiçbiri bu depodan doğrulanamaz.

## 6.1 Ölçüm altyapısı (M1–M7)

**Hepsi açık.** Veri sözleşmesi A'da kesinleşmeli; uygulama B–D içinde.
Ölçüm kodu **henüz depoda yok** — bu belgenin varlığı hiçbir ölçümün
çalıştığı anlamına gelmez.

## Aşama E / F — Beta ve genel yayın

Kapılar sırasıyla A–D ve E'ye bağlı; ikisi de **açık**. Eşikler ürün kararıdır,
istatistiksel garanti değildir.

---

## Her `await` için kontrol listesi

Yol haritasının C bölümündeki kural, bu projede üç kez aynı şekilde ihlal
edildiği için buraya yazılıdır. Yeni bir bekleme eklendiğinde beklemeden
**sonra** okunan her değer tek tek gözden geçirilir:

| Değer | Kural | Neden |
|---|---|---|
| Oda / oyun / deneme kimliği | Başta **sabitle** | Rövanş, kayıt beklerken biten oyunun kimliğini çalmıştı |
| Varış zamanı | Başta **sabitle** | Wikidata beklemesi ve sonra kimlik doğrulaması puanı düşürmüştü |
| Faz / pencere durumu | Beklemeden sonra **yeniden doğrula** | Süresi geçmiş turun cevabı yeni tura yazılmıştı |
| Oyuncu / oturum yetkisi | Beklemeden sonra **yeniden doğrula**, hata hâlinde düş | İptal edilmiş oturum geri gelmişti |
| Kayda gidecek sonuç | Skor/kazanan başta sabit, hesap kimliği sonra | Çıkış yapmış oyuncuya maç yazılmıştı |
