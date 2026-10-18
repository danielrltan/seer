// `seer daemon` (run by Seer.app): serves Seer home on 127.0.0.1:7399, which the tunnel publishes behind sign-in
// at seer.<zone>, and keeps the Mac awake only while something needs it (power.js decides; the tick at the bottom
// carries it out: caffeinate -is, and with away mode sleep disabled so a closed lid stays up).
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { list } from './core.js';
import { tail } from './devserver.js';
import { cleanName, loadConfig, saveConfig } from './store.js';
import { HOME_PORT } from './services.js';
import { reconcile, release, failover, battery, ruleInstalled, savePassword, hasPassword, journal, claimJournal, sleepDisabled } from './awake.js';
import { awakeReason, seen } from './activity.js';
import { macStatus, clamshell, idleSeconds, sampleBattery, darkWake, device } from './macstatus.js';
import { decide, sleptBetween, onWake, HOLD_OFF_MS } from './power.js';
import { homePage } from './home.js';
import { asleepPage, serviceWorker } from './asleep.js';
import { settingsPage } from './settingspage.js';
import { settings, applySettings, FREEZABLE } from './settings.js';
import { hooksInstalled, installHooks } from './hooks.js';
import { runningAgents } from './agents.js';
import { ICON_V, ICON_HEAD, iconCache, FONT_V, MANIFEST } from './icons.js';
import { sleepDisplay, freezeApps, thawAll, frozenCount, muteOutput, unmuteOutput } from './headless.js';
import { initStream, streamUpgrade, authorizeViewer, cleanInput, verifyAccess, viewerCount, streamingNow } from './stream.js';
import { localTarget, openSession, input as renderInput, closeSession, openWindow, closeWindow, windowOpen } from './render.js';
import { WebSocketServer } from 'ws';
import { desktopPage } from './viewer.js';
import { ensureStreamAuth } from './core.js';

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

export const APP_HEAD = `${ICON_HEAD}
<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Seer"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`;

let ASLEEP = asleepPage(APP_HEAD), SW = serviceWorker(ASLEEP);
device().then(d => { ASLEEP = asleepPage(APP_HEAD, d.model || 'Mac'); SW = serviceWorker(ASLEEP); });   // "Your MacBook Pro is asleep"

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
// awake is the last tick's decision, whole: label, why and countdown come from the same rules that hold the Mac
// (power.js), so the page and the menu bar (label, why, stayUntil) cannot promise what the Mac will not do.
export async function statusJson() {
  const d = state || { running: false, headless: false, label: 'Starting', why: '', mode: 'starting', countdown: null, closingSleeps: false, notes: [] };
  const awake = {
    awake: d.running, label: d.label, why: d.why, inUse: !!why.inUse, mode: d.mode, headless: d.headless,
    countdown: d.countdown, stayUntil: why.stayUntil || 0, reachableUntil: why.reachableUntil || 0,
    external, closingSleeps: d.closingSleeps, pluggedIn: !lastBattery.onBattery, batteryNote: d.batteryNote || '',
  };
  if (await darkWake()) Object.assign(awake, { awake: false, label: 'Asleep', why: '', countdown: null, inUse: false, batteryNote: '' });
  const st = await macStatus({ awake, agentsBusy: why.agentsBusy || 0, lid: lidState, notes: d.notes });
  return { ...st, device: await device(), agents: runningAgents(), projects: await projects(), desktop: !!loadConfig().desktop };
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
    // Someone opened a Seer page or did something: they may come back soon (the reachable window), and a Mac that
    // slept is theirs again (power.js sleepHold). The 5 s polls of an open page count for an hour after it was
    // opened, so a forgotten tab cannot keep the Mac up all night, and only with the lid closed: with it open the
    // page may be the Mac's own tab, which would hold off its idle sleep for that hour with nobody there.
    // A Mac in a dark wake is asleep: a page opened then is no one coming back.
    // A visit ticks at once when nothing holds the Mac, so sleep is disabled before the lid can close on it.
    if (req.headers['cf-access-jwt-assertion'] && !(await darkWake())) {
      const poll = ['/status.json', '/ping', '/settings.json'].includes(url.pathname);
      if (!poll && url.pathname !== '/sleep') { seen(); visitAt = backAt = Date.now(); if (!state?.running) tick(); }
      else if (poll && Date.now() - visitAt < 3600_000 && lidState === 'closed' && !external) seen();
    }
    if (url.pathname === '/s/check-result' && req.method === 'POST') {          // what the phone reported, for Seer's log
      let body = ''; for await (const c of req) { body += c; if (body.length > 4000) break; }
      log('stream check from a browser:\n' + body.slice(0, 4000));
      res.writeHead(204); return res.end();
    }
    if (url.pathname === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' }); return res.end(SW); }
    if (url.pathname === '/asleep') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(ASLEEP); }
    if (url.pathname === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' });
      return res.end(MANIFEST);
    }
    // Icons, favicon and manifest are the only paths open without sign-in (a Cloudflare Access bypass, `seer
    // public assets`): iOS fetches a home-screen icon without the login, so behind it the icon never loaded.
    if (url.pathname === '/favicon.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': iconCache(url) }); return res.end(fs.readFileSync(new URL('../assets/logo/seer-favicon.svg', import.meta.url))); }
    if (url.pathname === '/font/jakarta.woff2') {
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': url.searchParams.get('v') === FONT_V ? 'public, max-age=31536000, immutable' : 'public, max-age=300' });
      return res.end(fs.readFileSync(new URL('../assets/fonts/jakarta.woff2', import.meta.url)));
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': iconCache(url) }); return res.end(fs.readFileSync(new URL('../assets/icon-32.png', import.meta.url))); }
    const icon = url.pathname.match(/^\/icon-(32|180|192|512)\.png$/);
    if (icon) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': iconCache(url) });
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
    if (url.pathname === '/desktop' && loadConfig().desktop) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(desktopPage({ title: (await device()).name })); }
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
          if (typeof hotspotPassword !== 'string' || hotspotPassword.length < 8 || hotspotPassword.length > 63) throw new Error('8 to 63 characters');
          await savePassword(ssid, hotspotPassword);
        }
        log(`settings: ${[...Object.entries(patch).map(([k, v]) => `${k}=${JSON.stringify(v)}`), ...(hotspotPassword !== undefined ? ['hotspot password saved'] : [])].join(', ')}`);
        if (patch.desktop) startStream();
        tick();                                        // away off: this tick allows sleep again (Seer holds a lid only with it on)
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
    // Sleep now: from the phone (sign-in and Seer's origin, like stay awake) or Seer.app's menu (this Mac only).
    const sleepPhone = url.pathname === '/sleep' && req.method === 'POST';
    const sleepMenu = url.pathname === '/local/sleep' && req.method === 'POST' && !req.headers['cf-connecting-ip'] && req.socket.remoteAddress === '127.0.0.1' && !req.headers.origin;
    if (sleepPhone || sleepMenu) {
      const cfg = loadConfig();
      if (sleepPhone && (req.headers.origin !== `https://seer.${cfg.zone}` || !(await verifyAccess(req.headers['cf-access-jwt-assertion'], cfg).catch(() => null)))) {
        res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"error":"sign in first"}');
      }
      res.writeHead(204); res.end();                         // answer first: the Mac is about to go
      return sleepNow(sleepPhone ? 'from the phone' : 'from the menu bar');
    }
    if (url.pathname === '/kick' && req.method === 'POST' && !req.headers['cf-connecting-ip'] && req.socket.remoteAddress === '127.0.0.1') {
      backAt = Date.now();                             // an agent hook: something is working again after a sleep
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

// Hold the Mac awake while something needs it and let it sleep otherwise. power.js decides from what is read here;
// this part only carries it out, one tick at a time (every 15 s, and at once for a hook, the lid, a viewer, a wake
// from sleep, the end of a countdown, or a change from the page or the menu).
let holdOff = 0;                                       // after Sleep now: hold nothing for a minute, whatever comes in
let caf = null, why = { awake: false, why: 'starting' }, state = null, lidState = 'unknown', external = false;
let lastBattery = { onBattery: false, pct: 100 }, lastWatching = false, lastClosed = false, lastDark = 0, lastLine = '', lastUntil = 0, lastUnread = false;
let windowSince = 0, netTick = 0, failures = 0, pmsetFailedAt = 0, visitAt = 0, backAt = 0, deadline = null, started = false, stopping = false;
const log = msg => console.log(`${new Date().toISOString()} ${msg}`);
const checkNetwork = failover(log);
const watchingNow = () => streamingNow() || windowOpen();

// caffeinate -w: it lets go by itself the moment this daemon dies, however it dies.
function startCaffeinate() {
  if (caf) return;
  const c = spawn('/usr/bin/caffeinate', ['-is', '-w', String(process.pid)], { stdio: 'ignore' });
  c.on('exit', () => { if (caf === c) caf = null; });
  c.on('error', e => log(`caffeinate: ${e.message}`));
  caf = c;
}
function stopCaffeinate() { caf?.kill(); caf = null; }

// Everything Seer did, put back: apps thawed, sound on, then Low Power Mode and sleep allowed (last, since on a
// closed lid the Mac sleeps the moment it runs).
async function letGo() {
  await thawAll(log).catch(e => log(`thaw: ${e.message}`));
  await unmuteOutput().catch(() => {});
  stopCaffeinate();
  await release().catch(e => log(`release: ${e.message}`));
}

// Sleep now: skip the reachable window and any stay-awake timer, put everything Seer did back, then sleep the Mac
// as the Apple menu's Sleep does. The tick runs after any tick in flight, so nothing it does lands after this.
async function sleepNow(source) {
  log(`sleep now, asked ${source}`);
  holdOff = Date.now() + HOLD_OFF_MS; visitAt = 0;         // an open page's polls no longer count
  saveConfig({ stayAwakeUntil: 0, sleptAt: Date.now(), sleepHold: { at: Date.now(), lid: lidState } });
  await tick();
  await letGo();
  setTimeout(() => execFile('/usr/bin/pmset', ['sleepnow'], async err => {
    if (err) return log(`sleep now: pmset ${err.message}`);
    if (await sleepDisabled().catch(() => false)) log('sleep now: sleep is disabled outside Seer (pmset -g shows SleepDisabled 1), so the Mac cannot sleep');
  }), 1500);
}

// One tick at a time. A kick during a tick is not dropped: it runs once more right after.
let ticking = null, again = false;
function tick() {
  if (!started || stopping) return Promise.resolve();
  if (ticking) { again = true; return ticking; }
  ticking = (async () => {
    try { do { again = false; await safeTick(); } while (again && !stopping); } finally { ticking = null; }
  })();
  return ticking;
}
async function safeTick() {
  try { await tickOnce(); failures = 0; }
  catch (e) {
    log(`tick failed: ${e.stack || e.message}`);
    // A broken tick must not keep the Mac held on its last decision: after three in a row, let go.
    if (++failures === 3) {
      log('three ticks failed: letting the Mac sleep');
      state = { running: false, headless: false, label: 'Idling', why: 'Seer error', mode: 'sleep allowed', countdown: null, closingSleeps: false, notes: [] };
      await letGo();
    }
  }
}

let startup = null;
async function tickOnce() {
  await startup;
  const cfg = loadConfig(), set = settings(cfg);
  const [b, cs, idle, rule] = await Promise.all([
    battery().catch(() => ({ onBattery: false, pct: 100 })), clamshell().catch(() => null),
    idleSeconds().catch(() => null), ruleInstalled().catch(() => false),
  ]);
  if (stopping) return;
  // A failed ioreg read keeps the last lid: 'unknown' counts as open and would end a closed Mac's window early.
  if (cs && (cs.lid !== 'unknown' || lidState === 'unknown')) { lidState = cs.lid; external = cs.external; }
  lastBattery = b;
  const inUse = idle !== null && idle < 120;            // a key, click or trackpad touch in the last 2 minutes
  const watching = watchingNow();
  why = awakeReason({ watching, inUse });
  const now = Date.now();
  const d = decide({
    now, lid: lidState, external, inUse, watching, why, set, away: !!cfg.away, rule, battery: b,
    pmsetOk: now - pmsetFailedAt > 5 * 60_000,          // retried every 5 min, not every tick
    holdOff, sleepHold: cfg.sleepHold || null, backAt, lowPowerByUs: !!journal().lowPowerByUs,
  });
  if (JSON.stringify(d.sleepHold) !== JSON.stringify(cfg.sleepHold || null)) saveConfig({ sleepHold: d.sleepHold });
  state = d; lastWatching = watching;

  // Taking hold: caffeinate first, sleep disabled in reconcile. Letting go: thaw, sound, then caffeinate off and
  // sleep allowed last.
  if (d.caffeinate) startCaffeinate();
  // Screen off on closing, then again every minute (sleep disabled, a closed lid no longer turns the panel off).
  // watching is read again here: a viewer that connected during this tick has just woken the display (stream.js).
  if (d.screenOff && !watchingNow() && (!lastClosed || Date.now() - lastDark > 60_000)) { sleepDisplay(); lastDark = Date.now(); }
  lastClosed = d.closed;
  if (d.freeze && !watchingNow()) await freezeApps(log).catch(e => log(`freeze: ${e.message}`));
  else if (frozenCount()) await thawAll(log).catch(e => log(`thaw: ${e.message}`));
  if (d.mute) await muteOutput().catch(() => {});
  else await unmuteOutput().catch(() => {});
  if (!d.caffeinate) stopCaffeinate();
  if (rule) {                                            // away off or nothing holding: this is also what allows sleep again
    const r = await reconcile({ disableSleep: d.disableSleep, lowPower: d.lowPower }).catch(e => ({ error: e.message }));
    if (r.error && d.disableSleep) { pmsetFailedAt = Date.now(); log(`pmset could not disable sleep: ${r.error}`); tick(); }
    else if (r.error) log(`pmset could not allow sleep again: ${r.error}`);
    else if (r.unread && !lastUnread) log('pmset -g could not be read: sleep left as it is');
    lastUnread = !!r.unread;
  }

  // Logged on a change, with when the window lets go (so a lid test can be read against the log). A window that a
  // polling page keeps moving is logged again only when its end moved 5 minutes or more.
  const line = `${d.label}${d.why ? ` (${d.why})` : ''}${d.disableSleep ? ', lid can close' : ''}`;
  if (line !== lastLine || Math.abs(d.windowUntil - lastUntil) >= 5 * 60_000) {
    const until = d.windowUntil ? ` until ${new Date(d.windowUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
    log(`power: ${line}${until}`);
    lastUntil = d.windowUntil;
  }
  lastLine = line;
  sampleBattery(b, d.mode);
  // The countdown's end is a tick of its own, so the Mac lets go when the page reaches 0:00 (or, lid open, when
  // the window ends).
  clearTimeout(deadline);
  const end = d.countdown?.until || d.windowUntil;
  if (end) deadline = setTimeout(tick, Math.max(1000, end - Date.now() + 500));
  // The Mac view's window closes a while (Settings: two minutes) after the last viewer of the stream has gone.
  if (windowOpen() && viewerCount() > 0) windowSince = Date.now();
  if (windowOpen() && viewerCount() === 0 && Date.now() - windowSince > set.macViewCloseMin * 60_000) closeWindow(log);
}
setInterval(tick, 15_000);

// Every 3 s: a wake from sleep, the lid, or a viewer coming or going settles the Mac now, not at the next tick.
// libuv's timers stop in sleep while the wall clock runs on, so a wake shows as the two clocks drifting apart.
let beatWall = Date.now(), beatMono = performance.now();
setInterval(async () => {
  const wall = Date.now(), mono = performance.now();
  const slept = sleptBetween({ wallBefore: beatWall, wallNow: wall, monoBefore: beatMono, monoNow: mono });
  beatWall = wall; beatMono = mono;
  if (slept) {
    const cfg = loadConfig();
    saveConfig(onWake({ sleptAt: slept, lid: lidState, prevSleptAt: cfg.sleptAt || 0, prevHold: cfg.sleepHold || null }));
    lastClosed = false; visitAt = 0;                     // screen off again if the lid is closed; stale tabs' polls end
    log(`woke after ${Math.round((wall - slept) / 60_000)} min asleep`);
    return tick();
  }
  const cs = await clamshell().catch(() => null);
  if ((cs && (cs.lid !== lidState || cs.external !== external)) || watchingNow() !== lastWatching) tick();
}, 3_000);

// The network check (hotspot failover, only with the lid closed and the Mac held): every 5 s while something is
// working, every 30 s when headless (it only waits).
setInterval(() => {
  if (++netTick % (state?.failover && !state.headless ? 1 : 6)) return;
  checkNetwork(!!state?.failover && !!loadConfig().away).catch(e => log(`failover: ${e.message}`));
}, 5_000);

// Nothing power-related starts until this daemon has the port: a second daemon (port taken) exits without
// touching what the first one holds. Then: a crash or restart never leaves apps frozen or the sound off, this
// daemon takes over the journal, and the watchdog starts. If this daemon dies with sleep disabled, apps frozen or
// the sound off and no new daemon takes over within 45 s (Seer.app restarts it within 30), the watchdog puts them
// back. caffeinate -w covers caffeinate itself.
server.once('listening', () => {
  started = true;
  startup = Promise.all([thawAll(log).catch(() => {}), unmuteOutput().catch(() => {})]);
  claimJournal();
  try {
    spawn(process.execPath, [fileURLToPath(new URL('./watchdog.js', import.meta.url)), String(process.pid)], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) { log(`watchdog: ${e.message}`); }
  tick();
});

// Stopping (Seer.app quits, a deploy restarts it, or a crash): apps thawed and the sound on at once. If the Mac
// is held, a 45 s caffeinate and the watchdog bridge a restart, so a deploy does not sleep a closed Mac mid-work;
// with no new daemon, the watchdog allows sleep again. All within Seer.app's 5 s before it kills the daemon.
async function shutdown(reason, code) {
  if (stopping) return; stopping = true;
  log(`stopping: ${reason}`);
  if (!started) process.exit(code);
  setTimeout(() => process.exit(code), 4000).unref();
  await Promise.race([ticking, new Promise(r => setTimeout(r, 1500))]).catch(() => {});
  await thawAll(log).catch(() => {});
  await unmuteOutput().catch(() => {});
  if (state?.running) spawn('/usr/bin/caffeinate', ['-is', '-t', '45'], { detached: true, stdio: 'ignore' }).unref();
  else if (state) await release().catch(() => {});      // never decided: what the journal holds is the watchdog's
  stopCaffeinate();
  process.exit(code);
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(sig, 0));
process.on('uncaughtException', e => shutdown(`crashed: ${e.stack || e.message}`, 1));
process.on('unhandledRejection', e => shutdown(`crashed: ${e?.stack || e}`, 1));
