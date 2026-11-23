import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, request } from 'undici';
import ipaddr from 'ipaddr.js';

export function normalizeIP(value = '') {
  try { return ipaddr.process(value.split('%')[0]).toString(); } catch { return ''; }
}

export function isLocalIP(value) {
  try {
    return ['loopback', 'private', 'uniqueLocal', 'linkLocal'].includes(ipaddr.process(value.split('%')[0]).range());
  } catch { return false; }
}

export function isLoopback(value) {
  try { return ipaddr.process(value.split('%')[0]).range() === 'loopback'; } catch { return false; }
}

export function httpURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入完整的 HTTP 或 HTTPS 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持不含用户名密码的 HTTP / HTTPS 地址');
  if (url.href.length > 8192) throw new Error('地址过长');
  url.hash = '';
  return url;
}

function allowedAddress(address, allowPrivate) {
  try {
    const range = ipaddr.process(address).range();
    return range === 'unicast' || (allowPrivate && ['private', 'uniqueLocal', 'loopback'].includes(range));
  } catch { return false; }
}

// Resolve and pin every redirect hop independently; never trust a second DNS lookup.
export async function safeRequest(input, options = {}) {
  let target = httpURL(input);
  const { allowPrivate = false, headers = {}, signal, timeout = 15000 } = options;
  for (let hop = 0; hop <= 5; hop += 1) {
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    const records = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await dns.lookup(hostname, { all: true, verbatim: true });
    if (!records.length || records.some(record => !allowedAddress(record.address, allowPrivate))) throw new Error('片源地址指向受保护的网络地址；局域网片源需由服务端显式开启');
    const selected = records.find(record => record.family === 4) || records[0];
    const dispatcher = new Agent({ connect: {
      timeout: Math.min(timeout, 10000),
      lookup: (_name, lookupOptions, callback) => lookupOptions.all
        ? callback(null, [selected]) : callback(null, selected.address, selected.family),
    } });
    let result;
    try {
      result = await request(target, {
        method: 'GET', dispatcher, maxRedirections: 0, headersTimeout: timeout, bodyTimeout: timeout, signal,
        headers: { 'user-agent': 'Yingjian-LAN/0.1', 'accept-encoding': 'identity', ...headers },
      });
    } catch (error) { await dispatcher.close(); throw error; }
    // Undici emits RequestAbortedError when an unread body is deliberately discarded
    // (redirects, HTTP errors, oversized responses). Consumers still receive errors
    // through iteration/pipeline; this listener also covers those discarded bodies.
    result.body.on('error', () => {});
    if ([301, 302, 303, 307, 308].includes(result.statusCode) && result.headers.location) {
      result.body.destroy();
      await dispatcher.close();
      if (hop === 5) throw new Error('片源重定向次数过多');
      target = httpURL(new URL(result.headers.location, target).href);
      continue;
    }
    let cleaned = false;
    const cleanup = async () => { if (!cleaned) { cleaned = true; await dispatcher.close(); } };
    result.body.once('end', () => { void cleanup(); });
    result.body.once('close', () => { void cleanup(); });
    return { ...result, url: target.href, cleanup };
  }
}

export async function readLimited(response, maximum = 8 * 1024 * 1024) {
  const length = Number(response.headers['content-length'] || 0);
  if (length > maximum) { response.body.destroy(); throw new Error('片源响应超过大小限制'); }
  const parts = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maximum) throw new Error('片源响应超过大小限制');
      parts.push(chunk);
    }
    return Buffer.concat(parts).toString('utf8');
  } finally { response.body.destroy(); await response.cleanup(); }
}

export function networkError(error) {
  if (['AbortError', 'TimeoutError'].includes(error.name) || /timeout/i.test(error.code || '')) return '片源请求超时，请稍后重试';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(error.code)) return '无法解析片源域名';
  if (error.code === 'ECONNREFUSED') return '片源拒绝连接';
  return String(error.message || '片源暂不可用').slice(0, 240);
}
