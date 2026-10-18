// The desktop viewer page (/desktop): decodes the H.264 stream with WebCodecs onto a canvas and turns touch into
// mouse and keyboard. One finger: tap = click, hold = right click, drag = drag. Two fingers: pinch = zoom,
// move = pan when zoomed, otherwise scroll. The keyboard button opens the phone's keyboard and a key bar.
// opts: wsPath (the socket; the page's own query string is passed on), dock (the Dock button), title.
// openPath: POSTed first (with the page's query string); its { crop } (fractions of the screen) limits the view
// to that part of the screen, and taps map into it (the Mac view's window).
export function desktopPage({ wsPath = '/desktop/ws', dock = true, title = 'Seer', openPath = null } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#000"><title>${title}</title>
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials"><link rel="apple-touch-icon" href="/icon-180.png">
<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Seer"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style>
:root{--bg:#000;--bar:#0a0a0a;--border:#262626;--text:#ededed;--quiet:#a1a1a1;--live:#00e676;--fail:#ff4d4f;--wait:#f5a524}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font:14px/1.3 -apple-system,system-ui,sans-serif;overflow:hidden;overscroll-behavior:none}
/* #app is pinned to the part of the screen the phone actually shows (visualViewport, set from the script):
   when the keyboard opens, iOS slides the page up, and everything inside #app stays in view above the keyboard */
#app{position:fixed;left:0;right:0;top:var(--vt,0px);height:var(--vh,100%);overflow:hidden}
#bar{position:absolute;top:0;left:0;right:0;height:calc(44px + env(safe-area-inset-top));padding:env(safe-area-inset-top) max(12px,env(safe-area-inset-right)) 0 max(12px,env(safe-area-inset-left));display:flex;align-items:center;gap:10px;background:var(--bar);border-bottom:1px solid var(--border);z-index:2}
#bar a{color:var(--quiet);text-decoration:none;font-size:18px;padding:4px 6px}
#dot{width:8px;height:8px;border-radius:50%;background:var(--wait);flex:none}
#dot.live{background:var(--live)}#dot.fail{background:var(--fail)}
#msg{color:var(--quiet);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
button{background:none;border:1px solid var(--border);color:var(--text);border-radius:8px;height:32px;min-width:36px;padding:0 10px;font:inherit;flex:none}
button.on{border-color:var(--live);color:var(--live)}
#stage{position:absolute;top:calc(44px + env(safe-area-inset-top));left:env(safe-area-inset-left);right:env(safe-area-inset-right);bottom:env(safe-area-inset-bottom);display:flex;align-items:center;justify-content:center;touch-action:none;overflow:hidden}
#wrap{transform-origin:0 0}
canvas{display:block}
#keys{position:absolute;left:0;right:0;bottom:0;display:none;gap:6px;padding:8px 8px calc(8px + env(safe-area-inset-bottom));background:var(--bar);border-top:1px solid var(--border);overflow-x:auto;z-index:2}
#keys.open{display:flex}
body.keys-open #stage{bottom:calc(50px + env(safe-area-inset-bottom))}
body.kb-up #keys{padding-bottom:8px}
body.kb-up.keys-open #stage{bottom:50px}
#typepill{position:absolute;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));transform:translateX(-50%);display:none;z-index:3;height:40px;padding:0 18px;border-radius:20px;border-color:var(--live);color:var(--live);background:var(--bar)}
#typepill.show{display:block}
#type{position:fixed;left:-1000px;top:0;opacity:0;font-size:16px}
/* Landscape on a phone: the controls are a column on the left, the key bar a two-column strip on the right,
   and the screen fills the height between them. Both columns scroll if the keyboard leaves them short. */
@media (orientation:landscape) and (max-height:500px){
  #bar{top:0;bottom:0;left:0;right:auto;width:calc(52px + env(safe-area-inset-left));height:auto;flex-direction:column;align-items:center;gap:8px;padding:8px 0 8px env(safe-area-inset-left);border-bottom:none;border-right:1px solid var(--border);overflow-y:auto}
  #msg{display:none}
  button{min-width:40px;height:30px;padding:0 6px}
  #stage{top:0;bottom:0;left:calc(52px + env(safe-area-inset-left))}
  #keys{top:0;bottom:0;left:auto;right:0;width:calc(100px + env(safe-area-inset-right));grid-template-columns:1fr 1fr;align-content:start;gap:6px;padding:8px calc(6px + env(safe-area-inset-right)) 8px 6px;border-top:none;border-left:1px solid var(--border);overflow-y:auto}
  #keys.open{display:grid}
  #keys button{min-width:0;width:100%}
  body.kb-up #keys{gap:4px;padding-top:6px;padding-bottom:6px}
  body.kb-up #keys button,body.kb-up #bar button{height:26px}
  body.kb-up #bar{gap:6px;padding-top:6px}
  body.keys-open #stage,body.kb-up.keys-open #stage{right:calc(100px + env(safe-area-inset-right));bottom:0}
  #typepill{left:calc(64px + env(safe-area-inset-left));transform:none}
}
</style></head><body>
<div id="app">
<div id="bar"><a href="/" aria-label="Back">&larr;</a><span id="dot"></span><span id="msg">Connecting</span>
<button id="kb" aria-label="Keyboard">&#9000;</button>${dock ? '<button id="dock" aria-label="Show the Dock">Dock</button>' : ''}<button id="fit" aria-label="Fit to screen">1:1</button></div>
<div id="stage"><div id="wrap"><canvas id="screen" width="16" height="10"></canvas></div></div>
<div id="keys">
<button data-mod="cmd">&#8984;</button><button data-mod="alt">&#8997;</button><button data-mod="ctrl">&#8963;</button><button data-mod="shift">&#8679;</button>
<button data-key="Escape">esc</button><button data-key="Tab">tab</button><button data-key="Enter">&#8629;</button><button data-key="Backspace">&#9003;</button>
<button data-key="ArrowLeft">&larr;</button><button data-key="ArrowUp">&uarr;</button><button data-key="ArrowDown">&darr;</button><button data-key="ArrowRight">&rarr;</button>
</div>
<button id="typepill">&#9000; Type</button>
</div>
<input id="type" inputmode="none" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false">
<script>
const $ = id => document.getElementById(id);
const canvas = $('screen'), ctx = canvas.getContext('2d'), wrap = $('wrap'), stage = $('stage');
const status = (text, cls) => { $('msg').textContent = text; $('dot').className = cls || ''; };
let ws, decoder, configured = false, waitingKey = true, mods = new Set();
let crop = null;   // { x, y, w, h } as fractions of the Mac's screen, or the whole screen
let drawing = false, pendingJpeg = null;
function drawJpeg(buf) {
  drawing = true;
  createImageBitmap(new Blob([buf.subarray(1)], { type: 'image/jpeg' })).then(bmp => {
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; fit(); }
    ctx.drawImage(bmp, 0, 0); bmp.close();
    if ($('dot').className !== 'live') status('Live', 'live');
  }).catch(() => {}).finally(() => { drawing = false; if (pendingJpeg) { const next = pendingJpeg; pendingJpeg = null; drawJpeg(next); } });
}

function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function makeDecoder(cfg) {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = new VideoDecoder({
    output: frame => {
      const fw = frame.displayWidth, fh = frame.displayHeight;
      const sx = crop ? Math.round(crop.x * fw) : 0, sy = crop ? Math.round(crop.y * fh) : 0;
      const sw = crop ? Math.round(crop.w * fw) : fw, sh = crop ? Math.round(crop.h * fh) : fh;
      if (canvas.width !== sw || canvas.height !== sh) { canvas.width = sw; canvas.height = sh; fit(); }
      ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, sw, sh); frame.close();
    },
    error: e => { status('Decoder: ' + e.message, 'fail'); configured = false; waitingKey = true; send({ t: 'keyframe' }); },
  });
  decoder.configure({ codec: cfg.codec, description: cfg.avcc, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
  configured = true; waitingKey = true;
}

function connect() {
  status('Connecting', '');
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + ${JSON.stringify(wsPath)} + location.search);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => status('Waiting for the first frame', '');
  ws.onmessage = ev => {
    if (typeof ev.data === 'string') {
      const m = JSON.parse(ev.data);
      if (m.error) status(m.error, 'fail');
      if ('dock' in m && $('dock')) $('dock').classList.toggle('on', m.dock);
      if ('textFocus' in m) textFocus(m.textFocus);
      return;
    }
    const buf = new Uint8Array(ev.data), type = buf[0];
    if (type === 5) {                        // a whole JPEG frame (the Mac view): draw the newest, skip any that queue behind
      if (drawing) { pendingJpeg = buf; return; }
      drawJpeg(buf);
      return;
    }
    if (type === 1) {
      const jl = (buf[1] << 8) | buf[2], cfg = JSON.parse(new TextDecoder().decode(buf.subarray(3, 3 + jl)));
      cfg.avcc = buf.slice(3 + jl);
      makeDecoder(cfg);
      return;
    }
    if (!configured || (waitingKey && type !== 2)) return;
    waitingKey = false;
    const view = new DataView(buf.buffer, buf.byteOffset + 1, 8);
    const ts = Number(view.getBigUint64(0));
    if (decoder.decodeQueueSize > 6 && type === 3) { waitingKey = true; send({ t: 'keyframe' }); return; }
    decoder.decode(new EncodedVideoChunk({ type: type === 2 ? 'key' : 'delta', timestamp: ts, data: buf.subarray(9) }));
    if ($('dot').className !== 'live') status('Live', 'live');
  };
  ws.onclose = () => { status('Disconnected, reconnecting', 'fail'); configured = false; setTimeout(connect, 1500); };
}

// ---------- view: fit, zoom and pan (local only) ----------
let zoom = 1, panX = 0, panY = 0;
// The largest size with the screen's own proportions inside the space actually left on the phone (measured,
// since 100vh in iOS landscape counts the toolbar and the notch). Run again on every rotation or resize.
function fit() {
  const w = stage.clientWidth, h = stage.clientHeight, ar = canvas.width / canvas.height;
  if (!w || !h || !ar) return;
  let cw = w, ch = w / ar;
  if (ch > h) { ch = h; cw = h * ar; }
  canvas.style.width = Math.floor(cw) + 'px'; canvas.style.height = Math.floor(ch) + 'px';
  zoom = 1; panX = panY = 0; applyView();
}
let fitTimer;
const refit = () => { clearTimeout(fitTimer); fitTimer = setTimeout(fit, 120); };   // iOS reports the new size a moment after rotating
window.addEventListener('resize', refit);
window.addEventListener('orientationchange', refit);
// Pin #app to what is visible: the keyboard shrinks the visual viewport and iOS scrolls the page under it.
function syncViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  document.documentElement.style.setProperty('--vh', vv.height + 'px');
  document.documentElement.style.setProperty('--vt', vv.offsetTop + 'px');
  document.body.classList.toggle('kb-up', vv.height < window.innerHeight * 0.8);
  refit();
}
if (window.visualViewport) { visualViewport.addEventListener('resize', syncViewport); visualViewport.addEventListener('scroll', syncViewport); syncViewport(); }
function applyView() { wrap.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')'; $('fit').textContent = zoom > 1.01 ? 'fit' : '1:1'; }
$('fit').onclick = () => {
  if (zoom > 1.01) { zoom = 1; panX = panY = 0; }
  else { const r = canvas.getBoundingClientRect(); zoom = Math.max(1, canvas.width / r.width); panX = -(r.width * zoom - r.width) / 2; panY = 0; }
  applyView();
};
function toRemote(cx, cy) {
  const r = canvas.getBoundingClientRect(), nx = (cx - r.left) / r.width, ny = (cy - r.top) / r.height;
  return crop ? { x: crop.x + nx * crop.w, y: crop.y + ny * crop.h } : { x: nx, y: ny };
}
const withMods = o => { if (mods.size) o.mods = [...mods]; return o; };
function clearMods() { if (!mods.size) return; mods.clear(); document.querySelectorAll('[data-mod]').forEach(b => b.classList.remove('on')); }

// ---------- touch ----------
let one = null, two = null, holdTimer = null;
stage.addEventListener('touchstart', e => {
  e.preventDefault();
  if (e.touches.length === 1) {
    const t = e.touches[0];
    one = { x0: t.clientX, y0: t.clientY, t0: Date.now(), dragging: false, held: false };
    holdTimer = setTimeout(() => {
      if (!one || one.dragging) return;
      one.held = true;
      const p = toRemote(one.x0, one.y0);
      send(withMods({ t: 'down', button: 'right', ...p })); send({ t: 'up', button: 'right', ...p }); clearMods();
      navigator.vibrate && navigator.vibrate(10);
    }, 450);
  } else if (e.touches.length === 2) {
    clearTimeout(holdTimer);
    if (one && one.dragging) send({ t: 'up', ...toRemote(one.lastX, one.lastY) });
    one = null;
    const [a, b] = e.touches;
    two = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2, zooming: false };
  }
}, { passive: false });

stage.addEventListener('touchmove', e => {
  e.preventDefault();
  if (one && e.touches.length === 1) {
    const t = e.touches[0];
    if (!one.dragging && Math.hypot(t.clientX - one.x0, t.clientY - one.y0) > 10 && !one.held) {
      clearTimeout(holdTimer); one.dragging = true;
      send({ t: 'move', ...toRemote(one.x0, one.y0) }); send(withMods({ t: 'down', ...toRemote(one.x0, one.y0) }));
    }
    if (one.dragging) { one.lastX = t.clientX; one.lastY = t.clientY; send({ t: 'move', ...toRemote(t.clientX, t.clientY) }); }
  } else if (two && e.touches.length === 2) {
    const [a, b] = e.touches;
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2;
    const ratio = d / two.d;
    if (two.zooming || Math.abs(ratio - 1) > 0.06) {
      two.zooming = true;
      const sr = stage.getBoundingClientRect(), nz = Math.min(6, Math.max(1, zoom * ratio));
      const px = cx - sr.left, py = cy - sr.top;                       // keep the point under the fingers still
      panX = px - (px - panX) * (nz / zoom) + (cx - two.cx); panY = py - (py - panY) * (nz / zoom) + (cy - two.cy);
      zoom = nz; if (zoom === 1) { panX = panY = 0; } applyView();
    } else if (zoom > 1.01) { panX += cx - two.cx; panY += cy - two.cy; applyView(); }
    else send({ t: 'scroll', dx: Math.round((cx - two.cx) * 2), dy: Math.round((cy - two.cy) * 2) });
    Object.assign(two, { d, cx, cy });
  }
}, { passive: false });

stage.addEventListener('touchend', e => {
  e.preventDefault();
  clearTimeout(holdTimer);
  if (one && !e.touches.length) {
    if (one.dragging) send({ t: 'up', ...toRemote(one.lastX, one.lastY) });
    else if (!one.held && Date.now() - one.t0 < 450) {
      const p = toRemote(one.x0, one.y0);
      send({ t: 'move', ...p }); send(withMods({ t: 'down', ...p })); send({ t: 'up', ...p });
      primeKeyboard();
    }
    clearMods(); one = null;
  }
  if (e.touches.length < 2) two = null;
}, { passive: false });

// ---------- mouse (testing from a computer) ----------
let mouseDown = false;
canvas.addEventListener('mousedown', e => { mouseDown = true; send(withMods({ t: 'down', button: e.button === 2 ? 'right' : 'left', ...toRemote(e.clientX, e.clientY) })); });
window.addEventListener('mouseup', e => { if (mouseDown) { mouseDown = false; send({ t: 'up', button: e.button === 2 ? 'right' : 'left', ...toRemote(e.clientX, e.clientY) }); } });
canvas.addEventListener('mousemove', e => send({ t: 'move', ...toRemote(e.clientX, e.clientY) }));
canvas.addEventListener('wheel', e => { e.preventDefault(); send({ t: 'scroll', dx: -Math.round(e.deltaX), dy: -Math.round(e.deltaY) }); }, { passive: false });
canvas.addEventListener('contextmenu', e => e.preventDefault());

if ($('dock')) $('dock').onclick = () => send({ t: 'dock' });

// ---------- keyboard ----------
// iOS opens the keyboard only inside a tap, and the Mac says "a text field has focus" a moment after the tap.
// So every tap focuses the hidden input with inputmode=none (no keyboard yet); when the Mac reports a text
// field, inputmode switches to text, which brings the keyboard up on the input that already has focus. If iOS
// does not (the screen did not shrink), a Type button appears instead: one tap. Opened by the Mac, the keyboard
// also closes when focus leaves the text field; opened by hand (the keyboard button), it stays.
const input = $('type');
let kbOpen = false, kbAuto = false, ourBlur = false;
const keyboardUp = () => window.visualViewport && visualViewport.height < window.innerHeight * 0.8;
function showKeys(auto) { $('keys').classList.add('open'); document.body.classList.add('keys-open'); $('kb').classList.add('on'); kbOpen = true; kbAuto = auto; $('typepill').classList.remove('show'); refit(); }
function closedKeys() { $('keys').classList.remove('open'); document.body.classList.remove('keys-open'); $('kb').classList.remove('on'); kbOpen = kbAuto = false; input.setAttribute('inputmode', 'none'); refit(); }
function blurQuietly() { ourBlur = true; input.blur(); ourBlur = false; }
function hideKeys() { closedKeys(); blurQuietly(); }
function openKeyboard(auto) { input.setAttribute('inputmode', 'text'); blurQuietly(); input.focus({ preventScroll: true }); showKeys(auto); }
// The keyboard closed some other way (iOS's own hide-keyboard key, Done): the key bar and the button follow.
input.addEventListener('blur', () => { if (!ourBlur && kbOpen) closedKeys(); });
// Buttons must not take focus from the input on press, or every key-bar tap would close the keyboard.
document.querySelectorAll('#bar button, #keys button, #typepill').forEach(b => b.addEventListener('pointerdown', e => e.preventDefault()));
function primeKeyboard() { if (!kbOpen) { input.setAttribute('inputmode', 'none'); input.focus({ preventScroll: true }); } }
function textFocus(on) {
  if (on && !kbOpen) {
    input.setAttribute('inputmode', 'text');
    showKeys(true);
    setTimeout(() => { if (kbAuto && !keyboardUp()) $('typepill').classList.add('show'); }, 450);
  } else if (!on) {
    $('typepill').classList.remove('show');
    if (kbAuto) hideKeys();
  }
}
$('typepill').onclick = () => openKeyboard(true);
$('kb').onclick = () => { if (kbOpen) hideKeys(); else openKeyboard(false); };
document.querySelectorAll('[data-mod]').forEach(b => b.onclick = () => {
  const m = b.dataset.mod; mods.has(m) ? mods.delete(m) : mods.add(m); b.classList.toggle('on', mods.has(m)); input.focus();
});
document.querySelectorAll('[data-key]').forEach(b => b.onclick = () => { send(withMods({ t: 'key', key: b.dataset.key })); clearMods(); input.focus(); });
input.addEventListener('keydown', e => {
  const special = ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
  if (special.includes(e.key)) { e.preventDefault(); send(withMods({ t: 'key', key: e.key })); clearMods(); }
});
input.addEventListener('input', e => {
  const text = input.value; input.value = '';
  if (!text) { if (e.inputType === 'deleteContentBackward') send({ t: 'key', key: 'Backspace' }); return; }
  if (mods.size && text.length === 1) { send(withMods({ t: 'key', key: text })); clearMods(); }
  else send({ t: 'text', text });
});

async function start() {
  if (${JSON.stringify(openPath)}) {
    status('Opening on the Mac', '');
    try {
      const r = await fetch(${JSON.stringify(openPath)} + location.search, { method: 'POST' });
      const body = await r.json();
      if (!r.ok) return status(body.error || 'Could not open it on the Mac', 'fail');
      crop = body.crop;
    } catch { return status('Could not reach the Mac', 'fail'); }
  }
  connect();
}
if (!('VideoDecoder' in window) && ${JSON.stringify(wsPath)} === '/desktop/ws') status('This browser cannot play the stream (no WebCodecs)', 'fail');
else start();
</script></body></html>`;
}
