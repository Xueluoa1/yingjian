// Export reviewable source without publishing or changing Git metadata.
import {execFileSync} from 'node:child_process';
import {access, chmod, lstat, mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, process.argv[2] || 'release/github/yingjian');
const releaseRoot = resolve(root, 'release');
if (!destination.startsWith(releaseRoot + sep)) throw new Error('Output must be a new directory under release/.');
const reportPath = `${destination}.manifest.json`;
for (const path of [destination, reportPath]) {
  try { await access(path); throw new Error(`Output already exists: ${path}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

const folders = new Set(['server', 'public', 'launcher', 'player', 'android', 'deployment', 'config', 'scripts', 'tests', 'ui', 'docs', '.github']);
const topFiles = new Set(['package.json', 'package-lock.json', 'Dockerfile', 'docker-compose.yml', '.dockerignore', '.env.example', '.gitignore', '.gitattributes', '.editorconfig', 'start-windows.cmd', 'README.md', 'THIRD-PARTY.md', 'API-CONTRACT.md', 'AUTHORS.md', 'LICENSE', 'LICENSE.md', 'CONTRIBUTING.md', 'SECURITY.md']);
const forbidden = /(^|\/)(node_modules|data|release|test-results|deliverables|build|\.git|\.gradle|\.gradle-home|\.android-user|\.signing|\.agents|\.codex|\.aws)(\/|$)|(^|\/)(household\.json|local\.properties|launcher-settings\.json)$|\.(jks|keystore|p12|pfx|key|pem|exe|apk|aab|zip|tar|7z|log)$/i;
const secretPatterns = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /sk-[A-Za-z0-9_-]{24,}/,
];
const list = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {cwd:root, encoding:'utf8', maxBuffer:16*1024*1024});
const files = [...new Set(list.split('\0').filter(Boolean))].sort();
const records = [], excluded = [], approved = [];
for (const file of files) {
  const normalized = file.replaceAll('\\', '/');
  if (isAbsolute(file) || normalized.split('/').includes('..')) throw new Error(`Invalid source path: ${file}`);
  if (!topFiles.has(normalized) && !folders.has(normalized.split('/')[0])) { excluded.push(normalized); continue; }
  if (forbidden.test(normalized) || /(^|\/)\.env(?:\.|$)/.test(normalized) && !normalized.endsWith('/.env.example') && normalized!=='.env.example') throw new Error(`Sensitive/generated path in source list: ${normalized}`);
  const source = resolve(root, file), stat = await lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Only regular source files are supported: ${normalized}`);
  if (stat.size>25*1024*1024) throw new Error(`File exceeds source export limit (25 MiB): ${normalized}`);
  let bytes = await readFile(source);
  const binary = /\.(png|jpe?g|webp|ico|jar|woff2?|ttf)$/i.test(normalized);
  if (!binary) {
    let content = bytes.toString('utf8');
    if (secretPatterns.some(pattern=>pattern.test(content))) throw new Error(`Possible secret found; inspect locally: ${normalized}`);
    const credentialUrls=content.match(/https?:\/\/[^\s/"']+:[^\s/@"']+@[^\s"']+/g)||[];
    // This exact negative-test fixture is intentionally rejected by the Android parser.
    const allowedFixture='http://'+'name:password@'+'192.168.1.1:8080';
    if (credentialUrls.some(url=>normalized!=='android/tests/ServerAddressTest.java'||url!==allowedFixture)) throw new Error(`Credential-bearing URL found; inspect locally: ${normalized}`);
    // PS 5.1 needs a BOM for non-ASCII source; Linux shell scripts need LF.
    content=content.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
    if (/\.(cmd|bat|ps1)$/i.test(normalized)) content=content.replace(/\n/g,'\r\n');
    if (/\.ps1$/i.test(normalized)) content='\uFEFF'+content;
    bytes=Buffer.from(content,'utf8');
  }
  approved.push({file:normalized,bytes});
}
for (const required of ['package.json','package-lock.json','README.md','server/index.js','public/index.html','android/gradlew','android/gradle/wrapper/gradle-wrapper.jar','android/app/libs/zxing-core-3.5.3.jar','.github/workflows/ci.yml']) {
  if (!approved.some(entry=>entry.file===required)) throw new Error(`Missing required source: ${required}`);
}
await mkdir(destination,{recursive:true});
for (const {file,bytes} of approved) {
  const target=resolve(destination,file);
  await mkdir(dirname(target),{recursive:true});
  await writeFile(target,bytes);
  if (file.endsWith('.sh')||file==='android/gradlew') await chmod(target,0o755);
  records.push({path:file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
const report={repository:'yingjian',author:'雪落a',fileCount:records.length,totalBytes:records.reduce((sum,item)=>sum+item.bytes,0),source:relative(root,destination).replaceAll('\\','/'),license:approved.some(item=>/^LICENSE(?:\.md)?$/.test(item.file))?'See LICENSE':'Not selected by author',secretCheck:'No matches for configured patterns; this is not a comprehensive secret audit',excluded,files:records};
await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({directory:destination,manifest:reportPath,fileCount:report.fileCount,totalBytes:report.totalBytes},null,2));
