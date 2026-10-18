// What the viewer may send for input, and how it reaches SeerStream: node test/stream-input.test.mjs
import assert from 'node:assert/strict';
import { cleanInput, flipScroll, scaleInput } from '../src/stream.js';
import { SPEC } from '../src/settings.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok  ${name}`); };
const same = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);   // -0 and 0 alike, as on the wire

test('nudge: valid, clamped, rejected', () => {
  same(cleanInput({ t: 'nudge', dx: 1.25, dy: -3 }), { cmd: 'input', t: 'nudge', dx: 1.25, dy: -3 });
  same(cleanInput({ t: 'nudge', dx: 5000, dy: -900 }), { cmd: 'input', t: 'nudge', dx: 800, dy: -800 });
  same(cleanInput({ t: 'nudge', dx: 1, dy: 2, x: 0.5, y: 0.5, evil: 1 }), { cmd: 'input', t: 'nudge', dx: 1, dy: 2 });
  for (const bad of [{ dx: 1 }, { dx: NaN, dy: 0 }, { dx: Infinity, dy: 0 }, { dx: '3', dy: 0 }, { dx: null, dy: 1 }])
    assert.equal(cleanInput({ t: 'nudge', ...bad }), null, JSON.stringify(bad));
});

test('press and release: left or right, nothing else', () => {
  same(cleanInput({ t: 'press', button: 'left' }), { cmd: 'input', t: 'press', button: 'left' });
  same(cleanInput({ t: 'release', button: 'right', x: 0.2 }), { cmd: 'input', t: 'release', button: 'right' });
  same(cleanInput({ t: 'press', button: 'left', mods: ['shift', 'hyper'] }), { cmd: 'input', t: 'press', button: 'left', mods: ['shift'] });
  for (const button of [undefined, 'middle', 'LEFT', 1]) {
    assert.equal(cleanInput({ t: 'press', button }), null);
    assert.equal(cleanInput({ t: 'release', button }), null);
  }
});

test('click: button and a count of 1 to 3', () => {
  same(cleanInput({ t: 'click', button: 'left', count: 2 }), { cmd: 'input', t: 'click', button: 'left', count: 2 });
  same(cleanInput({ t: 'click', button: 'right' }), { cmd: 'input', t: 'click', button: 'right', count: 1 });
  same(cleanInput({ t: 'click', button: 'left', count: 3, y: 1 }), { cmd: 'input', t: 'click', button: 'left', count: 3 });
  for (const count of [0, 4, 1.5, '2', -1, true]) assert.equal(cleanInput({ t: 'click', button: 'left', count }), null, String(count));
  assert.equal(cleanInput({ t: 'click', count: 1 }), null);
});

test('scroll with phases: begin, move, end with velocity', () => {
  same(cleanInput({ t: 'scroll', phase: 'begin', dx: 0, dy: 4.5 }), { cmd: 'input', t: 'scroll', dx: 0, dy: 4.5, phase: 'begin' });
  same(cleanInput({ t: 'scroll', phase: 'move', dx: 3, dy: -2, vx: 9 }), { cmd: 'input', t: 'scroll', dx: 3, dy: -2, phase: 'move' });
  same(cleanInput({ t: 'scroll', phase: 'end', dx: 0, dy: 0, vx: 0.5, vy: -1.2 }), { cmd: 'input', t: 'scroll', dx: 0, dy: 0, phase: 'end', vx: 0.5, vy: -1.2 });
  same(cleanInput({ t: 'scroll', phase: 'end', dx: 0, dy: 0, vx: 99, vy: -99 }), { cmd: 'input', t: 'scroll', dx: 0, dy: 0, phase: 'end', vx: 20, vy: -20 });
  same(cleanInput({ t: 'scroll', phase: 'end', dx: 0, dy: 0 }), { cmd: 'input', t: 'scroll', dx: 0, dy: 0, phase: 'end', vx: 0, vy: 0 });
  same(cleanInput({ t: 'scroll', phase: 'move', dx: 1e6, dy: -1e6 }), { cmd: 'input', t: 'scroll', dx: 2000, dy: -2000, phase: 'move' });
  for (const phase of ['start', 'END', '', null, 3]) assert.equal(cleanInput({ t: 'scroll', phase, dx: 1, dy: 1 }), null, String(phase));
});

test('the old messages are unchanged', () => {
  same(cleanInput({ t: 'scroll', dx: 3, dy: -7 }), { cmd: 'input', t: 'scroll', dx: 3, dy: -7 });
  same(cleanInput({ t: 'down', x: 0.5, y: 2, button: 'right' }), { cmd: 'input', t: 'down', x: 0.5, y: 1, button: 'right' });
  same(cleanInput({ t: 'up', x: 0.5, y: 0.25, button: 'left' }), { cmd: 'input', t: 'up', x: 0.5, y: 0.25 });
  same(cleanInput({ t: 'move', x: -1, y: 0.5 }), { cmd: 'input', t: 'move', x: 0, y: 0.5 });
  same(cleanInput({ t: 'key', key: 'Enter', mods: ['cmd'] }), { cmd: 'input', t: 'key', mods: ['cmd'], key: 'Enter' });
  same(cleanInput({ t: 'text', text: 'hi' }), { cmd: 'input', t: 'text', text: 'hi' });
  assert.equal(cleanInput({ t: 'drag' }), null);
  assert.equal(cleanInput({ t: 'keyframe' }), null);
});

test('natural scrolling flips deltas and velocity', () => {
  const end = cleanInput({ t: 'scroll', phase: 'end', dx: 2, dy: -3, vx: 0.4, vy: -1 });
  same(flipScroll(end, true), { cmd: 'input', t: 'scroll', dx: -2, dy: 3, phase: 'end', vx: -0.4, vy: 1 });
  same(flipScroll(end, false), { cmd: 'input', t: 'scroll', dx: 2, dy: -3, phase: 'end', vx: 0.4, vy: -1 });
  const old = flipScroll(cleanInput({ t: 'scroll', dx: 5, dy: 1 }), true);
  same(old, { cmd: 'input', t: 'scroll', dx: -5, dy: -1 });
  assert.ok(!('vx' in old), 'no velocity invented for the old scroll');
  const nudge = cleanInput({ t: 'nudge', dx: 1, dy: 1 });
  assert.equal(flipScroll(nudge, true), nudge, 'only scroll flips');
});

test('scroll speed scales scroll and its velocity, pointer speed scales nudges', () => {
  const end = cleanInput({ t: 'scroll', phase: 'end', dx: 10, dy: -4, vx: 1, vy: -2 });
  same(scaleInput(end, { scrollSpeed: 150, pointerSpeed: 300 }), { cmd: 'input', t: 'scroll', dx: 15, dy: -6, phase: 'end', vx: 1.5, vy: -3 });
  same(scaleInput(cleanInput({ t: 'nudge', dx: 2, dy: -1 }), { scrollSpeed: 150, pointerSpeed: 250 }), { cmd: 'input', t: 'nudge', dx: 5, dy: -2.5 });
  const click = cleanInput({ t: 'click', button: 'left', count: 1 });
  assert.equal(scaleInput(click, { scrollSpeed: 50, pointerSpeed: 50 }), click);
  same(scaleInput(cleanInput({ t: 'scroll', dx: 4, dy: 8 }), { scrollSpeed: 25 }), { cmd: 'input', t: 'scroll', dx: 1, dy: 2 });
});

test('pointerSpeed is a setting beside scrollSpeed', () => {
  assert.deepEqual(SPEC.pointerSpeed, { type: 'int', def: 100, min: 25, max: 300 });
});

console.log(`${n} passed`);
