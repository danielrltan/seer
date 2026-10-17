// The desktop viewer page (/desktop): decodes the H.264 stream with WebCodecs onto a canvas and turns touch into
// mouse and keyboard. One finger: tap = click, hold = right click, drag = drag. Two fingers: pinch = zoom,
// move = pan when zoomed, otherwise scroll. The keyboard button opens the phone's keyboard and a key bar.
export function desktopPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#000"><title>Desktop</title>
<style>
:root{--bg:#000;--bar:#0a0a0a;--border:#262626;--text:#ededed;--quiet:#a1a1a1;--live:#00e676;--fail:#ff4d4f;--wait:#f5a524}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font:14px/1.3 -apple-system,system-ui,sans-serif;overflow:hidden;overscroll-behavior:none}
#bar{position:fixed;top:0;left:0;right:0;height:calc(44px + env(safe-area-inset-top));padding:env(safe-area-inset-top) 12px 0;display:flex;align-items:center;gap:10px;background:var(--bar);border-bottom:1px solid var(--border);z-index:2}
#bar a{color:var(--quiet);text-decoration:none;font-size:18px;padding:4px 6px}
#dot{width:8px;height:8px;border-radius:50%;background:var(--wait);flex:none}
#dot.live{background:var(--live)}#dot.fail{background:var(--fail)}
#msg{color:var(--quiet);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
button{background:none;border:1px solid var(--border);color:var(--text);border-radius:8px;height:32px;min-width:36px;padding:0 10px;font:inherit}
button.on{border-color:var(--live);color:var(--live)}
#stage{position:fixed;top:calc(44px + env(safe-area-inset-top));left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;touch-action:none}
#wrap{transform-origin:0 0}
canvas{display:block;max-width:100vw;max-height:calc(100vh - 44px - env(safe-area-inset-top));width:auto;height:auto}
#keys{position:fixed;left:0;right:0;bottom:0;display:none;gap:6px;padding:8px 8px calc(8px + env(safe-area-inset-bottom));background:var(--bar);border-top:1px solid var(--border);overflow-x:auto;z-index:2}
#keys.open{display:flex}
#keys button{flex:none}
#type{position:fixed;left:-1000px;top:0;opacity:0;font-size:16px}
</style></head><body>
<div id="bar"><a href="/" aria-label="Back">&larr;</a><span id="dot"></span><span id="msg">Connecting</span>
<button id="dock" aria-label="Show the Dock">Dock</button><button id="kb" aria-label="Keyboard">&#9000;</button><button id="fit" aria-label="Fit to screen">1:1</button></div>
<div id="stage"><div id="wrap"><canvas id="screen" width="16" height="10"></canvas></div></div>
<div id="keys">
<button data-mod="cmd">&#8984;</button><button data-mod="alt">&#8997;</button><button data-mod="ctrl">&#8963;</button><button data-mod="shift">&#8679;</button>
<button data-key="Escape">esc</button><button data-key="Tab">tab</button><button data-key="Enter">&#8629;</button><button data-key="Backspace">&#9003;</button>
<button data-key="ArrowLeft">&larr;</button><button data-key="ArrowUp">&uarr;</button><button data-key="ArrowDown">&darr;</button><button data-key="ArrowRight">&rarr;</button>
</div>
<input id="type" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false">
<script>
const $ = id => document.getElementById(id);
const canvas = $('screen'), ctx = canvas.getContext('2d'), wrap = $('wrap'), stage = $('stage');
const status = (text, cls) => { $('msg').textContent = text; $('dot').className = cls || ''; };
let ws, decoder, configured = false, waitingKey = true, mods = new Set();

function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function makeDecoder(cfg) {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = new VideoDecoder({
    output: frame => {
      if (canvas.width !== frame.displayWidth) { canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; }
      ctx.drawImage(frame, 0, 0); frame.close();
    },
    error: e => { status('Decoder: ' + e.message, 'fail'); configured = false; waitingKey = true; send({ t: 'keyframe' }); },
  });
  decoder.configure({ codec: cfg.codec, description: cfg.avcc, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
  configured = true; waitingKey = true;
}

function connect() {
  status('Connecting', '');
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/desktop/ws');
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => status('Waiting for the first frame', '');
  ws.onmessage = ev => {
    if (typeof ev.data === 'string') {
      const m = JSON.parse(ev.data);
      if (m.error) status(m.error, 'fail');
      if ('dock' in m) $('dock').classList.toggle('on', m.dock);
      return;
    }
    const buf = new Uint8Array(ev.data), type = buf[0];
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

// ---------- view: zoom and pan (local only) ----------
let zoom = 1, panX = 0, panY = 0;
function applyView() { wrap.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')'; $('fit').textContent = zoom > 1.01 ? 'fit' : '1:1'; }
$('fit').onclick = () => {
  if (zoom > 1.01) { zoom = 1; panX = panY = 0; }
  else { const r = canvas.getBoundingClientRect(); zoom = Math.max(1, canvas.width / r.width); panX = -(r.width * zoom - r.width) / 2; panY = 0; }
  applyView();
};
function toRemote(cx, cy) {
  const r = canvas.getBoundingClientRect();
  return { x: (cx - r.left) / r.width, y: (cy - r.top) / r.height };
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

$('dock').onclick = () => send({ t: 'dock' });

// ---------- keyboard ----------
const input = $('type');
$('kb').onclick = () => {
  const open = !$('keys').classList.contains('open');
  $('keys').classList.toggle('open', open); $('kb').classList.toggle('on', open);
  if (open) input.focus(); else input.blur();
};
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

if (!('VideoDecoder' in window)) status('This browser cannot play the stream (no WebCodecs)', 'fail');
else connect();
</script></body></html>`;
}
