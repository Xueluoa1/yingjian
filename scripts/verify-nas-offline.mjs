import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const imageTag = 'yingjian-server:0.1.4-nas1';
export const bundleFiles = [
  'image.tar', 'image-metadata.txt', 'image.tar.sha256', 'verification.json',
  'docker-compose.yml', '.env.example', 'deploy.sh', 'README.md', 'THIRD-PARTY.md',
];
const requiredChecks = ['nonRoot', 'health', 'adminLogin', 'staticAssets', 'persistenceRecreate'];
function need(value, message) { if (!value) throw new Error(message); }
async function sha256(path) {
  const digest = createHash('sha256');
  for await (const data of createReadStream(path)) digest.update(data);
  return digest.digest('hex');
}

// Read only the Docker save manifest/config. Never extract archive paths.
async function inspectArchive(path, expectedId) {
  const file = await open(path, 'r');
  try {
    const { size: total } = await file.stat();
    const entries = new Map();
    let offset = 0, nextName;
    async function textAt(start, size) {
      need(size <= 2 * 1024 * 1024, 'Oversized archive metadata.');
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, start);
      need(bytesRead === size, 'Truncated image archive.');
      return buffer;
    }
    while (offset + 512 <= total) {
      const header = await textAt(offset, 512);
      if (header.every(byte => byte === 0)) break;
      const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
      const sizeText = field(124, 136).trim();
      need(/^[0-7]+$/.test(sizeText), 'Unsupported TAR size encoding.');
      const size = parseInt(sizeText, 8);
      need(Number.isSafeInteger(size) && offset + 512 + size <= total, 'Truncated image archive.');
      const expectedSum = parseInt(field(148, 156).trim(), 8);
      const actualSum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      need(expectedSum === actualSum, 'Invalid TAR header checksum.');
      const type = field(156, 157);
      let name = nextName || [field(345, 500), field(0, 100)].filter(Boolean).join('/');
      nextName = undefined;
      if (type === 'L') nextName = (await textAt(offset + 512, size)).toString('utf8').replace(/\0.*$/s, '');
      else if (type === 'x') {
        const pax = await textAt(offset + 512, size);
        let cursor = 0;
        while (cursor < pax.length) {
          const space = pax.indexOf(32, cursor);
          need(space > cursor, 'Invalid PAX record.');
          const length = Number(pax.subarray(cursor, space).toString());
          need(Number.isSafeInteger(length) && length > space - cursor + 1 && cursor + length <= pax.length, 'Invalid PAX record length.');
          const record = pax.subarray(space + 1, cursor + length - 1).toString('utf8');
          if (record.startsWith('path=')) nextName = record.slice(5);
          cursor += length;
        }
      } else if (type === '0' || type === '') {
        name = name.replace(/^\.\//, '');
        need(!name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..'), 'Unsafe TAR path.');
        need(!entries.has(name), 'Duplicate TAR entry.');
        entries.set(name, { offset: offset + 512, size });
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    const manifestEntry = entries.get('manifest.json');
    need(manifestEntry, 'Archive is not a Docker save archive (manifest.json missing).');
    const manifest = JSON.parse((await textAt(manifestEntry.offset, manifestEntry.size)).toString('utf8'));
    need(Array.isArray(manifest) && manifest.length === 1, 'Archive must contain exactly one application image.');
    const image = manifest[0];
    need(Array.isArray(image.RepoTags) && image.RepoTags.includes(imageTag), 'Archive application tag does not match.');
    const configEntry = entries.get(image.Config);
    need(configEntry, 'Image config missing from archive.');
    const configBytes = await textAt(configEntry.offset, configEntry.size);
    need(`sha256:${createHash('sha256').update(configBytes).digest('hex')}` === expectedId, 'Archive image ID does not match verification.');
    const config = JSON.parse(configBytes.toString('utf8'));
    need(config.os === 'linux' && config.architecture === 'amd64', 'Archive must be linux/amd64.');
    need(config.config?.User && !/^(?:root|0)(?::|$)/.test(config.config.User), 'Image must run as a non-root user.');
    need(Array.isArray(image.Layers) && image.Layers.length > 0 && image.Layers.every(layer => entries.has(layer)), 'Archive image layers are incomplete.');
  } finally { await file.close(); }
}

export async function verifyBundle(directory, { writeManifest = false } = {}) {
  const root = resolve(directory);
  const allowed = new Set([...bundleFiles, 'manifest.json']);
  for (const name of await readdir(root)) need(allowed.has(name), `Unexpected file in generic offline bundle: ${name}`);
  const files = {};
  for (const name of bundleFiles) {
    const path = join(root, name);
    const stat = await lstat(path);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, `Missing or unsafe bundle file: ${name}`);
    files[name] = { bytes: stat.size, sha256: await sha256(path) };
  }
  const report = JSON.parse(await readFile(join(root, 'verification.json'), 'utf8'));
  need(report.schemaVersion === 1 && report.appVersion === '0.1.4', 'Unsupported image verification report.');
  need(report.verificationMode === 'docker-runtime' && report.passed === true, 'Actual Docker runtime verification is required.');
  need(typeof report.verifiedAt === 'string' && Number.isFinite(Date.parse(report.verifiedAt)), 'Missing verification timestamp.');
  need(report.image?.tag === imageTag && report.image.platform === 'linux/amd64' && /^sha256:[a-f0-9]{64}$/.test(report.image.id), 'Invalid verified image identity.');
  for (const name of requiredChecks) need(report.checks?.[name] === true, `Container verification did not pass: ${name}`);
  need(report.archive?.file === 'image.tar' && report.archive.bytes === files['image.tar'].bytes && report.archive.sha256 === files['image.tar'].sha256, 'Image archive differs from the verified export.');
  const expectedMetadata = `IMAGE_ID=${report.image.id}\nIMAGE_PLATFORM=linux/amd64\n`;
  need(await readFile(join(root, 'image-metadata.txt'), 'utf8') === expectedMetadata, 'Image metadata mismatch.');
  need(await readFile(join(root, 'image.tar.sha256'), 'utf8') === `${files['image.tar'].sha256}  image.tar\n`, 'Image checksum file mismatch.');
  for (const name of ['docker-compose.yml', 'deploy.sh', '.env.example']) {
    const text = await readFile(join(root, name), 'utf8');
    need(!text.includes('\r') && !text.startsWith('\uFEFF'), `${name} must use UTF-8 without BOM and LF.`);
  }
  const compose = await readFile(join(root, 'docker-compose.yml'), 'utf8');
  need(/^\s+image: yingjian-server:0\.1\.4-nas1\s*$/m.test(compose) && /^\s+pull_policy: never\s*$/m.test(compose) && !/^\s+build:/m.test(compose), 'Compose must use only the included image, without build/pull.');
  await inspectArchive(join(root, 'image.tar'), report.image.id);
  const manifest = { schemaVersion: 1, appVersion: report.appVersion, image: report.image, verifiedAt: report.verifiedAt, files };
  if (writeManifest) {
    const path = join(root, 'manifest.json');
    const existing = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    need(!existing || existing.isFile() && !existing.isSymbolicLink(), 'Unsafe manifest output.');
    await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', { flag: 'w' });
  } else {
    const stat = await lstat(join(root, 'manifest.json'));
    need(stat.isFile() && !stat.isSymbolicLink(), 'Unsafe bundle manifest.');
    const saved = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    need(saved.schemaVersion === 1 && JSON.stringify(saved.image) === JSON.stringify(report.image) && saved.verifiedAt === report.verifiedAt, 'Manifest image identity mismatch.');
    need(Object.keys(saved.files || {}).length === bundleFiles.length, 'Manifest file list mismatch.');
    for (const name of bundleFiles) need(saved.files[name]?.sha256 === files[name].sha256 && saved.files[name]?.bytes === files[name].bytes, `Manifest checksum mismatch: ${name}`);
  }
  return { ok: true, image: report.image, verifiedAt: report.verifiedAt, bytes: files['image.tar'].bytes, files: [...bundleFiles, 'manifest.json'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    need(process.argv.length >= 3 && process.argv.length <= 4 && (!process.argv[3] || process.argv[3] === '--write-manifest'), 'Usage: node verify-nas-offline.mjs BUNDLE [--write-manifest]');
    console.log(JSON.stringify(await verifyBundle(process.argv[2], { writeManifest: process.argv[3] === '--write-manifest' })));
  } catch (error) { console.error(`Offline release validation failed: ${error.message}`); process.exitCode = 1; }
}
