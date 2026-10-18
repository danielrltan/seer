// The Mac's clipboard, for whoever is streaming: text copied on the Mac goes to the viewer, which puts it on the
// phone's clipboard on the next tap (a page may only write the clipboard during a tap). Watched only while someone
// streams, by one small JavaScript-for-Automation process polling the pasteboard's change count. Items a password
// manager marks concealed or transient (the nspasteboard.org convention: 1Password, Passwords, and others) are
// never sent, and neither is what was already on the clipboard when the stream started.
import { spawn } from 'node:child_process';

const MAX = 100_000;                                       // characters; a bigger copy is not sent
// It stops by itself once Seer is gone (its parent becomes launchd), so a daemon that died or was restarted
// mid-stream never leaves one polling.
const WATCH = `
ObjC.import('AppKit');
ObjC.import('stdlib');
ObjC.import('unistd');
const pb = $.NSPasteboard.generalPasteboard;
let last = pb.changeCount;
for (;;) {
  delay(0.4);
  if ($.getppid() === 1) $.exit(0);
  const n = pb.changeCount;
  if (n === last) continue;
  last = n;
  const types = ObjC.deepUnwrap(pb.types) || [];
  if (types.includes('org.nspasteboard.ConcealedType') || types.includes('org.nspasteboard.TransientType')) continue;
  const s = pb.stringForType($.NSPasteboardTypeString);
  if (!s.isNil()) console.log(JSON.stringify(s.js));
}`;

let child = null;
export function watchClipboard(onText, log) {
  if (child) return;
  child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', WATCH], { stdio: ['ignore', 'ignore', 'pipe'] });
  let buf = '';
  child.stderr.on('data', d => {                           // JXA's console.log writes to stderr, one JSON string a line
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const text = JSON.parse(line); if (typeof text === 'string' && text && text.length <= MAX) onText(text); } catch {}
    }
    if (buf.length > MAX * 8) buf = '';
  });
  child.on('exit', () => { child = null; });
  log('clipboard: watching while streaming');
}
export function stopClipboard() { child?.kill(); child = null; }
