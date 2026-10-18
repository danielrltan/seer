// What keeps the Mac awake (with away mode on), so it sleeps whenever nothing needs it:
//   plugged in             always (battery is not the concern)
//   an agent is working    Claude Code hooks mark a session busy on each prompt and idle when it stops (seer hook)
//   you are watching       a desktop stream or Mac view viewer, or Seer home being opened
//   the reachable window   REACHABLE_MIN minutes after the last of those, so you can come back and check
// After that the Mac sleeps normally. Nothing can wake a sleeping Mac from the phone; the window is the answer.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, loadConfig } from './store.js';

const AGENTS = path.join(HOME, 'agents');
const STALE_MS = 6 * 3600_000;          // a "busy" mark this old is a session that died without its Stop hook
let lastSeen = 0;

export const seen = () => { lastSeen = Date.now(); };

// Called by the Claude Code hooks: `seer hook busy|idle`, the hook's JSON (session_id) on stdin. Never fails.
export function recordHook(state, input) {
  try {
    let id = 'unknown';
    try { id = String(JSON.parse(input || '{}').session_id || 'unknown').replace(/[^\w-]/g, '').slice(0, 80) || 'unknown'; } catch {}
    fs.mkdirSync(AGENTS, { recursive: true });
    const file = path.join(AGENTS, `${id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ state, at: Date.now() }));
    fs.renameSync(`${file}.tmp`, file);
  } catch {}
}

function agents() {
  const now = Date.now(), out = { busy: 0, lastAt: 0 };
  let files = [];
  try { files = fs.readdirSync(AGENTS).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(AGENTS, f), 'utf8'));
      if (a.state === 'busy' && now - a.at < STALE_MS) out.busy++;
      out.lastAt = Math.max(out.lastAt, a.at);
      if (now - a.at > 7 * 24 * 3600_000) fs.unlinkSync(path.join(AGENTS, f));   // tidy week-old marks
    } catch {}
  }
  return out;
}

// { awake, why, agentsBusy, reachableUntil }
export function awakeReason({ pluggedIn, watching }) {
  const now = Date.now(), reachableMs = (loadConfig().reachableMin ?? 30) * 60_000;
  if (watching) lastSeen = now;
  const a = agents();
  if (a.busy) lastSeen = Math.max(lastSeen, now);
  const last = Math.max(lastSeen, a.lastAt), until = last + reachableMs;
  const why = pluggedIn ? 'plugged in'
    : watching ? 'you are watching'
    : a.busy ? `${a.busy} agent${a.busy > 1 ? 's' : ''} working`
    : now < until ? `reachable for ${Math.ceil((until - now) / 60_000)} more min`
    : null;
  return { awake: !!why, why: why || 'nothing needs it: sleeping to save battery', agentsBusy: a.busy, reachableUntil: last ? until : 0 };
}
