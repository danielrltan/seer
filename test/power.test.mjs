// The power decision (src/power.js) across the cases the owner cares about: what holds the Mac, what the page and
// the menu bar say, and what Seer does (caffeinate, sleep disabled, screen, freeze, mute, Low Power Mode).
// Pure: imports nothing that reads ~/.seer or touches the Mac. Run: node test/power.test.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { decide, sleptBetween, onWake, HOLD_OFF_MS } from '../src/power.js';
import { homePage } from '../src/home.js';

const T = 1_800_000_000_000, MIN = 60_000;
const SET = { reachableMin: 15, screenOff: true, freeze: true, mute: true, headlessLowPower: true, lowPowerBelow: 30, sleepBelow: 15 };
const WHY = { awake: false, why: '', agentsBusy: 0, agentsWaiting: 0, reachableUntil: 0, stayUntil: 0 };
// What awakeReason() returns in each situation (activity.js: a busy agent or a viewer refreshes the window).
const why = {
  none: WHY,
  busy: { ...WHY, awake: true, why: '1 agent active', agentsBusy: 1 },
  busyClosed: { ...WHY, awake: true, why: '1 agent active', agentsBusy: 1, reachableUntil: T + 15 * MIN },
  finished: { ...WHY, awake: true, why: 'agent finished', reachableUntil: T + 9 * MIN },
  waiting: { ...WHY, awake: true, why: 'an agent needs you', agentsWaiting: 1, reachableUntil: T + 12 * MIN },
  streaming: { ...WHY, awake: true, why: 'streaming', reachableUntil: T + 15 * MIN },
  streamingOpen: { ...WHY, awake: true, why: 'streaming' },
  stay: { ...WHY, awake: true, why: 'until 2:00 AM', stayUntil: T + 40 * MIN },
  stayClosed: { ...WHY, awake: true, why: 'until 2:00 AM', stayUntil: T + 40 * MIN, reachableUntil: T + 5 * MIN },
  expired: { ...WHY, reachableUntil: T - MIN },
};
const base = {
  now: T, lid: 'open', external: false, inUse: false, watching: false, why: why.none, set: SET, away: true, rule: true,
  pmsetOk: true, battery: { onBattery: false, pct: 100 }, holdOff: 0, sleepHold: null, backAt: 0, lowPowerByUs: false,
};
const run = over => decide({ ...base, ...over });
const bat = pct => ({ battery: { onBattery: true, pct } });

let passed = 0;
function check(name, over, expect) {
  const d = run(over);
  for (const [k, v] of Object.entries(expect)) {
    try { assert.deepEqual(d[k], v); }
    catch { throw new Error(`${name}: ${k} is ${JSON.stringify(d[k])}, expected ${JSON.stringify(v)}\n${JSON.stringify(d, null, 1)}`); }
  }
  invariants(name, over, d);
  passed++;
}

// Rules that must hold in every state: the display can never promise what the Mac will not do.
function invariants(name, over, d) {
  const i = { ...base, ...over }, closed = i.lid === 'closed' && !i.external, busy = i.why.agentsBusy > 0;
  const ok = (cond, what) => assert.ok(cond, `${name}: ${what}\n${JSON.stringify(d)}`);
  ok(d.caffeinate === d.running, 'caffeinate exactly while held');
  ok(!d.disableSleep || (d.running && i.away && i.rule), 'sleep disabled only while held, with away mode and the rule');
  ok(!d.lowPower || (d.running && i.battery.onBattery && i.away && i.rule), 'Low Power Mode only while held on battery');
  ok(!d.headless || (closed && !i.watching && !i.inUse && !busy), 'headless only with the lid closed, nobody there, no agent working');
  ok((d.label === 'Headless') === d.headless, 'the label says Headless exactly when headless');
  ok(d.running ? ['Awake', 'Headless'].includes(d.label) : !['Awake', 'Headless'].includes(d.label), 'Awake only when held');
  ok(!d.freeze && !d.mute || d.headless, 'apps frozen and sound off only when headless');
  ok(!d.countdown || d.running, 'a countdown only while held');
  ok(!d.countdown || d.countdown.until > i.now, 'a countdown is in the future');
  if (d.countdown?.kind === 'sleep') ok(closed && !i.watching && !busy && !i.why.stayUntil, 'to sleep only when only the reachable window holds it');
  ok(!(d.running && closed && !(i.away && i.rule && i.pmsetOk)), 'never held with the lid closed when sleep cannot be disabled');
  ok(!d.screenOff || (closed && !i.watching && !i.inUse), 'screen off only behind a closed lid nobody watches');
  ok(!d.failover || (d.running && closed), 'hotspot failover only with the lid closed');
  ok(!(i.lid === 'open' && !d.running && (d.disableSleep || d.caffeinate)), 'lid open and nothing needed: hold nothing');
}

// ---- lid open ----
check('lid open, nothing', {}, { running: false, label: 'Idle', why: '', countdown: null, disableSleep: false, notes: [] });
check('lid open, someone at it', { inUse: true }, { running: false, label: 'In use', caffeinate: false });
check('lid open, agent working: sleep disabled before the lid closes', { why: why.busy },
  { running: true, label: 'Awake', why: '1 agent active', disableSleep: true, countdown: null, headless: false, screenOff: false, notes: [] });
check('lid open, agent working, someone at it', { why: why.busy, inUse: true }, { running: true, label: 'Awake', headless: false });
check('lid open, streaming', { why: why.streamingOpen }, { running: true, label: 'Awake', countdown: null });
check('lid open, stay timer', { why: why.stay }, { running: true, countdown: { until: T + 40 * MIN, kind: 'stay' }, disableSleep: true });
check('lid open, agent working, away off', { why: why.busy, away: false },
  { running: true, disableSleep: false, closingSleeps: true, notes: ['Closing the lid will sleep it. Turn on Stay awake with the lid closed in Settings.'] });
check('lid open, agent working, no sudoers rule', { why: why.busy, rule: false },
  { running: true, disableSleep: false, closingSleeps: true, notes: ['Closing the lid will sleep it. Run seer away install on the Mac.'] });
check('lid open, stay timer, away off: the note too', { why: why.stay, away: false }, { closingSleeps: true });
check('lid open, pmset refused', { why: why.busy, pmsetOk: false },
  { running: true, disableSleep: false, notes: ['Closing the lid will sleep it: pmset could not disable sleep.'] });
check('lid open, nothing, away off: no note', { away: false, rule: false }, { notes: [], closingSleeps: false });
check('lid unknown (desktop Mac), agent working', { lid: 'unknown', why: why.busy }, { running: true, notes: [], closingSleeps: false, screenOff: false });

// ---- lid closed ----
check('THE BUG: lid closed while an agent works: awake, no sleep countdown', { lid: 'closed', why: why.busyClosed },
  { running: true, label: 'Awake', why: '1 agent active', countdown: null, headless: false, disableSleep: true, screenOff: true, freeze: false, mute: false });
check('lid closed, agent finished: headless, counting down', { lid: 'closed', why: why.finished },
  { running: true, label: 'Headless', countdown: { until: T + 9 * MIN, kind: 'sleep', from: T - 6 * MIN }, freeze: true, mute: true, lowPower: false, failover: true });
check('lid closed, agent waiting on the owner: the window still ends', { lid: 'closed', why: why.waiting },
  { running: true, label: 'Headless', countdown: { until: T + 12 * MIN, kind: 'sleep', from: T - 3 * MIN } });
check('lid closed, streaming: no countdown, screen on, nothing frozen', { lid: 'closed', why: why.streaming, watching: true },
  { running: true, label: 'Awake', why: 'streaming', countdown: null, headless: false, screenOff: false, freeze: false, mute: false });
check('lid closed, stay timer: headless, counting the stay', { lid: 'closed', why: why.stayClosed },
  { running: true, label: 'Headless', countdown: { until: T + 40 * MIN, kind: 'stay' } });
check('lid closed, window over', { lid: 'closed', why: why.expired }, { running: false, label: 'Sleeping', countdown: null, disableSleep: false });
check('lid closed, agent working, away off: macOS sleeps it, say so', { lid: 'closed', why: why.busyClosed, away: false },
  { running: false, label: 'Sleeping', caffeinate: false });
check('lid closed, agent working, no rule', { lid: 'closed', why: why.busyClosed, rule: false }, { running: false, label: 'Sleeping' });
check('lid closed, pmset refused', { lid: 'closed', why: why.busyClosed, pmsetOk: false }, { running: false, label: 'Sleeping' });
check('lid closed, external keyboard in use: never headless', { lid: 'closed', why: why.finished, inUse: true },
  { running: true, label: 'Awake', headless: false, freeze: false, screenOff: false });

// ---- closed on an external display (clamshell): a desk Mac ----
check('external display, idle, agent working', { lid: 'closed', external: true, why: why.busy },
  { running: true, label: 'Awake', headless: false, screenOff: false, freeze: false, failover: false, countdown: null, closingSleeps: false, notes: [] });
check('external display, nothing', { lid: 'closed', external: true }, { running: false, label: 'Idle', screenOff: false });

// ---- battery ----
check('below sleepBelow on battery: let it sleep, and say why', { lid: 'closed', why: why.busyClosed, ...bat(14) },
  { running: false, label: 'Sleeping', why: 'battery 14%', countdown: null, disableSleep: false, lowPower: false, notes: ['Battery 14%. Plug it in to keep it awake.'] });
check('below sleepBelow, stay timer: no countdown', { why: why.stay, ...bat(10) }, { running: false, countdown: null, label: 'Idle', why: 'battery 10%' });
check('below sleepBelow, in use', { why: why.busy, inUse: true, ...bat(12) }, { running: false, label: 'In use' });
check('below sleepBelow but plugged in', { lid: 'closed', why: why.busyClosed, battery: { onBattery: false, pct: 5 } }, { running: true });
check('below sleepBelow, nothing wanted: no note', { ...bat(12) }, { notes: [], why: '' });
check('near the floor', { lid: 'closed', why: why.busyClosed, ...bat(18) },
  { running: true, lowPower: true, notes: ['Battery 18%. It sleeps at 15% unless plugged in.'] });
check('headless on battery: Low Power Mode at any charge', { lid: 'closed', why: why.finished, ...bat(80) }, { headless: true, lowPower: true });
check('headless on battery, setting off', { lid: 'closed', why: why.finished, ...bat(80), set: { ...SET, headlessLowPower: false } }, { lowPower: false });
check('working below lowPowerBelow', { why: why.busy, ...bat(29) }, { lowPower: true });
check('Low Power Mode stays on 5 points up (hysteresis)', { why: why.busy, ...bat(32), lowPowerByUs: true }, { lowPower: true });
check('Low Power Mode off at 35', { why: why.busy, ...bat(35), lowPowerByUs: true }, { lowPower: false });
check('32% and not ours: not turned on', { why: why.busy, ...bat(32) }, { lowPower: false });
check('viewer arrives while headless on battery: Low Power Mode off', { lid: 'closed', why: why.streaming, watching: true, ...bat(70), lowPowerByUs: true }, { lowPower: false });
check('nothing held: Low Power Mode restored', { ...bat(20), lowPowerByUs: true }, { lowPower: false });
check('Low Power Mode needs away mode', { why: why.busy, ...bat(20), away: false }, { lowPower: false });

// ---- Sleep now ----
check('Sleep now: hold nothing for a minute', { lid: 'closed', why: why.busyClosed, holdOff: T + 30_000 },
  { running: false, label: 'Sleeping', why: '', disableSleep: false, caffeinate: false, freeze: false, mute: false });
check('Sleep now, lid open', { why: why.stay, holdOff: T + 30_000 }, { running: false, label: 'Idle', countdown: null });
check('holdOff over', { why: why.busy, holdOff: T - 1 }, { running: true });
check('a clock set back does not hold off for hours', { why: why.busy, holdOff: T + 2 * 3600_000 }, { running: true });
assert.equal(HOLD_OFF_MS, 60_000);

// ---- after a sleep (Sleep now, or a wake the daemon saw) ----
const held = { at: T - 3600_000, lid: 'closed' };
check('dark wake, lid closed, agent was busy before the sleep: back to sleep', { lid: 'closed', why: why.busyClosed, sleepHold: held },
  { running: false, label: 'Sleeping', sleepHold: held, caffeinate: false });
check('dark wake, lid open, agent was busy: back to sleep', { why: why.busy, sleepHold: { at: T - MIN, lid: 'open' } }, { running: false, label: 'Idle' });
check('after the sleep, an agent hook: it works again', { lid: 'closed', why: why.busyClosed, sleepHold: held, backAt: T - 10_000 }, { running: true, sleepHold: null });
check('after the sleep, a Seer page opened', { lid: 'closed', why: why.busyClosed, sleepHold: held, backAt: T }, { running: true, sleepHold: null });
check('a hook before the sleep does not count', { lid: 'closed', why: why.busyClosed, sleepHold: held, backAt: held.at - 1 }, { running: false });
check('lid opened after a closed-lid sleep', { why: why.busy, sleepHold: held }, { running: true, sleepHold: null });
check('someone at it', { why: why.busy, inUse: true, sleepHold: { at: T - MIN, lid: 'open' } }, { running: true, sleepHold: null });
check('a viewer', { lid: 'closed', why: why.streaming, watching: true, sleepHold: held }, { running: true, sleepHold: null });
check('a stay timer', { lid: 'closed', why: { ...why.stayClosed, agentsBusy: 1 }, sleepHold: held }, { running: true, sleepHold: null });
check('held, no agent busy, someone checked in since: the window counts', { lid: 'closed', why: { ...WHY, awake: true, why: 'you checked in', reachableUntil: T + 14 * MIN }, sleepHold: held },
  { running: true, label: 'Headless', sleepHold: held });

// ---- every combination: the invariants alone ----
let combos = 0;
for (const lid of ['open', 'closed', 'unknown']) for (const external of [false, true]) for (const inUse of [false, true])
  for (const w of Object.keys(why)) for (const away of [false, true]) for (const rule of [false, true]) for (const pmsetOk of [false, true])
    for (const battery of [{ onBattery: false, pct: 100 }, { onBattery: true, pct: 10 }, { onBattery: true, pct: 25 }, { onBattery: true, pct: 60 }])
      for (const holdOff of [0, T + 1000]) for (const sleepHold of [null, held]) for (const lowPowerByUs of [false, true]) {
        if (external && lid !== 'closed') continue;
        const over = { lid, external, inUse, why: why[w], watching: w.startsWith('streaming'), away, rule, pmsetOk, battery, holdOff, sleepHold, lowPowerByUs };
        invariants(`combo ${JSON.stringify(over)}`, over, run(over));
        combos++;
      }

// ---- wake detection ----
assert.equal(sleptBetween({ wallBefore: T, wallNow: T + 3000, monoBefore: 0, monoNow: 3000 }), 0, 'a normal beat');
assert.equal(sleptBetween({ wallBefore: T, wallNow: T + 3 * 3600_000, monoBefore: 0, monoNow: 3000 }), T, 'slept 3 h');
assert.equal(sleptBetween({ wallBefore: T, wallNow: T + 25_000, monoBefore: 0, monoNow: 3000 }), T, 'a short sleep');
assert.equal(sleptBetween({ wallBefore: T, wallNow: T + 40_000, monoBefore: 0, monoNow: 40_000 }), 0, 'a busy event loop is not a sleep');
assert.equal(sleptBetween({ wallBefore: T, wallNow: T + 600_000, monoBefore: 0, monoNow: 600_000 }), T, 'a clock that runs on in sleep: a long gap');
assert.equal(sleptBetween({ wallBefore: T, wallNow: T - 3600_000, monoBefore: 0, monoNow: 3000 }), 0, 'the clock set back');
assert.deepEqual(onWake({ sleptAt: T, lid: 'closed', prevSleptAt: 0 }), { sleptAt: T, sleepHold: { at: T, lid: 'closed' } }, 'a wake cuts the window and holds stale agents');
assert.deepEqual(onWake({ sleptAt: T, lid: 'closed', prevSleptAt: T + 5 }).sleptAt, T + 5, 'a later Sleep now time is kept');
assert.deepEqual(onWake({ sleptAt: T, lid: 'closed', prevHold: { at: T + 1000, lid: 'open' } }).sleepHold, { at: T + 1000, lid: 'open' }, 'Sleep now\'s hold is kept');
// A wake then feeds decide(): the busy agent no longer holds a closed Mac in a dark wake.
const w = onWake({ sleptAt: T - 3 * 3600_000, lid: 'closed' });
assert.equal(run({ lid: 'closed', why: why.busyClosed, sleepHold: w.sleepHold }).running, false, 'dark wake after 3 h: not grabbed');

// ---- the page's own script compiles, and renders the server's countdown only ----
const sample = { awake: { awake: true, label: 'Awake', why: '1 agent active', countdown: null, stayUntil: 0, reachableUntil: T + 15 * MIN, inUse: false },
  agentsBusy: 1, battery: { pct: 80, pluggedIn: true }, network: { kind: 'wifi' }, hotspot: {}, lid: 'closed', help: [], agents: [], projects: [] };
const html = homePage(JSON.stringify(sample), '');
const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
new vm.Script(script, { filename: 'home-client.js' });
assert.ok(!/reachableUntil/.test(script.replace(JSON.stringify(sample), '')), 'the page does not compute its own countdown from reachableUntil');

console.log(`power: ${passed} scenarios and ${combos} combinations pass`);
