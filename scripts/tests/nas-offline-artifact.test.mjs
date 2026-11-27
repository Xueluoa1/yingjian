import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageTag, verifyBundle } from '../verify-nas-offline.mjs';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function tar(entries) {
  const parts = [];
  for (const [name, value] of entries) {
    const data = Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

async function fixture(t, { user = 'node', platform = 'linux/amd64', architecture = platform.split('/')[1], includeLayer = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'yingjian-synthetic-archive-test-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())));
    await rm(directory, { recursive: true });
  });
  for (const name of ['docker-compose.yml', '.env.example', 'deploy.sh', 'README.md']) {
    await cp(join(root, 'deployment/nas-offline', name), join(directory, name));
  }
  await cp(join(root, 'THIRD-PARTY.md'), join(directory, 'THIRD-PARTY.md'));
  const tag = platform === 'linux/arm64' ? `${imageTag}-arm64` : imageTag;
  if (platform === 'linux/arm64') {
    const compose = await readFile(join(directory, 'docker-compose.yml'), 'utf8');
    await writeFile(join(directory, 'docker-compose.yml'), compose.replace(`image: ${imageTag}`, `image: ${tag}\n    platform: linux/arm64`));
  }
  const config = JSON.stringify({ os: 'linux', architecture, config: { User: user } });
  const id = digest(config);
  // This is a deliberately synthetic archive fixture, never a release/runtime test.
  const entries = [
    ['manifest.json', JSON.stringify([{ Config: `${id}.json`, RepoTags: [tag], Layers: ['layer.tar'] }])],
    [`${id}.json`, config],
    ...(includeLayer ? [['layer.tar', 'synthetic layer fixture']] : []),
  ];
  const archive = tar(entries);
  await writeFile(join(directory, 'image.tar'), archive);
  const report = {
    schemaVersion: 1, appVersion: '0.1.4', verificationMode: 'docker-runtime', passed: true, verifiedAt: '2026-11-16T00:00:00Z',
    image: { tag, id: `sha256:${id}`, platform },
    archive: { file: 'image.tar', sha256: digest(archive), bytes: archive.length },
    checks: { nonRoot: true, health: true, adminLogin: true, staticAssets: true, persistenceRecreate: true },
  };
  const saveReport = () => writeFile(join(directory, 'verification.json'), JSON.stringify(report));
  await saveReport();
  await writeFile(join(directory, 'image-metadata.txt'), `IMAGE_ID=sha256:${id}\nIMAGE_PLATFORM=${platform}\n`);
  await writeFile(join(directory, 'image.tar.sha256'), `${digest(archive)}  image.tar\n`);
  return { directory, report, saveReport };
}

test('validates archive structure and repeatable manifests using a synthetic fixture', async t => {
  const f = await fixture(t);
  assert.equal((await verifyBundle(f.directory, { writeManifest: true })).ok, true);
  assert.equal((await verifyBundle(f.directory)).ok, true);
});
for (const check of ['nonRoot', 'health', 'adminLogin', 'staticAssets', 'persistenceRecreate']) {
  test(`requires runtime report check ${check}`, async t => {
    const f = await fixture(t);
    f.report.checks[check] = false;
    await f.saveReport();
    await assert.rejects(verifyBundle(f.directory, { writeManifest: true }), /did not pass/);
  });
}
test('source-only directory cannot become a release', async () => {
  await assert.rejects(verifyBundle(join(root, 'deployment/nas-offline')), /Unexpected file|ENOENT/);
});
test('rejects modified archive even with its separate checksum file changed', async t => {
  const f = await fixture(t);
  const path = join(f.directory, 'image.tar');
  const changed = Buffer.concat([await readFile(path), Buffer.from('corruption')]);
  await writeFile(path, changed);
  await writeFile(join(f.directory, 'image.tar.sha256'), `${digest(changed)}  image.tar\n`);
  await assert.rejects(verifyBundle(f.directory, { writeManifest: true }), /differs from the verified export/);
});
for (const [name, options, expected] of [
  ['root user', { user: 'root' }, /non-root/],
  ['ARM64 image', { architecture: 'arm64' }, /linux\/amd64/],
  ['missing layer', { includeLayer: false }, /layers are incomplete/],
]) {
  test(`rejects ${name} regardless of report assertions`, async t => {
    const f = await fixture(t, options);
    await assert.rejects(verifyBundle(f.directory, { writeManifest: true }), expected);
  });
}
test('rejects stale deployment files and excludes household secrets', async t => {
  const f = await fixture(t);
  await verifyBundle(f.directory, { writeManifest: true });
  await writeFile(join(f.directory, 'README.md'), 'Changed after verification');
  await assert.rejects(verifyBundle(f.directory), /checksum mismatch: README/);
  await writeFile(join(f.directory, '.env'), 'ADMIN_PASSWORD=must-not-be-in-generic-bundle');
  await assert.rejects(verifyBundle(f.directory), /Unexpected file.*\.env/);
});
test('rejects source-building Compose in an offline release', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'docker-compose.yml'), 'services:\n  yingjian:\n    build: .\n');
  await assert.rejects(verifyBundle(f.directory, { writeManifest: true }), /without build\/pull/);
});

test('ARM64 archive and CLI validate only for their declared platform (synthetic fixture)', async t => {
  const f = await fixture(t, { platform: 'linux/arm64' });
  const result = spawnSync(process.execPath, [join(root, 'scripts/verify-nas-offline.mjs'), f.directory, '--platform', 'linux/arm64', '--write-manifest'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).image.tag, `${imageTag}-arm64`);
  assert.equal((await verifyBundle(f.directory, { platform: 'linux/arm64' })).ok, true);
  await assert.rejects(verifyBundle(f.directory, { platform: 'linux/amd64' }), /does not match requested/);
});
for (const replacement of ['', '    platform: linux/amd64\n']) {
  test(`ARM64 requires matching Compose platform: ${replacement.trim() || 'absent'}`, async t => {
    const f = await fixture(t, { platform: 'linux/arm64' });
    const path = join(f.directory, 'docker-compose.yml');
    await writeFile(path, (await readFile(path, 'utf8')).replace('    platform: linux/arm64\n', replacement));
    await assert.rejects(verifyBundle(f.directory, { writeManifest: true }), /Compose platform/);
  });
}
test('ARM64 report cannot relabel an AMD64 archive', async t => {
  const f = await fixture(t, { platform: 'linux/arm64', architecture: 'amd64' });
  await assert.rejects(verifyBundle(f.directory, { writeManifest: true }), /Archive must be linux\/arm64/);
});
