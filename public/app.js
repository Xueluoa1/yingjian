/* 映间局域网客户端。界面只呈现服务端返回的片源、设备与播放记录。 */
'use strict';
import {matchEpisode, seekTarget} from './playback-utils.js?v=0.1.3';
const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');
const modal = $('#modal');
const params = new URLSearchParams(location.search);
const validViews = new Set(['server', 'mobile', 'tv']);
const nativeShell = /Yingjian(?:TV|Phone)/.test(navigator.userAgent);
const state = {
  view: validViews.has(params.get('view')) ? params.get('view') : null,
  tab: 'home', status: null, sources: [], overview: null, items: [], channels: [],
  history: [], favorites: [], failures: [], page: 1, pageCount: 1, total: 0,
  filters: {category: 'all', year: '', area: '', genre: '', sort: 'updated'},
  facets: {years: [], areas: [], genres: []}, scope: null, snapshot: '', canLoadMore: false, expandedFilters: [], filterFocus: null, advancedFiltersOpen: null,
  loading: false, loaded: false, query: '', pairing: null, detail: null, line: 0,
  playing: null, hls: null, connectTab: 'code', error: '', requestId: 0, modalVersion: 0,
  detailSession: null, sourceRequest: 0, switchCancel: null, sourceBusy: false, pendingSource: null,
  playbackSettings: {sourceId:'',autoNext:false}, homeSummary: null, sourceSearch: '', sourceType: 'all', playerSettingsOpen: false,
  probing: new Set(), batchProbing: false, recentSearches: [],
};
const icons = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  play: '<path d="m9 5 11 7-11 7z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  source: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5"/>',
  tv: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M10 5h4m-2 14h.01"/>',
  desktop: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  link: '<path d="m10 13 4-4m-6 6-1.5 1.5a4.2 4.2 0 0 1-6-6L5 7m11 2 1.5-1.5a4.2 4.2 0 0 1 6 6L19 17" transform="translate(0 0) scale(.9)"/>',
  qr: '<path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h3v3h3v3h-6v-3h-3v-3M12 3v3m0 6h6m3 0v3M3 12h3m3 0v3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 2M18 18a8 8 0 0 1-13-2"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  edit: '<path d="m14 5 5 5M4 20l5-1L21 7l-5-5L4 14z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  heart: '<path d="M12 21 3.5 12.5C-3 6 6-2 12 5c6-7 15 1 8.5 7.5z"/>',
  wifi: '<path d="M2 7a16 16 0 0 1 20 0M5 11a11 11 0 0 1 14 0M8 15a6 6 0 0 1 8 0m-4 4h.01"/>',
  settings: '<path d="m9 3-1 3-3 1v4l-2 1 2 1v4l3 1 1 3h6l1-3 3-1v-4l2-1-2-1V7l-3-1-1-3z"/><circle cx="12" cy="12" r="3"/>',
  logout: '<path d="M10 3H3v18h7m-2-9h13m-5-5 5 5-5 5"/>',
  chevron: '<path d="m8 5 7 7-7 7"/>',
};
const icon = (name) => `<svg aria-hidden="true" viewBox="0 0 24 24">${icons[name] || icons.play}</svg>`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function safeUrl(value) {
  if (!value) return '';
  try { const url = new URL(value, location.origin); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
}
const shortTime = (seconds) => {
  const mins = Math.floor(Number(seconds || 0) / 60);
  return mins >= 60 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分` : `${mins} 分钟`;
};
const deviceKind = () => state.view === 'tv' ? 'tv' : /Android|iPhone|iPad/i.test(navigator.userAgent) || innerWidth < 700 ? 'phone' : 'desktop';
function online(device) { return device.online === true || (Date.now() - new Date(device.lastSeen || 0).getTime() < 60000); }
function brand() { return `<a class="brand" href="/?view=${state.view || 'mobile'}"><img src="/icon.svg" alt=""><span>映间<small>YINGJIAN${state.view === 'server' ? ' · 管理后台' : ''}</small></span></a>`; }
function illustration() {
  return `<div class="connection-art"><svg viewBox="0 0 500 330" aria-hidden="true"><defs><linearGradient id="device-face" x2="0" y2="1"><stop stop-color="#fff"/><stop offset="1" stop-color="#e4eae6"/></linearGradient></defs><ellipse cx="260" cy="273" rx="190" ry="25" fill="#d9e3dd" opacity=".36"/><path d="M157 227h48q18 0 18-18v-22m-18 40h88q18 0 18-18v-15m-91 33v35q0 13 18 13h78" stroke="#85d7b9" stroke-width="4" stroke-linecap="round"/><g transform="translate(191 126)"><path d="m0 17 40-20 63 17-40 21z" fill="#fdfefd"/><path d="M0 17v93l63 20V35z" fill="#f1f5f1"/><path d="M63 35v95l40-22V14z" fill="#dce4de"/><path d="m16 42 29 9m-29 6 29 9m-29 6 29 9" stroke="#c6d0c8" stroke-width="3"/><circle cx="46" cy="104" r="3" fill="#00bd94"/></g><g transform="translate(83 71)"><path d="m0 17 103-12 6 89L6 105z" fill="#dce5de"/><path d="m7 23 89-10 5 74-89 14z" fill="url(#device-face)"/><path d="m44 105 3 20-22 8 58-8-24-3-2-20" fill="#cbd7ce"/><path d="m42 43 30 15-27 21z" fill="#a8d9bf"/></g><g transform="translate(303 74)"><path d="m0 0 136 12v89L0 88z" fill="#d7e1d9"/><path d="m7 8 122 10v75L7 81z" fill="url(#device-face)"/><path d="m54 99-7 15m45-11 7 16" stroke="#c0d0c4" stroke-width="5" stroke-linecap="round"/><path d="m52 30 35 22-35 17z" fill="#a6dac2"/></g><g transform="translate(314 229) rotate(-15)"><rect width="45" height="77" rx="8" fill="#d2dfd4"/><rect x="4" y="5" width="37" height="66" rx="5" fill="url(#device-face)"/><path d="M17 10h11" stroke="#b5c8bb" stroke-width="2"/><path d="m17 28 16 10-16 10z" fill="#8fd8b5"/></g><circle cx="206" cy="227" r="4" fill="#00bb92"/><circle cx="310" cy="197" r="4" fill="#00bb92"/></svg></div>`;
}
function empty(title, copy, action = '', symbol = 'source') { return `<div class="empty"><div class="empty-icon">${icon(symbol)}</div><h3>${esc(title)}</h3><p>${esc(copy)}</p>${action}</div>`; }
function button(label, action, type = '', symbol = '') { return `<button class="button ${type}" data-action="${action}">${symbol ? icon(symbol) : ''}${label}</button>`; }
function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 3500);
}
async function api(path, options = {}) {
  const headers = {'X-Yingjian': '1', ...options.headers};
  if (options.body && typeof options.body !== 'string') { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(options.body); }
  const requestUrl = new URL(`/api${path}`, location.origin);
  // A changed session must not reuse an anonymous status response from a WebView cache.
  if (requestUrl.pathname === '/api/status') requestUrl.searchParams.set('_', String(Date.now()));
  const response = await fetch(requestUrl, {...options, headers, credentials: 'same-origin', cache: 'no-store'});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.status?.paired && !path.startsWith('/auth/') && path !== '/pairing/claim') { state.status.paired = false; stopPlayer(); closeModal(); render(); }
    throw new Error(data.error || `请求失败（${response.status}），请稍后重试`);
  }
  return data;
}
function openModal(html, className = '') { if (modal.open) modal.close(); modal.className = className; modal.innerHTML = html; modal.showModal(); return ++state.modalVersion; }
function closeModal() { state.modalVersion++; if (modal.open) modal.close(); }
function modalHead(title) { return `<div class="modal-heading"><h2 id="modal-title">${esc(title)}</h2><button class="icon-button" data-action="close-modal" aria-label="关闭">${icon('close')}</button></div>`; }
function footer() { return `<footer class="footer"><span>映间 · 局域网家庭影音</span><span>${state.status?.version ? `v${esc(state.status.version)} · ` : ''}片源由家庭服务端统一管理</span></footer>`; }
function navItem(tab, label, symbol = '') { return `<button data-action="tab" data-tab="${tab}" class="${state.tab === tab ? 'active' : ''}">${symbol ? icon(symbol) : ''}${label}</button>`; }
function topbar(admin = false) {
  const enabled = state.sources.filter(source => source.enabled && source.type === 'vod').length;
  return `<header class="topbar">${brand()}<nav class="nav-pills" aria-label="${admin ? '服务端导航' : '播放导航'}">${admin ? navItem('overview', '总览') + navItem('sources', '片源管理') + navItem('playback-settings', '播放设置') + navItem('devices', '设备') + navItem('settings', '系统设置') : navItem('home', '首页') + navItem('live', '直播') + navItem('favorites', '收藏') + navItem('history', '历史') + navItem('playback-settings', '播放设置')}</nav><div class="tools">${admin ? `<a class="icon-button" href="/?view=mobile" title="打开播放器" aria-label="打开播放器">${icon('play')}</a><span class="account"><span class="avatar">管</span>管理员</span>` : `<button class="service-pill" data-action="connection-info" aria-label="家庭服务连接信息"><span class="status-dot"></span>家庭服务${icon('chevron')}</button><button class="icon-button tv-settings" data-action="tab" data-tab="playback-settings" aria-label="播放设置">${icon('settings')}</button><span class="tv-source-count">${enabled} 个片源</span>`}</div></header>`;
}
function render() {
  document.body.classList.toggle('tv-mode', state.view === 'tv');
  if (location.pathname === '/connect') return renderConnect();
  if (!state.status?.paired) return renderWelcome();
  if (state.view === 'server' && state.status.role !== 'admin') return renderWelcome(true);
  if (state.view === 'server') renderServer(); else renderConsumer();
}
function renderWelcome(noAdmin = false) {
  app.innerHTML = `<div class="auth-shell">${brand()}<section class="welcome-card"><div class="welcome-content"><div class="eyebrow">YINGJIAN / HOME CINEMA</div><h1>${noAdmin ? '这台设备已连接' : '把好电影，留在家里。'}</h1><p>${noAdmin ? '片源和设备由家庭服务端管理。你可以直接进入播放器，浏览家里的内容。' : '在一处添加片源，在手机和电视上播放。所有设备连接同一家庭网络，就能开始。'}</p>${state.status?.localAdminAvailable ? button('进入服务端管理', 'activate-admin', '', 'server') : state.status?.passwordLoginAvailable ? button('管理家庭服务端', 'login-admin', '', 'server') : ''}<a class="button ${state.status?.localAdminAvailable || state.status?.passwordLoginAvailable ? 'light' : ''}" href="${noAdmin ? '/?view=mobile' : `/connect?view=${state.view === 'tv' ? 'tv' : 'mobile'}`}">${icon(noAdmin ? 'play' : 'link')}${noAdmin ? '打开播放器' : '连接家里的服务端'}</a><div class="welcome-foot">${state.status?.localAdminAvailable ? '在本机管理片源、连接设备和查看运行状态。' : state.status?.passwordLoginAvailable ? '管理员使用部署时设置的密码，家庭设备使用连接码。' : '首次使用：在服务端页面点击「连接设备」。'}</div>${state.error ? `<div class="error-banner">${esc(state.error)}</div>` : ''}</div><div class="welcome-art">${illustration()}</div></section>${footer()}</div>`;
}
function dashboardOverview() {
  const data=state.overview||{}, devices=data.devices||[], health=healthSummary(), firstAddress=addresses()[0]||location.origin, live=data.liveChannels||state.homeSummary?.liveChannels;
  const current=devices.find(d=>online(d)&&d.playing?.title), playing=current?.playing;
  const metrics=[['source','点播片源',health.enabledVod||0,`/ ${health.vod||state.sources.filter(s=>s.type==='vod').length} 已启用`],['tv','直播频道',live?.known?live.count:'—',live?.known?`${live.totalSources} 个直播源`:'打开直播页后获取'],['refresh','接口响应',health.averageLatencyMs==null?'—':Math.round(health.averageLatencyMs),health.averageLatencyMs==null?'尚未测试':'ms · 已启用片源平均'],['clock','连续运行',Math.floor(Number(data.uptime||0)/3600),'小时']];
  return `<div class="page-heading admin-heading"><div><h1>家庭影音中心</h1><p>${esc(firstAddress)} · 局域网 · 家庭共享片源</p></div><div class="row-actions"><span class="status">运行中</span><button class="button white small" data-action="copy" data-value="${esc(firstAddress)}">${icon('copy')}复制地址</button>${button('刷新状态','reload','white small','refresh')}</div></div><div class="admin-top-grid"><section class="service-card"><span class="feature-caption">${icon('play')}服务已就绪</span><p>设备连接同一网络，扫码或输入连接码即可观看</p><strong class="service-address">${esc(firstAddress.split('://').pop())}</strong><dl><div><dt>服务名称</dt><dd>映间家庭影院</dd></div><div><dt>访问范围</dt><dd>局域网</dd></div><div><dt>家庭设备</dt><dd>${devices.length} 台已连接</dd></div></dl>${button('连接新设备','pair','','qr')}</section><div class="admin-metrics">${metrics.map(([symbol,label,value,unit])=>`<section class="metric-card"><span>${icon(symbol)}${label}</span><strong>${value}</strong><small>${unit}</small></section>`).join('')}</div><section class="panel devices-panel"><div class="panel-header"><h2>家里的设备</h2><span class="badge">${devices.filter(online).length} / ${devices.length} 在线</span><button class="text-button" data-action="tab" data-tab="devices">管理 ${icon('chevron')}</button></div>${devices.length?devices.slice(0,4).map(deviceRow).join(''):empty('等待设备连接','手机扫码或电视输入连接码。',button('连接设备','pair','light small','qr'),'tv')}</section><section class="panel now-playing-panel"><div class="panel-header"><h2>${current?esc(current.name):'家庭播放'}</h2><span class="badge">${playing?'正在播放':'待播放'}</span></div>${playing?`<div class="now-playing-art">${safeUrl(playing.poster)?`<img src="${esc(safeUrl(playing.poster))}" alt="">`:icon('play')}</div><div class="now-playing-meta"><h3>${esc(playing.title)}</h3><p>${esc(playing.episode||'')}${playing.paused?' · 已暂停':''}</p><small>${esc(playing.sourceName||'当前片源')}</small><div class="progress-track"><i style="width:${Math.max(0,Math.min(100,Number(playing.position||0)/Math.max(1,Number(playing.duration||1))*100))}%"></i></div><small>已观看 ${shortTime(playing.position)}</small></div>`:'<p class="muted">当前没有设备在播放。连接手机或电视，开始家里的放映。</p><a class="button light" href="/?view=mobile">打开播放器</a>'}</section></div><div class="admin-main-grid"><section class="panel source-management"><div class="panel-header"><h2>片源管理 <small>${state.sources.length} 个片源 · ${health.enabled} 个已启用</small></h2><div class="row-actions">${button('批量测试','probe-all','light small','refresh')}${button('添加片源','add-source','small','plus')}</div></div>${state.sources.length?`<div class="table-scroll"><table class="source-table"><thead><tr><th>名称 / 接口地址</th><th>类型</th><th>接口延迟</th><th>启用</th><th>操作</th></tr></thead><tbody>${state.sources.slice(0,6).map(sourceRow).join('')}</tbody></table></div>${state.sources.length>6?`<div class="panel-header"><small class="muted">展示前 6 个片源</small><button class="text-button" data-action="tab" data-tab="playback-settings">查看全部 ${state.sources.length} 个片源 ${icon('chevron')}</button></div>`:''}`:empty('添加第一个片源','支持苹果 CMS JSON 点播接口和 M3U 直播列表。',button('添加片源','add-source','mint','plus'))}</section><div class="admin-side-stack"><section class="panel stats-summary"><h2>片源状态</h2><div class="health-values"><span><strong>${health.healthy||0}</strong>可用</span><span><strong>${health.failed||0}</strong>暂不可用</span><span><strong>${health.unknown??health.enabled}</strong>待检测</span></div><p>接口测试用于检查连接和响应时间。停用的片源不参与首页内容获取。</p><button class="button light small" data-action="tab" data-tab="playback-settings">${icon('settings')}播放设置</button></section><section class="panel"><h2>播放偏好</h2>${playbackToggle()}<p class="muted">当前浏览：${esc(selectedSourceName())}</p><a class="button light small" href="/?view=tv">${icon('tv')}打开电视界面</a></section></div></div><div class="admin-bottom-grid"><section class="panel"><h2>连接与访问</h2><ul class="security-list"><li><span>当前会话</span><strong>管理员</strong></li><li><span>设备连接</span><strong>扫码 / 六位连接码</strong></li><li><span>连接码有效期</span><strong>10 分钟 · 单次使用</strong></li><li><span>访问地址</span><strong>${location.protocol==='https:'?'HTTPS':'局域网 HTTP'}</strong></li></ul></section><section class="panel"><h2>最近设备活动</h2><div class="activity-list">${[...devices].sort((a,b)=>new Date(b.lastSeen)-new Date(a.lastSeen)).slice(0,4).map(d=>`<div class="activity-row">${icon(d.kind||'desktop')}<span><strong>${esc(d.name)}</strong><small>${d.playing?.title?`正在播放 ${esc(d.playing.title)}`:'最近连接'} · ${esc(updateLabel(d.lastSeen))}</small></span></div>`).join('')||'<p class="muted">还没有设备活动。</p>'}</div></section></div>`;
}

function renderServer() {
  const data = state.overview;
  const sourceCount = state.sources.length;
  const enabled = state.sources.filter(s => s.enabled).length;
  const devices = data?.devices || [];
  let content = '';
  if (state.tab === 'playback-settings') {
    content = playbackSettingsPage();
  } else if (state.tab === 'sources') {
    content = `<div class="page-heading"><div><h1>片源管理</h1><p>添加一次，同一家庭的所有设备都能使用。</p></div>${button('添加片源', 'add-source', '', 'plus')}</div><section class="panel wide-panel"><div class="panel-header"><h2>我的片源 <small>${sourceCount} 个片源 · ${enabled} 个已启用</small></h2>${button('检测全部', 'probe-all', 'light small', 'refresh')}</div>${sourceCount ? `<div class="table-scroll"><table class="source-table"><thead><tr><th>名称 / 接口地址</th><th>类型</th><th>可用性</th><th>状态</th><th>操作</th></tr></thead><tbody>${state.sources.map(sourceRow).join('')}</tbody></table></div>` : empty('添加第一个片源', '支持苹果 CMS JSON 点播接口和 M3U 直播列表。', button('添加片源', 'add-source', 'mint', 'plus'))}</section>`;
  } else if (state.tab === 'devices') {
    content = `<div class="page-heading"><div><h1>家里的设备</h1><p>手机扫码或输入链接连接，电视可以输入连接码。</p></div>${button('连接设备', 'pair', '', 'qr')}</div><section class="panel wide-panel"><div class="panel-header"><h2>已连接设备<small>在线状态每 30 秒更新</small></h2><span class="badge">${devices.filter(online).length} 台在线</span></div>${devices.length ? `<div class="device-list">${devices.map(deviceRow).join('')}</div>` : empty('等待第一台设备', '让手机或电视连接同一局域网，再添加到家庭服务端。', button('连接设备', 'pair', 'mint', 'qr'), 'tv')}</section>`;
  } else if (state.tab === 'settings') {
    content = `<div class="page-heading"><div><h1>服务端设置</h1><p>连接信息与本机服务状态。</p></div><span class="status">服务运行中</span></div><div class="settings-grid"><section class="panel"><h2>局域网访问地址</h2><p>手机和电视需要访问以下地址。建议在路由器中固定服务端的局域网 IP。</p>${addresses().map(url => `<div class="url-line"><code>${esc(url)}</code><button class="icon-button" data-action="copy" data-value="${esc(url)}" aria-label="复制地址">${icon('copy')}</button></div>`).join('') || '<p>未找到局域网地址，请检查电脑网络连接。</p>'}</section><section class="panel"><h2>运行信息</h2><p>版本：${esc(state.status.version || '0.1.0')}<br>已运行：${shortTime(data?.uptime || state.status.uptime)}<br>片源：${sourceCount} 个<br>家庭设备：${devices.length} 台</p><div class="modal-actions">${button('退出管理', 'logout', 'light', 'logout')}</div></section><section class="panel"><h2>在这台电脑上观看</h2><p>使用相同的片源、收藏和播放进度。</p><div class="modal-actions"><a class="button" href="/?view=mobile">${icon('play')}打开播放器</a><a class="button light" href="/?view=tv">电视界面</a></div></section><section class="panel"><h2>让设备保持连接</h2><p>所有设备应处于能互相访问的同一网络。电脑作为服务端时，请关闭自动休眠，并保持映间正在运行。</p><p>连接二维码和连接码 10 分钟内有效，一次使用后失效。已连接的设备会记住服务端。</p></section></div>`;
  } else {
    content = dashboardOverview();
  }
  app.innerHTML = `<div class="shell server">${topbar(true)}${state.error ? `<div class="error-banner">${esc(state.error)}</div>` : ''}${content}${footer()}</div>`;
}
function addresses() {
  const all = state.overview?.addresses || state.status?.addresses || [];
  return all.filter(url => { try { return !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname); } catch { return false; } });
}
function sourceHealth(source) {
  if (!source.health) return '<span class="muted">尚未检测</span>';
  return `<span class="status ${source.health.ok ? '' : 'failed'}" title="${esc(source.health.error || '')}">${source.health.ok ? `${Number(source.health.latency || 0)} ms` : '暂不可用'}</span>`;
}
function sourceCompact(source) { return `<div class="list-row"><div class="row-icon">${icon(source.type === 'live' ? 'tv' : 'source')}</div><div class="row-info"><strong>${esc(source.name)}</strong><small>${source.type === 'live' ? 'M3U 直播' : 'JSON 点播'} · ${source.enabled ? '已启用' : '已停用'}</small></div>${sourceHealth(source)}</div>`; }
function playbackToggle() {
  return `<div class="setting-toggle"><span><strong>自动连播下一集</strong><small>本设备播放完一集后继续下一集</small></span><button class="switch" role="switch" aria-checked="${Boolean(state.playbackSettings.autoNext)}" aria-label="自动连播下一集" data-action="toggle-auto-next"><span></span></button></div>`;
}
function sourceSettingsList() {
  const query=state.sourceSearch.trim().toLowerCase();
  const sources=state.sources.filter(source=>(state.sourceType==='all'||source.type===state.sourceType)&&(!query||source.name.toLowerCase().includes(query)||source.url.toLowerCase().includes(query)));
  return sources.length ? sources.map(source=>`<article class="source-setting-card ${source.enabled?'':'disabled-source'}"><div class="source-setting-head"><span class="row-icon">${icon(source.type==='live'?'tv':'source')}</span><div class="source-setting-info"><strong>${esc(source.name)}</strong><small>${source.type==='live'?'M3U 直播':'JSON 点播'} · ${source.enabled?'已启用':'已停用'}</small></div><button class="switch" data-action="toggle-source" data-id="${esc(source.id)}" role="switch" aria-checked="${Boolean(source.enabled)}" aria-label="${source.enabled?'停用':'启用'} ${esc(source.name)}"><span></span></button></div><p class="source-url" title="${esc(source.url)}">${esc(source.url)}</p><div class="source-status">${sourceHealth(source)}${source.health?.checkedAt?`<small>检测于 ${esc(updateLabel(source.health.checkedAt))}</small>`:''}</div><div class="source-setting-actions">${source.type==='vod'?`<button class="source-selection ${state.playbackSettings.sourceId===source.id?'active':''}" data-action="select-browse-source" data-id="${esc(source.id)}" aria-pressed="${state.playbackSettings.sourceId===source.id}" ${source.enabled?'':'disabled'}>${icon(state.playbackSettings.sourceId===source.id?'check':'play')}${state.playbackSettings.sourceId===source.id?'当前浏览源':'只看此源'}</button>`:''}<button class="button light small" data-action="probe-source" data-id="${esc(source.id)}" ${state.probing.has(source.id)?'disabled':''}>${icon('refresh')}${state.probing.has(source.id)?'检测中…':'测试延迟'}</button><button class="icon-button" data-action="edit-source" data-id="${esc(source.id)}" aria-label="编辑 ${esc(source.name)}">${icon('edit')}</button><button class="icon-button" data-action="delete-source" data-id="${esc(source.id)}" aria-label="删除 ${esc(source.name)}">${icon('trash')}</button></div></article>`).join('') : empty('没有匹配的片源',query?'换个名称或地址搜索。':'添加点播接口或 M3U 直播列表。',button('添加片源','add-source','mint','plus'));
}
function playbackSettingsPage(inline=false) {
  return `<section class="playback-settings-page">${inline?'':`<div class="page-heading"><div><h1>播放设置</h1><p>选择本设备浏览的片源，管理家里的共享片源。</p></div>${button('添加片源','add-source','','plus')}</div>`}<div class="settings-summary">${playbackToggle()}<div class="source-filter"><div><strong>浏览片源</strong><small>启用的片源内容显示在首页，每条影片标注来源。</small></div><button class="button ${state.playbackSettings.sourceId?'light':'mint'} small" data-action="select-browse-source" data-id="" aria-pressed="${!state.playbackSettings.sourceId}">${icon('source')}全部已启用</button><span class="badge">${esc(selectedSourceName())}</span></div></div><div class="settings-toolbar"><div class="nav-pills" aria-label="片源类型">${[['all','全部'],['vod','点播'],['live','直播']].map(([key,label])=>`<button data-action="source-type" data-type="${key}" class="${state.sourceType===key?'active':''}">${label}</button>`).join('')}</div><label class="source-search">${icon('search')}<input id="source-search" type="search" aria-label="搜索片源名称或地址" placeholder="搜索片源名称或地址" value="${esc(state.sourceSearch)}"></label><button class="button light small" data-action="probe-all" ${state.batchProbing?'disabled':''}>${icon('refresh')}${state.batchProbing?'正在检测…':'批量测试'}</button>${inline?button('添加片源','add-source','small','plus'):''}</div><div class="source-management-notice">启用、停用、添加和删除对家庭所有设备生效；浏览片源和自动连播仅影响当前设备。延迟为接口响应时间，不代表视频播放速度。</div><div id="source-inline-editor"></div><div id="source-confirm"></div><div class="source-settings-list">${sourceSettingsList()}</div></section>`;
}
function refreshSettingsSurface() {
  if(state.playing && state.playerSettingsOpen) {
    const controls=$('#player-settings-controls');
    if(controls) controls.innerHTML=playbackSettingsPage(true);
    refreshSourceControls();
  } else render();
}
async function reloadSourceState() {
  const [sources,summary,settings]=await Promise.all([api('/sources'),api('/home-summary'),api('/playback-settings')]);
  state.sources=sources.sources||[]; state.homeSummary=summary; state.playbackSettings=settings.settings||{sourceId:'',autoNext:false};
  if(state.detailSession) state.detailSession.variants=state.detailSession.variants.filter(item=>state.sources.some(s=>s.id===item.sourceId&&s.enabled));
  if(state.view==='server') { state.overview=await api('/overview'); }
  refreshSettingsSurface();
}
async function probeSource(id) {
  if(state.probing.has(id)) return;
  state.probing.add(id); refreshSettingsSurface();
  try { const data=await api(`/sources/${encodeURIComponent(id)}/probe`,{method:'POST'}); const source=state.sources.find(s=>s.id===id); if(source) source.health=data.health; toast(data.health?.ok?`接口响应 ${data.health.latency} ms`:data.health?.error||'片源暂不可用'); }
  finally { state.probing.delete(id); await reloadSourceState(); }
}
async function chooseBrowseSource(id) {
  const data=await api('/playback-settings',{method:'PATCH',body:{sourceId:id}});
  state.playbackSettings=data.settings; invalidateCatalog();
  refreshSettingsSurface(); toast(id?'浏览片源已切换，返回首页查看内容':'已显示全部启用片源');
}
function invalidateCatalog() {
  state.requestId++; state.loading=false; state.page=1; state.snapshot=''; state.items=[]; state.total=0; state.pageCount=1; state.canLoadMore=false;
  state.facets={years:[],areas:[],genres:[]}; state.scope=null; state.failures=[];
}
async function mutateSource(id, method, body) {
  const active=state.playing?.sourceId===id;
  const source=state.sources.find(source=>source.id===id);
  const changesPlayback=body && ((body.url!==undefined && body.url!==source?.url)||(body.type!==undefined && body.type!==source?.type));
  if(active && (method==='DELETE'||body?.enabled===false||changesPlayback)) { await saveProgress(); stopPlayer(); closeModal(); state.tab='playback-settings'; }
  await api(`/sources/${encodeURIComponent(id)}`,{method,...(body?{body}:{})});
  if(modal.open && !state.playing) closeModal();
  invalidateCatalog(); await reloadSourceState();
}
function confirmSourceMutation(source, action) {
  const active=state.playing?.sourceId===source.id;
  const title=action==='confirm-delete-source'?'删除片源':'停用片源';
  const copy=`${title}「${source.name}」会影响家庭所有设备。${active?'当前视频正在使用此源，确认后将保存进度并停止播放。':'该片源的影片将不再显示在列表。'}`;
  if(state.playing) {
    const target=$('#source-confirm',modal);
    if(target) { target.innerHTML=`<div class="inline-confirm"><strong>${title}</strong><p>${esc(copy)}</p><div class="modal-actions">${button('取消','cancel-source-confirm','light')}<button class="button danger" data-action="${action}" data-id="${esc(source.id)}">确认${title}</button></div></div>`; target.scrollIntoView({block:'nearest'}); }
  } else confirmation(title,copy,action,source.id);
}

function sourceRow(source) {
  return `<tr><td><strong>${esc(source.name)}</strong><span class="source-url" title="${esc(source.url)}">${esc(source.url)}</span></td><td>${source.type === 'live' ? '直播' : '点播'}</td><td>${sourceHealth(source)}</td><td><button class="badge ${source.enabled ? '' : 'muted'}" data-action="toggle-source" data-id="${esc(source.id)}" aria-label="${source.enabled ? '停用' : '启用'} ${esc(source.name)}">${source.enabled ? '已启用' : '已停用'}</button></td><td><div class="row-actions"><button class="icon-button" data-action="probe-source" data-id="${esc(source.id)}" title="检测片源" aria-label="检测 ${esc(source.name)}">${icon('refresh')}</button><button class="icon-button" data-action="edit-source" data-id="${esc(source.id)}" title="编辑片源" aria-label="编辑 ${esc(source.name)}">${icon('edit')}</button><button class="icon-button" data-action="delete-source" data-id="${esc(source.id)}" title="删除片源" aria-label="删除 ${esc(source.name)}">${icon('trash')}</button></div></td></tr>`;
}
function deviceRow(device) {
  const isSelf = device.id === state.status?.device?.id;
  return `<div class="list-row"><div class="row-icon">${icon(device.kind || 'desktop')}</div><div class="row-info"><strong>${esc(device.name || '家庭设备')}${isSelf ? ' · 本机' : ''}</strong><small>${device.playing?.title ? `正在播放 ${esc(device.playing.title)}` : ({phone:'安卓手机',tv:'电视',desktop:'电脑'}[device.kind] || '家庭设备')}</small></div><span class="status ${online(device) ? '' : 'offline'}">${online(device) ? '在线' : '离线'}</span>${!isSelf && device.role !== 'admin' ? `<button class="icon-button" data-action="revoke-device" data-id="${esc(device.id)}" title="断开设备" aria-label="断开 ${esc(device.name)}">${icon('logout')}</button>` : ''}</div>`;
}
async function loadAdmin() {
  try { const [data,settings,summary] = await Promise.all([api('/overview'),api('/playback-settings'),api('/home-summary')]); state.overview = data; state.sources = data.sources || []; state.playbackSettings=settings.settings; state.homeSummary=summary; state.error = ''; }
  catch (error) { state.error = error.message; }
  render();
}
function adminLogin() {
  openModal(`<div class="modal-body">${modalHead('管理家庭服务端')}<p class="modal-description">输入部署电脑或 NAS 时设置的管理密码。</p><form id="admin-form"><label class="form-field"><span>管理密码</span><input name="password" type="password" required autocomplete="current-password" placeholder="输入管理密码" maxlength="512"></label><div class="form-message" role="alert"></div><div class="modal-actions">${button('取消', 'close-modal', 'light')}<button class="button" type="submit">进入管理</button></div></form></div>`);
}
async function enterAdmin() {
  state.status = await api('/status'); state.view = 'server'; state.tab = 'overview';
  history.replaceState(null, '', '/?view=server'); closeModal(); await loadAdmin();
}
function sourceForm(id) {
  const source = state.sources.find(s => s.id === id);
  const form = `<div class="modal-body">${state.playing ? `<h3>${source ? '编辑片源' : '添加片源'}</h3>` : modalHead(source ? '编辑片源' : '添加片源')}<p class="modal-description">支持苹果 CMS JSON 点播接口和 M3U 直播列表。</p><form id="source-form" data-id="${esc(source?.id || '')}"><label class="form-field"><span>片源名称</span><input name="name" required maxlength="80" value="${esc(source?.name || '')}" placeholder="给片源起个容易辨认的名字"></label><label class="form-field"><span>片源类型</span><select name="type"><option value="vod" ${source?.type !== 'live' ? 'selected' : ''}>点播 · 苹果 CMS JSON</option><option value="live" ${source?.type === 'live' ? 'selected' : ''}>直播 · M3U 列表</option></select></label><label class="form-field"><span>接口地址</span><input name="url" type="url" required inputmode="url" value="${esc(source?.url || '')}" placeholder="https://example.com/api.php/provide/vod/"><small>请填写片源接口地址，普通视频网站首页不能直接使用。</small></label><div class="form-message" role="alert"></div><div class="modal-actions">${button('取消', state.playing ? 'cancel-source-form' : 'close-modal', 'light')}<button class="button" type="submit">${source ? '保存修改' : '添加片源'}</button></div></form></div>`;
  if (state.playing) { const target = $('#source-inline-editor'); if (target) { target.innerHTML = form; target.scrollIntoView({block:'nearest'}); } } else openModal(form);
}
async function pairing(origin) {
  const prior = state.pairing;
  const version = openModal(`<div class="modal-body">${modalHead('连接设备')}<div class="loading">正在生成连接二维码…</div></div>`);
  try { const result = await api('/pairing', {method: 'POST', body: origin ? {origin} : {}}); if (version !== state.modalVersion) return; state.pairing = result; renderPairing(); }
  catch (error) { if (version !== state.modalVersion) return; state.pairing = prior; openModal(`<div class="modal-body">${modalHead('连接设备')}<div class="error-banner">${esc(error.message)}</div>${button('重新生成', 'pair', '', 'refresh')}</div>`); }
}
function renderPairing() {
  const pair = state.pairing;
  let chosen = ''; try { chosen = new URL(pair.url).origin; } catch { chosen = addresses()[0]; }
  const options = [...new Set([...addresses(), chosen].filter(Boolean))];
  openModal(`<div class="modal-body">${modalHead('连接家里的映间')}<p class="modal-description">手机、电视和服务端需要连接同一局域网。</p><label class="form-field"><span>服务端地址</span><select id="pair-origin">${options.map(url => `<option value="${esc(url)}" ${url === chosen ? 'selected' : ''}>${esc(url)}</option>`).join('')}</select><small>有多个网卡时，选择与手机所在网络对应的地址。</small></label><div class="pair-layout"><div class="qr-frame"><img src="${esc(pair.qrDataUrl)}" alt="设备连接二维码"></div><div><span class="badge">${icon('qr')}扫码连接</span><p style="font-size:12px;color:var(--muted);margin:13px 0 18px">使用手机系统相机扫码，<br>打开后确认连接。</p><small>或输入六位连接码</small><div class="pair-code">${esc(pair.code)}</div><span class="pair-expiry"></span></div></div><div class="pair-link"><input aria-label="完整连接链接" value="${esc(pair.url)}" readonly><button class="button" data-action="copy" data-value="${esc(pair.url)}">${icon('copy')}复制连接链接</button></div><p class="pair-help">电视：填写上方服务端地址，再输入连接码。<br>链接与连接码仅可使用一次；重新生成后，旧链接立即失效。</p><div class="modal-actions">${button('重新生成', 'regenerate-pair', 'light', 'refresh')}${button('完成', 'close-modal')}</div></div>`);
  updateExpiry();
}
function updateExpiry() {
  const element = $('.pair-expiry');
  if (!element || !state.pairing) return;
  const secs = Math.max(0, Math.ceil((new Date(state.pairing.expiresAt).getTime() - Date.now()) / 1000));
  element.textContent = secs ? `${Math.floor(secs / 60)} 分 ${String(secs % 60).padStart(2, '0')} 秒后失效` : '已过期，请重新生成';
  element.classList.toggle('danger-copy', !secs);
}
function pairingToken() { return new URLSearchParams(location.hash.slice(1)).get('pair'); }
function renderConnect() {
  const token = pairingToken();
  const kind = deviceKind();
  const hint = kind === 'tv' ? '电视' : kind === 'desktop' ? '电脑' : '手机';
  app.innerHTML = `<div class="auth-shell">${brand()}<div class="connect-layout"><div class="connect-intro"><div class="eyebrow">WELCOME HOME</div><h1>连接一次，<br>好内容随时播放。</h1><p>把${hint}连到家里的映间，共享片源、收藏和播放进度。</p>${illustration()}<div class="connect-help">${icon('wifi')}请连接与服务端相同的网络。<br>电脑或 NAS 需要保持运行。</div></div><section class="panel connect-form"><h2>${token ? '确认连接服务端' : '连接家里的映间'}</h2><p>${token ? '确认这是你家里的服务端，再添加这台设备。' : '从服务端获取连接码，或填写服务端地址。'}</p>${state.status?.paired ? `<div class="connection-address">${icon('check')}当前设备已连接。<a class="text-button" href="/?view=${state.view === 'tv' ? 'tv' : 'mobile'}">进入播放 ${icon('arrow')}</a></div>` : ''}${token ? '' : `<div class="nav-pills connect-switch"><button data-action="connect-tab" data-tab="code" class="${state.connectTab === 'code' ? 'active' : ''}">连接码</button><button data-action="connect-tab" data-tab="address" class="${state.connectTab === 'address' ? 'active' : ''}">服务端地址</button></div>`}${token || state.connectTab === 'code' ? `<div class="connection-address">${icon('server')}<span>${esc(location.origin)}</span></div><form id="claim-form"><label class="form-field"><span>设备名称</span><input name="name" required maxlength="60" value="${kind === 'tv' ? '客厅电视' : kind === 'desktop' ? '我的电脑' : '我的手机'}" autocomplete="off"></label><label class="form-field"><span>设备类型</span><select name="kind"><option value="phone" ${kind === 'phone' ? 'selected' : ''}>手机</option><option value="tv" ${kind === 'tv' ? 'selected' : ''}>电视</option><option value="desktop" ${kind === 'desktop' ? 'selected' : ''}>电脑</option></select></label>${token ? '' : '<label class="form-field"><span>六位连接码</span><input class="code-input" name="code" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" required placeholder="000000" autocomplete="one-time-code"><small>在服务端点击「连接设备」获取。</small></label>'}<div class="form-message" role="alert"></div><button class="button full" type="submit">${icon('link')}${token ? '确认连接' : '连接服务端'}</button></form>${token ? '<p class="pair-help">如果链接已使用或过期，请在服务端重新生成。</p>' : `<p class="pair-help">也可以用手机系统相机扫描服务端的二维码，打开链接后确认连接。</p>`}` : `<form id="address-form"><label class="form-field"><span>服务端地址或连接链接</span><input name="address" required type="text" inputmode="url" placeholder="http://192.168.1.100:8080" autocomplete="url"><small>支持粘贴服务端复制的完整连接链接。</small></label><div class="form-message" role="alert"></div><button class="button full" type="submit">前往服务端 ${icon('arrow')}</button></form><div class="connect-help">在服务端的「连接设备」中查看地址。打开地址后，输入连接码即可完成连接。</div>`}</section></div>${footer()}</div>`;
}
const categories = [['all','全部'],['movie','电影'],['series','剧集'],['anime','动漫'],['variety','综艺'],['short','短剧']];
const filterFields = [['year','年份','years'],['area','地区','areas'],['genre','类型','genres']];
function filterRow(key, label, facet) {
  const selected = state.filters[key];
  const values = [...new Set([...(state.facets[facet] || []), ...(selected ? [selected] : [])])];
  const expanded = state.expandedFilters.includes(key);
  const shown = expanded ? values : values.slice(0, 9);
  if (selected && !shown.includes(selected)) shown.push(selected);
  const choice = (value, text) => `<button type="button" data-action="filter" data-filter="${key}" data-value="${esc(value)}" aria-pressed="${selected === value}" class="${selected === value ? 'active' : ''}">${esc(text)}</button>`;
  return `<div class="filter-row"><span class="filter-label" id="filter-label-${key}">${label}</span><div class="filter-choices" role="group" aria-labelledby="filter-label-${key}">${choice('', '全部')}${shown.map(value => choice(value,value)).join('')}${values.length > 9 ? `<button class="filter-more" data-action="expand-filter" data-filter="${key}" aria-expanded="${expanded}">${expanded ? '收起' : '更多'} ${icon('chevron')}</button>` : ''}${!values.length && !state.loading ? '<span class="filter-unavailable">暂无可用信息</span>' : ''}</div></div>`;
}
function renderFilters() {
  const selected = filterFields.filter(([key]) => state.filters[key]);
  const active = selected.length > 0;
  const expanded = state.advancedFiltersOpen ?? (active || state.tab === 'search' || state.filters.category !== 'all');
  const summary = selected.map(([key,label]) => `${label}：${state.filters[key]}`).join(' · ');
  return `<section class="browse-filters ${expanded ? 'filters-expanded' : 'filters-collapsed'}" aria-label="影片筛选"><div class="browse-categories" role="group" aria-label="内容分类">${categories.map(([key,label]) => `<button data-action="filter" data-filter="category" data-value="${key}" aria-pressed="${state.filters.category === key}" class="${state.filters.category === key ? 'active' : ''}">${label}</button>`).join('')}</div>${expanded ? `<div class="filter-fields" id="advanced-filters">${filterFields.map(field => filterRow(...field)).join('')}</div>` : '<div id="advanced-filters" hidden></div>'}<div class="filter-bottom"><div class="sort-choices" role="group" aria-label="排序方式">${[['updated','最近更新'],['score','评分最高']].map(([key,label]) => `<button data-action="filter" data-filter="sort" data-value="${key}" class="${state.filters.sort === key ? 'active' : ''}" aria-pressed="${state.filters.sort === key}">${label}</button>`).join('')}</div><div class="filter-actions"><button class="button light small" data-action="toggle-filters" aria-expanded="${expanded}" aria-controls="advanced-filters">${expanded ? '收起筛选' : `筛选${active ? ` · ${selected.length}` : ''}`}</button>${active ? button('清除筛选','reset-filters','light small') : ''}${button('刷新内容','refresh-catalog','light small','refresh')}</div></div>${active && !expanded ? `<p class="filter-hint">${esc(summary)}</p>` : ''}</section>`;
}
function catalogPager() {
  return `<div class="catalog-pagination">${state.pageCount > 1 ? `<div class="pager"><button class="button white small" data-action="page-prev" ${state.page <= 1 || state.loading ? 'disabled' : ''}>上一页</button><span>第 ${state.page} / ${state.pageCount} 页</span><button class="button white small" data-action="page-next" ${state.page >= state.pageCount || state.loading ? 'disabled' : ''}>下一页</button></div>` : ''}${state.canLoadMore ? button('加载更多内容','load-more-catalog','mint','plus') : ''}${state.scope ? `<p class="catalog-scope">${state.scope.limited ? '已达到本次浏览范围，可搜索片名查找更多影片。' : state.canLoadMore ? '筛选和排序适用于已加载的影片，可继续加载更多。' : '筛选和排序适用于本次已加载的影片。'}${state.filters.sort === 'score' ? ' 评分来自片源，暂无评分的影片排在后面。' : ' 更新时间来自片源，暂无时间的影片排在后面。'}</p>` : ''}</div>`;
}
function selectedSourceName() { return state.sources.find(s => s.id === state.playbackSettings.sourceId)?.name || '全部已启用片源'; }
function sourceName(item) { return item.sourceName || state.sources.find(s => s.id === item.sourceId)?.name || '原片源'; }
function healthSummary() { return state.homeSummary?.sourceHealth || state.overview?.sourceHealth || {enabled:state.sources.filter(s=>s.enabled).length,enabledVod:state.sources.filter(s=>s.enabled&&s.type==='vod').length,averageLatencyMs:null}; }
function searchBar() {
  return `<form class="search-form" id="search-form">${icon('search')}<input name="q" aria-label="搜索影片" placeholder="搜索电影、剧集" value="${esc(state.query)}" maxlength="100"><button class="search-source-count" data-action="tab" data-tab="playback-settings" type="button">${icon('source')}${state.playbackSettings.sourceId ? esc(selectedSourceName()) : `聚合 ${healthSummary().enabledVod} 个片源`}</button><button class="search-submit" type="submit" aria-label="搜索">${icon('arrow')}</button></form>`;
}
function recentSearches() { return state.recentSearches.length ? `<div class="recent-searches" aria-label="最近搜索">${icon('clock')}${state.recentSearches.map(q=>`<button data-action="recent-search" data-query="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : ''; }
function hero(item) {
  if (!item) return '';
  const watched=state.history.find(entry=>sameFilm(entry,item)), favorite=state.favorites.some(entry=>sameFilm(entry,item));
  return `<section class="home-hero"><div class="hero-copy"><span class="hero-label">${watched?'接着上次看':'今日片单'}</span><h1>${esc(item.title)}</h1><p class="hero-meta">${Number(item.score)>0?`★ ${Number(item.score).toFixed(1)} · `:''}${esc([item.year,item.type,item.remarks].filter(Boolean).join(' · '))}</p><p class="hero-source">${icon('source')}来源：${esc(sourceName(item))}</p><div class="hero-actions"><button class="button" data-action="${watched?'resume':'detail'}" data-source="${esc(item.sourceId)}" data-id="${esc(item.id)}">${icon('play')}${watched?'继续观看':'查看影片'}</button><button class="button light" data-action="favorite-card" data-source="${esc(item.sourceId)}" data-id="${esc(item.id)}">${icon(favorite?'check':'plus')}${favorite?'已收藏':'收藏'}</button></div></div><div class="hero-art"><span class="poster-placeholder">${icon('play')}</span>${safeUrl(item.poster)?`<img src="${esc(safeUrl(item.poster))}" alt="">`:''}<span class="hero-art-label">${esc(item.remarks||item.type||'家庭影音')}</span></div></section>`;
}
function continueSection() { return state.history.length ? `<section class="continue-section"><div class="section-heading"><h2>继续观看 <small>${state.history.length} 部 · 进度已同步</small></h2><button class="text-button" data-action="tab" data-tab="history">全部 ${icon('chevron')}</button></div>${historyGrid(state.history.slice(0,5))}</section>` : ''; }
function sourceHealthStrip() { const h=healthSummary(); return `<button class="source-health" data-action="tab" data-tab="playback-settings">${icon('link')}<span class="health-copy"><strong>家庭片源</strong><small>${h.enabled} 个片源已启用 · ${h.averageLatencyMs==null?'可在播放设置中测试延迟':`平均响应 ${Math.round(h.averageLatencyMs)} ms`}</small></span><span>设置 ${icon('chevron')}</span></button>`; }
function quickActions() { const live=state.homeSummary?.liveChannels; return `<nav class="quick-actions" aria-label="快捷入口">${[['live','tv','直播',live?.known?`${live.count} 个频道`:'浏览频道'],['history','clock','观看历史',`${state.history.length} 条`],['favorites','heart','我的收藏',`${state.favorites.length} 部`],['playback-settings','settings','播放设置','片源与播放']].map(([tab,symbol,label,count])=>`<button data-action="tab" data-tab="${tab}">${icon(symbol)}<strong>${label}</strong><span class="quick-count">${count}</span></button>`).join('')}</nav>`; }
function channelGrid(channels=state.channels) { return `<div class="channels">${channels.map(channel=>`<button class="channel" data-action="play-channel" data-index="${state.channels.indexOf(channel)}"><span class="channel-logo">${channel.logo&&safeUrl(channel.logo)?`<img src="${esc(safeUrl(channel.logo))}" alt="" loading="lazy">`:icon('tv')}</span><span><strong>${esc(channel.name)}</strong><small>${esc(channel.group||'直播频道')} · ${esc(sourceName(channel))}</small></span></button>`).join('')}</div>`; }
function renderConsumer() {
  const browsing=state.tab==='home'||state.tab==='search';
  const onHome=state.tab==='home'&&state.page===1&&state.filters.category==='all'&&!state.filters.year&&!state.filters.area&&!state.filters.genre;
  let content='';
  if (state.tab==='playback-settings') content=playbackSettingsPage();
  else if(state.loading) content='<div class="loading" role="status">正在获取片源内容，请稍候…</div>';
  else if(state.tab==='live') content=`<div class="section-heading"><h1>直播频道</h1><small>${state.channels.length} 个已加载频道</small>${button('刷新','reload','light small','refresh')}</div>${state.channels.length?channelGrid():empty('还没有可播放的直播频道','添加并启用 M3U 直播列表，即可在这里观看。',button('添加直播源','add-source','mint','plus'),'tv')}`;
  else if(state.tab==='favorites') content=`<div class="section-heading"><h1>我的收藏</h1><small>家庭共享 · ${state.favorites.length} 部</small></div>${state.favorites.length?posterGrid(state.favorites):empty('把喜欢的电影留在这里','打开影片详情，点击「收藏」。',button('去发现','go-home','mint','arrow'),'heart')}`;
  else if(state.tab==='history') content=`<div class="section-heading"><h1>观看历史</h1><small>家庭设备共享播放进度</small></div>${state.history.length?historyGrid(state.history):empty('还没有播放记录','开始播放后，这里会记住你的观看进度。',button('去发现','go-home','mint','play'),'clock')}`;
  else {
    const hasSources=state.sources.some(s=>s.enabled&&s.type==='vod'), categoryTitle=categories.find(([key])=>key===state.filters.category)?.[1]||'全部';
    const heading=state.tab==='search'?`“${esc(state.query)}”的搜索结果`:onHome?'影片推荐':categoryTitle==='全部'?'全部影片':categoryTitle;
    if(onHome) content+=hero(state.items[0])+continueSection()+sourceHealthStrip()+quickActions();
    content+=`<section class="catalog-section"><div class="section-heading" id="catalog-results"><h2>${heading}</h2><small>${state.total} 条 · ${esc(selectedSourceName())}</small></div>`;
    content+=state.items.length?posterGrid(state.items):empty(hasSources?'暂时没有符合条件的影片':'还没有启用的点播片源',hasSources?'可以清除筛选、加载更多，或搜索片名。':'前往播放设置添加片源，或启用已有片源。',hasSources?button('清除筛选','reset-filters','mint'):'<button class="button mint" data-action="tab" data-tab="playback-settings">播放设置</button>','search');
    content+=catalogPager()+'</section>';
    if(onHome&&state.items.some(item=>Number(item.score)>0)) {
      const rated=[...state.items].filter(item=>Number(item.score)>0).sort((a,b)=>b.score-a.score).slice(0,3);
      content+=`<section class="ranking-section panel"><div class="section-heading"><h2>高分片单</h2><small>片源评分 · 本次已加载内容</small></div><div class="ranking-list">${rated.map((item,index)=>`<button class="ranking-row" data-action="detail" data-source="${esc(item.sourceId)}" data-id="${esc(item.id)}"><span class="rank-number">${index+1}</span>${safeUrl(item.poster)?`<img src="${esc(safeUrl(item.poster))}" alt="" loading="lazy">`:''}<span><strong>${esc(item.title)}</strong><small>${esc([item.year,item.type,sourceName(item)].filter(Boolean).join(' · '))}</small></span><span class="badge">★ ${Number(item.score).toFixed(1)}</span></button>`).join('')}</div></section>`;
    }
    if(onHome&&state.channels.length) content+=`<section class="live-preview"><div class="section-heading"><h2>直播频道</h2><button class="text-button" data-action="tab" data-tab="live">查看全部 ${icon('chevron')}</button></div>${channelGrid(state.channels.slice(0,3))}</section>`;
  }
  const failures=state.failures.length&&browsing?`<div class="error-banner"><details><summary>${state.failures.length} 个片源暂时无法读取，其余内容仍可浏览</summary>${state.failures.map(f=>`<p>${esc(f.name||state.sources.find(s=>s.id===f.sourceId)?.name||'片源')}：${esc(f.error||'连接失败')}</p>`).join('')}</details></div>`:'';
  const focused=document.activeElement, focusKey=state.filterFocus?.key||focused?.dataset?.filter, focusValue=state.filterFocus?state.filterFocus.value:focused?.dataset?.value;
  app.innerHTML=`<div class="shell consumer ${state.view==='tv'?'tv':''}">${topbar()}${browsing?`<div class="consumer-search">${searchBar()}${recentSearches()}</div>${renderFilters()}`:''}${state.error?`<div class="error-banner">${esc(state.error)} ${button('重试','reload','white small','refresh')}</div>`:''}${failures}${content}${state.view==='tv'?'<div class="footer"><span class="tv-help"><span><kbd>↑ ↓ ← →</kbd> 移动</span><span><kbd>OK</kbd> 选择</span><span><kbd>返回</kbd> 返回上一级</span></span><span class="status">局域网 · 家庭服务已连接</span></div>':footer()}<nav class="bottom-nav" aria-label="主导航">${navItem('home','首页','home')}${navItem('live','直播','tv')}${navItem('playback-settings','片源','source')}${navItem('favorites','收藏','heart')}${navItem('history','历史','clock')}</nav></div>`;
  attachImageFallbacks();
  if(focusKey) [...app.querySelectorAll('[data-filter]')].find(el=>el.dataset.filter===focusKey&&el.dataset.value===focusValue)?.focus({preventScroll:true});
}

function updateLabel(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '暂无时间';
}
function posterGrid(items) {
  return `<div class="poster-grid">${items.map(item=>`<button class="poster-card" data-action="detail" data-id="${esc(item.id)}" data-source="${esc(item.sourceId)}"><div class="poster"><span class="poster-placeholder">${icon('play')}</span>${safeUrl(item.poster)?`<img src="${esc(safeUrl(item.poster))}" alt="" loading="lazy">`:''}${item.remarks?`<span class="poster-badge">${esc(item.remarks)}</span>`:''}${Number(item.score)>0?`<span class="poster-score" aria-label="片源评分 ${Number(item.score).toFixed(1)}">★ ${Number(item.score).toFixed(1)}</span>`:''}</div><span class="poster-title">${esc(item.title)}</span><span class="poster-meta">${esc([item.year,item.genres?.[0]||item.type].filter(Boolean).join(' · ')||'资料待补充')}</span><span class="poster-source-label">${icon('source')}${esc(sourceName(item))}</span><span class="poster-update">更新 ${esc(updateLabel(item.updatedAt))}</span></button>`).join('')}</div>`;
}
function historyGrid(items) {
  return `<div class="continue-strip history-grid">${items.map(item=>`<button class="continue-card history-card" data-action="resume" data-id="${esc(item.id)}" data-source="${esc(item.sourceId)}"><span class="continue-art"><span class="poster-placeholder">${icon('play')}</span>${safeUrl(item.poster)?`<img src="${esc(safeUrl(item.poster))}" alt="" loading="lazy">`:''}<span class="poster-badge">${esc(item.episodeName||'继续播放')}</span><span class="progress-track"><i style="width:${Math.max(0,Math.min(100,Number(item.position||0)/Math.max(1,Number(item.duration||1))*100))}%"></i></span></span><span class="continue-copy"><strong>${esc(item.title)}</strong><small>${esc(item.episodeName||'继续播放')} · ${shortTime(item.position)}</small><small>${esc(sourceName(item))}</small></span></button>`).join('')}</div>`;
}

function attachImageFallbacks() { document.querySelectorAll('img:not([src="/icon.svg"])').forEach(img => { if (img.complete && !img.naturalWidth) img.hidden = true; else img.addEventListener('error', () => { img.hidden = true; }, {once:true}); }); }
async function loadConsumer({loadMore = false, refresh = false} = {}) {
  const requestId = ++state.requestId;
  state.loading = true; state.error = ''; state.failures = []; render();
  try {
    const [sources, history, favorites, settings, summary] = await Promise.all([api('/sources'), api('/history'), api('/favorites'),api('/playback-settings'),api('/home-summary')]);
    if (requestId !== state.requestId) return;
    state.sources = sources.sources || []; state.history = history.items || []; state.favorites = favorites.items || [];
    state.playbackSettings=settings.settings; state.homeSummary=summary;
    if (state.tab === 'live') { const data = await api('/live'); if (requestId !== state.requestId) return; state.channels = data.channels || []; state.failures = data.failures || []; }
    else if ((state.tab === 'home' || state.tab === 'search') && state.sources.some(source => source.enabled && source.type === 'vod')) {
      const query = new URLSearchParams({...state.filters,page:state.page,pageSize:24});
      if (state.tab === 'search') query.set('q',state.query);
      if (refresh) query.set('refresh','1');
      if (loadMore) { query.set('loadMore','1'); if (state.snapshot) query.set('snapshot',state.snapshot); }
      const data = await api('/' + (state.tab === 'search' ? 'search' : 'catalog') + '?' + query);
      if (requestId !== state.requestId) return;
      state.items = data.items || []; state.page = Number(data.page) || 1;
      state.pageCount = Number(data.pageCount) || 1; state.total = Number(data.total) || state.items.length;
      state.facets = data.facets || {years:[],areas:[],genres:[]}; state.scope = data.scope || null; state.snapshot = data.snapshot || '';
      state.canLoadMore = Boolean(data.canLoadMore); state.failures = data.failures || [];
    } else if (state.tab === 'home' || state.tab === 'search') {
      state.items = []; state.pageCount = 1; state.total = 0; state.canLoadMore = false;
      state.scope = null; state.facets = {years:[],areas:[],genres:[]};
    }
  } catch (error) { if (requestId === state.requestId) { state.error = error.message; state.items = []; } }
  finally { if (requestId === state.requestId) { state.loading = false; state.loaded = true; render(); state.filterFocus = null; } }
}
const variantKey = item => `${item.sourceId}:${item.id}`;
const sameFilm = (left, right) => Boolean(left && right && ((left.groupKey && right.groupKey && left.groupKey === right.groupKey) || variantKey(left) === variantKey(right)));
function mergeVariants(...lists) {
  const seen = new Map();
  for (const item of lists.flat()) if (item?.sourceId && item?.id !== undefined) seen.set(variantKey(item), {...seen.get(variantKey(item)), ...item});
  return [...seen.values()];
}
function sourceControls(player = false) {
  const session = state.detailSession;
  if (!session) return '';
  const selected = player ? state.playing : state.detail?.item;
  return `<div class="source-picker"><div class="source-picker-heading"><h3>播放源</h3><span role="status">${state.sourceBusy ? '正在准备切换…' : session.loading ? '正在查找其他片源…' : `${session.variants.length} 个可选片源`}</span></div><div class="source-choices" role="group" aria-label="切换播放源">${session.variants.map((item,index) => `<button data-action="switch-source" data-index="${index}" aria-pressed="${variantKey(item) === variantKey(selected || {})}" class="${variantKey(item) === variantKey(selected || {}) ? 'active' : ''}">${esc(item.sourceName || state.sources.find(source => source.id === item.sourceId)?.name || '片源')}${item.remarks ? `<small>${esc(item.remarks)}</small>` : ''}</button>`).join('')}</div>${session.error ? `<p class="source-help">${esc(session.error)}</p>` : ''}${player ? '<p class="source-help">换源会匹配当前集数，并接着当前进度播放。</p>' : ''}</div>`;
}
function refreshSourceControls() {
  const active = document.activeElement;
  const focused = active?.dataset?.action === 'switch-source' ? active.dataset.index : undefined;
  const player = modal.classList.contains('player-dialog') && state.playing;
  const container = $('#source-controls', modal);
  if (container) container.innerHTML = sourceControls(Boolean(player));
  if (focused !== undefined) $('#source-controls [data-index="' + focused + '"]')?.focus({preventScroll:true});
}
async function findAlternatives(session, sourceId, id) {
  try {
    const data = await api(`/alternatives?sourceId=${encodeURIComponent(sourceId)}&id=${encodeURIComponent(id)}`);
    if (state.detailSession !== session) return;
    session.groupKey = data.groupKey || session.groupKey;
    session.variants = mergeVariants(session.variants, data.variants || []);
    session.error = data.failures?.length ? '部分片源暂时未响应，已找到的片源仍可使用。' : '';
    if (state.detail?.item) state.detail.item.groupKey ||= session.groupKey;
  } catch { if (state.detailSession === session) session.error = '暂时无法查找更多片源，可先使用已找到的片源。'; }
  finally { if (state.detailSession === session) { session.loading = false; refreshSourceControls(); } }
}
async function showDetail(sourceId, id, resume = false) {
  stopPlayer();
  state.playerSettingsOpen = false;
  const known = [...state.items, ...state.history, ...state.favorites].find(item => (String(item.id) === String(id) && item.sourceId === sourceId) || item.variants?.some(entry => String(entry.id) === String(id) && entry.sourceId === sourceId));
  const session = {groupKey:known?.groupKey, variants:mergeVariants(known?.variants || [], known ? [known] : []), loading:false, error:''};
  state.detailSession = session; state.pendingSource = null;
  const version = openModal(`<div class="modal-body">${modalHead('影片详情')}<div class="loading">正在获取影片信息…</div></div>`, 'detail-dialog');
  try {
    const detail = await api(`/detail?sourceId=${encodeURIComponent(sourceId)}&id=${encodeURIComponent(id)}`);
    if (version !== state.modalVersion || state.detailSession !== session) return;
    if (!detail.item) throw new Error('片源没有返回影片详情');
    detail.item.sourceId ||= sourceId; detail.item.id ||= id; detail.item.groupKey ||= known?.groupKey;
    session.groupKey = detail.item.groupKey || session.groupKey;
    session.variants = mergeVariants(session.variants, detail.item.variants || [], detail.variants || [], [detail.item]);
    state.detail = detail; state.line = 0;
    session.loading = false;
    if (resume) {
      const historyItem = state.history.find(item => sameFilm(item, detail.item));
      if (historyItem) {
        const matched = matchEpisode(historyItem.episodeName, detail.lines, {preferredLine:detail.lines?.[Number(historyItem.line)]?.name, movie:detail.item.category === 'movie',sourceEpisodeCount:1});
        if (matched) { state.line = matched.line; return playEpisode(matched.episode, Number(historyItem.position) || 0); }
        toast('这个片源没有匹配到上次的集数，请选择要播放的一集。');
      }
    }
    renderDetail();
  } catch (error) { if (version === state.modalVersion) openModal(`<div class="modal-body">${modalHead('影片详情')}<div class="error-banner">${esc(error.message)}</div>${button('关闭', 'close-modal', 'light')}</div>`); }
}
function renderDetail() {
  if (!state.detail) return;
  const {item, lines = []} = state.detail;
  const favorite = state.favorites.some(entry => sameFilm(entry,item));
  const line = lines[state.line] || lines[0];
  openModal(`<div class="modal-body">${modalHead('影片详情')}<div class="detail-top"><div class="poster"><span class="poster-placeholder">${icon('play')}</span>${safeUrl(item.poster) ? `<img src="${esc(safeUrl(item.poster))}" alt="">` : ''}</div><div class="detail-copy"><h2>${esc(item.title)}</h2><div class="meta">${esc([item.year,item.type,item.remarks].filter(Boolean).join(' · '))}<br>更新 ${esc(updateLabel(item.updatedAt))}</div><p class="description">${esc(item.description || '片源暂未提供剧情介绍。')}</p><button class="button ${favorite ? 'mint' : 'light'}" data-action="favorite-detail">${icon('heart')}${favorite ? '已收藏 · 取消' : '收藏'}</button></div></div><p class="detail-source">来源：${esc(sourceName(item))}</p><div class="line-selector"><h3>选择剧集</h3>${lines.length ? `<select id="play-line" aria-label="播放线路">${lines.map((entry,index) => `<option value="${index}" ${state.line === index ? 'selected' : ''}>${esc(entry.name || `线路 ${index + 1}`)}</option>`).join('')}</select>` : ''}</div>${line?.episodes?.length ? `<div class="episode-grid">${line.episodes.map((episode,index) => `<button class="episode-button" data-action="play-episode" data-index="${index}">${esc(episode.name || `第 ${index + 1} 集`)}</button>`).join('')}</div>` : empty('没有可播放的剧集', '这个片源没有返回受支持的播放地址，请尝试其他片源。', '', 'play')}</div>`, 'detail-dialog');
  attachImageFallbacks();
}
function cancelSourceSwitch() {
  state.sourceRequest++; state.switchCancel?.(); state.switchCancel = null;
  state.sourceBusy = false; state.pendingSource = null;
}
async function switchSource(index) {
  const session = state.detailSession, variant = session?.variants[index];
  const current = state.playing || state.detail?.item;
  if (!variant) return;
  if (variantKey(variant) === variantKey(current || {})) { cancelSourceSwitch(); $('#source-switch-choice')?.replaceChildren(); refreshSourceControls(); return; }
  cancelSourceSwitch();
  $('#source-switch-choice')?.replaceChildren();
  const request = state.sourceRequest, modalVersion = state.modalVersion, original = state.playing;
  const stillCurrent = () => request === state.sourceRequest && session === state.detailSession && modal.open && modalVersion === state.modalVersion && original === state.playing;
  state.sourceBusy = true; refreshSourceControls();
  try {
    const detail = await api(`/detail?sourceId=${encodeURIComponent(variant.sourceId)}&id=${encodeURIComponent(variant.id)}`);
    if (!stillCurrent()) return;
    if (!detail.item) throw new Error('该片源没有返回影片详情');
    detail.item = {...variant, ...detail.item, groupKey:session.groupKey || detail.item.groupKey};
    if (!original) { state.detail = detail; state.line = 0; state.sourceBusy = false; renderDetail(); return; }
    const previousLine = state.detail?.lines?.[Number(original.line)];
    const matched = matchEpisode(original.episodeName, detail.lines, {preferredLine:previousLine?.name, movie:original.category === 'movie',sourceEpisodeCount:previousLine?.episodes?.length || 0});
    if (!matched) {
      state.pendingSource = {detail,index};
      showUnmatchedSource(detail);
      return;
    }
    await prepareSourceSwitch(detail, matched, original, stillCurrent);
  } catch (error) {
    if (stillCurrent()) { playerError(`切换失败：${error.message}。当前片源继续播放。`); toast(`切换失败：${error.message}`); }
  } finally { if (request === state.sourceRequest) { state.sourceBusy = false; refreshSourceControls(); } }
}
function showUnmatchedSource(detail) {
  const area = $('#source-switch-choice');
  if (!area) return;
  area.innerHTML = `<div class="source-unmatched"><strong>这个片源没有匹配到「${esc(state.playing?.episodeName || '当前集数')}」</strong><p>当前播放继续。你可以在下方手动选择对应的一集；选择后会接着当前进度播放。</p><div class="source-manual-lines">${(detail.lines || []).map((line,lineIndex) => `<div><small>${esc(line.name || `线路 ${lineIndex + 1}`)}</small><div class="episode-grid">${(line.episodes || []).map((episode,episodeIndex) => `<button class="episode-button" data-action="switch-source-episode" data-line="${lineIndex}" data-index="${episodeIndex}">${esc(episode.name || `第 ${episodeIndex + 1} 集`)}</button>`).join('')}</div></div>`).join('')}</div>${button('取消换源','cancel-source-switch','light small')}</div>`;
}
async function manualSourceEpisode(line, episode) {
  const pending = state.pendingSource, original = state.playing;
  if (!pending || !original) return;
  const request = ++state.sourceRequest, version = state.modalVersion;
  state.switchCancel?.(); state.switchCancel = null; state.sourceBusy = true; refreshSourceControls();
  const stillCurrent = () => request === state.sourceRequest && state.playing === original && version === state.modalVersion && modal.open;
  try { await prepareSourceSwitch(pending.detail, {line,episode}, original, stillCurrent); }
  catch (error) { if (stillCurrent()) { playerError(`切换失败：${error.message}。当前片源继续播放。`); toast(error.message); } }
  finally { if (request === state.sourceRequest) { state.sourceBusy = false; refreshSourceControls(); } }
}
function createMedia(video, url, directUrl, onError) {
  let hls = null;
  const safe = safeUrl(url);
  if (!safe) throw new Error('片源返回了无效的视频地址');
  const isFile = /\.(?:mp4|m4v|webm|ogv|ogg|mov)(?:[?#]|$)/i.test(directUrl || safe);
  if (!isFile && window.Hls?.isSupported()) {
    hls = new window.Hls({maxBufferLength:30,enableWorker:true});
    hls.on(window.Hls.Events.ERROR, (_event,data) => {
      if (!data.fatal) return;
      if (data.details === window.Hls.ErrorDetails.MANIFEST_PARSING_ERROR) { hls?.destroy(); hls = null; video.src = safe; }
      else onError(new Error('片源视频加载失败，请检查网络或尝试其他片源'));
    });
    hls.loadSource(safe); hls.attachMedia(video);
  } else video.src = safe;
  return {destroy() { hls?.destroy(); hls = null; }};
}
async function prepareSourceSwitch(detail, match, original, stillCurrent) {
  const selection = {sourceId:detail.item.sourceId,id:detail.item.id,line:match.line,episode:match.episode};
  const data = await api('/playback', {method:'POST',body:selection});
  if (!stillCurrent()) return;
  const oldVideo = $('#video');
  if (!oldVideo) return;
  const candidate = document.createElement('video');
  candidate.className = 'source-preview-video'; candidate.preload = 'auto'; candidate.muted = true; candidate.playsInline = true;
  modal.appendChild(candidate);
  let controller, captured, settled = false, commit = false;
  const ready = new Promise((resolve,reject) => {
    const timer = setTimeout(() => finish(new Error('新片源加载或恢复进度超时')), 25000);
    const poll = setInterval(check, 150);
    function finish(error) {
      if (settled) return;
      settled = true; clearTimeout(timer); clearInterval(poll);
      if (error) reject(error); else resolve();
    }
    state.switchCancel = () => finish(new Error('已取消换源'));
    function check() {
      if (!stillCurrent()) return finish(new Error('已取消换源'));
      if (candidate.error) return finish(new Error('新片源无法播放'));
      if (candidate.readyState < 2) return;
      if (!captured) {
        captured = {position:Number.isFinite(oldVideo.currentTime) ? oldVideo.currentTime : 0,paused:oldVideo.paused,volume:oldVideo.volume,muted:oldVideo.muted,rate:oldVideo.playbackRate};
        saveProgress(); oldVideo.pause();
      }
      if (captured.position > 0) {
        const target = seekTarget(captured.position, candidate.duration, candidate.seekable);
        if (target === null) return;
        if (Math.abs(candidate.currentTime - target) > 0.75) { try { candidate.currentTime = target; } catch { return; } return; }
        if (candidate.seeking || candidate.readyState < 2) return;
      }
      finish();
    }
    candidate.addEventListener('error', () => finish(new Error('新片源无法播放')), {once:true});
    try { controller = createMedia(candidate,data.url,data.directUrl,error => { if (commit) playerError(error.message); else finish(error); }); }
    catch (error) { finish(error); }
  });
  try {
    await ready;
    if (!stillCurrent()) return;
    commit = true; state.switchCancel = null;
    original.ignoreProgress = true;
    state.hls?.destroy(); oldVideo.pause(); oldVideo.removeAttribute('src'); oldVideo.load();
    state.detail = detail; state.line = match.line; state.pendingSource = null;
    state.playing = {...detail.item,...selection,...data,resumeAt:0,resumePending:false,lastSaved:0,preferences:captured};
    state.hls = controller;
    showPlayer(candidate);
    saveProgress();
    toast(`已切换到 ${detail.item.sourceName || '新片源'}，接着播放`);
  } finally {
    if (!commit) {
      controller?.destroy(); candidate.pause(); candidate.removeAttribute('src'); candidate.load(); candidate.remove();
      if (captured && !captured.paused && state.playing === original) oldVideo.play().catch(() => {});
    }
  }
}
async function playEpisode(episode, resumeAt = 0) {
  const item = state.detail.item;
  await startPlayback({sourceId:item.sourceId,id:item.id,line:state.line,episode}, item, resumeAt);
}
async function startPlayback(selection, item, resumeAt = 0) {
  stopPlayer();
  const version = openModal(`<div class="modal-body">${modalHead(item.title || item.name || '正在准备播放')}<div class="loading">正在获取播放地址…</div></div>`, 'player-dialog');
  try {
    const data = await api('/playback', {method:'POST',body:selection});
    if (version !== state.modalVersion) return;
    state.playing = {...item,...selection,...data,resumeAt,resumePending:resumeAt > 0,lastSaved:0};
    showPlayer();
  } catch (error) { if (version === state.modalVersion) openModal(`<div class="modal-body">${modalHead('暂时无法播放')}<div class="error-banner">${esc(error.message)}</div>${!selection.channelId && state.detail ? button('返回选集', 'back-detail', 'light') : button('关闭', 'close-modal', 'light')}</div>`, 'detail-dialog'); }
}
function showPlayer(preparedVideo = null) {
  const playing = state.playing;
  const nextEpisode = !playing.channelId && state.detail?.lines?.[playing.line]?.episodes?.[Number(playing.episode) + 1];
  const transport = state.view === 'tv' ? `<div class="tv-transport" aria-label="播放控制">${button('播放 / 暂停', 'player-toggle', 'small', 'play')}${!playing.channelId ? button('后退 10 秒', 'seek-back', 'small') + button('前进 10 秒', 'seek-forward', 'small') : ''}${button('全屏', 'fullscreen', 'small', 'tv')}${nextEpisode ? button('下一集', 'next-episode', 'small', 'arrow') : ''}</div>` : '';
  preparedVideo?.remove();
  openModal(`<div class="modal-body">${modalHead(`${playing.title || '直播'}${playing.episodeName ? ` · ${playing.episodeName}` : ''}`)}<video id="video" controls playsinline tabindex="0"></video>${transport}<div class="player-error" role="alert"></div><div class="player-footer"><span>${playing.channelId ? '直播' : `${esc(playing.sourceName || '')} · 进度自动保存`}</span><div class="row-actions">${playing.directUrl ? button('尝试直连', 'direct-play', 'small') : ''}${button('播放设置', 'player-settings', 'small', 'settings')}${!playing.channelId ? button('返回选集', 'back-detail', 'small') : ''}</div></div><section class="player-settings-panel" id="player-settings-panel" ${state.playerSettingsOpen ? '' : 'hidden'}><div class="section-heading"><h3>播放设置</h3>${button('收起', 'player-settings', 'small light')}</div>${!playing.channelId ? `<div id="source-controls">${state.playerSettingsOpen ? sourceControls(true) : ''}</div><div id="source-switch-choice"></div>` : ''}<div class="player-settings-controls" id="player-settings-controls">${state.playerSettingsOpen ? playbackSettingsPage(true) : ''}</div></section></div>`, 'player-dialog');
  if (preparedVideo) {
    preparedVideo.id = 'video'; preparedVideo.className = ''; preparedVideo.controls = true; preparedVideo.tabIndex = 0;
    $('#video').replaceWith(preparedVideo);
  }
  const video = $('#video');
  const prefs = playing.preferences;
  if (prefs) { video.volume = prefs.volume; video.muted = prefs.muted; video.playbackRate = prefs.rate; }
  const maybeResume = () => {
    if (state.playing !== playing || !playing.resumePending) return;
    const target = seekTarget(playing.resumeAt,video.duration,video.seekable);
    if (target === null) return;
    if (Math.abs(video.currentTime - target) > 0.75) { try { video.currentTime = target; } catch { /* Wait for a seekable media range. */ } return; }
    if (!video.seeking) { playing.resumePending = false; playing.resumeAt = 0; playing.started = true; if (!prefs?.paused) video.play().catch(() => {}); }
  };
  ['loadedmetadata','canplay','progress','durationchange','seeked','timeupdate'].forEach(event => video.addEventListener(event,maybeResume));
  video.addEventListener('canplay', () => { if (!playing.resumePending && !prefs?.paused && !playing.started) { playing.started = true; video.play().catch(() => {}); } });
  video.addEventListener('timeupdate', () => { if (Date.now() - playing.lastSaved > 10000) saveProgress(); });
  video.addEventListener('pause', () => { if (state.playing === playing) saveProgress(); });
  video.addEventListener('ended', async () => { await saveProgress(); if (state.playing !== playing) return; if (state.playbackSettings.autoNext && nextEpisode) { try { await playEpisode(Number(playing.episode)+1); } catch (error) { playerError(error.message); } } else toast('本集播放结束'); });
  video.addEventListener('error', () => playerError('播放失败，可打开播放设置尝试其他片源，或尝试直连。'));
  if (!preparedVideo) attachPlayback(playing.url); else if (!prefs?.paused) { playing.started = true; video.play().catch(() => {}); }
  if (state.view === 'tv') $('[data-action="player-toggle"]')?.focus();
  heartbeat();
}
function playerError(message) { const element = $('.player-error'); if (element) element.textContent = message; }
function attachPlayback(url) {
  const video = $('#video'), playing = state.playing;
  if (!video || !playing) return;
  if (video.currentTime > 0) { playing.resumeAt = video.currentTime; playing.resumePending = true; }
  state.hls?.destroy(); state.hls = null;
  playing.started = false;
  try { state.hls = createMedia(video,url,url === playing.url ? playing.directUrl : url,error => playerError(error.message)); }
  catch (error) { playerError(error.message); }
}
async function saveProgress() {
  const video = $('#video'); const playing = state.playing;
  if (!video || !playing || playing.ignoreProgress || playing.resumePending || playing.channelId || !playing.id || !isFinite(video.currentTime) || video.currentTime < 1) return;
  playing.lastSaved = Date.now();
  const body = {sourceId:playing.sourceId,id:playing.id,groupKey:playing.groupKey,title:playing.title,year:playing.year,category:playing.category,type:playing.type,recordedAt:Date.now(),poster:playing.poster || '',episodeName:playing.episodeName || '',line:Number(playing.line) || 0,episode:Number(playing.episode) || 0,position:video.currentTime,duration:isFinite(video.duration) ? video.duration : 0};
  const persist = async () => { try { await api('/history', {method:'PUT',body,keepalive:true}); } catch { /* Playback continues if history is temporarily unavailable. */ } };
  saveProgress.pending = (saveProgress.pending || Promise.resolve()).then(persist);
  return saveProgress.pending;
}
function stopPlayer() {
  cancelSourceSwitch();
  if (!state.playing) return;
  saveProgress();
  state.playing = null;
  const video = $('#video'); if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
  state.hls?.destroy(); state.hls = null;
  heartbeat();
}

function connectionInfo() {
  openModal(`<div class="modal-body">${modalHead('家庭连接')}<div class="connection-address">${icon('wifi')}<span>${esc(location.origin)}</span></div><p class="modal-description">${esc(state.status?.device?.name || '当前设备')}已连接。片源、收藏与播放进度由家里的服务端共享。</p><div class="stack">${state.status.role === 'admin' ? '<a class="button light" href="/?view=server">管理家庭服务端</a>' : ''}<a class="button light" href="/?view=${state.view === 'tv' ? 'mobile' : 'tv'}">${state.view === 'tv' ? '切换普通界面' : '切换电视界面'}</a>${nativeShell ? '<p class="pair-help">更换服务端：点击应用顶部「连接设置」。</p>' : `<a class="button light" href="/connect?view=${state.view === 'tv' ? 'tv' : 'mobile'}">连接其他服务端</a>`}${button('退出当前设备', 'logout', 'light', 'logout')}</div></div>`);
}
async function copyText(value) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value);
    else { const input = document.createElement('textarea'); input.value = value; input.style.position = 'fixed'; input.style.opacity = '0'; (modal.open ? modal : document.body).appendChild(input); input.select(); const copied = document.execCommand('copy'); input.remove(); if (!copied) throw new Error('请长按链接手动复制'); }
    toast('已复制');
  } catch (error) { toast(error.message || '请长按链接手动复制'); }
}
function confirmation(title, copy, action, id) { openModal(`<div class="modal-body">${modalHead(title)}<p class="modal-description">${esc(copy)}</p><div class="modal-actions">${button('取消', 'close-modal', 'light')}<button class="button danger" data-action="${action}" data-id="${esc(id)}">确认${title}</button></div></div>`); }
async function searchFor(query) {
  state.query=String(query||'').trim(); state.tab=state.query?'search':'home'; state.page=1;
  state.filters={category:'all',year:'',area:'',genre:'',sort:'updated'}; state.facets={years:[],areas:[],genres:[]}; state.advancedFiltersOpen=null; state.expandedFilters=[];
  if(state.query) { state.recentSearches=[state.query,...state.recentSearches.filter(q=>q!==state.query)].slice(0,6); try{localStorage.setItem('yingjian-recent-searches',JSON.stringify(state.recentSearches));}catch{} }
  await loadConsumer();
}
async function toggleFavorite(item) {
  const favorite=state.favorites.find(entry=>sameFilm(entry,item));
  if(favorite) await api(`/favorites/${encodeURIComponent(favorite.key||`${item.sourceId}:${item.id}`)}`,{method:'DELETE'});
  else await api('/favorites',{method:'POST',body:item});
  state.favorites=(await api('/favorites')).items||[];
}
async function handleAction(element) {
  const action = element.dataset.action;
  if (action === 'close-modal') { stopPlayer(); closeModal(); return; }
  if (action === 'copy') return copyText(element.dataset.value);
  if (action === 'activate-admin') { await api('/auth/local-admin', {method:'POST',body:{name:'家庭管理员'}}); return enterAdmin(); }
  if (action === 'login-admin') return adminLogin();
  if (action === 'tab') { state.tab = element.dataset.tab; state.page = 1; state.query = ''; state.error = ''; state.view === 'server' ? await loadAdmin() : await loadConsumer(); return; }
  if (action === 'go-home') { state.tab = 'home'; state.query = ''; return loadConsumer(); }
  if (action === 'pair') return pairing(addresses()[0]);
  if (action === 'regenerate-pair') return pairing($('#pair-origin')?.value || addresses()[0]);
  if (action === 'add-source') return sourceForm();
  if (action === 'edit-source') return sourceForm(element.dataset.id);
  if (action === 'delete-source') { const source=state.sources.find(s=>s.id===element.dataset.id); if(source) return confirmSourceMutation(source,'confirm-delete-source'); }
  if (action === 'confirm-delete-source') { await mutateSource(element.dataset.id,'DELETE'); toast('片源已删除'); return; }
  if (action === 'confirm-disable-source') { await mutateSource(element.dataset.id,'PATCH',{enabled:false}); toast('片源已停用'); return; }
  if (action === 'toggle-source') { const source=state.sources.find(s=>s.id===element.dataset.id); if(!source) return; if(source.enabled && state.playing?.sourceId===source.id) return confirmSourceMutation(source,'confirm-disable-source'); await mutateSource(source.id,'PATCH',{enabled:!source.enabled}); return; }
  if (action === 'probe-source') return probeSource(element.dataset.id);
  if (action === 'probe-all') {
    if(state.batchProbing) return;
    state.batchProbing=true; refreshSettingsSurface(); toast('正在测试接口延迟…');
    const queue=[...state.sources];
    const run=async()=>{while(queue.length){const source=queue.shift(); state.probing.add(source.id); try{await api(`/sources/${encodeURIComponent(source.id)}/probe`,{method:'POST'});}catch{}finally{state.probing.delete(source.id);}}};
    try{await Promise.all([run(),run(),run()]);}finally{state.batchProbing=false; await reloadSourceState();} toast('接口延迟测试完成'); return;
  }
  if (action === 'select-browse-source') return chooseBrowseSource(element.dataset.id || '');
  if (action === 'toggle-auto-next') { const data=await api('/playback-settings',{method:'PATCH',body:{autoNext:!state.playbackSettings.autoNext}}); state.playbackSettings=data.settings; refreshSettingsSurface(); return; }
  if (action === 'source-type') { state.sourceType=element.dataset.type; refreshSettingsSurface(); return; }
  if (action === 'cancel-source-confirm') { $('#source-confirm')?.replaceChildren(); return; }
  if (action === 'cancel-source-form') { $('#source-inline-editor')?.replaceChildren(); return; }
  if (action === 'player-settings') {
    state.playerSettingsOpen=!state.playerSettingsOpen; const panel=$('#player-settings-panel'); if(!panel) return;
    panel.hidden=!state.playerSettingsOpen;
    if(state.playerSettingsOpen) { refreshSettingsSurface(); panel.scrollIntoView({block:'nearest'}); const session=state.detailSession; if(session && !session.searched && state.playing && !state.playing.channelId) { session.searched=true; session.loading=true; refreshSourceControls(); findAlternatives(session,state.playing.sourceId,state.playing.id); } }
    return;
  }
  if (action === 'recent-search') { await searchFor(element.dataset.query); return; }
  if (action === 'revoke-device') { const device = state.overview?.devices.find(d => d.id === element.dataset.id); return confirmation('断开设备', `「${device?.name || '该设备'}」需要重新扫码或输入连接码才能使用。`, 'confirm-revoke', element.dataset.id); }
  if (action === 'confirm-revoke') { await api(`/devices/${encodeURIComponent(element.dataset.id)}`,{method:'DELETE'}); modal.close(); toast('设备已断开'); return loadAdmin(); }
  if (action === 'connect-tab') { state.connectTab = element.dataset.tab; renderConnect(); return; }
  if (action === 'logout') { stopPlayer(); await api('/auth/logout',{method:'POST'}); location.href = `/connect?view=${state.view === 'tv' ? 'tv' : 'mobile'}`; return; }
  if (action === 'filter') {
    const key = element.dataset.filter;
    if (!Object.prototype.hasOwnProperty.call(state.filters,key)) return;
    if (state.filters[key] === element.dataset.value) return;
    state.filterFocus = {key, value:element.dataset.value};
    state.filters[key] = element.dataset.value; state.page = 1;
    if (key === 'category') { state.filters.year = ''; state.filters.area = ''; state.filters.genre = ''; state.facets = {years:[],areas:[],genres:[]}; state.expandedFilters = []; state.advancedFiltersOpen = null; }
    return loadConsumer();
  }
  if (action === 'toggle-filters') {
    state.advancedFiltersOpen = element.getAttribute('aria-expanded') !== 'true';
    renderConsumer(); $('[data-action="toggle-filters"]')?.focus({preventScroll:true}); return;
  }
  if (action === 'expand-filter') {
    const key = element.dataset.filter;
    state.expandedFilters = state.expandedFilters.includes(key) ? state.expandedFilters.filter(value => value !== key) : [...state.expandedFilters,key];
    renderConsumer(); return;
  }
  if (action === 'reset-filters') { state.filters.year = ''; state.filters.area = ''; state.filters.genre = ''; state.page = 1; return loadConsumer(); }
  if (action === 'load-more-catalog') return loadConsumer({loadMore:true});
  if (action === 'refresh-catalog') { state.page = 1; state.snapshot = ''; return loadConsumer({refresh:true}); }
  if (action === 'reload') return state.view === 'server' ? loadAdmin() : loadConsumer();
  if (action === 'page-prev' || action === 'page-next') { state.page = Math.max(1,state.page + (action === 'page-next' ? 1 : -1)); await loadConsumer(); window.scrollTo({top:0,behavior:'smooth'}); return; }
  if (action === 'detail' || action === 'resume') return showDetail(element.dataset.source, element.dataset.id, action === 'resume');
  if (action === 'favorite-card') { const item=state.items.find(item=>item.sourceId===element.dataset.source&&String(item.id)===element.dataset.id); if(item) { await toggleFavorite(item); renderConsumer(); } return; }
  if (action === 'favorite-detail') {
    await toggleFavorite(state.detail.item); renderDetail(); if (state.tab === 'favorites') renderConsumer(); return;
  }
  if (action === 'switch-source') return switchSource(Number(element.dataset.index));
  if (action === 'switch-source-episode') return manualSourceEpisode(Number(element.dataset.line), Number(element.dataset.index));
  if (action === 'cancel-source-switch') { cancelSourceSwitch(); $('#source-switch-choice')?.replaceChildren(); refreshSourceControls(); return; }
  if (action === 'play-episode') return playEpisode(Number(element.dataset.index));
  if (action === 'back-detail') { stopPlayer(); return renderDetail(); }
  if (action === 'play-channel') { const channel = state.channels[Number(element.dataset.index)]; state.detail = null; return startPlayback({sourceId:channel.sourceId,channelId:channel.id},{...channel,title:channel.name}); }
  if (action === 'direct-play') { $('.player-error').textContent = ''; attachPlayback(state.playing.directUrl); toast('已切换为直连，兼容性取决于片源'); return; }
  if (action === 'player-toggle') { const video = $('#video'); if (video) { if (video.paused) await video.play(); else video.pause(); } return; }
  if (action === 'seek-back' || action === 'seek-forward') { const video = $('#video'); if (video && Number.isFinite(video.duration)) video.currentTime = Math.max(0,Math.min(video.duration,video.currentTime + (action === 'seek-back' ? -10 : 10))); return; }
  if (action === 'next-episode' && state.playing) return playEpisode(Number(state.playing.episode) + 1);
  if (action === 'fullscreen') { const video = $('#video'); if (video?.requestFullscreen) await video.requestFullscreen(); else if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen(); else toast('这台设备暂不支持全屏播放'); return; }
  if (action === 'connection-info') return connectionInfo();
}
document.addEventListener('click', async (event) => {
  const element = event.target.closest('[data-action]');
  if (!element || element.disabled) return;
  event.preventDefault(); element.disabled = true;
  try { await handleAction(element); } catch (error) { toast(error.message); } finally { if (element.isConnected) element.disabled = false; }
});
document.addEventListener('submit', async (event) => {
  const form = event.target; event.preventDefault();
  const submit = form.querySelector('[type="submit"]'); const message = $('.form-message',form);
  if (submit) submit.disabled = true; if (message) message.textContent = '';
  const data = Object.fromEntries(new FormData(form));
  try {
    if (form.id === 'admin-form') { await api('/auth/admin',{method:'POST',body:{password:data.password,name:'家庭管理员'}}); await enterAdmin(); }
    if (form.id === 'source-form') {
      if(form.dataset.id && state.playing?.sourceId===form.dataset.id) {
        const original=state.sources.find(source=>source.id===form.dataset.id);
        if(original && (original.url!==data.url || original.type!==data.type) && !form.dataset.confirmed) {
          form.dataset.confirmed='1'; if(message) message.textContent='修改当前播放源的接口或类型会保存进度并停止播放。再次点击保存修改确认。'; return;
        }
      }
      if(form.dataset.id) await mutateSource(form.dataset.id,'PATCH',data);
      else { await api('/sources',{method:'POST',body:data}); if(!state.playing) closeModal(); invalidateCatalog(); await reloadSourceState(); }
      toast(form.dataset.id?'片源已更新':'片源已添加');
    }
    if (form.id === 'claim-form') { const token = pairingToken(); await api('/pairing/claim',{method:'POST',body:{name:data.name,kind:data.kind,...(token ? {token} : {code:data.code})}}); history.replaceState(null,'',`/connect?view=${data.kind === 'tv' ? 'tv' : 'mobile'}`); location.href = `/?view=${data.kind === 'tv' ? 'tv' : 'mobile'}`; }
    if (form.id === 'address-form') {
      const address = data.address.trim(); const url = new URL(/^https?:\/\//i.test(address) ? address : `http://${address}`);
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('请填写有效的 HTTP 或 HTTPS 服务端地址');
      if (nativeShell && url.origin !== location.origin) throw new Error('请点击应用顶部「连接设置」，选择「更换服务端」后填写此地址。');
      const target = new URL('/connect',url.origin); target.searchParams.set('view',state.view === 'tv' ? 'tv' : 'mobile');
      const token = new URLSearchParams(url.hash.slice(1)).get('pair'); if (token) target.hash = new URLSearchParams({pair:token}).toString();
      location.assign(target.href);
    }
    if (form.id === 'search-form') await searchFor(data.q);
  } catch (error) { if (message) message.textContent = error.message; else toast(error.message); }
  finally { if (submit?.isConnected) submit.disabled = false; }
});
document.addEventListener('change', (event) => {
  if (event.target.id === 'pair-origin') pairing(event.target.value);
  if (event.target.id === 'play-line') { state.line = Number(event.target.value); renderDetail(); }
});
document.addEventListener('input',event=>{
  if(event.target.id==='source-search') { state.sourceSearch=event.target.value; const list=$('.source-settings-list',state.playing?modal:app); if(list) list.innerHTML=sourceSettingsList(); }
  if(event.target.closest('#source-form')) delete event.target.closest('#source-form').dataset.confirmed;
});
modal.addEventListener('cancel', () => { state.modalVersion++; stopPlayer(); });
modal.addEventListener('click', (event) => { if (event.target === modal) { const rect = modal.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { stopPlayer(); closeModal(); } } });
window.yingjianBack = () => {
  if (modal.open) {
    const returnToDetail = modal.classList.contains('player-dialog') && state.detail;
    stopPlayer(); closeModal(); if (returnToDetail) renderDetail(); return true;
  }
  if (state.view !== 'server' && state.tab !== 'home' && location.pathname !== '/connect') {
    state.tab = 'home'; state.query = ''; loadConsumer(); return true;
  }
  return false;
};
function spatialFocus(key) {
  const scope = modal.open ? modal : app;
  const elements = [...scope.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),video')].filter(element => element.getClientRects().length);
  const focused = document.activeElement;
  if (!elements.includes(focused)) { elements[0]?.focus(); return; }
  const origin = focused.getBoundingClientRect(); const x = origin.left + origin.width / 2; const y = origin.top + origin.height / 2;
  const candidates = elements.filter(el => el !== focused).map(element => { const rect=element.getBoundingClientRect();return {element,dx:rect.left+rect.width/2-x,dy:rect.top+rect.height/2-y}; }).filter(({dx,dy}) => key === 'ArrowLeft' ? dx < -5 : key === 'ArrowRight' ? dx > 5 : key === 'ArrowUp' ? dy < -5 : dy > 5).map(candidate => ({...candidate,score: key === 'ArrowLeft' || key === 'ArrowRight' ? Math.abs(candidate.dx)+Math.abs(candidate.dy)*3 : Math.abs(candidate.dy)+Math.abs(candidate.dx)*3})).sort((a,b)=>a.score-b.score);
  candidates[0]?.element.focus(); candidates[0]?.element.scrollIntoView({block:'nearest',inline:'nearest'});
}
document.addEventListener('keydown', (event) => {
  if (document.fullscreenElement) return;
  if (event.key === 'Escape' || event.key === 'BrowserBack' || (event.key === 'Backspace' && !/INPUT|TEXTAREA/.test(event.target.tagName))) {
    if (window.yingjianBack()) event.preventDefault();
  }
  if (state.view !== 'tv' || !['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) return;
  if (event.target.tagName === 'VIDEO' || event.target.tagName === 'SELECT' || (/INPUT|TEXTAREA/.test(event.target.tagName) && ['ArrowLeft','ArrowRight'].includes(event.key))) return;
  event.preventDefault(); spatialFocus(event.key);
});
async function heartbeat() {
  if (!state.status?.paired || location.pathname === '/connect') return;
  const video=$('#video'), playing=state.playing;
  try { await api('/heartbeat',{method:'POST',body:{kind:deviceKind(),...(playing ? {playing:{title:playing.title,episode:playing.episodeName,sourceId:playing.sourceId,id:playing.id,poster:playing.poster,position:Number.isFinite(video?.currentTime)?video.currentTime:0,duration:Number.isFinite(video?.duration)?video.duration:0,paused:Boolean(video?.paused)}} : {})}}); } catch { /* A subsequent action shows connection errors. */ }
}
window.addEventListener('pagehide', () => saveProgress());
window.addEventListener('hashchange', () => { if (location.pathname === '/connect') renderConnect(); });
setInterval(updateExpiry,1000);
setInterval(heartbeat,25000);
setInterval(() => { if (state.view === 'server' && state.status?.role === 'admin' && !modal.open && !document.hidden) loadAdmin(); },30000);
async function boot() {
  try {
    try { const recent=JSON.parse(localStorage.getItem('yingjian-recent-searches')||'[]'); state.recentSearches=Array.isArray(recent)?recent.filter(q=>typeof q==='string').slice(0,6):[]; } catch{}
    state.status = await api('/status');
    state.view ||= /YingjianTV/.test(navigator.userAgent) ? 'tv' : state.status.role === 'admin' || (state.status.localAdminAvailable && innerWidth >= 900) ? 'server' : 'mobile';
    state.tab = state.view === 'server' ? 'overview' : 'home';
    if (location.pathname === '/connect' && state.status.paired && !pairingToken() && nativeShell) { location.replace(`/?view=${state.view === 'tv' ? 'tv' : 'mobile'}`); return; }
    if (location.pathname === '/connect' || !state.status.paired) render();
    else if (state.view === 'server' && state.status.role === 'admin') await loadAdmin();
    else if (state.view === 'server') render();
    else await loadConsumer();
    heartbeat();
  } catch (error) { state.error = `无法连接服务端：${error.message}`; state.view ||= 'mobile'; renderWelcome(); }
}
boot();
