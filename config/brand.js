/**
 * Marka tek kaynağı.
 *
 * Oyunun adı değişebilir. Adın geçtiği her yer — sayfa başlığı, manifest,
 * paylaşım metni, Wikidata User-Agent'ı, uygulama kimliği — buradan okur, ki
 * isim değişikliği tek dosyada bitsin.
 *
 * Sunucu bu nesneyi index.html'e `window.__BRAND` olarak enjekte eder, yani
 * istemci tarafı da aynı kaynağı kullanır ve ekstra bir istek gerekmez.
 */

// DİKKAT: bu önek localStorage anahtarlarının başına gelir
// (`<önek>.token`, `<önek>.muted`). Değiştirmek, giriş yapmış her oyuncunun
// oturumunu ve ses tercihini düşürür. Değiştirmek gerekirse önce eski
// anahtarları yeni öneke taşıyan bir geçiş kodu yazılmalı.
const STORAGE_PREFIX = '321futbol';

module.exports = {
  /** Kullanıcıya görünen tam ad. */
  name: '3-2-1 Futbol',
  /** Ana ekran simgesi ve dar alanlar için kısa ad (12 karakteri geçmesin). */
  shortName: '3-2-1',
  tagline: 'Aynı anda takım söyle. Ortak oyuncuyu ilk sen bul.',
  description:
    'İki oyunculu gerçek zamanlı futbol oyunu: aynı anda bir takım söyleyin, '
    + 'her iki takımda da oynamış futbolcuyu ilk bulan turu kazansın.',

  storagePrefix: STORAGE_PREFIX,
  storageKeys: {
    token: `${STORAGE_PREFIX}.token`,
    muted: `${STORAGE_PREFIX}.muted`,
  },

  /** npm paket adı ve dağıtım kimlikleri. */
  packageName: '3-2-1-futbol',
  /** iOS bundle id / Android applicationId — mağazaya çıkarken sabitlenir. */
  appId: 'com.hasansozgun.futbol321',

  themeColor: '#fa6b1d',
  backgroundColor: '#0d0d10',
  locale: 'tr',

  supportEmail: 'hsnszgn@gmail.com',
  /** Wikidata kullanım politikası tanımlanabilir bir iletişim adresi ister. */
  contactUrl: 'https://github.com/hsnszgn/3-2-1-futbol',

  /** Mutlak bağlantılar (paylaşım, manifest, og:url) için kök adres. */
  get siteUrl() {
    return (process.env.PUBLIC_URL || 'https://three-2-1-futbol.onrender.com').replace(/\/$/, '');
  },
};
