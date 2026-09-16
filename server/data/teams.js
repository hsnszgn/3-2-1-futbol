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
  { id: 'paris saint-germain', display: 'Paris Saint-Germain', aliases: ['psg', 'paris sg'] },
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

function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^fc |^fk /, '')
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
