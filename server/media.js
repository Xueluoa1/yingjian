import { createHash } from 'node:crypto';
import { safeRequest, readLimited, httpURL } from './network.js';

export function cleanText(value, maximum = 800) {
  return String(value ?? '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim().slice(0, maximum);
}

export function safeMediaURL(value, base) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try { return httpURL(new URL(String(value).trim(), base).href).href; } catch { return ''; }
}

export function categoryName(value) {
  const name = cleanText(value, 100).toLowerCase();
  if (/短剧|微短剧|短\s*剧|short[ -]?drama/.test(name)) return 'short';
  if (/动漫|动画|卡通|anime|animation/.test(name)) return 'anime';
  if (/综艺|真人秀|脱口秀|晚会|variety/.test(name)) return 'variety';
  if (/电视剧|连续剧|剧集|series|drama series/.test(name)
    || /^(国产|内地|大陆|中国|欧美|美国|英国|日韩|日本|韩国|香港|台湾|港澳|港台|泰国|新加坡|马来西亚|新马|马泰|海外|日|韩|港|台|泰)剧$/.test(name)) return 'series';
  if (/电影|片$|movie|film/.test(name)) return 'movie';
  return null;
}

export function categoryIndex(classes = []) {
  const index = new Map();
  function add(entries, parent = '', depth = 0) {
    if (depth > 20 || index.size >= 2000) return;
    for (const entry of entries.slice(0, 500)) {
      if (!entry || typeof entry !== 'object') continue;
      const id = String(entry.type_id ?? entry.id ?? '');
      if (!id) continue;
      index.set(id, { id, name: cleanText(entry.type_name ?? entry.name, 100), parent: String(entry.type_pid ?? entry.parent_id ?? entry.pid ?? parent) });
      const children = entry.children ?? entry.child;
      if (Array.isArray(children) && parent !== id) add(children, id, depth + 1);
    }
  }
  add(Array.isArray(classes) ? classes : []);
  return index;
}

export function classifyItem(raw, index = new Map()) {
  const chain = []; const seen = new Set();
  let node = index.get(String(raw.type_id ?? ''));
  while (node && !seen.has(node.id)) { seen.add(node.id); chain.unshift(node); node = index.get(node.parent); }
  const root = index.get(String(raw.type_id_1 ?? raw.type_1_id ?? ''));
  // Some feeds place short dramas under a broad TV parent, or only identify
  // them in vod_class. Never infer this category from the programme title.
  if ([root?.name, ...chain.map(entry => entry.name), raw.type_1_name, raw.type_name, raw.vod_class]
    .some(value => categoryName(value) === 'short')) return 'short';
  return (root && categoryName(root.name)) || chain.map(entry => categoryName(entry.name)).find(Boolean)
    || categoryName(raw.type_1_name) || categoryName(raw.type_name) || null;
}

export function categoryTarget(index, category) {
  // Only send t when one unambiguous ancestor covers this category. Otherwise
  // filtering the general feed is safer than silently omitting sibling classes.
  const matching = [...index.values()].filter(node => categoryName(node.name) === category);
  const roots = matching.filter(node => {
    const seen = new Set([node.id]); let parent = index.get(node.parent);
    while (parent && !seen.has(parent.id)) {
      if (categoryName(parent.name) === category) return false;
      seen.add(parent.id); parent = index.get(parent.parent);
    }
    return true;
  });
  return roots.length === 1 ? roots[0].id : null;
}

export function normalizeArea(value) {
  const area = cleanText(value, 60);
  return ({ '大陆': '中国大陆', '内地': '中国大陆', '中国内地': '中国大陆', '香港': '中国香港', '台湾': '中国台湾', '澳门': '中国澳门' })[area] || area;
}

function splitMetadata(value, normalize = value => value) {
  return [...new Set(cleanText(value, 300).split(/[,，、/|;；]+/).map(value => normalize(value.trim())).filter(Boolean))].slice(0, 12);
}

function scoreValue(raw) {
  for (const value of [raw.vod_douban_score, raw.vod_score]) {
    const score = Number(value);
    if (Number.isFinite(score) && score > 0 && score <= 10) return Math.round(score * 10) / 10;
  }
  return null;
}

export function updateTime(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  let timestamp;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    if (numeric < 100000000) return null;
    timestamp = numeric < 100000000000 ? numeric * 1000 : numeric;
  } else if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T].*)?$/.test(text)) {
    let date = text.replace(/\//g, '-').replace(' ', 'T');
    date = date.replace(/^(\d{4})-(\d{1,2})-(\d{1,2})/, (_all, year, month, day) => `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
    if (!date.includes('T')) date += 'T00:00:00';
    if (!/(?:Z|[+-]\d\d:?\d\d)$/i.test(date)) date += '+08:00';
    timestamp = Date.parse(date);
  }
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 253402300799999 ? new Date(timestamp).toISOString() : null;
}

export function itemUpdateTime(raw) {
  // Blank/zero vod_time is common. Nullish coalescing silently discarded the
  // usable timestamp/add-time fields and made “最近更新” appear ineffective.
  return [raw.vod_time, raw.vod_time_stamp, raw.vod_time_add].map(updateTime).find(Boolean) || null;
}

export function createMedia({ allowPrivate, imageURL }) {
  const classes = new Map();
  const sourceKey = source => `${source.id}:${source.url}`;
  async function fetchText(url, maximum, options = {}) {
    const timeout = AbortSignal.timeout(options.timeoutMs || 18000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await safeRequest(url, { allowPrivate, signal });
    if (response.statusCode < 200 || response.statusCode >= 300) { response.body.destroy(); await response.cleanup(); throw new Error(`片源返回 HTTP ${response.statusCode}`); }
    return { text: await readLimited(response, maximum), url: response.url };
  }
  async function vod(source, parameters = {}, options = {}) {
    const url = httpURL(source.url);
    url.searchParams.set('ac', 'detail');
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
    const result = await fetchText(url.href, 8 * 1024 * 1024, options);
    let payload;
    try { payload = JSON.parse(result.text.replace(/^\uFEFF/, '')); } catch { throw new Error('该接口没有返回有效 JSON，请使用苹果 CMS JSON 采集接口'); }
    if (!Array.isArray(payload.list)) throw new Error('接口不包含影片列表，不是兼容的苹果 CMS 数据源');
    if (Array.isArray(payload.class) && payload.class.length) {
      if (classes.size > 100) classes.clear();
      classes.set(sourceKey(source), { index: categoryIndex(payload.class), expires: Date.now() + 10 * 60000 });
    }
    return payload;
  }
  async function taxonomy(source, options = {}) {
    const key = sourceKey(source); const cached = classes.get(key);
    if (cached?.expires > Date.now()) return cached.index;
    const payload = await vod(source, { ac: 'list', pg: 1 }, options);
    const index = categoryIndex(payload.class);
    classes.set(key, { index, expires: Date.now() + 10 * 60000 });
    return index;
  }
  function item(raw, source) {
    const poster = safeMediaURL(raw.vod_pic || '', source.url);
    const areas = splitMetadata(raw.vod_area, normalizeArea);
    return { id: String(raw.vod_id ?? '').slice(0, 180), sourceId: source.id, sourceName: source.name,
      title: cleanText(raw.vod_name, 160), poster: poster && imageURL(poster), type: cleanText(raw.type_name, 80),
      category: classifyItem(raw, classes.get(sourceKey(source))?.index), year: cleanText(raw.vod_year, 20),
      area: areas.join(' / '), areas, genres: splitMetadata(raw.vod_class), score: scoreValue(raw), updatedAt: itemUpdateTime(raw),
      remarks: cleanText(raw.vod_remarks, 100), description: cleanText(raw.vod_content, 1600),
    };
  }
  async function detail(source, id) {
    const payload = await vod(source, { ids: id });
    const raw = payload.list.find(value => String(value.vod_id) === String(id));
    if (!raw) throw new Error('该影片已不存在于片源中');
    const groups = String(raw.vod_play_url || '').split('$$$');
    const names = String(raw.vod_play_from || '').split('$$$');
    const lines = groups.slice(0, 30).map((group, index) => ({
      name: cleanText(names[index] || `线路 ${index + 1}`, 80),
      episodes: group.split('#').slice(0, 3000).map((entry, number) => {
        const separator = entry.indexOf('$');
        const name = separator >= 0 ? entry.slice(0, separator) : `第 ${number + 1} 集`;
        const url = safeMediaURL(separator >= 0 ? entry.slice(separator + 1) : entry, source.url);
        return { name: cleanText(name, 100), url };
      }).filter(episode => episode.url),
    })).filter(line => line.episodes.length);
    return { item: item(raw, source), lines };
  }
  async function live(source) {
    const result = await fetchText(source.url, 8 * 1024 * 1024);
    if (!/^\s*#EXTM3U/i.test(result.text)) throw new Error('该地址不是有效的 M3U 播放列表');
    const channels = [];
    let metadata = null;
    for (const line of result.text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const text = line.trim();
      if (text.startsWith('#EXTINF:')) {
        const name = text.match(/,(.*)$/)?.[1] || '未命名频道';
        const attribute = key => text.match(new RegExp(`${key}="([^"]*)"`, 'i'))?.[1] || '';
        const logo = safeMediaURL(attribute('tvg-logo'), result.url);
        metadata = { name: cleanText(name, 140), group: cleanText(attribute('group-title'), 80), logo: logo && imageURL(logo) };
      } else if (text && !text.startsWith('#')) {
        const url = safeMediaURL(text, result.url);
        if (url && metadata) channels.push({ ...metadata, id: createHash('sha256').update(url).digest('hex').slice(0, 20), sourceId: source.id, url });
        metadata = null;
        if (channels.length >= 5000) break;
      }
    }
    return channels;
  }
  return { vod, item, detail, live, taxonomy };
}

export function rewritePlaylist(text, base, proxyURL) {
  return text.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (!trimmed.startsWith('#')) {
      const url = safeMediaURL(trimmed, base);
      if (!url) throw new Error('播放列表含不支持的媒体地址');
      return proxyURL(url);
    }
    return line.replace(/URI="([^"]+)"/g, (_match, value) => {
      if (value.startsWith('data:')) return `URI="${value}"`;
      const url = safeMediaURL(value, base);
      if (!url) throw new Error('播放列表含不支持的资源地址');
      return `URI="${proxyURL(url)}"`;
    });
  }).join('\n');
}
