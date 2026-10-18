// Seer home, styled as a small mission-control panel (after Tonik's Supabase Launch Week 14 work: phosphor
// green line instruments, terminal readouts, corner-bracketed viewports, a tunnel receding into the dark, grain).
// Labels stay lowercase and every element carries information: no taglines, no coaching copy.
// The page renders itself from the status JSON and refreshes every 5 s; ping is timed from the phone.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function homePage(initial, appHead) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#050605"><title>Seer</title>
${appHead}
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&family=VT323&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#030403;--panel:rgba(9,12,9,.86);--line:#1d231d;--line-hi:#2c352c;--ink:#e8ede8;--quiet:#8a948a;--dim:#4d564d;
  --live:#00e676;--glow:rgba(0,230,118,.35);--vignette:rgba(0,0,0,.35);--amber:#ffc53d;--amber-dim:rgba(255,197,61,.12);--red:#ff4d4f;
  --mono:'Geist Mono',ui-monospace,monospace;--pix:'VT323','Geist Mono',monospace;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
[hidden]{display:none!important}
html{background:var(--bg);color-scheme:dark}
body{margin:0;min-height:100vh;color:var(--ink);font:15px/1.45 Geist,-apple-system,system-ui,sans-serif;
  background:transparent}
/* The tunnel (after Supabase LW14): frames shrinking into a dark void, lines to the vanishing point. The frames
   drift forward by one ring every 7 s and loop seamlessly; only a transform moves, so it stays on the GPU. */
.tunnel{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none;
  -webkit-mask:radial-gradient(closest-side at 50% 46%,transparent 0,#000 75%);mask:radial-gradient(closest-side at 50% 46%,transparent 0,#000 75%)}
.tunnel svg{position:absolute;inset:0;width:100%;height:100%}
.tunnel line,.tunnel rect{vector-effect:non-scaling-stroke}
.tunnel .fly{position:absolute;inset:0;transform-origin:50% 46%;animation:fly 7s linear infinite;will-change:transform}
@keyframes fly{to{transform:scale(1.4286)}}
@media (prefers-reduced-motion: reduce){.tunnel .fly{animation:none}}
.tunnel:after{content:'';position:absolute;inset:0;background:radial-gradient(130% 90% at 50% 46%,transparent 45%,rgba(0,0,0,.55) 100%)}
body:after{content:'';position:fixed;inset:0;pointer-events:none;opacity:.07;mix-blend-mode:overlay;
  background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E")}
main{max-width:520px;margin:0 auto;padding:calc(14px + env(safe-area-inset-top)) 16px calc(40px + env(safe-area-inset-bottom))}
a{color:inherit;text-decoration:none}
.mono{font-family:var(--mono)}
/* header */
header{display:flex;align-items:center;gap:10px;padding:6px 2px 18px}
#pupil{transform-box:view-box;transform-origin:512px 512px}
#pupil.spin{animation:spin 1s steps(8) infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){#pupil.spin{animation:none}}
header .word{font:600 17px/1 var(--mono);letter-spacing:-.02em}
header .clock{margin-left:auto;font:400 13px var(--mono);color:var(--quiet);font-variant-numeric:tabular-nums}
.link{display:inline-flex;align-items:center;gap:6px;font:400 12px var(--mono);color:var(--quiet)}
.pip{width:7px;height:7px;border-radius:50%;background:var(--dim)}
.pip.on{background:var(--live);box-shadow:0 0 8px var(--glow)}.pip.amber{background:var(--amber)}.pip.red{background:var(--red)}
/* bracketed viewport: corner ticks, like a HUD frame */
.frame{position:relative;padding:18px 18px 16px;margin-bottom:12px;background:linear-gradient(180deg,rgba(0,230,118,.04),transparent 60%),var(--panel);border:1px solid var(--line)}
.frame:before,.frame:after,.frame>.c1,.frame>.c2{content:'';position:absolute;width:12px;height:12px;border:1.5px solid var(--live)}
.frame:before{left:-1px;top:-1px;border-right:0;border-bottom:0}.frame:after{right:-1px;top:-1px;border-left:0;border-bottom:0}
.frame>.c1{left:-1px;bottom:-1px;border-right:0;border-top:0}.frame>.c2{right:-1px;bottom:-1px;border-left:0;border-top:0}
.k{font:400 12px var(--mono);color:var(--quiet)}
.state{font:400 44px/1 var(--pix);letter-spacing:.02em;margin:8px 0 6px;color:var(--live);text-shadow:0 0 14px var(--glow)}
.state.off{color:var(--quiet);text-shadow:none}
.why{font-size:14px;color:var(--ink)}
.timer{display:flex;align-items:baseline;justify-content:space-between;margin-top:14px;padding-top:12px;border-top:1px dashed var(--line-hi)}
.timer .t{font:400 30px/1 var(--pix);font-variant-numeric:tabular-nums;letter-spacing:.04em}
.ruler{height:9px;margin-top:10px;background:repeating-linear-gradient(90deg,var(--line-hi) 0 1px,transparent 1px 8px);position:relative}
.ruler i{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,var(--live),transparent);opacity:.55}
/* instruments */
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
.inst{background:var(--panel);border:1px solid var(--line);padding:12px 13px;min-height:118px;display:flex;flex-direction:column}
.inst .v{font:400 34px/1 var(--pix);margin-top:10px;font-variant-numeric:tabular-nums}
.inst .s{font:400 12px var(--mono);color:var(--quiet);margin-top:auto;padding-top:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.green{color:var(--live);text-shadow:0 0 12px var(--glow)}.amber{color:var(--amber)}.red{color:var(--red)}
.segs{display:grid;grid-template-columns:repeat(10,1fr);gap:3px;margin-top:10px}
.segs i{height:10px;background:var(--line-hi)}.segs i.on{background:var(--live);box-shadow:0 0 6px var(--glow)}.segs.low i.on{background:var(--red);box-shadow:none}
svg.scope{width:100%;height:30px;margin-top:8px;overflow:visible}
svg.scope .base{stroke:var(--line-hi);stroke-dasharray:2 4}
svg.scope polyline{fill:none;stroke:var(--live);stroke-width:1.5;filter:drop-shadow(0 0 3px var(--glow))}
.icon{display:flex;align-items:center;gap:10px;margin-top:10px}
.icon .v{margin-top:0}
.radar path{fill:none;stroke:var(--line-hi);stroke-width:2;stroke-linecap:round}.radar path.on{stroke:var(--live);filter:drop-shadow(0 0 3px var(--glow))}
.radar circle{fill:var(--live)}
.lap path{fill:none;stroke:var(--ink);stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}.lap .scr{stroke:var(--live)}
/* stay awake ruler */
.stay{background:var(--panel);border:1px solid var(--line);padding:13px;margin-bottom:12px}
.stay .row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.stay .amt{font:400 26px/1 var(--pix);color:var(--ink)}
.stay input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:30px;margin:10px 0 2px;background:transparent}
.stay input[type=range]::-webkit-slider-runnable-track{height:12px;background:repeating-linear-gradient(90deg,var(--line-hi) 0 1px,transparent 1px 7px)}
.stay input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:4px;height:26px;margin-top:-7px;background:var(--live);box-shadow:0 0 10px var(--glow)}
.stay .ticks{display:flex;justify-content:space-between;font:400 10px var(--mono);color:var(--dim)}
.btn{height:36px;padding:0 14px;border:1px solid var(--live);background:transparent;color:var(--live);font:500 13px var(--mono);cursor:pointer}
.btn.ghost{border-color:var(--line-hi);color:var(--ink)}
/* help: amber note, only when something needs the owner */
.help{display:flex;gap:10px;align-items:flex-start;padding:12px 13px;margin-bottom:10px;border:1px solid var(--amber);background:var(--amber-dim);color:var(--ink);font-size:14px}
.help b{font:600 12px var(--mono);color:var(--amber);flex:none;margin-top:2px}
/* projects: boarding passes */
.sect{display:flex;align-items:center;gap:10px;margin:22px 2px 10px}.sect .k{flex:none}.sect hr{flex:1;border:0;border-top:1px solid var(--line-hi);margin:0}
.proj{display:flex;align-items:center;gap:12px;margin-bottom:8px;padding:12px 14px;background:var(--panel);border:1px solid var(--line)}
.proj:active{border-color:var(--line-hi)}
.proj .main{flex:1;min-width:0}
.proj .nm{font:500 16px/1.2 var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.proj .meta{margin-top:4px;font:400 12px var(--mono);color:var(--quiet)}
.proj .go{color:var(--dim);font:400 18px var(--mono)}
.empty{font:400 13px var(--mono);color:var(--quiet);padding:8px 2px}
</style></head><body>
<div class="tunnel" aria-hidden="true"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><g fill="none" stroke="#00e676" stroke-opacity=".20" stroke-width="1" vector-effect="non-scaling-stroke"><line x1="0" y1="0" x2="50" y2="46"/><line x1="25" y1="0" x2="50" y2="46"/><line x1="50" y1="0" x2="50" y2="46"/><line x1="75" y1="0" x2="50" y2="46"/><line x1="100" y1="0" x2="50" y2="46"/><line x1="100" y1="25" x2="50" y2="46"/><line x1="100" y1="50" x2="50" y2="46"/><line x1="100" y1="75" x2="50" y2="46"/><line x1="100" y1="100" x2="50" y2="46"/><line x1="75" y1="100" x2="50" y2="46"/><line x1="50" y1="100" x2="50" y2="46"/><line x1="25" y1="100" x2="50" y2="46"/><line x1="0" y1="100" x2="50" y2="46"/><line x1="0" y1="75" x2="50" y2="46"/><line x1="0" y1="50" x2="50" y2="46"/><line x1="0" y1="25" x2="50" y2="46"/></g></svg><div class="fly"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><g fill="none" stroke="#00e676" stroke-opacity=".30" stroke-width="1" vector-effect="non-scaling-stroke"><rect x="0.00" y="-3.68" width="100.00" height="108.00"/><rect x="15.00" y="11.22" width="70.00" height="75.60"/><rect x="25.50" y="21.66" width="49.00" height="52.92"/><rect x="32.85" y="28.96" width="34.30" height="37.04"/><rect x="38.00" y="34.07" width="24.01" height="25.93"/><rect x="41.60" y="37.65" width="16.81" height="18.15"/><rect x="44.12" y="40.16" width="11.76" height="12.71"/><rect x="45.88" y="41.91" width="8.24" height="8.89"/><rect x="47.12" y="43.14" width="5.76" height="6.23"/><rect x="47.98" y="44.00" width="4.04" height="4.36"/></g></svg></div></div>
<main>
<header>
  <svg class="mark" width="32" height="23" viewBox="120 232 784 560" aria-hidden="true"><path d="M150 512C260 322 386 262 512 262s252 60 362 250c-110 190-236 250-362 250S260 702 150 512Z" fill="none" stroke="currentColor" stroke-width="48" stroke-linejoin="round"/><g id="pupil" stroke="var(--live)" stroke-width="50" stroke-linecap="round"><line x1="512" y1="442" x2="512" y2="342" stroke-opacity="1.00"/><line x1="561" y1="463" x2="632" y2="392" stroke-opacity="0.25"/><line x1="582" y1="512" x2="682" y2="512" stroke-opacity="0.35"/><line x1="561" y1="561" x2="632" y2="632" stroke-opacity="0.46"/><line x1="512" y1="582" x2="512" y2="682" stroke-opacity="0.57"/><line x1="463" y1="561" x2="392" y2="632" stroke-opacity="0.68"/><line x1="442" y1="512" x2="342" y2="512" stroke-opacity="0.79"/><line x1="463" y1="463" x2="392" y2="392" stroke-opacity="0.89"/></g></svg>
  <span class="word">seer</span>
  <span class="clock" id="clock"></span>
</header>

<section class="frame"><span class="c1"></span><span class="c2"></span>
  <div class="k" style="display:flex;justify-content:space-between"><span>mac</span><span class="link"><span class="pip" id="link-pip"></span><span id="link">linking</span></span></div>
  <div class="state" id="state">—</div>
  <div class="why" id="why"></div>
  <div class="timer" id="timer" hidden><span class="k" id="timer-k"></span><span class="t" id="timer-t"></span></div>
  <div class="ruler" id="ruler" hidden><i id="ruler-i"></i></div>
</section>

<div id="help"></div>

<div class="grid">
  <div class="inst"><span class="k">battery</span><div class="v" id="batt">—</div><div class="segs" id="segs"></div><div class="s" id="batt-s"></div></div>
  <div class="inst"><span class="k">ping</span><div class="v" id="ping">—</div><svg class="scope" viewBox="0 0 100 30" preserveAspectRatio="none"><line class="base" x1="0" y1="29" x2="100" y2="29"/><polyline id="scope" points=""/></svg><div class="s">phone to mac</div></div>
  <div class="inst"><span class="k">network</span><div class="icon"><svg class="radar" width="30" height="24" viewBox="0 0 30 24" aria-hidden="true"><path id="r3" d="M3 11a17 17 0 0 1 24 0"/><path id="r2" d="M7.5 15.5a10.6 10.6 0 0 1 15 0"/><path id="r1" d="M11.5 19.5a5 5 0 0 1 7 0"/><circle cx="15" cy="22" r="1.6"/></svg><div class="v" id="net">—</div></div><div class="s" id="net-s"></div></div>
  <div class="inst"><span class="k">lid</span><div class="icon"><svg class="lap" width="36" height="24" viewBox="0 0 36 24" aria-hidden="true"><path id="lap-screen" class="scr" d="M7 3h22v14H7z"/><path d="M2 20h32l-2 2H4z"/></svg><div class="v" id="lid">—</div></div><div class="s" id="lid-s"></div></div>
</div>

<section class="stay" id="stay">
  <div class="row"><span class="k">stay awake</span><span class="amt" id="stay-amt">1 h</span></div>
  <input type="range" id="stay-r" min="0" max="11" value="4" aria-label="How long to stay awake">
  <div class="ticks"><span>10m</span><span>1h</span><span>3h</span><span>12h</span></div>
  <div class="row" style="margin-top:12px"><span class="k" id="stay-now"></span><span><button class="btn ghost" id="stay-x" hidden>cancel</button> <button class="btn" id="stay-b">stay awake</button></span></div>
</section>

<div class="sect"><span class="k">projects</span><hr></div>
<div id="projects"></div>
</main>
<script>
const $ = id => document.getElementById(id);
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clockOf = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(ss).padStart(2, '0'); };
let st = ${initial}, pings = [];

function tick() {                                       // the clock and the countdown, every second
  $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const a = st.awake, now = Date.now();
  const until = a.stayUntil || (a.awake && !a.pluggedIn && !st.agentsBusy && a.reachableUntil > now ? a.reachableUntil : 0);
  $('timer').hidden = $('ruler').hidden = !until;
  if (until) {
    $('timer-k').textContent = a.stayUntil ? 'staying awake' : 'sleeps in';
    $('timer-t').textContent = 'T-' + mmss(until - now);
    const span = a.stayUntil ? (a.stayUntil - (st.stayFrom || now)) : 15 * 60_000;
    $('ruler-i').style.width = Math.max(0, Math.min(100, (until - now) / span * 100)) + '%';
  }
}

function render() {
  const a = st.awake, b = st.battery, n = st.network, h = st.hotspot;
  $('pupil').classList.toggle('spin', !!st.agentsBusy);           // the logo's pupil turns while an agent works
  $('state').textContent = a.awake ? (a.headless ? 'headless' : 'awake') : 'will sleep';
  $('state').className = 'state' + (a.awake ? '' : ' off');
  $('why').textContent = a.why + (st.agentsBusy && !/agent/.test(a.why) ? ', ' + st.agentsBusy + ' agent' + (st.agentsBusy > 1 ? 's' : '') + ' working' : '') + (a.headless ? ', saving power' : '');
  // battery
  const low = !b.pluggedIn && b.pct <= 20;
  $('batt').textContent = b.pct + '%'; $('batt').className = 'v ' + (low ? 'red' : b.pluggedIn ? 'green' : '');
  $('segs').className = 'segs' + (low ? ' low' : '');
  $('segs').innerHTML = Array.from({ length: 10 }, (_, i) => '<i class="' + (i < Math.round(b.pct / 10) ? 'on' : '') + '"></i>').join('');
  $('batt-s').textContent = b.pluggedIn ? (b.state === 'charging' ? 'charging' : 'plugged in') : (b.remaining ? b.remaining + ' left' : 'on battery') + (b.drainPerHour != null ? ', ' + b.drainPerHour + '%/h' : '');
  // network
  const lit = { strong: 3, good: 2, weak: 1, poor: 0 }[n.signal] ?? (n.kind === 'hotspot' || n.kind === 'wired' ? 3 : 0);
  ['r1', 'r2', 'r3'].forEach((r, i) => $(r).classList.toggle('on', n.kind !== 'offline' && i < lit));
  $('net').textContent = { wifi: 'wi-fi', hotspot: 'hotspot', wired: 'wired', offline: 'offline' }[n.kind] || n.kind;
  $('net').className = 'v ' + (n.kind === 'offline' ? 'red' : n.kind === 'hotspot' ? 'amber' : '');
  $('net-s').textContent = n.kind === 'offline'
    ? (h.joining ? 'joining ' + (h.name || 'hotspot') : h.offlineFor ? 'offline ' + h.offlineFor + ' s' + (h.lastJoin ? ', ' + h.lastJoin.result : '') : 'no internet')
    : n.kind === 'hotspot' ? (h.name || 'phone') + (n.internetMs != null ? ', ' + n.internetMs + ' ms' : '')
    : [n.ssid, n.txRate ? n.txRate + ' Mbps' : '', n.internetMs != null ? n.internetMs + ' ms' : ''].filter(Boolean).join(', ');
  // lid
  $('lid').textContent = st.lid === 'unknown' ? '—' : st.lid;
  $('lap-screen').setAttribute('d', st.lid === 'closed' ? 'M4 18.5h28' : 'M7 3h22v14H7z');
  $('lid-s').textContent = st.lid === 'closed' ? (a.awake ? 'awake anyway' : 'will sleep') : 'in use';
  // stay awake
  $('stay-x').hidden = !a.stayUntil;
  $('stay-now').textContent = a.stayUntil ? 'until ' + clockOf(a.stayUntil) : '';
  // help
  $('help').innerHTML = st.help.map(t => '<div class="help"><b>!</b><span>' + esc(t) + '</span></div>').join('');
  // projects
  const rows = (st.desktop ? [{ name: 'desktop', href: '/desktop', state: 'streamed', where: 'screen' }] : []).concat(st.projects);
  $('projects').innerHTML = rows.length ? rows.map(p => {
    const live = p.state === 'running' || p.state === 'on demand' || p.state === 'streamed';
    return '<a class="proj" href="' + esc(p.href) + '"><span class="pip ' + (live ? 'on' : p.state === 'failed' ? 'red' : '') + '"></span>'
      + '<div class="main"><div class="nm">' + esc(p.name) + '</div><div class="meta">' + esc(p.where === 'cloud' ? 'cloud' : p.where === 'screen' ? 'mac screen' : 'this mac') + ' · ' + esc(p.state) + '</div></div>'
      + '<span class="go">→</span></a>';
  }).join('') : '<p class="empty">no previews running</p>';
  tick();
}

function scope(ms) {                                   // the last 30 pings as a trace, higher is slower
  pings.push(ms); if (pings.length > 30) pings.shift();
  const max = Math.max(150, ...pings);
  $('scope').setAttribute('points', pings.map((p, i) => (i / 29 * 100).toFixed(1) + ',' + (29 - Math.min(1, p / max) * 26).toFixed(1)).join(' '));
}
async function refresh() {
  try {
    const t0 = performance.now();
    await fetch('/ping', { cache: 'no-store' });
    const ms = Math.round(performance.now() - t0);
    $('ping').textContent = ms + 'ms'; $('ping').className = 'v ' + (ms < 120 ? 'green' : ms < 300 ? 'amber' : 'red');
    $('link').textContent = 'linked'; $('link-pip').className = 'pip on';
    scope(ms);
    st = await (await fetch('/status.json', { cache: 'no-store' })).json();
    render();
  } catch { $('link').textContent = 'lost'; $('link-pip').className = 'pip red'; $('ping').textContent = '—'; }
}

// stay awake: 10 min to 12 h, finer at the short end
const STEPS = [10, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720];
const span = m => m < 60 ? m + ' min' : (m % 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' m' : m / 60 + ' h');
$('stay-r').oninput = () => { $('stay-amt').textContent = span(STEPS[$('stay-r').value]); };
async function setStay(minutes) {
  try { await fetch('/awake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minutes }) }); } catch {}
  st.stayFrom = Date.now(); refresh();
}
$('stay-b').onclick = () => setStay(STEPS[$('stay-r').value]);
$('stay-x').onclick = () => setStay(0);

render(); refresh();
setInterval(tick, 1000);
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
</script></body></html>`;
}
export { esc };
