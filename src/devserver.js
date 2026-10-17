// Starting, checking and stopping the dev servers Seer runs. A server is spawned detached in its own process
// group, logging to ~/.seer/logs/<name>.log, so it outlives the agent session (and MCP process) that started it.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { LOGS } from './store.js';

const PORT_MIN = 7400, PORT_MAX = 7499;        // clear of the Poddle test ports (8140s, 8300s, 8420, 8443, 8630, 8760, 8960)

export function portOpen(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const s = net.connect({ port, host });
    s.setTimeout(800);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}
export const anyHostOpen = async port => (await portOpen(port, '127.0.0.1')) || (await portOpen(port, '::1'));

export function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export async function freePort(taken) {
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (taken.has(p)) continue;
    if (!(await anyHostOpen(p))) return p;
  }
  throw new Error(`no free port between ${PORT_MIN} and ${PORT_MAX}`);
}

// How to run a project. An explicit cmd wins ({port} in it is replaced, and PORT is always set). Otherwise the
// package.json dev script (or start), with the port flags the common dev servers understand.
export function detect(dir, cmd) {
  if (cmd) return { cmd, how: 'given' };
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch {
    throw new Error(`no package.json in ${dir}: pass a command, e.g. --cmd "node server.js" (PORT is set for it)`);
  }
  const scripts = pkg.scripts || {}, deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const script = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
  if (!script) throw new Error(`${dir}/package.json has no dev or start script: pass --cmd`);
  const body = scripts[script];
  if (/\bvite\b/.test(body) || (deps.vite && !/\bnext\b/.test(body)))
    return { cmd: `npm run ${script} -- --port {port} --strictPort --host 127.0.0.1`, how: 'vite' };
  if (/\bnext\b/.test(body) || deps.next) return { cmd: `npm run ${script} -- -p {port} -H 127.0.0.1`, how: 'next' };
  if (/\bastro\b/.test(body)) return { cmd: `npm run ${script} -- --port {port} --host 127.0.0.1`, how: 'astro' };
  return { cmd: `npm run ${script}`, how: 'npm, PORT env' };
}

export function logPath(name) { return path.join(LOGS, `${name}.log`); }

export function start({ name, dir, cmd, port }) {
  const line = cmd.replaceAll('{port}', String(port));
  const out = fs.openSync(logPath(name), 'a');
  fs.writeSync(out, `\n--- ${new Date().toISOString()} seer: ${line}  (in ${dir}, PORT=${port})\n`);
  const child = spawn('/bin/sh', ['-c', line], {
    cwd: dir, detached: true, stdio: ['ignore', out, out],
    env: { ...process.env, PORT: String(port), BROWSER: 'none', FORCE_COLOR: '0' },
  });
  child.unref();
  fs.closeSync(out);
  return child.pid;                            // detached: the pid is also the process group id
}

// Ready when the port answers; failed if the process group dies first or nothing listens in time.
export async function waitReady(pid, port, ms = 90_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await anyHostOpen(port)) return true;
    if (!alive(pid)) return false;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

export async function stop(pid) {
  if (!pid || !alive(pid)) return;
  try { process.kill(-pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 25 && alive(pid); i++) await new Promise(r => setTimeout(r, 200));
  if (alive(pid)) try { process.kill(-pid, 'SIGKILL'); } catch {}
}

export function tail(name, lines = 40) {
  try { return fs.readFileSync(logPath(name), 'utf8').trimEnd().split('\n').slice(-lines).join('\n'); } catch { return ''; }
}
