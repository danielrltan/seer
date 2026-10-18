// node test/activity.test.mjs: when an agent counts as working, and when the reachable window starts, against a
// fake ~/.seer and ~/.claude in a temp folder, with real live and dead pids (sleep children).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'seer-activity-'));
process.env.SEER_HOME = path.join(T, 'seer');
process.env.SEER_CLAUDE_SESSIONS = path.join(T, 'claude', 'sessions');
process.env.SEER_CLAUDE_TMP = path.join(T, 'claudetmp');
const SESS = process.env.SEER_CLAUDE_SESSIONS, MARKS = path.join(T, 'seer', 'agents');
const PROJ = path.join(T, 'claude', 'projects'), CWD = '/Users/someone/proj', SLUG = '-Users-someone-proj';

const kids = [];
const live = () => { const c = spawn('sleep', ['300'], { stdio: 'ignore' }); kids.push(c); return c.pid; };
const cleanup = () => { for (const c of kids) try { c.kill('SIGKILL'); } catch {} try { fs.rmSync(T, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);
const lstart = pid => execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, encoding: 'utf8' }).trim();
async function deadPid() {
  const c = spawn('sleep', ['300'], { stdio: 'ignore' });
  const pid = c.pid; c.kill('SIGKILL');
  await new Promise(r => c.on('exit', r));
  return pid;
}

const MIN = 60_000, H = 3600_000;
let n = 0;
const sid = () => `0000000${++n}-aaaa-bbbb-cccc-dddddddddddd`;
function reset(cfg = {}) {
  fs.rmSync(path.join(T, 'seer'), { recursive: true, force: true });
  fs.rmSync(path.join(T, 'claude'), { recursive: true, force: true });
  fs.rmSync(path.join(T, 'claudetmp'), { recursive: true, force: true });
  fs.mkdirSync(SESS, { recursive: true }); fs.mkdirSync(MARKS, { recursive: true });
  fs.writeFileSync(path.join(T, 'seer', 'config.json'), JSON.stringify({ reachableMin: 15, ...cfg }));
}
// A Claude Code sessions file, as Claude writes it.
function session({ pid, id, status, since, startedAt = Date.now() - 2 * H, procStart }) {
  fs.writeFileSync(path.join(SESS, `${pid}.json`), JSON.stringify({
    pid, sessionId: id, cwd: CWD, startedAt, procStart: procStart ?? lstart(pid), version: '2.1.302', kind: 'interactive',
    entrypoint: 'cli', name: `s-${String(id).slice(7, 8)}`, status, updatedAt: since, statusUpdatedAt: since,
  }));
}
const mark = (id, state, at, extra = {}) => fs.writeFileSync(path.join(MARKS, `${id}.json`), JSON.stringify({ state, at, ...extra }));
// A file under a session's transcript folder, last written at `at`.
function wrote(id, rel, at) {
  const f = rel === 'main' ? path.join(PROJ, SLUG, `${id}.jsonl`) : path.join(PROJ, SLUG, id, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '{}\n');
  fs.utimesSync(f, new Date(at), new Date(at));
  return f;
}
const fresh = async () => import(`../src/activity.js?t=${++n}`);
async function reason(opts = {}) {
  const m = await fresh();
  return m.awakeReason({ watching: false, lidClosed: true, inUse: false, ...opts });
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 2000, `${msg}: ${a} vs ${b}`);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('background work after Stop: hook idle, sessions busy -> working, no countdown', async () => {
  reset(); const now = Date.now(), id = sid();
  session({ pid: live(), id, status: 'busy', since: now - 20 * MIN });
  mark(id, 'idle', now - 19 * MIN);
  const r = await reason();
  assert.equal(r.why, '1 agent active'); assert.equal(r.awake, true); assert.equal(r.agentsBusy, 1);
  near(r.reachableUntil, now + 15 * MIN, 'window held open at now while working');
});

test('background shell after Stop (status shell) -> working', async () => {
  reset(); const now = Date.now(), id = sid();
  session({ pid: live(), id, status: 'shell', since: now - 30 * MIN });
  mark(id, 'idle', now - 30 * MIN);
  assert.equal((await reason()).why, '1 agent active');
});

test('all idle -> countdown from the real finish (status went idle), not the Stop hook', async () => {
  reset(); const now = Date.now(), id = sid(), done = now - 5 * MIN;
  session({ pid: live(), id, status: 'idle', since: done });
  mark(id, 'idle', now - 40 * MIN);                                    // the turn ended long before the work did
  const r = await reason();
  assert.equal(r.why, 'agent finished'); assert.equal(r.agentsBusy, 0);
  assert.equal(r.reachableUntil, done + 15 * MIN);
  const open = await reason({ lidClosed: false });                    // the lid makes no difference: power.js holds it open
  assert.equal(open.why, 'agent finished'); assert.equal(open.reachableUntil, done + 15 * MIN);
});

test('finished 20 minutes ago, lid closed -> nothing', async () => {
  reset(); const now = Date.now(), id = sid();
  session({ pid: live(), id, status: 'idle', since: now - 20 * MIN });
  const r = await reason();
  assert.equal(r.awake, false); assert.equal(r.why, '');
});

test('a session that was only opened (idle since start) did not "finish"', async () => {
  reset(); const now = Date.now(), id = sid();
  session({ pid: live(), id, status: 'idle', since: now - 2 * MIN, startedAt: now - 2 * MIN - 500 });
  assert.equal((await reason()).awake, false);
});

test('dead pid with a busy file (and a busy hook) -> not working', async () => {
  reset(); const now = Date.now(), id = sid();
  session({ pid: await deadPid(), id, status: 'busy', since: now - 40 * MIN, procStart: 'Sat Oct 17 18:35:11 2026' });
  mark(id, 'busy', now - 40 * MIN);
  const r = await reason();
  assert.equal(r.agentsBusy, 0); assert.equal(r.awake, false);
});

test('pid reused (procStart differs) -> not working, even with a fresh hook busy', async () => {
  reset(); const now = Date.now(), id = sid(), pid = live();
  const wrong = lstart(pid).replace(/\d\d:\d\d:\d\d/, t => (t === '00:00:00' ? '00:00:01' : '00:00:00'));
  session({ pid, id, status: 'busy', since: now - 40 * MIN, procStart: wrong });
  mark(id, 'busy', now - 30_000);
  const r = await reason();
  assert.equal(r.agentsBusy, 0);
  assert.notEqual(r.why, '1 agent active');
});

test('waiting on a prompt -> "an agent needs you" for the window from when it began waiting, never holding longer', async () => {
  reset(); const now = Date.now(), id = sid(), at = now - 3 * MIN;
  session({ pid: live(), id, status: 'waiting', since: at });
  mark(id, 'busy', now - 10 * MIN);
  let r = await reason();
  assert.equal(r.why, 'an agent needs you'); assert.equal(r.agentsWaiting, 1); assert.equal(r.agentsBusy, 0);
  assert.equal(r.reachableUntil, at + 15 * MIN);
  assert.equal((await reason({ lidClosed: false })).why, 'an agent needs you');
  reset(); session({ pid: live(), id: sid(), status: 'waiting', since: now - 20 * MIN });
  r = await reason();
  assert.equal(r.awake, false); assert.equal(r.agentsWaiting, 1);
});

test('waiting on a prompt while its background subagents keep writing -> still working', async () => {
  reset(); const now = Date.now(), id = sid();
  session({ pid: live(), id, status: 'waiting', since: now - 30 * MIN });
  wrote(id, 'subagents/agent-a1.jsonl', now - MIN);
  const r = await reason();
  assert.equal(r.why, '1 agent active'); assert.equal(r.agentsWaiting, 1);
});

test('long busy stretch: working while anything is written, stuck after an hour of silence, capped at 12 h', async () => {
  reset(); let now = Date.now(), id = sid();
  session({ pid: live(), id, status: 'busy', since: now - 3 * H });
  wrote(id, 'subagents/workflows/wf_1/agent-a2.jsonl', now - 5 * MIN);
  assert.equal((await reason()).why, '1 agent active');
  reset(); id = sid();
  session({ pid: live(), id, status: 'busy', since: now - 3 * H });
  wrote(id, 'main', now - 2 * H);
  let r = await reason();
  assert.equal(r.agentsBusy, 0); assert.equal(r.awake, false);
  reset(); id = sid();
  session({ pid: live(), id, status: 'busy', since: now - 13 * H });
  wrote(id, 'main', now - MIN);
  assert.equal((await reason()).agentsBusy, 0);
  reset(); id = sid();                                                 // a background shell left running: 3 h cap
  session({ pid: live(), id, status: 'shell', since: now - 4 * H });
  fs.mkdirSync(path.join(T, 'claudetmp', SLUG, id, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(T, 'claudetmp', SLUG, id, 'tasks', 'b1.output'), 'GET /\n');
  assert.equal((await reason()).agentsBusy, 0);
  reset(); id = sid();                                                 // a long silent-ish shell job writing output
  session({ pid: live(), id, status: 'shell', since: now - 2 * H });
  fs.mkdirSync(path.join(T, 'claudetmp', SLUG, id, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(T, 'claudetmp', SLUG, id, 'tasks', 'b2.output'), 'step 9\n');
  assert.equal((await reason()).agentsBusy, 1);
});

test('a session kept open for days (hundreds of old transcripts) still shows its newest write', async () => {
  reset(); const now = Date.now(), old = now - 3 * H;
  for (const [id, where] of [[sid(), 'tasks'], [sid(), 'workflow']]) {
    session({ pid: live(), id, status: 'busy', since: now - 2 * H });
    for (let i = 0; i < 300; i++) {
      wrote(id, `subagents/agent-old${i}.jsonl`, old); wrote(id, `subagents/agent-old${i}.meta.json`, now);
      wrote(id, `subagents/workflows/wf_${i % 40}/agent-w${i}.jsonl`, old); wrote(id, `tool-results/r${i}.txt`, old);
    }
    if (where === 'tasks') {
      const d = path.join(T, 'claudetmp', SLUG, id, 'tasks');
      fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'bx.output'), 'building\n');
    } else wrote(id, 'subagents/workflows/wf_zz_late/agent-new.jsonl', now - 2 * MIN);
  }
  assert.equal((await reason()).why, '2 agents active');
});

test('a live sessions file with no session id counts by its status', async () => {
  reset(); const now = Date.now();
  session({ pid: live(), id: null, status: 'busy', since: now - 5 * MIN });
  assert.equal((await reason()).why, '1 agent active');
});

test('hook busy newer than an idle sessions file: fast path for 2 minutes, then the file decides', async () => {
  reset(); const now = Date.now(), id = sid();
  session({ pid: live(), id, status: 'idle', since: now - 10 * MIN });
  mark(id, 'busy', now - 30_000);
  assert.equal((await reason()).agentsBusy, 1);
  mark(id, 'busy', now - 5 * MIN);
  const r = await reason();
  assert.equal(r.agentsBusy, 0); assert.equal(r.why, 'agent finished');
});

test('two files for one session: dead busy one and live idle one -> idle', async () => {
  reset(); const now = Date.now(), id = sid();
  session({ pid: await deadPid(), id, status: 'busy', since: now - 3 * MIN, procStart: 'x' });
  session({ pid: live(), id, status: 'idle', since: now - 4 * MIN });
  const r = await reason();
  assert.equal(r.agentsBusy, 0); assert.equal(r.why, 'agent finished');
});

test('hook-only sessions (no sessions file): busy, idle, stale, written-to, capped', async () => {
  const now = Date.now();
  reset(); mark(sid(), 'busy', now - 10 * MIN);
  assert.equal((await reason()).why, '1 agent active');
  reset(); mark(sid(), 'busy', now - 2 * H);
  assert.equal((await reason()).awake, false);
  reset(); let id = sid(); mark(id, 'busy', now - 2 * H, { transcript: wrote(id, 'main', now - 2 * MIN) });
  assert.equal((await reason()).agentsBusy, 1);
  reset(); id = sid(); mark(id, 'busy', now - 13 * H, { transcript: wrote(id, 'main', now - 2 * MIN) });
  assert.equal((await reason()).agentsBusy, 0);
  reset(); mark(sid(), 'idle', now - 5 * MIN);
  let r = await reason();
  assert.equal(r.why, 'agent finished'); assert.equal(r.reachableUntil, now - 5 * MIN + 15 * MIN);
  reset(); mark(sid(), 'waiting', now - 5 * MIN);
  r = await reason();
  assert.equal(r.why, 'an agent needs you'); assert.equal(r.agentsWaiting, 1);
});

test('recordHook: only notifications that block on the owner become waiting; transcript kept', async () => {
  reset(); const m = await fresh(), id = sid();
  const input = extra => JSON.stringify({ session_id: id, transcript_path: '/x/y.jsonl', ...extra });
  m.recordHook('idle', input({ hook_event_name: 'Stop' }));
  const read = () => JSON.parse(fs.readFileSync(path.join(MARKS, `${id}.json`), 'utf8'));
  assert.equal(read().state, 'idle'); assert.equal(read().transcript, '/x/y.jsonl');
  m.recordHook('waiting', input({ notification_type: 'idle_prompt' }));
  assert.equal(read().state, 'idle');
  m.recordHook('waiting', input({ notification_type: 'agent_needs_input' }));
  assert.equal(read().state, 'idle');
  m.recordHook('waiting', input({ notification_type: 'permission_prompt' }));
  assert.equal(read().state, 'waiting');
  m.recordHook('busy', 'not json');
  assert.equal(JSON.parse(fs.readFileSync(path.join(MARKS, 'unknown.json'), 'utf8')).state, 'busy');
});

test('agentsKeepAwake off -> agents are no reason, not even the window', async () => {
  reset({ agentsKeepAwake: false }); const now = Date.now();
  session({ pid: live(), id: sid(), status: 'busy', since: now - 5 * MIN });
  session({ pid: live(), id: sid(), status: 'idle', since: now - MIN });
  const r = await reason();
  assert.equal(r.awake, false); assert.equal(r.agentsBusy, 0); assert.equal(r.reachableUntil, 0);
});

test('Sleep now: only activity after it counts', async () => {
  const now = Date.now();
  reset({ sleptAt: now - 2 * MIN });
  session({ pid: live(), id: sid(), status: 'idle', since: now - 5 * MIN });
  assert.equal((await reason()).awake, false);
  reset({ sleptAt: now - 2 * MIN });
  session({ pid: live(), id: sid(), status: 'idle', since: now - MIN });
  assert.equal((await reason()).why, 'agent finished');
});

test('several sessions mixed: two working, one waiting, one idle, one dead', async () => {
  reset(); const now = Date.now(), a = sid(), b = sid();
  session({ pid: live(), id: a, status: 'busy', since: now - 5 * MIN }); mark(a, 'idle', now - 4 * MIN);
  session({ pid: live(), id: b, status: 'shell', since: now - 5 * MIN });
  session({ pid: live(), id: sid(), status: 'waiting', since: now - MIN });
  session({ pid: live(), id: sid(), status: 'idle', since: now - MIN });
  session({ pid: await deadPid(), id: sid(), status: 'busy', since: now - MIN, procStart: 'x' });
  const r = await reason();
  assert.equal(r.why, '2 agents active'); assert.equal(r.agentsBusy, 2); assert.equal(r.agentsWaiting, 1);
  const { runningAgents } = await import('../src/agents.js');
  const list = runningAgents();
  assert.equal(list.length, 4);
  assert.deepEqual(list.map(x => [x.busy, x.waiting]), [[true, false], [true, false], [false, true], [false, false]]);
  for (const x of list) assert.deepEqual(Object.keys(x).sort(), ['busy', 'dir', 'kind', 'name', 'since', 'url', 'waiting']);
});

test('lid open: the window applies as closed; working still holds; inUse passes through and never feeds the window', async () => {
  reset(); const now = Date.now();
  session({ pid: live(), id: sid(), status: 'idle', since: now - MIN });
  let r = await reason({ lidClosed: false, inUse: true });
  assert.equal(r.why, 'agent finished'); assert.equal(r.inUse, true); assert.equal(r.reachableUntil, now - MIN + 15 * MIN);
  session({ pid: live(), id: sid(), status: 'busy', since: now - MIN });
  r = await reason({ lidClosed: false });
  assert.equal(r.why, '1 agent active'); assert.equal(r.inUse, false);
  reset(); const m = await fresh();                                    // someone typing for an hour: no window of its own
  for (let i = 0; i < 3; i++) r = m.awakeReason({ watching: false, inUse: true });
  assert.equal(r.awake, false); assert.equal(r.reachableUntil, 0);
});

test('a restart keeps the window: "you checked in" and a working agent that died without a finish time', async () => {
  reset(); let m = await fresh();
  m.seen(); m.awakeReason({ watching: false, inUse: false });
  m = await fresh();                                                   // a new daemon: nothing in memory
  assert.equal(m.awakeReason({ watching: false, inUse: false }).why, 'you checked in');
  reset(); m = await fresh(); const pid = live();
  session({ pid, id: sid(), status: 'busy', since: Date.now() - 30 * MIN });
  assert.equal(m.awakeReason({ watching: false, inUse: false }).agentsBusy, 1);
  process.kill(pid, 'SIGKILL');
  await new Promise(r => setTimeout(r, 200));
  m = await fresh();
  const r = m.awakeReason({ watching: false, inUse: false });
  assert.equal(r.agentsBusy, 0); assert.equal(r.why, 'agent finished');
  near(r.reachableUntil, Date.now() + 15 * MIN, 'from the last tick it worked, before the restart');
  const kept = () => JSON.parse(fs.readFileSync(path.join(T, 'seer', 'activity.json'), 'utf8'));
  m.seen(); m.awakeReason({ watching: false, inUse: false });         // the first check-in is written at once
  const before = kept();
  near(before.seenAt, Date.now(), 'written');
  m.seen(); m.awakeReason({ watching: false, inUse: false });         // a poll a few seconds later writes nothing
  assert.deepEqual(kept(), before);
});

test('kept moments: Sleep now still cuts them; ones from a clock set back count for nothing', async () => {
  const now = Date.now(), keep = v => fs.writeFileSync(path.join(T, 'seer', 'activity.json'), JSON.stringify(v));
  reset({ sleptAt: now - 30_000 }); keep({ seenAt: now - MIN, workedAt: now - 2 * MIN });
  assert.equal((await reason()).awake, false);
  reset(); keep({ seenAt: now + 3 * H, workedAt: now + 3 * H });
  let r = await reason();
  assert.equal(r.awake, false); assert.equal(r.reachableUntil, 0);
  reset({ stayAwakeUntil: now + 20 * H });                            // the slider goes to 12 h: this is a clock set back
  r = await reason();
  assert.equal(r.awake, false); assert.equal(r.stayUntil, 0);
  reset(); session({ pid: live(), id: sid(), status: 'idle', since: now + 3 * H });
  assert.equal((await reason()).awake, false);
});

test('the rest of the order: stay awake > streaming > working; you checked in', async () => {
  const now = Date.now();
  reset({ stayAwakeUntil: now + H });
  session({ pid: live(), id: sid(), status: 'busy', since: now - MIN });
  let r = await reason({ watching: true });
  assert.match(r.why, /^until /); assert.equal(r.stayUntil, now + H);
  reset(); session({ pid: live(), id: sid(), status: 'busy', since: now - MIN });
  assert.equal((await reason({ watching: true })).why, 'streaming');
  reset(); const m = await fresh();
  m.seen();
  r = m.awakeReason({ watching: false, lidClosed: true, inUse: false });
  assert.equal(r.why, 'you checked in');
  reset();
  assert.deepEqual(Object.keys(await reason()).sort(), ['agentsBusy', 'agentsWaiting', 'awake', 'inUse', 'reachableUntil', 'stayUntil', 'why']);
});

test('a session that stops working without a finish time still gets the window (from the last tick it worked)', async () => {
  reset(); const now = Date.now(), m = await fresh(), pid = live();
  session({ pid, id: sid(), status: 'busy', since: now - 30 * MIN });
  assert.equal(m.awakeReason({ watching: false, lidClosed: true, inUse: false }).agentsBusy, 1);
  process.kill(pid, 'SIGKILL');
  await new Promise(r => setTimeout(r, 200));
  const r = m.awakeReason({ watching: false, lidClosed: true, inUse: false });
  assert.equal(r.agentsBusy, 0); assert.equal(r.why, 'agent finished');
});

let failed = 0;
try {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
  }
} finally { cleanup(); }
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exitCode = failed ? 1 : 0;
