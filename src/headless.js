// Headless: the lid is closed and the Mac stays awake for a reason (an agent, the stay-awake timer, the reachable
// window), but nobody is streaming. Then it spends as little as it can:
//   - the screen goes off at once: with sleep disabled, closing the lid no longer turns the panel off by itself
//   - heavy apps are frozen (SIGSTOP, the app and its helper processes) while no agent works, and thawed the
//     moment one does, or the lid opens, or a stream starts; terminals, editors, Claude, Docker, Xcode, dev
//     servers and Seer's own processes are never on the list
// Every freeze is written to frozen.json before the signal, so a crash or restart thaws them (thawAll on start).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { HOME, loadConfig } from './store.js';

const JOURNAL = path.join(HOME, 'frozen.json');
export const DEFAULT_FREEZE = [
  'com.google.Chrome', 'com.apple.Safari', 'com.spotify.client', 'com.tinyspeck.slackmacgap',
  'com.hnc.Discord', 'com.figma.Desktop', 'notion.id', 'com.microsoft.teams2',
];
const run = (file, args) => new Promise(resolve => execFile(file, args, { timeout: 5000 }, (err, out) => resolve(err ? '' : String(out))));

export function sleepDisplay() { execFile('/usr/bin/pmset', ['displaysleepnow'], () => {}); }

const journal = () => { try { return JSON.parse(fs.readFileSync(JOURNAL, 'utf8')); } catch { return { frozen: [] }; } };
const save = j => fs.writeFileSync(JOURNAL, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
export const frozenCount = () => journal().frozen.length;

async function startTime(pid) { return (await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)])).trim(); }

// The app's main process and everything under it (Chrome's renderers and helpers), never Seer's own Chrome.
async function appTree(bundleId) {
  const info = await run('/usr/bin/lsappinfo', ['info', '-only', 'pid', '-app', bundleId]);
  const main = Number((info.match(/"pid"\s*=\s*(\d+)/) || [])[1]);
  if (!main) return [];
  const rows = (await run('/bin/ps', ['-A', '-o', 'pid=,ppid=,command='])).split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(m => ({ pid: +m[1], ppid: +m[2], cmd: m[3] }));
  const out = [], queue = [main];
  while (queue.length) {
    const pid = queue.shift(), row = rows.find(r => r.pid === pid);
    if (!row || row.cmd.includes('/.seer/')) continue;
    out.push(pid);
    for (const r of rows) if (r.ppid === pid) queue.push(r.pid);
  }
  return out;
}

export async function freezeApps(log) {
  const j = journal(), list = loadConfig().freezeApps ?? DEFAULT_FREEZE, done = new Set(j.frozen.map(f => f.pid));
  let n = 0;
  for (const bundleId of list) {
    for (const pid of await appTree(bundleId)) {
      if (done.has(pid)) continue;
      j.frozen.push({ pid, start: await startTime(pid), app: bundleId });
      save(j);                                                    // journal first, then the signal
      try { process.kill(pid, 'SIGSTOP'); n++; } catch {}
    }
  }
  if (n) log(`headless: froze ${n} processes (${list.filter(b => j.frozen.some(f => f.app === b)).join(', ')})`);
}

export async function thawAll(log) {
  const j = journal();
  if (!j.frozen.length) return;
  let n = 0;
  for (const f of j.frozen) {
    if (f.start && (await startTime(f.pid)) !== f.start) continue;   // that pid is a different process now
    try { process.kill(f.pid, 'SIGCONT'); n++; } catch {}
  }
  save({ frozen: [] });
  log(`headless: thawed ${n} processes`);
}
