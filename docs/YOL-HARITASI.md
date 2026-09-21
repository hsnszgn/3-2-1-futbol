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

**Bu depodan yapılamayanlar** — yalnızca şunlar: canlı panelin gerçek ayarlarını
değiştirmek, ücretli plan kararı, sağlayıcıdaki gerçek yedek ayarı ve canlı
ortamda yetkili işlem, alarm kanalının kendisi ve sırlarının tanımlanması, beta
katılımcı listesi, marka/mağaza hukuki değerlendirmesi, gerçek cihaz
(iPhone Safari / Android Chrome) denemeleri, hedef sağlayıcıya bağlanarak
yapılan doğrulamalar.

**Bunların hiçbiri kartın tamamını beklemez.** Önceki sürümde bu ayrım fazla
geniş yazılmıştı ve uygulamayı gereksiz durduruyordu; her kart iki parçaya
ayrılır ve geliştirici parçası sağlayıcı bilgisi beklemeden ilerler:

| İş | Geliştiricinin yapacağı (beklemez) | Sağlayıcı/Hasan erişimi gerektiren |
|---|---|---|
| A2/A3 | Pinli tarayıcı kurulumu, PostgreSQL servisli CI tanımı, koşucu çıktıları | Actions/runner ayarları, ilk koşunun açılması |
| B3 | Bağlantı adresini sır sızdırmadan ayrıştırma, `sslmode` etkisinin kesinleşmesi, zincir/host doğrulaması, geçersiz sertifikanın kontrollü reddi | Hedef sağlayıcının zinciriyle staging doğrulaması, canlıda açma kararı |
| D3/D4, M1–M7 | Yük testi, ölçüm kodu, uzlaştırma, kalıcı testler | Hedef kapasite/bütçe kararı, gerçek beta katılımcıları |
| D5/D6 | Kesinti ve bakım davranışı, hata ölçümü, alarm entegrasyonu ve testleri | Alarm kanalı, sırların tanımlanması |
| D7/D8 | Geri dönüş ve rollback prosedürü, atılabilir ortamda prova | Sağlayıcıdaki gerçek yedek ayarı, canlı işlem |
| D9 | Ürün metinleri ile hata/servis durumu ekranlarının uygulaması | Ürün kararları, gerekirse uzman değerlendirmesi |

**Kapanma ölçütü:** geliştiricinin test koşmuş olması bir kartı kapatmaz. Kart
`incelemede` olur; kapanması bağımsız incelemenin kabul sınırına bağlıdır. Bu
belgedeki "kapalı" satırları da bu kapsamda okunmalıdır: kanıt kolonu neyin
ölçüldüğünü yazar, ölçülmeyen hiçbir şeyi kapsamaz.

---

## Aşama A — Kapsam ve çalışma ortamı

| Kimlik | İş | Durum | Kanıt / not |
|---|---|---|---|
| A1 | Desteklenen Node LTS'e geç, kurulumu lockfile'a bağla | **kısmen** — tek sürüm sabitlemesi değil | `render.yaml`: `NODE_VERSION 20.11.0 → 24.21.0`, `npm install → npm ci`; `package.json` `engines: >=22`. Node 20 gerçekten destek dışı (nodejs.org/dist + Release/schedule.json ile kontrol edildi); Node 24 "Krypton" aktif LTS, bitiş 2028-04-30. Regresyon: Node 24.21.0 üzerinde temiz `npm ci` + tam paket koşuldu. **Sınır:** `engines: >=22` bir alt sınırdır, sabitleme değil; yalnızca Render pini kesindir. CI'daki matris (24.21.0 + 22.22.2) henüz koşmadı, yani "tüm ortamlar aynı sürümde" doğrulanmış değil |
| A2 | Playwright/Chromium kurulumunu tekrarlanabilir kıl | **kısmen** | README'de komutlar ve doğrulanmış sürümler (Playwright 1.56.1 / Chromium 141.0.7390.37) yazılı, koşucu her koşuda sürümleri basıyor. `package.json`'a pin **eklenmedi**: üretim imajının test tarayıcısı indirmesi istenmiyor — pin CI tanımında (`--no-save` ile) yapılıyor |
| A3 | Gerçek PostgreSQL + tarayıcı çalıştıran CI | **uygulanıyor** | `.github/workflows/ci.yml` **koştu**: `bbcb58d` push'unda [run #1](https://github.com/hsnszgn/3-2-1-futbol/actions/runs/35491500881), iki Node sürümünde de. Sonuç: veritabanısız 10/10 geçti, **izole PostgreSQL koşusu `account-integrity`'de kaldı** ve tarayıcı adımları hiç koşmadı. Sebep CI'ın kendisi değil, test harness'ı: gerçekten boş bir veritabanında sunucunun migration'ı `/healthz`'den sonra bittiği için ilk kayıt `503 accounts_unavailable` alıyordu (yerelde şema zaten duruyordu, bu yüzden hiç görünmedi). Düzeltildi: koşucu şemayı önceden kuruyor (`server/schema.js`, yan etkisi olmayan ayrı modül) ve `waitForAccounts()` hazır olmayı bekliyor. Bir sonraki koşunun sonucu buraya yazılacak; tarayıcı adımları o koşuda ilk kez çalışacak |
| A4 | Staging/üretim sırlarının ve veritabanlarının ayrılması | **açık** | Panel işi; depodan doğrulanamaz |
| A5 | İlk sürüm oyun kurallarının yazılı kesinleşmesi | **açık** | Sahibi Hasan. Kararı olmayan davranışın testi de belirsiz |
| A6 | Beta hesaplarının genel yayına taşınıp taşınmayacağı | **açık** | Sahibi Hasan; katılımcıya baştan söylenmeli |

## Aşama B — Bilinen açıkların kapanması

| Kimlik | İş | Durum | Kanıt |
|---|---|---|---|
| B1 | Yapılandırılmış ↔ kullanıma hazır ayrımı | **incelemede** (12. kontrolde iki kusur daha kapandı) | Sunucu: `db.isReady()`, `/api/config` ayrımı, `503 accounts_disabled` ↔ `accounts_unavailable`, zaman aşımları, migration yeniden denemesi. İstemci (bu commit): üç durum (`disabled`/`unavailable`/`ready`), sınırlı backoff (3/6/12/24/30s, en çok 20 deneme) + "Tekrar dene", servis gelince saklanan oturumun yeniden doğrulanması, maç sırasında jeton devrinin **ertelenmesi**. Kanıt: `test/account-recovery.test.js` (gerçek PostgreSQL, TCP proxy ile başarısız→başarılı migration geçişi) ve `test/browser/account-readiness.spec.js` (gerçek Chromium: uyarı → servis açılıyor → aynı sayfada dönüş, tıklamasız otomatik dönüş 1 config isteğiyle, maç sırasında aynı socket korunuyor, lobide jeton devri). Mutasyonla doğrulandı: eski istemci ve `setTimeout(tryMigrate)` kaldırılınca ikisi de kalıyor. 12. kontrolde bulunan iki kusur da kapandı: (a) `fetch` ağ hatasında **reddediyor**, bu ret `init()`'i düşürüyordu — ne "Tekrar dene" düğmesi bağlanıyordu ne de bir yeniden kontrol kuruluyordu, yani sayfa yalnız yenilenerek dönebiliyordu; artık `api()` bunu `status: 0` olarak döndürüyor, istekler 10 saniyede zaman aşımına uğruyor ve dinleyiciler ilk istekten **önce** bağlanıyor. (b) `/api/config` hazır dediğinde deneme bütçesi sıfırlanıyordu; `/api/me` 503 verince bu sonsuz 3 saniyelik döngü demekti — artık sıfırlama ancak oturum gerçekten okunduktan sonra. Kanıt: `test/accounts-client.test.js` (ölçüldü: tam 20 deneme, 3/6/12/24/30s, jeton korunuyor); her ikisi ayrı mutasyonla doğrulandı. **Sınır:** `db.isReady()` şemanın bir kez hazırlandığını tutar; sonradan bozulan erişimi yansıtan canlı sağlık kontrolü **değildir**. `accounts-client` testi tarayıcı testi değildir: DOM ve saat çifti kullanır, render hakkında hiçbir şey kanıtlamaz |
| B2 | Futbolcu adı eşleştirmesi | **kapalı** | `"de de"` reddediliyor; `test/name-matching.test.js` 20 kabul + 18 ret örneği |
| B3 | DB TLS doğrulaması | **kısmen — hedef ortam açık** | Kod: TLS kararı artık **sürücünün gerçekten bağlandığı host** üzerinden veriliyor. 12. kontrolde bulundu: `?host=` parametresi URL'nin authority'sini eziyor, yani `postgres://…@localhost/app?host=db.example.com` politikaya "yerel" görünürken sürücü uzak sunucuya **şifresiz** bağlanıyordu; artık parametre kararı belirliyor, çeliştiğinde loglanıyor ve `test/db-tls.test.js` politikanın host'unu pg'nin `ConnectionParameters` çıktısıyla beş biçimde karşılaştırıyor. Yerel istisna yalnız **ayrıştırılmış host** ile (parolada/parametrede geçen `localhost` TLS'i kapatmıyor); URL'deki `ssl*` parametreleri ayıklanıyor (ölçüldü: pg'nin `ConnectionParameters`'ında `?sslmode=no-verify` koddaki `rejectUnauthorized: true`'yu **eziyor**); uzak host için zincir + host doğrulaması, `DB_CA_CERT`/`DB_CA_CERT_PATH`. `DB_SSL=no-verify` açık, loglanan ve **kasıtlı** bir geçiş kapısıdır. Kanıt: `test/db-tls.test.js` — kendinden imzalı sertifika `DEPTH_ZERO_SELF_SIGNED_CERT` ile reddedildi, aynı sertifika eski ayarla el sıkışıyor (kontrol), başka host için kesilmiş sertifika `ERR_TLS_CERT_ALTNAME_INVALID`. **Açık kalan:** hedef sağlayıcının zinciriyle staging doğrulaması ve canlıda açma kararı; bu yapılmadan kart kapanmaz |
| B4 | Gerçek tarayıcı recovery testi | **incelemede** | 12. kontrolde bulunan eksik: **maç sonu ekranı** oda yaşam döngüsünün dışındaydı. Rövanş, maçın oynandığı odaya ihtiyaç duyar; o ekranda kopma izlenmiyordu, recovery süresi dolunca rövanş isteği odası olmayan yeni socket'ten gidiyor, sunucu yanıtlamıyor ve düğme sebebi yazılmadan ölü kalıyordu. Artık `over` ekranı da oda ekranı sayılıyor (jeton devri de orada erteleniyor): kopma anında bilgi veriliyor, recovery reddedilirse rövanş **tıklanmadan önce** kapatılıyor, sebebi ve lobiye dönüş yolu yazılıyor, skor ekranda kalıyor. Kanıt `test/browser/recovery-over.spec.js` — hem reddedilen recovery hem de **normal** (recovery başarılı) rövanş akışı; eski `app.js` ile kalıyor. Önceki eksikler: recovery penceresi aşılınca istemci ölü oyun ekranında kalıyordu (yeni socket, oda yok) ve kopma sırasında kullanıcıya hiçbir şey yazılmıyordu. Kanıt (gerçek Chromium, ağ `setOffline` ile gerçekten kesilerek, her bekleme olaya bağlı): `recovery-ui.spec.js` — takım ve cevap pencerelerinde kopma, faz geri dönüyor, **bitiş anı değişmiyor**, kalan süre yalnız azalıyor (8963→6647ms; 5802→2667ms), çevrimdışı yazılan cevap yeni tura taşınmıyor (skor 0, "Tur 2/2"); `recovery-expired.spec.js` — pencere 1200ms'ye indirilip aşılıyor, socket yenileniyor, lobide açık son durum; `recovery-roomgone.spec.js` — oda yok olduktan sonra dönüşte de açık son durum; `recovery-session.spec.js` — kopma sırasında iptal edilen oturum geri gelmiyor. Üçlü koşuda üç kez üst üste geçti. **Düzeltilmiş iddia:** eklenen `roomGone` olayı kanıtlanmış bir düzeltme **değil** — kaldırıldığında test üç kez geçiyor, çünkü Socket.IO odadan ayrılmış oturuma `opponentLeft`'i yeniden gönderiyor; kodda emniyet payı olarak kalıyor, düzeltme diye sayılmıyor. İlk testim sabit `sleep` ile oda yıkımıyla yarışıyordu; bir koşuda kalması bunu ortaya çıkardı |
| B5 | Fontların yerelleştirilmesi + README düzeltmesi | **incelemede** | `public/fonts/` (16 woff2, latin+latin-ext), SIL OFL 1.1 metinleri, CSP'den dış kaynaklar kaldırıldı. İki ayrı kanıt, biri diğerinin yerine geçmez: `test/browser/fonts-local.spec.js` gerçek ağı izler ve yalnız **yüklenen** fontları ölçer (Inter ölçümü dahil); 8 yüzün Türkçe glif kapsaması ayrıca fontTools cmap taramasıyla doğrulandı (statik kontrol, tarayıcı testinin kanıtı değil). Bağımsız kontrolde fontTools Brotli eksikliğinden koşamadı — o ortamda glif kapsaması doğrulanmadı |
| B6 | Debug jetonu yalnız başlıkta | **kapalı** | `?key=` kaldırıldı; `test/account-readiness.test.js` son senaryo |

## Aşama C — Birleşik doğrulama

| Kimlik | İş | Durum |
|---|---|---|
| C1 | Normal oyun akışlarının bir arada doğrulanması | **kısmen** — socket + tarayıcı paketleri var; karma (misafir/hesap) eşleşme ayrı senaryo olarak yok |
| C2 | Yarış senaryoları | **kısmen** — koşan testler: `round-timing`, `recovery`, `session-revocation`, `pending-join`, `double-match`, `account-integrity` (izole PostgreSQL). Kapsanan: eşzamanlı gönderim, geç/replay gönderim, iptal edilmiş oturumun dönüşü, bekleyen davet, aynı maçın iki kez kaydı. **Kapsanmayan:** iki sunucu süreci (D1), veritabanı bağlantı havuzunun tükenmesi, aynı anda çok sayıda oda. "Kapalı sayılabilir" ifadesi kaldırıldı |
| C3 | Hesap yaşam döngüsü | **kısmen** — `browser/account-rights`, `browser/auth-security`, `account-integrity`; süresi dolan oturum ayrı test edilmedi |
| C4 | Dış veri (snapshot yok/eski, Wikidata yavaş/hatalı) | **kısmen** — gecikme knob'u var, "erişilemez" ve "eski snapshot" ayrı senaryo değil |
| C5 | Gerçek cihaz | **açık** — sahibi Hasan |

## Aşama D — Yayın ortamı ve kurtarma provası

D1 tek süreç sınırı · D2 barındırma planı · D3 kapasite deneyi · D4 ölçüm ·
D5 kesinti politikası · D6 gözlem/alarm · D7 yedek + geri yükleme provası ·
D8 sürüm geri dönüşü · D9 ürün metinleri · D10 marka/haklar — **hepsi açık**.

Her birinin geliştirici parçası bu depodan yapılabilir (yukarıdaki sahiplik
tablosu); yalnız sağlayıcıda yapılan doğrulama ve canlı işlem bekler. D1 için
tek süreç sınırı kod içinde ölçülebilir ve henüz ölçülmedi.

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
