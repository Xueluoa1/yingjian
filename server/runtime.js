import { mkdir, open, readFile, rmdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

export const DATA_LOCK_NAME = '.yingjian-server.lock';
const processStartedAt = Math.round(Date.now() - process.uptime() * 1000);
const locked = directory => Object.assign(new Error(`数据目录正在使用或存在未确认的锁：${directory}。请先停止使用该目录的服务；异常退出后若仍提示此错误，请确认原服务已停止再移除 ${DATA_LOCK_NAME} 目录。`), { code: 'EDATALOCKED' });

async function readOwner(directory) {
  try {
    const owner = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'));
    return Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string' && owner.token.length >= 32 ? owner : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export async function linuxProcessIdentity(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const [bootId, processStat] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);
    // The command name is parenthesized and can contain spaces or ')'.
    // The remaining fields begin at state (field 3); starttime is field 22.
    const tail = processStat.slice(processStat.lastIndexOf(') ') + 2).trim().split(/\s+/);
    const identity = { bootId: bootId.trim(), startTime: tail[19] };
    return validLinuxIdentity(identity) ? identity : null;
  } catch { return null; }
}

function validLinuxIdentity(value) {
  return value && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value.bootId) && /^\d+$/.test(value.startTime);
}

export async function canRecoverDataLock(owner, { machine = hostname(), isAlive = processAlive, readIdentity = linuxProcessIdentity } = {}) {
  // A shared NAS volume can be visible in different containers/machines.
  // Never decide that a foreign owner's PID is dead using our own PID namespace.
  if (!owner || owner.hostname !== machine) return false;
  if (!isAlive(owner.pid)) return true;
  if (!validLinuxIdentity(owner.linuxIdentity)) return false;
  const current = await readIdentity(owner.pid);
  // PID 1 is reused on container restarts; PID existence alone is insufficient.
  // A matching hostname plus boot/start identity proves it is a new process.
  return Boolean(validLinuxIdentity(current) && (current.bootId !== owner.linuxIdentity.bootId || current.startTime !== owner.linuxIdentity.startTime));
}

async function removeStale(directory) {
  const previous = await readOwner(directory);
  if (!await canRecoverDataLock(previous)) return false;
  const previousStat = await stat(directory);
  const guardPath = join(directory, 'cleanup');
  let guard;
  try { guard = await open(guardPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST' || error.code === 'ENOENT') return false;
    throw error;
  }
  let removed = false;
  try {
    const current = await readOwner(directory);
    const currentStat = await stat(directory);
    if (!current || current.token !== previous.token || currentStat.ino !== previousStat.ino || currentStat.dev !== previousStat.dev || !await canRecoverDataLock(current)) return false;
    await unlink(join(directory, 'owner.json'));
    removed = true;
  } finally {
    await guard.close();
    await unlink(guardPath);
  }
  if (removed) await rmdir(directory);
  return removed;
}

/** Acquire before opening the store; only recover an owner proven to be gone. */
export async function lockDataDirectory(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const directory = join(dataDir, DATA_LOCK_NAME);
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await mkdir(directory); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await removeStale(directory)) continue;
      throw locked(dataDir);
    }
    const owner = { pid: process.pid, hostname: hostname(), processStartedAt, linuxIdentity: await linuxProcessIdentity(process.pid), token: randomBytes(24).toString('hex'), acquiredAt: new Date().toISOString() };
    try {
      const file = await open(join(directory, 'owner.json'), 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(owner)); }
      finally { await file.close(); }
    } catch (error) {
      // Incomplete locks are intentionally retained if writing failed:
      // removing an unverified directory could remove another process's lock.
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      const current = await readOwner(directory);
      if (!current || current.token !== owner.token) throw locked(dataDir);
      await unlink(join(directory, 'owner.json'));
      await rmdir(directory);
      released = true;
    };
  }
  throw locked(dataDir);
}

/** Wait for clients to disconnect; bound lingering media streams and idle sockets. */
export async function closeHttpServer(server, timeoutMs = 8000) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => server.closeAllConnections(), timeoutMs);
    timeout.unref();
    server.close(error => {
      clearTimeout(timeout);
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    });
  });
}
