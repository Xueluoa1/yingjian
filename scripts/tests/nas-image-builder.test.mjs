import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const mock = `#!/bin/sh
printf '%s\\n' "$*" >> calls.txt
case "$1:\${2:-}" in
  info:) [ "\${FAIL_AT:-}" != engine ]; exit $? ;;
  info:--format) printf '%s\\n' "\${MOCK_HOST:-linux/x86_64}"; exit 0 ;;
  build:*) [ "\${FAIL_AT:-}" != build ]; exit $? ;;
  image:inspect) printf 'sha256:${'a'.repeat(64)} %s\\n' "\${MOCK_IMAGE:-linux/amd64}"; exit 0 ;;
  volume:inspect|container:inspect) exit 1 ;;
  volume:create) touch volume-created; exit 0 ;;
  create:*) touch container-created; exit 0 ;;
  start:*) exit 0 ;;
  inspect:*) printf '%s\\n' "\${TEST_STATE:-running:healthy}"; exit 0 ;;
  exec:*) case "$*" in
    *SMOKE_PHASE=prepare*) [ "\${FAIL_AT:-}" != login ]; exit $? ;;
    *SMOKE_PHASE=restore*) [ "\${FAIL_AT:-}" != persistence ]; exit $? ;;
    *) exit 9 ;;
    esac ;;
  stop:*|container:rm|volume:rm|image:rm|tag:*) exit 0 ;;
  logs:*) printf 'mock container startup failed\\n'; exit 0 ;;
  save:--output) printf 'synthetic archive fixture\\n' > "$3"; exit 0 ;;
  run:*) exit 1 ;;
esac
exit 9
`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'yingjian-builder-failure-test-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true });
  });
  for (const folder of ['scripts', 'deployment/nas', 'deployment/nas-offline', 'bin']) mkdirSync(join(root, folder), { recursive: true });
  for (const name of ['build-nas-image.sh', 'nas-image-smoke.mjs', 'verify-nas-offline.mjs']) copyFileSync(join(sourceRoot, 'scripts', name), join(root, 'scripts', name));
  for (const name of ['docker-compose.yml', '.env.example', 'deploy.sh', 'README.md']) copyFileSync(join(sourceRoot, 'deployment/nas-offline', name), join(root, 'deployment/nas-offline', name));
  copyFileSync(join(sourceRoot, 'deployment/nas/Dockerfile'), join(root, 'deployment/nas/Dockerfile'));
  copyFileSync(join(sourceRoot, 'THIRD-PARTY.md'), join(root, 'THIRD-PARTY.md'));
  writeFileSync(join(root, 'bin/docker'), mock, { mode: 0o755 });
  return {
    run(env, architecture) { return spawnSync(shell, ['-c', 'export PATH="$PWD/bin:$PATH"; exec sh scripts/build-nas-image.sh output ${1:+"$1"}', 'test', architecture || ''], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' }); },
    calls() { return readFileSync(join(root, 'calls.txt'), 'utf8'); },
    hasRelease() { return ['amd64', 'arm64'].some(arch => existsSync(join(root, `output/Yingjian-Server-0.1.4-nas1-linux-${arch}-Offline`))); },
  };
}
for (const stage of ['engine', 'build', 'login', 'persistence', 'archive-verifier']) {
  test(`${stage} failure cannot publish an offline image (mock Docker)`, { skip: !existsSync(shell) }, t => {
    const f = fixture(t);
    const result = f.run({ FAIL_AT: stage });
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(f.hasRelease(), false);
    const calls = f.calls();
    assert.doesNotMatch(calls, /yingjian-lan|yingjian-data|prune|compose/);
    if (stage !== 'archive-verifier') assert.doesNotMatch(calls, /^save /m);
    for (const line of calls.split('\n').filter(line => /^(container rm|volume rm) /.test(line))) {
      assert.match(line, /yingjian-image-check-[a-zA-Z0-9]+$/);
    }
    if (stage === 'persistence' || stage === 'archive-verifier') assert.equal(calls.split('\n').filter(line => line.startsWith('create ')).length, 2, 'Persistence verification must recreate the container.');
    if (stage !== 'engine' && stage !== 'build') assert.match(calls, /--network none/);
  });
}
test('unhealthy startup stops before login and export (mock Docker)', { skip: !existsSync(shell) }, t => {
  const f = fixture(t);
  const result = f.run({ TEST_STATE: 'exited:unhealthy' });
  assert.notEqual(result.status, 0);
  assert.equal(f.hasRelease(), false);
  assert.doesNotMatch(f.calls(), /^exec |^save /m);
  assert.match(result.stderr, /Test container failed/);
});

for (const [host, architecture] of [['linux/aarch64', undefined], ['linux/x86_64', 'arm64']]) {
  test(`ARM64 pipeline passes target to build and execution on ${host} (mock Docker)`, { skip: !existsSync(shell) }, t => {
    const f = fixture(t);
    const result = f.run({ MOCK_HOST: host, MOCK_IMAGE: 'linux/arm64' }, architecture);
    assert.notEqual(result.status, 0, 'Mock archive verifier must prevent publishing.');
    assert.equal(f.hasRelease(), false);
    const calls = f.calls();
    assert.match(calls, /^build --platform linux\/arm64 /m);
    assert.equal(calls.split('\n').filter(line => /^create --platform linux\/arm64 /.test(line)).length, 2);
    assert.match(calls, /^run --rm --platform linux\/arm64 .* --platform linux\/arm64$/m);
    assert.match(calls, /yingjian-server:0\.1\.4-nas1-arm64/);
  });
}
test('wrong built architecture stops before creating test resources (mock Docker)', { skip: !existsSync(shell) }, t => {
  const f = fixture(t);
  const result = f.run({}, 'arm64');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected built image platform/);
  assert.doesNotMatch(f.calls(), /^volume create|^create |^save /m);
  assert.equal(f.hasRelease(), false);
});
