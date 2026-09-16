# 3-2-1 Futbol

İki oyunculu, gerçek zamanlı takım/futbolcu isim oyunu.

## Nasıl oynanır
1. İsmini yaz, "Rastgele Rakip Bul" ile eşleş ya da bir arkadaşına oda kodu gönder.
2. "3-2-1" geri sayımından sonra ekrandaki kutuya bir futbol takımı yaz ve gönder.
3. İki oyuncu da takımını gönderince takımlar karşılıklı açıklanır.
4. Her iki takımda da oynamış bir futbolcunun adını ilk doğru yazan turu kazanır.
5. 5 round sonunda en çok puanı alan kazanır.

## Kurulum

```bash
npm install
npm start
```

Sunucu `http://localhost:3000` adresinde çalışır.

## Mimari
- `server/index.js` — Express + Socket.io: eşleştirme (rastgele kuyruk / oda kodu), round state machine, zamanlayıcılar, bağlantı kopması toleransı.
- `server/wikidata.js` — Futbolcu doğrulaması için Wikidata'nın ücretsiz, API-key gerektirmeyen arama + SPARQL servislerine canlı bağlanır. Önemli ayrıntı: Wikidata'da birçok kulübün birden fazla kaydı vardır (ana spor kulübü, futbol şubesi, tarihî isimler) ve futbolcuların "member of sports team" (P54) kayıtları bunlardan yalnızca birine bağlıdır; bu yüzden tek bir kayıt seçmek yerine isme gerçekten benzeyen tüm adaylar `VALUES` ile sorguda birleştirilir. Sorgu, takımlar açıklanır açıklanmaz (oyuncular henüz yazmaya başlamadan) arka planda tetiklenir, böylece tahmin anında gecikme hissedilmez.
- `server/gameLogic.js` — Önceden çekilmiş oyuncu listesine karşı eşleştirme: normalize (Türkçe karakter dahil), Wikidata takma adları, yazım hatası toleransı (Levenshtein) ve sadece soyisim yazma ("Muriqi") desteği.
- `server/data/teams.js` — Takım adı/alias normalizasyonu (Türkçe karakter desteği dahil) — kullanıcının yazdığı serbest metni kanonik bir takım adına çevirir, Wikidata sorgusu bu adla yapılır.
- `public/` — Tek sayfalık istemci (vanilla JS + Socket.io client).

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
