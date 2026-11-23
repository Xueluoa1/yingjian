import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { format } from 'node:util';
import { listen } from '../server/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const options = { port: Number(process.env.PORT || 8080), dataDir: resolve(process.env.DATA_DIR || resolve(root, 'data')), host: '0.0.0.0' };
const consoleMode = args.includes('--console');
let service;
let stopping;
let stopRequested = false;

function emit(type, fields = {}) {
  if (process.stdout.destroyed) return;
  const event = { type, ...fields };
  if (consoleMode) {
    const text = type === 'ready' ? `映间服务端已启动：http://127.0.0.1:${fields.port}/?view=server\n数据目录：${fields.dataDir}\n按 Ctrl+C 停止服务。`
      : type === 'stopped' ? '映间服务端已停止，数据已保存。'
        : fields.message || '';
    if (text) process.stdout.write(text + '\n');
  } else process.stdout.write(JSON.stringify(event) + '\n');
}

async function stop(exitCode = 0) {
  stopRequested = true;
  if (!service) return;
  if (stopping) return stopping;
  stopping = (async () => {
    try {
      await service.close();
      emit('stopped');
    } catch (error) {
      emit('error', { message: error.message });
      exitCode = 1;
    }
    // Pending upstream tasks cannot write after shutdown and lock release.
    process.exit(exitCode);
  })();
  return stopping;
}

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
process.stdout.on('error', error => { if (error.code === 'EPIPE') void stop(); });
if (!consoleMode) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    if (line.length > 1024) { emit('error', { message: '控制消息过长' }); return; }
    try {
      const message = JSON.parse(line);
      if (message.command === 'shutdown') void stop();
      else emit('error', { message: '不支持的控制命令' });
    } catch { emit('error', { message: '控制消息格式不正确' }); }
  });
  // Only the launcher that owns this pipe can stop its child.
  input.on('close', () => void stop());
}

try {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--console') continue;
    if (!['--port', '--data-dir', '--host'].includes(arg) || !args[index + 1]) throw new Error(`不支持的启动参数：${arg}`);
    const value = args[++index];
    if (arg === '--port') options.port = Number(value);
    if (arg === '--data-dir') options.dataDir = resolve(value);
    if (arg === '--host') options.host = value;
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('端口必须是 1–65535 的整数');
  if (!['127.0.0.1', '0.0.0.0'].includes(options.host)) throw new Error('不支持此监听地址');
  // The embedded server's normal console output also follows the launcher protocol.
  console.log = (...values) => emit('log', { message: format(...values) });
  console.error = (...values) => emit('log', { message: format(...values) });
  service = await listen(options);
  emit('ready', { port: service.server.address().port, pid: process.pid, dataDir: options.dataDir });
  if (stopRequested) await stop();
} catch (error) {
  emit('error', { message: error.code === 'EADDRINUSE' ? `端口 ${options.port} 已被占用。请使用现有服务，或先停止它。` : error.message });
  process.exit(1);
}
