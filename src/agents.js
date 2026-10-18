// The Claude Code sessions running on this Mac, read from Claude Code's own bookkeeping: one small file per
// process in ~/.claude/sessions (pid, procStart, sessionId, folder, name, status, statusUpdatedAt, and with Remote
// Control on, the claude.ai session it is bridged to). It is not a published format, so anything missing or
// unreadable just counts for less. Used by Seer home (runningAgents) and by activity.js (is an agent working).
//
// Claude's status is the best signal there is. It is set from the session's real state, so it covers what the
// hooks miss: "busy" while the turn runs AND while background subagents or workflows it started still run after
// the turn ended (Stop has fired by then); "shell" when the turn ended but a background shell it started still
// runs; "waiting" on a permission prompt, a question or an open dialog; "idle" otherwise. statusUpdatedAt is when
// the status last changed, so for "idle" it is when the agent really finished.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Read at call time so tests (and a moved Claude config) can point elsewhere.
export const sessionsDir = () => process.env.SEER_CLAUDE_SESSIONS || path.join(os.homedir(), '.claude', 'sessions');
const projectsDir = () => path.join(path.dirname(sessionsDir()), 'projects');
const tmpDir = () => process.env.SEER_CLAUDE_TMP || `/private/tmp/claude-${process.getuid?.() ?? 0}`;

const STATUSES = ['busy', 'shell', 'idle', 'waiting'];
// Never a reason to stay awake forever: a stuck status (a hung task, a dev server left running in the background)
// must let the Mac sleep in the end, so nothing runs and bills all night.
export const QUIET_MS = 3600_000;            // working, but nothing written for an hour (status, transcripts, task output): stuck
const BUSY_CAP = 12 * 3600_000;              // one busy stretch this long is a runaway, whatever it writes
const SHELL_CAP = 3 * 3600_000;              // a background shell this long is a server or watcher, not a job
const BACKGROUND_MS = 10 * 60_000;           // waiting on the owner, but its subagents wrote this recently: still working

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Is pid still the process that wrote the file? A pid can be reused after a crash, so compare procStart with the
// process's start time, read exactly as Claude writes it (LC_ALL=C TZ=UTC, or the format and clock differ).
// The start of a running process never changes, so ps runs once per pid and again only every 10 minutes or after
// a gap in looking (the Mac slept, Seer restarted): a reuse needs the old process to die first, and death is seen
// by the cheap kill(pid, 0) on every look. If ps fails, the live pid is trusted.
const starts = new Map();                    // pid -> { start, at, seen }
const START_TTL = 10 * 60_000, START_GAP = 60_000;
function sameProcess(pid, procStart, now) {
  if (!alive(pid)) { starts.delete(pid); return false; }
  if (typeof procStart !== 'string' || !procStart.trim()) return true;          // older Claude: liveness alone
  let c = starts.get(pid);
  if (!c || now - c.at > START_TTL || now - c.seen > START_GAP) {
    let start = null;
    try {
      start = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null;
    } catch {}
    c = { start, at: now, seen: now };
    starts.set(pid, c);
  }
  c.seen = now;
  return c.start === null || c.start === procStart.trim();
}

const num = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

// Every sessions file, live or not (a dead one tells activity.js to disregard that session's hook marks).
export function claudeSessions(now = Date.now()) {
  const dir = sessionsDir();
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f)); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!Number.isInteger(s.pid) || s.pid <= 0 || `${s.pid}.json` !== f) continue;   // Claude ignores these too
      out.push({
        pid: s.pid, live: sameProcess(s.pid, s.procStart, now),
        sessionId: typeof s.sessionId === 'string' ? s.sessionId : null,
        status: STATUSES.includes(s.status) ? s.status : undefined,
        since: num(s.statusUpdatedAt) || num(s.updatedAt) || num(s.startedAt),
        startedAt: num(s.startedAt), cwd: typeof s.cwd === 'string' ? s.cwd : '',
        name: s.name, bridge: s.bridgeSessionId,
      });
    } catch {}
  }
  return out;
}

// One entry per session id: the live file first, then the newest status (a resumed session can leave two).
export function bySession(list) {
  const m = new Map();
  for (const s of list) {
    if (!s.sessionId) continue;
    const o = m.get(s.sessionId);
    if (!o || (s.live && !o.live) || (s.live === o.live && s.since > o.since)) m.set(s.sessionId, s);
  }
  return m;
}

// The newest write by a session: its transcript, its subagents' and workflows' transcripts, its background tasks'
// output. Only looked at for a long or unclear stretch, and cached a minute, so a tick stays a few file reads.
// main: false leaves out the session's own transcript (only what runs behind it).
const writes = new Map();                    // transcript path -> { at, value }
export function lastWrite(transcript, now = Date.now(), { main = true } = {}) {
  if (!transcript) return 0;
  const key = `${main ? 1 : 0}${transcript}`, c = writes.get(key);
  if (c && now - c.at < 60_000) return c.value;
  let value = 0;
  const mtime = p => { try { value = Math.max(value, fs.statSync(p).mtimeMs); } catch {} };
  // Each root has its own budget, so a session kept open for days (hundreds of old workflow transcripts; the
  // most seen is under 400 files) cannot crowd out the newest write. readdir order is not sorted on APFS.
  const look = (dir, depth, budget) => {
    const walk = (p, d) => {
      let ents = [];
      try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (--budget < 0) return;
        if (e.name === 'tool-results' || e.name.endsWith('.meta.json')) continue;   // never the newest real progress
        const q = path.join(p, e.name);
        if (e.isDirectory()) { if (d > 0) walk(q, d - 1); } else mtime(q);         // files, and tasks' symlinks
      }
    };
    walk(dir, depth);
  };
  const base = transcript.replace(/\.jsonl$/, '');
  look(path.join(tmpDir(), path.basename(path.dirname(transcript)), path.basename(base), 'tasks'), 0, 2000);   // background shells and agents
  look(path.join(base, 'subagents'), 2, 5000);                                                               // subagents/, subagents/workflows/<id>/
  if (main) mtime(transcript);
  writes.set(key, { at: now, value });
  if (writes.size > 200) writes.clear();
  return value;
}

// Where Claude keeps a session's transcript: projects/<cwd with every non-alphanumeric as "-">/<sessionId>.jsonl.
export const transcriptOf = s => (s.cwd && s.sessionId ? path.join(projectsDir(), s.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${s.sessionId}.jsonl`) : '');

// What a live session is doing, from its status: { working, waiting }.
//   busy / shell  working, unless the stretch passed its cap (12 h busy, 3 h background shell) or, after the first
//                 hour, nothing at all was written for an hour
//   waiting       waiting on the owner; also working if its subagents or background tasks wrote in the last 10
//                 minutes (a prompt in front does not stop the work behind it)
//   idle          neither
// transcript: the hook's exact path when there is one, else the usual place.
export function sessionActivity(s, now = Date.now(), transcript = '') {
  if (!s.live) return { working: false, waiting: false };
  const age = now - s.since, file = transcript || transcriptOf(s);
  if (s.status === 'busy' || s.status === 'shell') {
    if (age >= (s.status === 'shell' ? SHELL_CAP : BUSY_CAP)) return { working: false, waiting: false };
    if (age < QUIET_MS) return { working: true, waiting: false };
    return { working: now - Math.max(s.since, lastWrite(file, now)) < QUIET_MS, waiting: false };
  }
  if (s.status === 'waiting') {
    const w = lastWrite(file, now, { main: false });
    return { working: w > s.since && now - w < BACKGROUND_MS, waiting: true };
  }
  return { working: false, waiting: false };
}

export function runningAgents(now = Date.now()) {
  const all = claudeSessions(now).filter(s => s.live), one = bySession(all), out = [];
  for (const s of all) {
    if (s.sessionId && one.get(s.sessionId) !== s) continue;       // one row per session
    try {
      const { working, waiting } = sessionActivity(s, now);
      const bridge = typeof s.bridge === 'string' && /^session_[A-Za-z0-9]{8,64}$/.test(s.bridge) ? s.bridge : null;
      const dir = s.cwd && s.cwd !== os.homedir() ? s.cwd.replace(os.homedir(), '~') : '';
      out.push({
        name: String(s.name || 'session').slice(0, 60), dir: dir.slice(0, 80),
        busy: working, waiting, since: s.since,
        url: bridge ? `https://claude.ai/code/${bridge}` : null,
      });
    } catch {}
  }
  return out.sort((a, b) => (b.busy - a.busy) || (b.waiting - a.waiting) || (b.since - a.since));
}
