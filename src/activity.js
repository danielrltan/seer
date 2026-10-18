// What keeps the Mac awake (with away mode on), so it sleeps whenever nothing needs it:
//   stay awake             the owner asked from Seer home (the slider): until that time, whatever else is true
//   an agent is working    Claude Code's own status for each live session (agents.js): busy through the turn and
//                          through background subagents, workflows and shells that outlive it. The hooks
//                          (UserPromptSubmit busy, Notification waiting, Stop idle) kick Seer the moment a turn
//                          starts and stand in for a session that has no sessions file
//   you are watching       a desktop stream or Mac view viewer, or Seer home being opened
//   the reachable window   with the lid closed only: reachableMin (15) minutes after the last of those, waiting
//                          included, so the owner can answer or check from the phone. For an agent the window
//                          starts when the last one really finished (its status went idle), not when a turn ended
//                          with work still running; an agent stuck on a prompt no longer holds the Mac up for hours
// Nothing else. With the lid open and none of these, Seer holds nothing and the Mac's own display and idle sleep
// apply as if Seer were not there; someone at the keyboard is "in use", which the Mac handles itself.
// Nothing can wake a sleeping Mac from the phone; the window and the slider are the answer. While awake with the
// lid closed and nobody watching or at it, the Mac is "headless" and saves all it can.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, loadConfig } from './store.js';
import { settings } from './settings.js';
import { claudeSessions, bySession, sessionActivity, lastWrite, QUIET_MS } from './agents.js';

const AGENTS = path.join(HOME, 'agents');
const HOOK_CAP = 12 * 3600_000;         // a hook-only "busy" this old is a runaway or a session that died without Stop
const GRACE_MS = 2 * 60_000;            // a prompt's hook can land before Claude rewrites its sessions file
const STARTUP_MS = 10_000;              // idle since it opened: never ran, so it did not "finish"
let lastSeen = 0, lastWorking = 0;

export const seen = () => { lastSeen = Date.now(); };

// Notifications that mean the session itself is blocked on the owner. The rest (idle_prompt "waiting for your
// input" after a Stop, agent_completed and agent_needs_input about other sessions, auth, computer use, push)
// leave the mark as it is.
const NEEDS_YOU = ['permission_prompt', 'worker_permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog'];

// Called by the Claude Code hooks: `seer-hook busy|waiting|idle`, the hook's JSON (session_id, transcript_path,
// notification_type) on stdin. Never fails.
export function recordHook(state, input) {
  try {
    let h = {};
    try { h = JSON.parse(input || '{}') || {}; } catch {}
    if (state === 'waiting' && typeof h.notification_type === 'string' && !NEEDS_YOU.includes(h.notification_type)) return;
    const id = String(h.session_id || 'unknown').replace(/[^\w-]/g, '').slice(0, 80) || 'unknown';
    const mark = { state, at: Date.now() };
    if (typeof h.transcript_path === 'string' && path.isAbsolute(h.transcript_path) && h.transcript_path.length < 1024) mark.transcript = h.transcript_path;
    fs.mkdirSync(AGENTS, { recursive: true });
    const file = path.join(AGENTS, `${id}.json`);
    fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(mark));
    fs.renameSync(`${file}.${process.pid}.tmp`, file);
  } catch {}
}

function hookMarks(now) {
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(AGENTS).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(AGENTS, f), 'utf8'));
      if (now - a.at > 7 * 24 * 3600_000) { fs.unlinkSync(path.join(AGENTS, f)); continue; }   // tidy week-old marks
      if (typeof a.at === 'number') out.set(f.slice(0, -5), a);
    } catch {}
  }
  return out;
}

// { busy, waiting, lastAt }: sessions working, sessions waiting on the owner, and the newest moment an agent
// finished or began waiting (the reachable window counts from it). One session counts once, from the best source:
//   a sessions file with a live process   its status (agents.js), whatever the hook says, except that a hook
//                                         "busy" newer than the status counts for 2 minutes (the fast path)
//   a sessions file whose process is gone not working and not waiting, whatever the hook says
//   no sessions file (hook only)          busy while written to in the last hour and under 12 h old, waiting
//                                         under an hour old
function agents(now) {
  const out = { busy: 0, waiting: 0, lastAt: 0 };
  const all = claudeSessions(now), sessions = bySession(all), marks = hookMarks(now);
  const at = t => { out.lastAt = Math.max(out.lastAt, t || 0); };
  for (const s of all) {                                              // a file with no session id: its status alone
    if (s.sessionId || !s.live) continue;
    const { working, waiting } = sessionActivity(s, now);
    out.busy += working; out.waiting += waiting;
    if (s.status !== 'idle' || s.since - s.startedAt > STARTUP_MS) at(s.since);
  }
  for (const [id, s] of sessions) {
    const h = marks.get(id);
    marks.delete(id);
    if (!s.live) { at(Math.min(s.since, now)); if (h) at(h.at); continue; }
    let { working, waiting } = sessionActivity(s, now, h?.transcript);
    if (!working && !waiting && h?.state === 'busy' && h.at > s.since && now - h.at < GRACE_MS) working = true;
    if (working) out.busy++;
    if (waiting) out.waiting++;
    if (s.status !== 'idle' || s.since - s.startedAt > STARTUP_MS) at(s.since);
    if (h && h.state !== 'busy') at(h.at);
  }
  for (const [, h] of marks) {                                        // sessions with no sessions file
    const age = now - h.at;
    if (h.state === 'busy' && age < HOOK_CAP && now - Math.max(h.at, lastWrite(h.transcript, now)) < QUIET_MS) out.busy++;
    else if (h.state === 'waiting' && age < QUIET_MS) out.waiting++;
    at(h.at);
  }
  out.lastAt = Math.min(out.lastAt, now);
  return out;
}

// { awake, why, inUse, agentsBusy, agentsWaiting, reachableUntil, stayUntil }
export function awakeReason({ watching, lidClosed, inUse }) {
  const cfg = loadConfig(), set = settings(cfg), now = Date.now(), reachableMs = set.reachableMin * 60_000;
  if (watching) lastSeen = now;
  const a = set.agentsKeepAwake ? agents(now) : { busy: 0, waiting: 0, lastAt: 0 };   // the owner can turn agents off as a reason
  if (a.busy) lastWorking = now;
  // An agent's moment: now while one works, else when the last finished or began waiting. lastWorking covers one
  // that stopped counting without a finish time (its process died, or it hit a cap) while Seer was watching.
  const agentAt = set.agentsKeepAwake ? Math.max(a.lastAt, lastWorking) : 0;
  let last = Math.max(lastSeen, agentAt);
  if (last <= (cfg.sleptAt || 0)) last = 0;                   // "Sleep now" ended the window: only newer activity counts
  const until = last + reachableMs;
  const stayUntil = cfg.stayAwakeUntil > now ? cfg.stayAwakeUntil : 0;
  const clock = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const why = stayUntil ? `until ${clock(stayUntil)}`
    : watching ? 'streaming'
    : a.busy ? `${a.busy} agent${a.busy > 1 ? 's' : ''} working`
    : lidClosed && now < until ? (a.waiting ? 'an agent needs you' : agentAt >= lastSeen ? 'agent finished' : 'you checked in')
    : null;
  return { awake: !!why, why: why || '', inUse: !!inUse, agentsBusy: a.busy, agentsWaiting: a.waiting, reachableUntil: lidClosed && last ? until : 0, stayUntil };
}
