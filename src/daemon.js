// `seer daemon` (run by launchd): serves Seer home on 127.0.0.1:7399, which the tunnel publishes behind sign-in
// at seer.<zone>, and holds the Mac awake (caffeinate -is) while any preview is running.
// caffeinate cannot stop sleep when the lid is closed on battery: the Mac must stay open, or plugged in.
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { list } from './core.js';
import { tail } from './devserver.js';
import { cleanName, loadConfig, saveConfig } from './store.js';
import { HOME_PORT } from './services.js';
import { reconcile, release, failover, battery, ruleInstalled, savePassword, hasPassword } from './awake.js';
import { awakeReason, seen } from './activity.js';
import { macStatus, lid, sampleBattery } from './macstatus.js';
import { homePage } from './home.js';
import { settingsPage } from './settingspage.js';
import { settings, applySettings, FREEZABLE } from './settings.js';
import { hooksInstalled, installHooks } from './hooks.js';
import { sleepDisplay, freezeApps, thawAll, frozenCount, muteOutput, unmuteOutput } from './headless.js';
import { initStream, streamUpgrade, authorizeViewer, cleanInput, verifyAccess, viewerCount } from './stream.js';
import { localTarget, openSession, input as renderInput, closeSession, openWindow, closeWindow, windowOpen } from './render.js';
import { WebSocketServer } from 'ws';
import { desktopPage } from './viewer.js';
import { ensureStreamAuth } from './core.js';

let away = { mode: 'starting' };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STYLE = `
:root{--bg:#000;--surface:#0a0a0a;--border:#262626;--text:#ededed;--quiet:#a1a1a1;--live:#00e676;--live-text:#00e676;--fail:#ff4d4f;--wait:#f5a524;--wait-text:#f5a524;--off:#525252}
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
.label{color:var(--quiet);font-size:13px;margin:22px 2px 8px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 14px;min-height:84px}
.tile.wide{grid-column:1 / -1;min-height:0;display:flex;align-items:center;gap:12px}
.tile .k{color:var(--quiet);font-size:12px}
.tile .v{font-size:22px;font-weight:600;letter-spacing:-.01em;margin-top:4px;display:flex;align-items:center;gap:8px;white-space:nowrap}
.tile .s{color:var(--quiet);font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile.wide .v{font-size:15px;margin:0}.tile.wide .s{margin:0}
.tile.col{flex-direction:column;align-items:stretch;gap:12px}.tile .line{display:flex;align-items:center;gap:12px}
.stay{display:flex;align-items:center;gap:10px}.stay[hidden]{display:none}
.stay input{flex:1;accent-color:var(--live);height:28px}
.stay button{flex:none;height:34px;padding:0 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:500 13px Geist,-apple-system,system-ui,sans-serif}
.ok{color:var(--live-text)}.warn{color:var(--wait-text)}.bad{color:var(--fail)}
.batt{width:26px;height:13px;border:1.5px solid currentColor;border-radius:3px;position:relative;opacity:.9}
.batt i{position:absolute;left:1.5px;top:1.5px;bottom:1.5px;border-radius:1px;background:currentColor}
.batt:after{content:'';position:absolute;right:-4px;top:3px;width:2px;height:4px;background:currentColor;border-radius:0 1px 1px 0}
.bars{display:inline-flex;align-items:flex-end;gap:2px;height:13px}.bars i{width:3px;background:var(--off);border-radius:1px}.bars i.on{background:currentColor}
.help{margin-top:8px;padding:12px 14px;border:1px solid var(--wait);border-radius:8px;color:var(--text);font-size:14px}
.help+.help{margin-top:6px}
pre{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;overflow:auto;font:12px/1.5 'Geist Mono',ui-monospace,monospace;white-space:pre-wrap;word-break:break-word}
`;
const EYE = `<svg width="22" height="14" viewBox="0 0 22 14" aria-hidden="true"><path d="M1 7C4 2 7.5 1 11 1s7 1 10 6c-3 5-6.5 6-10 6S4 12 1 7Z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="11" cy="7" r="2.6" fill="#00e676"/></svg>`;

export const APP_HEAD = `<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon-180.png"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/icon-32.png" sizes="32x32" type="image/png">
<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Seer"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#000"><title>${esc(title)}</title>
${APP_HEAD}
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@500&display=swap" rel="stylesheet">
<style>${STYLE}</style></head><body><main><header>${EYE}<b>Seer</b></header>${body}</main></body></html>`;
}

// Seer home: the Mac's status (battery, ping, network, lid, awake and why, anything that needs you), refreshed
// every 5 s from /status.json, with the ping timed from the phone itself, then the projects.
async function projects() {
  const out = (await list()).map(p => ({ name: p.name, href: p.state === 'running' ? p.url : `/log/${encodeURIComponent(p.name)}`, state: p.state, where: 'mac' }));
  for (const [name, c] of Object.entries(loadConfig().cloud || {})) if (c.link) out.push({ name, href: c.link, state: 'on demand', where: 'cloud' });
  return out;
}
export async function statusJson() {
  const st = await macStatus({ awake: { awake: why.awake, why: why.why, mode: away.mode, stayUntil: why.stayUntil || 0, reachableUntil: why.reachableUntil || 0, headless, pluggedIn: !away.battery?.onBattery }, agentsBusy: why.agentsBusy || 0 });
  return { ...st, projects: await projects(), desktop: !!loadConfig().desktop };
}

async function home() {
  return homePage(JSON.stringify(await statusJson()).replace(/</g, '\\u003c'), APP_HEAD);
}

// What the Settings page shows: the settings, the apps it can freeze, and what is installed on the Mac.
async function settingsJson() {
  const s = settings();
  return { settings: s, apps: FREEZABLE, installed: { away: await ruleInstalled(), hooks: hooksInstalled(), hotspotPassword: s.hotspotSsid ? await hasPassword(s.hotspotSsid) : false } };
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
    if (req.headers['cf-access-jwt-assertion']) seen();          // someone opened a Seer page: they may come back soon
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
    // Icons, favicon and manifest are the only paths open without sign-in (a Cloudflare Access bypass, `seer
    // public assets`): iOS fetches a home-screen icon without the login, so behind it the icon never loaded.
    if (url.pathname === '/favicon.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' }); return res.end(fs.readFileSync(new URL('../assets/logo/seer-icon.svg', import.meta.url))); }
    if (url.pathname === '/favicon.ico') { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' }); return res.end(fs.readFileSync(new URL('../assets/icon-32.png', import.meta.url))); }
    const icon = url.pathname.match(/^\/icon-(32|180|192|512)\.png$/);
    if (icon) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
      return res.end(fs.readFileSync(new URL(`../assets/icon-${icon[1]}.png`, import.meta.url)));
    }
    // Mac view. With the screen stream on: a real Chrome window on the Mac, shown through the stream cropped to it
    // (/render/open opens it). Without: headless Chrome frames (/render/ws).
    if (url.pathname === '/render') {
      // Back goes to the project's own page (phone view) that the eye was tapped on.
      const host = url.searchParams.get('host') || '', p = url.searchParams.get('path') || '/';
      const backHref = /^seer-[a-z0-9-]+\./.test(host) && p.startsWith('/') && !p.startsWith('//') ? `https://${host}${p}` : '/';
      const page = loadConfig().desktop ? desktopPage({ wsPath: '/desktop/ws', dock: false, title: 'Mac view', openPath: '/render/open', backHref })
        : desktopPage({ wsPath: '/render/ws', dock: false, title: 'Mac view', backHref });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(page);
    }
    if (url.pathname === '/render/open' && req.method === 'POST') {
      const cfg = loadConfig();
      const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
      if (req.headers.origin !== `https://seer.${cfg.zone}` || !(await verifyAccess(req.headers['cf-access-jwt-assertion'], cfg).catch(() => null))) return json(403, { error: 'sign in first' });
      const target = localTarget(url.searchParams.get('host'), url.searchParams.get('path'));
      if (!target) return json(404, { error: 'That project is not running on this Mac' });
      try {
        const { bounds, screen } = await openWindow(target, log);
        windowSince = Date.now();
        return json(200, { crop: { x: bounds.left / screen.width, y: bounds.top / screen.height, w: bounds.width / screen.width, h: bounds.height / screen.height } });
      } catch (e) { return json(500, { error: `Mac view: ${e.message}` }); }
    }
    if (url.pathname === '/desktop' && loadConfig().desktop) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(desktopPage()); }
    // Settings: the page, what it shows, and saving. A save from the phone needs the sign-in and Seer's own
    // origin, like stay awake; /local/settings is Seer.app's menu on this Mac (no tunnel header, no origin).
    if (url.pathname === '/settings' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(settingsPage(JSON.stringify(await settingsJson()).replace(/</g, '\\u003c'), APP_HEAD));
    }
    if (url.pathname === '/settings.json') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(await settingsJson())); }
    const fromPhone = req.method === 'POST' && ['/settings', '/settings/hooks'].includes(url.pathname);
    const fromMenu = req.method === 'POST' && url.pathname === '/local/settings' && !req.headers['cf-connecting-ip'] && req.socket.remoteAddress === '127.0.0.1' && !req.headers.origin;
    if (fromPhone || fromMenu) {
      const cfg = loadConfig();
      const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
      if (fromPhone && (req.headers.origin !== `https://seer.${cfg.zone}` || !(await verifyAccess(req.headers['cf-access-jwt-assertion'], cfg).catch(() => null)))) return json(403, { error: 'sign in first' });
      try {
        if (url.pathname === '/settings/hooks') { log(`settings: ${installHooks()}`); return json(200, await settingsJson()); }
        let body = ''; for await (const c of req) { body += c; if (body.length > 4000) throw new Error('too long'); }
        const { hotspotPassword, ...patch } = JSON.parse(body || '{}');
        if (fromMenu && Object.keys(patch).some(k => k !== 'launchAtLogin')) return json(403, { error: 'the menu only sets launch at login' });
        applySettings(patch);
        if (hotspotPassword !== undefined) {
          const ssid = settings().hotspotSsid;
          if (!ssid) throw new Error('set the hotspot name first');
          if (typeof hotspotPassword !== 'string' || hotspotPassword.length < 8 || hotspotPassword.length > 63) throw new Error('a Wi-Fi password is 8 to 63 characters');
          await savePassword(ssid, hotspotPassword);
        }
        log(`settings: ${[...Object.entries(patch).map(([k, v]) => `${k}=${JSON.stringify(v)}`), ...(hotspotPassword !== undefined ? ['hotspot password saved'] : [])].join(', ')}`);
        if (patch.desktop) startStream();
        if (patch.away === false) await release().catch(() => {});
        tick();
        return json(200, await settingsJson());
      } catch (e) { return json(400, { error: e.message }); }
    }
    // Stay awake (the slider): { minutes } from now, 0 cancels; at most 12 hours.
    if (url.pathname === '/awake' && req.method === 'POST') {
      const cfg = loadConfig();
      const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
      if (req.headers.origin !== `https://seer.${cfg.zone}` || !(await verifyAccess(req.headers['cf-access-jwt-assertion'], cfg).catch(() => null))) return json(403, { error: 'sign in first' });
      let body = ''; for await (const c of req) { body += c; if (body.length > 1000) break; }
      const minutes = Math.max(0, Math.min(720, Math.round(Number(JSON.parse(body || '{}').minutes) || 0)));
      saveConfig({ stayAwakeUntil: minutes ? Date.now() + minutes * 60_000 : 0 });
      log(minutes ? `stay awake: ${minutes} min, asked from the phone` : 'stay awake: cancelled');
      await tick();
      return json(200, { stayUntil: loadConfig().stayAwakeUntil || 0 });
    }
    // Seer.app's menu (on this Mac, so no Cloudflare login to show): the same stay-awake as the slider.
    if (url.pathname === '/local/awake' && req.method === 'POST' && !req.headers['cf-connecting-ip'] && req.socket.remoteAddress === '127.0.0.1' && !req.headers.origin) {
      let body = ''; for await (const c of req) { body += c; if (body.length > 1000) break; }
      const minutes = Math.max(0, Math.min(720, Math.round(Number(JSON.parse(body || '{}').minutes) || 0)));
      saveConfig({ stayAwakeUntil: minutes ? Date.now() + minutes * 60_000 : 0 });
      log(minutes ? `stay awake: ${minutes} min, from the menu bar` : 'stay awake: cancelled from the menu bar');
      await tick(); res.writeHead(204); return res.end();
    }
    if (url.pathname === '/kick' && req.method === 'POST' && !req.headers['cf-connecting-ip'] && req.socket.remoteAddress === '127.0.0.1') {
      tick(); res.writeHead(204); return res.end();
    }
    if (url.pathname === '/ping') { res.writeHead(204, { 'cache-control': 'no-store' }); return res.end(); }
    if (url.pathname === '/status.json') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(await statusJson())); }
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
// Viewer sockets, each behind the Access check in authorizeViewer: /render/ws, the Mac view of a live project
// (render.js); /desktop/ws, the parked remote desktop, only when it is turned on (`seer desktop on`).
let streamStarted = false;
const startStream = () => { if (!streamStarted) { streamStarted = true; initStream(msg => log(msg)); } };
if (loadConfig().desktop) startStream();
ensureStreamAuth().then(() => log('viewer sockets: Access token check ready')).catch(e => log(`viewer sockets: ${e.message}`));
const renderWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', async (req, socket, head) => {
  const pathname = req.url.split('?')[0];
  if (pathname === '/desktop/ws' && loadConfig().desktop) return streamUpgrade(req, socket, head, msg => log(msg));
  if (pathname !== '/render/ws') return socket.destroy();
  if (!(await authorizeViewer(req, socket, msg => log(msg), 'mac view'))) return;
  const q = new URL(req.url, 'http://x').searchParams, target = localTarget(q.get('host'), q.get('path'));
  renderWss.handleUpgrade(req, socket, head, async ws => {
    if (!target) { ws.send(JSON.stringify({ error: 'That project is not running on this Mac' })); return ws.close(); }
    let session;
    try { session = await openSession(ws, target, msg => log(msg)); }
    catch (e) { ws.send(JSON.stringify({ error: `Mac view: ${e.message}` })); return ws.close(); }
    ws.on('message', (data, binary) => {
      if (binary) return;
      let m; try { m = JSON.parse(String(data)); } catch { return; }
      const clean = cleanInput(m);
      if (clean) renderInput(session, clean).catch(() => {});
    });
    ws.on('close', () => closeSession(session, msg => log(msg)));
  });
});

// Hold the Mac awake while something needs it (activity.js: plugged in, an agent working, someone watching, or
// the reachable window after those) and let it sleep otherwise. caffeinate covers an open lid; away mode
// (awake.js) covers a closed one and fails over to the hotspot when the Wi-Fi goes.
let awake = null, running = false, windowSince = 0, why = { awake: false, why: 'starting' }, lidState = 'unknown', headless = false, netTick = 0, lastLid = 'unknown', lastDark = 0, ticking = false;
const log = msg => console.log(`${new Date().toISOString()} ${msg}`);
const checkNetwork = failover(log);
async function tick() {
  if (ticking) return; ticking = true;
  try { await tickOnce(); } finally { ticking = false; }
}
async function tickOnce() {
  const b = await battery().catch(() => ({ onBattery: false, pct: 100 }));
  const watching = viewerCount() > 0 || windowOpen();
  why = awakeReason({ pluggedIn: !b.onBattery, watching });
  running = why.awake;
  // Headless: lid closed, nobody streaming, no agent working. The Mac only waits, so it saves all it can.
  lidState = await lid().catch(() => 'unknown');
  headless = running && lidState === 'closed' && !watching && !why.agentsBusy;
  // Headless actions: screen off on closing; heavy apps frozen while it waits, thawed for an agent, a viewer or
  // an open lid. Also when the Mac is about to sleep (nothing needs it) nothing stays frozen across the sleep.
  const set = settings(), shut = lidState === 'closed' && !watching && set.screenOff;
  if (shut && lastLid !== 'closed') sleepDisplay();
  if (shut && Date.now() - lastDark > 60_000) { sleepDisplay(); lastDark = Date.now(); }
  if (headless && set.freeze) await freezeApps(log).catch(e => log(`freeze: ${e.message}`));
  else if (frozenCount()) await thawAll(log).catch(e => log(`thaw: ${e.message}`));
  if (headless && set.mute) await muteOutput().catch(() => {});
  else await unmuteOutput().catch(() => {});
  lastLid = lidState;
  if (running && !awake) {
    awake = spawn('/usr/bin/caffeinate', ['-is'], { stdio: 'ignore' });
    awake.on('exit', () => { awake = null; });
  } else if (!running && awake) { awake.kill(); awake = null; }
  const next = loadConfig().away ? await reconcile(running, { headless }).then(r => ({ ...r, why: running ? why.why : r.why })).catch(e => ({ mode: 'error', why: e.message }))
    : { mode: 'sleeps normally', why: 'away mode off (seer away on)' };
  if (next.mode !== away.mode || next.why !== away.why) log(`away mode: ${next.mode} (${next.why})`);
  away = next;
  sampleBattery(b, away.mode);
  // The Mac view's window closes a while (Settings: two minutes) after the last viewer of the stream has gone.
  if (windowOpen() && viewerCount() > 0) windowSince = Date.now();
  if (windowOpen() && viewerCount() === 0 && Date.now() - windowSince > set.macViewCloseMin * 60_000) closeWindow(log);
}
setInterval(tick, 15_000);
// The lid, every 3 s: closing it should turn the screen off and settle the Mac now, not at the next 15 s tick.
setInterval(async () => { if ((await lid().catch(() => lidState)) !== lidState) tick(); }, 3_000);
thawAll(log).catch(() => {});                                        // a crash or restart never leaves apps frozen
unmuteOutput().catch(() => {});                                      // or the sound off
// The network check (hotspot failover): every 5 s while the lid is closed and the Mac is in use; every 30 s when
// headless (it only waits) or the lid is open (someone is at it).
setInterval(() => {
  if (++netTick % ((lidState === 'closed' && !headless) ? 1 : 6)) return;
  checkNetwork(running && !!loadConfig().away).catch(e => log(`failover: ${e.message}`));
}, 5_000);
tick();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { awake?.kill(); await thawAll(log).catch(() => {}); await unmuteOutput().catch(() => {}); await release().catch(() => {}); process.exit(0); });
