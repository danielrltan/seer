// Seer home: the Mac's state, its instruments, stay awake, and the projects, in dark Liquid Glass (glass.js).
// Labels stay lowercase and every element carries information: no taglines, no coaching copy.
// The page renders itself from the status JSON and refreshes every 5 s; ping is timed from the phone.
import { GLASS_CSS, MARK, BACKDROP, GEAR } from './glass.js';

export function homePage(initial, appHead) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#020403"><title>Seer</title>
${appHead}
<style>${GLASS_CSS}
.hero{padding:18px 20px 20px;margin-bottom:12px;border-radius:30px}
.hero .top{display:flex;justify-content:space-between;align-items:center}
.state{font:700 46px/1 var(--round);letter-spacing:-.025em;margin:14px 0 6px;color:var(--ink2)}
.state.live{color:var(--live);text-shadow:0 0 28px var(--glow)}
.state.use{color:#fff}
.why{font-size:15px;color:var(--ink2)}
.count{display:flex;align-items:center;gap:12px;margin-top:16px}
.sleep-row{display:flex;justify-content:flex-end;margin-top:16px}
#sleep-b.armed{background:rgba(255,90,95,.2);color:#ffd9da;box-shadow:inset 0 1px 0 rgba(255,200,200,.25),0 0 0 .5px rgba(255,90,95,.6)}
.count .t{font:700 20px/1 var(--round);font-variant-numeric:tabular-nums;min-width:70px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
.tile{padding:14px 16px 13px;border-radius:24px;min-height:128px;display:flex;flex-direction:column}
.tile .v{font:700 30px/1.05 var(--round);letter-spacing:-.02em;margin-top:10px;font-variant-numeric:tabular-nums}
.tile .s{font:500 12px var(--mono);color:var(--ink3);margin-top:auto;padding-top:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.green{color:var(--live)!important;text-shadow:0 0 18px var(--glow)}.amber{color:var(--amber)!important}.red{color:var(--red)!important}
svg.scope{width:100%;height:28px;margin-top:10px;overflow:visible}
svg.scope polyline{fill:none;stroke:var(--live);stroke-width:1.8;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke;filter:drop-shadow(0 0 4px var(--glow))}
.icon{display:flex;align-items:center;gap:10px;margin-top:10px}.icon .v{margin-top:0}
.wifi path{fill:none;stroke:rgba(255,255,255,.18);stroke-width:2.4;stroke-linecap:round}.wifi path.on{stroke:#fff}.wifi circle{fill:#fff}
.lap path{fill:none;stroke:#fff;stroke-width:1.6;stroke-linejoin:round;stroke-linecap:round}
.stay{padding:16px 18px 16px;border-radius:26px;margin-bottom:12px}
.stay .row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.stay .amt{font:700 24px/1 var(--round)}
.help{display:flex;gap:12px;align-items:flex-start;padding:14px 16px;margin-bottom:12px;border-radius:20px;font-size:14.5px}
.help .dot{flex:none;width:8px;height:8px;margin-top:6px;border-radius:50%;background:var(--amber);box-shadow:0 0 12px var(--amber)}
.sect{font:600 13px var(--sans);color:var(--ink3);margin:22px 8px 9px}
.list{border-radius:24px;overflow:hidden}
.proj{display:flex;align-items:center;gap:13px;padding:14px 16px;position:relative}
.proj+.proj:before{content:'';position:absolute;left:37px;right:0;top:0;border-top:1px solid var(--hair)}
.proj:active{background:rgba(255,255,255,.06)}
.proj .main{flex:1;min-width:0}
.proj .nm{font:600 16.5px/1.25 var(--sans);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.proj .meta{margin-top:2px;font:500 12px var(--mono);color:var(--ink3)}
.proj .go{width:8px;height:8px;border-right:2px solid var(--ink3);border-top:2px solid var(--ink3);transform:rotate(45deg);margin-right:4px}
.empty{font:500 13px var(--mono);color:var(--ink3);padding:16px;margin:0}
</style></head><body>
${BACKDROP}
<main>
<header class="glass bar">
  ${MARK}
  <span class="word">seer</span>
  <span class="clock" id="clock"></span>
  <a class="icon-btn" href="/settings" aria-label="Settings">${GEAR}</a>
</header>

<section class="glass hero">
  <div class="top"><span class="k">mac</span><span class="chip"><span class="pip" id="link-pip"></span><span id="link">linking</span></span></div>
  <div class="state" id="state">—</div>
  <div class="why" id="why"></div>
  <div class="count" id="count" hidden><span class="t" id="count-t"></span><div class="track"><i id="count-i"></i></div><span class="k" id="count-k"></span></div>
  <div class="sleep-row"><button class="btn" id="sleep-b">Sleep now</button></div>
</section>

<div id="help"></div>

<div class="grid">
  <div class="glass tile"><span class="k">battery</span><div class="v" id="batt">—</div><div class="track" style="flex:none;margin-top:12px"><i id="batt-i"></i></div><div class="s" id="batt-s"></div></div>
  <div class="glass tile"><span class="k">ping</span><div class="v" id="ping">—</div><svg class="scope" viewBox="0 0 100 30" preserveAspectRatio="none"><polyline id="scope" points=""/></svg><div class="s">phone to mac</div></div>
  <div class="glass tile"><span class="k">network</span><div class="icon"><svg class="wifi" width="26" height="21" viewBox="0 0 30 24" aria-hidden="true"><path id="r3" d="M3 11a17 17 0 0 1 24 0"/><path id="r2" d="M7.5 15.5a10.6 10.6 0 0 1 15 0"/><path id="r1" d="M11.5 19.5a5 5 0 0 1 7 0"/><circle cx="15" cy="22" r="1.7"/></svg><div class="v" id="net">—</div></div><div class="s" id="net-s"></div></div>
  <div class="glass tile"><span class="k">lid</span><div class="icon"><svg class="lap" width="32" height="22" viewBox="0 0 36 24" aria-hidden="true"><path id="lap-screen" d="M7 3h22v14H7z"/><path d="M2 20h32l-2 2H4z"/></svg><div class="v" id="lid">—</div></div><div class="s" id="lid-s"></div></div>
</div>

<section class="glass stay">
  <div class="row"><span class="k">stay awake</span><span class="amt" id="stay-amt">1 h</span></div>
  <input class="slider" type="range" id="stay-r" min="0" max="11" value="4" aria-label="How long to stay awake">
  <div class="row"><span class="k" id="stay-now"></span><span class="btns"><button class="btn" id="stay-x" hidden>Cancel</button><button class="btn tint" id="stay-b">Stay awake</button></span></div>
</section>

<div class="sect">projects</div>
<div class="glass list" id="projects"></div>
</main>
<script>
const $ = id => document.getElementById(id);
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clockOf = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0'); };
let st = ${initial}, pings = [];

function tick() {                                       // the clock and the countdown, every second
  $('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const a = st.awake, now = Date.now();
  const until = a.stayUntil || (a.awake && !st.agentsBusy && a.reachableUntil > now ? a.reachableUntil : 0);
  $('count').hidden = !until;
  if (until) {
    $('count-k').textContent = a.stayUntil ? 'awake' : 'then sleeps';
    $('count-t').textContent = mmss(until - now);
    const span = a.stayUntil ? Math.max(a.stayUntil - (st.stayFrom || now), until - now) : 15 * 60_000;
    $('count-i').style.width = Math.max(2, Math.min(100, (until - now) / span * 100)) + '%';
  }
}

function render() {
  const a = st.awake, b = st.battery, n = st.network, h = st.hotspot;
  $('pupil').classList.toggle('spin', !!st.agentsBusy);           // the logo's pupil turns while an agent works
  $('state').textContent = a.awake ? (a.headless ? 'Headless' : 'Awake') : a.inUse ? 'In use' : st.lid === 'closed' ? 'Will sleep' : 'Normal sleep';
  $('state').className = 'state' + (a.awake ? ' live' : a.inUse ? ' use' : '');
  $('why').textContent = a.why + (st.agentsBusy && !/agent/.test(a.why) ? ', ' + st.agentsBusy + ' agent' + (st.agentsBusy > 1 ? 's' : '') + ' working' : '') + (a.headless ? ', saving power' : '');
  // battery
  const low = !b.pluggedIn && b.pct <= 20;
  $('batt').textContent = b.pct + '%'; $('batt').className = 'v ' + (low ? 'red' : b.pluggedIn ? 'green' : '');
  $('batt-i').style.width = b.pct + '%'; $('batt-i').className = low ? 'red' : '';
  $('batt-s').textContent = b.pluggedIn ? (b.state === 'charging' ? 'charging' : 'plugged in') : (b.remaining ? b.remaining + ' left' : 'on battery') + (b.drainPerHour != null ? ', ' + b.drainPerHour + '%/h' : '');
  // network
  const lit = { strong: 3, good: 2, weak: 1, poor: 0 }[n.signal] ?? (n.kind === 'hotspot' || n.kind === 'wired' ? 3 : 0);
  ['r1', 'r2', 'r3'].forEach((r, i) => $(r).classList.toggle('on', n.kind !== 'offline' && i < lit));
  $('net').textContent = { wifi: 'Wi-Fi', hotspot: 'Hotspot', wired: 'Wired', offline: 'Offline' }[n.kind] || n.kind;
  $('net').className = 'v ' + (n.kind === 'offline' ? 'red' : n.kind === 'hotspot' ? 'amber' : '');
  $('net-s').textContent = n.kind === 'offline'
    ? (h.joining ? 'joining ' + (h.name || 'hotspot') : h.offlineFor ? 'offline ' + h.offlineFor + ' s' + (h.lastJoin ? ', ' + h.lastJoin.result : '') : 'no internet')
    : n.kind === 'hotspot' ? (h.name || 'phone') + (n.internetMs != null ? ', ' + n.internetMs + ' ms' : '')
    : [n.ssid, n.txRate ? n.txRate + ' Mbps' : '', n.internetMs != null ? n.internetMs + ' ms' : ''].filter(Boolean).join(', ');
  // lid
  $('lid').textContent = st.lid === 'unknown' ? '—' : st.lid === 'closed' ? 'Closed' : 'Open';
  $('lap-screen').setAttribute('d', st.lid === 'closed' ? 'M4 18.5h28' : 'M7 3h22v14H7z');
  $('lid-s').textContent = st.lid === 'closed' ? (a.awake ? 'awake anyway' : a.inUse ? 'external display' : 'will sleep') : a.inUse ? 'in use' : 'idle';
  // stay awake
  $('stay-x').hidden = !a.stayUntil;
  $('stay-now').textContent = a.stayUntil ? 'until ' + clockOf(a.stayUntil) : '';
  // help
  $('help').innerHTML = st.help.map(t => '<div class="glass help"><i class="dot"></i><span>' + esc(t) + '</span></div>').join('');
  // projects
  const rows = (st.desktop ? [{ name: 'Desktop', href: '/desktop', state: 'streamed', where: 'screen' }] : []).concat(st.projects);
  $('projects').innerHTML = rows.length ? rows.map(p => {
    const live = p.state === 'running' || p.state === 'on demand' || p.state === 'streamed';
    return '<a class="proj" href="' + esc(p.href) + '"><span class="pip ' + (live ? 'on' : p.state === 'failed' ? 'red' : '') + '"></span>'
      + '<div class="main"><div class="nm">' + esc(p.name) + '</div><div class="meta">' + esc(p.where === 'cloud' ? 'cloud' : p.where === 'screen' ? 'mac screen' : 'this mac') + ' · ' + esc(p.state) + '</div></div>'
      + '<span class="go"></span></a>';
  }).join('') : '<p class="empty">no previews running</p>';
  tick();
}

function scope(ms) {                                   // the last 30 pings as a trace, higher is slower
  pings.push(ms); if (pings.length > 30) pings.shift();
  const max = Math.max(150, ...pings);
  $('scope').setAttribute('points', pings.map((p, i) => (i / 29 * 100).toFixed(1) + ',' + (28 - Math.min(1, p / max) * 26).toFixed(1)).join(' '));
}
async function refresh() {
  try {
    const t0 = performance.now();
    await fetch('/ping', { cache: 'no-store' });
    const ms = Math.round(performance.now() - t0);
    $('ping').innerHTML = ms + '<small> ms</small>'; $('ping').className = 'v ' + (ms < 120 ? 'green' : ms < 300 ? 'amber' : 'red');
    $('link').textContent = 'linked'; $('link-pip').className = 'pip on';
    scope(ms);
    st = await (await fetch('/status.json', { cache: 'no-store' })).json();
    render();
  } catch { $('link').textContent = 'lost'; $('link-pip').className = 'pip red'; $('ping').textContent = '—'; }
}

// stay awake: 10 min to 12 h, finer at the short end
const STEPS = [10, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720];
const span = m => m < 60 ? m + ' min' : (m % 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' m' : m / 60 + ' h');
const paint = () => { const r = $('stay-r'); r.style.setProperty('--p', (r.value / r.max * 100) + '%'); $('stay-amt').textContent = span(STEPS[r.value]); };
$('stay-r').oninput = paint; paint();
async function setStay(minutes) {
  try { await fetch('/awake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minutes }) }); } catch {}
  st.stayFrom = Date.now(); refresh();
}
$('stay-b').onclick = () => setStay(STEPS[$('stay-r').value]);
$('stay-x').onclick = () => setStay(0);

// Sleep now: a sleeping Mac cannot be woken from here, so the first tap arms it and a second within 3 s sends it.
let armed = 0;
$('sleep-b').onclick = async () => {
  const b = $('sleep-b');
  if (Date.now() > armed) {
    armed = Date.now() + 3000; b.textContent = 'Tap again to sleep'; b.classList.add('armed');
    setTimeout(() => { if (Date.now() > armed) { b.textContent = 'Sleep now'; b.classList.remove('armed'); } }, 3100);
    return;
  }
  armed = 0; b.classList.remove('armed'); b.disabled = true; b.textContent = 'Going to sleep';
  try {
    const r = await fetch('/sleep', { method: 'POST' });
    if (!r.ok) throw new Error();
    $('state').textContent = 'Asleep'; $('state').className = 'state'; $('why').textContent = 'asleep since ' + clockOf(Date.now()); $('count').hidden = true;
  } catch { b.disabled = false; b.textContent = 'Sleep now'; }
};

render(); refresh();
setInterval(tick, 1000);
setInterval(() => { if (!document.hidden && !$('sleep-b').disabled) refresh(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
</script></body></html>`;
}
