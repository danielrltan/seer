// What keeps the Mac awake (with away mode on), so it sleeps whenever nothing needs it:
//   stay awake             the owner asked from Seer home (the slider): until that time, whatever else is true
//   an agent is working    Claude Code hooks: busy on each prompt (UserPromptSubmit), waiting when it needs the
//                          owner (Notification: a permission prompt or a question), idle when it stops (Stop)
//   you are watching       a desktop stream or Mac view viewer, or Seer home being opened
//   the reachable window   reachableMin (15) minutes after the last of those, waiting included, so the owner can
//                          answer or check; an agent stuck on a prompt no longer holds the Mac up for hours
// After that the Mac sleeps. Nothing can wake a sleeping Mac from the phone; the window and the slider are the
// answer. While awake with the lid closed and nobody watching, the Mac is "headless" and saves all it can.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, loadConfig } from './store.js';
import { settings } from './settings.js';

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
  const now = Date.now(), out = { busy: 0, waiting: 0, lastAt: 0 };
  let files = [];
  try { files = fs.readdirSync(AGENTS).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(AGENTS, f), 'utf8'));
      if (a.state === 'busy' && now - a.at < STALE_MS) out.busy++;
      if (a.state === 'waiting' && now - a.at < STALE_MS) out.waiting++;
      out.lastAt = Math.max(out.lastAt, a.at);
      if (now - a.at > 7 * 24 * 3600_000) fs.unlinkSync(path.join(AGENTS, f));   // tidy week-old marks
    } catch {}
  }
  return out;
}

// { awake, why, agentsBusy, agentsWaiting, reachableUntil, stayUntil }
export function awakeReason({ pluggedIn, watching }) {
  const cfg = loadConfig(), set = settings(cfg), now = Date.now(), reachableMs = set.reachableMin * 60_000;
  if (watching) lastSeen = now;
  const a = agents();
  if (!set.agentsKeepAwake) { a.busy = 0; a.waiting = 0; a.lastAt = 0; }       // the owner turned agents off as a reason
  if (a.busy) lastSeen = Math.max(lastSeen, now);
  const last = Math.max(lastSeen, a.lastAt), until = last + reachableMs;
  const stayUntil = cfg.stayAwakeUntil > now ? cfg.stayAwakeUntil : 0;
  const clock = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const why = stayUntil ? `staying awake until ${clock(stayUntil)}`
    : watching ? 'you are watching'
    : a.busy ? `${a.busy} agent${a.busy > 1 ? 's' : ''} working`
    : now < until ? `${a.waiting ? 'an agent is waiting for you, ' : ''}reachable for ${Math.ceil((until - now) / 60_000)} more min`
    : null;
  return { awake: !!why, why: why || 'nothing needs it: sleeping to save battery', agentsBusy: a.busy, agentsWaiting: a.waiting, reachableUntil: last ? until : 0, stayUntil };
}
