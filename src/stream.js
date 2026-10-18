// Streamed mode, the daemon's half: relays SeerStream's H.264 frames to viewers over a WebSocket and their mouse
// and keyboard back. This is remote control of the whole Mac, so a viewer must carry a valid Cloudflare Access
// token for the home app (verified here against the team's signing keys, not just trusted as a header) and come
// from the home page's own origin. The daemon listens on 127.0.0.1, where any page in a local browser could
// otherwise open a WebSocket to it.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { HOME, loadConfig } from './store.js';

const SOCK = path.join(HOME, 'stream.sock');
const MAX_BUFFERED = 512 * 1024;               // bytes queued to a viewer before its delta frames are dropped
const DEV = process.env.SEER_STREAM_DEV === '1';   // local testing only: no Access token needed from 127.0.0.1

// ---------- Access token ----------
let keys = { at: 0, byKid: new Map() };
async function signingKey(team, kid) {
  if (!keys.byKid.has(kid) || Date.now() - keys.at > 3600_000) {
    const res = await fetch(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(8000) });
    const { keys: jwks = [] } = await res.json();
    keys = { at: Date.now(), byKid: new Map(jwks.map(k => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })])) };
  }
  return keys.byKid.get(kid);
}
const b64 = s => Buffer.from(s, 'base64url');
export async function verifyAccess(token, cfg) {
  if (!token || !cfg.teamDomain || !cfg.homeAud) return null;
  const [h, p, s] = token.split('.');
  if (!s) return null;
  const header = JSON.parse(b64(h)), claims = JSON.parse(b64(p));
  if (header.alg !== 'RS256') return null;
  const key = await signingKey(cfg.teamDomain, header.kid);
  if (!key || !crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, b64(s))) return null;
  const aud = [].concat(claims.aud || []);
  if (!aud.includes(cfg.homeAud) || claims.iss !== `https://${cfg.teamDomain}` || !(claims.exp * 1000 > Date.now())) return null;
  return claims.email || 'signed in';
}

// ---------- SeerStream connection ----------
const viewers = new Set();
export const viewerCount = () => viewers.size;
let helper = null, helperBuf = Buffer.alloc(0), lastConfig = null, lastKeyAt = 0;

function toHelper(obj) { if (helper && !helper.destroyed) helper.write(JSON.stringify(obj) + '\n'); }
function requestKey() { if (Date.now() - lastKeyAt > 500) { lastKeyAt = Date.now(); toHelper({ cmd: 'keyframe' }); } }

function connectHelper(log) {
  if (helper) return;
  const s = net.connect(SOCK);
  helper = s;
  s.on('connect', () => { log('stream helper connected'); if (viewers.size) startCapture(); });
  s.on('data', chunk => {
    helperBuf = Buffer.concat([helperBuf, chunk]);
    while (helperBuf.length >= 5) {
      const len = helperBuf.readUInt32BE(1);
      if (helperBuf.length < 5 + len) break;
      const type = helperBuf[0], frame = helperBuf.subarray(0, 5 + len);
      helperBuf = helperBuf.subarray(5 + len);
      const msg = Buffer.concat([frame.subarray(0, 1), frame.subarray(5)]);   // [type][payload] to the browser
      if (type === 1) lastConfig = msg;
      if (type === 4) { const text = frame.subarray(5).toString(); log(`stream: ${text}`); for (const v of viewers) v.send(text); continue; }
      for (const v of viewers) {
        if (type === 1) { v.send(msg); continue; }
        if (v.bufferedAmount > MAX_BUFFERED) { v.needKey = true; requestKey(); continue; }   // behind: skip to the next keyframe
        if (v.needKey && type !== 2) continue;
        v.needKey = false;
        v.send(msg);
      }
    }
  });
  const gone = () => { if (helper === s) { helper = null; helperBuf = Buffer.alloc(0); lastConfig = null; } setTimeout(() => connectHelper(log), 2000); };
  s.on('error', () => {});
  s.on('close', gone);
}

function startCapture() {
  const { stream = {} } = loadConfig();
  toHelper({ cmd: 'start', maxWidth: stream.maxWidth || 1512, fps: stream.fps || 30, bitrate: stream.bitrate || 3_000_000 });
}

// The Dock button: an auto-hidden Dock only shows while the pointer sits on its edge, which a tap through a
// stream cannot hold, so the button turns auto-hide off (the Dock stays) and on again. dock.json records that
// Seer changed it, so the setting goes back when the last viewer leaves, or when the daemon starts after a crash.
const DOCK_JOURNAL = path.join(HOME, 'dock.json');
const run = (file, args) => new Promise(resolve => execFile(file, args, (err, out) => resolve(err ? null : String(out).trim())));
const autohide = async () => (await run('/usr/bin/defaults', ['read', 'com.apple.dock', 'autohide'])) === '1';
async function setAutohide(on) {
  await run('/usr/bin/defaults', ['write', 'com.apple.dock', 'autohide', '-bool', on ? 'true' : 'false']);
  await run('/usr/bin/killall', ['Dock']);                                       // the Dock reads it on relaunch
}
const dockChanged = () => { try { return JSON.parse(fs.readFileSync(DOCK_JOURNAL, 'utf8')).shownBySeer; } catch { return false; } };
const markDock = shown => fs.writeFileSync(DOCK_JOURNAL, JSON.stringify({ shownBySeer: shown }) + '\n');

export async function toggleDock() {
  if (dockChanged()) { await setAutohide(true); markDock(false); }
  else if (await autohide()) { markDock(true); await setAutohide(false); }
  const shown = dockChanged() || !(await autohide());
  for (const v of viewers) v.send(JSON.stringify({ dock: shown }));
}
export async function restoreDock() {
  if (dockChanged()) { await setAutohide(true); markDock(false); }
}

// ---------- viewers ----------
const INPUT = new Set(['down', 'up', 'move', 'scroll', 'text', 'key']);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
export function cleanInput(m) {
  if (!INPUT.has(m.t)) return null;
  const out = { cmd: 'input', t: m.t };
  if ('x' in m) { out.x = Math.min(Math.max(num(m.x), 0), 1); out.y = Math.min(Math.max(num(m.y), 0), 1); }
  if (m.button === 'right') out.button = 'right';
  if (Array.isArray(m.mods)) out.mods = m.mods.filter(k => ['cmd', 'shift', 'alt', 'ctrl'].includes(k));
  if (m.t === 'scroll') { out.dx = Math.max(-2000, Math.min(2000, num(m.dx))); out.dy = Math.max(-2000, Math.min(2000, num(m.dy))); }
  if (m.t === 'text') out.text = String(m.text || '').slice(0, 500);
  if (m.t === 'key') out.key = String(m.key || '').slice(0, 20);
  return out;
}

// Who may open a viewer socket (desktop stream or Mac view): the home page's own origin, with a valid Access
// token. Returns the signed-in email, or null after answering 403.
export async function authorizeViewer(req, socket, log, what) {
  const deny = why => { log(`${what} refused: ${why}`); socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return null; };
  const cfg = loadConfig(), origin = req.headers.origin || '';
  if (DEV && req.socket.remoteAddress === '127.0.0.1' && !req.headers['cf-connecting-ip']) return 'local dev';
  if (origin !== `https://seer.${cfg.zone}`) return deny(`origin ${origin || 'none'}`);
  const who = await verifyAccess(req.headers['cf-access-jwt-assertion'], cfg).catch(() => null);
  return who || deny('no valid Access token');
}

// Scrolling: the viewer sends how far the finger moved (swipe up: dy < 0, the page should move up, as on iOS).
// SeerStream turns it into scroll-wheel events, which macOS reverses when "natural scrolling" is on (the
// default), so the sign follows that setting, read again every minute in case it is changed.
let natural = true;
function readNatural() {
  execFile('/usr/bin/defaults', ['read', '-g', 'com.apple.swipescrolldirection'], (err, out) => { natural = err ? true : String(out).trim() !== '0'; });
}
readNatural(); setInterval(readNatural, 60_000).unref();
const wheel = input => (input.t === 'scroll' && natural ? { ...input, dx: -input.dx, dy: -input.dy } : input);

export function initStream(log) {
  connectHelper(log);
  restoreDock();                                                                  // a crash left it shown
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
export async function streamUpgrade(req, socket, head, log) {
  {
    req.who = await authorizeViewer(req, socket, log, 'desktop');
    if (!req.who) return;
    wss.handleUpgrade(req, socket, head, ws => {
      log(`desktop viewer connected (${req.who}); ${viewers.size + 1} watching`);
      viewers.add(ws);
      // Wake the display (a sleeping screen streams black): a short user-activity assertion, like a key press.
      execFile('/usr/bin/caffeinate', ['-u', '-t', '10'], () => {});
      ws.needKey = true;
      if (!helper) ws.send(JSON.stringify({ error: 'Seer Stream is not running on the Mac' }));
      if (viewers.size === 1) startCapture(); else { if (lastConfig) ws.send(lastConfig); requestKey(); }
      ws.on('message', (data, binary) => {
        if (binary) return;
        let m; try { m = JSON.parse(String(data)); } catch { return; }
        if (m.t === 'keyframe') return requestKey();
        if (m.t === 'dock') return toggleDock();
        const input = cleanInput(m);
        if (input) toHelper(wheel(input));
      });
      ws.on('close', () => {
        viewers.delete(ws);
        log(`desktop viewer left; ${viewers.size} watching`);
        if (!viewers.size) { toHelper({ cmd: 'stop' }); lastConfig = null; restoreDock(); }
      });
    });
  }
}
