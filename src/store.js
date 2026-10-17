// Everything Seer keeps lives in ~/.seer: config.json (ids, the zone, who may sign in), cf-token and
// tunnel-token (secrets, chmod 600, never logged), previews.json (the registry) and logs/<name>.log.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.SEER_HOME || path.join(os.homedir(), '.seer');
export const LOGS = path.join(HOME, 'logs');
const CONFIG = path.join(HOME, 'config.json');
const PREVIEWS = path.join(HOME, 'previews.json');
const LOCK = path.join(HOME, 'lock');

export function ensureHome() {
  fs.mkdirSync(LOGS, { recursive: true, mode: 0o700 });
}

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, value) => {           // write then rename, so a crash never leaves half a file
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
};

export const loadConfig = () => readJson(CONFIG, {});
export function saveConfig(patch) {
  ensureHome();
  const next = { ...loadConfig(), ...patch };
  writeJson(CONFIG, next);
  return next;
}

export function readSecret(name) {             // cf-token | tunnel-token
  try { return fs.readFileSync(path.join(HOME, name), 'utf8').trim(); } catch { return ''; }
}
export function writeSecret(name, value) {
  ensureHome();
  fs.writeFileSync(path.join(HOME, name), value.trim() + '\n', { mode: 0o600 });
  fs.chmodSync(path.join(HOME, name), 0o600);
}
export const secretPath = name => path.join(HOME, name);

export const loadPreviews = () => readJson(PREVIEWS, {});
export const savePreviews = previews => { ensureHome(); writeJson(PREVIEWS, previews); };

// One writer at a time: parallel agent sessions can run `seer up` together, and the tunnel's config is
// rebuilt whole from the registry on every change, so two unlocked writers would drop each other's routes.
export async function withLock(fn) {
  ensureHome();
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { fs.mkdirSync(LOCK); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 120_000) { fs.rmdirSync(LOCK); continue; } } catch {}   // a holder that crashed
      if (Date.now() > deadline) throw new Error('another seer command is still running (~/.seer/lock); try again');
      await new Promise(r => setTimeout(r, 200));
    }
  }
  try { return await fn(); } finally { try { fs.rmdirSync(LOCK); } catch {} }
}

// A name becomes part of a hostname (seer-<name>.<zone>): lowercase letters, digits and dashes only.
export function cleanName(raw) {
  const n = String(raw || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  if (!n) throw new Error(`"${raw}" does not make a usable name; pass --name with letters or digits`);
  return n;
}
