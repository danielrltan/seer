// The power decision, once per daemon tick: from what the Mac reports (lid, battery, someone at it, someone
// streaming) and what activity.js says wants it awake, what Seer holds and what the page and the menu bar say.
// Pure: no imports, no clock, no files, so test/power.test.mjs can run every case without touching the Mac.
// daemon.js gathers the inputs, calls decide(), and carries out what it returns.
//
// The rules, in order:
//   lid      'closed' means closed with no external display. A closed lid on an external display is a desk Mac
//            (macOS keeps it up itself), so it is treated as open: never headless.
//   wants    activity.js: the stay-awake timer, someone streaming, an agent working, or the reachable window after
//            the last of those, lid open or closed.
//   held     wants, unless one of these lets it sleep:
//              - Sleep now was tapped under a minute ago (holdOff)
//              - on battery below sleepBelow
//              - the lid is closed and Seer cannot keep a closed Mac up (away mode off, no sudoers rule, or
//                pmset refused): macOS sleeps it anyway, so holding caffeinate would only lie
//              - after a sleep (Sleep now, or any sleep the daemon wakes from), agents that were already busy
//                no longer hold it until someone is back: the lid opens, a key or click, a viewer, a stay timer,
//                a Seer page opened, or an agent hook after the sleep. A dark wake (Power Nap) must not turn
//                into a night awake.
//   held means caffeinate -is, and with away mode and the rule, sleep disabled with the lid open too, so that
//   closing the lid on a held Mac does not sleep it before the daemon sees the lid move. That is why the window
//   holds with the lid open: an agent that finished, then the lid closed, must find sleep already disabled. With
//   the lid open it only keeps macOS's idle sleep off until the window ends (windowUntil), reachableMin at most.
//   headless held, lid closed, nobody streaming or at it, no agent working: screen off, apps frozen, sound off,
//            Low Power Mode on battery. The lid open is never headless, whatever holds it.
//   countdown the page's "to sleep" is the closed lid's window only: with the lid open the Mac does not sleep then,
//            it only stops being held, so there is no countdown, only windowUntil for the log and the next tick.
// Nothing held means nothing at all: macOS's own display and idle sleep apply.

export const HOLD_OFF_MS = 60_000;          // after Sleep now
const LOW_POWER_HYSTERESIS = 5;             // Low Power Mode comes off 5 points above where it went on

// in: {
//   now, lid: 'open'|'closed'|'unknown', external (closed lid on an external display), inUse, watching,
//   why: awakeReason() { awake, why, agentsBusy, agentsWaiting, reachableUntil, stayUntil },
//   set: settings() (reachableMin, screenOff, freeze, mute, headlessLowPower, lowPowerBelow, sleepBelow),
//   away (config.away), rule (sudoers rule installed), pmsetOk (the last disablesleep change worked),
//   battery { onBattery, pct }, holdOff (ms), sleepHold { at, lid } | null, lowPowerByUs,
//   backAt (the last agent hook or Seer page opened: someone or something is active again)
// }
export function decide(i) {
  const { now, set, why = {}, battery: b = { onBattery: false, pct: 100 } } = i;
  const closed = i.lid === 'closed' && !i.external;
  const busy = (why.agentsBusy || 0) > 0;
  const stay = why.stayUntil > now ? why.stayUntil : 0;
  const canClose = !!(i.away && i.rule && i.pmsetOk !== false);
  // A holdOff far in the future is a clock that jumped back, not a Sleep now: never more than a minute.
  const holdingOff = i.holdOff > now && i.holdOff - now <= HOLD_OFF_MS;
  const floor = b.onBattery && b.pct < set.sleepBelow;

  // After a sleep: is anyone back?
  let hold = i.sleepHold || null;
  if (hold && (i.inUse || i.watching || stay || (i.backAt || 0) > hold.at || (hold.lid === 'closed' && i.lid === 'open'))) hold = null;

  // A busy agent also refreshes the reachable window, so while held nothing else can be keeping it up.
  // The window alone, with the lid open, is only for a lid close to find sleep already disabled: without away mode
  // and the rule a close sleeps it anyway, and a Mac with no lid to read (a desktop) has none to close.
  const windowOnly = !stay && !i.watching && !busy, lidOpenUseless = i.lid !== 'closed' && !(i.lid === 'open' && canClose);
  const wants = !!why.awake && !(hold && busy) && !(windowOnly && lidOpenUseless), reason = why.why || '';
  const running = wants && !holdingOff && !floor && !(closed && !canClose);
  const headless = running && closed && !i.watching && !i.inUse && !busy;
  // Held by the reachable window alone (no stay, no viewer, no agent working): it lets go at reachableUntil.
  const windowUntil = running && !stay && !i.watching && !busy && why.reachableUntil > now ? why.reachableUntil : 0;

  const label = running ? (headless ? 'Idling' : 'Awake') : i.inUse ? 'In use' : closed ? 'Asleep' : 'Idling';
  const sub = running ? reason : wants && floor && !holdingOff ? `battery ${b.pct}%` : '';

  // The one countdown the page shows, so it can never disagree with when the Mac lets go.
  let countdown = null;
  if (running && stay) countdown = { until: stay, kind: 'stay' };
  else if (windowUntil && closed) countdown = { until: windowUntil, kind: 'sleep', from: windowUntil - set.reachableMin * 60_000 };

  const disableSleep = running && canClose;
  const lowPowerTrigger = running && b.onBattery && ((headless && set.headlessLowPower) || b.pct < set.lowPowerBelow);
  const lowPowerKeep = running && b.onBattery && !!i.lowPowerByUs && b.pct < set.lowPowerBelow + LOW_POWER_HYSTERESIS;
  const lowPower = !!(i.away && i.rule) && (lowPowerTrigger || lowPowerKeep);       // part of away mode, like disablesleep

  // Help lines: only ones the owner can act on, and only when true now.
  // The battery's own line, shown in the battery card: at sleepBelow Seer lets go whatever wants it awake.
  const batteryNote = b.onBattery && wants && floor ? `Under ${set.sleepBelow}%, it sleeps even with agents running. Plug it in`
    : b.onBattery && running && b.pct <= set.sleepBelow + 5 ? `Sleeps at ${set.sleepBelow}% even with agents running` : '';
  const notes = [];
  const closingSleeps = running && i.lid === 'open' && !canClose;
  if (closingSleeps) notes.push(!i.rule ? 'Closing the lid will sleep it. Run seer away install on the Mac.'
    : !i.away ? 'Closing the lid will sleep it. Turn on Stay awake with the lid closed in Settings.'
    : 'Closing the lid will sleep it: pmset could not disable sleep.');

  return {
    running, headless, label, why: sub, countdown, closed,
    mode: !running ? 'sleep allowed' : headless ? 'headless' : 'awake',      // also the battery drain's state
    caffeinate: running, disableSleep, lowPower,
    screenOff: closed && !i.watching && !i.inUse && !!set.screenOff,
    freeze: headless && !!set.freeze, mute: headless && !!set.mute,
    failover: running && closed,                                             // never switch the Wi-Fi under someone
    sleepHold: hold, closingSleeps, notes, batteryNote, windowUntil,
  };
}

// A wake from sleep: the wall clock moved on while the monotonic clock (which stops in sleep on macOS) did not,
// or the gap between two 3 s beats is far longer than any stall. Returns when it went to sleep, or 0.
export function sleptBetween({ wallBefore, wallNow, monoBefore, monoNow }) {
  const wall = wallNow - wallBefore, mono = monoNow - monoBefore;
  if (wall <= 0) return 0;                                                   // the clock was set back
  return wall - mono > 15_000 || wall > 120_000 ? wallBefore : 0;
}

// On a wake: activity before the sleep no longer counts (sleptAt cuts the reachable window), and agents that were
// busy before it don't hold the Mac until someone is back.
// A hold Sleep now set just before the sleep is kept (its lid is the one the owner left).
export function onWake({ sleptAt, lid, prevSleptAt = 0, prevHold = null }) {
  return { sleptAt: Math.max(prevSleptAt, sleptAt), sleepHold: prevHold && prevHold.at >= sleptAt ? prevHold : { at: sleptAt, lid } };
}
