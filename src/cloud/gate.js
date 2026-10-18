// seer-gate: runs inside every cloud copy, in front of the project, and is the reason a copy can neither be
// reached without Seer's front door nor bill overnight.
//   - Only requests carrying X-Seer-Key = $SEER_KEY reach the app (the front door adds it); anything else gets 404.
//   - The machine exits after IDLE_MIN minutes without a request, and after MAX_MIN minutes in all, whatever is
//     connected (an open tab's websocket cannot keep it up). The Fly machine is set never to restart on exit:
//     only a new request through the front door starts it again.
// Starts the project's own command on APP_PORT and proxies to it. No dependencies: Node's own http only.
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

const KEY = process.env.SEER_KEY || '';
const PORT = Number(process.env.GATE_PORT || 8080), APP_PORT = Number(process.env.APP_PORT || 8081);
const IDLE_MS = Number(process.env.IDLE_MIN || 10) * 60_000, MAX_MS = Number(process.env.MAX_MIN || 60) * 60_000;
const CMD = process.env.SEER_START;
if (!KEY || !CMD) { console.error('seer-gate: SEER_KEY and SEER_START are required'); process.exit(1); }

const started = Date.now();
let lastRequest = Date.now(), served = false;   // served: a request with the key has come since the machine started
const app = spawn('/bin/sh', ['-c', CMD], { stdio: 'inherit', env: { ...process.env, PORT: String(APP_PORT) } });
app.on('exit', code => { console.log(`seer-gate: app exited (${code}); stopping`); process.exit(0); });

function stop(why) {
  console.log(`seer-gate: ${why}; stopping the machine`);
  app.kill('SIGTERM');
  setTimeout(() => process.exit(0), 5000).unref();
}
setInterval(() => {
  if (Date.now() - started > MAX_MS) stop(`reached the ${MAX_MS / 60_000} min limit`);
  else if (Date.now() - lastRequest > IDLE_MS) stop(`no requests for ${IDLE_MS / 60_000} min`);
  // Woken only by requests without the key (a scanner on the public Fly address): Fly starts the machine before
  // the gate can refuse, so do not keep it up for the whole idle window.
  else if (!served && Date.now() - started > 60_000) stop('woken without the key; nothing to serve');
}, 15_000);

const keyOk = req => {
  const got = Buffer.from(String(req.headers['x-seer-key'] || '')), want = Buffer.from(KEY);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};
const strip = headers => { const h = { ...headers }; delete h['x-seer-key']; return h; };

// Answer once the project listens: until then a request waits (Fly holds the first request while starting).
async function appReady(ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const ok = await new Promise(r => { const s = net.connect(APP_PORT, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
    if (ok) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  if (!keyOk(req)) { res.writeHead(404); return res.end(); }
  lastRequest = Date.now(); served = true;
  if (!(await appReady())) { res.writeHead(503, { 'content-type': 'text/plain' }); return res.end('The project did not start. Check its log with seer status.'); }
  const up = http.request({ host: '127.0.0.1', port: APP_PORT, method: req.method, path: req.url, headers: strip(req.headers) }, r => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
});

// Websockets (a game server, live updates): same key check, then the raw connection is joined to the app.
server.on('upgrade', async (req, socket, head) => {
  if (!keyOk(req)) return socket.destroy();
  lastRequest = Date.now(); served = true;
  if (!(await appReady())) return socket.destroy();
  const up = net.connect(APP_PORT, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(strip(req.headers)).map(([k, v]) => `${k}: ${v}`), '', ''];
    up.write(lines.join('\r\n'));
    if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  const end = () => { up.destroy(); socket.destroy(); };
  up.on('error', end); socket.on('error', end);
  socket.on('data', () => { lastRequest = Date.now(); });               // a socket in use counts as activity
});

server.listen(PORT, '0.0.0.0', () => console.log(`seer-gate on :${PORT} -> app on :${APP_PORT} (idle ${IDLE_MS / 60_000} min, max ${MAX_MS / 60_000} min)`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => stop(`got ${sig}`));
