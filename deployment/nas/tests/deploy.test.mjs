import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const template = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const supported = existsSync(shell);
const defaults = {
  ADMIN_PASSWORD: "'Local$Password#2026'",
  LAN_BIND_IP: '192.168.1.100',
  HOST_PORT: '8080',
  PUBLIC_ORIGIN: 'http://192.168.1.100:8080',
  DATA_VOLUME: 'yingjian-data',
};
const mockDocker = `#!/bin/sh
printf '%s|volume=%s|image=%s\\n' "$*" "\${DATA_VOLUME:-}" "\${NODE_IMAGE:-}" >> calls.txt
case "$1:$2" in
  info:) exit 0 ;;
  info:--format) printf '%s\\n' "\${FAKE_PLATFORM:-linux/amd64}"; exit 0 ;;
  compose:version) [ "\${FAKE_COMPOSE:-v2}" = v2 ]; exit $? ;;
  container:inspect)
    [ "\${FAKE_CONTAINER:-}" = yes ] || exit 1
    [ "\${3:-}" = --format ] || exit 0
    case "$4" in
      *Mounts*) printf '%s\\n' "\${FAKE_MOUNT:-volume:legacy_yingjian-data}" ;;
      *compose.project*) printf '%s\\n' "legacy" ;;
      *compose.service*) printf '%s\\n' "yingjian" ;;
    esac
    exit 0 ;;
  volume:ls) printf '%s\\n' "\${FAKE_VOLUMES:-}"; exit 0 ;;
  compose:--env-file) exit 0 ;;
esac
exit 1
`;
const mockCompose = `#!/bin/sh
[ "\${FAKE_COMPOSE:-v2}" = v1 ] || exit 1
printf 'v1 %s|volume=%s|image=%s\\n' "$*" "\${DATA_VOLUME:-}" "\${NODE_IMAGE:-}" >> calls.txt
exit 0
`;
function fixture(t, overrides = {}, extra = '') {
  const root = mkdtempSync(join(tmpdir(), 'yingjian-nas-test-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    rmSync(root, { recursive: true });
  });
  copyFileSync(join(template, 'deploy.sh'), join(root, 'deploy.sh'));
  copyFileSync(join(template, 'docker-compose.yml'), join(root, 'docker-compose.yml'));
  const config = { ...defaults, ...overrides };
  writeFileSync(join(root, '.env'), Object.entries(config).filter(([, value]) => value !== null).map(([key, value]) => `${key}=${value}\n`).join('') + extra);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/docker'), mockDocker, { mode: 0o755 });
  writeFileSync(join(root, 'bin/docker-compose'), mockCompose, { mode: 0o755 });
  return {
    root,
    run(action = 'validate', env = {}) {
      return spawnSync(shell, ['-c', 'export PATH="$PWD/bin:$PATH"; exec sh ./deploy.sh "$1"', 'test', action], {
        cwd: root, env: { ...process.env, ...env }, encoding: 'utf8',
      });
    },
    calls() { return existsSync(join(root, 'calls.txt')) ? readFileSync(join(root, 'calls.txt'), 'utf8') : ''; },
    config() { return readFileSync(join(root, '.env'), 'utf8'); },
  };
}

test('deploy.sh is valid POSIX shell syntax', { skip: !supported }, () => {
  const result = spawnSync(shell, ['-n', join(template, 'deploy.sh')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('validation accepts literal punctuation without executing password text', { skip: !supported }, t => {
  const f = fixture(t, { ADMIN_PASSWORD: "'$(touch PWNED)$HOME;#LongPassword'" });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(f.root, 'PWNED')), false);
  assert.equal(f.calls(), '', 'validate should not contact Docker');
  assert.ok(!result.stdout.includes('LongPassword'));
});

for (const [name, overrides, extra] of [
  ['missing password', { ADMIN_PASSWORD: null }],
  ['short password', { ADMIN_PASSWORD: 'short' }],
  ['example password', { ADMIN_PASSWORD: "'replace-with-your-own-password'" }],
  ['unquoted substitution', { ADMIN_PASSWORD: '$(touch PWNED)Password' }],
  ['embedded apostrophe', { ADMIN_PASSWORD: "'example'password123'" }],
  ['backslash escape', { ADMIN_PASSWORD: "'example\\\\password123'" }],
  ['unknown shell key', {}, 'BASH_ENV=payload.sh\n'],
  ['duplicate key', {}, 'HOST_PORT=9090\n'],
  ['public address', { LAN_BIND_IP: '8.8.8.8', PUBLIC_ORIGIN: 'http://8.8.8.8:8080' }],
  ['all-interface bind', { LAN_BIND_IP: '0.0.0.0', PUBLIC_ORIGIN: 'http://0.0.0.0:8080' }],
  ['invalid IPv4 octet', { LAN_BIND_IP: '192.168.1.999' }],
  ['leading-zero IPv4 octet', { LAN_BIND_IP: '192.168.001.100' }],
  ['invalid port', { HOST_PORT: '65536' }],
  ['zero port', { HOST_PORT: '0' }],
  ['leading-zero port', { HOST_PORT: '08080' }],
  ['origin mismatch', { PUBLIC_ORIGIN: 'http://192.168.1.100:9090' }],
  ['path in origin', { PUBLIC_ORIGIN: 'http://192.168.1.100:8080/admin' }],
  ['volume argument injection', { DATA_VOLUME: "'--name other'" }],
  ['newline in password', { ADMIN_PASSWORD: "'secret\npassword123'" }],
  ['image command substitution', { NODE_IMAGE: "'$(touch PWNED)'" }],
  ['image shell separator', { NODE_IMAGE: "'node:24;touch PWNED'" }],
  ['image whitespace', { NODE_IMAGE: "'node:24 alpine'" }],
  ['image tab', { NODE_IMAGE: "'node:\t24'" }],
  ['image URL instead of reference', { NODE_IMAGE: 'https://registry.example.com/library/node:24' }],
  ['image empty path component', { NODE_IMAGE: 'registry.example.com//node:24' }],
  ['image invalid registry port', { NODE_IMAGE: 'registry.example.com:65536/node:24' }],
  ['image empty tag', { NODE_IMAGE: 'node:' }],
  ['image option injection', { NODE_IMAGE: '--pull' }],
  ['image parent path', { NODE_IMAGE: 'registry.example.com/../node:24' }],
  ['image multiple digests', { NODE_IMAGE: `node@sha256:${'a'.repeat(64)}@sha256:${'b'.repeat(64)}` }],
  ['image invalid digest', { NODE_IMAGE: 'node@sha256:wrong' }],
  ['image truncated SHA-256 digest', { NODE_IMAGE: `node@sha256:${'a'.repeat(63)}` }],
  ['image reference over 512 characters', { NODE_IMAGE: `registry.example.com/${'a'.repeat(490)}:24` }],
  ['image tag over 128 characters', { NODE_IMAGE: `node:${'a'.repeat(129)}` }],
]) {
  test(`rejects ${name} before Docker is contacted`, { skip: !supported }, t => {
    const f = fixture(t, overrides, extra);
    const result = f.run('start');
    assert.notEqual(result.status, 0);
    assert.equal(f.calls(), '');
    assert.equal(existsSync(join(f.root, 'PWNED')), false);
  });
}

test('inherited shell values cannot override bundle settings', { skip: !supported }, t => {
  const f = fixture(t);
  const result = f.run('start', { HOST_PORT: '7777', LAN_BIND_IP: '8.8.8.8', PUBLIC_ORIGIN: 'http://8.8.8.8:7777', NODE_IMAGE: 'unexpected.example.com/node:changed' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /192\.168\.1\.100:8080/);
  assert.match(f.calls(), /up -d --build\|volume=yingjian-data\|image=public\.ecr\.aws\/docker\/library\/node:24-alpine/);
  assert.ok(!f.calls().includes('unexpected.example.com'));
  assert.ok(!f.calls().includes('Password'), 'the password must never be a command-line argument');
});

for (const image of [
  'node:24-slim',
  'registry.example.com/library/node:24-alpine',
  'registry.example.com:5000/team/node:24.1_Custom',
  '192.168.1.20:5000/node:24-alpine',
  'localhost:5000/team/node:24',
  `node@sha256:${'a'.repeat(64)}`,
  `registry.example.com:5443/library/node:24-alpine@sha256:${'b'.repeat(64)}`,
]) {
  test(`custom base image reaches Compose literally: ${image}`, { skip: !supported }, t => {
    const f = fixture(t, { NODE_IMAGE: image });
    const result = f.run('start', { NODE_IMAGE: 'unexpected.example.com/node:changed' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(f.calls().includes(`|image=${image}\n`));
    assert.ok(!f.calls().includes('unexpected.example.com'));
    assert.ok(!f.calls().includes('--build-arg'), 'the image remains an environment value, not shell command text');
  });
}

test('single-quoted base image and optional empty value match Compose defaults', { skip: !supported }, t => {
  for (const [value, expected] of [["'registry.example.com:5000/node:24'", 'registry.example.com:5000/node:24'], ["''", 'public.ecr.aws/docker/library/node:24-alpine']]) {
    const f = fixture(t, { NODE_IMAGE: value });
    const result = f.run('start');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(f.calls().includes(`|image=${expected}\n`));
  }
});

test('upgrade reuses actual old volume and project, persisting the selection', { skip: !supported }, t => {
  const f = fixture(t);
  const originalPassword = f.config().split('\n')[0];
  const result = f.run('update', { FAKE_CONTAINER: 'yes' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.calls(), /-p legacy build --pull\|volume=legacy_yingjian-data/);
  assert.match(f.config(), /^DATA_VOLUME=legacy_yingjian-data$/m);
  assert.equal(f.config().split('\n')[0], originalPassword);
});

test('conflicting explicit volume does not replace an existing server', { skip: !supported }, t => {
  const f = fixture(t, { DATA_VOLUME: 'another-data' });
  const result = f.run('start', { FAKE_CONTAINER: 'yes' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /differs from the existing server/);
  assert.ok(!f.calls().includes('up -d'));
  assert.match(f.config(), /^DATA_VOLUME=another-data$/m);
});

test('multiple old volumes require explicit selection', { skip: !supported }, t => {
  const f = fixture(t);
  const result = f.run('start', { FAKE_VOLUMES: 'one_yingjian-data\ntwo_yingjian-data' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Multiple previous data volumes/);
  assert.ok(!f.calls().includes('up -d'));
});

test('unrelated bind mount is preserved and upgrade is refused', { skip: !supported }, t => {
  const f = fixture(t);
  const result = f.run('start', { FAKE_CONTAINER: 'yes', FAKE_MOUNT: 'bind:' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported/);
  assert.ok(!f.calls().includes('up -d'));
});

test('stop uses compose stop and never deletes volumes', { skip: !supported }, t => {
  const f = fixture(t);
  const result = f.run('stop', { FAKE_CONTAINER: 'yes' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.calls(), /-p legacy stop\|volume=legacy_yingjian-data/);
  assert.ok(!/\b(down|rm|prune)\b/.test(f.calls()));
});

test('legacy docker-compose is supported when v2 is unavailable', { skip: !supported }, t => {
  const f = fixture(t);
  const result = f.run('start', { FAKE_COMPOSE: 'v1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.calls(), /v1 --env-file .*up -d --build\|volume=yingjian-data/);
});

function setTarget(fixture, platform, composePlatform = platform) {
  writeFileSync(join(fixture.root, 'target-platform.txt'), `${platform}\n`);
  const compose = readFileSync(join(fixture.root, 'docker-compose.yml'), 'utf8');
  writeFileSync(join(fixture.root, 'docker-compose.yml'), compose.replace('  yingjian:\n', `  yingjian:\n    platform: ${composePlatform}\n`));
}

for (const host of ['linux/arm64', 'linux/aarch64']) {
  test(`ARM64 source deploy accepts ${host} and preserves the existing volume`, { skip: !supported }, t => {
    const f = fixture(t);
    setTarget(f, 'linux/arm64');
    const result = f.run('start', { FAKE_PLATFORM: host, FAKE_CONTAINER: 'yes' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(f.calls(), /up -d --build\|volume=legacy_yingjian-data/);
    assert.match(f.config(), /DATA_VOLUME=legacy_yingjian-data/);
  });
}
for (const host of ['linux/amd64', 'linux/x86_64', 'linux/armv7l']) {
  test(`ARM64 source deploy rejects ${host} before changing configuration or containers`, { skip: !supported }, t => {
    const f = fixture(t);
    setTarget(f, 'linux/arm64');
    const previous = f.config();
    const result = f.run('start', { FAKE_PLATFORM: host });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Wrong deployment package|Unsupported NAS platform/);
    assert.equal(f.config(), previous);
    assert.ok(!f.calls().includes('container inspect'));
    assert.ok(!f.calls().includes('up -d'));
  });
}
test('source bundle platform must match Compose before deployment', { skip: !supported }, t => {
  const f = fixture(t);
  setTarget(f, 'linux/arm64', 'linux/amd64');
  const previous = f.config();
  const result = f.run('start', { FAKE_PLATFORM: 'linux/arm64' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Compose platform does not match/);
  assert.equal(f.config(), previous);
  assert.ok(!f.calls().includes('up -d'));
});
test('unknown source target platform is rejected even by configuration validation', { skip: !supported }, t => {
  const f = fixture(t);
  setTarget(f, 'linux/arm/v7');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported target platform/);
  assert.equal(f.calls(), '');
});
