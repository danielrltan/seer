// Seer's Settings page, for the phone and the Mac: grouped glass lists in the manner of iOS Settings, in the dark
// Liquid Glass of glass.js. Every control saves the moment it changes (sliders when let go) and shows what the
// Mac now holds; a refused save puts the control back and says why on its row.
import { GLASS_CSS, BACKDROP, BACK } from './glass.js';

export function settingsPage(initial, appHead) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#020403"><title>Seer settings</title>
${appHead}
<style>${GLASS_CSS}
.bar{padding-left:7px}
.bar .title{flex:1;text-align:center;margin-right:38px}
.sect{font:600 13px var(--sans);color:var(--ink3);margin:22px 8px 9px}
.group{border-radius:24px;overflow:hidden}
.row{display:flex;align-items:center;gap:12px;min-height:56px;padding:10px 16px;position:relative}
.row+.row:before,.row+.apps:before,.apps+.row:before{content:'';position:absolute;left:16px;right:0;top:0;border-top:1px solid var(--hair)}
.row .l{flex:1;min-width:0;font:500 16px/1.3 var(--sans)}
.row .d{display:block;margin-top:2px;font:500 12px var(--mono);color:var(--ink3)}
.row .d.err{color:var(--red)}
.row .val{font:700 17px var(--round);font-variant-numeric:tabular-nums;color:var(--ink2);flex:none}
.row.col{flex-direction:column;align-items:stretch;gap:0;padding-bottom:4px}
.row.col .top{display:flex;align-items:center;gap:12px}
.row.col .slider{margin:6px 0 4px}
.row input.text{flex:1;min-width:0;height:38px;padding:0 14px;border:0;border-radius:19px;outline:none;font:500 15px var(--sans);color:#fff;
  background:rgba(0,0,0,.36);box-shadow:inset 0 1px 2px rgba(0,0,0,.6),inset 0 -1px 0 rgba(255,255,255,.06)}
.row input.text::placeholder{color:var(--ink3)}
.row input.text:focus{box-shadow:inset 0 1px 2px rgba(0,0,0,.6),0 0 0 1.5px rgba(43,240,138,.55)}
.row .btn{height:36px;padding:0 15px;font-size:14px;flex:none}
.apps{display:flex;flex-wrap:wrap;gap:8px;padding:12px 16px 14px;position:relative}
.app{height:34px;padding:0 14px;border:0;border-radius:17px;font:600 13.5px var(--sans);color:var(--ink3);cursor:pointer;
  background:rgba(255,255,255,.05);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
.app.on{color:#eafff3;background:linear-gradient(160deg,rgba(43,240,138,.34),rgba(43,240,138,.12));box-shadow:inset 0 1px 0 rgba(200,255,225,.3),0 0 0 .5px rgba(43,240,138,.5)}
.off .apps{opacity:.4;pointer-events:none}
.ok{color:var(--live)}
</style></head><body>
${BACKDROP}
<main>
<header class="glass bar">
  <a class="icon-btn" href="/" aria-label="Back">${BACK}</a>
  <span class="title">Settings</span>
</header>

<div class="sect">staying awake</div>
<div class="glass group">
  <label class="row"><span class="l">Stay up with the lid closed<span class="d" id="away-d"></span></span><input type="checkbox" class="switch" data-k="away"></label>
  <label class="row"><span class="l">Working agents keep it awake<span class="d" id="agentsKeepAwake-d"></span></span><input type="checkbox" class="switch" data-k="agentsKeepAwake"></label>
  <div class="row col"><div class="top"><span class="l">Reachable after the last activity<span class="d" id="reachableMin-d"></span></span><span class="val" id="reachableMin-v"></span></div>
    <input type="range" class="slider" data-k="reachableMin" min="0" max="120" step="5" data-unit="min"></div>
</div>

<div class="sect">lid closed, nobody watching</div>
<div class="glass group" id="headless-g">
  <label class="row"><span class="l">Screen off<span class="d" id="screenOff-d"></span></span><input type="checkbox" class="switch" data-k="screenOff"></label>
  <label class="row"><span class="l">Mute<span class="d" id="mute-d"></span></span><input type="checkbox" class="switch" data-k="mute"></label>
  <label class="row"><span class="l">Low Power Mode on battery<span class="d" id="headlessLowPower-d"></span></span><input type="checkbox" class="switch" data-k="headlessLowPower"></label>
  <label class="row"><span class="l">Freeze apps while no agent works<span class="d" id="freeze-d"></span></span><input type="checkbox" class="switch" data-k="freeze"></label>
  <div class="apps" id="apps"></div>
</div>

<div class="sect">battery</div>
<div class="glass group">
  <div class="row col"><div class="top"><span class="l">Low Power Mode below<span class="d" id="lowPowerBelow-d"></span></span><span class="val" id="lowPowerBelow-v"></span></div>
    <input type="range" class="slider" data-k="lowPowerBelow" min="10" max="80" step="5" data-unit="%"></div>
  <div class="row col"><div class="top"><span class="l">Let it sleep below<span class="d" id="sleepBelow-d"></span></span><span class="val" id="sleepBelow-v"></span></div>
    <input type="range" class="slider" data-k="sleepBelow" min="5" max="50" step="5" data-unit="%"></div>
</div>

<div class="sect">network</div>
<div class="glass group">
  <label class="row"><span class="l">Join the hotspot when Wi-Fi drops<span class="d" id="hotspotFailover-d"></span></span><input type="checkbox" class="switch" data-k="hotspotFailover"></label>
  <div class="row"><input class="text" id="ssid" placeholder="Hotspot name" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="btn" id="ssid-b" hidden>Save</button></div>
  <div class="row"><input class="text" id="pw" type="password" placeholder="Password" autocomplete="new-password"><button class="btn" id="pw-b" hidden>Save</button></div>
  <div class="row" id="net-d-row" hidden><span class="l"><span class="d" id="hotspotSsid-d" style="margin:0"></span></span></div>
</div>

<div class="sect">screen</div>
<div class="glass group">
  <label class="row"><span class="l">Desktop stream<span class="d" id="desktop-d"></span></span><input type="checkbox" class="switch" data-k="desktop"></label>
  <div class="row col"><div class="top"><span class="l">Close the Mac view after<span class="d" id="macViewCloseMin-d"></span></span><span class="val" id="macViewCloseMin-v"></span></div>
    <input type="range" class="slider" data-k="macViewCloseMin" min="1" max="30" step="1" data-unit="min"></div>
</div>

<div class="sect">agents</div>
<div class="glass group">
  <div class="row"><span class="l">Claude Code hooks<span class="d" id="hooks-d"></span></span><span class="val" id="hooks-v"></span><button class="btn tint" id="hooks-b" hidden>Install</button></div>
</div>

<div class="sect">app</div>
<div class="glass group">
  <label class="row"><span class="l">Open Seer at login<span class="d" id="launchAtLogin-d"></span></span><input type="checkbox" class="switch" data-k="launchAtLogin"></label>
</div>
</main>
<script>
const $ = id => document.getElementById(id);
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let st = ${initial};

const fmt = (el, v) => v + (el.dataset.unit === '%' ? '%' : v ? ' min' : ' (off)');
function paintSlider(el) {
  const p = (el.value - el.min) / (el.max - el.min) * 100;
  el.style.setProperty('--p', p + '%');
  $(el.dataset.k + '-v').textContent = el.dataset.k === 'reachableMin' && +el.value === 0 ? 'off' : fmt(el, el.value);
}
function note(k, text, err) { const d = $(k + '-d'); if (d) { d.textContent = text || ''; d.className = 'd' + (err ? ' err' : ''); } }

function render() {
  const s = st.settings, inst = st.installed;
  document.querySelectorAll('.switch').forEach(el => { el.checked = !!s[el.dataset.k]; });
  document.querySelectorAll('.slider').forEach(el => { el.value = s[el.dataset.k]; paintSlider(el); });
  const sw = document.querySelector('[data-k=away]');
  sw.disabled = !inst.away && !s.away;
  note('away', inst.away ? '' : 'needs one sudo step on the Mac: seer away install');
  $('headless-g').classList.toggle('off', !s.freeze);
  $('apps').innerHTML = Object.entries(st.apps).map(([id, name]) =>
    '<button class="app' + (s.freezeApps.includes(id) ? ' on' : '') + '" data-id="' + esc(id) + '">' + esc(name) + '</button>').join('');
  if (document.activeElement !== $('ssid')) $('ssid').value = s.hotspotSsid;
  $('ssid-b').hidden = true;
  $('pw').placeholder = inst.hotspotPassword ? 'Password saved' : 'Password';
  $('net-d-row').hidden = !(s.hotspotSsid && !inst.hotspotPassword);
  if (s.hotspotSsid && !inst.hotspotPassword) note('hotspotSsid', 'no password saved for this hotspot', true);
  $('hooks-v').textContent = inst.hooks === 3 ? 'installed' : inst.hooks + ' of 3';
  $('hooks-v').className = 'val' + (inst.hooks === 3 ? ' ok' : '');
  $('hooks-b').hidden = inst.hooks === 3;
}

async function save(patch, k) {
  try {
    const r = await fetch('/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'not saved');
    st = j; render(); if (k) note(k, '');
    return true;
  } catch (e) { render(); if (k) note(k, e.message, true); return false; }
}

document.querySelectorAll('.switch').forEach(el => el.onchange = () => save({ [el.dataset.k]: el.checked }, el.dataset.k));
document.querySelectorAll('.slider').forEach(el => {
  el.oninput = () => paintSlider(el);
  el.onchange = () => save({ [el.dataset.k]: +el.value }, el.dataset.k);
});
$('apps').onclick = e => {
  const b = e.target.closest('.app'); if (!b) return;
  const list = st.settings.freezeApps.includes(b.dataset.id) ? st.settings.freezeApps.filter(x => x !== b.dataset.id) : [...st.settings.freezeApps, b.dataset.id];
  b.classList.toggle('on');
  save({ freezeApps: list }, 'freeze');
};
$('ssid').oninput = () => { $('ssid-b').hidden = $('ssid').value.trim() === st.settings.hotspotSsid; };
$('ssid-b').onclick = async () => { $('ssid').blur(); await save({ hotspotSsid: $('ssid').value }, 'hotspotSsid'); $('net-d-row').hidden = !$('hotspotSsid-d').textContent; };
$('pw').oninput = () => { $('pw-b').hidden = !$('pw').value; };
$('pw-b').onclick = async () => {
  $('net-d-row').hidden = false;
  if (await save({ hotspotPassword: $('pw').value }, 'hotspotSsid')) { $('pw').value = ''; $('pw-b').hidden = true; $('pw').blur(); }
};
$('hooks-b').onclick = async () => {
  try { const r = await fetch('/settings/hooks', { method: 'POST' }); const j = await r.json(); if (!r.ok) throw new Error(j.error); st = j; render(); }
  catch (e) { note('hooks', e.message, true); }
};

render();
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  try { st = await (await fetch('/settings.json', { cache: 'no-store' })).json(); render(); } catch {}
});
</script></body></html>`;
}
