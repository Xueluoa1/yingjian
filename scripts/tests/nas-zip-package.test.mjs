import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { bundleFiles, imageTag, verifyBundle } from '../verify-nas-offline.mjs';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const shell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const supported = process.platform === 'win32' && existsSync(shell);
const bundleName = 'Yingjian-Server-0.1.4-nas1-linux-amd64-Offline';
const digest = value => createHash('sha256').update(value).digest('hex');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

// Deliberately synthetic Docker metadata for packaging tests, never a runtime
// acceptance test or a deliverable image. Every fixture stays in a temporary dir.
function syntheticArchive(architecture = 'amd64') {
  const tag = architecture === 'arm64' ? `${imageTag}-arm64` : imageTag;
  const config = JSON.stringify({ os: 'linux', architecture, config: { User: 'node' } });
  const id = digest(config);
  const entries = [
    ['manifest.json', JSON.stringify([{ Config: `${id}.json`, RepoTags: [tag], Layers: ['layer.tar'] }])],
    [`${id}.json`, config],
    ['layer.tar', 'SYNTHETIC PACKAGING TEST; NOT A RUNNABLE IMAGE'],
  ];
  const parts = [];
  for (const [name, value] of entries) {
    const bytes = Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write(`${header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0')}\0 `, 148);
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return { archive: Buffer.concat([...parts, Buffer.alloc(1024)]), id: `sha256:${id}` };
}

async function fixture(t, { resume = false, architecture = 'amd64' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'yingjian-synthetic-winps-zip-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true });
  });
  const kitRoot = join(root, '映间 中文 空格 工具');
  const runRoot = join(kitRoot, 'output', 'yingjian-image-20261116-000000-fixture');
  const name = `Yingjian-Server-0.1.4-nas1-linux-${architecture}-Offline`;
  const tag = architecture === 'arm64' ? `${imageTag}-arm64` : imageTag;
  const bundle = join(runRoot, name);
  await mkdir(bundle, { recursive: true });
  // These tests inspect packaging bytes; they never execute a Windows launcher.
  // Keep them independent of ignored release binaries on a clean checkout.
  const launcherPath = join(root, 'synthetic-launcher.exe');
  await writeFile(launcherPath, 'SYNTHETIC PACKAGING FIXTURE; NOT AN EXECUTABLE');
  await writeFile(`${launcherPath}.config`, '<configuration/>');
  for (const name of ['docker-compose.yml', '.env.example', 'deploy.sh', 'README.md']) {
    await copyFile(join(sourceRoot, 'deployment/nas-offline', name), join(bundle, name));
  }
  await copyFile(join(sourceRoot, 'THIRD-PARTY.md'), join(bundle, 'THIRD-PARTY.md'));
  if (architecture === 'arm64') {
    const composePath = join(bundle, 'docker-compose.yml');
    const compose = (await readFile(composePath, 'utf8')).replace(`image: ${imageTag}`, `image: ${tag}\n    platform: linux/arm64`);
    await writeFile(composePath, compose);
  }
  const { archive, id } = syntheticArchive(architecture);
  const report = {
    schemaVersion: 1, appVersion: '0.1.4', verificationMode: 'docker-runtime',
    passed: true, verifiedAt: '2026-11-16T00:00:00Z',
    image: { tag, id, platform: `linux/${architecture}` },
    archive: { file: 'image.tar', bytes: archive.length, sha256: digest(archive) },
    checks: { nonRoot: true, health: true, adminLogin: true, staticAssets: true, persistenceRecreate: true, pairing: true },
  };
  await writeFile(join(bundle, 'image.tar'), archive);
  await writeFile(join(bundle, 'verification.json'), JSON.stringify(report));
  await writeFile(join(bundle, 'image-metadata.txt'), `IMAGE_ID=${id}\nIMAGE_PLATFORM=linux/${architecture}\n`);
  await writeFile(join(bundle, 'image.tar.sha256'), `${digest(archive)}  image.tar\n`);
  await verifyBundle(bundle, { writeManifest: true });
  if (resume) {
    await mkdir(join(kitRoot, 'scripts'));
    await mkdir(join(kitRoot, 'runtime'));
    for (const name of ['repack-nas-offline.ps1', 'package-nas-offline.ps1', 'verify-nas-offline.mjs']) {
      await copyFile(join(sourceRoot, 'scripts', name), join(kitRoot, 'scripts', name));
    }
    await copyFile(process.execPath, join(kitRoot, 'runtime/node.exe'));
    // No build input, SSH scripts, NAS configuration or household data exist here.
    assert.equal(existsSync(join(kitRoot, 'build-input.tgz')), false);
    assert.equal(existsSync(join(kitRoot, 'scripts/make-nas-offline.ps1')), false);
  }
  return { root, kitRoot, runRoot, bundle, name, architecture, launcherPath };
}

function runScript(path, parameters = {}) {
  const args = Object.entries(parameters).flatMap(([name, value]) =>
    value === true ? [`-${name}`] : [`-${name}`, quote(value)]);
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "if ($PSVersionTable.PSVersion.Major -ne 5) { throw 'Windows PowerShell 5 is required.' }",
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    `& ${quote(path)} ${args.join(' ')}`,
  ].join('\n');
  // A PowerShell 7 host can prepend its incompatible modules to PSModulePath.
  // Use WinPS's own standard modules, as a fresh CMD-launched WinPS would.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  env.PSModulePath = join(dirname(shell), 'Modules');
  return spawnSync(shell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-OutputFormat', 'Text',
    '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env });
}

function packageBundle(f, destination = f.runRoot) {
  return runScript(join(sourceRoot, 'scripts/package-nas-offline.ps1'), {
    VerifiedBundle: f.bundle, DestinationRoot: destination, NodePath: process.execPath,
  });
}

function needSuccess(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

// Read the actual ZIP central directory and inflate each entry with Node, so the
// verification is independent of the PowerShell ZIP writer being tested.
function zipEntries(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'ZIP end-of-central-directory record must exist.');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const original = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    assert.equal(bytes.readUInt32LE(localOffset), 0x04034b50);
    const dataOffset = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    const payload = bytes.subarray(dataOffset, dataOffset + compressed);
    assert.ok(method === 0 || method === 8, 'ZIP must use supported storage/deflate.');
    const contents = method === 0 ? payload : inflateRawSync(payload);
    assert.equal(contents.length, original, name);
    assert.equal(entries.has(name), false, `Duplicate ZIP entry: ${name}`);
    entries.set(name, contents);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function checkArchive(f, archive) {
  const bytes = await readFile(archive);
  const entries = zipEntries(bytes);
  const expected = [...bundleFiles, 'manifest.json'];
  assert.deepEqual([...entries.keys()].sort(), expected.map(name => `${f.name}/${name}`).sort());
  for (const name of expected) {
    assert.deepEqual(entries.get(`${f.name}/${name}`), await readFile(join(f.bundle, name)), name);
  }
  assert.equal(await readFile(`${archive}.sha256`, 'utf8'), `${digest(bytes)}  ${f.name}.zip\n`);
  assert.equal(existsSync(`${archive}.partial`), false);
}

test('fresh Windows PowerShell 5.1 packages a verified synthetic bundle at a Chinese spaced path', { skip: !supported }, async t => {
  const f = await fixture(t);
  const result = packageBundle(f);
  needSuccess(result);
  assert.equal(JSON.parse(result.stdout).Image.tag, imageTag);
  await checkArchive(f, join(f.runRoot, `${bundleName}.zip`));
});

for (const suffix of ['.zip', '.zip.partial']) {
  test(`package refuses to overwrite an existing ${suffix}`, { skip: !supported }, async t => {
    const f = await fixture(t);
    const existing = join(f.runRoot, `${bundleName}${suffix}`);
    const sentinel = Buffer.from('keep this existing output unchanged');
    await writeFile(existing, sentinel);
    const result = packageBundle(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Output already exists/);
    assert.deepEqual(await readFile(existing), sentinel);
    assert.equal(existsSync(join(f.runRoot, `${bundleName}.zip.sha256`)), false);
  });
}

test('package rejects a household .env without publishing a ZIP', { skip: !supported }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.bundle, '.env'), 'ADMIN_PASSWORD=synthetic-do-not-package');
  const result = packageBundle(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected file.*\.env/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /synthetic-do-not-package/);
  assert.equal(existsSync(join(f.runRoot, `${bundleName}.zip`)), false);
  assert.equal(existsSync(join(f.runRoot, `${bundleName}.zip.partial`)), false);
});

test('local recovery discovers one downloaded bundle without NAS build input', { skip: !supported }, async t => {
  const f = await fixture(t, { resume: true });
  needSuccess(runScript(join(f.kitRoot, 'scripts/repack-nas-offline.ps1'), { NoOpenFolder: true }));
  await checkArchive(f, join(f.runRoot, `${bundleName}.zip`));
});

for (const suffix of ['.zip', '.zip.partial']) {
  test(`local recovery preserves ${suffix} and creates an independent repacked directory`, { skip: !supported }, async t => {
    const f = await fixture(t, { resume: true });
    const existing = join(f.runRoot, `${bundleName}${suffix}`);
    const sentinel = Buffer.from('previous result must remain unchanged');
    await writeFile(existing, sentinel);
    needSuccess(runScript(join(f.kitRoot, 'scripts/repack-nas-offline.ps1'), {
      VerifiedBundle: f.bundle, NoOpenFolder: true,
    }));
    assert.deepEqual(await readFile(existing), sentinel);
    const recovered = (await readdir(f.runRoot, { withFileTypes: true })).filter(item => item.isDirectory() && item.name.startsWith('repacked-'));
    assert.equal(recovered.length, 1);
    await checkArchive(f, join(f.runRoot, recovered[0].name, `${bundleName}.zip`));
  });
}

test('local recovery does not silently select among multiple downloaded bundles', { skip: !supported }, async t => {
  const f = await fixture(t, { resume: true });
  const other = join(f.kitRoot, 'output', 'yingjian-image-other-fixture', bundleName);
  await mkdir(other, { recursive: true });
  await copyFile(join(f.bundle, 'image.tar'), join(other, 'image.tar'));
  await copyFile(join(f.bundle, 'verification.json'), join(other, 'verification.json'));
  const result = runScript(join(f.kitRoot, 'scripts/repack-nas-offline.ps1'), { NoOpenFolder: true });
  assert.notEqual(result.status, 0, 'A noninteractive call must stop when user selection is required.');
  assert.equal(existsSync(join(f.runRoot, `${bundleName}.zip`)), false);
  assert.equal(existsSync(join(other, '..', `${bundleName}.zip`)), false);
});

test('ARM64 synthetic package keeps its architecture in name, image tag and ZIP contents', { skip: !supported }, async t => {
  const f = await fixture(t, { architecture: 'arm64' });
  const result = packageBundle(f);
  needSuccess(result);
  const packageReport = JSON.parse(result.stdout);
  assert.equal(packageReport.Image.platform, 'linux/arm64');
  assert.equal(packageReport.Image.tag, `${imageTag}-arm64`);
  await checkArchive(f, join(f.runRoot, `${f.name}.zip`));
  assert.equal(existsSync(join(f.runRoot, `${bundleName}.zip`)), false);
});

test('local recovery discovers and packages an ARM64 bundle without build input', { skip: !supported }, async t => {
  const f = await fixture(t, { resume: true, architecture: 'arm64' });
  needSuccess(runScript(join(f.kitRoot, 'scripts/repack-nas-offline.ps1'), { NoOpenFolder: true }));
  await checkArchive(f, join(f.runRoot, `${f.name}.zip`));
  assert.equal(existsSync(join(f.runRoot, `${bundleName}.zip`)), false);
});

for (const [architecture, wrongParameter] of [['amd64', 'NasArm64OfflineBundle'], ['arm64', 'NasOfflineBundle']]) {
  test(`Windows packager refuses ${architecture} image in the wrong architecture slot before writing`, { skip: !supported }, async t => {
    const f = await fixture(t, { architecture });
    const output = join(f.root, 'wrong-architecture-output');
    const result = runScript(join(sourceRoot, 'scripts/package-server.ps1'), {
      DestinationRoot: output,
      LauncherPath: f.launcherPath,
      [wrongParameter]: f.bundle,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /platform|architecture|verification failed/i);
    assert.equal(existsSync(output), false);
  });
}

test('Windows packager keeps two synthetic architecture bundles in independent directories', { skip: !supported }, async t => {
  const amd64 = await fixture(t);
  const arm64 = await fixture(t, { architecture: 'arm64' });
  const output = join(amd64.root, 'dual-image-windows');
  const result = runScript(join(sourceRoot, 'scripts/package-server.ps1'), {
    DestinationRoot: output,
    LauncherPath: amd64.launcherPath,
    NasOfflineBundle: amd64.bundle,
    NasArm64OfflineBundle: arm64.bundle,
  });
  needSuccess(result);
  const archive = JSON.parse(result.stdout).Archive;
  const entries = zipEntries(await readFile(archive));
  const packagePrefix = 'Yingjian-Server-0.1.4-Windows/';
  assert.equal(entries.has(`${packagePrefix}deployment/nas-offline/image.tar`), false);
  for (const f of [amd64, arm64]) {
    for (const name of [...bundleFiles, 'manifest.json']) {
      assert.deepEqual(entries.get(`${packagePrefix}deployment/nas-offline/${f.architecture}/${name}`), await readFile(join(f.bundle, name)));
    }
  }
  const guide = entries.get(`${packagePrefix}先读我.txt`).toString('utf8');
  assert.match(guide, /linux\/amd64、linux\/arm64/);
  assert.match(guide, /没有该架构镜像时明确导出源码部署包/);
});
