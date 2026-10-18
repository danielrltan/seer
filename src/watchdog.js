// Seer's watchdog, started detached by each daemon with that daemon's pid: `node watchdog.js <pid>`. When the daemon
// is gone (crashed, killed, or quit) it waits 45 s, longer than Seer.app takes to restart it, and if no new daemon
// has taken over awake.json by then, it puts back what the journals say Seer did: sleep allowed again, Low Power
// Mode off, apps thawed, sound on. So nothing Seer did outlives Seer. Its command line never matches
// `seer.js daemon`, so a deploy's pkill leaves it to do its job.
import fs from 'node:fs';
import path from 'node:path';
import { LOGS } from './store.js';
import { journal, release } from './awake.js';
import { thawAll, unmuteOutput } from './headless.js';

const pid = Number(process.argv[2]), GRACE_MS = 45_000;
const alive = p => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const wait = ms => new Promise(r => setTimeout(r, ms));
const log = msg => { try { fs.appendFileSync(path.join(LOGS, 'daemon.log'), `${new Date().toISOString()} watchdog: ${msg}\n`); } catch {} };

if (Number.isInteger(pid) && pid > 1) {
  while (alive(pid)) await wait(2000);
  await wait(GRACE_MS);
  const j = journal();
  if (!(j.pid && j.pid !== pid && alive(j.pid))) {
    await thawAll(log).catch(e => log(`thaw: ${e.message}`));          // logs only if anything was frozen
    await unmuteOutput().catch(() => {});
    if (j.sleepDisabledByUs || j.lowPowerByUs) {
      log(`daemon ${pid} is gone and none took over: ${(await release().catch(() => false)) ? 'sleep allowed again' : 'pmset could not allow sleep again'}`);
    }
  }
}
process.exit(0);
