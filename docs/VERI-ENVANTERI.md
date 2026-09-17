# Veri Envanteri

Bu belge, uygulamanın **gerçekte** hangi verileri işlediğini koddan çıkarılmış
haliyle listeler. Gizlilik Politikası, Kullanım Koşulları ve KVKK aydınlatma
metni bunun üzerine yazılmalıdır — tahmin üzerine değil.

Kod değiştiğinde bu belge de güncellenmelidir. Doğrulama noktaları her satırda
dosya adıyla verilmiştir.

Son kontrol: 2026-09-18

---

## 1. Sunucuda saklanan veriler (Postgres)

Şema: `server/db.js`

### `players`
| Alan | İçerik | Amaç | Kişisel veri mi |
|---|---|---|---|
| `id` | otomatik sayı | iç referans | dolaylı |
| `username` | oyuncunun seçtiği ad (küçük harf) | giriş ve tabloda kimlik | evet (takma ad) |
| `display_name` | aynı adın yazıldığı hali | ekranda gösterim | evet (takma ad) |
| `password_hash` | scrypt özeti + tuz | kimlik doğrulama | evet (kimlik bilgisi) |
| `created_at` | kayıt anı | hesap yaşı | evet |
| `deleted_at` | silinme anı | silinmiş hesabı gizlemek | evet |

**E-posta, telefon, ad-soyad, doğum tarihi, konum veya ödeme bilgisi
toplanmıyor.** Kayıt yalnızca kullanıcı adı ve şifre ister
(`server/accounts.js`, `register`).

### `sessions`
| Alan | İçerik | Amaç |
|---|---|---|
| `token` | 32 baytlık rastgele değer | oturum |
| `player_id` | oyuncu referansı | oturum sahibi |
| `created_at` / `expires_at` | zaman damgaları | oturum ömrü (60 gün) |

Oturum satırında **IP, cihaz, tarayıcı veya konum bilgisi tutulmuyor.**

### `matches`
| Alan | İçerik | Amaç |
|---|---|---|
| `player_a`, `player_b` | oyuncu referansları | maçın tarafları |
| `score_a`, `score_b` | skorlar | lider tablosu ve seri |
| `winner_id` | kazanan (boşsa beraberlik) | istatistik |
| `played_at` | maç anı | sıralama |

Yalnızca **iki tarafı da kayıtlı** maçlar yazılır; misafir içeren maçlar hiç
kaydedilmez (`server/index.js`, `saveMatch`).

---

## 2. Bellekte tutulan, kalıcı olmayan veriler

`server/index.js` içinde, yalnızca sunucu çalıştığı sürece:

- **Oda durumu**: oyuncu adları, yazılan takımlar, skorlar, tur durumu.
  Maç bitince veya bağlantı kopunca silinir.
- **Davet kodları**: 30 dakika sonra otomatik silinir (`INVITE_TTL_MS`).
- **Hız sınırı sayaçları**: `server/rateLimit.js`. IP adresi bir Map
  anahtarı olarak tutulur, **diske yazılmaz**, en geç 1 saatte temizlenir.
  Bu, kötüye kullanımı engellemenin teknik zorunluluğudur (meşru menfaat).
- **Wikidata önbelleği**: kulüp kadroları, 6 saat. Kişisel veri içermez.

Sunucu yeniden başladığında bu verilerin tamamı kaybolur.

---

## 3. Tarayıcıda saklananlar

Anahtar adları `config/brand.js` içinde tanımlıdır.

| Anahtar | Depo | İçerik | Amaç | Ömür |
|---|---|---|---|---|
| `321futbol.token` | localStorage | oturum jetonu | girişi hatırlamak | çıkışa veya 60 güne kadar |
| `321futbol.muted` | localStorage | `0` / `1` | ses tercihi | kullanıcı silene kadar |

**Çerez (cookie) kullanılmıyor. sessionStorage kullanılmıyor.** Üçüncü taraf
izleme çerezi yok.

---

## 4. Üçüncü taraflara giden veriler

| Servis | Ne gidiyor | Neden | Not |
|---|---|---|---|
| **Neon (Postgres)** | 1. bölümdeki tüm veriler | veritabanı barındırma | veri işleyen; bölge seçimi AB olmalı |
| **Render** | HTTP istekleri, IP adresi (altyapı logu) | uygulama barındırma | veri işleyen |
| **Wikidata / WMF** | yalnızca **kulüp adı** ve User-Agent'ımız | futbolcu doğrulama | kullanıcıya ait hiçbir veri gitmez |
| **Google Fonts** | ziyaretçinin **IP adresi** ve tarayıcı bilgisi | yazı tipi indirme | ⚠ aşağıya bakınız |

> ⚠ **Google Fonts uyarısı.** Yazı tipleri şu an Google'ın sunucusundan
> çekiliyor; bu, her ziyaretçinin IP adresinin Google'a gitmesi demek. Avrupa'da
> bu konuda aleyhte kararlar var ve KVKK açısından da "yurt dışına aktarım"
> başlığını açıyor. **Çözüm: yazı tiplerini kendi sunucumuzdan servis etmek.**
> Teknik olarak basit (dosyaları `public/` altına koyup `@font-face` yazmak) ve
> sayfa da hızlanır. Yapılacaklar listesinde HIGH.

**Analytics, reklam, piksel, hata izleme servisi kullanılmıyor** — yani şu anda
kullanıcı davranışı hiçbir yere gönderilmiyor.

---

## 5. Loglanan veriler

`server/index.js` ve diğer sunucu dosyaları yalnızca teknik olay yazar:
hata mesajları, hesap silme olayı (`id` ile), sunucu başlangıcı, Wikidata
sorgu sonuçları. **İstek logu, IP logu veya kullanıcı davranış logu
tutulmuyor.** Render'ın kendi altyapı logları bunun dışındadır ve barındırma
sağlayıcısının politikasına tabidir.

---

## 6. Saklama süreleri

| Veri | Süre |
|---|---|
| Hesap (kullanıcı adı, şifre özeti) | kullanıcı silene kadar |
| Oturumlar | 60 gün, sonra otomatik silinir (`purgeExpiredSessions`) |
| Maç geçmişi | süresiz — istatistiklerin temeli |
| Oda/oyun durumu | maç süresince |
| Davet kodu | 30 dakika |
| Hız sınırı sayaçları | en fazla 1 saat |

**Hesap silindiğinde:** kullanıcı adı ve görünen ad anonimleştirilir, şifre
özeti tamamen silinir, tüm oturumlar yok edilir. Maç satırları kalır — çünkü
silinmeleri **rakibin** galibiyet geçmişini de silerdi. Silinen oyuncu hiçbir
ekranda görünmez (`server/accounts.js`, `deleteAccount`).

---

## 7. Kullanıcı hakları — teknik karşılıkları

| Hak | Uç nokta | Durum |
|---|---|---|
| Erişim / taşınabilirlik | `POST /api/account/export` | ✅ hazır (JSON indirir) |
| Silme | `POST /api/account/delete` | ✅ hazır |
| Oturum sonlandırma | `POST /api/logout` | ✅ hazır |
| Düzeltme (ad değişikliği) | — | ❌ yok, eklenmeli |
| Şifre değiştirme | — | ❌ yok, eklenmeli |
| Şifre sıfırlama | — | ❌ yok — e-posta toplanmadığı için şu an **imkânsız** |

Her iki hassas işlem de şifreyi yeniden sorar: çalınmış bir jeton tek başına
veri indirmeye veya hesap silmeye yetmez.

### Şifre sıfırlama hakkında karar gerekiyor

E-posta toplamadığımız için şifresini unutan kullanıcı hesabını **kalıcı
olarak** kaybediyor. Üç seçenek var:

1. **İsteğe bağlı kurtarma e-postası** — kullanıcı isterse verir. Veri toplamayı
   minimumda tutar, sıfırlamayı mümkün kılar. *Önerilen.*
2. **Tek kullanımlık kurtarma kodu** — kayıtta gösterilir, kullanıcı saklar.
   Hiç veri toplamaz ama çoğu kullanıcı kaybeder.
3. **Hiç sıfırlama yok** — şu anki durum; mağazaya çıkarken şikâyet üretir.
