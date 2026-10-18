// Cloud copies on Fly: one app (seer-<name>-<suffix>) and one small machine per project, built by Fly's remote
// builder from the files git tracks (so .env files and other ignored secrets never leave the Mac).
//
// Billing guards, all on by construction and none optional:
//   - shared-cpu-1x, 512 MB; one machine (--ha=false); never more than config.cloudMax copies (default 5)
//   - Fly stops the machine when idle (auto_stop) and only a request starts it (min_machines_running 0)
//   - seer-gate inside it exits after 10 idle minutes or 60 minutes in all, and restart policy "never" keeps it
//     down, so an open tab cannot hold it up overnight
// Only apps whose names start with seer- are ever created, changed or destroyed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { HOME, loadConfig, saveConfig, cleanName } from './store.js';

const FLY = ['/opt/homebrew/bin/fly', '/usr/local/bin/fly'].find(f => fs.existsSync(f)) || 'fly';
const GATE = new URL('./cloud/gate.js', import.meta.url).pathname;
const BUILD_ROOT = path.join(HOME, 'build');
const MAX_BYTES = 200 * 1024 * 1024;
export const LIMITS = { vm: 'shared-cpu-1x', memory: '512mb', idleMin: 10, maxMin: 60 };

function fly(args, { input, timeout = 15 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(FLY, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`fly ${args.slice(0, 2).join(' ')} failed: ${(stderr || stdout || err.message).toString().trim().split('\n').slice(-6).join('\n')}`));
      else resolve(String(stdout));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function appName(name) {
  const cfg = loadConfig();
  const suffix = cfg.cloudSuffix || saveConfig({ cloudSuffix: crypto.randomBytes(3).toString('hex') }).cloudSuffix;
  return `seer-${name}-${suffix}`.slice(0, 50);
}

// The files to ship: what git tracks plus new files it is not told to ignore. No git: everything but the usual junk.
function projectFiles(dir) {
  try {
    const out = execFileSync('/usr/bin/git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 64 * 1024 * 1024 });
    return String(out).split('\0').filter(Boolean);
  } catch {
    const files = [];
    const walk = rel => {
      for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist', '.next', '.env'].includes(e.name) || e.name.startsWith('.env')) continue;
        const r = path.join(rel, e.name);
        if (e.isDirectory()) walk(r); else if (e.isFile()) files.push(r);
      }
    };
    walk('');
    return files;
  }
}

function prepareContext(name, dir, { start, build, port, idleMin }) {
  const ctx = path.join(BUILD_ROOT, name);
  fs.rmSync(ctx, { recursive: true, force: true });
  fs.mkdirSync(ctx, { recursive: true });
  let bytes = 0;
  for (const rel of projectFiles(dir)) {
    const src = path.join(dir, rel);
    let st; try { st = fs.lstatSync(src); } catch { continue; }
    if (!st.isFile()) continue;                                   // symlinks and folders: not shipped
    bytes += st.size;
    if (bytes > MAX_BYTES) throw new Error(`${dir} is over ${MAX_BYTES >> 20} MB of tracked files; a cloud copy is for apps, not data`);
    fs.mkdirSync(path.dirname(path.join(ctx, rel)), { recursive: true });
    fs.copyFileSync(src, path.join(ctx, rel));
  }
  fs.copyFileSync(GATE, path.join(ctx, '.seer-gate.mjs'));
  fs.writeFileSync(path.join(ctx, 'Dockerfile.seer'), [
    'FROM node:22-slim',
    'WORKDIR /app',
    'COPY . .',
    'RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; elif [ -f package.json ]; then npm install --no-audit --no-fund; fi',
    ...(build ? [`RUN ${build}`] : []),
    'ENV NODE_ENV=production',
    'CMD ["node", "/app/.seer-gate.mjs"]',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(ctx, 'fly.seer.toml'), `app = "${appName(name)}"
primary_region = "yyz"

[build]
  dockerfile = "Dockerfile.seer"

[env]
  SEER_START = ${JSON.stringify(start)}
  GATE_PORT = "8080"
  APP_PORT = "${port || 8081}"
  IDLE_MIN = "${Math.min(idleMin || LIMITS.idleMin, LIMITS.idleMin)}"
  MAX_MIN = "${LIMITS.maxMin}"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  size = "${LIMITS.vm}"
  memory = "${LIMITS.memory}"

[[restart]]
  policy = "never"
`);
  return { ctx, bytes };
}

export async function cloudUp({ path: dirArg, name: rawName, cmd, build, port, idleMin }) {
  const dir = path.resolve(dirArg || process.cwd());
  const name = cleanName(rawName || path.basename(dir));
  if (!cmd) throw new Error('pass the start command for the cloud copy, e.g. --cmd "node server.js" (it gets PORT)');
  const cfg = loadConfig(), copies = { ...(cfg.cloud || {}) }, max = cfg.cloudMax || 5;
  if (!copies[name] && Object.keys(copies).length >= max)
    throw new Error(`already ${Object.keys(copies).length} cloud copies (limit ${max}); remove one with seer cloud down <name>`);
  const app = appName(name);

  const apps = JSON.parse(await fly(['apps', 'list', '--json']));
  if (!apps.some(a => (a.Name || a.name) === app)) await fly(['apps', 'create', app, '--org', 'personal']);
  const key = copies[name]?.key || crypto.randomBytes(24).toString('base64url');
  copies[name] = { app, key, dir, cmd, build: build || null, url: `https://${app}.fly.dev` };
  saveConfig({ cloud: copies });
  await fly(['secrets', 'import', '--stage', '--app', app], { input: `SEER_KEY=${key}\n` });   // on stdin, never on a command line

  const { ctx, bytes } = prepareContext(name, dir, { start: cmd, build, port, idleMin });   // idleMin can only shorten the limit
  const log = await fly(['deploy', ctx, '--config', path.join(ctx, 'fly.seer.toml'), '--app', app, '--remote-only', '--ha=false', '--strategy', 'immediate', '--yes']);
  fs.writeFileSync(path.join(HOME, 'logs', `cloud-${name}.log`), log);
  await enforceOneMachine(app);
  return { name, app, url: copies[name].url, shippedMB: +(bytes / 1048576).toFixed(1) };
}

// Belt and braces: a copy is one machine, never more, however it was deployed.
async function enforceOneMachine(app) {
  const machines = JSON.parse(await fly(['machines', 'list', '--app', app, '--json']));
  for (const m of machines.slice(1)) await fly(['machines', 'destroy', m.id, '--app', app, '--force']);
}

export async function cloudStatus() {
  const out = [];
  for (const [name, c] of Object.entries(loadConfig().cloud || {})) {
    let machines = [];
    try { machines = JSON.parse(await fly(['machines', 'list', '--app', c.app, '--json'])); } catch {}
    out.push({ name, app: c.app, machines: machines.map(m => ({ id: m.id, state: m.state, size: `${m.config?.guest?.cpu_kind}-${m.config?.guest?.cpus}x ${m.config?.guest?.memory_mb}MB`, updated: m.updated_at })) });
  }
  return out;
}

// Stop any Seer machine that is running (the gate should already have; this is the backstop).
export async function cloudStopAll() {
  const stopped = [];
  for (const c of Object.values(loadConfig().cloud || {})) {
    if (!c.app.startsWith('seer-')) continue;
    const machines = JSON.parse(await fly(['machines', 'list', '--app', c.app, '--json']).catch(() => '[]'));
    for (const m of machines) if (m.state === 'started') { await fly(['machines', 'stop', m.id, '--app', c.app]); stopped.push(`${c.app}/${m.id}`); }
  }
  return stopped;
}

export async function cloudDown(rawName) {
  const name = cleanName(rawName), cfg = loadConfig(), copies = { ...(cfg.cloud || {}) }, c = copies[name];
  if (!c) throw new Error(`no cloud copy named ${name}`);
  if (!c.app.startsWith('seer-')) throw new Error(`refusing to destroy ${c.app}: not a Seer app`);
  await fly(['apps', 'destroy', c.app, '--yes']);
  delete copies[name];
  saveConfig({ cloud: copies });
  return { name, destroyed: c.app };
}
