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
- `server/wikidata.js` — Futbolcu doğrulaması için Wikidata'nın ücretsiz, API-key gerektirmeyen SPARQL + arama servislerine canlı bağlanır: takım adını Wikidata QID'ine çözer (kalıcı önbellek), sonra o iki takımda ortak oynamış tüm futbolcuları tek SPARQL sorgusuyla çeker (1 saatlik önbellek). Bu sorgu, takımlar açıklanır açıklanmaz (oyuncular henüz yazmaya başlamadan) arka planda tetiklenir, böylece gerçek tahmin anında gecikme neredeyse hiç hissedilmez.
- `server/gameLogic.js` — Önceden çekilmiş oyuncu listesine karşı normalize + basit fuzzy (Levenshtein) eşleştirme.
- `server/data/teams.js` — Takım adı/alias normalizasyonu (Türkçe karakter desteği dahil) — kullanıcının yazdığı serbest metni kanonik bir takım adına çevirir, Wikidata sorgusu bu adla yapılır.
- `public/` — Tek sayfalık istemci (vanilla JS + Socket.io client).

## Veri kaynağı ve bilinen sınırlamalar
- Futbolcu-takım verisi elle küratörlenmiş bir liste DEĞİL — her sorguda canlı olarak Wikidata'dan çekiliyor, bu yüzden kapsam pratikte Wikidata'nın kapsamı kadar geniş (dünyadaki hemen her profesyonel futbolcu).
- Bir takım adı Wikidata'da ilk aramada doğru kulüple eşleşmezse (nadiren, belirsiz/az bilinen isimlerde olabilir) o round'da doğrulama başarısız olur ve kullanıcıya açık bir hata mesajı gösterilir (sessizce "bulunamadı" demez).
- Wikidata servisi yanıt vermezse veya zaman aşımına uğrarsa (6 saniye limit), oyuncuya "doğrulama servisine ulaşılamıyor" mesajı gösterilir; round süre dolunca tekrarlanır.
- Oda/eşleşme durumu ve önbellekler bellekte tutulur (in-memory) — sunucu yeniden başlatıldığında sıfırlanır. Çoklu sunucu/ölçeklenme için Redis gibi paylaşımlı bir store gerekir.
