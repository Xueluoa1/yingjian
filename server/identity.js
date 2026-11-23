import { createHash } from 'node:crypto';

// Keep season/part numbers and edition names. Only discard punctuation, spacing
// and common technical/language suffixes that do not identify a different work.
export function searchTitle(value) {
  let title = String(value || '').normalize('NFKC').trim();
  const suffix = '(?:4k|1080p|720p|2160p|blu-?ray|bd|hd|高清|超清|蓝光|国语(?:版)?|粤语(?:版)?|普通话(?:版)?|中[英日韩]?字幕|中字|双语)(?:\\s*(?:版|中字|双语))?';
  const bracketed = new RegExp(`\\s*[（(\\[【]\\s*${suffix}\\s*[）)\\]】]\\s*$`, 'i');
  const separated = new RegExp(`(?:\\s*[-_·–—]\\s*|\\s+)${suffix}\\s*$`, 'i');
  let previous;
  do { previous = title; title = title.replace(bracketed, '').replace(separated, '').trim(); } while (title !== previous);
  return title;
}

export function normalizedTitle(value) { return searchTitle(value).toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, ''); }

export function groupKeyFor(item) {
  const title = normalizedTitle(item.title);
  const category = ['movie', 'series', 'anime', 'variety', 'short'].includes(item.category) ? item.category : '';
  const year = /^\d{4}$/.test(String(item.year || '').trim()) ? String(item.year).trim() : '';
  // Missing years/categories cannot safely distinguish remakes or film/series
  // adaptations. Preserve them separately instead of inventing metadata.
  const identity = title && category && year ? ['work', title, category, year]
    : ['source', String(item.sourceId || ''), String(item.id || ''), title, category, year];
  return `work_${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32)}`;
}

export function sameWork(a, b) { return groupKeyFor(a) === groupKeyFor(b); }

function variantOf(item) {
  const { variants: _variants, groupKey: _groupKey, ...variant } = item;
  return variant;
}

export function mergeCatalogItems(items) {
  const groups = new Map();
  for (const item of items) {
    for (const variant of item.variants?.length ? item.variants : [item]) {
      const groupKey = groupKeyFor(variant);
      if (!groups.has(groupKey)) groups.set(groupKey, new Map());
      const variants = groups.get(groupKey);
      const key = `${variant.sourceId}:${variant.id}`;
      const prior = variants.get(key);
      if (!prior || (Date.parse(variant.updatedAt) || 0) > (Date.parse(prior.updatedAt) || 0)) variants.set(key, variantOf(variant));
    }
  }
  return [...groups].map(([groupKey, candidates]) => {
    const variants = [...candidates.values()];
    const representative = variants[0];
    const timestamps = variants.map(item => Date.parse(item.updatedAt)).filter(Number.isFinite);
    const areas = [...new Set(variants.flatMap(item => item.areas || (item.area ? [item.area] : [])))];
    return { ...representative, groupKey, variants,
      poster: variants.find(item => item.poster)?.poster || '',
      areas, area: areas.join(' / '), genres: [...new Set(variants.flatMap(item => item.genres || []))],
      score: variants.find(item => Number.isFinite(item.score) && item.score > 0)?.score ?? null,
      updatedAt: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null };
  });
}
