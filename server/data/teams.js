// Canonical team names + alias map for normalization.
// key: alias (lowercase, no accents) -> canonical team id

const TEAMS = [
  { id: 'manchester united', display: 'Manchester United', aliases: ['man united', 'man utd', 'manu', 'united'] },
  { id: 'manchester city', display: 'Manchester City', aliases: ['man city', 'city'] },
  { id: 'liverpool', display: 'Liverpool', aliases: ['lfc'] },
  { id: 'chelsea', display: 'Chelsea', aliases: ['cfc'] },
  { id: 'arsenal', display: 'Arsenal', aliases: ['afc'] },
  { id: 'tottenham hotspur', display: 'Tottenham Hotspur', aliases: ['tottenham', 'spurs'] },
  { id: 'real madrid', display: 'Real Madrid', aliases: ['madrid', 'real'] },
  { id: 'barcelona', display: 'Barcelona', aliases: ['barca', 'fc barcelona'] },
  { id: 'atletico madrid', display: 'Atletico Madrid', aliases: ['atletico', 'atleti'] },
  { id: 'sevilla', display: 'Sevilla', aliases: [] },
  { id: 'valencia', display: 'Valencia', aliases: [] },
  { id: 'juventus', display: 'Juventus', aliases: ['juve'] },
  { id: 'ac milan', display: 'AC Milan', aliases: ['milan'] },
  { id: 'inter milan', display: 'Inter Milan', aliases: ['inter', 'internazionale'] },
  { id: 'napoli', display: 'Napoli', aliases: ['ssc napoli'] },
  { id: 'roma', display: 'Roma', aliases: ['as roma'] },
  { id: 'bayern munich', display: 'Bayern Munich', aliases: ['bayern', 'fc bayern'] },
  { id: 'borussia dortmund', display: 'Borussia Dortmund', aliases: ['dortmund', 'bvb'] },
  { id: 'rb leipzig', display: 'RB Leipzig', aliases: ['leipzig'] },
  { id: 'bayer leverkusen', display: 'Bayer Leverkusen', aliases: ['leverkusen'] },
  { id: 'paris saint-germain', display: 'Paris Saint-Germain', aliases: ['psg', 'paris sg', 'paris st germain', 'paris saint germain'] },
  { id: 'marseille', display: 'Marseille', aliases: ['om'] },
  { id: 'monaco', display: 'Monaco', aliases: ['as monaco'] },
  { id: 'lyon', display: 'Lyon', aliases: ['ol'] },
  { id: 'ajax', display: 'Ajax', aliases: [] },
  { id: 'psv eindhoven', display: 'PSV Eindhoven', aliases: ['psv'] },
  { id: 'porto', display: 'Porto', aliases: ['fc porto'] },
  { id: 'benfica', display: 'Benfica', aliases: ['sl benfica'] },
  { id: 'sporting cp', display: 'Sporting CP', aliases: ['sporting lisbon', 'sporting'] },
  { id: 'galatasaray', display: 'Galatasaray', aliases: ['gs'] },
  { id: 'fenerbahce', display: 'Fenerbahce', aliases: ['fb'] },
  { id: 'besiktas', display: 'Besiktas', aliases: ['bjk'] },
  { id: 'trabzonspor', display: 'Trabzonspor', aliases: ['ts'] },
  { id: 'istanbul basaksehir', display: 'Istanbul Basaksehir', aliases: ['basaksehir'] },
  { id: 'kasimpasa', display: 'Kasimpasa', aliases: [] },
  { id: 'sivasspor', display: 'Sivasspor', aliases: [] },
  { id: 'antalyaspor', display: 'Antalyaspor', aliases: [] },
  { id: 'alanyaspor', display: 'Alanyaspor', aliases: [] },
  { id: 'konyaspor', display: 'Konyaspor', aliases: [] },
  { id: 'kayserispor', display: 'Kayserispor', aliases: [] },
  { id: 'gaziantep fk', display: 'Gaziantep FK', aliases: ['gaziantep'] },
  { id: 'ankaragucu', display: 'Ankaragucu', aliases: [] },
  { id: 'rizespor', display: 'Rizespor', aliases: ['caykur rizespor'] },
  { id: 'adana demirspor', display: 'Adana Demirspor', aliases: [] },
  { id: 'hatayspor', display: 'Hatayspor', aliases: [] },
  { id: 'samsunspor', display: 'Samsunspor', aliases: [] },
  { id: 'goztepe', display: 'Goztepe', aliases: [] },
  { id: 'bursaspor', display: 'Bursaspor', aliases: [] },
  { id: 'genclerbirligi', display: 'Genclerbirligi', aliases: [] },
  { id: 'eskisehirspor', display: 'Eskisehirspor', aliases: [] },
  { id: 'wolfsburg', display: 'Wolfsburg', aliases: ['vfl wolfsburg'] },
  { id: 'schalke 04', display: 'Schalke 04', aliases: ['schalke'] },
  { id: 'eintracht frankfurt', display: 'Eintracht Frankfurt', aliases: ['frankfurt'] },
  { id: 'borussia monchengladbach', display: 'Borussia Monchengladbach', aliases: ['gladbach', 'monchengladbach'] },
  { id: 'hamburg', display: 'Hamburger SV', aliases: ['hamburger sv', 'hsv'] },
  { id: 'stuttgart', display: 'VfB Stuttgart', aliases: ['vfb stuttgart'] },
  { id: 'athletic bilbao', display: 'Athletic Bilbao', aliases: ['athletic club'] },
  { id: 'real sociedad', display: 'Real Sociedad', aliases: ['sociedad'] },
  { id: 'villarreal', display: 'Villarreal', aliases: [] },
  { id: 'real betis', display: 'Real Betis', aliases: ['betis'] },
  { id: 'celta vigo', display: 'Celta Vigo', aliases: ['celta'] },
  { id: 'espanyol', display: 'Espanyol', aliases: [] },
  { id: 'malaga', display: 'Malaga', aliases: [] },
  { id: 'lille', display: 'Lille', aliases: ['losc'] },
  { id: 'nice', display: 'Nice', aliases: ['ogc nice'] },
  { id: 'rennes', display: 'Rennes', aliases: [] },
  { id: 'fiorentina', display: 'Fiorentina', aliases: [] },
  { id: 'lazio', display: 'Lazio', aliases: ['ss lazio'] },
  { id: 'atalanta', display: 'Atalanta', aliases: [] },
  { id: 'torino', display: 'Torino', aliases: [] },
  { id: 'bologna', display: 'Bologna', aliases: [] },
  { id: 'udinese', display: 'Udinese', aliases: [] },
  { id: 'sampdoria', display: 'Sampdoria', aliases: [] },
  { id: 'genoa', display: 'Genoa', aliases: [] },
  { id: 'parma', display: 'Parma', aliases: [] },
  { id: 'pescara', display: 'Pescara', aliases: [] },
  { id: 'feyenoord', display: 'Feyenoord', aliases: [] },
  { id: 'az alkmaar', display: 'AZ Alkmaar', aliases: ['az'] },
  { id: 'olympiacos', display: 'Olympiacos', aliases: [] },
  { id: 'panathinaikos', display: 'Panathinaikos', aliases: [] },
  { id: 'shakhtar donetsk', display: 'Shakhtar Donetsk', aliases: ['shakhtar'] },
  { id: 'dynamo kyiv', display: 'Dynamo Kyiv', aliases: [] },
  { id: 'celtic', display: 'Celtic', aliases: [] },
  { id: 'rangers', display: 'Rangers', aliases: [] },
  { id: 'anderlecht', display: 'Anderlecht', aliases: ['rsc anderlecht'] },
  { id: 'club brugge', display: 'Club Brugge', aliases: ['brugge'] },
  { id: 'al ittihad', display: 'Al Ittihad', aliases: [] },
  { id: 'al ahli', display: 'Al Ahli', aliases: [] },
  { id: 'al ain', display: 'Al Ain', aliases: [] },
  { id: 'palmeiras', display: 'Palmeiras', aliases: [] },
  { id: 'corinthians', display: 'Corinthians', aliases: [] },
  { id: 'sao paulo', display: 'Sao Paulo', aliases: [] },
  { id: 'gremio', display: 'Gremio', aliases: [] },
  { id: 'internacional', display: 'Internacional', aliases: [] },
  { id: 'penarol', display: 'Penarol', aliases: [] },
  { id: 'independiente', display: 'Independiente', aliases: [] },
  { id: 'crystal palace', display: 'Crystal Palace', aliases: [] },
  { id: 'bournemouth', display: 'Bournemouth', aliases: ['afc bournemouth'] },
  { id: 'sheffield united', display: 'Sheffield United', aliases: [] },
  { id: 'wolverhampton wanderers', display: 'Wolverhampton Wanderers', aliases: ['wolves'] },
  { id: 'southampton', display: 'Southampton', aliases: [] },
  { id: 'brighton', display: 'Brighton', aliases: ['brighton hove albion'] },
  { id: 'fulham', display: 'Fulham', aliases: [] },
  { id: 'brentford', display: 'Brentford', aliases: [] },
  { id: 'nottingham forest', display: 'Nottingham Forest', aliases: [] },
  { id: 'leeds united', display: 'Leeds United', aliases: ['leeds'] },
  { id: 'west bromwich albion', display: 'West Bromwich Albion', aliases: ['west brom'] },
  { id: 'al nassr', display: 'Al Nassr', aliases: [] },
  { id: 'al hilal', display: 'Al Hilal', aliases: [] },
  { id: 'inter miami', display: 'Inter Miami', aliases: [] },
  { id: 'la galaxy', display: 'LA Galaxy', aliases: ['los angeles galaxy'] },
  { id: 'boca juniors', display: 'Boca Juniors', aliases: ['boca'] },
  { id: 'river plate', display: 'River Plate', aliases: ['river'] },
  { id: 'flamengo', display: 'Flamengo', aliases: [] },
  { id: 'santos', display: 'Santos', aliases: [] },
  { id: 'west ham united', display: 'West Ham United', aliases: ['west ham'] },
  { id: 'newcastle united', display: 'Newcastle United', aliases: ['newcastle'] },
  { id: 'everton', display: 'Everton', aliases: [] },
  { id: 'leicester city', display: 'Leicester City', aliases: ['leicester'] },
  { id: 'aston villa', display: 'Aston Villa', aliases: ['villa'] },
];

// Turkish letters aren't decomposable by NFD accent-stripping (ş, ğ, ç, ö, ü, ı, İ
// are precomposed code points, not base+combining-mark pairs), so map them explicitly
// before the generic accent strip below.
const TURKISH_MAP = { ş: 's', ğ: 'g', ç: 'c', ö: 'o', ü: 'u', ı: 'i', İ: 'i' };

function normalize(str) {
  return String(str || '')
    .replace(/[şğçöüıİ]/g, (ch) => TURKISH_MAP[ch])
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^fc |^fk /, '')
    // Turn separators (hyphens, apostrophes, dots) into spaces before
    // stripping everything else — otherwise "Saint-Germain" collapses into
    // "saintgermain" and never matches someone typing "Saint Germain".
    .replace(/[-'.]/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ALIAS_TO_ID = new Map();
for (const team of TEAMS) {
  ALIAS_TO_ID.set(normalize(team.id), team.id);
  ALIAS_TO_ID.set(normalize(team.display), team.id);
  for (const alias of team.aliases) {
    ALIAS_TO_ID.set(normalize(alias), team.id);
  }
}

const ID_TO_DISPLAY = new Map(TEAMS.map((t) => [t.id, t.display]));

function resolveTeam(input) {
  const norm = normalize(input);
  if (!norm) return null;
  const id = ALIAS_TO_ID.get(norm);
  if (!id) return null;
  return { id, display: ID_TO_DISPLAY.get(id) };
}

module.exports = { TEAMS, normalize, resolveTeam };
