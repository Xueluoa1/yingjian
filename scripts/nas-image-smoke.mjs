// Runs INSIDE an isolated test container. Its volume is never a household volume.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

assert.notEqual(process.getuid(), 0, 'The application must run as a non-root user.');
const origin = 'http://127.0.0.1:8080';
const checkpoint = '/app/data/.image-smoke-check.json';
let cookie = '';
async function request(path, method = 'GET', body, expected = 200) {
  const response = await fetch(origin + path, {
    method, headers: { 'x-yingjian': '1', 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(7000),
  });
  assert.equal(response.status, expected, `${method} ${path} returned ${response.status}.`);
  return response;
}
const status = await (await request('/api/status')).json();
assert.equal(status.version, '0.1.4');
assert.equal(status.passwordLoginAvailable, true);
if (process.env.SMOKE_PHASE === 'prepare') {
  await request('/api/sources', 'GET', undefined, 401);
  await request('/api/auth/admin', 'POST', { password: 'intentionally-wrong-password' }, 401);
  const login = await request('/api/auth/admin', 'POST', { password: process.env.ADMIN_PASSWORD, name: 'Image verification' });
  cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie?.startsWith('yingjian_session='));
  assert.equal((await login.json()).role, 'admin');
  for (const path of ['/', '/?view=server', '/?view=phone', '/?view=tv', '/app.js', '/styles.css', '/playback-utils.js', '/vendor/hls.min.js']) {
    const asset = await request(path);
    assert.ok((await asset.arrayBuffer()).byteLength > 100, `Empty asset: ${path}`);
    if (path.endsWith('.js')) assert.match(asset.headers.get('content-type'), /javascript/);
    if (path.endsWith('.css')) assert.match(asset.headers.get('content-type'), /css/);
  }
  const pairing = await (await request('/api/pairing', 'POST', {})).json();
  assert.match(pairing.code, /^\d{6}$/);
  assert.ok(pairing.qrDataUrl.startsWith('data:image/png;base64,'));
  const adminCookie = cookie;
  cookie = '';
  const claim = await (await request('/api/pairing/claim', 'POST', { code: pairing.code, kind: 'tv', name: 'Image test TV' })).json();
  assert.equal(claim.role, 'client');
  cookie = adminCookie;
  const { source } = await (await request('/api/sources', 'POST', { name: 'Image persistence test', type: 'vod', url: 'https://example.invalid/api.php' }, 201)).json();
  await request('/api/playback-settings', 'PATCH', { sourceId: source.id, autoNext: false });
  await writeFile(checkpoint, JSON.stringify({ cookie, sourceId: source.id }), { mode: 0o600 });
  console.log(JSON.stringify({ phase: 'prepare', nonRoot: true, health: true, adminLogin: true, staticAssets: true, pairing: true }));
} else if (process.env.SMOKE_PHASE === 'restore') {
  const saved = JSON.parse(await readFile(checkpoint, 'utf8'));
  cookie = saved.cookie;
  const restoredStatus = await (await request('/api/status')).json();
  assert.equal(restoredStatus.role, 'admin');
  const { sources } = await (await request('/api/sources')).json();
  assert.ok(sources.some(source => source.id === saved.sourceId && source.name === 'Image persistence test'));
  const { settings } = await (await request('/api/playback-settings')).json();
  assert.equal(settings.sourceId, saved.sourceId);
  assert.equal(settings.autoNext, false);
  console.log(JSON.stringify({ phase: 'restore', persistenceRecreate: true }));
} else throw new Error('SMOKE_PHASE must be prepare or restore.');
