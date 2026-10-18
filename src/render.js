// "Mac" view: a project rendered by the Mac, shown on the phone. A hidden (headless) Chrome on the Mac loads the
// project from its local dev server at 1440x900, on the Mac's own GPU, and streams its frames; the phone sends
// clicks, scrolls and typing back. Nothing appears on the Mac's screen, no Screen Recording or Accessibility
// permission is involved, and the page is exactly what a laptop shows, because it is a laptop's browser.
// Only the live previews Seer itself published can be opened (no arbitrary URLs), and Chrome quits two minutes
// after the last viewer leaves.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { HOME, loadPreviews } from './store.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333, W = 1440, H = 900, LINGER_MS = 120_000;
const PROFILE = path.join(HOME, 'chrome-render');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const MAX_BUFFERED = 256 * 1024;   // bytes waiting for the phone before Chrome is asked for the next frame

let chrome = null, quitTimer = null;
const sessions = new Set();

// The local address of a published live preview, by its public hostname. Anything else is refused.
export function localTarget(host, rawPath) {
  const p = Object.values(loadPreviews()).find(x => x.host === host && x.published);
  if (!p) return null;
  const pathPart = typeof rawPath === 'string' && rawPath.startsWith('/') && !rawPath.startsWith('//') ? rawPath : '/';
  return `http://${p.origin === '[::1]' ? '[::1]' : '127.0.0.1'}:${p.port}${pathPart}`;
}

async function ensureChrome(log) {
  clearTimeout(quitTimer);
  if (chrome && chrome.exitCode === null) return;
  if (!fs.existsSync(CHROME)) throw new Error('Google Chrome is not installed on this Mac');
  fs.mkdirSync(PROFILE, { recursive: true });
  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', `--window-size=${W},${H}`, '--enable-gpu', '--use-angle=metal',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    'about:blank',
  ], { stdio: 'ignore' });
  chrome.on('exit', () => log('mac view: Chrome exited'));
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); log('mac view: Chrome started'); return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Chrome did not start');
}

function quitSoon(log) {
  clearTimeout(quitTimer);
  quitTimer = setTimeout(() => { if (!sessions.size && chrome) { chrome.kill(); chrome = null; log('mac view: Chrome quit (nobody watching)'); } }, LINGER_MS);
}

// A small DevTools-protocol client for one page.
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  let id = 0;
  const pending = new Map(), handlers = new Map();
  ws.on('message', data => {
    const m = JSON.parse(data);
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
    else if (m.method) handlers.get(m.method)?.(m.params);
  });
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return {
    opened, ws,
    call: (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); }),
    on: (method, fn) => handlers.set(method, fn),
    close: () => ws.close(),
  };
}

const KEYS = {
  Enter: [13, '\r'], Tab: [9, '\t'], Backspace: [8, ''], Escape: [27, ''], Delete: [46, ''],
  ArrowLeft: [37, ''], ArrowUp: [38, ''], ArrowRight: [39, ''], ArrowDown: [40, ''], Home: [36, ''], End: [35, ''], PageUp: [33, ''], PageDown: [34, ''],
};
const MODS = { alt: 1, ctrl: 2, cmd: 4, shift: 8 };

// One phone viewing one project: its own Chrome tab, its frames, its input.
export async function openSession(viewer, url, log) {
  await ensureChrome(log);
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
  const page = cdp(target.webSocketDebuggerUrl);
  await page.opened;
  await page.call('Runtime.enable');                       // waits until the new tab is attached and live
  const session = { viewer, page, targetId: target.id, buttons: 0 };
  sessions.add(session);

  await page.call('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await page.call('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'MacIntel' });
  await page.call('Page.enable');
  // Chrome sends the next frame only after the last is acknowledged, and the acknowledgement waits until the
  // phone's connection has taken the frame: the frame rate follows the network instead of a queue building up.
  page.on('Page.screencastFrame', async ({ data, sessionId }) => {
    if (viewer.readyState !== 1) return;
    viewer.send(Buffer.concat([Buffer.from([5]), Buffer.from(data, 'base64')]));
    for (let i = 0; i < 100 && viewer.readyState === 1 && viewer.bufferedAmount > MAX_BUFFERED; i++) await new Promise(r => setTimeout(r, 20));
    page.call('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  // The screencast is refused while the tab is mid-navigation, so start it once the page has loaded (or after
  // 15 s, for a page that never finishes loading).
  const loaded = new Promise(resolve => { page.on('Page.loadEventFired', resolve); setTimeout(resolve, 15_000); });
  await page.call('Page.navigate', { url });
  await loaded;
  await page.call('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: W, maxHeight: H, everyNthFrame: 2 });
  log(`mac view: opened ${url}`);
  return session;
}

export async function input(session, m) {
  const { page } = session, x = Math.round((m.x ?? 0) * W), y = Math.round((m.y ?? 0) * H);
  const modifiers = (m.mods || []).reduce((n, k) => n | (MODS[k] || 0), 0);
  const button = m.button === 'right' ? 'right' : 'left';
  switch (m.t) {
    case 'move':
      return page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers, buttons: session.buttons, button: session.buttons ? 'left' : 'none' });
    case 'down':
      session.buttons = button === 'left' ? 1 : 2;
      return page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: session.buttons, clickCount: 1, modifiers });
    case 'up':
      session.buttons = 0;
      return page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1, modifiers });
    case 'scroll':
      return page.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: W / 2, y: H / 2, deltaX: -(m.dx || 0), deltaY: -(m.dy || 0) });
    case 'text':
      return page.call('Input.insertText', { text: String(m.text || '') });
    case 'key': {
      const [code, text] = KEYS[m.key] || [String(m.key || '').toUpperCase().charCodeAt(0) || 0, ''];
      const base = { key: m.key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers };
      await page.call('Input.dispatchKeyEvent', { type: text && !modifiers ? 'keyDown' : 'rawKeyDown', ...base, ...(text && !modifiers ? { text } : {}) });
      return page.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    }
  }
}

export async function closeSession(session, log) {
  sessions.delete(session);
  try { await session.page.call('Page.stopScreencast'); } catch {}
  session.page.close();
  try { await fetch(`http://127.0.0.1:${PORT}/json/close/${session.targetId}`); } catch {}
  quitSoon(log);
}
