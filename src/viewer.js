// The desktop viewer page (/desktop): decodes the H.264 stream with WebCodecs onto a canvas and turns touch into
// mouse and keyboard (gestures: see touch, below). The keyboard button opens the phone's keyboard and a key bar.
// opts: wsPath (the socket; the page's own query string is passed on), dock (the Dock button), title.
// openPath: POSTed first (with the page's query string); its { crop } (fractions of the screen) limits the view
// to that part of the screen, and taps map into it (the Mac view's window).
// Upright, the screen sits at the top and the space under it is a trackpad (trackpad.js); on its side the
// screen fills the height and the controls are a glass rail on the left. Dark Liquid Glass (glass.js).
import { ICON_HEAD } from './icons.js';
import { GLASS_CSS, BACK } from './glass.js';
import { TRACKPAD_JS } from './trackpad.js';

// One icon style for every control: 24-unit grid, 1.7 stroke, round caps and joins (as glass.js's gear and back).
const ico = (d, size = 22) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</g></svg>`;
const KEYBOARD = '<rect x="2.5" y="5.5" width="19" height="13" rx="2.6"/><path d="M6.3 9.4h.01M9.4 9.4h.01M12.5 9.4h.01M15.6 9.4h.01M18.2 9.4h-.5M7.8 12.3h.01M10.9 12.3h.01M14 12.3h.01M16.9 12.3h.01M8.5 15.3h7" stroke-width="1.9"/>';
const I = {
  keyboard: ico(KEYBOARD),
  dock: ico('<rect x="2.5" y="4" width="19" height="16" rx="2.8"/><path d="M6.5 16.2h11" stroke-width="2.6"/>'),
  unzoom: ico('<path d="M9 4.5V9H4.5M15 4.5V9h4.5M9 19.5V15H4.5M15 19.5V15h4.5"/>'),
  cmd: ico('<path d="M14.5 7v10a2.5 2.5 0 1 0 2.5-2.5H7a2.5 2.5 0 1 0 2.5 2.5V7A2.5 2.5 0 1 0 7 9.5h10A2.5 2.5 0 1 0 14.5 7"/>', 20),
  alt: ico('<path d="M4 7h4.6l6.8 10H20M14.2 7H20"/>', 20),
  ctrl: ico('<path d="M6.5 14.2 12 8.7l5.5 5.5"/>', 20),
  shift: ico('<path d="M12 4.6 4.6 12h3.9v7.4h7V12h3.9z"/>', 20),
  enter: ico('<path d="M19 5.5v6a2.5 2.5 0 0 1-2.5 2.5H5.5M9 10.5 5.5 14 9 17.5"/>', 19),
  back: ico('<path d="M8.6 5.5H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8.6L3 12z"/><path d="m11.5 9.5 5 5m0-5-5 5"/>', 19),
  left: ico('<path d="M14.5 6.5 9 12l5.5 5.5"/>', 19), right: ico('<path d="M9.5 6.5 15 12l-5.5 5.5"/>', 19),
  up: ico('<path d="M6.5 14.5 12 9l5.5 5.5"/>', 19), down: ico('<path d="M6.5 9.5 12 15l5.5-5.5"/>', 19),
};
const MODS = [['cmd', 'Command'], ['alt', 'Option'], ['ctrl', 'Control'], ['shift', 'Shift']];
const KEYS = [['Escape', 'esc'], ['Tab', 'tab'], ['Enter', I.enter], ['Backspace', I.back], ['ArrowLeft', I.left], ['ArrowUp', I.up], ['ArrowDown', I.down], ['ArrowRight', I.right]];
// The trackpad's surface: smoked glass with a faint grain, as a real one's matte finish.
const GRAIN = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .055 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;

export function desktopPage({ wsPath = '/desktop/ws', dock = true, title = 'Seer', openPath = null, backHref = '/' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#020403"><title>${title}</title>
${ICON_HEAD}
<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Seer"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style>${GLASS_CSS}
html,body{height:100%;overflow:hidden;overscroll-behavior:none}
body{min-height:0;font:14px/1.3 var(--sans);
  background:radial-gradient(110% 60% at 50% 110%,rgba(43,240,138,.09),transparent 62%),radial-gradient(80% 45% at 0% 55%,rgba(12,143,134,.07),transparent 70%),var(--bg)}
button{-webkit-appearance:none;appearance:none;border:0;margin:0;padding:0;font:inherit;color:inherit;background:none;cursor:pointer;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
svg{display:block}
/* #app is pinned to the part of the screen the phone actually shows (visualViewport, set from the script):
   when the keyboard opens, iOS slides the page up, and everything inside #app stays in view above the keyboard.
   Upright it is a column: the screen, the trackpad, then the key bar (while typing) and the controls. */
#app{position:fixed;left:0;right:0;top:var(--vt,0px);height:var(--vh,100%);overflow:hidden;display:flex;flex-direction:column;gap:10px;
  padding:calc(6px + env(safe-area-inset-top)) max(8px,env(safe-area-inset-right)) max(10px,env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left))}
body.short-vp #app{padding-bottom:10px}
#stage{position:relative;flex:none;align-self:center;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:none;border-radius:13px;background:#000;
  box-shadow:0 0 0 .5px rgba(255,255,255,.17),0 18px 44px rgba(0,0,0,.7)}
#wrap{transform-origin:0 0}
canvas{display:block}
/* The Mac's pointer, drawn over as a solid green arrow with the Mac arrow's own angles (Figma-style): its tip is the
   pointer's tip, so it covers the small real one exactly. A ring spreads where a click lands. Drawn on the phone at
   the position the Mac reports; the Mac's own cursor is unchanged. */
#halo{position:absolute;left:0;top:0;width:13px;height:20px;transform-origin:0 0;overflow:visible;pointer-events:none;z-index:2;opacity:0;
  filter:drop-shadow(0 1px 2px rgba(0,0,0,.45)) drop-shadow(0 0 5px var(--glow));transition:opacity .35s}
#halo path{fill:var(--live);stroke:var(--live);stroke-width:1.3;stroke-linejoin:round}   /* the stroke only rounds and fills out the shape, all green */
#halo.on{opacity:1}#halo.on.rest{opacity:.7}
.ripple{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;pointer-events:none;z-index:2;
  border:2.5px solid var(--live);box-shadow:0 0 10px var(--glow);animation:ripple .5s cubic-bezier(.2,.7,.3,1) forwards}
.ripple.right{border-style:dashed}
@keyframes ripple{from{transform:scale(.5);opacity:1}to{transform:scale(2.7);opacity:0}}
#pad{position:relative;flex:1 1 0;min-height:0;border-radius:26px;-webkit-backdrop-filter:none;backdrop-filter:none;touch-action:none;-webkit-user-select:none;user-select:none;
  background:${GRAIN},radial-gradient(130% 80% at 50% -20%,rgba(255,255,255,.075),transparent 60%),linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.01)),rgba(14,19,17,.5);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.14),inset 0 -1px 0 rgba(255,255,255,.03),inset 0 0 0 .5px rgba(255,255,255,.05),0 22px 50px rgba(0,0,0,.55)}
/* edge scroll: a faint groove down each side of the pad, lit while a thumb scrolls along it */
#pad .groove{position:absolute;top:22px;bottom:22px;width:3px;border-radius:2px;background:rgba(255,255,255,.07);transition:background .25s,box-shadow .25s;pointer-events:none}
#pad .groove.l{left:9px}#pad .groove.r{right:9px}
#pad .groove.on{background:var(--live);box-shadow:0 0 12px var(--glow)}
#foot{flex:none;position:relative;display:flex;flex-direction:column;align-items:center;gap:10px}
/* the controls: one glass capsule of round glass buttons */
#bar{display:flex;align-items:center;gap:3px;padding:6px;border-radius:28px;max-width:100%}
#bar .icon-btn{flex:0 1 40px;min-width:32px;width:40px;height:40px;border-radius:20px;color:var(--ink2);background:none;box-shadow:none;transition:background .15s,color .15s,box-shadow .15s}
#bar .icon-btn:active,.key:active{background:rgba(255,255,255,.16)}
#bar .icon-btn.on{color:#eafff3;background:linear-gradient(160deg,rgba(43,240,138,.46),rgba(43,240,138,.16));
  box-shadow:inset 0 1px 0 rgba(200,255,225,.42),0 0 0 .5px rgba(43,240,138,.55),0 0 16px rgba(43,240,138,.24)}
#bar .icon-btn.on svg{filter:drop-shadow(0 0 5px var(--glow))}
.sep{flex:none;width:1px;height:22px;margin:0 3px;background:rgba(255,255,255,.1)}
#dot{flex:none;width:8px;height:8px;margin:0 12px 0 9px;border-radius:50%;background:var(--amber);box-shadow:0 0 10px var(--amber);transition:background .3s,box-shadow .3s}
#dot.live{background:var(--live);box-shadow:0 0 10px var(--glow)}#dot.fail{background:var(--red);box-shadow:0 0 10px var(--red)}
/* the key bar (while typing): keycaps in a glass strip */
#keys{display:none;width:100%;gap:5px;padding:5px;border-radius:22px}
#keys.open{display:flex}
.key{flex:1;min-width:0;height:40px;border-radius:15px;display:grid;place-items:center;color:var(--ink2);font:600 14px var(--round);
  background:rgba(255,255,255,.07);box-shadow:inset 0 1px 0 rgba(255,255,255,.12)}
/* status, on the screen while it is not live (connecting, reconnecting, copied, errors) */
#msg{position:absolute;z-index:2;top:12px;left:50%;transform:translateX(-50%);max-width:calc(100% - 24px);height:30px;padding:0 14px;border-radius:15px;
  font:600 13px/30px var(--sans);color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
#typepill{position:absolute;z-index:3;left:50%;bottom:calc(100% + 16px);transform:translateX(-50%);display:none;width:58px;height:58px;border-radius:29px;place-items:center;color:#eafff3;
  background:linear-gradient(160deg,rgba(43,240,138,.5),rgba(43,240,138,.18)),rgba(8,14,11,.6);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);
  box-shadow:inset 0 1px 0 rgba(200,255,225,.45),0 0 0 .5px rgba(43,240,138,.6),0 0 28px rgba(43,240,138,.35),0 10px 30px rgba(0,0,0,.5)}
#typepill.show{display:grid}
#typepill svg{filter:drop-shadow(0 0 6px var(--glow))}
#type{position:fixed;left:-1000px;top:0;opacity:0;font-size:16px}
/* Landscape on a phone: the screen fills the height, the controls are a glass rail on the left and the key bar a
   two-column strip on the right. No trackpad: touch the screen itself. Both columns scroll if the keyboard
   leaves them short. */
@media (orientation:landscape) and (max-height:500px){
  #app{display:block;padding:0}
  #foot{display:contents}
  #pad{display:none}
  #stage{position:absolute;align-self:auto;top:env(safe-area-inset-top);bottom:env(safe-area-inset-bottom);left:calc(max(8px,env(safe-area-inset-left)) + 62px);right:max(8px,env(safe-area-inset-right));
    width:auto!important;height:auto!important;border-radius:0;background:none;box-shadow:none}
  canvas{border-radius:10px;box-shadow:0 0 0 .5px rgba(255,255,255,.17)}
  #bar{position:absolute;top:max(8px,env(safe-area-inset-top));bottom:max(8px,env(safe-area-inset-bottom));left:max(8px,env(safe-area-inset-left));width:54px;
    flex-direction:column;justify-content:flex-start;gap:1px;padding:6px 0;border-radius:27px;overflow-y:auto;touch-action:pan-y;scrollbar-width:none}
  #bar::-webkit-scrollbar{display:none}
  #bar .icon-btn{flex:none;width:40px;height:39px;border-radius:20px}
  .sep{width:22px;height:1px;margin:4px 0}
  #dot{margin:auto 0 9px;min-height:8px}
  #keys{position:absolute;top:max(8px,env(safe-area-inset-top));bottom:max(8px,env(safe-area-inset-bottom));right:max(8px,env(safe-area-inset-right));width:104px;height:auto;
    grid-template-columns:1fr 1fr;align-content:start;gap:6px;padding:7px;border-radius:26px;overflow-y:auto;touch-action:pan-y;scrollbar-width:none}
  #keys.open{display:grid}
  .key{height:40px}
  body.keys-open #stage{right:calc(max(8px,env(safe-area-inset-right)) + 112px)}
  #msg{top:10px}
  #typepill{left:calc(max(8px,env(safe-area-inset-left)) + 72px);bottom:max(14px,env(safe-area-inset-bottom));transform:none}
  @media (max-height:385px){#bar .icon-btn{height:36px}}
  /* typing: the rail keeps only what typing uses (the keyboard button and the modifiers) */
  body.kb-up #bar{padding:3px 0}
  body.kb-up #bar>a,body.kb-up #dock,body.kb-up .sep{display:none}
  body.kb-up #bar .icon-btn{width:36px;height:34px}
  body.kb-up #dot{margin-bottom:6px}
  body.kb-up #keys{gap:3px;padding:5px}
  body.kb-up .key{height:30px;border-radius:11px}
}
</style></head><body>
<div id="app">
<div id="stage"><div id="wrap"><canvas id="screen" width="16" height="10"></canvas></div><svg id="halo" viewBox="0 0 13 20" aria-hidden="true"><path d="M0 0V16.2L3.9 12.6L6.6 18.9L9.3 17.8L6.7 11.7H12Z"/></svg><div id="msg" class="glass">Connecting</div></div>
<div id="pad" class="glass"><i class="groove l" id="groove-l"></i><i class="groove r" id="groove-r"></i></div>
<div id="foot">
<div id="keys" class="glass">${KEYS.map(([k, l]) => `<button class="key" data-key="${k}" aria-label="${k}">${l}</button>`).join('')}</div>
<div id="bar" class="glass">
<a class="icon-btn" href="${backHref.replace(/"/g, '&quot;')}" aria-label="Back">${BACK}</a><span class="sep"></span>
<button class="icon-btn" id="kb" aria-label="Keyboard">${I.keyboard}</button>
${MODS.map(([m, n]) => `<button class="icon-btn" data-mod="${m}" aria-label="${n}">${I[m]}</button>`).join('')}
${dock ? `<span class="sep"></span><button class="icon-btn" id="dock" aria-label="Show the Dock">${I.dock}</button>` : ''}
<button class="icon-btn" id="unzoom" aria-label="Fit the screen" hidden>${I.unzoom}</button>
<span id="dot" role="status" aria-label="Connecting"></span>
</div>
<button id="typepill" aria-label="Type">${ico(KEYBOARD, 26)}</button>
</div>
</div>
<input id="type" inputmode="none" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false">
<script>${TRACKPAD_JS}</script>
<script>
const $ = id => document.getElementById(id);
const canvas = $('screen'), ctx = canvas.getContext('2d'), wrap = $('wrap'), stage = $('stage'), app = $('app'), pad = $('pad');
// The dot always shows the state; the words show only while it is not simply live.
const status = (text, cls) => { $('msg').textContent = text; $('msg').hidden = !text || text === 'Live'; $('dot').className = cls || ''; $('dot').setAttribute('aria-label', text); };
let ws, decoder, configured = false, waitingKey = true, mods = new Set();
let crop = null;   // { x, y, w, h } as fractions of the Mac's screen, or the whole screen
let cursor = null; // where the Mac's pointer was last sent (fractions of its screen), for zooming around it
let drawing = false, pendingJpeg = null;
function drawJpeg(buf) {
  drawing = true;
  createImageBitmap(new Blob([buf.subarray(1)], { type: 'image/jpeg' })).then(bmp => {
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; fit(); }
    ctx.drawImage(bmp, 0, 0); bmp.close();
    if ($('dot').className !== 'live') status('Live', 'live');
  }).catch(() => {}).finally(() => { drawing = false; if (pendingJpeg) { const next = pendingJpeg; pendingJpeg = null; drawJpeg(next); } });
}

function send(obj) {
  if (typeof obj.x === 'number' && typeof obj.y === 'number') { cursor = { x: obj.x, y: obj.y }; halo(); }
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  if (CLICKS.includes(obj.t)) ripple(obj.button === 'right');
}

function makeDecoder(cfg) {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = new VideoDecoder({
    output: frame => {
      // The Mac's real size, not the frame's: H.264 codes whole 16-pixel blocks, so a 982-pixel-tall screen is
      // coded 992 tall, and a decoder that reports that would draw a band of padding along the bottom.
      const fw = Math.min(frame.displayWidth, cfg.width || frame.displayWidth), fh = Math.min(frame.displayHeight, cfg.height || frame.displayHeight);
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

// Copied on the Mac: onto the phone's clipboard at the next tap (a page may only write it during one).
let pendingClip = null;
document.addEventListener('touchend', () => {
  if (pendingClip === null || !navigator.clipboard) return;
  const text = pendingClip; pendingClip = null;
  navigator.clipboard.writeText(text).then(() => {
    const was = [$('msg').textContent, $('dot').className];
    status('Copied', 'live');
    setTimeout(() => { if ($('msg').textContent === 'Copied') status(...was); }, 1500);
  }).catch(() => { pendingClip = text; });
}, true);

let retry = 0, misses = 0;
function connect() {
  clearTimeout(retry);
  status('Connecting', '');
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + ${JSON.stringify(wsPath)} + location.search);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { misses = 0; status('Connecting', ''); };
  ws.onmessage = ev => {
    if (typeof ev.data === 'string') {
      const m = JSON.parse(ev.data);
      if (m.error) status(m.error, 'fail');
      if ('dock' in m && $('dock')) $('dock').classList.toggle('on', m.dock);
      if ('textFocus' in m) textFocus(m.textFocus, m.tapped !== false);
      if (typeof m.clip === 'string') pendingClip = m.clip;
      if (m.cursor && typeof m.cursor.x === 'number' && typeof m.cursor.y === 'number') { cursor = m.cursor; followPointer(); halo(); }   // the Mac's pointer, as fractions of its screen
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
  // Lost: try again. A Mac that no longer answers at all (asleep, or off the network) gets the asleep page, which
  // the service worker shows when a page load cannot reach it (src/asleep.js).
  ws.onclose = async () => {
    configured = false;
    status('Reconnecting', 'fail');
    if (++misses >= 3 && navigator.onLine !== false && navigator.serviceWorker && navigator.serviceWorker.controller) {
      let up = false;
      try { up = (await fetch('/ping', { cache: 'no-store' })).status === 204; } catch {}
      if (!up) { location.reload(); return; }
    }
    retry = setTimeout(connect, 1500);
  };
}

// ---------- view: fit, zoom and pan (local only) ----------
let zoom = 1, panX = 0, panY = 0;
const landscape = window.matchMedia('(orientation:landscape) and (max-height:500px)');
// Upright: the screen spans the width at its own proportions, and the trackpad takes what is left under it, down
// to a usable minimum (while typing, the screen keeps its size and the trackpad goes first). On its side: the
// largest size with the screen's proportions in the space left (measured, since 100vh in iOS landscape counts
// the toolbar and the notch). Run again on every rotation, resize and keyboard change; a zoom survives any of
// these that leave the screen's size alone.
function fit() {
  const ar = canvas.width / canvas.height;
  if (!ar) return;
  if (!landscape.matches) {
    const cs = getComputedStyle(app), gap = parseFloat(cs.rowGap) || 0;
    const room = app.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - $('foot').offsetHeight - gap;   // for the screen and the pad
    const full = app.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const want = full / ar, typing = document.body.classList.contains('kb-up');
    let h = typing ? want : Math.min(want, room - gap - 168);
    pad.hidden = room - gap - h < 72;
    if (pad.hidden) h = Math.min(want, room);
    h = Math.max(40, Math.floor(h));
    stage.style.height = h + 'px'; stage.style.width = Math.min(full, Math.floor(h * ar)) + 'px';   // no black bars: a short screen narrows too
  } else { stage.style.height = stage.style.width = ''; pad.hidden = false; }
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  let cw = w, ch = w / ar;
  if (ch > h) { ch = h; cw = h * ar; }
  const sw = Math.floor(cw) + 'px', sh = Math.floor(ch) + 'px';
  if (canvas.style.width !== sw || canvas.style.height !== sh) { canvas.style.width = sw; canvas.style.height = sh; zoom = 1; panX = panY = 0; }
  applyView();
}
let fitTimer;
const refit = () => { clearTimeout(fitTimer); fitTimer = setTimeout(fit, 120); };   // iOS reports the new size a moment after rotating
window.addEventListener('resize', refit);
window.addEventListener('orientationchange', refit);
// Pin #app to what is visible: the keyboard shrinks the visual viewport and iOS scrolls the page under it.
function syncViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const kb = vv.height < window.innerHeight * 0.8, root = document.documentElement.style;
  document.body.classList.toggle('kb-up', kb);
  // Opened from the Home Screen, iOS can lay the page out shorter than the screen (by the status bar's height) and
  // paint nothing below it: a black strip across the bottom, over where the home indicator sits. Then the
  // controls stop at the page's own bottom with a small margin, since the home indicator is in that strip.
  const full = landscape.matches || innerWidth > innerHeight ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height);
  document.body.classList.toggle('short-vp', !!navigator.standalone && !kb && full - innerHeight > 20);
  let h = vv.height, top = vv.offsetTop;
  if (!kb) { h = Math.max(vv.height, innerHeight); top = 0; }
  root.setProperty('--vh', h + 'px');
  root.setProperty('--vt', top + 'px');
  refit();
}
if (window.visualViewport) { visualViewport.addEventListener('resize', syncViewport); visualViewport.addEventListener('scroll', syncViewport); syncViewport(); }
// The zoomed view stops at its edges (as a zoomed page on iOS does): never panned off into empty space.
function clampPan() {
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  panX = Math.min(0, Math.max(w - w * zoom, panX)); panY = Math.min(0, Math.max(h - h * zoom, panY));
}
function applyView() {
  if (zoom <= 1.001) { zoom = 1; panX = panY = 0; }
  clampPan(); wrap.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
  $('unzoom').hidden = zoom === 1;
  halo();
}
// Zoom to nz keeping the point (px, py) still (in the screen's own unzoomed CSS px), then move by (dx, dy).
function zoomAt(nz, px, py, dx, dy) {
  nz = Math.min(6, Math.max(1, nz));
  panX = px - (px - panX) * (nz / zoom) + (dx || 0); panY = py - (py - panY) * (nz / zoom) + (dy || 0);
  zoom = nz; applyView();
}
// Where the Mac's pointer is on the view (screen px), if it is known and in sight.
function pointerOnView() {
  if (!cursor) return null;
  const u = (crop ? (cursor.x - crop.x) / crop.w : cursor.x) * canvas.offsetWidth, v = (crop ? (cursor.y - crop.y) / crop.h : cursor.y) * canvas.offsetHeight;
  return { px: panX + zoom * u, py: panY + zoom * v };
}
// While zoomed in, the view follows the pointer the trackpad moves: it scrolls once the pointer nears an edge.
function followPointer() {
  const p = zoom > 1 && pointerOnView();
  if (!p) return;
  const ox = wrap.offsetLeft, oy = wrap.offsetTop, sw = stage.clientWidth, sh = stage.clientHeight;
  const mx = Math.min(48, sw * 0.12), my = Math.min(40, sh * 0.12), sx = p.px + ox, sy = p.py + oy;
  const bx = panX, by = panY;
  if (sx < mx) panX += mx - sx; else if (sx > sw - mx) panX -= sx - (sw - mx);
  if (sy < my) panY += my - sy; else if (sy > sh - my) panY -= sy - (sh - my);
  if (panX !== bx || panY !== by) applyView();
}
$('unzoom').onclick = () => { zoom = 1; applyView(); };

// The halo follows the pointer (on the stage, growing a little when zoomed so it still covers the real one), dims
// a little after a moment at rest, and hides when the pointer is out of sight. A click spreads a ring from where it
// lands.
const CLICKS = ['down', 'click', 'press'];
let haloAt = null, restTimer = 0;
function halo() {
  const p = pointerOnView(), el = $('halo');
  if (!p) return;                                       // unknown for a moment after a nudge: the Mac reports it next
  const x = wrap.offsetLeft + p.px, y = wrap.offsetTop + p.py, inside = x >= 0 && y >= 0 && x <= stage.clientWidth && y <= stage.clientHeight;
  if (haloAt && Math.abs(haloAt.x - x) + Math.abs(haloAt.y - y) > 0.5) { el.classList.remove('rest'); clearTimeout(restTimer); restTimer = setTimeout(() => el.classList.add('rest'), 1800); }
  haloAt = { x, y };
  el.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + Math.sqrt(zoom) + ')'; el.classList.toggle('on', inside);
}
function ripple(right) {
  // A trackpad click has no position of its own: it lands where the halo is (the Mac reports it within 33 ms).
  setTimeout(() => {
    if (!haloAt) return;
    const r = document.createElement('div');
    r.className = 'ripple' + (right ? ' right' : ''); r.style.left = haloAt.x + 'px'; r.style.top = haloAt.y + 'px';
    r.addEventListener('animationend', () => r.remove());
    stage.appendChild(r);
  }, cursor ? 0 : 40);
}

function toRemote(cx, cy) {
  const r = canvas.getBoundingClientRect(), nx = (cx - r.left) / r.width, ny = (cy - r.top) / r.height;
  return crop ? { x: crop.x + nx * crop.w, y: crop.y + ny * crop.h } : { x: nx, y: ny };
}
const withMods = o => { if (mods.size) o.mods = [...mods]; return o; };
function clearMods() { if (!mods.size) return; mods.clear(); document.querySelectorAll('[data-mod]').forEach(b => b.classList.remove('on')); }

// ---------- touch on the screen ----------
// One finger: drag = move the cursor under the finger (no click: hover effects and cursor trails follow it),
// tap = click, double tap = double click, tap then touch again and drag = mouse drag (select, move things, as a
// laptop trackpad's tap-and-drag), hold still = right click.
// Two fingers: drag = scroll (with momentum on a flick; while zoomed in it moves the zoomed view first),
// pinch = zoom the view. The kind of gesture is decided once, from its first clear movement.
let one = null, two = null, holdTimer = null, glide = null, lastTap = { t: 0, x: 0, y: 0 };
const scale = () => { const r = canvas.getBoundingClientRect(); return r.width ? canvas.width / r.width : 1; };   // screen px -> remote px
const scrollBy = (dx, dy) => { const k = scale(); send({ t: 'scroll', dx: Math.round(dx * k), dy: Math.round(dy * k) }); };
// A swipe: while zoomed in it moves the zoomed view first, and scrolls the page only past the view's edge.
function swipeBy(dx, dy) {
  if (zoom > 1.01) {
    const bx = panX, by = panY;
    panX += dx; panY += dy; applyView();
    dx -= panX - bx; dy -= panY - by;              // what the view could not take
  }
  if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) scrollBy(dx, dy);
}
function stopGlide() { if (glide) { cancelAnimationFrame(glide); glide = null; } }
function startGlide(vx, vy) {                       // flick: keep scrolling, slowing down, like the phone does
  let last = performance.now();
  const step = now => {
    const dt = now - last; last = now;
    vx *= Math.pow(0.998, dt); vy *= Math.pow(0.998, dt);   // UIScrollView's normal deceleration rate
    if (Math.hypot(vx, vy) < 0.02) { glide = null; return; }
    swipeBy(vx * dt, vy * dt);
    glide = requestAnimationFrame(step);
  };
  glide = requestAnimationFrame(step);
}

stage.addEventListener('touchstart', e => {
  e.preventDefault();
  stopGlide();
  if (e.touches.length === 1) {
    const t = e.touches[0];
    // A touch that follows a tap closely, near it, is the second half of a double tap: dragging it drags.
    const afterTap = Date.now() - lastTap.t < 350 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 40;
    one = { x0: t.clientX, y0: t.clientY, t0: Date.now(), mode: null, afterTap, x: t.clientX, y: t.clientY, tm: performance.now(), vx: 0, vy: 0 };
    holdTimer = setTimeout(() => {
      if (!one || one.mode) return;
      one.mode = 'held';
      const p = toRemote(one.x0, one.y0);
      send({ t: 'move', ...p }); send(withMods({ t: 'down', button: 'right', ...p })); send({ t: 'up', button: 'right', ...p }); clearMods();
      navigator.vibrate && navigator.vibrate(10);
    }, 650);
  } else if (e.touches.length === 2) {
    clearTimeout(holdTimer);
    if (one && one.mode === 'drag') send({ t: 'up', ...toRemote(one.x, one.y) });
    one = null;
    const [a, b] = e.touches;
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2;
    two = { d0: d, cx0: cx, cy0: cy, d, cx, cy, mode: null, tm: performance.now(), vx: 0, vy: 0 };
    send({ t: 'move', ...toRemote(cx, cy) });        // scroll lands on what is between the fingers
  }
}, { passive: false });

stage.addEventListener('touchmove', e => {
  e.preventDefault();
  if (one && e.touches.length === 1) {
    const t = e.touches[0], now = performance.now();
    if (!one.mode && Math.hypot(t.clientX - one.x0, t.clientY - one.y0) > 10) {
      clearTimeout(holdTimer);
      const p = toRemote(one.x0, one.y0);
      send({ t: 'move', ...p });                     // the pointer goes under the finger: scroll and drag act there
      if (one.afterTap) { one.mode = 'drag'; send(withMods({ t: 'down', ...p })); } else one.mode = 'hover';
    }
    if (one.mode === 'hover' || one.mode === 'drag') send({ t: 'move', ...toRemote(t.clientX, t.clientY) });
    one.x = t.clientX; one.y = t.clientY; one.tm = now;
  } else if (two && e.touches.length === 2) {
    const [a, b] = e.touches;
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2;
    if (!two.mode) {
      const spread = Math.abs(d - two.d0), moved = Math.hypot(cx - two.cx0, cy - two.cy0);
      if (spread > 24 && spread > moved) two.mode = 'zoom';
      else if (moved > 8) two.mode = 'scroll';
    }
    if (two.mode === 'zoom') {
      const sr = stage.getBoundingClientRect();      // keep the point under the fingers still
      zoomAt(zoom * (d / two.d), cx - sr.left - wrap.offsetLeft, cy - sr.top - wrap.offsetTop, cx - two.cx, cy - two.cy);
    } else if (two.mode === 'scroll') {
      const now = performance.now(), dt = Math.max(1, now - two.tm), dx = cx - two.cx, dy = cy - two.cy;
      swipeBy(dx, dy);                               // while zoomed in: the zoomed view first, then the page
      two.vx = 0.6 * two.vx + 0.4 * (dx / dt); two.vy = 0.6 * two.vy + 0.4 * (dy / dt); two.tm = now;
    }
    Object.assign(two, { d, cx, cy });
  }
}, { passive: false });

stage.addEventListener('touchend', e => {
  e.preventDefault();
  clearTimeout(holdTimer);
  if (one && !e.touches.length) {
    if (one.mode === 'drag') send({ t: 'up', ...toRemote(one.x, one.y) });
    else if (!one.mode && Date.now() - one.t0 < 650) {
      // The second tap of a double tap lands exactly on the first: the Mac counts a double click only when close.
      const p = one.afterTap ? toRemote(lastTap.x, lastTap.y) : toRemote(one.x0, one.y0);
      send({ t: 'move', ...p }); send(withMods({ t: 'down', ...p })); send({ t: 'up', ...p });   // two in a row: the Mac counts a double click
      lastTap = one.afterTap ? { t: 0, x: 0, y: 0 } : { t: Date.now(), x: one.x0, y: one.y0 };
      primeKeyboard();
    }
    clearMods(); one = null;
  }
  if (two && e.touches.length < 2) {
    if (two.mode === 'scroll' && performance.now() - two.tm < 80) startGlide(two.vx, two.vy);   // flick
    two = null;
  }
}, { passive: false });

// ---------- the trackpad (upright) ----------
// trackpad.js reads the gestures and sends the Mac input; this side adds the held modifier keys to presses
// (one-shot: they clear when the click lets go, as a tap on the screen does), keeps the zoomed view on the
// pointer, and zooms the view on a pinch: around the pointer while it is in sight, else around the middle.
// Its messages move the Mac's pointer relatively (nudge), so where the pointer is stays unknown after one, unless
// a message carries x and y again.
const PRESS = ['click', 'press', 'down', 'key'], LET_GO = ['click', 'release', 'up', 'key'];
function padSend(m) {
  if (!m || typeof m !== 'object') return;
  if (PRESS.includes(m.t) && !m.mods) withMods(m);
  if (m.t === 'nudge') cursor = null;
  send(m);
  if (typeof m.x === 'number') followPointer();
  if (LET_GO.includes(m.t)) clearMods();
}
let pinchAt = null;
if (window.mountTrackpad) window.mountTrackpad(pad, {
  send: padSend,
  onZoom(factor) {
    if (!(factor > 0) || !isFinite(factor)) return;
    stopGlide();
    if (!pinchAt) {
      const p = pointerOnView(), sw = stage.clientWidth, sh = stage.clientHeight, ox = wrap.offsetLeft, oy = wrap.offsetTop;
      pinchAt = p && p.px + ox >= 0 && p.px + ox <= sw && p.py + oy >= 0 && p.py + oy <= sh ? p : { px: sw / 2 - ox, py: sh / 2 - oy };
    }
    zoomAt(zoom * factor, pinchAt.px, pinchAt.py);
  },
  onZoomEnd() { pinchAt = null; if (zoom < 1.06) { zoom = 1; applyView(); } },
  onEdge(side) { $('groove-l').classList.toggle('on', side === 'left'); $('groove-r').classList.toggle('on', side === 'right'); },
});
// A click on the pad may land in a Mac text field: get the keyboard ready inside the touch (see keyboard, below).
pad.addEventListener('touchend', () => primeKeyboard(), true);

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
// field the tap landed on, inputmode switches to text, which brings the keyboard up on the input that already has
// focus. If iOS does not (the screen did not shrink), a Type button appears instead: one tap. A field that took
// focus by itself (a new tab's address bar, a page's search box) only shows the Type button for a few seconds.
// Opened by the Mac, the keyboard also closes when focus leaves the text field; opened by hand (the keyboard
// button), it stays.
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
document.querySelectorAll('#app button').forEach(b => b.addEventListener('pointerdown', e => e.preventDefault()));
function primeKeyboard() { if (!kbOpen) { input.setAttribute('inputmode', 'none'); input.focus({ preventScroll: true }); } }
let pillTimer = 0;
function pill(ms) { clearTimeout(pillTimer); $('typepill').classList.add('show'); if (ms) pillTimer = setTimeout(() => $('typepill').classList.remove('show'), ms); }
function textFocus(on, tapped) {
  if (on && !kbOpen && tapped) {
    input.setAttribute('inputmode', 'text');
    showKeys(true);
    setTimeout(() => { if (kbAuto && !keyboardUp()) pill(0); }, 450);
  } else if (on && !kbOpen) {
    pill(4000);                                        // focus it did not ask for: offer, don't open
  } else if (!on) {
    clearTimeout(pillTimer); $('typepill').classList.remove('show');
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
landscape.addEventListener && landscape.addEventListener('change', refit);
fit();

async function start() {
  if (${JSON.stringify(openPath)}) {
    status('Opening', '');
    try {
      const r = await fetch(${JSON.stringify(openPath)} + location.search, { method: 'POST' });
      const body = await r.json();
      if (!r.ok) return status(body.error || "Couldn't open it", 'fail');
      crop = body.crop;
    } catch { return status('Mac unreachable', 'fail'); }
  }
  connect();
}
if (!('VideoDecoder' in window) && ${JSON.stringify(wsPath)} === '/desktop/ws') status("This browser can't play the stream", 'fail');
else start();
</script></body></html>`;
}
