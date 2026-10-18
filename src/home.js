// Seer home, in three tabs under one glass tab bar: Home (the Mac's state, its instruments, stay awake), Monitors
// (the Mac's screen and the projects) and Agents (Claude Code sessions). Dark Liquid Glass (glass.js).
// Labels stay lowercase and every element carries information: no taglines, no coaching copy.
// The page renders itself from the status JSON and refreshes every 5 s; ping is timed from the phone.
import fs from 'node:fs';
import { GLASS_CSS, MARK, BACKDROP, GEAR, BACK, BTN } from './glass.js';

const CLAUDE_D = fs.readFileSync(new URL('../assets/agents/claude.svg', import.meta.url), 'utf8').match(/<path d="([^"]+)"/)[1];

export function homePage(initial, appHead) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#020403"><title>Seer</title>
${appHead}
<style>${GLASS_CSS}
.hero{padding:18px 20px 20px;margin-bottom:12px;border-radius:30px}
.hero .top{display:flex;justify-content:space-between;align-items:center}
.state{font:750 44px/1 var(--round);letter-spacing:-.035em;margin:12px 0 5px;color:var(--ink2)}
.state.live{color:var(--live);text-shadow:0 0 28px var(--glow)}
.state.use{color:#fff}
.why{font-size:15px;color:var(--ink2)}
.count{display:flex;align-items:center;gap:12px;margin-top:16px}
.hero .srow{display:flex;align-items:center;gap:13px;margin-top:16px}
.hero .sw{flex:1;min-width:0}
.hero .srow .state{margin:0;font-size:31px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hero .srow .why{margin-top:5px;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* the Mac's state as the eye: open, its pupil turning while an agent works, shut while the Mac sleeps */
.hero .eye.big{flex:none;width:50px;height:37px}
.hero #sleep-b{flex:none;align-self:center}
#sleep-b.armed{background:rgba(255,90,95,.2);color:#ffd9da;box-shadow:inset 0 1px 0 rgba(255,200,200,.25),0 0 0 .5px rgba(255,90,95,.6)}
.count .t{font:700 20px/1 var(--round);font-variant-numeric:tabular-nums;min-width:70px}
/* stats, by weight: battery first and widest, with the biggest number; then ping, network and lid as three
   equal smaller tiles; their labels and subs quiet, their values the thing to read */
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}
.tile{padding:13px 13px 12px;border-radius:22px;min-height:108px;display:flex;flex-direction:column;min-width:0}
.tile .v{font:700 21px/1.1 var(--round);letter-spacing:-.02em;margin-top:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.tile .th .ti{width:24px;height:16px}
.tile.wide{padding:15px 18px 17px;border-radius:24px;min-height:150px}
.tile.wide .th .ti{width:30px;height:20px}
.tile.wide .brow{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-top:auto}
.tile.wide .v{font-size:46px;margin-top:0;letter-spacing:-.035em}
.tile.wide .s{margin:0;padding:0}
.tile.wide .track{flex:none;margin-top:12px}
/* the last 6 hours of charge, behind the number: a line and a soft fill, broken where the Mac slept */
.bchart{flex:1 1 auto;min-height:0;width:100%;margin:10px 0 -26px;overflow:visible}
.bchart #bchart-l{fill:none;stroke:var(--live);stroke-width:2;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke;opacity:.8}
.bchart.red #bchart-l{stroke:var(--red)}.bchart.red stop{stop-color:var(--red)}
.tile.wide .brow{position:relative}
.tile .s{font:500 12px var(--mono);color:var(--ink3);margin-top:auto;padding-top:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.green{color:var(--live)!important;text-shadow:0 0 18px var(--glow)}.amber{color:var(--amber)!important}.red{color:var(--red)!important}
svg.scope{width:100%;height:28px;margin-top:10px;overflow:visible}
svg.scope polyline{fill:none;stroke:var(--live);stroke-width:1.8;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke;filter:drop-shadow(0 0 4px var(--glow))}
/* each tile: its label, and on the right a live icon of the same thing (battery level, signal, lid) */
.th{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ti{flex:none;width:30px;height:20px;fill:none;stroke:var(--ink2);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;overflow:visible;transition:stroke .3s,color .3s}
#batt-ic .fill{fill:currentColor;stroke:none;color:#fff;transition:width .4s}
#batt-ic.green .fill{color:var(--live)}#batt-ic.red .fill{color:var(--red)}#batt-ic.red{stroke:var(--red)}
#batt-ic .bolt{fill:#fff;stroke:#0b100e;stroke-width:1.3;display:none}#batt-ic.charging .bolt{display:block}
#ping-ic.green{stroke:var(--live);filter:drop-shadow(0 0 4px var(--glow))}#ping-ic.amber{stroke:var(--amber)}#ping-ic.red{stroke:var(--red)}
.wifi path{stroke:rgba(255,255,255,.2)}.wifi path.on{stroke:#fff}.wifi circle{fill:#fff;stroke:none}
.wifi .x{display:none;stroke:var(--red)}.wifi.off .x{display:block}.wifi.off circle{fill:rgba(255,255,255,.2)}
.lap{stroke:#fff}
.stay{padding:16px 18px 16px;border-radius:26px;margin-bottom:12px}
.stay .row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.stay .row:first-child{align-items:baseline}
.stay .amt{font:700 24px/1 var(--round);letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stay .amt small{font-size:.58em;font-weight:600;margin-left:2px;letter-spacing:0}
.stay .r2{margin-top:4px}.stay .r2 .slider{flex:1;margin:0}
#stay-now{color:var(--ink2)}
.help{display:flex;gap:12px;align-items:flex-start;padding:14px 16px;margin-bottom:12px;border-radius:20px;font-size:14.5px}
.help .dot{flex:none;width:8px;height:8px;margin-top:6px;border-radius:50%;background:var(--amber);box-shadow:0 0 12px var(--amber)}
.list{border-radius:24px;overflow:hidden}
.proj{display:flex;align-items:center;gap:13px;padding:14px 16px;position:relative}
.proj+.proj:before{content:'';position:absolute;left:37px;right:0;top:0;border-top:1px solid var(--hair)}
.proj:active{background:rgba(255,255,255,.06)}
.proj .main{flex:1;min-width:0}
.proj .nm{font:600 16.5px/1.25 var(--sans);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.proj .meta{margin-top:2px;font:500 12px var(--mono);color:var(--ink3)}
.proj .go{width:8px;height:8px;border-right:2px solid var(--ink3);border-top:2px solid var(--ink3);transform:rotate(45deg);margin-right:4px}
.empty{font:500 13px var(--mono);color:var(--ink3);padding:16px;margin:0}
.proj .pip.on.pulse{animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{50%{box-shadow:0 0 2px var(--glow);opacity:.55}}
/* Monitors: bigger rows, each with a glass icon tile for what it is: the Mac's own screen (a laptop or a
   desktop, as the Mac is), a project served from the Mac, a cloud copy in its container (a window) */
.mon{padding:15px 16px;gap:14px}
.mon+.mon:before{left:76px}
.mon .ic{position:relative;flex:none;width:46px;height:46px;border-radius:14px;display:grid;place-items:center;color:var(--ink2);
  background:linear-gradient(160deg,rgba(255,255,255,.13),rgba(255,255,255,.035));box-shadow:inset 0 1px 0 rgba(255,255,255,.18),inset 0 0 0 .5px rgba(255,255,255,.06),0 4px 12px rgba(0,0,0,.3)}
.mon.live .ic{color:#eafff3;background:linear-gradient(160deg,rgba(43,240,138,.3),rgba(43,240,138,.08));box-shadow:inset 0 1px 0 rgba(200,255,225,.3),0 0 0 .5px rgba(43,240,138,.35),0 4px 14px rgba(43,240,138,.12)}
.mon .ic svg{width:25px;height:25px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.mon .ic .pip{position:absolute;right:-3px;bottom:-3px;width:12px;height:12px;border:2.5px solid #0a0f0d}
.mon .nm{font-size:17.5px;font-weight:650}
.mon .meta{margin-top:3px}
.proj .view{height:34px;padding:0 12px 0 15px;display:inline-flex;font-size:13.5px;flex:none;gap:4px}.proj .view svg{width:15px;height:15px;margin:0 -2px 0 0}
/* agents: each one's own mark in its tile (kind from agents.js), not tinted green like a live monitor */
.agent .ic{color:inherit}
/* View with Remote Control off: dimmed, and a tap says why (a tooltip; a phone has no hover) */
.proj .view.off{color:var(--ink3);background:rgba(255,255,255,.04);box-shadow:inset 0 0 0 .5px rgba(255,255,255,.1)}
.tip{position:fixed;z-index:30;background:rgba(14,19,17,.9)!important;max-width:240px;padding:9px 12px;border-radius:14px;font:500 13px/1.35 var(--sans);color:var(--ink);pointer-events:none;
  opacity:0;transform:translateY(4px);transition:opacity .18s,transform .18s}
.tip.show{opacity:1;transform:none}
.agent.live .ic{background:linear-gradient(160deg,rgba(255,255,255,.13),rgba(255,255,255,.035));box-shadow:inset 0 1px 0 rgba(255,255,255,.18),inset 0 0 0 .5px rgba(255,255,255,.06),0 4px 12px rgba(0,0,0,.3)}
.agent .ic svg.mark{width:24px;height:24px;stroke:none}
main{padding-bottom:calc(104px + env(safe-area-inset-bottom))}
/* tabs: one pane at a time, switched at once as iOS tab bars do (fading a pane in leaves its glass unblurred
   until the fade ends) */
.pane:not(.on){display:none}
/* Home fits the screen: the tiles take whatever height is left between the hero and stay awake, so nothing
   scrolls; on a short phone they keep a usable size and the page scrolls instead */
#p-home.on{display:flex;flex-direction:column;gap:12px;
  min-height:calc(100vh - 180px - env(safe-area-inset-top) - env(safe-area-inset-bottom));
  min-height:calc(100dvh - 180px - env(safe-area-inset-top) - env(safe-area-inset-bottom))}
#p-home>*{flex:none;margin:0}
#p-home .tile.wide{flex:1 1 auto}
#help:empty{display:none}
#help .help:last-child{margin-bottom:0}
/* the tab bar: a floating glass capsule; a lit glass pill slides under the tab that is open */
body.short-vp main{padding-bottom:96px}
body.short-vp #p-home.on{min-height:calc(100vh - 172px - env(safe-area-inset-top));min-height:calc(100dvh - 172px - env(safe-area-inset-top))}
body.short-vp .tabs{bottom:12px}
.tabs{position:fixed;z-index:6;left:0;right:0;bottom:calc(12px + env(safe-area-inset-bottom));margin:0 auto;width:min(calc(100% - 40px),340px);
  height:64px;padding:6px;border-radius:32px;display:grid;grid-template-columns:repeat(3,1fr)}
.tabs .sel{position:absolute;left:6px;top:6px;bottom:6px;width:calc((100% - 12px) / 3);border-radius:26px;pointer-events:none;
  background:linear-gradient(160deg,rgba(255,255,255,.16),rgba(255,255,255,.05));box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 4px 14px rgba(0,0,0,.3);
  transition:transform .42s cubic-bezier(.32,.72,0,1)}
.tabs button{position:relative;border:0;background:none;color:var(--ink3);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
  font:600 10.5px var(--sans);cursor:pointer;transition:color .25s}
.tabs button svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.tabs button.on{color:var(--live);text-shadow:0 0 12px var(--glow)}
.tabs button:active svg{transform:scale(.9)}
.tabs .badge{position:absolute;top:5px;left:calc(50% + 7px);min-width:16px;height:16px;padding:0 4px;border-radius:8px;
  background:var(--live);color:#02170b;font:700 10.5px/16px var(--round);text-align:center;box-shadow:0 0 10px var(--glow)}
.tabs .badge.amber{background:var(--amber);box-shadow:0 0 10px var(--amber)}
@media (prefers-reduced-motion: reduce){.tabs .sel{transition:none}}
/* opening a project: an iOS push. A glass sheet slides over from the right while the page under it slides a
   third of the way left and dims; the project loads behind the sheet, which stays until it arrives. */
main{transition:transform .5s cubic-bezier(.32,.72,0,1),filter .5s}
body.pushed main{transform:translateX(-30%);filter:brightness(.45)}
.tabs{transition:transform .5s cubic-bezier(.32,.72,0,1),filter .5s}
body.pushed .tabs{transform:translateX(-30%);filter:brightness(.45)}
.push{position:fixed;inset:0;z-index:20;display:flex;flex-direction:column;transform:translateX(100%);visibility:hidden;
  transition:transform .5s cubic-bezier(.32,.72,0,1),visibility 0s .5s;
  background:linear-gradient(160deg,rgba(255,255,255,.07),rgba(255,255,255,.015) 40%),rgba(6,10,8,.72);
  -webkit-backdrop-filter:blur(30px) saturate(170%);backdrop-filter:blur(30px) saturate(170%);
  box-shadow:-24px 0 60px rgba(0,0,0,.6),inset 1px 0 0 rgba(255,255,255,.14)}
body.pushed .push{transform:none;visibility:visible;transition:transform .5s cubic-bezier(.32,.72,0,1)}
.push .bar{position:relative;top:auto;margin:calc(10px + env(safe-area-inset-top)) 14px 0;padding-left:7px}
.push .bar .title{flex:1;text-align:center;margin-right:38px;font:650 17px var(--sans);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.push .wait{flex:1;display:grid;place-items:center}
.push .wait svg{width:96px;height:70px;opacity:0;transition:opacity .3s .35s}
body.pushed .push .wait svg{opacity:1}
.push .wait .spokes{transform-box:view-box;transform-origin:512px 512px;animation:spin 1s steps(8) infinite}
@media (prefers-reduced-motion: reduce){main,.push{transition:none!important}}
</style></head><body>
${BACKDROP}
<main>
<header class="glass bar">
  ${MARK.replace(' id="pupil"', '')}
  <span class="word">seer</span>
  <span class="clock" id="clock"></span>
  <a class="icon-btn" href="/settings" aria-label="Settings">${GEAR}</a>
</header>

<div class="pane on" id="p-home">
<section class="glass hero">
  <div class="top"><span class="k" id="dev">mac</span><span class="chip"><span class="pip" id="link-pip"></span><span id="link">linking</span></span></div>
  <div class="srow">${MARK.replace('class="eye"', 'class="eye big" id="eye"')}<div class="sw"><div class="state" id="state">—</div><div class="why" id="why"></div></div><button class="btn" id="sleep-b">${BTN.sleep}<span>Sleep</span></button></div>
  <div class="count" id="count" hidden><span class="t" id="count-t"></span><div class="track"><i id="count-i"></i></div><span class="k" id="count-k"></span></div>
</section>

<div id="help"></div>

<div class="glass tile wide"><div class="th"><span class="k">battery</span><svg class="ti" id="batt-ic" viewBox="0 0 30 20" aria-hidden="true"><rect x="1.5" y="3.5" width="23.5" height="13" rx="4"/><path d="M28 8.2v3.6"/><rect class="fill" id="batt-f" x="4" y="6" width="0" height="8" rx="2"/><path class="bolt" id="batt-bolt" d="M14.6 4.2 9.6 11h4.2l-1.6 4.8 5.2-7h-4.3Z"/></svg></div><svg class="bchart" id="bchart" viewBox="0 0 360 100" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="bfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2bf08a" stop-opacity=".16"/><stop offset="1" stop-color="#2bf08a" stop-opacity="0"/></linearGradient></defs><path id="bchart-a" fill="url(#bfill)"/><path id="bchart-l"/></svg><div class="brow"><div class="v" id="batt">—</div><div class="s" id="batt-s"></div></div><div class="track"><i id="batt-i"></i></div></div>
<div class="grid">
  <div class="glass tile"><div class="th"><span class="k">ping</span><svg class="ti" id="ping-ic" viewBox="0 0 30 20" aria-hidden="true"><path d="M1.5 10.5h5.5l3-7 4.6 13.5 3.6-10 2.1 3.5h8.2"/></svg></div><div class="v" id="ping">—</div><svg class="scope" viewBox="0 0 100 30" preserveAspectRatio="none"><polyline id="scope" points=""/></svg></div>
  <div class="glass tile"><div class="th"><span class="k">network</span><svg class="ti wifi" viewBox="0 0 30 20" aria-hidden="true"><path id="r3" d="M2.5 7.6a17.6 17.6 0 0 1 25 0"/><path id="r2" d="M7 12.1a11.2 11.2 0 0 1 16 0"/><path id="r1" d="M11.4 16.3a5.1 5.1 0 0 1 7.2 0"/><circle cx="15" cy="18.4" r="1.6"/><path class="x" id="wifi-x" d="M4.5 1.5l21 17"/></svg></div><div class="v" id="net">—</div><div class="s" id="net-s"></div></div>
  <div class="glass tile"><div class="th"><span class="k">lid</span><svg class="ti lap" viewBox="0 0 30 20" aria-hidden="true"><path id="lap-screen" d="M5.5 2.5h19a1.5 1.5 0 0 1 1.5 1.5v10.5H4V4a1.5 1.5 0 0 1 1.5-1.5Z"/><path d="M1.5 16.8h27"/></svg></div><div class="v" id="lid">—</div><div class="s" id="lid-s"></div></div>
</div>

<section class="glass stay">
  <div class="row"><span class="k">stay awake <span id="stay-now"></span></span><span class="amt" id="stay-amt">1<small>h</small></span></div>
  <div class="row r2"><input class="slider" type="range" id="stay-r" min="0" max="11" value="4" aria-label="How long to stay awake"><span class="btns"><button class="btn" id="stay-x" hidden>${BTN.cancel}<span>Cancel</span></button><button class="btn tint" id="stay-b">${BTN.cup}<span>Start</span></button></span></div>
</section>

</div>

<div class="pane" id="p-monitors"><div class="glass list" id="projects"></div></div>

<div class="pane" id="p-agents"><div class="glass list" id="agents"></div></div>
</main>
<div class="glass tip" id="tip" role="tooltip"></div>
<nav class="glass tabs" id="tabs">
  <span class="sel" id="tab-sel"></span>
  <button data-tab="home" class="on"><svg viewBox="0 0 24 24"><path d="M4 16.5a8 8 0 1 1 16 0"/><path d="M12 16.5l3.6-4.6"/><circle cx="12" cy="16.5" r="1.2" fill="currentColor" stroke="none"/></svg>Home</button>
  <button data-tab="monitors"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12.5" rx="2.4"/><path d="M12 16.5V20M8.5 20h7"/></svg>Monitors</button>
  <button data-tab="agents"><svg viewBox="0 0 24 24"><path d="M12 4.5c.6 4.4 2.6 6.4 7 7-4.4.6-6.4 2.6-7 7-.6-4.4-2.6-6.4-7-7 4.4-.6 6.4-2.6 7-7Z"/></svg>Agents<span class="badge" id="ag-badge" hidden></span></button>
</nav>
<div class="push" id="push" aria-hidden="true">
  <header class="glass bar"><button class="icon-btn" id="push-back" aria-label="Back" style="border:0">${BACK}</button><span class="title" id="push-t"></span></header>
  <div class="wait">${MARK.replace('id="pupil"', 'class="spokes"')}</div>
</div>
<script>
const $ = id => document.getElementById(id);
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clockOf = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0'); };
let st = ${initial}, pings = [];

// The countdown is the server's (power.js): shown only when the Mac really lets go at that time, so never while
// an agent works, someone streams, or the lid is open with nothing else holding it.
function tick() {                                       // the clock and the countdown, every second
  $('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const c = st.awake.countdown, now = Date.now(), until = c && c.until > now ? c.until : 0;
  $('count').hidden = !until;
  if (until) {
    $('count-k').textContent = c.kind === 'stay' ? 'left' : 'to sleep';
    $('count-t').textContent = mmss(until - now);
    const span = c.from ? until - c.from : Math.max(until - (st.stayFrom || now), until - now);
    $('count-i').style.width = Math.max(2, Math.min(100, (until - now) / span * 100)) + '%';
  }
}

// Each agent's mark, by the kind agents.js reports: the agent's own logo (assets/agents, from Simple Icons, which
// takes each from the brand's source); one it does not know gets a plain spark.
const AGENT = {
  claude: '<svg class="mark" viewBox="0 0 24 24"><path fill="#d97757" d="${CLAUDE_D}"/></svg>',
  other: '<svg viewBox="0 0 24 24"><path d="M12 4.5c.6 4.4 2.6 6.4 7 7-4.4.6-6.4 2.6-7 7-.6-4.4-2.6-6.4-7-7 4.4-.6 6.4-2.6 7-7Z"/></svg>',
};

// What each monitor is: this Mac (a laptop or a desktop, from its model), a web project on it, a cloud copy.
const ICON = {
  laptop: '<svg viewBox="0 0 24 24"><rect x="4.5" y="5" width="15" height="10.5" rx="1.8"/><path d="M2.5 18.5h19"/></svg>',
  desktop: '<svg viewBox="0 0 24 24"><rect x="3" y="3.8" width="18" height="12.6" rx="2.2"/><path d="M12 16.4v3.6M8.2 20h7.6"/></svg>',
  web: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9.5 9.5 7 12l2.5 2.5M14.5 9.5 17 12l-2.5 2.5"/></svg>',
  window: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 8.8h18"/><circle cx="6.1" cy="6.4" r=".75" fill="currentColor" stroke="none"/><circle cx="8.6" cy="6.4" r=".75" fill="currentColor" stroke="none"/></svg>',
};

function render() {
  const a = st.awake, b = st.battery, n = st.network, h = st.hotspot;
  $('pupil').classList.toggle('spin', !!st.agentsBusy);           // the eye's pupil turns while an agent works
  $('eye').classList.toggle('asleep', a.label === 'Asleep');    // and shuts while the Mac sleeps
  if (!sleptAt) $('sleep-b').hidden = a.label === 'Asleep';     // already asleep: nothing to send
  $('state').textContent = a.label || (a.awake ? 'Awake' : 'Idle');
  $('state').className = 'state' + (a.label === 'Awake' ? ' live' : a.inUse ? ' use' : '');
  $('why').textContent = a.why; $('why').hidden = !a.why;
  // battery
  const low = !b.pluggedIn && b.pct <= 20;
  $('batt').textContent = b.pct + '%'; $('batt').className = 'v ' + (low ? 'red' : b.pluggedIn ? 'green' : '');
  $('batt-i').style.width = b.pct + '%'; $('batt-i').className = low ? 'red' : '';
  // chart: x is time (6 h ago at the left), y the charge; a gap of over 15 minutes between samples breaks the line
  const hs = (b.history || []).slice().sort((p, q) => q[0] - p[0]), X = ago => (360 - ago) / 360 * 360, Y = pct => 100 - pct;
  let line = '', area = '', run = [];
  const close = () => { if (run.length > 1) { line += 'M' + run.map(p => X(p[0]).toFixed(1) + ' ' + Y(p[1])).join('L'); area += 'M' + X(run[0][0]).toFixed(1) + ' 100L' + run.map(p => X(p[0]).toFixed(1) + ' ' + Y(p[1])).join('L') + 'L' + X(run[run.length - 1][0]).toFixed(1) + ' 100Z'; } run = []; };
  for (const p of hs) { if (run.length && run[run.length - 1][0] - p[0] > 15) close(); run.push(p); }
  close();
  $('bchart-l').setAttribute('d', line); $('bchart-a').setAttribute('d', area);
  $('bchart').setAttribute('class', 'bchart' + (low ? ' red' : ''));
  $('batt-f').setAttribute('width', (Math.max(0, Math.min(100, b.pct)) / 100 * 18.5).toFixed(1));
  $('batt-ic').setAttribute('class', 'ti' + (low ? ' red' : b.pluggedIn ? ' green' : '') + (b.state === 'charging' ? ' charging' : ''));
  $('batt-s').textContent = b.pluggedIn ? (b.state === 'charging' ? 'charging' : 'plugged in') : (b.remaining ? b.remaining + ' left' : 'on battery') + (b.drainPerHour != null ? ' · ' + b.drainPerHour + '%/h' : '');
  // network
  const lit = { strong: 3, good: 2, weak: 1, poor: 0 }[n.signal] ?? (n.kind === 'hotspot' || n.kind === 'wired' ? 3 : 0);
  ['r1', 'r2', 'r3'].forEach((r, i) => $(r).classList.toggle('on', n.kind !== 'offline' && i < lit));
  document.querySelector('.wifi').classList.toggle('off', n.kind === 'offline');
  $('net').textContent = { wifi: 'Wi-Fi', hotspot: 'Hotspot', wired: 'Wired', offline: 'Offline' }[n.kind] || n.kind;
  $('net').className = 'v ' + (n.kind === 'offline' ? 'red' : n.kind === 'hotspot' ? 'amber' : '');
  $('net-s').textContent = n.kind === 'offline'
    ? (h.joining ? 'joining ' + (h.name || 'hotspot') : 'no internet')
    : [n.kind === 'hotspot' ? h.name : n.ssid, n.internetMs != null ? n.internetMs + ' ms' : ''].filter(Boolean).join(' · ');
  // lid
  $('lid').textContent = st.lid === 'unknown' ? '—' : st.lid === 'closed' ? 'Closed' : 'Open';
  $('lap-screen').setAttribute('d', st.lid === 'closed' ? 'M3.5 14.2h23' : 'M5.5 2.5h19a1.5 1.5 0 0 1 1.5 1.5v10.5H4V4a1.5 1.5 0 0 1 1.5-1.5Z');
  $('lid-s').textContent = st.lid === 'closed' && (a.external || a.inUse) ? 'external display' : '';
  // stay awake
  $('stay-x').hidden = !a.stayUntil;
  $('stay-now').textContent = a.stayUntil ? 'until ' + clockOf(a.stayUntil) : '';
  // help
  $('help').innerHTML = st.help.map(t => '<div class="glass help"><i class="dot"></i><span>' + esc(t) + '</span></div>').join('');
  // agents: Claude Code sessions on this Mac; View opens the session's Remote Control page (the Claude app on a phone)
  const ago = t => { const m = Math.round((Date.now() - t) / 60_000); return m < 1 ? 'now' : m < 60 ? m + ' min' : m < 2880 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' d'; };
  const ag = st.agents || [], working = ag.filter(g => g.busy).length, waiting = ag.filter(g => g.waiting).length;
  $('ag-badge').hidden = !(working || waiting);
  $('ag-badge').textContent = waiting || working;                // one needing you outranks the count working
  $('ag-badge').className = 'badge' + (waiting ? ' amber' : '');
  $('agents').innerHTML = ag.length ? ag.map(g => '<div class="proj mon agent' + (g.busy ? ' live' : '') + '"><span class="ic">' + (AGENT[g.kind] || AGENT.other)
    + '<i class="pip ' + (g.waiting ? 'amber' : g.busy ? 'on pulse' : '') + '"></i></span>'
    + '<div class="main"><div class="nm">' + esc(g.name) + '</div><div class="meta">' + esc([g.waiting ? 'needs you' : g.busy ? 'active' : 'idle ' + ago(g.since), g.dir].filter(Boolean).join(' · ')) + '</div></div>'
    + (g.url ? '<a class="btn view" href="' + esc(g.url) + '" target="_blank" rel="noopener">View${BTN.open}</a>'
      : '<button class="btn view off" data-tip="Turn on Remote Control in this session to view it" aria-label="View: Remote Control is off">View${BTN.info}</button>') + '</div>').join('') : '<p class="empty">no agents</p>';
  // projects
  const dev = st.device || {};
  $('dev').textContent = dev.name || 'mac';
  const rows = (st.desktop ? [{ name: dev.name || 'Desktop', href: '/desktop', state: 'streamed', where: 'screen' }] : []).concat(st.projects);
  $('projects').innerHTML = rows.length ? rows.map(p => {
    const live = p.state === 'running' || p.state === 'on demand' || p.state === 'streamed';
    const icon = p.where === 'screen' ? (dev.kind === 'desktop' || (!dev.kind && st.lid === 'unknown') ? ICON.desktop : ICON.laptop) : p.where === 'cloud' ? ICON.window : ICON.web;
    const meta = p.where === 'screen' ? [dev.model, 'screen'].filter(Boolean).join(' · ') : [p.where === 'cloud' ? 'cloud' : 'mac', p.state === 'running' ? '' : p.state].filter(Boolean).join(' · ');
    return '<a class="proj mon' + (live ? ' live' : '') + '" href="' + esc(p.href) + '"><span class="ic">' + icon + '<i class="pip ' + (live ? 'on' : p.state === 'failed' ? 'red' : '') + '"></i></span>'
      + '<div class="main"><div class="nm">' + esc(p.name) + '</div><div class="meta">' + esc(meta) + '</div></div>'
      + '<span class="go"></span></a>';
  }).join('') : '<p class="empty">nothing running</p>';
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
    const q = ms < 120 ? 'green' : ms < 300 ? 'amber' : 'red';
    $('ping').innerHTML = ms + '<small> ms</small>'; $('ping').className = 'v ' + q; $('ping-ic').setAttribute('class', 'ti ' + q);
    $('link').textContent = 'linked'; $('link-pip').className = 'pip on';
    scope(ms);
    const next = await (await fetch('/status.json', { cache: 'no-store' })).json();
    // Just sent to sleep: the Mac answers awake for the few seconds it takes to go, so hold "Asleep". Still
    // answering after that, it did not sleep (someone touched it, or it woke): show it as it is.
    if (sleptAt && Date.now() - sleptAt < 15000) return;
    if (sleptAt) { sleptAt = 0; const b = $('sleep-b'); b.disabled = false; b.lastChild.textContent = 'Sleep'; }
    st = next;
    render();
  } catch { $('link').textContent = 'lost'; $('link-pip').className = 'pip red'; $('ping').textContent = '—'; $('ping-ic').setAttribute('class', 'ti'); }
}

// stay awake: 10 min to 12 h, finer at the short end
const STEPS = [10, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720];
// The number big, its unit small beside it (as ping's ms): 45 min, 1 h, 1 h 30 min.
const span = m => { const h = Math.floor(m / 60), mm = m % 60;
  return [h ? h + '<small>h</small>' : '', mm ? mm + '<small>min</small>' : ''].filter(Boolean).join(' '); };
const paint = () => { const r = $('stay-r'); r.style.setProperty('--p', (r.value / r.max * 100) + '%'); $('stay-amt').innerHTML = span(STEPS[r.value]); };
$('stay-r').oninput = paint; paint();
async function setStay(minutes) {
  try { await fetch('/awake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minutes }) }); } catch {}
  st.stayFrom = Date.now(); refresh();
}
$('stay-b').onclick = () => setStay(STEPS[$('stay-r').value]);
$('stay-x').onclick = () => setStay(0);

// Sleep now: a sleeping Mac cannot be woken from here, so the first tap arms it and a second within 3 s sends it.
let armed = 0, sleptAt = 0;
$('sleep-b').onclick = async () => {
  const b = $('sleep-b');
  if (Date.now() > armed) {
    armed = Date.now() + 3000; b.lastChild.textContent = 'Sleep?'; b.classList.add('armed');
    setTimeout(() => { if (Date.now() > armed) { b.lastChild.textContent = 'Sleep'; b.classList.remove('armed'); } }, 3100);
    return;
  }
  armed = 0; b.classList.remove('armed'); b.disabled = true; b.lastChild.textContent = 'Sleeping';
  try {
    const r = await fetch('/sleep', { method: 'POST' });
    if (!r.ok) throw new Error();
    sleptAt = Date.now();
    $('eye').classList.add('asleep'); $('state').textContent = 'Asleep'; $('state').className = 'state'; $('why').textContent = 'since ' + clockOf(Date.now()); $('why').hidden = false; $('count').hidden = true;
  } catch { b.disabled = false; b.lastChild.textContent = 'Sleep'; }
};

// Opening a project slides a sheet over (see .push); the project starts loading the moment it is tapped.
$('projects').addEventListener('click', e => {
  const a = e.target.closest('a.proj');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  $('push-t').textContent = a.querySelector('.nm').textContent;
  document.body.classList.add('pushed');
  setTimeout(() => { location.href = a.href; }, 60);     // a frame for the slide to start before the browser gets busy
});
const unpush = () => document.body.classList.remove('pushed');
$('push-back').onclick = () => { window.stop(); unpush(); };
window.addEventListener('pageshow', e => { if (e.persisted) requestAnimationFrame(unpush); });   // back from a project

// A tap on anything with data-tip shows it above that thing for a few seconds; any other tap hides it.
let tipFor = null, tipTimer = 0;
document.addEventListener('click', e => {
  const t = e.target.closest('[data-tip]'), tip = $('tip');
  clearTimeout(tipTimer);
  if (!t || t === tipFor) { tip.classList.remove('show'); tipFor = null; return; }
  tip.textContent = t.dataset.tip; tipFor = t;
  const r = t.getBoundingClientRect(), w = Math.min(240, innerWidth - 24);
  tip.style.maxWidth = w + 'px';
  tip.style.left = Math.max(12, Math.min(innerWidth - 12 - tip.offsetWidth, r.right - tip.offsetWidth)) + 'px';
  tip.style.top = (r.top - tip.offsetHeight - 8) + 'px';
  tip.classList.add('show');
  tipTimer = setTimeout(() => { tip.classList.remove('show'); tipFor = null; }, 3500);
});
addEventListener('scroll', () => { $('tip').classList.remove('show'); tipFor = null; }, { passive: true });

// Tabs. The open one is kept in the address (#monitors, #agents) so back from a project lands where it was;
// each keeps its own scroll.
// Home Screen app laid out shorter than the screen (see viewer.js, short-vp): the tab bar sits on the page's own bottom.
const shortVp = () => document.body.classList.toggle('short-vp', !!navigator.standalone && Math.max(screen.width, screen.height) - Math.max(innerWidth, innerHeight) > 20);
shortVp(); addEventListener('resize', shortVp);
const TABS = ['home', 'monitors', 'agents'], scrolls = {};
let tab = 'home';
function show(t) {
  if (!TABS.includes(t)) t = 'home';
  if (t !== tab) scrolls[tab] = scrollY;
  for (const k of TABS) $('p-' + k).classList.toggle('on', k === t);
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $('tab-sel').style.transform = 'translateX(' + TABS.indexOf(t) * 100 + '%)';
  tab = t;
  history.replaceState(null, '', t === 'home' ? location.pathname + location.search : '#' + t);
  scrollTo(0, scrolls[t] || 0);
}
$('tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  if (b.dataset.tab === tab) { scrollTo({ top: 0, behavior: 'smooth' }); return; }    // tapping the open tab scrolls up
  show(b.dataset.tab);
});
show(location.hash.slice(1));

render(); refresh();
setInterval(tick, 1000);
// Every 5 s while the Mac is up; every 30 s while it sleeps or does not answer, so an open page never keeps
// knocking on a sleeping Mac (a reply can only come from one of its brief background wakes). Never while hidden.
(function poll() {
  const asleep = sleptAt || $('link').textContent === 'lost' || (st.awake && st.awake.label === 'Asleep');
  setTimeout(() => { if (!document.hidden) refresh().finally(poll); else poll(); }, asleep ? 30000 : 5000);
})();
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
</script></body></html>`;
}
