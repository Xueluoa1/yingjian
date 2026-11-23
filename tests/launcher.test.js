import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function worker(port, directory, extra = []) {
  const child = spawn(process.execPath, [resolve('launcher/host.mjs'), '--port', String(port), '--data-dir', directory, '--host', '127.0.0.1', ...extra], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  let stderr = '';
  const events = [];
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Worker start timeout: ${stderr}`)), 12000);
    child.stdout.on('data', chunk => {
      output += chunk;
      let split;
      while ((split = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, split); output = output.slice(split + 1);
        try {
          const event = JSON.parse(line); events.push(event);
          if (event.type === 'ready') { clearTimeout(timer); resolve(event); }
          if (event.type === 'error') { clearTimeout(timer); reject(new Error(event.message)); }
        } catch (error) { if (!(error instanceof SyntaxError)) reject(error); }
      }
    });
    child.once('exit', code => { clearTimeout(timer); if (!events.some(event => event.type === 'ready')) reject(new Error(`Worker exited ${code}: ${stderr}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const exited = new Promise((resolve, reject) => { child.once('exit', code => resolve(code)); child.once('error', reject); });
  return { child, ready, exited, events, async stop() { if (child.exitCode === null) child.stdin.end('{"command":"shutdown"}\n'); return exited; } };
}

test('launcher-owned worker saves a device, stops, releases lock, and reopens the same data', { timeout: 25000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yingjian-launcher-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const port = await freePort();
  const first = worker(port, directory);
  t.after(() => first.stop());
  await first.ready;
  const origin = `http://127.0.0.1:${port}`;
  const auth = await fetch(origin + '/api/auth/local-admin', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Yingjian': '1' }, body: JSON.stringify({ name: '启动器保存验证' }) });
  assert.equal(auth.status, 200);
  assert.equal(await first.stop(), 0);
  assert.ok(first.events.some(event => event.type === 'stopped'));
  const saved = JSON.parse(await readFile(join(directory, 'household.json'), 'utf8'));
  assert.ok(saved.devices.length > 0);
  const second = worker(port, directory);
  t.after(() => second.stop());
  await second.ready;
  const reopened = JSON.parse(await readFile(join(directory, 'household.json'), 'utf8'));
  assert.equal(reopened.secret, saved.secret);
  assert.deepEqual(reopened.devices, saved.devices);
  assert.equal(await second.stop(), 0);
});

test('closing the launcher control pipe stops only its worker', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yingjian-pipe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const running = worker(await freePort(), directory);
  t.after(() => running.stop());
  await running.ready;
  running.child.stdin.end();
  assert.equal(await running.exited, 0);
});

test('invalid launcher port fails before creating household data', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yingjian-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const running = worker(-1, directory);
  await assert.rejects(running.ready, /端口/);
  assert.equal(await running.exited, 1);
  await assert.rejects(access(join(directory, 'household.json')), { code: 'ENOENT' });
});
