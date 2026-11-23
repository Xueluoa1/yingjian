import express from 'express';
import QRCode from 'qrcode';
import { randomBytes, randomInt, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { networkInterfaces, hostname } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { createServer } from 'node:http';
import { openStore } from './store.js';
import { lockDataDirectory, closeHttpServer } from './runtime.js';
import { safeRequest, readLimited, httpURL, isLocalIP, isLoopback, normalizeIP, networkError } from './network.js';
import { createMedia, cleanText, rewritePlaylist, categoryName } from './media.js';
import { createCatalog } from './catalog.js';
import { groupKeyFor, sameWork, mergeCatalogItems, searchTitle } from './identity.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '0.1.4';
const COOKIE = 'yingjian_session';
const SESSION_AGE = 30 * 86400000;
const PAIR_AGE = 10 * 60000;
const hash = text => createHash('sha256').update(String(text)).digest('hex');
const identifier = () => randomBytes(12).toString('hex');
const equal = (left, right) => {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const number = (value, max = Number.MAX_SAFE_INTEGER) => Math.min(max, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0));
const kinds = new Set(['phone', 'tv', 'desktop']);
const short = (value, max = 120) => cleanText(value, max);
function sourceURL(value) {
  try { return httpURL(value).href; }
  catch (error) { throw fail(400, error.message); }
}

function advertisedOrigin(value, configuredNames) {
  if (!value) return null;
  const parsed = httpURL(value);
  const name = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const localName = name === 'localhost' || /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(name) || /^[a-z\d.-]+\.(?:local|lan|home\.arpa)$/i.test(name);
  if (parsed.pathname !== '/' || parsed.search || (isIP(name) ? !isLocalIP(name) : !localName && !configuredNames.includes(name))) {
    throw new Error('PUBLIC_ORIGIN 必须是局域网 HTTP / HTTPS 根地址，例如 http://192.168.1.100:8080；自定义域名请同时设置 SERVER_HOSTNAME');
  }
  return parsed.origin;
}
async function mapLimit(items, concurrency, work) {
  const output = Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; output[index] = await work(items[index]); }
  }));
  return output;
}

export async function createApp(options = {}) {
  const app = express();
  const store = await openStore(resolve(options.dataDir || process.env.DATA_DIR || join(ROOT, 'data')));
  const { state } = store;
  if (store.fresh) {
    let initial = options.initialSources;
    if (initial === undefined) {
      try { initial = JSON.parse(await readFile(join(ROOT, 'config/initial-sources.json'), 'utf8')).sources; }
      catch (error) { if (error.code !== 'ENOENT') throw error; initial = []; }
    }
    state.sources = (initial || []).slice(0, 50).map(source => ({ ...source, id: short(source.id, 100) || identifier(), name: short(source.name, 80), type: source.type === 'live' ? 'live' : 'vod', url: httpURL(source.url).href, enabled: source.enabled !== false }));
    await store.save();
  }
  const boot = Date.now();
  const allowPrivate = options.allowPrivateUpstream ?? process.env.ALLOW_PRIVATE_SOURCES === '1';
  const adminPassword = options.adminPassword ?? process.env.ADMIN_PASSWORD;
  const configuredNames = [...(options.hostnames || []), ...(process.env.SERVER_HOSTNAME || '').split(',')].map(value => value.trim().toLowerCase()).filter(Boolean);
  const publicOrigin = advertisedOrigin(options.publicOrigin ?? process.env.PUBLIC_ORIGIN, configuredNames);
  const grants = new Map();
  const attempts = new Map();
  const detailCache = new Map();
  const liveCache = new Map();
  let pairing = null;
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.locals.store = store;
  app.locals.close = () => store.flush();

  function localAddresses() {
    return Object.values(networkInterfaces()).flat().filter(item => item && !item.internal && item.family === 'IPv4' && isLocalIP(item.address)).map(item => item.address);
  }
  function addresses(req) {
    const port = req.socket.localPort;
    return [...new Set([...(publicOrigin ? [publicOrigin] : []), ...[...localAddresses(), '127.0.0.1'].map(address => `http://${address}:${port}`)])];
  }
  function hostAllowed(req) {
    let parsed;
    try { parsed = new URL(`http://${req.headers.host}`); } catch { return false; }
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
    // A Docker port mapping can advertise a different host and port from this socket.
    if (publicOrigin && parsed.host === new URL(publicOrigin).host) return true;
    if (Number(parsed.port || 80) !== req.socket.localPort) return false;
    const name = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const names = new Set(['localhost', hostname().toLowerCase(), ...configuredNames]);
    const ips = new Set(['127.0.0.1', '::1', ...Object.values(networkInterfaces()).flat().filter(Boolean).map(item => normalizeIP(item.address))]);
    return names.has(name) || ips.has(normalizeIP(name));
  }
  function session(req) {
    const raw = req.headers.cookie?.split(';').map(cookie => cookie.trim()).find(cookie => cookie.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!raw || raw.length > 160) return null;
    const record = state.sessions.find(value => value.hash === hash(raw) && value.expiresAt > Date.now());
    if (!record) return null;
    const device = state.devices.find(value => value.id === record.deviceId);
    return device ? { record, device, role: record.role } : null;
  }
  function publicDevice(device) {
    return { ...device, online: Date.now() - new Date(device.lastSeen).getTime() < 60000 };
  }
  function limitAttempts(key, maximum = 10) {
    const previous = attempts.get(key);
    const attempt = previous && previous.until > Date.now() ? previous : { count: 0, until: Date.now() + 60000 };
    if (attempt.count >= maximum) throw fail(429, '尝试次数过多，请一分钟后重试');
    attempt.count += 1; attempts.set(key, attempt);
    if (attempts.size > 2000) for (const [id, value] of attempts) if (value.until < Date.now()) attempts.delete(id);
  }
  const auth = (req, _res, next) => { if (!req.auth) return next(fail(401, '请先连接家庭服务端')); next(); };
  const admin = (req, _res, next) => { if (req.auth?.role !== 'admin') return next(fail(403, '此操作需要服务端管理权限')); next(); };
  async function issueSession(res, device, role) {
    const token = randomBytes(32).toString('base64url');
    state.sessions = state.sessions.filter(value => value.expiresAt > Date.now());
    state.sessions.push({ hash: hash(token), deviceId: device.id, role, expiresAt: Date.now() + SESSION_AGE });
    await store.save();
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_AGE });
  }
  function sourceById(id, enabled = false) {
    const source = state.sources.find(value => value.id === id);
    if (!source) throw fail(404, '片源不存在');
    if (enabled && !source.enabled) throw fail(400, '该片源已停用');
    return source;
  }
  function playbackSettings(device) {
    const saved = device.playbackSettings || {};
    const source = state.sources.find(value => value.id === saved.sourceId && value.enabled && value.type === 'vod');
    return { sourceId: source?.id || '', autoNext: saved.autoNext === true };
  }
  function clearUnavailableSelections() {
    for (const device of state.devices) {
      if (device.playbackSettings) device.playbackSettings = playbackSettings(device);
    }
  }
  function browseSources(req) {
    const selected = req.query.sourceId || playbackSettings(req.auth.device).sourceId;
    if (!selected) return state.sources;
    const source = sourceById(String(selected), true);
    if (source.type !== 'vod') throw fail(400, '请选择点播片源');
    return [source];
  }
  function sourceSummary() {
    const enabled = state.sources.filter(source => source.enabled);
    const measured = enabled.filter(source => typeof source.health?.ok === 'boolean');
    const healthy = measured.filter(source => source.health.ok);
    const latencies = healthy.map(source => source.health.latency).filter(value => Number.isFinite(value) && value >= 0);
    const live = enabled.filter(source => source.type === 'live');
    const cached = live.map(source => liveCache.get(source.id)).filter(value => value?.expires > Date.now());
    return {
      sourceHealth: { total: state.sources.length, enabled: enabled.length,
        vod: state.sources.filter(source => source.type === 'vod').length, enabledVod: enabled.filter(source => source.type === 'vod').length,
        live: state.sources.filter(source => source.type === 'live').length, enabledLive: live.length,
        measured: measured.length, healthy: healthy.length, failed: measured.length - healthy.length, unknown: enabled.length - measured.length,
        averageLatencyMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null },
      liveChannels: { count: cached.reduce((sum, value) => sum + value.data.length, 0), loadedSources: cached.length, totalSources: live.length, known: cached.length === live.length },
    };
  }
  function sign(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encoded}.${createHmac('sha256', state.secret).update(encoded).digest('base64url')}`;
  }
  function verify(token) {
    if (typeof token !== 'string' || token.length > 14000) throw fail(403, '资源签名无效');
    const [encoded, signature, extra] = token.split('.');
    if (extra || !signature || !equal(createHmac('sha256', state.secret).update(encoded).digest('base64url'), signature)) throw fail(403, '资源签名无效');
    let value;
    try { value = JSON.parse(Buffer.from(encoded, 'base64url').toString()); } catch { throw fail(403, '资源签名无效'); }
    if (value.e < Date.now()) throw fail(403, '播放地址已过期，请重新打开影片');
    return value;
  }
  function safePoster(value) {
    if (typeof value !== 'string' || value.length > 14000 || !value.startsWith('/api/image?t=')) return '';
    try { return verify(value.slice('/api/image?t='.length)).k === 'image' ? value : ''; }
    catch { return ''; }
  }
  const imageURL = url => `/api/image?t=${sign({ k: 'image', u: url, e: Date.now() + 7 * 86400000 })}`;
  const media = createMedia({ allowPrivate, imageURL });
  const catalog = createCatalog(media, options.catalog);
  function unchangedSource(source, requested) {
    if (!state.sources.includes(source) || source.url !== requested.url || source.type !== requested.type) throw fail(409, '片源已修改，请重新加载');
    if (!source.enabled) throw fail(400, '该片源已停用');
  }
  async function detail(source, id) {
    const key = `${source.id}:${id}`;
    const cached = detailCache.get(key);
    if (cached?.expires > Date.now() && cached.url === source.url) return cached.data;
    const requested = { ...source };
    const data = await media.detail(requested, id);
    unchangedSource(source, requested);
    if (detailCache.size > 200) detailCache.clear();
    detailCache.set(key, { data, url: requested.url, expires: Date.now() + 30000 });
    return data;
  }
  function groupedDetail(data) {
    const groupKey = groupKeyFor(data.item);
    const variants = mergeCatalogItems([data.item, ...catalog.variants(groupKey, state.sources)])[0]?.variants || [data.item];
    return { ...data, item: { ...data.item, groupKey, variants } };
  }
  async function channels(source) {
    const cached = liveCache.get(source.id);
    if (cached?.expires > Date.now() && cached.url === source.url) return cached.data;
    const requested = { ...source };
    const data = await media.live(requested);
    unchangedSource(source, requested);
    liveCache.set(source.id, { data, url: requested.url, expires: Date.now() + 30000 });
    return data;
  }

  app.use((req, res, next) => {
    if (!isLocalIP(req.socket.remoteAddress)) return res.status(403).json({ error: '此服务仅接受局域网连接' });
    if (!hostAllowed(req)) return res.status(403).json({ error: '服务地址不受信任，请使用实际局域网 IP 地址访问' });
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: http: https:; connect-src 'self' http: https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    const requestOrigin = publicOrigin && req.headers.host === new URL(publicOrigin).host ? publicOrigin : `http://${req.headers.host}`;
    if (req.headers.origin && req.headers.origin !== requestOrigin) return res.status(403).json({ error: '跨站请求已拒绝' });
    if (req.path.startsWith('/api/')) {
      res.set('Cache-Control', 'no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-yingjian'] !== '1') return res.status(403).json({ error: '请求缺少安全校验标记' });
      if (req.method === 'OPTIONS') return res.sendStatus(403);
    }
    req.auth = session(req);
    next();
  });
  app.use(express.json({ limit: '96kb' }));

  app.get('/api/status', (req, res) => res.json({ name: '映间', version: VERSION, paired: Boolean(req.auth), role: req.auth?.role || null,
    device: req.auth ? publicDevice(req.auth.device) : null, addresses: addresses(req), localAdminAvailable: isLoopback(req.socket.remoteAddress), passwordLoginAvailable: Boolean(adminPassword),
    sourceCount: state.sources.length, enabledSourceCount: state.sources.filter(source => source.enabled).length, uptime: Math.floor((Date.now() - boot) / 1000) }));
  app.post('/api/auth/local-admin', async (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) throw fail(403, '请在服务端电脑上打开 127.0.0.1 地址启用管理权限');
    let device = req.auth?.role === 'admin' ? req.auth.device : state.devices.find(value => value.kind === 'desktop' && value.admin === true);
    if (!device) { device = { id: identifier(), name: short(req.body?.name || '服务端电脑'), kind: 'desktop', admin: true, createdAt: new Date().toISOString() }; state.devices.push(device); }
    device.lastSeen = new Date().toISOString();
    store.activity('admin', '服务端管理已登录');
    await issueSession(res, device, 'admin');
    res.json({ device: publicDevice(device), role: 'admin' });
  });
  app.post('/api/auth/logout', async (req, res) => {
    if (req.auth) { state.sessions = state.sessions.filter(value => value !== req.auth.record); await store.save(); }
    res.clearCookie(COOKIE, { path: '/', sameSite: 'lax', httpOnly: true }); res.json({ ok: true });
  });
  app.post('/api/auth/admin', async (req, res) => {
    if (!adminPassword) throw fail(403, '服务端未启用密码管理登录');
    limitAttempts(`admin:${normalizeIP(req.socket.remoteAddress)}`, 6);
    if (typeof req.body?.password !== 'string' || !equal(hash(adminPassword), hash(req.body.password))) throw fail(401, '管理密码不正确');
    let device = req.auth?.role === 'admin' ? req.auth.device : null;
    if (!device) {
      device = { id: identifier(), name: short(req.body?.name || '管理设备', 60), kind: 'desktop', admin: true, createdAt: new Date().toISOString() };
      state.devices.push(device);
    }
    device.lastSeen = new Date().toISOString();
    store.activity('admin', `${device.name} 已通过密码登录管理页`);
    await issueSession(res, device, 'admin');
    res.json({ device: publicDevice(device), role: 'admin' });
  });
  app.post('/api/pairing', auth, admin, async (req, res) => {
    const available = addresses(req);
    const origin = req.body?.origin || available[0];
    if (!available.includes(origin)) throw fail(400, '请选择服务端显示的局域网地址');
    const token = randomBytes(32).toString('base64url');
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    const expiresAt = Date.now() + PAIR_AGE;
    pairing = { tokenHash: hash(token), codeHash: hash(code), expiresAt };
    const url = `${origin}/connect#pair=${token}`;
    const qrDataUrl = await QRCode.toDataURL(url, { width: 360, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#111316', light: '#ffffff' } });
    res.json({ code, token, url, expiresAt: new Date(expiresAt).toISOString(), qrDataUrl });
  });
  app.post('/api/pairing/claim', async (req, res) => {
    const ip = normalizeIP(req.socket.remoteAddress);
    limitAttempts(`pair:${ip}`);
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!pairing || pairing.expiresAt < Date.now() || !(token ? equal(pairing.tokenHash, hash(token)) : /^\d{6}$/.test(code) && equal(pairing.codeHash, hash(code)))) throw fail(400, '配对信息已失效或不正确，请在服务端重新生成');
    const kind = kinds.has(req.body?.kind) ? req.body.kind : 'phone';
    const name = short(req.body?.name || ({ phone: '手机', tv: '电视', desktop: '电脑' })[kind], 60);
    const device = { id: identifier(), name, kind, admin: false, createdAt: new Date().toISOString(), lastSeen: new Date().toISOString() };
    pairing = null; // Consume before the first asynchronous write: concurrent claims cannot both succeed.
    state.devices.push(device);
    store.activity('pair', `${name} 已连接家庭服务端`);
    await issueSession(res, device, 'client');
    res.json({ device: publicDevice(device), role: 'client' });
  });
  app.post('/api/heartbeat', auth, async (req, res) => {
    const device = req.auth.device;
    device.lastSeen = new Date().toISOString();
    if (kinds.has(req.body?.kind)) device.kind = req.body.kind;
    if (req.body?.name) device.name = short(req.body.name, 60);
    const playing = req.body?.playing;
    if (playing?.title) {
      const source = state.sources.find(value => value.id === playing.sourceId);
      const id = typeof playing.id === 'string' && /^[\w\-.:]{1,180}$/.test(playing.id) ? playing.id : '';
      const metadata = source && detailCache.get(`${source.id}:${id}`)?.data.item;
      const duration = number(playing.duration, 604800);
      const position = number(playing.position, 604800);
      device.playing = { title: short(metadata?.title || playing.title), episode: short(playing.episode), sourceId: source?.id || '', sourceName: source?.name || '',
        id, poster: safePoster(metadata?.poster || playing.poster), position: duration ? Math.min(position, duration) : position, duration, paused: playing.paused === true };
    } else device.playing = null;
    await store.save(); res.json({ ok: true });
  });
  app.get('/api/overview', auth, admin, (req, res) => res.json({ sources: state.sources, devices: state.devices.map(publicDevice), activity: state.activity,
    history: state.history, uptime: Math.floor((Date.now() - boot) / 1000), addresses: addresses(req), enabledSourceCount: state.sources.filter(source => source.enabled).length, ...sourceSummary() }));
  app.get('/api/home-summary', auth, (req, res) => res.json({ ...sourceSummary(), settings: playbackSettings(req.auth.device) }));
  app.get('/api/playback-settings', auth, (req, res) => res.json({ settings: playbackSettings(req.auth.device) }));
  app.patch('/api/playback-settings', auth, async (req, res) => {
    const input = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['sourceId', 'autoNext'].includes(key))) throw fail(400, '播放设置参数不正确');
    const settings = playbackSettings(req.auth.device);
    if ('sourceId' in input) {
      if (typeof input.sourceId !== 'string') throw fail(400, '片源选择不正确');
      if (input.sourceId) {
        const source = sourceById(input.sourceId, true);
        if (source.type !== 'vod') throw fail(400, '请选择点播片源');
      }
      settings.sourceId = input.sourceId;
    }
    if ('autoNext' in input) {
      if (typeof input.autoNext !== 'boolean') throw fail(400, '自动连播设置不正确');
      settings.autoNext = input.autoNext;
    }
    req.auth.device.playbackSettings = settings;
    await store.save(); res.json({ settings });
  });
  app.get('/api/devices', auth, admin, (_req, res) => res.json({ devices: state.devices.map(publicDevice) }));
  app.delete('/api/devices/:id', auth, admin, async (req, res) => {
    if (req.params.id === req.auth.device.id) throw fail(400, '不能移除当前服务端管理员');
    const device = state.devices.find(value => value.id === req.params.id);
    if (!device) throw fail(404, '设备不存在');
    state.devices = state.devices.filter(value => value.id !== device.id);
    state.sessions = state.sessions.filter(value => value.deviceId !== device.id);
    store.activity('device', `已移除 ${device.name}`); await store.save(); res.json({ ok: true });
  });

  app.get('/api/sources', auth, (_req, res) => res.json({ sources: state.sources }));
  app.post('/api/sources', auth, async (req, res) => {
    if (state.sources.length >= 50) throw fail(400, '最多可保存 50 个片源');
    const name = short(req.body?.name, 80);
    if (!name || !['vod', 'live'].includes(req.body?.type)) throw fail(400, '请填写片源名称并选择正确类型');
    const url = sourceURL(req.body?.url);
    const source = { id: identifier(), name, type: req.body.type, url, enabled: true, createdAt: new Date().toISOString() };
    state.sources.push(source); store.activity('source', `已添加片源「${name}」`); await store.save(); res.status(201).json({ source });
  });
  app.patch('/api/sources/:id', auth, async (req, res) => {
    const source = sourceById(req.params.id);
    const change = {};
    if ('name' in (req.body || {})) { change.name = short(req.body.name, 80); if (!change.name) throw fail(400, '片源名称不能为空'); }
    if ('url' in (req.body || {})) change.url = sourceURL(req.body.url);
    if ('enabled' in (req.body || {})) { if (typeof req.body.enabled !== 'boolean') throw fail(400, '启用状态无效'); change.enabled = req.body.enabled; }
    if ('type' in (req.body || {})) { if (!['vod', 'live'].includes(req.body.type)) throw fail(400, '片源类型无效'); change.type = req.body.type; }
    Object.assign(source, change);
    if ('url' in change || 'type' in change) delete source.health;
    detailCache.clear(); liveCache.delete(source.id); clearUnavailableSelections();
    store.activity('source', `已更新片源「${source.name}」${'enabled' in change ? source.enabled ? '：已启用' : '：已停用' : ''}`);
    await store.save(); res.json({ source });
  });
  app.delete('/api/sources/:id', auth, async (req, res) => {
    const source = sourceById(req.params.id);
    state.sources = state.sources.filter(value => value !== source); detailCache.clear(); liveCache.delete(source.id); clearUnavailableSelections();
    store.activity('source', `已删除片源「${source.name}」`); await store.save(); res.json({ ok: true });
  });
  app.post('/api/sources/:id/probe', auth, async (req, res) => {
    const source = sourceById(req.params.id); const requested = { ...source }; const start = Date.now();
    let health; let liveData;
    try {
      if (requested.type === 'vod') await media.vod(requested, { pg: 1 }); else liveData = await media.live(requested);
      health = { ok: true, latency: Date.now() - start, checkedAt: new Date().toISOString() };
    } catch (error) { health = { ok: false, latency: Date.now() - start, checkedAt: new Date().toISOString(), error: networkError(error) }; }
    if (!state.sources.includes(source) || source.url !== requested.url || source.type !== requested.type) throw fail(409, '片源已修改，请重新测试延迟');
    source.health = health;
    if (liveData) liveCache.set(source.id, { data: liveData, url: requested.url, expires: Date.now() + 30000 });
    await store.save(); res.json({ health: source.health });
  });
  app.get('/api/catalog', auth, async (req, res) => {
    res.json(await catalog.browse(browseSources(req), req.query));
  });
  app.get('/api/search', auth, async (req, res) => {
    const query = short(req.query.q, 100);
    if (!query) throw fail(400, '请输入影片名称');
    res.json(await catalog.browse(browseSources(req), { ...req.query, q: query }));
  });
  app.get('/api/detail', auth, async (req, res) => {
    const source = sourceById(String(req.query.sourceId), true);
    if (source.type !== 'vod' || !req.query.id || String(req.query.id).length > 180) throw fail(400, '影片参数不正确');
    res.json(groupedDetail(await detail(source, String(req.query.id))));
  });
  app.get('/api/alternatives', auth, async (req, res) => {
    const source = sourceById(String(req.query.sourceId), true);
    if (source.type !== 'vod' || !req.query.id || String(req.query.id).length > 180) throw fail(400, '影片参数不正确');
    const data = await detail(source, String(req.query.id));
    const result = await catalog.browse(state.sources, { q: searchTitle(data.item.title), pageSize: 60 });
    const item = groupedDetail(data).item;
    res.json({ groupKey: item.groupKey, variants: item.variants, failures: result.failures });
  });
  app.get('/api/live', auth, async (req, res) => {
    const sources = req.query.sourceId ? [sourceById(String(req.query.sourceId), true)] : state.sources.filter(source => source.enabled && source.type === 'live');
    const results = await mapLimit(sources, 3, async source => {
      try { if (source.type !== 'live') throw new Error('请选择直播片源'); return { channels: await channels(source) }; }
      catch (error) { return { failure: { sourceId: source.id, name: source.name, error: networkError(error) } }; }
    });
    res.json({ channels: results.flatMap(result => result.channels || []), failures: results.flatMap(result => result.failure ? [result.failure] : []) });
  });
  app.post('/api/playback', auth, async (req, res) => {
    const source = sourceById(req.body?.sourceId, true);
    let directUrl; let title; let episodeName;
    if (source.type === 'live') {
      const channel = (await channels(source)).find(value => value.id === req.body?.channelId);
      if (!channel) throw fail(404, '频道不存在');
      directUrl = channel.url; title = channel.name; episodeName = '直播';
    } else {
      if (!req.body?.id || String(req.body.id).length > 180) throw fail(400, '请提供有效影片 ID');
      const data = await detail(source, String(req.body.id));
      const line = Number(req.body.line ?? 0); const episode = Number(req.body.episode ?? 0);
      const selected = Number.isInteger(line) && Number.isInteger(episode) ? data.lines[line]?.episodes[episode] : null;
      if (!selected) throw fail(404, '播放线路或集数不存在');
      directUrl = selected.url; title = data.item.title; episodeName = selected.name;
    }
    for (const [id, grant] of grants) if (grant.expiresAt < Date.now()) grants.delete(id);
    if (grants.size >= 1000) throw fail(429, '当前播放请求较多，请稍后重试');
    const scope = identifier(); const expiresAt = Date.now() + 8 * 3600000;
    grants.set(scope, { deviceId: req.auth.device.id, sourceId: source.id, expiresAt });
    const url = `/api/stream?t=${sign({ k: 'stream', s: scope, u: directUrl, e: expiresAt })}`;
    res.json({ url, directUrl, title, episodeName });
  });
  app.get('/api/stream', auth, async (req, res) => {
    const signed = verify(req.query.t);
    const grant = grants.get(signed.s);
    if (signed.k !== 'stream' || !grant || grant.deviceId !== req.auth.device.id || grant.expiresAt < Date.now()) throw fail(403, '该播放会话无效，请重新播放');
    sourceById(grant.sourceId, true);
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const range = req.headers.range;
    if (range && !/^bytes=\d*-\d*$/.test(range)) throw fail(400, '不支持的 Range 请求');
    const upstream = await safeRequest(signed.u, { allowPrivate, signal: controller.signal, headers: range ? { range } : {} });
    const contentType = String(upstream.headers['content-type'] || '');
    if (upstream.statusCode >= 400) {
      upstream.body.destroy(); await upstream.cleanup();
      throw fail(upstream.statusCode === 416 ? 416 : 502, `视频源返回 HTTP ${upstream.statusCode}`);
    }
    const playlist = /mpegurl/i.test(contentType) || /\.m3u8(?:$|\?)/i.test(upstream.url);
    if (playlist) {
      const text = await readLimited(upstream, 4 * 1024 * 1024);
      if (!/^\s*#EXTM3U/.test(text)) throw fail(502, '视频源没有返回有效 HLS 播放列表');
      const result = rewritePlaylist(text, upstream.url, url => `/api/stream?t=${sign({ k: 'stream', s: signed.s, u: url, e: signed.e })}`);
      res.type('application/vnd.apple.mpegurl').send(result);
    } else {
      res.status(upstream.statusCode);
      res.set('Content-Type', /^(video|audio)\//i.test(contentType) || /octet-stream|mp2t/i.test(contentType) ? contentType : 'application/octet-stream');
      for (const header of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) if (upstream.headers[header]) res.set(header, upstream.headers[header]);
      await pipeline(upstream.body, res).catch(error => { if (!controller.signal.aborted) throw error; });
    }
  });
  app.get('/api/image', auth, async (req, res) => {
    const signed = verify(req.query.t);
    if (signed.k !== 'image') throw fail(403, '图片签名无效');
    const upstream = await safeRequest(signed.u, { allowPrivate, signal: AbortSignal.timeout(15000) });
    const type = String(upstream.headers['content-type'] || '').split(';')[0];
    if (upstream.statusCode !== 200 || !['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(type)) {
      upstream.body.destroy(); await upstream.cleanup(); throw fail(502, '图片暂不可用');
    }
    const maximum = 10 * 1024 * 1024;
    let size = 0; const chunks = [];
    try { for await (const chunk of upstream.body) { size += chunk.length; if (size > maximum) throw fail(502, '图片大小超过限制'); chunks.push(chunk); } }
    finally { upstream.body.destroy(); await upstream.cleanup(); }
    res.set('Cache-Control', 'private, max-age=3600'); res.type(type).send(Buffer.concat(chunks));
  });

  function savedItem(body) {
    const source = sourceById(body?.sourceId);
    const id = String(body?.id ?? '').slice(0, 180);
    if (!id || !/^[\w\-.:]+$/.test(id)) throw fail(400, '影片 ID 不正确');
    const poster = typeof body?.poster === 'string' && body.poster.startsWith('/api/image?t=') && body.poster.length < 14000 ? body.poster : '';
    const metadata = detailCache.get(`${source.id}:${id}`)?.data.item;
    const type = short(metadata?.type || body?.type, 80);
    const category = metadata?.category || (['movie','series','anime','variety','short'].includes(body?.category) ? body.category : categoryName(type));
    const item = { key: `${source.id}:${id}`, id, sourceId: source.id, sourceName: source.name, title: short(metadata?.title || body?.title, 160) || '未命名影片', poster, type, category, year: short(metadata?.year || body?.year, 20), updatedAt: new Date().toISOString() };
    item.groupKey = groupKeyFor(item);
    return item;
  }
  function savedGroups(items) {
    const ordered = [...items].sort((a,b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    const seen = new Set();
    return ordered.filter(item => {
      const key = groupKeyFor(item);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).map(item => ({ ...item, groupKey: groupKeyFor(item), variants: catalog.variants(groupKeyFor(item), state.sources) }));
  }
  app.get('/api/history', auth, (_req, res) => res.json({ items: savedGroups(state.history) }));
  app.put('/api/history', auth, async (req, res) => {
    const item = { ...savedItem(req.body), episodeName: short(req.body?.episodeName, 100), line: Math.floor(number(req.body?.line, 30)), episode: Math.floor(number(req.body?.episode, 3000)), position: number(req.body?.position, 604800), duration: number(req.body?.duration, 604800) };
    if (item.duration > 0) item.position = Math.min(item.position, item.duration);
    const recordedAt = Number(req.body?.recordedAt);
    item.recordedAt = Number.isFinite(recordedAt) && Math.abs(recordedAt - Date.now()) < 300000 ? recordedAt : Date.now();
    item.recordedBy = req.auth.device.id;
    const previous = state.history.find(value => value.key === item.key || sameWork(value, item));
    // Client clocks are only comparable on the same device. Another device's
    // newer request wins even when its clock is behind the previous viewer's.
    if (previous?.recordedBy === item.recordedBy && (previous.recordedAt || 0) > item.recordedAt) return res.json({ ok: true, ignored: true });
    state.history = [item, ...state.history.filter(value => value.key !== item.key && !sameWork(value, item))].slice(0, 100);
    await store.save(); res.json({ ok: true });
  });
  app.delete('/api/history/:key', auth, async (req, res) => {
    const selected = state.history.find(value => value.key === req.params.key || groupKeyFor(value) === req.params.key);
    state.history = state.history.filter(value => value !== selected && (!selected || !sameWork(value, selected)));
    await store.save(); res.json({ ok: true });
  });
  app.get('/api/favorites', auth, (_req, res) => res.json({ items: savedGroups(state.favorites) }));
  app.post('/api/favorites', auth, async (req, res) => {
    const item = savedItem(req.body); state.favorites = [item, ...state.favorites.filter(value => value.key !== item.key && !sameWork(value, item))].slice(0, 1000);
    await store.save(); res.json({ ok: true, item });
  });
  app.delete('/api/favorites/:key', auth, async (req, res) => {
    const selected = state.favorites.find(value => value.key === req.params.key || groupKeyFor(value) === req.params.key);
    state.favorites = state.favorites.filter(value => value !== selected && (!selected || !sameWork(value, selected)));
    await store.save(); res.json({ ok: true });
  });
  app.use('/api', (_req, _res, next) => next(fail(404, '接口不存在')));
  app.get('/vendor/hls.min.js', (_req, res) => res.sendFile(join(ROOT, 'node_modules/hls.js/dist/hls.min.js')));
  app.use(express.static(join(ROOT, 'public'), { index: 'index.html', etag: true, maxAge: 0 }));
  app.get('/connect', (_req, res) => res.sendFile(join(ROOT, 'public/index.html')));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) { res.destroy(); return; }
    const status = error.status || (error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 502);
    res.status(status).json({ error: status === 400 && error.type === 'entity.parse.failed' ? '请求不是有效 JSON' : networkError(error) });
  });
  return app;
}

export async function listen(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 8080);
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || join(ROOT, 'data'));
  let app;
  let closing = false;
  let releaseLock;
  const server = createServer((req, res) => {
    if (app && !closing) return app(req, res);
    res.writeHead(503, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end('{"error":"服务正在启动或停止，请稍后重试"}');
  });
  try {
    // Reserve the port first: an occupied port must not initialize or rewrite data.
    await new Promise((resolve, reject) => {
      const ready = () => { server.off('error', failed); resolve(); };
      const failed = error => { server.off('listening', ready); reject(error); };
      server.once('listening', ready);
      server.once('error', failed);
      server.listen(port, options.host || '0.0.0.0');
    });
    releaseLock = await lockDataDirectory(dataDir);
    app = await createApp({ ...options, dataDir });
  } catch (error) {
    await closeHttpServer(server);
    if (app) await app.locals.close();
    if (releaseLock) await releaseLock();
    throw error;
  }
  let finalized;
  const finalize = () => finalized ||= (async () => {
    // A timed-out upstream task must not write after another server owns the store.
    app.locals.store.save = () => Promise.reject(fail(503, '服务已停止'));
    await app.locals.close();
    await releaseLock();
  })();
  const nativeClose = server.close.bind(server);
  let closingCompleted;
  // Preserve the existing server.close(callback) API, including lock cleanup.
  server.close = callback => {
    closing = true;
    if (!closingCompleted) closingCompleted = new Promise((resolve, reject) => {
      nativeClose(error => {
        void finalize().then(() => error ? reject(error) : resolve(), reject);
      });
    });
    void closingCompleted.then(
      () => { if (callback) callback(); },
      error => { if (callback) callback(error); else console.error(error.message); },
    );
    return server;
  };
  let stopped;
  const close = () => stopped ||= (async () => {
    closing = true;
    // Also bound an earlier server.close() that is still draining active clients.
    const timeout = setTimeout(() => server.closeAllConnections(), 8000);
    timeout.unref();
    try {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally { clearTimeout(timeout); }
  })();
  console.log(`映间局域网服务已启动： http://127.0.0.1:${server.address().port}`);
  console.log('请在本机打开上述地址进入管理页；手机和电视与服务端连接同一局域网。');
  return { app, server, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let service;
  let stopRequested = false;
  let stopping;
  const stop = () => {
    stopRequested = true;
    if (!service || stopping) return;
    stopping = service.close().then(
      () => process.exit(0),
      error => { console.error(error.message); process.exit(1); },
    );
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  listen().then(result => { service = result; if (stopRequested) stop(); }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
