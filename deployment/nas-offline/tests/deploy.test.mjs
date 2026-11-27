import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Docker executable is a test double. These tests do not certify an image.
const template = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const supported = existsSync(shell);
const imageId = `sha256:${'a'.repeat(64)}`;
const otherId = `sha256:${'b'.repeat(64)}`;
const defaults = {
  ADMIN_PASSWORD: "'Local$Password#2026'",
  LAN_BIND_IP: '192.168.1.100',
  HOST_PORT: '8080',
  PUBLIC_ORIGIN: 'http://192.168.1.100:8080',
  DATA_VOLUME: 'yingjian-data',
};
const mockDocker = `#!/bin/sh
printf '%s|volume=%s|origin=%s|oldbase=%s\\n' "$*" "\${DATA_VOLUME:-}" "\${PUBLIC_ORIGIN:-}" "\${NODE_IMAGE:-}" >> calls.txt
case "$1:$2" in
  info:)
    [ "\${FAKE_DOCKER_DOWN:-}" != yes ]; exit $? ;;
  info:--format)
    printf '%s\\n' "\${FAKE_HOST_PLATFORM:-linux/x86_64}"; exit 0 ;;
  compose:version)
    [ "\${FAKE_COMPOSE:-v2}" = v2 ]; exit $? ;;
  container:inspect)
    if [ "\${3:-}" != --format ]; then
      [ "\${FAKE_CONTAINER:-}" = yes ] || [ -f started ]; exit $?
    fi
    case "$4" in
      *Mounts*) printf '%s\\n' "\${FAKE_MOUNT:-volume:legacy_yingjian-data}" ;;
      *compose.project*) printf '%s\\n' "\${FAKE_PROJECT:-legacy}" ;;
      *compose.service*) printf '%s\\n' "\${FAKE_SERVICE:-yingjian}" ;;
      *State.Status*) printf '%s\\n' "\${FAKE_HEALTH:-running:healthy}" ;;
      *) exit 1 ;;
    esac
    exit 0 ;;
  volume:ls)
    printf '%s\\n' "\${FAKE_VOLUMES:-}"; exit 0 ;;
  image:inspect)
    if [ -f loaded ]; then
      id="\${FAKE_LOADED_ID:-$FAKE_IMAGE_ID}"
    else
      id="\${FAKE_CURRENT_ID:-}"
    fi
    [ -n "$id" ] || exit 1
    case "$4" in
      *Architecture*) printf '%s %s\\n' "$id" "\${FAKE_IMAGE_PLATFORM:-linux/amd64}" ;;
      *) printf '%s\\n' "$id" ;;
    esac
    exit 0 ;;
  load:--input)
    [ "\${FAKE_LOAD_FAILURE:-}" != yes ] || exit 1
    touch loaded
    exit 0 ;;
  compose:--env-file)
    case "$*" in
      *" config --quiet") [ "\${FAKE_CONFIG_FAILURE:-}" != yes ]; exit $? ;;
      *" up -d --no-build --pull never")
        [ "\${FAKE_UP_FAILURE:-}" != yes ] || exit 1
        touch started ;;
      *" stop"|*" ps") ;;
      *) exit 1 ;;
    esac
    exit 0 ;;
esac
exit 1
`;

function fixture(t, overrides = {}, extra = '') {
  const root = mkdtempSync(join(tmpdir(), 'yingjian-nas-offline-test-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true });
  });
  for (const file of ['deploy.sh', 'docker-compose.yml']) copyFileSync(join(template, file), join(root, file));
  const config = { ...defaults, ...overrides };
  writeFileSync(join(root, '.env'), Object.entries(config).filter(([, value]) => value !== null).map(([key, value]) => `${key}=${value}\n`).join('') + extra);
  writeFileSync(join(root, 'image-metadata.txt'), `IMAGE_ID=${imageId}\nIMAGE_PLATFORM=linux/amd64\n`);
  const archive = Buffer.from('This is a mock archive. It is not a Docker image.\n');
  writeFileSync(join(root, 'image.tar'), archive);
  writeFileSync(join(root, 'image.tar.sha256'), `${createHash('sha256').update(archive).digest('hex')}  image.tar\n`);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/docker'), mockDocker, { mode: 0o755 });
  writeFileSync(join(root, 'bin/sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return {
    root,
    write(name, value) { writeFileSync(join(root, name), value); },
    remove(name) { rmSync(join(root, name)); },
    run(action = 'start', env = {}) {
      return spawnSync(shell, ['-c', 'export PATH="$PWD/bin:$PATH"; exec sh ./deploy.sh "$1"', 'test', action], {
        cwd: root, env: { ...process.env, FAKE_IMAGE_ID: imageId, ...env }, encoding: 'utf8', timeout: 20_000,
      });
    },
    calls() { return existsSync(join(root, 'calls.txt')) ? readFileSync(join(root, 'calls.txt'), 'utf8') : ''; },
    config() { return readFileSync(join(root, '.env'), 'utf8'); },
  };
}

test('offline script has valid POSIX shell syntax', { skip: !supported }, () => {
  const result = spawnSync(shell, ['-n', join(template, 'deploy.sh')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('GUI Compose uses only the fixed application image and forbids remote pulls', () => {
  const compose = readFileSync(join(template, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /^\s+image: yingjian-server:0\.1\.4-nas1$/m);
  assert.match(compose, /^\s+pull_policy: never$/m);
  assert.doesNotMatch(compose, /^\s+build:|NODE_IMAGE|privileged:|network_mode:/m);
});

test('validate checks configuration without contacting Docker or executing values', { skip: !supported }, t => {
  const f = fixture(t, { ADMIN_PASSWORD: "'$(touch PWNED)$HOME;#Password2026'" });
  const result = f.run('validate');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls(), '');
  assert.equal(existsSync(join(f.root, 'PWNED')), false);
  assert.doesNotMatch(result.stdout, /Password2026/);
  assert.match(result.stdout, /actual container startup are checked by start or update/);
});

for (const [name, overrides, extra] of [
  ['missing password', { ADMIN_PASSWORD: null }],
  ['short password', { ADMIN_PASSWORD: 'short' }],
  ['example password', { ADMIN_PASSWORD: "'replace-with-your-own-password'" }],
  ['unquoted substitution', { ADMIN_PASSWORD: '$(touch PWNED)Password' }],
  ['apostrophe', { ADMIN_PASSWORD: "'example'password123'" }],
  ['backslash', { ADMIN_PASSWORD: "'example\\\\password123'" }],
  ['unknown environment key', {}, 'BASH_ENV=payload.sh\n'],
  ['duplicate key', {}, 'HOST_PORT=9090\n'],
  ['public IP', { LAN_BIND_IP: '8.8.8.8', PUBLIC_ORIGIN: 'http://8.8.8.8:8080' }],
  ['all interfaces', { LAN_BIND_IP: '0.0.0.0', PUBLIC_ORIGIN: 'http://0.0.0.0:8080' }],
  ['bad IPv4 octet', { LAN_BIND_IP: '192.168.1.999' }],
  ['leading-zero octet', { LAN_BIND_IP: '192.168.001.100' }],
  ['oversized port', { HOST_PORT: '65536' }],
  ['zero port', { HOST_PORT: '0' }],
  ['leading-zero port', { HOST_PORT: '08080' }],
  ['mismatched origin', { PUBLIC_ORIGIN: 'http://192.168.1.100:8081' }],
  ['origin path', { PUBLIC_ORIGIN: 'http://192.168.1.100:8080/admin' }],
  ['volume argument injection', { DATA_VOLUME: "'--name another'" }],
  ['volume over 128 characters', { DATA_VOLUME: 'a'.repeat(129) }],
  ['newline in password', { ADMIN_PASSWORD: "'secret\npassword123'" }],
]) {
  test(`rejects ${name} before contacting Docker`, { skip: !supported }, t => {
    const f = fixture(t, overrides, extra);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(f.calls(), '');
    assert.equal(existsSync(join(f.root, 'PWNED')), false);
  });
}

for (const [name, contents] of [
  ['duplicate ID', `IMAGE_ID=${imageId}\nIMAGE_ID=${otherId}\nIMAGE_PLATFORM=linux/amd64\n`],
  ['missing ID', 'IMAGE_PLATFORM=linux/amd64\n'],
  ['truncated ID', 'IMAGE_ID=sha256:abcdef\nIMAGE_PLATFORM=linux/amd64\n'],
  ['unexpected key', `IMAGE_ID=${imageId}\nIMAGE_PLATFORM=linux/amd64\nIMAGE_TAG=other:latest\n`],
  ['command substitution', 'IMAGE_ID=$(touch PWNED)\nIMAGE_PLATFORM=linux/amd64\n'],
  ['unreleased platform', `IMAGE_ID=${imageId}\nIMAGE_PLATFORM=linux/arm64\n`],
]) {
  test(`rejects metadata with ${name} before contacting Docker`, { skip: !supported }, t => {
    const f = fixture(t);
    f.write('image-metadata.txt', contents);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(f.calls(), '');
    assert.equal(existsSync(join(f.root, 'PWNED')), false);
  });
}

test('source template without release metadata cannot be deployed', { skip: !supported }, t => {
  const f = fixture(t);
  f.remove('image-metadata.txt');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a complete offline release/);
  assert.equal(f.calls(), '');
});

test('first install checks integrity, imports the application, and waits for health', { skip: !supported }, t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.calls(), /load --input .*image\.tar/);
  assert.match(f.calls(), /up -d --no-build --pull never/);
  assert.match(result.stdout, /Server is healthy: http:\/\/192\.168\.1\.100:8080/);
  assert.doesNotMatch(f.calls(), /(?:^|\n)(?:pull|build) | --build(?:\s|\|)| build --pull/);
  assert.doesNotMatch(f.calls(), /Password/);
});

test('the same image is reused without another load', { skip: !supported }, t => {
  const f = fixture(t);
  const result = f.run('start', { FAKE_CURRENT_ID: imageId });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(f.calls(), /load --input/);
  assert.match(f.calls(), /up -d --no-build --pull never/);
});

test('an old image at the same tag is replaced by the included image', { skip: !supported }, t => {
  const f = fixture(t);
  const result = f.run('update', { FAKE_CURRENT_ID: otherId });
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.calls(), /load --input/);
  assert.match(f.calls(), /up -d --no-build --pull never/);
});

test('old NODE_IMAGE is ignored and inherited variables cannot override settings', { skip: !supported }, t => {
  const f = fixture(t, { NODE_IMAGE: "'$(touch PWNED)'" });
  const result = f.run('start', {
    HOST_PORT: '7777', LAN_BIND_IP: '8.8.8.8', PUBLIC_ORIGIN: 'http://8.8.8.8:7777',
    DATA_VOLUME: 'wrong-volume', NODE_IMAGE: 'unexpected.example/node:24',
    IMAGE_ID: otherId, IMAGE_PLATFORM: 'linux/arm64', COMPOSE_PROJECT_NAME: 'wrong-project',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(f.root, 'PWNED')), false);
  assert.match(f.calls(), /volume=yingjian-data\|origin=http:\/\/192\.168\.1\.100:8080\|oldbase=\n/);
  assert.doesNotMatch(f.calls(), /unexpected\.example|wrong-project|wrong-volume/);
});

test('upgrade preserves the existing project, actual data volume, and password line', { skip: !supported }, t => {
  const f = fixture(t);
  const passwordLine = f.config().split('\n')[0];
  const result = f.run('update', { FAKE_CONTAINER: 'yes' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.calls(), /-p legacy up -d --no-build --pull never\|volume=legacy_yingjian-data/);
  assert.match(f.config(), /^DATA_VOLUME=legacy_yingjian-data$/m);
  assert.equal(f.config().split('\n')[0], passwordLine);
  assert.doesNotMatch(f.calls(), /\b(?:down|prune|rm)\b/);
});

test('a unique old volume is reused after its container was removed', { skip: !supported }, t => {
  const f = fixture(t);
  const result = f.run('start', { FAKE_VOLUMES: 'previous_yingjian-data' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.config(), /^DATA_VOLUME=previous_yingjian-data$/m);
  assert.match(f.calls(), /up -d --no-build --pull never\|volume=previous_yingjian-data/);
});

for (const [name, environment] of [
  ['conflicting explicit volume', { FAKE_CONTAINER: 'yes' }],
  ['unsupported bind mount', { FAKE_CONTAINER: 'yes', FAKE_MOUNT: 'bind:' }],
  ['unrelated service', { FAKE_CONTAINER: 'yes', FAKE_SERVICE: 'unrelated' }],
  ['invalid old project', { FAKE_CONTAINER: 'yes', FAKE_PROJECT: 'bad project' }],
  ['oversized detected volume', { FAKE_CONTAINER: 'yes', FAKE_MOUNT: `volume:${'a'.repeat(129)}` }],
  ['multiple old volumes', { FAKE_VOLUMES: 'one_yingjian-data\ntwo_yingjian-data' }],
  ['legacy Compose only', { FAKE_COMPOSE: 'v1' }],
  ['invalid Compose file', { FAKE_CONFIG_FAILURE: 'yes' }],
  ['ARM NAS with AMD64 release', { FAKE_HOST_PLATFORM: 'linux/aarch64' }],
]) {
  test(`${name} cannot import an image or update a container`, { skip: !supported }, t => {
    const f = fixture(t, name === 'conflicting explicit volume' ? { DATA_VOLUME: 'another-data' } : {});
    const configBefore = f.config();
    const result = f.run('update', environment);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(f.calls(), /load --input|up -d/);
    assert.equal(f.config(), configBefore);
  });
}

for (const [name, mutate] of [
  ['missing archive', f => f.remove('image.tar')],
  ['missing checksum', f => f.remove('image.tar.sha256')],
  ['changed archive', f => f.write('image.tar', 'incomplete transfer')],
  ['checksum path traversal', f => f.write('image.tar.sha256', `${'a'.repeat(64)}  ../another.tar\n`)],
  ['multiple checksum records', f => f.write('image.tar.sha256', `${'a'.repeat(64)}  image.tar\n${'a'.repeat(64)}  image.tar\n`)],
  ['empty checksum', f => f.write('image.tar.sha256', '')],
]) {
  test(`${name} cannot import an image or update a container`, { skip: !supported }, t => {
    const f = fixture(t);
    const configBefore = f.config();
    mutate(f);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(f.calls(), /load --input|up -d/);
    assert.equal(f.config(), configBefore);
  });
}

for (const [name, environment] of [
  ['archive with a mismatched image ID', { FAKE_LOADED_ID: otherId }],
  ['archive with a mismatched platform', { FAKE_IMAGE_PLATFORM: 'linux/arm64' }],
  ['Docker load failure', { FAKE_LOAD_FAILURE: 'yes' }],
]) {
  test(`${name} cannot replace the existing container`, { skip: !supported }, t => {
    const f = fixture(t);
    const configBefore = f.config();
    const result = f.run('update', { FAKE_CONTAINER: 'yes', ...environment });
    assert.notEqual(result.status, 0);
    assert.match(f.calls(), /load --input/);
    assert.doesNotMatch(f.calls(), /up -d/);
    assert.equal(f.config(), configBefore);
  });
}

for (const state of ['restarting:none', 'exited:unhealthy', 'running:unhealthy', 'running:none', 'running:starting']) {
  test(`does not report startup success when container state is ${state}`, { skip: !supported }, t => {
    const f = fixture(t);
    const result = f.run('start', { FAKE_HEALTH: state });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /health|healthy/);
    assert.doesNotMatch(result.stdout, /Server is healthy/);
  });
}

test('a failed up is not reported as successful startup', { skip: !supported }, t => {
  const f = fixture(t);
  const result = f.run('start', { FAKE_UP_FAILURE: 'yes' });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /Server is healthy/);
});

for (const action of ['stop', 'status']) {
  test(`${action} works without re-importing the archive and preserves data`, { skip: !supported }, t => {
    const f = fixture(t);
    f.remove('image.tar');
    const result = f.run(action, { FAKE_CONTAINER: 'yes' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(f.calls(), new RegExp(`-p legacy ${action === 'stop' ? 'stop' : 'ps'}\\|volume=legacy_yingjian-data`));
    assert.doesNotMatch(f.calls(), /load --input|\b(?:down|prune|rm)\b/);
  });
}

function armBundle(f) {
  f.write('image-metadata.txt', `IMAGE_ID=${imageId}\nIMAGE_PLATFORM=linux/arm64\n`);
  const compose = readFileSync(join(f.root, 'docker-compose.yml'), 'utf8');
  f.write('docker-compose.yml', compose.replace('image: yingjian-server:0.1.4-nas1', 'image: yingjian-server:0.1.4-nas1-arm64\n    platform: linux/arm64'));
}
for (const host of ['linux/aarch64', 'linux/arm64']) {
  test(`ARM64 update on ${host} uses matching tag and preserves original volume (mock Docker)`, { skip: !supported }, t => {
    const f = fixture(t);
    armBundle(f);
    const result = f.run('update', { FAKE_HOST_PLATFORM: host, FAKE_IMAGE_PLATFORM: 'linux/arm64', FAKE_CONTAINER: 'yes' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(f.calls(), /yingjian-server:0\.1\.4-nas1-arm64/);
    assert.match(f.calls(), /-p legacy up -d --no-build --pull never\|volume=legacy_yingjian-data/);
  });
}
for (const host of ['linux/x86_64', 'linux/amd64', 'linux/armv7l']) {
  test(`ARM64 bundle refuses ${host} without imports or config changes (mock Docker)`, { skip: !supported }, t => {
    const f = fixture(t);
    armBundle(f);
    const before = f.config();
    assert.notEqual(f.run('update', { FAKE_HOST_PLATFORM: host }).status, 0);
    assert.doesNotMatch(f.calls(), /load --input|up -d/);
    assert.equal(f.config(), before);
  });
}
test('ARM64 metadata rejects AMD64 Compose before Docker access', { skip: !supported }, t => {
  const f = fixture(t);
  f.write('image-metadata.txt', `IMAGE_ID=${imageId}\nIMAGE_PLATFORM=linux/arm64\n`);
  assert.notEqual(f.run().status, 0);
  assert.equal(f.calls(), '');
});
