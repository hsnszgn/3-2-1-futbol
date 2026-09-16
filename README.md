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
- `server/index.js` — Express + Socket.io: eşleştirme (rastgele kuyruk / oda kodu), round state machine, zamanlayıcılar.
- `server/gameLogic.js` — Futbolcu adı doğrulama (normalize + basit fuzzy eşleştirme).
- `server/data/teams.js` — Takım adı/alias normalizasyonu.
- `server/data/players.js` — MVP futbolcu-takım veri seti (genişletilebilir).
- `public/` — Tek sayfalık istemci (vanilla JS + Socket.io client).

## Bilinen sınırlamalar (MVP)
- Futbolcu veri seti elle küratörlenmiş, kapsamlı bir transfer veritabanı değil (~150 oyuncu, büyük Avrupa kulüpleri odaklı). Gerçek bir kullanım için harici bir futbol API'sine (örn. API-Football, Transfermarkt verisi) bağlanmak gerekir.
- Oda/eşleşme durumu bellekte tutulur (in-memory) — sunucu yeniden başlatıldığında sıfırlanır. Çoklu sunucu/ölçeklenme için Redis gibi paylaşımlı bir store gerekir.
