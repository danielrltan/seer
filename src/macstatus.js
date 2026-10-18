// The Mac's state for Seer home: battery, lid, network (Wi-Fi, phone hotspot, wired or offline), internet
// latency, whether and why it is staying awake, agents working, and the hotspot failover. Each reading is
// cheap (pmset, ioreg, route, one TCP handshake) and failures read as unknown, never as an error.
import net from 'node:net';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { battery, netState, WIFI_HELPER, wifiArgs, ruleInstalled } from './awake.js';
import path from 'node:path';
import { HOME, loadConfig } from './store.js';

const run = (file, args) => new Promise(resolve => execFile(file, args, { timeout: 5000 }, (err, out) => resolve(err ? '' : String(out))));

async function batteryDetail() {
  const out = await run('/usr/bin/pmset', ['-g', 'batt']);
  const b = await battery();
  const state = (out.match(/\d+%;\s*([a-z ]+);/) || [])[1]?.trim() || '';          // charging | discharging | charged | finishing charge
  const left = (out.match(/;\s*(\d+:\d+) remaining/) || [])[1];
  return { pct: b.pct, pluggedIn: !b.onBattery, state, remaining: left && left !== '0:00' ? left : null };
}

export async function lid() {
  const out = await run('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '4']);
  const m = out.match(/"AppleClamshellState"\s*=\s*(Yes|No)/);
  return m ? (m[1] === 'Yes' ? 'closed' : 'open') : 'unknown';
}

function connectMs(host, port = 443) {
  return new Promise(resolve => {
    const t0 = process.hrtime.bigint(), s = net.connect({ host, port });
    s.setTimeout(3000);
    s.once('connect', () => { s.destroy(); resolve(Math.round(Number(process.hrtime.bigint() - t0) / 1e6)); });
    s.once('timeout', () => { s.destroy(); resolve(null); });
    s.once('error', () => resolve(null));
  });
}

async function network() {
  const route = await run('/sbin/route', ['-n', 'get', 'default']);
  const iface = (route.match(/interface:\s*(\S+)/) || [])[1] || null;
  const gateway = (route.match(/gateway:\s*(\S+)/) || [])[1] || null;
  const internetMs = await connectMs('1.1.1.1');
  let wifi = null;
  if (fs.existsSync(WIFI_HELPER)) { try { wifi = JSON.parse(await run(WIFI_HELPER, wifiArgs(['status']))); } catch {} }
  const ports = await run('/usr/sbin/networksetup', ['-listallhardwareports']);
  const wifiDev = (ports.match(/Hardware Port: Wi-Fi\s*\nDevice: (\S+)/) || [])[1] || 'en0';
  // An iPhone's Personal Hotspot always hands out 172.20.10.x with itself at 172.20.10.1.
  const kind = !iface || internetMs === null ? 'offline' : gateway === '172.20.10.1' ? 'hotspot' : iface === wifiDev ? 'wifi' : 'wired';
  const rssi = wifi?.rssi && wifi.rssi !== 0 ? wifi.rssi : null;
  const signal = rssi === null ? null : rssi >= -60 ? 'strong' : rssi >= -70 ? 'good' : rssi >= -80 ? 'weak' : 'poor';
  return { kind, iface, internetMs, rssi, signal, ssid: wifi?.ssid || null, txRate: wifi?.txRate || null };
}

// awake: { awake, why, mode } from the daemon (activity.js + away mode); agentsBusy likewise.
const DRAIN_LOG = path.join(HOME, 'battery.jsonl');
let lastSample = 0;
// Called every daemon tick: one sample a minute (time, charge, on battery, the state the Mac was in).
export function sampleBattery(b, state) {
  if (Date.now() - lastSample < 60_000) return;
  lastSample = Date.now();
  try {
    fs.appendFileSync(DRAIN_LOG, JSON.stringify({ t: lastSample, pct: b.pct, bat: b.onBattery, state }) + '\n');
    if (fs.statSync(DRAIN_LOG).size > 400_000) {                               // keep about the last week
      const lines = fs.readFileSync(DRAIN_LOG, 'utf8').trim().split('\n');
      fs.writeFileSync(DRAIN_LOG, lines.slice(-6000).join('\n') + '\n');
    }
  } catch {}
}
// %/h on battery over the last hour of samples in the same state, once there are 30 min of them; else null.
function drainRate(state) {
  let rows = [];
  try { rows = fs.readFileSync(DRAIN_LOG, 'utf8').trim().split('\n').slice(-90).map(l => JSON.parse(l)); } catch { return null; }
  const run = [];
  for (let i = rows.length - 1; i >= 0 && rows[i].bat && rows[i].state === state && Date.now() - rows[i].t < 3600_000; i--) run.unshift(rows[i]);
  if (run.length < 2 || run.at(-1).t - run[0].t < 30 * 60_000) return null;
  return Math.max(0, +((run[0].pct - run.at(-1).pct) / ((run.at(-1).t - run[0].t) / 3600_000)).toFixed(1));
}

export async function macStatus({ awake, agentsBusy }) {
  const [batt, lidState, netw, awayAllowed] = await Promise.all([batteryDetail(), lid(), network(), ruleInstalled()]);
  const cfg = loadConfig();
  const hotspot = { name: cfg.hotspotSsid || null, offlineFor: netState.downSince ? Math.round((Date.now() - netState.downSince) / 1000) : 0, joining: netState.joining, lastJoin: netState.lastJoin };
  // What needs the owner's attention, most urgent first; empty when all is well.
  const help = [];
  if (netw.kind === 'offline' && hotspot.lastJoin?.result === 'not-found') help.push('Turn on Personal Hotspot on your phone, and keep its screen open until the Mac joins.');
  else if (netw.kind === 'offline' && !hotspot.name) help.push('The Mac is offline and has no hotspot to fall back on: seer away hotspot "<name>".');
  if (!batt.pluggedIn && batt.pct <= 15) help.push(`Battery at ${batt.pct}%: the Mac sleeps below 15% to keep some charge. Plug it in to keep it reachable.`);
  if (lidState === 'closed' && !(cfg.away && awayAllowed)) help.push('The lid is closed and away mode is off, so the Mac will sleep: seer away on.');
  return { at: Date.now(), battery: { ...batt, drainPerHour: batt.pluggedIn ? null : drainRate(awake.mode) }, lid: lidState, network: netw, awake, agentsBusy, hotspot, help };
}
