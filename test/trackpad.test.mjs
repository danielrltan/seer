// Trackpad gesture recognizer (src/trackpad.js) in headless Chrome: real touch events through the DevTools
// protocol, every gesture, and the exact messages that would go to the Mac.
//   node test/trackpad.test.mjs
// SEER_TEST_CHROME_PORT (default 9562), SEER_TEST_CHROME_DIR (default a fresh temp dir), SEER_TEST_CHROME (binary).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { TRACKPAD_JS } from '../src/trackpad.js';

let PORT = +process.env.SEER_TEST_CHROME_PORT || 9562;
const ownDir = !process.env.SEER_TEST_CHROME_DIR;
const DIR = process.env.SEER_TEST_CHROME_DIR || mkdtempSync(join(tmpdir(), 'seer-pad-'));
const BIN = process.env.SEER_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PAD = { left: 20, top: 120 };    // the pad is offset, so the pinch centre must come back pad-local

if (TRACKPAD_JS.includes('</script')) { console.error('TRACKPAD_JS contains </script'); process.exit(1); }
// The default port taken by something else: let Chrome pick one (it writes it to DevToolsActivePort).
let pick = false;
try { await fetch(`http://127.0.0.1:${PORT}/json`); if (process.env.SEER_TEST_CHROME_PORT) { console.error(`port ${PORT} is already in use`); process.exit(1); } pick = true; } catch {}

const chrome = spawn(BIN, ['--headless=new', `--remote-debugging-port=${pick ? 0 : PORT}`, `--user-data-dir=${DIR}`, '--no-first-run',
  '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} if (ownDir) try { rmSync(DIR, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

// ---------- DevTools protocol ----------
let page;
for (let i = 0; i < 100 && !page; i++) {
  if (pick) try { PORT = +readFileSync(join(DIR, 'DevToolsActivePort'), 'utf8').split('\n')[0] || PORT; } catch {}
  try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page'); } catch {}
  if (!page) await sleep(150);
}
if (!page) { console.error('headless Chrome did not answer'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let seq = 0; const waiting = new Map();
ws.on('message', m => { const d = JSON.parse(m); const w = waiting.get(d.id); if (w) { waiting.delete(d.id); d.error ? w[1](new Error(d.error.message)) : w[0](d.result); } });
const cdp = (method, params = {}) => new Promise((r, j) => { const id = ++seq; waiting.set(id, [r, j]); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expr => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
const html = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<body style="margin:0;background:#000"><div id=pad style="position:fixed;left:${PAD.left}px;top:${PAD.top}px;width:350px;height:640px;background:#222"></div>
<script>${TRACKPAD_JS}
window.__frame = 0; (function f() { __frame++; requestAnimationFrame(f); })();
window.__errors = []; addEventListener('error', e => __errors.push(String(e.message)));
window.__mount = () => {
  if (window.__tp) __tp.destroy();
  window.__msgs = [];
  const log = m => __msgs.push(Object.assign(JSON.parse(JSON.stringify(m)), { _f: __frame, _t: performance.now() }));
  window.__tp = mountTrackpad(pad, { send: log, onZoom: (f, x, y) => log({ t: 'zoom', f, x, y }), onZoomEnd: () => log({ t: 'zoomEnd' }) });
};
</script>`;
await cdp('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') });
for (let i = 0; i < 50 && !(await evaluate('typeof window.__mount')).startsWith('function'); i++) await sleep(100);

// ---------- fingers ----------
// Touch events carry a synthetic clock (epoch ms) so gestures run at a true 60/120 Hz: headless Chrome takes
// ~30 ms to deliver each event, but the recognizer times gestures by event timeStamp, as it would on the phone.
let clock = Date.now();
const wait = async ms => { clock += ms; await sleep(ms); };   // the user waits: both clocks move
const fingers = new Map();               // id -> [x, y], in viewport px
const points = () => [...fingers].map(([id, [x, y]]) => ({ x, y, id }));
const touch = (type, touchPoints) => cdp('Input.dispatchTouchEvent', { type, touchPoints, timestamp: clock / 1000 });
async function down(...fs) { for (const [id, x, y] of fs) fingers.set(id, [x, y]); await touch('touchStart', points()); }
async function up(...ids) {              // no ids: every finger. Lifts land a few ms after the last move.
  clock += 6;
  if (!ids.length || ids.length === fingers.size) { fingers.clear(); return touch('touchEnd', []); }
  const pts = ids.map(id => ({ x: fingers.get(id)[0], y: fingers.get(id)[1], id }));
  ids.forEach(id => fingers.delete(id));
  return touch('touchEnd', pts);
}
async function cancel() { fingers.clear(); await touch('touchCancel', []); }
// Move fingers (default: all) by dx, dy over ms at hz; spread moves them apart (or together) for pinches.
async function slide(dx, dy, ms, { ids, spread = 0, hz = 60 } = {}) {
  const which = ids || [...fingers.keys()], step = 1000 / hz, steps = Math.max(1, Math.round(ms / step));
  const start = new Map(which.map(id => [id, [...fingers.get(id)]]));
  const cx = which.reduce((s, id) => s + start.get(id)[0], 0) / which.length;
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    for (const id of which) {
      const [x0, y0] = start.get(id), out = Math.sign(x0 - cx) * spread * k;
      fingers.set(id, [x0 + dx * k + out, y0 + dy * k]);
    }
    clock += step;
    await touch('touchMove', points());
  }
}
async function tap(x = 200, y = 400, hold = 50, id = 1) { await down([id, x, y]); await wait(hold); await up(); }
const mount = () => { clock = Math.max(clock, Date.now() - 50); return evaluate('__mount()'); };
const msgs = async (wait = 400) => { await sleep(wait); return evaluate('__msgs'); };
const strip = ms => ms.map(({ _f, _t, ...m }) => m);
const kinds = ms => ms.map(m => m.t + (m.phase ? ':' + m.phase : '') + (m.button ? ':' + m.button : '') + (m.count ? ':' + m.count : '') + (m.key ? ':' + m.key : ''));
const sum = (ms, k, t = 'nudge') => ms.filter(m => m.t === t).reduce((s, m) => s + (m[k] || 0), 0);
const only = (ms, t) => ms.filter(m => m.t === t);

// ---------- checks ----------
const all = [];                          // every message from every case, for the well-formed check
function wellFormed(ms) {
  const fin = v => typeof v === 'number' && Number.isFinite(v);
  let scrolling = false, held = false;
  for (const { _f, _t, ...m } of ms) {
    const keys = Object.keys(m).sort().join(), bad = why => { throw new Error(why + ': ' + JSON.stringify(m)); };
    if (m.t === 'nudge') { if (keys !== 'dx,dy,t' || !fin(m.dx) || !fin(m.dy) || (!m.dx && !m.dy)) bad('bad nudge'); }
    else if (m.t === 'press' || m.t === 'release') {
      if (keys !== 'button,t' || !['left', 'right'].includes(m.button)) bad('bad ' + m.t);
      if ((m.t === 'press') === held) bad(m.t + ' out of order'); held = m.t === 'press';
    } else if (m.t === 'click') { if (keys !== 'button,count,t' || !['left', 'right'].includes(m.button) || ![1, 2, 3].includes(m.count)) bad('bad click'); }
    else if (m.t === 'scroll') {
      if (keys !== 'dx,dy,phase,t,vx,vy' || ![m.dx, m.dy, m.vx, m.vy].every(fin)) bad('bad scroll');
      if (m.phase === 'begin') { if (scrolling) bad('begin while scrolling'); scrolling = true; }
      else if (m.phase === 'move' || m.phase === 'end') { if (!scrolling) bad(m.phase + ' without begin'); if (m.phase === 'end') scrolling = false; }
      else bad('bad phase');
    } else if (m.t === 'key') {
      if (keys !== 'key,mods,t' || typeof m.key !== 'string' || !Array.isArray(m.mods) || !m.mods.every(x => ['cmd', 'shift', 'alt', 'ctrl'].includes(x))) bad('bad key');
    } else if (m.t === 'zoom') { if (!fin(m.f) || m.f <= 0 || !fin(m.x) || !fin(m.y)) bad('bad zoom'); }
    else if (m.t !== 'zoomEnd') bad('unknown message');
  }
  if (scrolling) throw new Error('scroll never ended');
  if (held) throw new Error('button left held');
}
function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(c, what) { if (!c) throw new Error(what); }
const near = (a, b, tol, what) => ok(Math.abs(a - b) <= tol, `${what}: ${a.toFixed(3)} not within ${tol} of ${b}`);

const results = [];
async function test(name, fn) {
  await mount(); fingers.clear();
  let got = [];
  try {
    got = await fn();
    if (!got) got = await msgs();
    wellFormed(got); all.push(...got);
    results.push([name, true]); console.log('  ok  ' + name);
  } catch (e) {
    if (!got.length) try { got = await evaluate('__msgs'); } catch {}
    results.push([name, false]); console.log('  FAIL ' + name + '\n       ' + e.message + '\n       got ' + JSON.stringify(kinds(got)));
    try { await up(); } catch {}
    fingers.clear(); await sleep(300);
  }
}

// ---------- one finger ----------
await test('tap -> left click', async () => { await tap(); const m = await msgs(); eq(strip(m), [{ t: 'click', button: 'left', count: 1 }], 'messages'); return m; });

await test('double tap -> click 1 then click 2', async () => {
  await tap(); await wait(120); await tap(204, 403);
  const m = await msgs(); eq(kinds(m), ['click:left:1', 'click:left:2'], 'messages'); return m;
});

await test('triple tap -> 1, 2, 3; a fourth starts over', async () => {
  for (let i = 0; i < 4; i++) { await tap(200 + i * 2, 400); await wait(120); }
  const m = await msgs(); eq(kinds(m), ['click:left:1', 'click:left:2', 'click:left:3', 'click:left:1'], 'messages'); return m;
});

await test('quick taps far apart are separate single clicks', async () => {
  await tap(100, 300); await wait(120); await tap(250, 450);
  const m = await msgs(); eq(kinds(m), ['click:left:1', 'click:left:1'], 'messages'); return m;
});

await test('slow taps are separate single clicks', async () => {
  await tap(); await wait(500); await tap();
  const m = await msgs(); eq(kinds(m), ['click:left:1', 'click:left:1'], 'messages'); return m;
});

await test('a finger held still is not a click', async () => {
  await tap(200, 400, 450); const m = await msgs(); eq(m.length, 0, 'message count'); return m;
});

await test('one finger move -> nudges only, one per frame, right direction', async () => {
  await down([1, 100, 400]); await slide(120, 0, 300); await up();
  const m = await msgs(), n = only(m, 'nudge');
  eq(m.length, n.length, 'only nudges');
  ok(n.length >= 5, 'several nudges: ' + n.length);
  ok(sum(m, 'dx') > 120 * 1.25, 'moved right ' + sum(m, 'dx'));
  near(sum(m, 'dy'), 0, 0.5, 'no vertical drift');
  const frames = n.slice(0, -1).map(x => x._f);
  eq(new Set(frames).size, frames.length, 'one nudge per frame');
  return m;
});

await test('a burst of moves inside one frame coalesces into one nudge', async () => {
  await evaluate(`(() => {
    const T = (x, y) => new Touch({ identifier: 7, target: pad, clientX: x, clientY: y });
    const fire = (type, list, changed) => pad.dispatchEvent(new TouchEvent(type, { touches: list, changedTouches: changed, targetTouches: list, cancelable: true, bubbles: true }));
    fire('touchstart', [T(100, 400)], [T(100, 400)]);
    for (let i = 1; i <= 6; i++) fire('touchmove', [T(100 + i * 10, 400)], [T(100 + i * 10, 400)]);
  })()`);
  await sleep(150);
  await evaluate(`pad.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [new Touch({ identifier: 7, target: pad, clientX: 160, clientY: 400 })], cancelable: true, bubbles: true }))`);
  const m = await msgs(); eq(kinds(m), ['nudge'], 'messages'); ok(m[0].dx > 60, 'carries the whole burst: ' + m[0].dx); return m;
});

await test('pointer acceleration: fast moves go much further than slow ones', async () => {
  await down([1, 100, 300]); await slide(40, 0, 800); await up(); await wait(450);
  const slow = sum(await evaluate('__msgs'), 'dx');
  await evaluate('__msgs.length = 0');
  await down([1, 100, 500]); await slide(40, 0, 48); await up();
  const m = await msgs(), fast = sum(m, 'dx');
  console.log(`       40 px slow -> ${slow.toFixed(1)} pt, 40 px fast -> ${fast.toFixed(1)} pt`);
  ok(slow >= 40 * 1.2 && slow <= 40 * 1.7, 'slow gain near 1.25: ' + slow);
  ok(fast > 2 * slow, 'fast gain well above slow');
  return [];
});

await test('no dead zone: a tiny slow adjustment after a hold moves the cursor, no click', async () => {
  await down([1, 200, 400]); await wait(350); await slide(3, 0, 100); await up();
  const m = await msgs(); ok(m.length && m.every(x => x.t === 'nudge'), 'nudges only'); near(sum(m, 'dx'), 3 * 1.25, 1, 'about 3 px of cursor'); return m;
});

await test('a move then a quick tap is a single click (moving breaks a double click)', async () => {
  await tap(); await wait(400); await down([1, 200, 400]); await slide(60, 0, 150); await up(); await wait(80); await tap(260, 400);
  const m = await msgs(); eq(kinds(m).filter(k => k !== 'nudge'), ['click:left:1', 'click:left:1'], 'clicks'); return m;
});

// ---------- tap to drag ----------
await test('tap-to-drag -> click, press, nudges, release', async () => {
  await tap(); await wait(120); await down([1, 205, 402]); await slide(80, 40, 250); await up();
  const m = await msgs(), k = kinds(m);
  eq(k[0], 'click:left:1', 'tap'); eq(k[1], 'press:left', 'press'); eq(k[k.length - 1], 'release:left', 'release last');
  ok(k.slice(2, -1).length >= 3 && k.slice(2, -1).every(x => x === 'nudge'), 'nudges while dragging');
  ok(sum(m, 'dx') > 80 && sum(m, 'dy') > 40, 'dragged down-right');
  return m;
});

await test('tap-to-drag release waits for the grace, not past it', async () => {
  await tap(); await wait(120); await down([1, 200, 400]); await slide(60, 0, 150); await up();
  const early = kinds(await msgs(60)), late = kinds(await msgs(400));
  ok(!early.includes('release:left'), 'held during the grace'); ok(late.includes('release:left'), 'released after it');
  return evaluate('__msgs');
});

await test('lift and touch again within the grace carries the drag on', async () => {
  await tap(); await wait(120); await down([1, 200, 400]); await slide(60, 0, 150); await up();
  await wait(100); await down([1, 150, 400]); await slide(60, 0, 150); await up();
  const m = await msgs(), k = kinds(m);
  eq(k.filter(x => x.startsWith('press')).length, 1, 'one press'); eq(k.filter(x => x.startsWith('release')).length, 1, 'one release');
  eq(k[k.length - 1], 'release:left', 'release last'); ok(sum(m, 'dx') > 120 * 1.25, 'both strokes moved the drag');
  return m;
});

await test('a tap during the grace drops the drag without a click', async () => {
  await tap(); await wait(120); await down([1, 200, 400]); await slide(60, 0, 150); await up(); await wait(60); await tap(150, 400);
  const m = await msgs(), k = kinds(m);
  eq(k.filter(x => x.startsWith('click')), ['click:left:1'], 'only the first tap clicks'); eq(k[k.length - 1], 'release:left', 'released');
  return m;
});

// ---------- two fingers ----------
const two = (x = 150, y = 500, gap = 70) => down([1, x, y], [2, x + gap, y]);

await test('two-finger tap -> right click', async () => {
  await two(); await wait(60); await up(); const m = await msgs(); eq(strip(m), [{ t: 'click', button: 'right', count: 1 }], 'messages'); return m;
});

await test('two-finger flick -> begin, moves, end with release velocity; no cursor', async () => {
  await two(); await slide(0, -150, 128); await up();
  const m = await msgs(), k = kinds(m), end = m[m.length - 1];
  eq(k[0], 'scroll:begin', 'begin first'); eq(k[k.length - 1], 'scroll:end', 'end last');
  ok(k.slice(1, -1).length >= 3 && k.slice(1, -1).every(x => x === 'scroll:move'), 'moves between');
  near(sum(m, 'dy', 'scroll'), 150 * 1.25, 4, 'tracks the fingers 1:1.25, against them');
  near(sum(m, 'dx', 'scroll'), 0, 0.5, 'no sideways');
  console.log(`       flick end v = (${end.vx}, ${end.vy}) pt/ms`);
  near(end.vy, 150 / 128 * 1.25, 0.3, 'release velocity ~ finger speed'); near(end.vx, 0, 0.1, 'no sideways velocity');
  return m;
});

await test('120 Hz flick -> the same scroll and velocity', async () => {
  await two(); await slide(0, -150, 128, { hz: 120 }); await up();
  const m = await msgs(), end = m[m.length - 1];
  near(sum(m, 'dy', 'scroll'), 150 * 1.25, 4, 'travel'); console.log(`       120 Hz flick end v = (${end.vx}, ${end.vy}) pt/ms`);
  ok(end.vy > 1, 'flick velocity'); return m;
});

await test('scroll, pause, lift -> end with zero velocity', async () => {
  await two(); await slide(0, -120, 100); await wait(150); await up();
  const m = await msgs(), end = m[m.length - 1]; eq(end.phase, 'end', 'ends'); eq([end.vx, end.vy], [0, 0], 'no glide'); return m;
});

await test('scroll is not accelerated: slow and fast travel the same', async () => {
  await two(150, 300); await slide(0, 100, 600); await up(); await wait(450);
  const slow = sum(await evaluate('__msgs'), 'dy', 'scroll'); await evaluate('__msgs.length = 0');
  await two(150, 300); await slide(0, 100, 64); await up();
  const m = await msgs(), fast = sum(m, 'dy', 'scroll');
  near(slow, -125, 3, 'slow'); near(fast, -125, 3, 'fast'); return [];
});

await test('staggered landing (second finger 25 ms late, first drifting) still scrolls, no cursor', async () => {
  await down([1, 150, 500]); await wait(10); fingers.set(1, [151, 498]); await touch('touchMove', points()); await wait(15);
  await down([2, 220, 500]); await slide(0, -100, 100); await up();
  const m = await msgs(), k = kinds(m); ok(!k.includes('nudge'), 'no nudge'); eq(k[0], 'scroll:begin', 'scrolls'); return m;
});

await test('scroll then lift one finger and keep moving -> scroll ends, cursor never moves', async () => {
  await two(); await slide(0, -60, 80); await up(2); await slide(0, -100, 200); await wait(100); await up();
  const m = await msgs(), k = kinds(m);
  ok(!k.includes('nudge'), 'no nudge'); eq(k.filter(x => x === 'scroll:end').length, 1, 'one end'); eq(k[k.length - 1], 'scroll:end', 'nothing after the end');
  return m;
});

await test('symmetric pinch out (centroid fixed) -> zoom about the pad-local centre, never scroll', async () => {
  await down([1, 150, 400], [2, 250, 400]); await slide(0, 0, 160, { spread: 50 }); await up();
  const m = await msgs(), z = only(m, 'zoom'), f = z.reduce((p, x) => p * x.f, 1);
  eq(kinds(m).filter(x => x !== 'zoom'), ['zoomEnd'], 'only zoom then zoomEnd');
  near(f, 2, 0.05, 'zoom factor'); near(z[z.length - 1].x, 200 - PAD.left, 1, 'centre x'); near(z[z.length - 1].y, 400 - PAD.top, 1, 'centre y');
  return m;
});

await test('pinch with one finger still -> zoom, not scroll', async () => {
  await down([1, 150, 400], [2, 230, 400]); await slide(80, 0, 160, { ids: [2] }); await up();
  const m = await msgs(), f = only(m, 'zoom').reduce((p, x) => p * x.f, 1);
  eq(kinds(m).filter(x => x !== 'zoom'), ['zoomEnd'], 'only zoom then zoomEnd'); near(f, 2, 0.05, 'zoom factor'); return m;
});

await test('symmetric pinch in -> zoom out', async () => {
  await down([1, 100, 400], [2, 300, 400]); await slide(0, 0, 160, { spread: -50 }); await up();
  const m = await msgs(), f = only(m, 'zoom').reduce((p, x) => p * x.f, 1);
  ok(!kinds(m).some(x => x.startsWith('scroll')), 'no scroll'); near(f, 0.5, 0.03, 'zoom factor'); return m;
});

// ---------- three and four fingers ----------
const three = () => down([1, 120, 450], [2, 180, 450], [3, 240, 450]);
for (const [name, dx, dy, key] of [['left', -110, 0, 'ArrowRight'], ['right', 110, 0, 'ArrowLeft'], ['up', 0, -110, 'ArrowUp'], ['down', 0, 110, 'ArrowDown']]) {
  await test(`three-finger swipe ${name} -> ctrl+${key}, once`, async () => {
    await three(); await slide(dx, dy, 200); await up();
    const m = await msgs(); eq(strip(m), [{ t: 'key', key, mods: ['ctrl'] }], 'messages'); return m;
  });
}

await test('three fingers landing 20 ms apart, swiping at once -> just the swipe', async () => {
  await down([1, 120, 450]); await wait(20); await down([2, 180, 450]); await wait(20); await down([3, 240, 450]);
  await slide(-110, 0, 150); await up();
  const m = await msgs(); eq(kinds(m), ['key:ArrowRight'], 'messages'); return m;
});

await test('three-finger tap -> Look Up (ctrl+cmd+d)', async () => {
  await three(); await wait(60); await up(); const m = await msgs(); eq(strip(m), [{ t: 'key', key: 'd', mods: ['ctrl', 'cmd'] }], 'messages'); return m;
});

await test('four fingers do nothing (tap, swipe, a fourth joining three)', async () => {
  await down([1, 100, 450], [2, 160, 450], [3, 220, 450], [4, 280, 450]); await wait(60); await up(); await wait(400);
  await down([1, 100, 450], [2, 160, 450], [3, 220, 450], [4, 280, 450]); await slide(-120, 0, 200); await up(); await wait(400);
  await three(); await wait(20); await down([4, 300, 450]); await slide(0, -120, 200); await up();
  const m = await msgs(); eq(m.length, 0, 'message count'); return m;
});

// ---------- ending abnormally ----------
await test('touchcancel mid-scroll -> scroll end with no glide', async () => {
  await two(); await slide(0, -100, 100); await cancel();
  const m = await msgs(), k = kinds(m), end = m[m.length - 1];
  eq(k[k.length - 1], 'scroll:end', 'ends'); eq([end.vx, end.vy], [0, 0], 'no glide'); return m;
});

await test('touchcancel mid-drag -> release at once', async () => {
  await tap(); await wait(120); await down([1, 200, 400]); await slide(50, 0, 120); await cancel();
  const m = await msgs(40), k = kinds(m); eq(k[k.length - 1], 'release:left', 'released'); return m;
});

await test('touchcancel mid-pinch -> zoomEnd', async () => {
  await down([1, 150, 400], [2, 250, 400]); await slide(0, 0, 100, { spread: 40 }); await cancel();
  const m = await msgs(); eq(kinds(m).at(-1), 'zoomEnd', 'zoom ended'); return m;
});

await test('a lost touchend (fresh first finger mid-scroll) ends the scroll', async () => {
  const T = (id, x, y) => `new Touch({ identifier: ${id}, target: pad, clientX: ${x}, clientY: ${y} })`;
  const fire = (type, list, changed) => evaluate(`pad.dispatchEvent(new TouchEvent('${type}', { touches: [${list}], changedTouches: [${changed}], cancelable: true, bubbles: true }))`);
  await fire('touchstart', [T(1, 150, 500), T(2, 220, 500)], [T(1, 150, 500), T(2, 220, 500)]);
  for (let i = 1; i <= 6; i++) { await sleep(16); await fire('touchmove', [T(1, 150, 500 - i * 10), T(2, 220, 500 - i * 10)], [T(1, 150, 500 - i * 10), T(2, 220, 500 - i * 10)]); }
  await fire('touchstart', [T(5, 200, 400)], [T(5, 200, 400)]);      // iOS never said fingers 1 and 2 lifted
  await sleep(300);
  await fire('touchend', [], [T(5, 200, 400)]);
  const m = await msgs(), k = kinds(m);
  eq(k.filter(x => x.startsWith('scroll')).at(-1), 'scroll:end', 'scroll closed'); eq(k.filter(x => x === 'scroll:end').length, 1, 'one end');
  return m;
});

await test('destroy mid-drag releases; nothing after destroy', async () => {
  await tap(); await wait(120); await down([1, 200, 400]); await slide(50, 0, 120);
  await evaluate('__tp.destroy()'); await up(); await wait(50);
  await tap(); await two(); await slide(0, -80, 100); await up();
  const m = await msgs(), k = kinds(m); eq(k[k.length - 1], 'release:left', 'release is the last message'); return m;
});

await test('destroy mid-scroll ends the scroll', async () => {
  await two(); await slide(0, -80, 100); await evaluate('__tp.destroy()'); await up();
  const m = await msgs(), k = kinds(m); eq(k[k.length - 1], 'scroll:end', 'ended'); return m;
});

// ---------- edge scroll ----------
await test('one finger up the right edge -> scroll (vertical only), no cursor', async () => {
  await down([1, PAD.left + 350 - 12, 600]); await slide(4, -150, 128); await up();
  const m = await msgs(), k = kinds(m);
  ok(!k.includes('nudge'), 'no nudge'); eq(k[0], 'scroll:begin', 'begin'); eq(k[k.length - 1], 'scroll:end', 'end');
  near(sum(m, 'dy', 'scroll'), 150 * 1.25, 4, 'against the finger'); near(sum(m, 'dx', 'scroll'), 0, 0.01, 'no sideways');
  ok(m[m.length - 1].vy > 1, 'glides'); eq(m[m.length - 1].vx, 0, 'no sideways glide'); return m;
});
await test('one finger down the left edge -> scroll', async () => {
  await down([1, PAD.left + 10, 300]); await slide(0, 120, 200); await up();
  const m = await msgs(); ok(!kinds(m).includes('nudge'), 'no nudge'); near(sum(m, 'dy', 'scroll'), -120 * 1.25, 4, 'scrolled'); return m;
});
await test('from the edge sideways -> cursor, not scroll', async () => {
  await down([1, PAD.left + 10, 400]); await slide(120, 10, 200); await up();
  const m = await msgs(), k = kinds(m); ok(!k.some(x => x.startsWith('scroll')), 'no scroll'); ok(sum(m, 'dx') > 100, 'cursor moved'); return m;
});
await test('tap on the edge -> click', async () => {
  await tap(PAD.left + 8, 400); const m = await msgs(); eq(strip(m), [{ t: 'click', button: 'left', count: 1 }], 'click'); return m;
});
await test('one finger up the middle -> cursor, not scroll', async () => {
  await down([1, PAD.left + 175, 600]); await slide(0, -150, 200); await up();
  const m = await msgs(), k = kinds(m); ok(!k.some(x => x.startsWith('scroll')), 'no scroll'); ok(sum(m, 'dy') < -100, 'cursor moved up'); return m;
});

// ---------- mouse ----------
await test('mouse: drag = nudge, click = click', async () => {
  const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
  await mouse('mousePressed', 100, 400, { buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', 100 + i * 8, 400, { buttons: 1 }); await sleep(16); }
  await mouse('mouseReleased', 180, 400, { clickCount: 1 }); await sleep(100);
  await mouse('mousePressed', 180, 400, { buttons: 1, clickCount: 1 }); await mouse('mouseReleased', 180, 400, { clickCount: 1 });
  const m = await msgs(), k = kinds(m);
  ok(sum(m, 'dx') > 80, 'moved right'); eq(k.filter(x => x !== 'nudge'), ['click:left:1'], 'one click, after the drag'); return m;
});

// ---------- summary ----------
const errors = await evaluate('__errors');
results.push(['no page errors', !errors.length]); if (errors.length) console.log('  FAIL no page errors: ' + errors.join('; '));
const failed = results.filter(r => !r[1]);
console.log(`\ntrackpad: ${results.length - failed.length}/${results.length} passed, ${all.length} messages checked well-formed` + (failed.length ? '\nFAILED: ' + failed.map(r => r[0]).join('; ') : ''));
ws.close(); cleanup();
process.exit(failed.length ? 1 : 0);
