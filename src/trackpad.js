// The phone half of the screen as a Mac trackpad: touches on the pad become relative Mac input, with macOS's
// default gestures. Browser code, inlined into the viewer page (see TRACKPAD_JS at the bottom).
//
//   window.mountTrackpad(el, { send, onZoom, onZoomEnd }) -> { destroy() }
//   send(msg)                one message to the Mac; the Mac acts at its own cursor:
//     {t:'nudge', dx, dy}                       cursor move, Mac points, accelerated here (at most one per frame)
//     {t:'press'|'release', button}             hold / let go of a button (tap-to-drag)
//     {t:'click', button, count}                count 2/3 for quick taps in a row
//     {t:'scroll', dx, dy, phase, vx, vy}       two-finger or edge scroll, against the fingers (SCROLL_DIR), Mac points, no acceleration;
//                                               phase begin|move|end, vx/vy (points/ms) only on end: the Mac glides
//     {t:'key', key, mods}                      gesture shortcuts (three-finger swipes and tap)
//   onZoom(factor, cx, cy)   a pinch on the pad: zoom the view by factor (relative to the last call) around cx, cy
//                            (pad CSS px)
//   onZoomEnd()              the pinch ended
//   onEdge(side)             an edge scroll began ('left' or 'right') or ended (null)
//   opts.tune                optional overrides of TUNE below (for tuning on the phone)
//
// Gestures: 1 finger move = cursor, tap = click (double/triple when quick and close), tap then touch again and
// move = drag; 1 finger sliding up or down from the left or right edge = scroll. 2 fingers move = scroll, tap = right click, pinch = zoom the view. 3 fingers swipe left/right =
// next/previous Space, up = Mission Control, down = App Exposé, tap = Look Up. 4+ fingers do nothing.
// The kind of gesture is decided once per touch sequence (first finger down to last finger up), from the most
// fingers down and the first clear movement, and kept until every finger lifts: lifting one finger of a scroll
// ends the scroll and never moves the cursor.

function trackpad() {
  // Distances in CSS px, times in ms, speeds in CSS px/ms. Gains turn CSS px into Mac points.
  const TUNE = {
    // Pointer acceleration: the gain rises smoothly with finger speed. Slow = precise (30 px at 0.05 px/ms moves
    // the cursor ~40 points); a 300 px swipe in 300 ms crosses a 1512-point screen.
    POINTER_MIN: 1.25, POINTER_MAX: 5.2, ACCEL_FROM: 0.03, ACCEL_TO: 0.7,
    SPEED_TAU: 25,      // smoothing of the speed that picks the gain, so event-timing jitter does not wobble it
    SCROLL_GAIN: 1.25,  // scroll tracks the fingers 1:1 in feel; the Mac's Settings scales it
    SCROLL_DIR: -1,     // the owner's choice: the page moves against the fingers (1 = with them, as on an iPhone)
    EDGE: 30,           // 1 finger landing this close to the pad's left or right side and going up or down scrolls
    // Fingers of one gesture land 10-50 ms apart: no kind is decided this soon after a finger lands (unless the
    // movement is already large), so a two-finger scroll does not start as a cursor move.
    SETTLE: 40,
    SLOP: 5,            // 1 finger: movement that makes the touch a cursor move
    TAP: 300,           // 1 finger: longest tap; held longer, even a tiny movement moves the cursor (no dead zone)
    TAP_SLOP: 8,        // 1 finger: furthest a tap may wander
    MULTI_TAP: 400,     // 2-3 fingers: longest tap, first finger down to last finger up
    MULTI_SLOP: 12,     // 2-3 fingers: furthest any finger may wander in a tap
    TAP_GAP: 350,       // a touch this soon after a tap lifts, near it, is the next click of a double click, or a drag
    TAP_NEAR: 40,
    SCROLL_SLOP: 6,     // 2 fingers: travel that starts a scroll
    PINCH_SLOP: 12,     // 2 fingers: change in spread that starts a pinch (and must beat the travel)
    SWIPE: 40,          // 3 fingers: travel that fires a swipe
    VEL_WINDOW: 80,     // release velocity: least squares over the last this many ms of a scroll
    PAUSE: 60,          // fingers still this long before lifting: no glide (fades out from 20 ms)
    VEL_MAX: 10,        // points/ms, so a timestamp hiccup never flings a page into orbit
    DRAG_GRACE: 250,    // a tap-drag holds the button this long after lifting: touch again and move to carry on
  };

  window.mountTrackpad = (el, opts) => {
    opts = opts || {};
    const C = Object.assign({}, TUNE, opts.tune);
    // A throwing callback must not leave a button held or a gesture half-tracked.
    const call = (f, ...a) => { try { if (f) f(...a); } catch (err) { console.error(err); } };
    const out = m => call(opts.send, m);
    const r2 = v => Math.round(v * 100) / 100;
    const clampV = v => Number.isFinite(v) ? Math.max(-C.VEL_MAX, Math.min(C.VEL_MAX, v)) : 0;
    // Event time (when the finger moved, not when the busy page got round to it) if it is on performance.now()'s
    // clock, as in Safari and Chrome; old WebKit used epoch ms, far in the "future", so then it is now.
    const stamp = e => { const p = performance.now(), t = e && e.timeStamp; return t > 0 && t <= p + 1000 ? t : p; };

    let seq = null;          // the touch sequence in progress
    let held = false;        // left button down (tap-to-drag)
    let grace = 0;           // timer: release after a drag's lift
    let scrolling = false;   // a scroll 'begin' went out and its 'end' has not
    let lastTap = null;      // { up, x, y, count }: the last click from a tap, for double clicks and tap-to-drag
    let speed = 0;           // smoothed pointer speed
    let raf = 0, dead = false;
    let edgeOn = false;      // an edge scroll is lit (onEdge)
    const pend = { nx: 0, ny: 0, sx: 0, sy: 0 };   // movement waiting for the next frame

    // ---------- output, coalesced per frame ----------
    const take = k => { const v = r2(pend[k]); pend[k] -= v; return v; };   // the rounding remainder stays pending
    function flush() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      const nx = take('nx'), ny = take('ny');
      if (nx || ny) out({ t: 'nudge', dx: nx, dy: ny });
      const sx = take('sx'), sy = take('sy');
      if (scrolling && (sx || sy)) out({ t: 'scroll', dx: sx, dy: sy, phase: 'move', vx: 0, vy: 0 });
      if (!scrolling) pend.sx = pend.sy = 0;
    }
    const schedule = () => { if (!raf && !dead) raf = requestAnimationFrame(() => { raf = 0; flush(); }); };

    const smooth = x => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
    function nudge(dx, dy, dt) {             // finger moved dx, dy over dt ms
      const inst = Math.hypot(dx, dy) / Math.max(dt, 4);
      speed += (1 - Math.exp(-Math.max(dt, 1) / C.SPEED_TAU)) * (inst - speed);
      const g = C.POINTER_MIN + (C.POINTER_MAX - C.POINTER_MIN) * smooth((speed - C.ACCEL_FROM) / (C.ACCEL_TO - C.ACCEL_FROM));
      if (!Number.isFinite(g * dx) || !Number.isFinite(g * dy)) return;
      pend.nx += dx * g; pend.ny += dy * g; schedule();
    }
    function scrollBy(dx, dy) { const g = C.SCROLL_GAIN * C.SCROLL_DIR; pend.sx += dx * g; pend.sy += dy * g; schedule(); }

    function press() { clearTimeout(grace); grace = 0; if (!held) { flush(); held = true; out({ t: 'press', button: 'left' }); } }
    function release() { clearTimeout(grace); grace = 0; if (held) { flush(); held = false; out({ t: 'release', button: 'left' }); } }
    function click(button, now, x, y) {
      flush();
      let count = 1;
      if (button === 'left' && lastTap && now - lastTap.up <= C.TAP_GAP && Math.hypot(x - lastTap.x, y - lastTap.y) <= C.TAP_NEAR) count = lastTap.count % 3 + 1;
      out({ t: 'click', button, count });
      lastTap = button === 'left' ? { up: now, x, y, count } : null;
    }

    // Release velocity, points/ms: least squares over the last VEL_WINDOW ms, faded to 0 if the fingers paused.
    function velocity(now) {
      const still = now - seq.lastMoved;
      const fade = 1 - Math.max(0, Math.min(1, (still - 20) / (C.PAUSE - 20)));
      if (fade <= 0) return [0, 0];
      let s = seq.samples.filter(p => p[0] >= now - C.VEL_WINDOW);
      if (s.length < 3) s = seq.samples.slice(-3);       // events came slowly (busy page): the last few, up to 150 ms
      if (s.length < 2) return [0, 0];
      let tm = 0, xm = 0, ym = 0;
      for (const p of s) { tm += p[0]; xm += p[1]; ym += p[2]; }
      tm /= s.length; xm /= s.length; ym /= s.length;
      let den = 0, nx = 0, ny = 0;
      for (const p of s) { const dt = p[0] - tm; den += dt * dt; nx += dt * (p[1] - xm); ny += dt * (p[2] - ym); }
      if (!(den > 1)) return [0, 0];       // all samples at one instant: no estimate
      const g = C.SCROLL_GAIN * C.SCROLL_DIR * fade;
      return [seq.edge === 'scroll' ? 0 : clampV(nx / den * g), clampV(ny / den * g)];
    }
    function endScroll(v) {
      if (!scrolling) return;
      flush();
      scrolling = false;
      out({ t: 'scroll', dx: 0, dy: 0, phase: 'end', vx: r2(v[0]), vy: r2(v[1]) });
      if (edgeOn) { edgeOn = false; call(opts.onEdge, null); }
    }
    function beginScroll() {
      flush();
      scrolling = true;
      out({ t: 'scroll', dx: 0, dy: 0, phase: 'begin', vx: 0, vy: 0 });
    }

    // ---------- touch ----------
    function start(now) {
      // A touch during a tap-drag's grace carries the drag on, if it moves.
      const cont = !!grace && held;
      clearTimeout(grace); grace = 0;
      speed = 0;
      return {
        pts: new Map(), n: 0, kind: null, t0: now, tLand: now, lastT: now, lastMoved: now,
        X: 0, Y: 0, samples: [], far: 0, pair: null, d0: 0, dPrev: 0, cont,
        x0: 0, y0: 0, afterTap: false, edge: null,       // edge: 'left'|'right' landed by a side, 'scroll' once scrolling
      };
    }
    const spread = () => { const a = seq.pts.get(seq.pair[0]), b = seq.pts.get(seq.pair[1]); return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; };
    function pairCentre() {
      const a = seq.pts.get(seq.pair[0]), b = seq.pts.get(seq.pair[1]), r = el.getBoundingClientRect();
      return [(a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top];
    }

    // Everything that ends a sequence early (touchcancel, the page hidden, destroy): let go of all of it.
    function abort() {
      flush();
      endScroll([0, 0]);
      if (seq && seq.kind === 'pinch') call(opts.onZoomEnd);
      release();
      seq = null;
    }

    function onTouch(e) {
      if (e.cancelable) e.preventDefault();
      const now = stamp(e), list = e.touches;
      // A fresh first finger while a sequence is live: iOS lost that sequence's end. Close it before starting.
      if (e.type === 'touchstart' && seq && list.length === e.changedTouches.length) abort();
      if (e.type === 'touchcancel') {
        abort();
        if (list.length) { seq = start(now); seq.kind = 'ignore'; for (const t of list) seq.pts.set(t.identifier, { x: t.clientX, y: t.clientY }); }
        return;
      }
      if (!seq) { if (!list.length || e.type !== 'touchstart') return; seq = start(now); }

      // Fingers that stayed down move the gesture by their average step: a finger landing or lifting never jumps it.
      // e.touches is the truth; ids we track but iOS no longer lists are gone.
      let sx = 0, sy = 0, k = 0, landed = false, moved = false;
      const pts = new Map();
      for (const t of list) {
        const id = t.identifier, x = t.clientX, y = t.clientY, p = seq.pts.get(id);
        if (p) { if (x !== p.x || y !== p.y) moved = true; sx += x - p.x; sy += y - p.y; k++; p.x = x; p.y = y; seq.far = Math.max(seq.far, Math.hypot(x - p.lx, y - p.ly)); pts.set(id, p); }
        else { pts.set(id, { x, y, lx: x, ly: y }); landed = true; }
      }
      const lifted = [...seq.pts.keys()].some(id => !pts.has(id));
      seq.pts = pts;
      if (landed) land(now, list);
      if (moved) move(sx / k, sy / k, now);              // a pinch moves fingers with no average step
      seq.lastT = now;
      if (!list.length) finish(now);
      else if (lifted) lift();
    }

    function land(now, list) {
      const first = !seq.n;
      seq.n = Math.max(seq.n, list.length);
      if (first) {
        const t = list[0];
        seq.x0 = t.clientX; seq.y0 = t.clientY;
        seq.afterTap = !!lastTap && now - lastTap.up <= C.TAP_GAP && Math.hypot(seq.x0 - lastTap.x, seq.y0 - lastTap.y) <= C.TAP_NEAR;
        const r = el.getBoundingClientRect();
        if (!seq.afterTap && !seq.cont) seq.edge = seq.x0 - r.left <= C.EDGE ? 'left' : r.right - seq.x0 <= C.EDGE ? 'right' : null;
      }
      if (seq.kind) return;                               // decided: extra fingers change nothing
      seq.tLand = now; seq.X = seq.Y = 0; seq.samples = [];   // measure the gesture from its last finger down
      if (seq.n >= 2 && seq.cont) { seq.cont = false; release(); }
      if (seq.n >= 4) { seq.kind = 'ignore'; return; }
      if (seq.n === 2) { seq.pair = [...seq.pts.keys()].slice(0, 2); seq.d0 = seq.dPrev = spread(); }
    }

    function move(dx, dy, now) {
      seq.X += dx; seq.Y += dy;
      if (Math.hypot(dx, dy) > 0.25) seq.lastMoved = now;
      seq.samples.push([now, seq.X, seq.Y]);
      while (seq.samples.length && seq.samples[0][0] < now - 150) seq.samples.shift();
      const kind = seq.kind;
      if (!kind) decide(now);
      else if (kind === 'move' || kind === 'drag') nudge(dx, dy, now - seq.lastT);
      else if (kind === 'scroll') scrollBy(seq.edge === 'scroll' ? 0 : dx, dy);
      else if (kind === 'pinch') {
        const d = spread();
        if (d > 0 && seq.dPrev > 0 && d !== seq.dPrev) { const [cx, cy] = pairCentre(); call(opts.onZoom, d / seq.dPrev, cx, cy); seq.dPrev = d; }
      }
    }

    function decide(now) {
      if (seq.pts.size < seq.n) return;                   // fingers already lifting: a tap or nothing
      const m = Math.hypot(seq.X, seq.Y), settled = now - seq.tLand >= C.SETTLE;
      if (seq.n === 1) {
        if ((settled && m > C.SLOP) || m > 3 * C.SLOP || (now - seq.t0 > C.TAP && m >= 1.5)) {
          lastTap = null;
          if (seq.edge && Math.abs(seq.Y) >= Math.abs(seq.X)) {   // along the edge: scroll; off it: the cursor
            const side = seq.edge;
            seq.kind = 'scroll'; seq.edge = 'scroll';
            beginScroll();
            edgeOn = true; call(opts.onEdge, side);
            scrollBy(0, seq.Y);
            return;
          }
          if (seq.afterTap || seq.cont) { seq.kind = 'drag'; press(); } else seq.kind = 'move';
          nudge(seq.X, seq.Y, now - seq.t0);              // the movement so far, so slow precise moves are not lost
        }
      } else if (seq.n === 2) {
        const s = Math.abs(spread() - seq.d0);
        if (!settled && m < 3 * C.SCROLL_SLOP && s < 3 * C.PINCH_SLOP) return;
        if (s > C.PINCH_SLOP && s > m) {
          seq.kind = 'pinch'; lastTap = null;
          const d = spread(), [cx, cy] = pairCentre();
          if (seq.d0 > 0) call(opts.onZoom, d / seq.d0, cx, cy);
          seq.dPrev = d;
        } else if ((m > C.SCROLL_SLOP && m > 1.5 * s) || m > 4 * C.SCROLL_SLOP) {
          seq.kind = 'scroll'; lastTap = null;
          beginScroll();
          scrollBy(seq.X, seq.Y);                         // the travel that recognised it goes in the first move
        }
      } else if (seq.n === 3) {
        if (m <= C.SWIPE || (!settled && m <= 1.5 * C.SWIPE)) return;
        // Fingers left = the Space to the right comes in, as on a Mac trackpad.
        const key = Math.abs(seq.X) > Math.abs(seq.Y) ? (seq.X < 0 ? 'ArrowRight' : 'ArrowLeft') : (seq.Y < 0 ? 'ArrowUp' : 'ArrowDown');
        seq.kind = 'done'; lastTap = null;
        flush();
        out({ t: 'key', key, mods: ['ctrl'] });
      }
    }

    // Some fingers lifted, some remain.
    function lift() {
      if (seq.kind === 'scroll') { endScroll(velocity(seq.lastT)); seq.kind = 'done'; }
      else if (seq.kind === 'pinch' && seq.pair.some(id => !seq.pts.has(id))) { call(opts.onZoomEnd); seq.kind = 'done'; }
    }

    // Every finger lifted.
    function finish(now) {
      const s = seq; seq = null;
      if (!s.kind) {
        const dur = now - s.t0;
        if (s.n === 1 && dur <= C.TAP && s.far <= C.TAP_SLOP) {
          if (s.cont) release();                          // a tap during a drag's grace drops it, no click
          else click('left', now, s.x0, s.y0);
        } else if (s.n === 2 && dur <= C.MULTI_TAP && s.far <= C.MULTI_SLOP) { if (s.cont) release(); click('right', now, s.x0, s.y0); }
        else if (s.n === 3 && dur <= C.MULTI_TAP && s.far <= C.MULTI_SLOP) { lastTap = null; flush(); out({ t: 'key', key: 'd', mods: ['ctrl', 'cmd'] }); }
        else if (s.cont) release();
        return;
      }
      if (s.kind === 'move') flush();
      else if (s.kind === 'drag') {
        flush();
        if (C.DRAG_GRACE > 0) grace = setTimeout(() => { grace = 0; release(); }, C.DRAG_GRACE); else release();
      } else if (s.kind === 'scroll') { seq = s; endScroll(velocity(now)); seq = null; }
      else if (s.kind === 'pinch') call(opts.onZoomEnd);
    }

    // ---------- mouse (testing from a computer): drag = cursor, click = click ----------
    let md = null;
    function onPointer(e) {
      if (e.pointerType !== 'mouse') return;
      const now = stamp(e);
      if (e.type === 'pointerdown') {
        if (e.button !== 0 && e.button !== 2) return;
        md = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: now, moved: false, button: e.button === 2 ? 'right' : 'left' };
        speed = 0;
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
      } else if (e.type === 'pointermove' && md) {
        const dx = e.clientX - md.x, dy = e.clientY - md.y;
        md.x = e.clientX; md.y = e.clientY;
        if (!md.moved && Math.hypot(md.x - md.x0, md.y - md.y0) > 3) md.moved = true;
        if (dx || dy) nudge(dx, dy, now - md.t);
        md.t = now;
      } else if ((e.type === 'pointerup' || e.type === 'pointercancel') && md) {
        flush();
        if (e.type === 'pointerup' && !md.moved) click(md.button, now, md.x0, md.y0);
        else lastTap = null;
        md = null;
      }
    }
    const noMenu = e => e.preventDefault();

    // The page going away mid-gesture (app switch, lock) never leaves a button held or a scroll open.
    const onHide = () => { if (document.hidden) abort(); };
    const onBlur = () => { abort(); md = null; };

    const saved = { touchAction: el.style.touchAction, userSelect: el.style.userSelect, webkitUserSelect: el.style.webkitUserSelect, webkitTouchCallout: el.style.webkitTouchCallout };
    el.style.touchAction = 'none';                        // no page scroll, no double-tap zoom over the pad
    el.style.userSelect = el.style.webkitUserSelect = 'none';
    el.style.webkitTouchCallout = 'none';
    const on = [
      [el, 'touchstart', onTouch], [el, 'touchmove', onTouch], [el, 'touchend', onTouch], [el, 'touchcancel', onTouch],
      [el, 'gesturestart', noMenu], [el, 'gesturechange', noMenu], [el, 'gestureend', noMenu],   // Safari's page pinch
      [el, 'pointerdown', onPointer], [el, 'pointermove', onPointer], [el, 'pointerup', onPointer], [el, 'pointercancel', onPointer],
      [el, 'contextmenu', noMenu],
      [document, 'visibilitychange', onHide], [window, 'pagehide', onBlur], [window, 'blur', onBlur],
    ];
    for (const [t, ev, f] of on) t.addEventListener(ev, f, { passive: false });

    return {
      destroy() {
        if (dead) return;
        abort(); md = null; lastTap = null;
        dead = true;
        for (const [t, ev, f] of on) t.removeEventListener(ev, f, { passive: false });
        Object.assign(el.style, saved);
      },
    };
  };
}

// Stringified from a real function so node parses it on import (a free syntax check) and nothing needs escaping.
export const TRACKPAD_JS = '(' + trackpad.toString() + ')();';
