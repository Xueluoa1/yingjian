import { categoryTarget, cleanText, normalizeArea } from './media.js';
import { networkError } from './network.js';
import { mergeCatalogItems } from './identity.js';

const CATEGORIES = new Set(['all', 'movie', 'series', 'anime', 'variety', 'short']);
const positiveInteger = (value, fallback, maximum) => Math.max(1, Math.min(maximum, Math.floor(Number(value) || fallback)));

export function catalogQuery(input = {}) {
  const category = String(input.category || 'all');
  const sort = String(input.sort || 'updated');
  if (!CATEGORIES.has(category)) throw Object.assign(new Error('影片分类不正确'), { status: 400 });
  if (!['updated', 'score'].includes(sort)) throw Object.assign(new Error('排序方式不正确'), { status: 400 });
  return { category, sort, year: cleanText(input.year, 20), area: normalizeArea(input.area), genre: cleanText(input.genre, 60),
    q: cleanText(input.q, 100), page: positiveInteger(input.page, 1, 10000), pageSize: positiveInteger(input.pageSize, 24, 60),
    expand: input.loadMore === '1' || input.expand === '1', refresh: input.refresh === '1', snapshot: cleanText(input.snapshot, 100) };
}

function facets(items) {
  const unique = (values, compare) => [...new Set(values.filter(Boolean))].sort(compare);
  return {
    years: unique(items.map(item => item.year), (a, b) => b.localeCompare(a, 'zh-CN', { numeric: true })),
    areas: unique(items.flatMap(item => item.areas || (item.area ? [item.area] : [])), (a, b) => a.localeCompare(b, 'zh-CN')),
    genres: unique(items.flatMap(item => item.genres || []), (a, b) => a.localeCompare(b, 'zh-CN')),
  };
}

export function filterCatalog(items, query) {
  const categorized = items.filter(item => query.category === 'all' || item.category === query.category);
  const selected = categorized.filter(item => (!query.year || item.year === query.year)
    && (!query.area || (item.areas || [item.area]).includes(query.area))
    && (!query.genre || (item.genres || []).includes(query.genre)));
  const updated = item => Date.parse(item.updatedAt) || 0;
  selected.sort((a, b) => {
    if (query.sort === 'score') {
      const byScore = (b.score ?? -1) - (a.score ?? -1);
      if (byScore) return byScore;
    }
    return updated(b) - updated(a) || `${a.sourceId}:${a.id}`.localeCompare(`${b.sourceId}:${b.id}`, 'zh-CN', { numeric: true });
  });
  const total = selected.length; const pageCount = Math.ceil(total / query.pageSize);
  const page = Math.min(query.page, pageCount || 1);
  return { items: selected.slice((page - 1) * query.pageSize, page * query.pageSize), total, page, pageCount,
    pageSize: query.pageSize, hasMore: page < pageCount, facets: facets(categorized) };
}

// This is a bounded, in-memory browsing snapshot, not an index of the entire
// upstream catalogue. Switching facets never silently crawls more source pages.
export function createCatalog(media, options = {}) {
  const ttlMs = options.ttlMs ?? 10 * 60000;
  const timeoutMs = options.timeoutMs ?? 6000;
  const roundTimeoutMs = options.roundTimeoutMs ?? 14000;
  const maxPages = options.maxPagesPerSource ?? 5;
  const concurrency = options.concurrency ?? 6;
  const snapshots = new Map();
  let active = 0; const queue = [];
  async function limited(work, signal) {
    if (active >= concurrency) await new Promise(resolve => queue.push(resolve));
    active += 1;
    try { signal.throwIfAborted(); return await work(); }
    finally { active -= 1; queue.shift()?.(); }
  }

  function cacheKey(sources, query) {
    return JSON.stringify([query.q, query.category, sources.map(({ id, name, url }) => [id, name, url]).sort((a, b) => a[0].localeCompare(b[0]))]);
  }
  function makeSnapshot(sources) {
    return { created: Date.now(), updated: Date.now(), revision: 0, initialized: false, pending: null,
      sources: sources.map(source => ({ source: { ...source }, items: new Map(), nextPage: 1, done: false, failed: null, target: undefined, completeMetadata: true, pageCount: null })) };
  }
  async function expand(snapshot, query) {
    if (snapshot.pending) return snapshot.pending;
    snapshot.pending = (async () => {
      const signal = AbortSignal.timeout(roundTimeoutMs);
      await Promise.all(snapshot.sources.filter(cursor => !cursor.done && cursor.nextPage <= maxPages).map(async cursor => {
        try {
          await limited(async () => {
            const { source } = cursor;
            if (query.category !== 'all' && cursor.target === undefined) {
              try { cursor.target = categoryTarget(await media.taxonomy(source, { timeoutMs: Math.min(timeoutMs, 4000), signal }), query.category); }
              catch { cursor.target = null; }
            }
            signal.throwIfAborted();
            const parameters = { pg: cursor.nextPage, ...(query.q ? { wd: query.q } : {}), ...(cursor.target ? { t: cursor.target } : {}) };
            const payload = await media.vod(source, parameters, { timeoutMs, signal });
            const list = payload.list.slice(0, 100);
            for (const raw of list) {
              const item = media.item(raw, source);
              if (item.id) cursor.items.set(item.id, item);
            }
            const count = Number(payload.pagecount);
            cursor.pageCount = Number.isInteger(count) && count > 0 ? count : null;
            cursor.completeMetadata &&= payload.list.length <= 100;
            cursor.done = payload.list.length === 0 || (cursor.pageCount !== null && cursor.nextPage >= cursor.pageCount);
            cursor.nextPage += 1;
            cursor.failed = null;
          }, signal);
        } catch (error) { cursor.failed = { sourceId: cursor.source.id, name: cursor.source.name, error: networkError(error) }; }
      }));
      snapshot.initialized = true;
      snapshot.updated = Date.now();
      snapshot.revision += 1;
    })();
    try { await snapshot.pending; } finally { snapshot.pending = null; }
  }

  async function browse(sources, input = {}) {
    const query = catalogQuery(input);
    const available = sources.filter(source => source.enabled && source.type === 'vod');
    const key = cacheKey(available, query);
    let snapshot = snapshots.get(key);
    if (!snapshot || snapshot.created + ttlMs <= Date.now() || (query.refresh && !snapshot.pending)) {
      for (const [oldKey, value] of snapshots) if (value.created + ttlMs <= Date.now() && !value.pending) snapshots.delete(oldKey);
      if (snapshots.size >= 12) {
        const removable = [...snapshots].find(([, value]) => !value.pending);
        if (removable) snapshots.delete(removable[0]);
        else throw Object.assign(new Error('正在加载的分类较多，请稍后重试'), { status: 429 });
      }
      snapshot = makeSnapshot(available); snapshots.set(key, snapshot);
    }
    // An optional revision makes retrying an expansion idempotent. A concurrent
    // request joins the in-flight round instead of advancing a second page.
    if (!snapshot.initialized || (query.expand && (!query.snapshot || query.snapshot === String(snapshot.revision)))) await expand(snapshot, query);
    else if (snapshot.pending) await snapshot.pending;
    const rawItems = snapshot.sources.flatMap(cursor => [...cursor.items.values()]);
    const items = rawItems;
    const failures = snapshot.sources.flatMap(cursor => cursor.failed ? [cursor.failed] : []);
    const limitedScope = snapshot.sources.some(cursor => !cursor.completeMetadata || (!cursor.done && cursor.nextPage > maxPages));
    const complete = !failures.length && !limitedScope && snapshot.sources.every(cursor => cursor.done);
    return { ...filterCatalog(items, query), failures, snapshot: String(snapshot.revision),
      canLoadMore: snapshot.sources.some(cursor => !cursor.done && cursor.nextPage <= maxPages),
      scope: { kind: 'loaded', loadedCount: items.length, rawLoadedCount: rawItems.length, sourceCount: available.length,
        successfulSources: snapshot.sources.filter(cursor => cursor.items.size || cursor.done).length,
        complete, limited: limitedScope, maxPagesPerSource: maxPages, updatedAt: new Date(snapshot.updated).toISOString(),
        expiresAt: new Date(snapshot.created + ttlMs).toISOString() } };
  }
  function variants(groupKey, sources) {
    const enabled = sources && new Map(sources.filter(source => source.enabled && source.type === 'vod').map(source => [source.id, source.url]));
    const items = [...snapshots.values()].filter(snapshot => snapshot.created + ttlMs > Date.now()).flatMap(snapshot => snapshot.sources
      .filter(cursor => !enabled || enabled.get(cursor.source.id) === cursor.source.url).flatMap(cursor => [...cursor.items.values()]));
    return mergeCatalogItems(items).find(item => item.groupKey === groupKey)?.variants || [];
  }
  return { browse, variants };
}
