import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createMedia, categoryIndex, classifyItem, categoryTarget, updateTime, itemUpdateTime } from '../server/media.js';
import { createCatalog, catalogQuery, filterCatalog } from '../server/catalog.js';
import { groupKeyFor, normalizedTitle, searchTitle, mergeCatalogItems, sameWork } from '../server/identity.js';

test('category hierarchies normalize arbitrary source IDs and parents without fabricated metadata', async t => {
  const trees = {
    a: [{ type_id: 12, type_name: '电视剧' }, { type_id: 99, type_pid: 12, type_name: '剧情' }],
    b: [{ type_id: 'film', type_name: '电影', children: [{ type_id: 'crime', type_name: '悬疑' }] }],
  };
  assert.equal(classifyItem({ type_id: 99, type_name: '剧情' }, categoryIndex(trees.a)), 'series');
  assert.equal(classifyItem({ type_id: 'crime' }, categoryIndex(trees.b)), 'movie');
  assert.equal(categoryTarget(categoryIndex(trees.a), 'series'), '12');
  assert.equal(categoryTarget(categoryIndex([{ type_id: 1, type_name: '国产动漫' }, { type_id: 2, type_name: '日韩动漫' }]), 'anime'), null);
  const flatNames = ['台湾剧', '日本剧', '韩国剧', '泰国剧', '港澳剧', '香港剧', '新加坡剧', '日剧', '韩剧', '港台剧'];
  const flat = categoryIndex(flatNames.map((type_name, type_id) => ({ type_name, type_id })));
  flatNames.forEach((_name, type_id) => assert.equal(classifyItem({ type_id }, flat), 'series'));
  assert.equal(classifyItem({ type_name: '舞台剧' }), null);
  assert.equal(classifyItem({ type_name: '戏剧' }), null);
  const server = createServer((_req, res) => res.end(JSON.stringify({ class: trees.a, list: [{ vod_id: 1 }] })));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const source = { id: 'a', name: 'A', url: `http://127.0.0.1:${server.address().port}/api` };
  const media = createMedia({ allowPrivate: true, imageURL: value => value });
  await media.vod(source);
  const item = media.item({ vod_id: 8, vod_name: '剧集', type_id: 99, type_name: '剧情', vod_area: '大陆,香港', vod_class: '剧情/悬疑', vod_douban_score: '8.4', vod_score: '2', vod_time: '2026-11-13 12:30:00' }, source);
  assert.equal(item.category, 'series');
  assert.deepEqual(item.areas, ['中国大陆', '中国香港']);
  assert.deepEqual(item.genres, ['剧情', '悬疑']);
  assert.equal(item.score, 8.4);
  assert.equal(item.updatedAt, '2026-11-13T04:30:00.000Z');
  const missing = media.item({ vod_id: 9, vod_score: 0, vod_time: 'unknown', type_name: '其他' }, source);
  assert.equal(missing.score, null);
  assert.equal(missing.updatedAt, null);
  assert.equal(missing.category, null);
  assert.deepEqual(missing.genres, []);
});

const items = [
  { id: '1', sourceId: 'a', title: '较早高分电影', category: 'movie', year: '2025', area: '中国大陆', areas: ['中国大陆'], genres: ['悬疑', '剧情'], score: 9, updatedAt: '2026-10-01T00:00:00Z' },
  { id: '2', sourceId: 'b', title: '较新低分电影', category: 'movie', year: '2026', area: '中国大陆', areas: ['中国大陆'], genres: ['剧情'], score: 6, updatedAt: '2026-11-01T00:00:00Z' },
  { id: '3', sourceId: 'a', title: '最新未知评分', category: 'movie', year: '2025', area: '中国大陆', areas: ['中国大陆'], genres: ['悬疑'], score: null, updatedAt: '2026-11-13T00:00:00Z' },
  { id: '4', sourceId: 'b', title: '同年海外剧', category: 'series', year: '2025', area: '日本', areas: ['日本'], genres: ['悬疑'], score: 10, updatedAt: '2026-11-12T00:00:00Z' },
];

test('facets intersect across category year area genre; unrated titles sort after rated titles', () => {
  const query = catalogQuery({ category: 'movie', year: '2025', area: '大陆', genre: '悬疑', sort: 'score' });
  const result = filterCatalog(items, query);
  assert.deepEqual(result.items.map(item => item.id), ['1', '3']);
  assert.equal(result.total, 2);
  assert.deepEqual(result.facets.years, ['2026', '2025']);
  assert.deepEqual(result.facets.areas, ['中国大陆']);
  assert.deepEqual(filterCatalog(items, catalogQuery({ category: 'movie', sort: 'updated' })).items.map(item => item.id), ['3', '2', '1']);
  assert.equal(filterCatalog(items, catalogQuery({ category: 'movie', year: '1900' })).total, 0);
  assert.throws(() => catalogQuery({ category: 'unknown' }), /分类/);
});

function mockMedia() {
  const calls = [];
  return { calls,
    async taxonomy(source) { calls.push([source.id, 'taxonomy']); return categoryIndex([{ type_id: 800, type_name: '电影' }]); },
    async vod(source, parameters) {
      calls.push([source.id, { ...parameters }]);
      if (source.id === 'broken') throw new Error('测试片源故障');
      const page = Number(parameters.pg);
      return { pagecount: 3, list: page === 1 ? items.filter(item => item.sourceId === source.id) : [{ ...items[0], sourceId: source.id, id: `${source.id}-${page}`, title: `新增影片 ${source.id} ${page}` }] };
    },
    item(raw, source) { return { ...raw, sourceName: source.name }; },
  };
}
const sources = ['a', 'b', 'broken'].map(id => ({ id, name: id, type: 'vod', url: `https://${id}.example/api`, enabled: true }));

test('aggregation isolates failures and caches pagination/filter requests; explicit expansion and source changes invalidate correctly', async () => {
  const media = mockMedia(); const catalog = createCatalog(media);
  const first = await catalog.browse(sources, { pageSize: '2', sort: 'score' });
  assert.equal(first.total, 4);
  assert.equal(first.items.length, 2);
  assert.equal(first.pageCount, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.failures.length, 1);
  assert.equal(first.scope.kind, 'loaded');
  assert.equal(first.scope.complete, false);
  assert.equal(first.scope.successfulSources, 2);
  assert.equal(first.canLoadMore, true);
  const initialCalls = media.calls.length;
  const second = await catalog.browse(sources, { pageSize: '2', page: '2', sort: 'score' });
  assert.equal(second.items.length, 2);
  assert.equal(second.hasMore, false);
  await catalog.browse(sources, { year: '2025', genre: '悬疑' });
  assert.equal(media.calls.length, initialCalls, 'ordinary pagination and filtering must not re-fetch');
  const expanded = await catalog.browse(sources, { loadMore: '1', snapshot: first.snapshot });
  assert.equal(expanded.total, 6);
  assert.equal(expanded.snapshot, '2');
  const expandedCalls = media.calls.length;
  await catalog.browse(sources, { loadMore: '1', snapshot: first.snapshot });
  assert.equal(media.calls.length, expandedCalls, 'repeated expansion revision must be idempotent');
  const disabled = sources.map(source => ({ ...source, enabled: source.id !== 'a' }));
  const changed = await catalog.browse(disabled);
  assert.equal(changed.items.some(item => item.sourceId === 'a'), false);
});

test('category/search fetches use mapped type and keyword, coalesce concurrent requests and enforce crawl cap', async () => {
  const media = mockMedia(); const catalog = createCatalog(media, { maxPagesPerSource: 2 });
  const query = { category: 'movie', q: '测试' };
  const [first, same] = await Promise.all([catalog.browse(sources.slice(0, 2), query), catalog.browse(sources.slice(0, 2), query)]);
  assert.equal(first.total, same.total);
  assert.equal(media.calls.filter(([, value]) => value !== 'taxonomy').length, 2);
  for (const [, value] of media.calls.filter(([, value]) => value !== 'taxonomy')) assert.deepEqual(value, { pg: 1, wd: '测试', t: '800' });
  const expanded = await catalog.browse(sources.slice(0, 2), { ...query, loadMore: '1', snapshot: first.snapshot });
  assert.equal(expanded.canLoadMore, false);
  assert.equal(expanded.scope.complete, false);
  assert.equal(expanded.scope.limited, true);
  const count = media.calls.length;
  await catalog.browse(sources.slice(0, 2), { ...query, loadMore: '1' });
  assert.equal(media.calls.length, count);
});

test('partial page without pagination metadata never claims the full upstream library', async () => {
  const media = { item: value => value, vod: async () => ({ list: items }) };
  const catalog = createCatalog(media, { maxPagesPerSource: 1 });
  const result = await catalog.browse(sources.slice(0, 1));
  assert.equal(result.scope.complete, false);
  assert.equal(result.scope.limited, true);
  assert.equal(result.total, 4);
});

test('a stalled source respects the round deadline while queued sources return explicit failures', async () => {
  let requests = 0;
  const media = { item: value => value, vod: async (_source, _parameters, { signal }) => {
    requests += 1;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 500);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    return { list: items, pagecount: 1 };
  } };
  const catalog = createCatalog(media, { concurrency: 1, roundTimeoutMs: 25 });
  const result = await catalog.browse(sources);
  assert.equal(requests, 1);
  assert.equal(result.failures.length, 3);
  assert.equal(result.items.length, 0);
  assert.equal(result.scope.complete, false);
  assert.equal(result.canLoadMore, true);
});

test('work identity merges source copies and format suffixes but retains seasons, years, and categories', () => {
  const base = { ...items[0], title: '  长夜·未央 第一季 ', id: 'show-a', category: 'series', year: '2025' };
  const copy = { ...base, sourceId: 'b', id: 'show-b', title: '长夜 未央 第一季（1080P）' };
  assert.equal(normalizedTitle(copy.title), normalizedTitle(base.title));
  assert.equal(sameWork(base, copy), true);
  assert.equal(sameWork(base, { ...copy, title: '长夜未央 第二季' }), false);
  assert.equal(sameWork(base, { ...copy, title: '长夜未央 第一季 导演剪辑版' }), false);
  assert.equal(sameWork(base, { ...copy, year: '2026' }), false);
  assert.equal(sameWork(base, { ...copy, category: 'movie' }), false);
  assert.equal(sameWork({ ...base, year: '' }, { ...copy, year: '' }), false);
  assert.equal(sameWork({ ...base, category: null }, { ...copy, category: null }), false);
  assert.equal(sameWork({ ...base, title: 'A Story - HD' }, { ...copy, title: 'A Story' }), true);
  assert.equal(sameWork({ ...base, title: 'A Story [粤语版]' }, { ...copy, title: 'A Story' }), true);
  assert.equal(mergeCatalogItems([base, copy, { ...copy, year: '2026' }]).length, 2);
  assert.match(groupKeyFor(base), /^work_[a-f0-9]{32}$/);
});

test('alternative-source search strips technical suffixes while retaining natural title words and season labels', () => {
  assert.equal(searchTitle(' The Long Night: Season 2 (1080P) '), 'The Long Night: Season 2');
  assert.equal(searchTitle('长夜·未央 第二季（国语）'), '长夜·未央 第二季');
  assert.equal(searchTitle('The Long Night HD'), 'The Long Night');
  assert.equal(searchTitle('The Long Night - HD'), 'The Long Night');
  assert.equal(searchTitle('长夜未央 第一季 导演剪辑版'), '长夜未央 第一季 导演剪辑版');
  assert.equal(searchTitle('The Long Night (Season 1)'), 'The Long Night (Season 1)');
});

test('source copies remain independent through facets, ordering, and pagination', () => {
  const duplicate = { ...items[0], id: 'same-on-b', sourceId: 'b', title: ` ${items[0].title}（高清）`,
    genres: ['悬疑', '犯罪'], updatedAt: '2026-11-14T00:00:00Z' };
  const catalogItems = [items[0], duplicate, ...items.slice(1)];
  const first = filterCatalog(catalogItems, catalogQuery({ category: 'movie', pageSize: 2, sort: 'updated' }));
  const second = filterCatalog(catalogItems, catalogQuery({ category: 'movie', pageSize: 2, page: 2, sort: 'updated' }));
  assert.equal(first.total, 4);
  assert.equal(first.pageCount, 2);
  assert.deepEqual(first.items.map(item => item.id), ['same-on-b', '3']);
  assert.deepEqual(second.items.map(item => item.id), ['2', '1']);
  assert.equal(new Set([...first.items, ...second.items].map(item => `${item.sourceId}:${item.id}`)).size, 4);
  assert.equal(first.items[0].updatedAt, duplicate.updatedAt);
  assert.equal(second.items[1].updatedAt, items[0].updatedAt);
  assert.equal(first.items[0].variants, undefined);
  assert.equal(first.facets.genres.includes('犯罪'), true);
  const filtered = filterCatalog(catalogItems, catalogQuery({ category: 'movie', genre: '犯罪' }));
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].sourceId, 'b', 'genre matching must use each source\'s own metadata');
});

test('short dramas use explicit type, genre, or ancestors and stay out of the series category', () => {
  const index = categoryIndex([{ type_id: 1, type_name: '电视剧', children: [
    { type_id: 2, type_name: '短剧', children: [{ type_id: 3, type_name: '现代言情' }] },
    { type_id: 4, type_name: '国产剧' },
  ] }]);
  assert.equal(classifyItem({ type_id: 3, type_id_1: 1 }, index), 'short');
  assert.equal(classifyItem({ type_id: 4, vod_class: '剧情,微短剧' }, index), 'short');
  assert.equal(classifyItem({ type_name: '短剧', vod_name: '任意名称' }), 'short');
  assert.equal(classifyItem({ type_name: '国产剧', vod_name: '短剧演员的故事' }), 'series');
  assert.equal(classifyItem({ type_name: '未知', vod_name: '短剧全集' }), null);
  assert.equal(categoryTarget(index, 'short'), '2');
  assert.equal(categoryTarget(index, 'series'), '1');
  const categorized = [{ ...items[0], category: 'short' }, { ...items[1], category: 'series' }];
  assert.deepEqual(filterCatalog(categorized, catalogQuery({ category: 'short' })).items.map(item => item.id), ['1']);
  assert.deepEqual(filterCatalog(categorized, catalogQuery({ category: 'series' })).items.map(item => item.id), ['2']);
});

test('update timestamps fall back through blank, zero, malformed, seconds and milliseconds without using fetch time', () => {
  const expected = '2026-11-13T04:30:00.000Z';
  const milliseconds = Date.parse(expected);
  for (const value of ['2026-11-13 12:30:00', '2026-11-13T12:30:00', '2026/11/13 12:30:00',
    '2026-11-13T04:30:00Z', '2026-11-13T12:30:00+08:00', milliseconds / 1000, String(milliseconds)]) {
    assert.equal(updateTime(value), expected, String(value));
  }
  for (const vod_time of ['', ' ', 0, '0', null, 'unknown', '0000-00-00 00:00:00']) {
    assert.equal(itemUpdateTime({ vod_time, vod_time_stamp: milliseconds / 1000, vod_time_add: '2020-01-01 00:00:00' }), expected);
    assert.equal(itemUpdateTime({ vod_time, vod_time_stamp: 0, vod_time_add: '2026-11-13 12:30:00' }), expected);
  }
  assert.equal(itemUpdateTime({ vod_time: '2026-11-13 12:30:00', vod_time_stamp: 1, vod_time_add: '2020-01-01 00:00:00' }), expected);
  assert.equal(itemUpdateTime({ vod_time: '', vod_time_stamp: 0, vod_time_add: '' }), null);
  assert.equal(updateTime('2026'), null);
  const media = createMedia({ allowPrivate: true, imageURL: value => value });
  const source = sources[0];
  const fresh = media.item({ vod_id: 31, vod_name: '有时间戳', vod_year: 2026, type_name: '电影', vod_time: '', vod_time_stamp: milliseconds }, source);
  const older = media.item({ vod_id: 32, vod_name: '旧电影', vod_year: 2026, type_name: '电影', vod_time: 0, vod_time_add: '2026-11-12 12:30:00' }, source);
  const unknown = media.item({ vod_id: 33, vod_name: '未知时间', vod_year: 2026, type_name: '电影', vod_time: '0' }, source);
  assert.deepEqual(filterCatalog([unknown, older, fresh], catalogQuery({ sort: 'updated' })).items.map(item => item.id), ['31', '32', '33']);
});

test('explicit refresh fetches the latest source page and cached group variants honor enabled source URLs', async () => {
  let generation = 0; const calls = [];
  const media = { item: value => value, vod: async (source, parameters) => {
    calls.push([source.id, parameters.pg, generation]);
    return { list: [{ ...items[0], sourceId: source.id, id: `copy-${source.id}`, updatedAt: generation ? '2026-11-15T00:00:00Z' : items[0].updatedAt }], pagecount: 1 };
  } };
  const available = sources.slice(0, 2); const catalog = createCatalog(media);
  const first = await catalog.browse(available);
  assert.equal(first.total, 2);
  assert.equal(first.scope.loadedCount, 2);
  assert.equal(first.scope.rawLoadedCount, 2);
  const groupKey = groupKeyFor(first.items[0]);
  assert.equal(catalog.variants(groupKey, available).length, 2);
  generation = 1;
  const cached = await catalog.browse(available, { sort: 'score' });
  assert.equal(calls.length, 2);
  assert.equal(cached.items[0].updatedAt, '2026-10-01T00:00:00Z');
  const [refreshed, concurrent] = await Promise.all([catalog.browse(available, { refresh: '1' }), catalog.browse(available, { refresh: '1' })]);
  assert.equal(calls.length, 4, 'concurrent refreshes share one fresh round');
  assert.equal(refreshed.items[0].updatedAt, '2026-11-15T00:00:00Z');
  assert.deepEqual(concurrent.items, refreshed.items);
  assert.deepEqual(catalog.variants(groupKey, [{ ...available[0], enabled: false }, available[1]]).map(item => item.sourceId), ['b']);
  assert.equal(catalog.variants(groupKey, available.map(source => ({ ...source, url: `${source.url}/changed` }))).length, 0);
  assert.deepEqual(catalog.variants('nonexistent', available), []);
});
