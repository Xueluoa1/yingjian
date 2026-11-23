// Optional network smoke check against the user's imported sources. Never writes production data.
import { createApp } from '../server/index.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { resolve } from 'node:path';

const directory = resolve('test-results');
await mkdir(directory, { recursive: true });
const dataDir = await mkdtemp(resolve(directory, 'smoke-'));
const app = await createApp({ dataDir });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let cookie = '';
const report = { checkedAt: new Date().toISOString(), checks: [], samples: [] };
async function api(path, body) {
  const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { cookie, 'X-Yingjian': '1', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(65000) });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
async function sampleStream(path, depth = 0) {
  if (depth > 4) throw new Error('HLS nesting exceeded');
  if (!path.startsWith('/api/stream?')) throw new Error('Playlist resource was not proxied');
  const response = await fetch(origin + path, { headers: { cookie, Range: 'bytes=0-4095' }, signal: AbortSignal.timeout(25000) });
  if (!response.ok) { const message = (await response.text()).slice(0, 300); throw new Error(`Stream HTTP ${response.status}: ${message}`); }
  const type = response.headers.get('content-type') || '';
  if (/mpegurl/.test(type)) {
    const playlist = await response.text();
    const child = playlist.split(/\r?\n/).find(line => line.trim() && !line.startsWith('#'));
    if (!child) throw new Error('Empty playlist');
    return { playlistDepth: depth + 1, ...(await sampleStream(child.trim(), depth + 1)) };
  }
  const reader = response.body.getReader();
  const chunk = await reader.read();
  await reader.cancel();
  if (!chunk.value?.length) throw new Error('Empty media body');
  return { mediaStatus: response.status, mediaType: type, sampledBytes: chunk.value.length };
}
try {
  await api('/api/auth/local-admin', {});
  const sources = (await api('/api/sources')).sources;
  report.checks.push({ name: 'fresh seeded sources', total: sources.length, enabled: sources.filter(x => x.enabled).length });
  const result = await api('/api/search?q=' + encodeURIComponent('地球'));
  report.checks.push({ name: 'aggregate search', itemCount: result.items.length, failures: result.failures });
  console.log(`Search returned ${result.items.length} items, ${result.failures.length} failed sources`);
  const unique = [...new Map(result.items.map(item => [item.sourceId, item])).values()];
  for (const item of unique.slice(0, 5)) {
    const sample = { source: item.sourceName, title: item.title };
    try {
      const detail = await api(`/api/detail?sourceId=${encodeURIComponent(item.sourceId)}&id=${encodeURIComponent(item.id)}`);
      const line = detail.lines.findIndex(line => line.episodes.some(episode => /\.m3u8(?:\?|$)|\.mp4(?:\?|$)/i.test(episode.url)));
      if (line < 0) throw new Error('No direct HLS/MP4 line');
      const episode = detail.lines[line].episodes.findIndex(episode => /\.m3u8(?:\?|$)|\.mp4(?:\?|$)/i.test(episode.url));
      const playback = await api('/api/playback', { sourceId: item.sourceId, id: item.id, line, episode });
      Object.assign(sample, { ok: true, ...await sampleStream(playback.url) });
    } catch (error) { Object.assign(sample, { ok: false, error: error.message }); }
    report.samples.push(sample);
    console.log(`${sample.ok ? 'OK' : 'FAIL'} ${sample.source}: ${sample.ok ? sample.sampledBytes + ' media bytes' : sample.error}`);
    if (sample.ok) break;
  }
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  await app.locals.close();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  await writeFile(resolve(directory, 'live-smoke.json'), JSON.stringify(report, null, 2));
}
if (!report.samples.some(sample => sample.ok)) process.exitCode = 1;
