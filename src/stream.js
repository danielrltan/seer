// Streamed mode, the daemon's half: relays SeerStream's H.264 frames to viewers over a WebSocket and their mouse
// and keyboard back. This is remote control of the whole Mac, so a viewer must carry a valid Cloudflare Access
// token for the home app (verified here against the team's signing keys, not just trusted as a header) and come
// from the home page's own origin. The daemon listens on 127.0.0.1, where any page in a local browser could
// otherwise open a WebSocket to it.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
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

// An auto-hidden Dock shows when the pointer reaches its edge: move there in two steps, so the Dock sees the
// pointer arrive rather than appear. Its edge comes from the Dock's own setting (bottom, left or right).
function revealDock() {
  execFile('/usr/bin/defaults', ['read', 'com.apple.dock', 'orientation'], (err, out) => {
    const edge = err ? 'bottom' : String(out).trim();
    const [near, at] = edge === 'left' ? [{ x: 0.02, y: 0.5 }, { x: 0, y: 0.5 }]
      : edge === 'right' ? [{ x: 0.98, y: 0.5 }, { x: 1, y: 0.5 }]
      : [{ x: 0.5, y: 0.97 }, { x: 0.5, y: 1 }];
    toHelper({ cmd: 'input', t: 'move', ...near });
    setTimeout(() => toHelper({ cmd: 'input', t: 'move', ...at }), 60);
  });
}

// ---------- viewers ----------
const INPUT = new Set(['down', 'up', 'move', 'scroll', 'text', 'key']);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
function cleanInput(m) {
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

export function attachStream(server, log) {
  connectHelper(log);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', async (req, socket, head) => {
    const deny = why => { log(`desktop refused: ${why}`); socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); };
    if (!req.url.startsWith('/desktop/ws')) return deny('path');
    const cfg = loadConfig(), origin = req.headers.origin || '';
    const local = DEV && req.socket.remoteAddress === '127.0.0.1' && !req.headers['cf-connecting-ip'];
    if (!local) {
      if (origin !== `https://seer.${cfg.zone}`) return deny(`origin ${origin || 'none'}`);
      const who = await verifyAccess(req.headers['cf-access-jwt-assertion'], cfg).catch(() => null);
      if (!who) return deny('no valid Access token');
      req.who = who;
    } else req.who = 'local dev';
    wss.handleUpgrade(req, socket, head, ws => {
      log(`desktop viewer connected (${req.who}); ${viewers.size + 1} watching`);
      viewers.add(ws);
      ws.needKey = true;
      if (!helper) ws.send(JSON.stringify({ error: 'Seer Stream is not running on the Mac' }));
      if (viewers.size === 1) startCapture(); else { if (lastConfig) ws.send(lastConfig); requestKey(); }
      ws.on('message', (data, binary) => {
        if (binary) return;
        let m; try { m = JSON.parse(String(data)); } catch { return; }
        if (m.t === 'keyframe') return requestKey();
        if (m.t === 'dock') return revealDock();
        const input = cleanInput(m);
        if (input) toHelper(input);
      });
      ws.on('close', () => {
        viewers.delete(ws);
        log(`desktop viewer left; ${viewers.size} watching`);
        if (!viewers.size) { toHelper({ cmd: 'stop' }); lastConfig = null; }
      });
    });
  });
}
