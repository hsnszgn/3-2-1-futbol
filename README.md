# 3-2-1 Futbol

İki oyunculu, gerçek zamanlı takım/futbolcu isim oyunu.

## Nasıl oynanır
1. İsmini yaz, "Rastgele Rakip Bul" ile eşleş ya da bir arkadaşına oda kodu gönder.
2. "3-2-1" geri sayımından sonra ekrandaki kutuya bir futbol takımı yaz ve gönder.
3. İki oyuncu da takımını gönderince takımlar karşılıklı açıklanır.
4. Her iki takımda da oynamış bir futbolcunun adını ilk doğru yazan turu kazanır.
5. 5 round sonunda en çok puanı alan kazanır.
6. Oyun bitince iki oyuncu da "Rövanş" derse aynı rakiple yeni oyun başlar.

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
