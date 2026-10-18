// The owner's settings, edited from Seer's Settings page (phone or Mac) and kept in config.json beside the rest.
// Each one is read where it acts, on every tick, so a change applies within seconds and needs no restart.
// SPEC is the whole list: its type and range are what a save is checked against, so a page can never write
// anything else into config.json.
import { loadConfig, saveConfig } from './store.js';

export const DEFAULT_FREEZE = [
  'com.google.Chrome', 'com.apple.Safari', 'com.spotify.client', 'com.tinyspeck.slackmacgap',
  'com.hnc.Discord', 'com.figma.Desktop', 'notion.id', 'com.microsoft.teams2',
];

export const SPEC = {
  // staying awake
  away:             { type: 'bool', def: false },        // keep the Mac up with the lid closed while something needs it
  agentsKeepAwake:  { type: 'bool', def: true },         // a working agent is a reason to stay awake
  reachableMin:     { type: 'int', def: 15, min: 0, max: 120 },
  // lid closed, nobody watching (headless)
  screenOff:        { type: 'bool', def: true },
  freeze:           { type: 'bool', def: true },
  freezeApps:       { type: 'apps', def: DEFAULT_FREEZE },
  mute:             { type: 'bool', def: true },
  headlessLowPower: { type: 'bool', def: true },         // Low Power Mode while headless on battery
  // battery
  lowPowerBelow:    { type: 'int', def: 30, min: 10, max: 80 },
  sleepBelow:       { type: 'int', def: 15, min: 5, max: 50 },
  // network
  hotspotFailover:  { type: 'bool', def: true },
  hotspotSsid:      { type: 'text', def: '', max: 64 },
  // streaming
  desktop:          { type: 'bool', def: false },
  macViewCloseMin:  { type: 'int', def: 2, min: 1, max: 30 },
  // app
  launchAtLogin:    { type: 'bool', def: true },
};

// The apps the Settings page offers to freeze, with names for the page.
export const FREEZABLE = {
  'com.google.Chrome': 'Chrome', 'com.apple.Safari': 'Safari', 'com.spotify.client': 'Spotify', 'com.tinyspeck.slackmacgap': 'Slack',
  'com.hnc.Discord': 'Discord', 'com.figma.Desktop': 'Figma', 'notion.id': 'Notion', 'com.microsoft.teams2': 'Teams',
  'com.apple.Music': 'Music', 'com.apple.mail': 'Mail', 'com.apple.Photos': 'Photos', 'company.thebrowser.Browser': 'Arc',
};

export function settings(cfg = loadConfig()) {
  const out = {};
  for (const [k, s] of Object.entries(SPEC)) out[k] = cfg[k] ?? s.def;
  if (cfg.freezeApps === false) { out.freeze = cfg.freeze ?? false; out.freezeApps = DEFAULT_FREEZE; }   // the old "off"
  if (out.sleepBelow >= out.lowPowerBelow) out.sleepBelow = Math.max(5, out.lowPowerBelow - 5);
  return out;
}

// A patch from the page: unknown keys and bad values are refused whole, so nothing half-applies.
export function applySettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('send an object of settings');
  const clean = {};
  for (const [k, v] of Object.entries(patch)) {
    const s = SPEC[k];
    if (!s) throw new Error(`unknown setting: ${k}`);
    if (s.type === 'bool') { if (typeof v !== 'boolean') throw new Error(`${k}: true or false`); clean[k] = v; }
    else if (s.type === 'int') { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < s.min || n > s.max) throw new Error(`${k}: ${s.min} to ${s.max}`); clean[k] = n; }
    else if (s.type === 'text') { if (typeof v !== 'string' || v.length > s.max || /[\u0000-\u001f]/.test(v)) throw new Error(`${k}: up to ${s.max} characters`); clean[k] = v.trim(); }
    else if (s.type === 'apps') { if (!Array.isArray(v) || !v.every(b => b in FREEZABLE)) throw new Error(`${k}: apps from the list`); clean[k] = [...new Set(v)]; }
  }
  const next = settings({ ...loadConfig(), ...clean });
  if ('lowPowerBelow' in clean && next.sleepBelow >= next.lowPowerBelow) clean.sleepBelow = next.sleepBelow;
  if ('sleepBelow' in clean && clean.sleepBelow >= next.lowPowerBelow) throw new Error('sleep below must be under Low Power Mode below');
  saveConfig(clean);
  return settings();
}
