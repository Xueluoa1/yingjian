import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, listen } from '../server/index.js';
import { safeRequest, readLimited } from '../server/network.js';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'yingjian-test-'));
  const app = await createApp({ dataDir: directory, initialSources: [], ...options });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await app.locals.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function api(path, { method = 'GET', body, cookie, headers = {} } = {}) {
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(`${origin}${path}`, {
        method, headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Yingjian': '1' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      }, incoming => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => resolve({ status: incoming.statusCode, headers: new Headers(Object.entries(incoming.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])), text: Buffer.concat(chunks).toString() }));
        incoming.on('error', reject);
      });
      request.on('error', reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const text = response.text;
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function admin() { const response = await api('/api/auth/local-admin', { method: 'POST', body: {} }); assert.equal(response.status, 200); return response.cookie; }
  async function pair(cookie, kind = 'phone') {
    const generated = await api('/api/pairing', { method: 'POST', cookie, body: { origin } });
    assert.equal(generated.status, 200);
    const claimed = await api('/api/pairing/claim', { method: 'POST', body: { token: generated.data.token, kind, name: '测试设备' } });
    assert.equal(claimed.status, 200);
    return claimed;
  }
  return { app, server, api, origin, directory, admin, pair };
}

async function mockSource(t) {
  const ranged = Buffer.from('0123456789');
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(request.url, origin);
    if (url.pathname === '/vod') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ page: 1, pagecount: 2, list: [{
        vod_id: 42, vod_name: '测试影片', vod_year: '2026', type_name: '纪录片', vod_pic: '/cover.png',
        vod_content: '<p>影片介绍</p><script>alert(1)</script>', vod_play_from: '高清$$$备用',
        vod_play_url: `第一集$${origin}/master.m3u8#第二集$${origin}/movie.mp4$$$全集$${origin}/movie.mp4`,
      }] }));
    } else if (url.pathname === '/master.m3u8') {
      response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvideo/index.m3u8\n');
    } else if (url.pathname === '/video/index.m3u8') {
      response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      response.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="../key.bin"\n#EXT-X-MAP:URI="../init.mp4"\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n');
    } else if (['/movie.mp4', '/video/segment.ts', '/key.bin', '/init.mp4'].includes(url.pathname)) {
      response.setHeader('Content-Type', url.pathname.endsWith('.ts') ? 'video/mp2t' : 'video/mp4');
      response.setHeader('Accept-Ranges', 'bytes');
      if (request.headers.range === 'bytes=2-5') {
        response.writeHead(206, { 'Content-Range': 'bytes 2-5/10', 'Content-Length': '4' });
        response.end(ranged.subarray(2, 6));
      } else response.end(ranged);
    } else if (url.pathname === '/live.m3u') {
      response.end(`#EXTM3U\n#EXTINF:-1 tvg-logo="/cover.png" group-title="纪录",测试频道\n${origin}/master.m3u8\n`);
    } else if (url.pathname === '/cover.png') {
      response.setHeader('Content-Type', 'image/png');
      response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XcAAAAASUVORK5CYII=', 'base64'));
    } else if (url.pathname === '/bad') response.end('<html>not json</html>');
    else if (url.pathname === '/redirect') { response.writeHead(302, { Location: '/vod' }); response.end('discard'.repeat(4096)); }
    else if (url.pathname === '/loop') { response.writeHead(302, { Location: '/loop' }); response.end('discard'.repeat(4096)); }
    else { response.writeHead(404); response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('authentication enforces origin, custom header, trusted host and role', async t => {
  const f = await fixture(t);
  const status = await f.api('/api/status');
  assert.equal(status.data.paired, false);
  assert.equal(status.data.localAdminAvailable, true);
  assert.equal((await f.api('/api/sources')).status, 401);
  assert.equal((await f.api('/api/auth/local-admin', { method: 'POST', body: {}, headers: { 'X-Yingjian': '' } })).status, 403);
  assert.equal((await f.api('/api/auth/local-admin', { method: 'POST', body: {}, headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await f.api('/api/status', { headers: { Host: `evil.example:${f.server.address().port}` } })).status, 403);
  const cookie = await f.admin();
  assert.equal((await f.api('/api/status', { cookie })).data.role, 'admin');
  assert.equal((await f.api('/api/sources', { method: 'POST', cookie, body: { name: '错误地址', type: 'vod', url: 'javascript:alert(1)' } })).status, 400);
  const client = await f.pair(cookie);
  assert.equal((await f.api('/api/overview', { cookie: client.cookie })).status, 403);
  assert.equal((await f.api('/api/devices', { cookie: client.cookie })).status, 403);
  assert.equal((await f.api('/api/pairing', { method: 'POST', cookie: client.cookie, body: {} })).status, 403);
  assert.equal((await f.api('/api/auth/logout', { method: 'POST', cookie: client.cookie })).status, 200);
  assert.equal((await f.api('/api/sources', { cookie: client.cookie })).status, 401);
});

test('startup rejects an occupied port without hiding the original listen error', async t => {
  const f = await fixture(t);
  await assert.rejects(listen({ dataDir: join(f.directory, 'collision'), initialSources: [], port: f.server.address().port, host: '127.0.0.1' }), { code: 'EADDRINUSE' });
  assert.equal((await f.api('/api/status')).status, 200);
  const ephemeral = await listen({ dataDir: join(f.directory, 'ephemeral'), initialSources: [], port: 0, host: '127.0.0.1' });
  assert.ok(ephemeral.server.address().port > 0);
  await new Promise(resolve => ephemeral.server.close(resolve));
  await ephemeral.app.locals.close();
});

test('NAS advertised address honors mapped ports and password login', async t => {
  const publicOrigin = 'http://192.168.1.50:18080';
  const f = await fixture(t, { publicOrigin, adminPassword: 'correct horse battery staple' });
  const headers = { Host: '192.168.1.50:18080', Origin: publicOrigin };
  const status = await f.api('/api/status', { headers });
  assert.equal(status.status, 200);
  assert.equal(status.data.addresses[0], publicOrigin);
  assert.equal(status.data.passwordLoginAvailable, true);
  assert.equal((await f.api('/api/auth/admin', { method: 'POST', headers, body: { password: 'wrong' } })).status, 401);
  const login = await f.api('/api/auth/admin', { method: 'POST', headers, body: { password: 'correct horse battery staple' } });
  assert.equal(login.status, 200);
  assert.equal(login.data.role, 'admin');
  const pairing = await f.api('/api/pairing', { method: 'POST', cookie: login.cookie, headers, body: {} });
  assert.ok(pairing.data.url.startsWith(`${publicOrigin}/connect#pair=`));
  assert.equal((await f.api('/api/status', { headers: { Host: '192.168.1.50:18081' } })).status, 403);
  for (let i = 0; i < 4; i++) await f.api('/api/auth/admin', { method: 'POST', body: { password: 'wrong' } });
  assert.equal((await f.api('/api/auth/admin', { method: 'POST', body: { password: 'correct horse battery staple' } })).status, 429);
});

test('invalid public origins fail at startup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yingjian-origin-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const publicOrigin of ['https://8.8.8.8', 'http://example.com', 'http://192.168.1.2/subpath', 'http://192.168.1.2/?x=1']) {
    await assert.rejects(createApp({ dataDir: directory, initialSources: [], publicOrigin }), /PUBLIC_ORIGIN/);
  }
});

test('pairing supports QR token and six digit code, one use, expiry, and revocation', async t => {
  const f = await fixture(t);
  const cookie = await f.admin();
  const generated = await f.api('/api/pairing', { method: 'POST', cookie, body: { origin: f.origin } });
  assert.match(generated.data.code, /^\d{6}$/);
  assert.match(generated.data.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(new URL(generated.data.url).search, '');
  assert.ok(new URL(generated.data.url).hash.includes(generated.data.token));
  await f.api('/connect'); // A QR preview or link prefetch must not consume pairing.
  const results = await Promise.all([0, 1].map(() => f.api('/api/pairing/claim', { method: 'POST', body: { code: generated.data.code, kind: 'tv' } })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
  const client = results.find(result => result.status === 200);
  assert.equal(client.data.device.kind, 'tv');
  assert.equal((await f.api('/api/heartbeat', { method: 'POST', cookie: client.cookie, body: { playing: { title: '测试影片', episode: '第一集' } } })).status, 200);
  assert.equal((await f.api('/api/devices', { cookie })).data.devices.find(device => device.id === client.data.device.id).playing.title, '测试影片');
  assert.equal((await f.api(`/api/devices/${client.data.device.id}`, { method: 'DELETE', cookie })).status, 200);
  assert.equal((await f.api('/api/catalog', { cookie: client.cookie })).status, 401);
  const expired = await f.api('/api/pairing', { method: 'POST', cookie, body: { origin: f.origin } });
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 11 * 60000;
    assert.equal((await f.api('/api/pairing/claim', { method: 'POST', body: { token: expired.data.token } })).status, 400);
  } finally { Date.now = originalNow; }
});

test('source seeds apply once and household state survives restart', async t => {
  const f = await fixture(t, { initialSources: [{ id: 'seed-test', name: '初始源', type: 'vod', url: 'https://example.com/vod', enabled: false }] });
  const cookie = await f.admin();
  assert.equal((await f.api('/api/sources', { cookie })).data.sources[0].enabled, false);
  assert.equal((await f.api('/api/sources/seed-test', { method: 'DELETE', cookie })).status, 200);
  await f.app.locals.close();
  const reopened = await createApp({ dataDir: f.directory, initialSources: [{ id: 'seed-test', name: '初始源', type: 'vod', url: 'https://example.com/vod' }] });
  assert.equal(reopened.locals.store.state.sources.length, 0);
  assert.equal(reopened.locals.store.state.devices.length, 1);
  await reopened.locals.close();
  const disk = JSON.parse(await readFile(join(f.directory, 'household.json'), 'utf8'));
  assert.equal(disk.sessions.length, 1);
  assert.ok(!JSON.stringify(disk).includes(cookie.split('=')[1]));
});

test('AppleCMS and M3U play through scoped HLS proxy including keys, segments and ranges', async t => {
  const upstream = await mockSource(t);
  const f = await fixture(t, { allowPrivateUpstream: true });
  const cookie = await f.admin();
  const added = await f.api('/api/sources', { method: 'POST', cookie, body: { name: '本地测试', type: 'vod', url: `${upstream}/vod` } });
  assert.equal(added.status, 201);
  const sourceId = added.data.source.id;
  const probe = await f.api(`/api/sources/${sourceId}/probe`, { method: 'POST', cookie });
  assert.equal(probe.data.health.ok, true);
  const catalog = await f.api(`/api/catalog?sourceId=${sourceId}`, { cookie });
  assert.equal(catalog.data.items[0].title, '测试影片');
  assert.equal(catalog.data.items[0].description, '影片介绍');
  assert.equal(catalog.data.pageCount, 1);
  assert.equal(catalog.data.canLoadMore, true);
  assert.equal((await f.api('/api/search?q=测试', { cookie })).data.items.length, 1);
  const detail = await f.api(`/api/detail?sourceId=${sourceId}&id=42`, { cookie });
  assert.equal(detail.data.lines.length, 2);
  assert.equal(detail.data.lines[0].episodes.length, 2);
  const cover = await fetch(`${f.origin}${catalog.data.items[0].poster}`, { headers: { Cookie: cookie } });
  assert.equal(cover.status, 200);
  assert.equal(cover.headers.get('content-type'), 'image/png');
  await cover.arrayBuffer();
  const client = await f.pair(cookie);
  const playback = await f.api('/api/playback', { method: 'POST', cookie: client.cookie, body: { sourceId, id: '42', line: 0, episode: 0 } });
  assert.equal(playback.status, 200);
  const master = await f.api(playback.data.url, { cookie: client.cookie });
  assert.equal(master.status, 200);
  assert.ok(!master.data.includes(upstream));
  const childPath = master.data.split('\n').find(line => line.startsWith('/api/stream'));
  const playlist = await f.api(childPath, { cookie: client.cookie });
  assert.equal(playlist.status, 200);
  const keyPaths = [...playlist.data.matchAll(/URI="([^"]+)"/g)].map(match => match[1]);
  assert.equal(keyPaths.length, 2);
  for (const keyPath of keyPaths) assert.equal((await f.api(keyPath, { cookie: client.cookie })).status, 200);
  const segmentPath = playlist.data.split('\n').find(line => line.startsWith('/api/stream'));
  const segment = await f.api(segmentPath, { cookie: client.cookie, headers: { Range: 'bytes=2-5' } });
  assert.equal(segment.status, 206);
  assert.equal(segment.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(segment.data, 2345); // Response content is four literal ASCII bytes.
  assert.equal((await f.api(segmentPath, { cookie: client.cookie, headers: { Range: 'bytes=1-2,4-5' } })).status, 400);
  assert.equal((await f.api(playback.data.url, { cookie })).status, 403);
  assert.equal((await f.api(`${playback.data.url}x`, { cookie: client.cookie })).status, 403);
  const favorite = { ...catalog.data.items[0], position: 100, duration: 60, episodeName: '第一集', episode: 0, line: 0 };
  assert.equal((await f.api('/api/favorites', { method: 'POST', cookie: client.cookie, body: favorite })).status, 200);
  assert.equal((await f.api('/api/history', { method: 'PUT', cookie: client.cookie, body: favorite })).status, 200);
  assert.equal((await f.api('/api/history', { cookie })).data.items[0].position, 60);
  assert.equal((await f.api('/api/favorites', { cookie })).data.items[0].id, '42');
  const live = await f.api('/api/sources', { method: 'POST', cookie, body: { name: '直播测试', type: 'live', url: `${upstream}/live.m3u` } });
  const channelList = await f.api(`/api/live?sourceId=${live.data.source.id}`, { cookie });
  assert.equal(channelList.data.channels[0].group, '纪录');
  const channelPlayback = await f.api('/api/playback', { method: 'POST', cookie: client.cookie, body: { sourceId: live.data.source.id, channelId: channelList.data.channels[0].id } });
  assert.equal(channelPlayback.status, 200);
  await f.api(`/api/sources/${sourceId}`, { method: 'PATCH', cookie, body: { enabled: false } });
  assert.equal((await f.api(playback.data.url, { cookie: client.cookie })).status, 400);
});

test('network proxy rejects private upstream by default and reports source failures', async t => {
  const upstream = await mockSource(t);
  await assert.rejects(safeRequest(`${upstream}/vod`), /受保护的网络地址/);
  const f = await fixture(t);
  const cookie = await f.admin();
  const added = await f.api('/api/sources', { method: 'POST', cookie, body: { name: '受限源', type: 'vod', url: `${upstream}/vod` } });
  const catalog = await f.api(`/api/catalog?sourceId=${added.data.source.id}`, { cookie });
  assert.equal(catalog.data.items.length, 0);
  assert.equal(catalog.data.failures.length, 1);
  assert.match(catalog.data.failures[0].error, /受保护的网络地址/);
  const probe = await f.api(`/api/sources/${added.data.source.id}/probe`, { method: 'POST', cookie });
  assert.equal(probe.data.health.ok, false);
});

test('upstream redirects and early body disposal do not emit unhandled abort errors', async t => {
  const upstream = await mockSource(t);
  const redirected = await safeRequest(`${upstream}/redirect`, { allowPrivate: true });
  assert.equal(redirected.url, `${upstream}/vod`);
  assert.equal(JSON.parse(await readLimited(redirected)).list[0].vod_id, 42);
  await assert.rejects(safeRequest(`${upstream}/loop`, { allowPrivate: true }), /重定向次数过多/);
  const oversized = await safeRequest(`${upstream}/vod`, { allowPrivate: true });
  await assert.rejects(readLimited(oversized, 10), /大小限制/);
  const f = await fixture(t, { allowPrivateUpstream: true });
  const cookie = await f.admin();
  const source = await f.api('/api/sources', { method: 'POST', cookie, body: { name: '不存在的源', type: 'vod', url: `${upstream}/404` } });
  const catalog = await f.api(`/api/catalog?sourceId=${source.data.source.id}`, { cookie });
  assert.match(catalog.data.failures[0].error, /HTTP 404/);
});

test('independent source cards retain alternate-source identity for history and favorites', async t => {
  const upstream = await mockSource(t);
  const f = await fixture(t, { allowPrivateUpstream: true });
  const cookie = await f.admin();
  const add = async name => (await f.api('/api/sources', { method:'POST', cookie, body:{name,type:'vod',url:`${upstream}/vod`} })).data.source;
  const a = await add('主片源'); const b = await add('备用片源');
  const catalog = await f.api('/api/catalog', {cookie});
  assert.equal(catalog.data.total, 2);
  assert.deepEqual(new Set(catalog.data.items.map(item => item.sourceName)), new Set(['主片源', '备用片源']));
  assert.equal(catalog.data.items[0].variants, undefined);
  const alternatives = await f.api(`/api/alternatives?sourceId=${a.id}&id=42`, {cookie});
  const groupKey = alternatives.data.groupKey;
  assert.equal(alternatives.data.variants.length, 2);
  const detail = await f.api(`/api/detail?sourceId=${a.id}&id=42`, {cookie});
  assert.equal(detail.data.item.variants.length, 2);
  const item = {...detail.data.item,episodeName:'第一集',line:0,episode:0,duration:600};
  const recordedAt = Date.now();
  await f.api('/api/history', {method:'PUT',cookie,body:{...item,sourceId:a.id,position:100,recordedAt:recordedAt-1000}});
  await f.api('/api/history', {method:'PUT',cookie,body:{...item,sourceId:b.id,position:110,recordedAt}});
  // An old in-flight save must not overwrite progress after switching sources.
  const stale = await f.api('/api/history', {method:'PUT',cookie,body:{...item,sourceId:a.id,position:101,recordedAt:recordedAt-500}});
  assert.equal(stale.data.ignored, true);
  const history = await f.api('/api/history', {cookie});
  assert.equal(history.data.items.length,1); assert.equal(history.data.items[0].sourceId,b.id); assert.equal(history.data.items[0].position,110);
  await f.api('/api/favorites', {method:'POST',cookie,body:{...item,sourceId:a.id}});
  await f.api('/api/favorites', {method:'POST',cookie,body:{...item,sourceId:b.id}});
  assert.equal((await f.api('/api/favorites',{cookie})).data.items.length,1);
  await f.api(`/api/favorites/${groupKey}`,{method:'DELETE',cookie});
  assert.equal((await f.api('/api/favorites',{cookie})).data.items.length,0);
  await f.api(`/api/sources/${b.id}`,{method:'PATCH',cookie,body:{enabled:false}});
  const available = await f.api(`/api/alternatives?sourceId=${a.id}&id=42`,{cookie});
  assert.deepEqual(available.data.variants.map(v=>v.sourceId),[a.id]);
});

test('history accepts progress from a different device despite clock skew and rejects that device\'s late saves', async t => {
  const upstream = await mockSource(t);
  const f = await fixture(t, { allowPrivateUpstream: true });
  const adminCookie = await f.admin();
  const source = (await f.api('/api/sources', { method:'POST', cookie:adminCookie, body:{name:'进度测试',type:'vod',url:`${upstream}/vod`} })).data.source;
  const phone = await f.pair(adminCookie, 'phone');
  const tv = await f.pair(adminCookie, 'tv');
  const item = (await f.api(`/api/detail?sourceId=${source.id}&id=42`, {cookie:phone.cookie})).data.item;
  const capturedAt = Date.now();
  const save = (cookie, position, recordedAt, extra = {}) => f.api('/api/history', { method:'PUT', cookie,
    body:{...item,episodeName:'第一集',line:0,episode:0,duration:600,position,recordedAt,...extra} });

  assert.equal((await save(phone.cookie, 100, capturedAt + 120000)).status, 200);
  const nextDevice = await save(tv.cookie, 130, capturedAt);
  assert.equal(nextDevice.status, 200);
  assert.equal(nextDevice.data.ignored, undefined, 'a fast phone clock must not block later TV progress');
  let history = (await f.api('/api/history', {cookie:adminCookie})).data.items;
  assert.equal(history.length, 1);
  assert.equal(history[0].position, 130);
  assert.equal(history[0].recordedBy, tv.data.device.id);

  const late = await save(tv.cookie, 110, capturedAt - 1000, {recordedBy:phone.data.device.id});
  assert.equal(late.data.ignored, true, 'device identity comes from authentication, not request metadata');
  history = (await f.api('/api/history', {cookie:adminCookie})).data.items;
  assert.equal(history[0].position, 130);
});

test('paired devices manage sources and persist independent selected-source playback settings', async t => {
  const upstream = await mockSource(t);
  const f = await fixture(t, { allowPrivateUpstream: true });
  const adminCookie = await f.admin();
  const phone = await f.pair(adminCookie, 'phone');
  const tv = await f.pair(adminCookie, 'tv');
  const cookie = phone.cookie;
  const add = async (name, type = 'vod') => {
    const result = await f.api('/api/sources', { method: 'POST', cookie, body: { name, type, url: `${upstream}/${type === 'vod' ? 'vod' : 'live.m3u'}` } });
    assert.equal(result.status, 201);
    return result.data.source;
  };
  assert.equal((await f.api('/api/playback-settings')).status, 401);
  assert.equal((await f.api('/api/playback-settings', { cookie })).data.settings.sourceId, '');
  const a = await add('手机添加的源');
  const b = await add('备用源');
  const live = await add('直播源', 'live');
  for (const [path, method, body] of [
    ['/api/sources', 'POST', { name: '未配对', type: 'vod', url: `${upstream}/vod` }],
    [`/api/sources/${a.id}`, 'PATCH', { enabled: false }],
    [`/api/sources/${a.id}`, 'DELETE', undefined],
    [`/api/sources/${a.id}/probe`, 'POST', undefined],
  ]) assert.equal((await f.api(path, { method, body })).status, 401);

  const settings = await f.api('/api/playback-settings', { method: 'PATCH', cookie, body: { sourceId: a.id, autoNext: true } });
  assert.deepEqual(settings.data.settings, { sourceId: a.id, autoNext: true });
  assert.deepEqual((await f.api('/api/playback-settings', { cookie: tv.cookie })).data.settings, { sourceId: '', autoNext: false });
  assert.equal((await f.api('/api/playback-settings', { method: 'PATCH', cookie, body: { sourceId: live.id } })).status, 400);
  assert.equal((await f.api('/api/playback-settings', { method: 'PATCH', cookie, body: { autoNext: 'true' } })).status, 400);
  assert.equal((await f.api('/api/playback-settings', { method: 'PATCH', cookie, body: { sourceId: 'missing' } })).status, 404);
  for (const path of ['/api/catalog', '/api/search?q=测试']) {
    const result = await f.api(path, { cookie });
    assert.equal(result.data.total, 1);
    assert.deepEqual(result.data.items.map(item => item.sourceId), [a.id]);
    assert.equal(result.data.scope.sourceCount, 1);
  }
  const all = await f.api('/api/catalog', { cookie: tv.cookie });
  assert.equal(all.data.total, 2);
  assert.deepEqual(new Set(all.data.items.map(item => item.sourceId)), new Set([a.id, b.id]));
  const probe = await f.api(`/api/sources/${a.id}/probe`, { method: 'POST', cookie });
  assert.equal(probe.data.health.ok, true);
  assert.ok(Number.isFinite(probe.data.health.latency));
  const toggled = await f.api(`/api/sources/${a.id}`, { method: 'PATCH', cookie, body: { enabled: false } });
  assert.deepEqual(toggled.data.source.health, probe.data.health, 'toggling retains the latest latency measurement');
  assert.deepEqual((await f.api('/api/playback-settings', { cookie })).data.settings, { sourceId: '', autoNext: true });
  assert.equal((await f.api('/api/playback-settings', { method: 'PATCH', cookie, body: { sourceId: a.id } })).status, 400);
  assert.deepEqual((await f.api('/api/catalog', { cookie })).data.items.map(item => item.sourceId), [b.id]);
  await f.api(`/api/sources/${a.id}`, { method: 'PATCH', cookie, body: { enabled: true } });
  await f.api('/api/playback-settings', { method: 'PATCH', cookie, body: { sourceId: b.id } });
  await f.app.locals.close();
  const reopened = await createApp({ dataDir: f.directory });
  assert.deepEqual(reopened.locals.store.state.devices.find(device => device.id === phone.data.device.id).playbackSettings, { sourceId: b.id, autoNext: true });
  await reopened.locals.close();
  assert.equal((await f.api(`/api/sources/${b.id}`, { method: 'DELETE', cookie: tv.cookie })).status, 200);
  assert.equal((await f.api('/api/playback-settings', { cookie })).data.settings.sourceId, '');
  const edited = await f.api(`/api/sources/${a.id}`, { method: 'PATCH', cookie, body: { url: `${upstream}/bad` } });
  assert.equal(edited.data.source.health, undefined);
  assert.ok((await f.api('/api/overview', { cookie: adminCookie })).data.activity.some(item => item.message.includes('已停用')));
});

test('paired source probes retain private-network protection and reject forged source URLs', async t => {
  const upstream = await mockSource(t);
  const f = await fixture(t);
  const adminCookie = await f.admin();
  const client = await f.pair(adminCookie);
  const cookie = client.cookie;
  const added = await f.api('/api/sources', { method: 'POST', cookie, body: { name: '私网探测', type: 'vod', url: `${upstream}/vod` } });
  assert.equal(added.status, 201);
  const sourceId = added.data.source.id;
  const probe = await f.api(`/api/sources/${sourceId}/probe`, { method: 'POST', cookie });
  assert.equal(probe.status, 200);
  assert.equal(probe.data.health.ok, false);
  assert.match(probe.data.health.error, /受保护的网络地址/);
  assert.equal((await f.api(`/api/sources/${sourceId}`, { method: 'PATCH', cookie, body: { url: 'file:///etc/passwd' } })).status, 400);
  assert.equal((await f.api(`/api/sources/${sourceId}/probe`, { method: 'POST', cookie, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.api(`/api/sources/${sourceId}`, { method: 'DELETE', cookie, headers: { 'X-Yingjian': '' } })).status, 403);
});

test('home and admin summaries report measured source health, cached live counts and safe current playback', async t => {
  const upstream = await mockSource(t);
  const f = await fixture(t, { allowPrivateUpstream: true });
  const adminCookie = await f.admin();
  const client = await f.pair(adminCookie);
  const cookie = client.cookie;
  const add = async (name, type, path) => (await f.api('/api/sources', { method: 'POST', cookie, body: { name, type, url: `${upstream}/${path}` } })).data.source;
  const vod = await add('真实片源名', 'vod', 'vod');
  const broken = await add('失败源', 'vod', 'bad');
  const live = await add('直播源', 'live', 'live.m3u');
  assert.equal((await f.api('/api/home-summary')).status, 401);
  let summary = (await f.api('/api/home-summary', { cookie })).data;
  assert.deepEqual(summary.sourceHealth, { total: 3, enabled: 3, vod: 2, enabledVod: 2, live: 1, enabledLive: 1, measured: 0, healthy: 0, failed: 0, unknown: 3, averageLatencyMs: null });
  assert.deepEqual(summary.liveChannels, { count: 0, loadedSources: 0, totalSources: 1, known: false });
  await f.api(`/api/sources/${vod.id}/probe`, { method: 'POST', cookie });
  await f.api(`/api/sources/${broken.id}/probe`, { method: 'POST', cookie });
  await f.api(`/api/sources/${live.id}/probe`, { method: 'POST', cookie });
  summary = (await f.api('/api/home-summary', { cookie })).data;
  assert.equal(summary.sourceHealth.measured, 3);
  assert.equal(summary.sourceHealth.healthy, 2);
  assert.equal(summary.sourceHealth.failed, 1);
  assert.equal(summary.sourceHealth.unknown, 0);
  assert.ok(summary.sourceHealth.averageLatencyMs >= 0);
  assert.deepEqual(summary.liveChannels, { count: 1, loadedSources: 1, totalSources: 1, known: true });
  const item = (await f.api(`/api/detail?sourceId=${vod.id}&id=42`, { cookie })).data.item;
  await f.api('/api/heartbeat', { method: 'POST', cookie, body: { playing: { sourceId: vod.id, id: '42', sourceName: '伪造来源', title: '伪造标题', episode: '第一集', poster: 'https://evil.example/pixel', position: 500, duration: 300, paused: true } } });
  let overview = (await f.api('/api/overview', { cookie: adminCookie })).data;
  assert.deepEqual(overview.sourceHealth, summary.sourceHealth);
  let playing = overview.devices.find(device => device.id === client.data.device.id).playing;
  assert.equal(playing.sourceName, '真实片源名');
  assert.equal(playing.title, '测试影片');
  assert.equal(playing.poster, item.poster);
  assert.equal(playing.position, 300);
  assert.equal(playing.duration, 300);
  assert.equal(playing.paused, true);
  await f.api('/api/heartbeat', { method: 'POST', cookie, body: { playing: { title: '未缓存影片', sourceId: 'unknown', sourceName: '伪造来源', id: '../../secret', poster: '/api/image?t=forged', position: -1, duration: 'not a number' } } });
  overview = (await f.api('/api/overview', { cookie: adminCookie })).data;
  playing = overview.devices.find(device => device.id === client.data.device.id).playing;
  assert.equal(playing.sourceId, '');
  assert.equal(playing.sourceName, '');
  assert.equal(playing.poster, '');
  assert.equal(playing.id, '');
  assert.equal(playing.position, 0);
  assert.equal(playing.duration, 0);
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 31000;
    assert.deepEqual((await f.api('/api/home-summary', { cookie })).data.liveChannels, { count: 0, loadedSources: 0, totalSources: 1, known: false });
  } finally { Date.now = originalNow; }
});

test('editing a source during its latency test cannot attach the old response to the new URL', async t => {
  let responseReady;
  const received = new Promise(resolve => { responseReady = resolve; });
  const upstream = createServer((_request, response) => responseReady(response));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const f = await fixture(t, { allowPrivateUpstream: true });
  const cookie = await f.admin();
  const url = `http://127.0.0.1:${upstream.address().port}/live.m3u`;
  const source = (await f.api('/api/sources', { method: 'POST', cookie, body: { name: '并发测试', type: 'live', url } })).data.source;
  const probe = f.api(`/api/sources/${source.id}/probe`, { method: 'POST', cookie });
  const response = await received;
  await f.api(`/api/sources/${source.id}`, { method: 'PATCH', cookie, body: { url: `${url}?updated=1` } });
  response.end('#EXTM3U\n#EXTINF:-1,旧频道\nhttps://example.com/old.m3u8\n');
  assert.equal((await probe).status, 409);
  const saved = (await f.api('/api/sources', { cookie })).data.sources[0];
  assert.equal(saved.url, `${url}?updated=1`);
  assert.equal(saved.health, undefined);
  const summary = (await f.api('/api/home-summary', { cookie })).data;
  assert.equal(summary.sourceHealth.measured, 0);
  assert.equal(summary.liveChannels.known, false);
  assert.equal(summary.liveChannels.count, 0);
});

test('in-flight detail and live results cannot repopulate caches after their source URL is edited', async t => {
  let waiting;
  const upstream = createServer((_request, response) => waiting(response));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const f = await fixture(t, { allowPrivateUpstream: true });
  const cookie = await f.admin();
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  for (const type of ['vod', 'live']) {
    const source = (await f.api('/api/sources', { method: 'POST', cookie, body: { name: `${type} 缓存测试`, type, url: `${origin}/${type}` } })).data.source;
    const received = new Promise(resolve => { waiting = resolve; });
    const path = type === 'vod' ? `/api/detail?sourceId=${source.id}&id=42` : `/api/live?sourceId=${source.id}`;
    const request = f.api(path, { cookie });
    const response = await received;
    await f.api(`/api/sources/${source.id}`, { method: 'PATCH', cookie, body: { url: `${origin}/updated-${type}` } });
    response.end(type === 'vod' ? JSON.stringify({ list: [{ vod_id: 42, vod_name: '旧数据', vod_play_url: '正片$https://example.com/old.mp4' }] })
      : '#EXTM3U\n#EXTINF:-1,旧频道\nhttps://example.com/old.m3u8\n');
    const result = await request;
    if (type === 'vod') assert.equal(result.status, 409);
    else {
      assert.equal(result.data.channels.length, 0);
      assert.match(result.data.failures[0].error, /片源已修改/);
      assert.equal((await f.api('/api/home-summary', { cookie })).data.liveChannels.count, 0);
    }
    // The next request must reach the updated upstream instead of using old data.
    const nextReceived = new Promise(resolve => { waiting = resolve; });
    const next = f.api(path, { cookie });
    const nextResponse = await nextReceived;
    nextResponse.end(type === 'vod' ? JSON.stringify({ list: [{ vod_id: 42, vod_name: '新数据', vod_play_url: '正片$https://example.com/new.mp4' }] })
      : '#EXTM3U\n#EXTINF:-1,新频道\nhttps://example.com/new.m3u8\n');
    const fresh = await next;
    assert.equal(type === 'vod' ? fresh.data.item.title : fresh.data.channels[0].name, type === 'vod' ? '新数据' : '新频道');
  }
});
