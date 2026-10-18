// What SeerStream's status lines mean to the daemon: node test/stream-status.test.mjs
import assert from 'node:assert/strict';
import { readStatus } from '../src/stream.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok  ${name}`); };

test('capturing on and off, whatever else rides along', () => {
  assert.equal(readStatus('{"capturing":true,"width":1512,"height":982}').capturing, true);
  assert.equal(readStatus('{"width":1512,"virtual":true,"height":982,"capturing":true}').capturing, true);
  assert.equal(readStatus('{"virtual":false,"capturing":true}').capturing, true);
  assert.equal(readStatus('{"capturing":false,"error":"stopped"}').capturing, false);
  assert.equal(readStatus('{"error":"no display to capture"}').capturing, false);
  assert.equal(readStatus('{"textFocus":true}').capturing, undefined);
});

test('errors in the words the phone shows', () => {
  assert.equal(readStatus('{"error":"no display to capture"}').text, '{"error":"No screen to show with the lid closed"}');
  assert.equal(readStatus('{"error":"screen-recording"}').text, '{"error":"Turn on Seer in Screen Recording settings on the Mac"}');
  assert.equal(readStatus('{"error":"accessibility"}').text, '{"error":"Turn on Seer in Accessibility settings on the Mac"}');
});

test('virtual screen notes: logged only, never an error, never capture on or off', () => {
  for (const raw of ['{"screen":"virtual screen: added 1512x982 HiDPI (display 8, serial 1)"}',
    '{"screen":"virtual screen: not added: serials 1, 2, 3, 4 all still taken by earlier ones (they go when the Mac wakes)"}',
    '{"screen":"virtual screen: removed (display 8; the stream stopped 20 s before)"}']) {
    const st = readStatus(raw);
    assert.equal(st.logOnly, true);
    assert.equal(st.text, raw);
    assert.equal(st.capturing, undefined);
  }
});

console.log(`${n} passed`);
