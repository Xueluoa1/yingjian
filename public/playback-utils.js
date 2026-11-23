// Shared, DOM-free episode matching and seek rules for the phone and TV players.
function chineseNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = {'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
  if (![...value].every(char => char in digits || '十百千'.includes(char))) return null;
  if (![...value].some(char => '十百千'.includes(char))) return Number([...value].map(char => digits[char]).join(''));
  let total = 0, digit = 0;
  for (const char of value) {
    if (char in digits) digit = digits[char];
    else { total += (digit || 1) * ({十:10,百:100,千:1000}[char]); digit = 0; }
  }
  return total + digit;
}

export function episodeIdentity(name) {
  const text = String(name || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const normalized = text.replace(/[【】\[\]（）()._:：-]/g, '');
  // Dates and split episodes keep their identity: “第1集上” must not become “第1集”.
  const numbers = '[0-9零〇一二两三四五六七八九十百千]+';
  const seasonEpisode = normalized.match(new RegExp(`^(?:s(${numbers})e(${numbers})|第(${numbers})季第?(${numbers})[集期话])([上下中前后](?:集|部|篇|半场)?)?$`));
  if (seasonEpisode) return {exact:normalized, season:chineseNumber(seasonEpisode[1] || seasonEpisode[3]), number:chineseNumber(seasonEpisode[2] || seasonEpisode[4]), part:seasonEpisode[5] || ''};
  const numbered = normalized.match(new RegExp(`^(?:第)?(${numbers})(?:集|期|话|回)?([上下中前后](?:集|部|篇|半场)?)?$`)) || normalized.match(new RegExp(`^(?:ep?|episode)(${numbers})([上下中前后](?:集|部|篇|半场)?)?$`));
  if (numbered) return {exact:normalized, season:null, number:chineseNumber(numbered[1]), part:numbered[2] || ''};
  return {exact:normalized, season:null, number:null, part:''};
}

export function matchEpisode(name, lines, {preferredLine = '', movie = false, sourceEpisodeCount = 0} = {}) {
  const origin = episodeIdentity(name);
  const entries = (lines || []).flatMap((line, lineIndex) => (line.episodes || []).map((episode, episodeIndex) => ({line:lineIndex, episode:episodeIndex, name:episode.name, identity:episodeIdentity(episode.name), preferred:line.name === preferredLine})));
  const exact = entries.filter(entry => origin.exact && entry.identity.exact === origin.exact);
  const equivalent = entries.filter(entry => origin.number !== null && entry.identity.number === origin.number && entry.identity.part === origin.part && (entry.identity.season === origin.season || (origin.season === null && entry.identity.season === 1) || (origin.season === 1 && entry.identity.season === null)));
  const candidates = exact.length ? exact : equivalent;
  if (candidates.length) return candidates.find(entry => entry.preferred) || candidates[0];
  // Only a movie with one episode on both sides can use a differently named full-length version.
  // A source sometimes exposes just a trailer or commentary; do not silently substitute it.
  const extra = /预告|花絮|特辑|彩蛋|解说|幕后|访谈|采访|片段|删减片段|trailer|teaser|featurette|behind.?the.?scenes|interview|commentary|\bclip\b/i;
  if (movie && sourceEpisodeCount === 1 && !extra.test(name)) {
    const single = entries.filter(entry => lines[entry.line].episodes.length === 1 && !extra.test(entry.name));
    if (single.length) return single.find(entry => entry.preferred) || single[0];
  }
  return null;
}

export function seekTarget(position, duration, ranges) {
  if (!Number.isFinite(position) || position <= 0) return 0;
  if (!Number.isFinite(duration) || duration <= 0 || !ranges?.length) return null;
  const desired = Math.min(position, Math.max(0, duration - 0.25));
  for (let index = 0; index < ranges.length; index++) {
    const start = ranges.start(index), end = ranges.end(index);
    if (desired >= start && desired <= end) return Math.min(desired, Math.max(start, end - 0.05));
  }
  // A partially buffered seekable range does not mean the episode is shorter.
  return null;
}
