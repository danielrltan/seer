// `seer daemon` (run by launchd): serves Seer home on 127.0.0.1:7399, which the tunnel publishes behind sign-in
// at seer.<zone>, and holds the Mac awake (caffeinate -is) while any preview is running.
// caffeinate cannot stop sleep when the lid is closed on battery: the Mac must stay open, or plugged in.
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { list } from './core.js';
import { tail } from './devserver.js';
import { cleanName } from './store.js';
import { HOME_PORT } from './services.js';
import { reconcile, release, failover } from './awake.js';
import { attachStream } from './stream.js';
import { desktopPage } from './viewer.js';
import { ensureStreamAuth } from './core.js';

let away = { mode: 'starting' };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STYLE = `
:root{--bg:#000;--surface:#0a0a0a;--border:#262626;--text:#ededed;--quiet:#a1a1a1;--live:#00e676;--fail:#ff4d4f;--wait:#f5a524;--off:#525252}
@media (prefers-color-scheme: light){:root{--bg:#fff;--surface:#fafafa;--border:#eaeaea;--text:#171717;--quiet:#666;--off:#a3a3a3}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 Geist,-apple-system,system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:20px 16px 48px}
header{display:flex;align-items:center;gap:10px;padding:4px 0 20px}
header b{font-size:17px;font-weight:600}
a{color:inherit;text-decoration:none}
.row{display:flex;align-items:center;gap:12px;padding:14px 16px;margin-bottom:8px;background:var(--surface);border:1px solid var(--border);border-radius:8px}
.dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--off)}
.running .dot{background:var(--live)}.failed .dot{background:var(--fail)}.starting .dot{background:var(--wait)}
.name{font:500 14px/1.3 'Geist Mono',ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{color:var(--quiet);font-size:13px;margin-left:auto;white-space:nowrap}
.empty{color:var(--quiet);padding:24px 0}
.foot{color:var(--quiet);font-size:13px;margin-top:20px}
pre{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;overflow:auto;font:12px/1.5 'Geist Mono',ui-monospace,monospace;white-space:pre-wrap;word-break:break-word}
`;
const EYE = `<svg width="22" height="14" viewBox="0 0 22 14" aria-hidden="true"><path d="M1 7C4 2 7.5 1 11 1s7 1 10 6c-3 5-6.5 6-10 6S4 12 1 7Z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="11" cy="7" r="2.6" fill="#00e676"/></svg>`;

export const APP_HEAD = `<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials"><link rel="apple-touch-icon" href="/icon-180.png">
<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Seer"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#000"><title>${esc(title)}</title>
${APP_HEAD}
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@500&display=swap" rel="stylesheet">
<style>${STYLE}</style></head><body><main><header>${EYE}<b>Seer</b></header>${body}</main></body></html>`;
}

async function home() {
  const items = await list();
  const b = away.battery;
  const foot = `<p class="foot">Mac: ${esc(away.mode)}${b ? ` · ${b.onBattery ? `battery ${b.pct}%` : 'plugged in'}` : ''}</p>`;
  const desktop = `<a class="row running" href="/desktop"><span class="dot"></span><span class="name">desktop</span><span class="meta">streamed</span></a>`;
  if (!items.length) return page('Seer', desktop + foot);
  const rows = desktop + items.map(p => {
    const href = p.state === 'running' ? p.url : `/log/${encodeURIComponent(p.name)}`;
    return `<a class="row ${esc(p.state.replace(/\s+/g, '-'))}" href="${esc(href)}"><span class="dot"></span><span class="name">${esc(p.name)}</span><span class="meta">${esc(p.state)}</span></a>`;
  }).join('');
  return page('Seer', rows + foot);
}

// Can this browser decode the H.264 stream Streamed mode sends (WebCodecs)? Opened once from the phone.
function checkPage() {
  return page('Stream check', `<pre id="out">checking…</pre><script>
(async () => {
  const lines = ['browser: ' + navigator.userAgent, 'VideoDecoder: ' + ('VideoDecoder' in window)];
  for (const codec of ['avc1.42E01F', 'avc1.4D401F', 'avc1.640028']) {
    try { lines.push(codec + ': ' + (await VideoDecoder.isConfigSupported({ codec, codedWidth: 1280, codedHeight: 800, hardwareAcceleration: 'prefer-hardware' })).supported); }
    catch (e) { lines.push(codec + ': ' + e.message); }
  }
  lines.push('screen: ' + screen.width + 'x' + screen.height + ' @' + devicePixelRatio + 'x');
  document.getElementById('out').textContent = lines.join('\\n');
  fetch('/s/check-result', { method: 'POST', body: lines.join('\\n') });
})();
</script>`);
}

function logPage(name) {
  return page(`${name} log`, `<header><a href="/">&larr;</a><span class="name">${esc(name)}</span></header><pre>${esc(tail(name, 120)) || 'No log yet.'}</pre>`);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/s/check-result' && req.method === 'POST') {          // what the phone reported, for Seer's log
      let body = ''; for await (const c of req) { body += c; if (body.length > 4000) break; }
      log('stream check from a browser:\n' + body.slice(0, 4000));
      res.writeHead(204); return res.end();
    }
    // Home-screen app: opened from its icon, iOS shows Seer with no browser bars (a page cannot hide them itself).
    if (url.pathname === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json' });
      return res.end(JSON.stringify({
        name: 'Seer', short_name: 'Seer', start_url: '/desktop', scope: '/', display: 'standalone', orientation: 'any',
        background_color: '#000000', theme_color: '#000000',
        icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }],
      }));
    }
    const icon = url.pathname.match(/^\/icon-(180|192|512)\.png$/);
    if (icon) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
      return res.end(fs.readFileSync(new URL(`../assets/icon-${icon[1]}.png`, import.meta.url)));
    }
    if (url.pathname === '/desktop') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(desktopPage()); }
    if (url.pathname === '/s/check') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(checkPage()); }
    const m = url.pathname.match(/^\/log\/([^/]+)$/);
    const html = m ? logPage(cleanName(decodeURIComponent(m[1]))) : url.pathname === '/' ? await home() : null;
    if (!html) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Seer home failed: ' + e.message);
  }
}).listen(HOME_PORT, '127.0.0.1', () => console.log(`seer home on 127.0.0.1:${HOME_PORT}`));
attachStream(server, msg => log(msg));
ensureStreamAuth().then(() => log('desktop stream: Access token check ready')).catch(e => log(`desktop stream: ${e.message}`));

// Hold the Mac awake while anything is running; let it sleep when nothing is. caffeinate covers an open lid;
// away mode (awake.js) covers a closed one and fails over to the hotspot when the Wi-Fi goes.
let awake = null, running = false;
const log = msg => console.log(`${new Date().toISOString()} ${msg}`);
const checkNetwork = failover(log);
async function tick() {
  running = (await list().catch(() => [])).some(p => p.state === 'running');
  if (running && !awake) {
    awake = spawn('/usr/bin/caffeinate', ['-is'], { stdio: 'ignore' });
    awake.on('exit', () => { awake = null; });
  } else if (!running && awake) { awake.kill(); awake = null; }
  const next = await reconcile(running).catch(e => ({ mode: 'error', why: e.message }));
  if (next.mode !== away.mode || next.why !== away.why) log(`away mode: ${next.mode} (${next.why})`);
  away = next;
}
setInterval(tick, 15_000);
setInterval(() => checkNetwork(running).catch(e => log(`failover: ${e.message}`)), 5_000);
tick();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { awake?.kill(); await release().catch(() => {}); process.exit(0); });
