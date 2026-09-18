# 3-2-1 Futbol

İki oyunculu, gerçek zamanlı takım/futbolcu isim oyunu.

> **Özel yazılım.** Bu depo açık kaynak değildir; kullanım, kopyalama ve
> dağıtım hakları saklıdır. Bkz. [LICENSE](LICENSE), [NOTICE](NOTICE),
> [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
> Güvenlik bildirimi için [SECURITY.md](SECURITY.md).

## Marka adı

Oyun adının geçtiği her yer — sayfa başlığı, manifest, paylaşım metni,
Wikidata User-Agent'ı, localStorage anahtarları — tek bir dosyadan okur:
[`config/brand.js`](config/brand.js). Ad değişikliği orada yapılır.

Tek istisna `storagePrefix`: değiştirmek giriş yapmış herkesin oturumunu
düşürür, o yüzden önce bir geçiş kodu yazılmalı. Dosyadaki not bunu anlatır.

## Testler

```bash
npm test                 # sunucu testleri — bağımlılıksız, veritabanı gerekmez
npm run test:browser     # tarayıcı testleri — Playwright gerekir
npm test -- socket       # tek test (isim filtresi)
```

**Veritabanı politikası.** Testler `DATABASE_URL` değerini **miras almaz** —
test sunucusu açılışta migration ve oturum temizliği çalıştırdığı için, miras
alınan bir üretim adresi canlı veriye yazmak demekti. Veritabanı isteyen
testler yalnızca `TEST_DATABASE_URL` ile çalışır ve bu adres **atılabilir** bir
veritabanını göstermelidir (tabloları `TRUNCATE` ederler). Tanımlı değilse o
testler ATLANIR ve atlandıkları açıkça yazılır — geçmiş sayılmazlar.

```bash
TEST_DATABASE_URL=postgres://... npm run test:browser
```

**Tarayıcı testlerinin kurulumu.** `playwright` bilerek `package.json`'a
eklenmedi: üretim imajının test tarayıcısı indirmesine gerek yok. Kurulum ve
doğrulanmış sürümler:

```bash
npm i --no-save playwright@1.56.1
npx playwright install chromium          # veya CHROMIUM_PATH ile hazır tarayıcı
CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:browser
```

Bu depodaki sonuçlar **Playwright 1.56.1 + Chromium 141.0.7390.37** ile alındı.
Koşucu her çalıştırmada kullandığı sürümleri ve veritabanının bağlı olup
olmadığını başlıkta yazar, sonucu da "veritabanısız" ve "izole PostgreSQL"
koşusu olarak ayrı raporlar.

| Test | Ne kanıtlıyor | DB |
|---|---|---|
| `socket-payloads` | 26 bozuk payload × 7 olay. Yanıt veren 4 olayda (`joinQueue`, `createPrivateRoom`, `joinPrivateRoom`, oyun sonu `requestRematch`) teslim **sunucu yanıtları sayılarak** ölçülüyor; yanıt vermeyen 4 olayda kanıt yalnızca "bağlantı ayakta kaldı ve sonrasında çalıştı" (bunlar oyun içi bölümde reddetme yanıtlarıyla ayrıca kanıtlanıyor). 16 KB üstü payload **sadece** o bağlantıyı kapatıyor — kapanmazsa test başarısız olur — ve o sırada oynanan maç etkilenmiyor | — |
| `room-integrity` | Tekrarlı `joinQueue` tek maç; kendi davetine katılma reddi; tekrar davet aynı kodu döner | — |
| `double-match` | Davet kabulü kuyruğu temizler; oyundaki oyuncu tekrar eşleşmez; başarılı katılım hata yaymaz; geçersiz kod sırayı düşürmez | — |
| `browser/full-match` | 5 tur + tur sayacı sınırı + rövanş | — |
| `browser/speed-scoring` | **Yalnızca** en hızlı kademe (+3) ve kaybedene gösterilen mesaj. +2/+1 kademeleri ile puanın Wikidata gecikmesinden bağımsızlığı doğrulanmadı | — |
| `browser/invite` | Davet linkiyle katılma akışı | — |
| `browser/void-round` | Ortak oyuncu yoksa tur geçersiz ve tekrarlanır | — |
| `browser/account-rights` | Hesap silme/dışa aktarma; silme rakibin geçmişini bozmaz | ✓ |
| `browser/auth-security` | Jeton sadece başlıkta; çıkış oturumu bitirir; hesap bazlı kilitleme | ✓ |

## Veri ve gizlilik

Uygulamanın gerçekte hangi veriyi topladığı, nerede tuttuğu ve nereye
gönderdiği [`docs/VERI-ENVANTERI.md`](docs/VERI-ENVANTERI.md) içinde
koddan çıkarılmış haliyle listelidir. Gizlilik metinleri bunun üzerine
yazılmalıdır.

## Nasıl oynanır
1. İsmini yaz, "Rastgele Rakip Bul" ile eşleş ya da "Arkadaşını Davet Et" ile
   tek tıkla davet linki gönder (`/?oda=KOD`). Linke basan kişi doğrudan senin
   odana düşer, kodu elle yazması gerekmez.
2. "3-2-1" geri sayımından sonra ekrandaki kutuya bir futbol takımı yaz ve gönder.
3. İki oyuncu da takımını gönderince takımlar karşılıklı açıklanır.
4. Her iki takımda da oynamış bir futbolcunun adını ilk doğru yazan turu kazanır.
5. 5 round sonunda en çok puanı alan kazanır.
6. Oyun bitince iki oyuncu da "Rövanş" derse aynı rakiple yeni oyun başlar.

## Hesap, puantaj ve lider tablosu

Kayıt olmak zorunlu değil — misafir olarak her şey eskisi gibi oynanır. Ama
kayıtlı iki oyuncunun oynadığı her maç kaydedilir ve lider tablosuna işlenir.

Kayıt yalnızca bir kullanıcı adı ve bir şifre ister; e-posta ya da ayrı bir
"görünecek ad" yok. Oyunda ve tabloda kullanıcı adı yazıldığı gibi görünür,
girişte büyük/küçük harf farkı önemsenmez.

- **Puan:** galibiyet 3, beraberlik 1, mağlubiyet 0.
- **Kademe** (puana göre, kendi rengiyle): Bronz 0+, Gümüş 20+, Altın 50+,
  Platin 100+, Elit 200+.
- **Rütbe** (oynama sıklığına göre, kazanmaktan bağımsız): Çaylak 0+,
  Düzenli 10+, Müdavim 30+, Efsane 100+.
- **Rozet:** ilk üç sıra 🥇🥈🥉 ile işaretlenir.
- Tabloda her oyuncunun galibiyet/beraberlik/mağlubiyet sayısı ve maç başına
  ortalama puanı yan yana durur — ortalamanın neye dayandığı görünsün diye.
- Daha önce karşılaşmış iki kayıtlı oyuncu eşleştiğinde, maç başlamadan
  aralarındaki seri gösterilir: "Aranızda 4 maç · 3-1 öndesin".

İstatistikler sayaç olarak tutulmaz; her seferinde maç geçmişinden hesaplanır,
bu yüzden geçmişle çelişmesi mümkün değil.

### Güvenlik

Oyun yakın çevrenin dışına açılacağı için hesap tarafı şu şekilde sıkılaştırıldı:

- **Oturumlar 60 günde sona erer.** "Çıkış" artık sunucudaki oturumu da siler;
  eskiden yalnızca tarayıcıdaki jetonu siliyordu, yani sızan bir jeton sonsuza
  kadar geçerli kalıyordu. Süresi dolan satırlar 6 saatte bir temizlenir.
- **Jeton URL'de taşınmaz.** `Authorization: Bearer ...` başlığıyla gider;
  adres çubuğundaki bir jeton sunucu kayıtlarına, tarayıcı geçmişine ve
  `Referer` başlığına düşerdi.
- **Hız sınırı** (`server/rateLimit.js`, bellek içi, bağımlılıksız):
  kayıt saatte 15/IP, giriş 15 dakikada 12/IP **ve** hesap başına 8 — böylece
  denemeleri birçok IP'ye yaymak tek bir hesabı sınırsızca denemeye dönüşmez.
  `/debug/*` uçları da sınırlı, çünkü her biri canlı Wikidata sorgusu tetikler.
  Sınırlar `RATE_REGISTER`, `RATE_LOGIN`, `RATE_LOGIN_USER`, `RATE_API`,
  `RATE_DEBUG` ortam değişkenleriyle değiştirilebilir.
- **Kullanıcı adı sızdırmaz.** Bilinmeyen kullanıcı adında da şifre özeti
  hesaplanır; yoksa "anında hayır" ile "yavaş hayır" arasındaki fark hangi
  kullanıcı adlarının var olduğunu ele verirdi.
- Şifre en az 6 karakter, JSON gövdesi en fazla 8 KB, tek bir IP'den en fazla
  25 eşzamanlı soket (kuyruğu hayalet oyuncularla doldurmayı engellemek için).
- `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` başlıkları.

### Kurulum (Postgres)

Render'ın ücretsiz planında kalıcı disk yok, bu yüzden hesaplar harici bir
Postgres'te durur (Neon'un ücretsiz planı fazlasıyla yeter):

1. [neon.com](https://neon.com) üzerinden ücretsiz bir proje aç.
2. Verdiği bağlantı adresini (`postgres://...`) kopyala.
3. Render'da servisin **Environment** sekmesine `DATABASE_URL` adıyla ekle.

Tablolar ilk açılışta kendiliğinden oluşur. `DATABASE_URL` tanımlı değilse
hesap sistemi tamamen kapalı kalır ve oyun eskisi gibi çalışır.

## Kurulum

```bash
npm install
npm start
```

Sunucu `http://localhost:3000` adresinde çalışır.

## Mimari
- `server/index.js` — Express + Socket.io: eşleştirme (rastgele kuyruk / oda kodu), round state machine, zamanlayıcılar, bağlantı kopması toleransı.
- `server/wikidata.js` — Futbolcu doğrulaması için Wikidata'nın ücretsiz, API-key gerektirmeyen arama + SPARQL servislerine canlı bağlanır. Sorgu, takımlar açıklanır açıklanmaz (oyuncular henüz yazmaya başlamadan) arka planda tetiklenir, böylece tahmin anında gecikme hissedilmez. Burada Wikidata'ya özgü iki tuzak var ve ikisi de üretimde canımızı yaktı:
  - **Kulübün birden fazla kaydı olması.** Ana spor kulübü, futbol şubesi, tarihî isimler ayrı kayıtlardır ve P54 ("member of sports team") kayıtları bunlardan yalnızca birine bağlıdır. Ayrıca kulüp adı çoğu zaman bir yer adıdır ("Valencia") ve şehir/il kayıtları aramada kulübün önüne geçer. Bu yüzden tek kayıt seçilmez: isme benzeyen tüm adaylar, kulübe benzeyenler öne sıralanarak `VALUES` ile sorguda birleştirilir.
  - **İfade rütbesi (statement rank).** `wdt:P54` yalnızca "truthy" (en yüksek rütbeli) ifadeleri döndürür. Bir editör futbolcunun *güncel* kulübünü "preferred" rütbeyle işaretlediği anda, o futbolcunun geçmiş kulüplerinin tamamı `wdt:` sonuçlarından kaybolur — yeni transfer olmuş bir oyuncu sanki tek kulüpte oynamış gibi görünür (Lukaku/McTominay → Napoli, Openda → Juventus bu yüzden reddediliyordu). Bu yüzden sorgu `p:P54/ps:P54` ile ifade düğümünden geçer ve rütbeden bağımsız olarak tüm kariyeri döndürür.
- `server/gameLogic.js` — Önceden çekilmiş oyuncu listesine karşı eşleştirme: normalize (Türkçe karakter dahil), Wikidata takma adları, yazım hatası toleransı (Levenshtein) ve sadece soyisim yazma ("Muriqi") desteği.
- `server/data/teams.js` — Takım adı/alias normalizasyonu (Türkçe karakter desteği dahil). Bu liste artık yalnızca bir **hızlı yol**: sık kullanılan kısaltmaları ("Man United", "GS") anında çözer. Listede olmayan bir takım yazılırsa (Deportivo, Leganés gibi) ya da Türkçe adı kullanılırsa ("Marsilya"), isim canlı olarak Wikidata'da aranır — hem İngilizce hem Türkçe etiketlerde. Yani takım adları da artık elle tutulan bir listeye bağlı değil.
- `server/db.js` — Postgres bağlantısı ve şema. `DATABASE_URL` yoksa temiz şekilde devre dışı kalır.
- `server/accounts.js` — Kayıt/giriş (scrypt ile şifre özeti), oturum jetonları, puantaj, kademe/rütbe hesabı ve kafa kafaya seri.
- `public/accounts.js` — Hesap ekranı, hesap kartı ve lider tablosu. Oyun döngüsüne hiç dokunmaz: soket üzerinden değil HTTP üzerinden konuşur, tek ortak nokta oturum jetonudur.
- `public/` — Tek sayfalık istemci (vanilla JS + Socket.io client).

## Kadro anlık görüntüsü (neden var?)

Bir round'un ortasında ağ beklemek, oyunun en kırılgan yeriydi: doğru bir
cevabın reddedilmesi çoğu zaman oyuncunun değil, yavaş veya hata veren bir
sorgunun suçuydu. Bu yüzden `scripts/build-squads.js`, **deploy sırasında**
(Render'ın `buildCommand`'ında) yerel listedeki her kulüp için "kim burada
oynadı" verisini çekip `server/data/squads.json` dosyasına yazar.

Sunucu açılışta bu dosyayı belleğe alır; bilinen iki kulüp arasındaki her
eşleşme artık **hiç ağa çıkmadan, milisaniyede** yanıtlanır. Listede olmayan
kulüpler (ve dosya hiç üretilememişse her şey) eskisi gibi canlı Wikidata
sorgusuna düşer — yani bu bir hızlandırma, bir bağımlılık değil.

Anlık görüntü depoya işlenmez (`.gitignore`), her deploy'da yeniden üretilir.
Yerelde denemek için: `npm run build:squads`.
Durumunu görmek için: `/debug/snapshot`

## Teşhis (bir oyuncu/takım neden kabul edilmedi?)

Canlı sunucuda şu adresi tarayıcıda açarak Wikidata'nın o eşleşme için ne
döndürdüğünü ham haliyle görebilirsin:

```
/debug/lookup?a=Fenerbahce&b=Lazio&guess=Vedat Muriqi
```

Yanıt; her iki takım adının Wikidata'da hangi kayıtlara çözüldüğünü
(`candidatesA`/`candidatesB`), ortak oyuncu sayısını, tüm ortak oyuncu
listesini ve yazılan ismin eşleşip eşleşmediğini (`guessMatched`) gösterir.

## Veri kaynağı ve bilinen sınırlamalar
- Futbolcu-takım verisi elle küratörlenmiş bir liste DEĞİL — her sorguda canlı olarak Wikidata'dan çekiliyor, bu yüzden kapsam pratikte Wikidata'nın kapsamı kadar geniş (dünyadaki hemen her profesyonel futbolcu).
- Bir takım adı Wikidata'da ilk aramada doğru kulüple eşleşmezse (nadiren, belirsiz/az bilinen isimlerde olabilir) o round'da doğrulama başarısız olur ve kullanıcıya açık bir hata mesajı gösterilir (sessizce "bulunamadı" demez).
- Wikidata servisi yanıt vermezse veya zaman aşımına uğrarsa (6 saniye limit), oyuncuya "doğrulama servisine ulaşılamıyor" mesajı gösterilir; round süre dolunca tekrarlanır.
- Oda/eşleşme durumu ve önbellekler bellekte tutulur (in-memory) — sunucu yeniden başlatıldığında sıfırlanır. Çoklu sunucu/ölçeklenme için Redis gibi paylaşımlı bir store gerekir.
- Render'ın ücretsiz planı 15 dakika kullanılmayınca uykuya geçer ve ilk istek
  ~40 saniye sürer; davet linkine basan biri çoğunlukla o ekranda vazgeçer.
  Ücretsiz çözüm: dışarıdan düzenli olarak `/healthz` adresine ping atan bir
  uptime servisi (örn. 10 dakikada bir). Ücretsiz plandaki aylık 750 saatlik
  kota, tek bir servisi sürekli ayakta tutmaya ancak yeter.
