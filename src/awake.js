// Away mode: keep the Mac (and its tunnel) up with the lid closed while a preview is running, and fail over to
// a phone hotspot when the Wi-Fi goes. `pmset -a disablesleep 1` is the one setting that outlasts closing the
// lid; it runs through a sudoers rule that allows only four pmset commands. Battery floors keep a closed Mac
// in a bag from running itself flat, and the hotspot is joined by a small CoreWLAN helper (seer-wifi).
//
// Seer only undoes what it did: awake.json records whether IT turned disablesleep / Low Power Mode on.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { HOME, loadConfig } from './store.js';

const SUDO = '/usr/bin/sudo', PMSET = '/usr/bin/pmset', SECURITY = '/usr/bin/security';
export const WIFI_HELPER = process.env.SEER_APP || path.join(HOME, 'bin', 'seer-wifi');
// Inside Seer.app the helper is the app itself (`Seer wifi ...`); standalone, the seer-wifi binary.
export const wifiArgs = args => (process.env.SEER_APP ? ['wifi', ...args] : args);
const JOURNAL = path.join(HOME, 'awake.json');
// % on battery. Low Power Mode at 30% stretches what is left; at 15% the Mac is let sleep, which still leaves
// enough to open it and get back online later. Low Power Mode comes off again above 35% (or on power).
const LOW_POWER_BELOW = 30, RELEASE_BELOW = 15, RESTORE_ABOVE = 35;
export const SUDOERS_FILE = '/etc/sudoers.d/seer';

function run(file, args, { input, timeout = 15_000 } = {}) {
  return new Promise(resolve => {
    const child = execFile(file, args, { timeout }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
    if (input !== undefined) { child.stdin.end(input); }
  });
}

const journal = () => { try { return JSON.parse(fs.readFileSync(JOURNAL, 'utf8')); } catch { return {}; } };
const saveJournal = j => fs.writeFileSync(JOURNAL, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });

export function sudoersRule(user) {
  const cmds = ['-a disablesleep 1', '-a disablesleep 0', '-b lowpowermode 1', '-b lowpowermode 0'].map(a => `${PMSET} ${a}`);
  return `# Seer away mode: only these four pmset commands, without a password\n${user} ALL=(root) NOPASSWD: ${cmds.join(', ')}\n`;
}
export const ruleInstalled = async () => (await run(SUDO, ['-n', '-l', PMSET, '-a', 'disablesleep', '1'])).code === 0;

export async function sleepDisabled() {
  const { stdout } = await run(PMSET, ['-g']);
  return /^\s*SleepDisabled\s+1\b/m.test(stdout);
}
export async function battery() {
  const { stdout } = await run(PMSET, ['-g', 'batt']);
  const pct = Number((stdout.match(/(\d+)%/) || [])[1]);
  return { onBattery: /'Battery Power'/.test(stdout), pct: Number.isFinite(pct) ? pct : 100 };
}
async function lowPowerOn() {
  const { stdout } = await run(PMSET, ['-g', 'custom']);
  const section = stdout.split(/^AC Power:/m)[0];                     // the Battery Power: block comes first
  return /lowpowermode\s+1\b/.test(section);
}
const pm = args => run(SUDO, ['-n', PMSET, ...args]);

// Called by the daemon every tick: wantAwake (activity.js), and headless (lid closed, nobody streaming, no agent
// working): then Low Power Mode goes on at any charge, not only below 30%, and comes off when streaming starts.
// Returns what away mode is doing.
export async function reconcile(wantAwake, { headless = false } = {}) {
  if (!(await ruleInstalled())) return { mode: 'sleeps with the lid closed', why: 'away mode not installed (seer away install)' };
  const j = journal(), b = await battery();
  let want = wantAwake, why = wantAwake ? 'a preview is running' : 'no preview running';
  if (want && b.onBattery && b.pct < RELEASE_BELOW) { want = false; why = `battery ${b.pct}%: letting the Mac sleep`; }

  const lowPower = want && b.onBattery && (headless || b.pct < LOW_POWER_BELOW);
  if (lowPower && !j.lowPowerByUs && !(await lowPowerOn())) {
    if ((await pm(['-b', 'lowpowermode', '1'])).code === 0) j.lowPowerByUs = true;
  } else if (j.lowPowerByUs && !lowPower && (!headless || !b.onBattery || b.pct >= RESTORE_ABOVE)) {
    if ((await pm(['-b', 'lowpowermode', '0'])).code === 0) j.lowPowerByUs = false;
  }

  const disabled = await sleepDisabled();
  if (want && !disabled) {
    const r = await pm(['-a', 'disablesleep', '1']);
    if (r.code === 0) j.sleepDisabledByUs = true;
    else why = `pmset failed: ${r.stderr.trim()}`;
  } else if (!want && disabled && j.sleepDisabledByUs) {
    if ((await pm(['-a', 'disablesleep', '0'])).code === 0) j.sleepDisabledByUs = false;
  }
  saveJournal(j);
  return { mode: !want ? 'normal sleep' : headless ? 'headless' : 'lid-closed awake', why, battery: b, lowPowerByUs: !!j.lowPowerByUs };
}

export async function release() {                                     // seer uninstall, daemon shutdown
  const j = journal();
  if (j.sleepDisabledByUs) await pm(['-a', 'disablesleep', '0']);
  if (j.lowPowerByUs) await pm(['-b', 'lowpowermode', '0']);
  saveJournal({});
}

// ---------- hotspot failover ----------
// The password lives in the login keychain (service dev.seer.hotspot), written and read by /usr/bin/security.
export async function savePassword(ssid, password) {
  const r = await run(SECURITY, ['add-generic-password', '-U', '-s', 'dev.seer.hotspot', '-a', ssid, '-w', password]);
  if (r.code) throw new Error(`could not save the hotspot password to the keychain: ${r.stderr.trim()}`);
}
const readPassword = async ssid => {
  const r = await run(SECURITY, ['find-generic-password', '-s', 'dev.seer.hotspot', '-a', ssid, '-w']);
  return r.code ? null : r.stdout.trim();
};

// A TCP handshake with Cloudflare (the path the tunnel needs), at either of its two resolver addresses.
export const online = async () => (await reach('1.1.1.1')) || (await reach('1.0.0.1'));
function reach(host) {
  return new Promise(resolve => {
    const s = net.connect({ host, port: 443 });
    s.setTimeout(3000);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

export async function joinHotspot() {
  const { hotspotSsid } = loadConfig();
  if (!hotspotSsid) return 'no hotspot set';
  if (!fs.existsSync(WIFI_HELPER)) return 'seer-wifi helper missing (seer away hotspot)';
  const pw = await readPassword(hotspotSsid);
  if (pw === null) return 'hotspot password missing from the keychain';
  const r = await run(WIFI_HELPER, wifiArgs(['join', hotspotSsid]), { input: pw + '\n', timeout: 60_000 });
  return r.stdout.trim() || r.stderr.trim() || `exit ${r.code}`;
}

// Offline for 20 s while away mode wants the Mac up: try the hotspot, then again after 5, 10, 20, 30, 30... s.
const BACKOFF = [5, 10, 20, 30];
// What the failover is doing, for Seer home: offline since when, and the last hotspot attempt.
export const netState = { downSince: null, joining: false, lastJoin: null };
export function failover(log) {
  let downSince = null, tries = 0, nextAt = 0;
  return async function check(active) {
    if (!active || !loadConfig().hotspotSsid) { downSince = null; netState.downSince = null; return; }
    if (await online()) {
      if (downSince) log(`back online after ${Math.round((Date.now() - downSince) / 1000)} s`);
      downSince = null; tries = 0; netState.downSince = null; return;
    }
    downSince ??= Date.now();
    netState.downSince = downSince;
    if (Date.now() - downSince < 20_000 || Date.now() < nextAt) return;
    netState.joining = true;
    const result = await joinHotspot();
    netState.joining = false; netState.lastJoin = { at: Date.now(), result };
    log(`offline ${Math.round((Date.now() - downSince) / 1000)} s; hotspot join: ${result}`);
    nextAt = Date.now() + BACKOFF[Math.min(tries++, BACKOFF.length - 1)] * 1000;
  };
}
