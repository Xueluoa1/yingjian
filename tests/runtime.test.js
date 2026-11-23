import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { listen } from '../server/index.js';
import { DATA_LOCK_NAME, lockDataDirectory, canRecoverDataLock, closeHttpServer } from '../server/runtime.js';

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'yingjian-runtime-test-'));
  t.services = [];
  t.after(async () => {
    for (const service of t.services) await service.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
const options = dataDir => ({ dataDir, port: 0, host: '127.0.0.1', initialSources: [] });
async function start(t, root) {
  const service = await listen(options(root));
  t.services.push(service);
  return service;
}
async function absent(path) { await assert.rejects(access(path), { code: 'ENOENT' }); }

test('occupied port never creates a data directory or rewrites existing household data', async t => {
  const root = await directory(t);
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const dataDir = join(root, 'untouched');
  const settings = { ...options(dataDir), port: server.address().port };
  await assert.rejects(listen(settings), { code: 'EADDRINUSE' });
  await absent(dataDir);
  await mkdir(dataDir);
  const file = join(dataDir, 'household.json');
  await writeFile(file, '{"unchanged":true}');
  await assert.rejects(listen(settings), { code: 'EADDRINUSE' });
  assert.equal(await readFile(file, 'utf8'), '{"unchanged":true}');
  await absent(join(dataDir, DATA_LOCK_NAME));
});

test('different ports cannot concurrently open the same data directory', async t => {
  const root = await directory(t);
  const first = await start(t, root);
  const before = await readFile(join(root, 'household.json'), 'utf8');
  await assert.rejects(listen(options(root)), { code: 'EDATALOCKED' });
  assert.equal(await readFile(join(root, 'household.json'), 'utf8'), before);
  assert.equal(first.server.listening, true);
});

test('close flushes queued data, removes its lock and preserves history when reopened', async t => {
  const root = await directory(t);
  const first = await start(t, root);
  first.app.locals.store.state.history.push({ key: 'episode', position: 123 });
  const saved = first.app.locals.store.save();
  await first.close();
  await saved;
  await absent(join(root, DATA_LOCK_NAME));
  await assert.rejects(first.app.locals.store.save(), /服务已停止/);
  const second = await start(t, root);
  assert.deepEqual(second.app.locals.store.state.history, [{ key: 'episode', position: 123 }]);
});

test('legacy server.close callback waits for data flush and lock release', async t => {
  const root = await directory(t);
  const service = await start(t, root);
  service.app.locals.store.state.favorites.push({ key: 'favorite' });
  const saved = service.app.locals.store.save();
  await new Promise((resolve, reject) => service.server.close(error => error ? reject(error) : resolve()));
  await saved;
  await absent(join(root, DATA_LOCK_NAME));
  const reopened = await start(t, root);
  assert.deepEqual(reopened.app.locals.store.state.favorites, [{ key: 'favorite' }]);
});

test('failed application initialization releases port and its data lock', async t => {
  const root = await directory(t);
  const file = join(root, 'household.json');
  await writeFile(file, 'invalid data');
  await assert.rejects(listen(options(root)), /无法读取家庭数据/);
  await absent(join(root, DATA_LOCK_NAME));
  assert.equal(await readFile(file, 'utf8'), 'invalid data');
});

async function existingLock(root, owner) {
  const path = join(root, DATA_LOCK_NAME);
  await mkdir(path);
  await writeFile(join(path, 'owner.json'), JSON.stringify(owner));
  return path;
}

test('a proven dead local PID lock is recovered, including concurrent retry attempts', async t => {
  const root = await directory(t);
  const pid = 2147483647;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await existingLock(root, { pid, hostname: hostname(), token: 'a'.repeat(48) });
  const results = await Promise.allSettled([lockDataDirectory(root), lockDataDirectory(root)]);
  const owners = results.filter(result => result.status === 'fulfilled');
  assert.equal(owners.length, 1);
  await owners[0].value();
  await absent(join(root, DATA_LOCK_NAME));
});

test('a live PID lock without verifiable process identity is never removed', async t => {
  const root = await directory(t);
  const owner = { pid: process.pid, hostname: hostname(), token: 'b'.repeat(48), processStartedAt: 1 };
  const path = await existingLock(root, owner);
  await assert.rejects(lockDataDirectory(root), { code: 'EDATALOCKED' });
  assert.deepEqual(JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')), owner);
});

test('Linux PID 1 reuse after a container restart recovers only a verified old identity', async () => {
  const bootId = '11111111-2222-3333-4444-555555555555';
  const identity = { bootId, startTime: '1234567' };
  const owner = { pid: 1, hostname: 'nas-container', linuxIdentity: identity };
  const inspect = current => ({ machine: 'nas-container', isAlive: () => true, readIdentity: async () => current });
  assert.equal(await canRecoverDataLock(owner, inspect(identity)), false, 'still the original process');
  assert.equal(await canRecoverDataLock(owner, inspect({ ...identity, startTime: '2000000' })), true, 'new container process');
  assert.equal(await canRecoverDataLock(owner, inspect({ ...identity, bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })), true, 'host reboot');
  assert.equal(await canRecoverDataLock(owner, inspect(null)), false, 'unreadable procfs');
  assert.equal(await canRecoverDataLock(owner, inspect({ bootId, startTime: undefined })), false, 'malformed identity');
  assert.equal(await canRecoverDataLock(owner, { ...inspect({ ...identity, startTime: '2000000' }), machine: 'other-container' }), false, 'foreign container');
  assert.equal(await canRecoverDataLock({ ...owner, linuxIdentity: null }, inspect(identity)), false, 'old lock has no identity');
});

test('foreign or incomplete locks require inspection rather than unsafe takeover', async t => {
  const root = await directory(t);
  const path = await existingLock(root, { pid: 2147483647, hostname: 'another-container', token: 'c'.repeat(48) });
  await assert.rejects(lockDataDirectory(root), { code: 'EDATALOCKED' });
  await writeFile(join(path, 'owner.json'), '');
  await assert.rejects(lockDataDirectory(root), { code: 'EDATALOCKED' });
  assert.equal(await readFile(join(path, 'owner.json'), 'utf8'), '');
});

test('shutdown bounds a client that keeps a response open', async t => {
  const server = createServer((_req, res) => res.write('streaming'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await new Promise((resolve, reject) => {
    const request = get(`http://127.0.0.1:${server.address().port}`, resolve);
    request.on('error', reject);
  });
  response.on('error', () => {});
  const closed = once(response, 'close').catch(() => {});
  const begin = Date.now();
  await closeHttpServer(server, 50);
  await closed;
  assert.ok(Date.now() - begin < 2000);
  assert.equal(server.listening, false);
});
