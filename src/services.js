// The two things that run in the background, as launchd agents so they survive logouts and restarts:
//   dev.seer.tunnel  cloudflared, reading its token from ~/.seer/tunnel-token (never on a command line)
//   dev.seer.daemon  `seer daemon`: the home page on 127.0.0.1:7399, and caffeinate while a preview runs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME, LOGS, secretPath } from './store.js';

export const HOME_PORT = 7399;
const AGENTS = path.join(os.homedir(), 'Library', 'LaunchAgents');
const SEER_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'seer.js');
const STREAM_BIN = path.join(HOME, 'SeerStream.app', 'Contents', 'MacOS', 'SeerStream');

const which = bin => { try { return execFileSync('/usr/bin/which', [bin], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function plist(label, args, logName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(LOGS, logName))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(LOGS, logName))}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH || '/usr/bin:/bin')}</string><key>SEER_HOME</key><string>${xml(HOME)}</string></dict>
</dict></plist>
`;
}

// bootout returns before the old job is gone, and a bootstrap in that window fails (5: Input/output error), so
// wait for it to disappear, and retry the bootstrap briefly.
function load(label, file) {
  const domain = `gui/${process.getuid()}`, loaded = () => { try { execFileSync('/bin/launchctl', ['print', `${domain}/${label}`], { stdio: 'ignore' }); return true; } catch { return false; } };
  try { execFileSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' }); } catch {}
  for (let i = 0; i < 50 && loaded(); i++) execFileSync('/bin/sleep', ['0.1']);
  for (let i = 0; ; i++) {
    try { execFileSync('/bin/launchctl', ['bootstrap', domain, file], { stdio: 'pipe' }); return; }
    catch (e) { if (i >= 10) throw new Error(`launchctl bootstrap ${label}: ${String(e.stderr || e.message).trim()}`); execFileSync('/bin/sleep', ['0.3']); }
  }
}

export async function installAgents() {
  const cloudflared = which('cloudflared');
  if (!cloudflared) throw new Error('cloudflared is not installed: brew install cloudflared');
  fs.mkdirSync(AGENTS, { recursive: true });
  const agents = [
    ['dev.seer.tunnel', [cloudflared, 'tunnel', '--no-autoupdate', 'run', '--token-file', secretPath('tunnel-token')], 'tunnel.log'],
    ['dev.seer.daemon', [process.execPath, SEER_BIN, 'daemon'], 'daemon.log'],
  ];
  // Streamed mode: the screen-capture helper, as its own agent so its permissions are its own (scripts/build-stream.sh).
  if (fs.existsSync(STREAM_BIN)) agents.push(['dev.seer.stream', [STREAM_BIN], 'stream.log']);
  for (const [label, args, log] of agents) {
    const file = path.join(AGENTS, `${label}.plist`);
    fs.writeFileSync(file, plist(label, args, log));
    load(label, file);
  }
}

export function uninstallAgents() {
  for (const label of ['dev.seer.tunnel', 'dev.seer.daemon', 'dev.seer.stream']) {
    try { execFileSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' }); } catch {}
    try { fs.unlinkSync(path.join(AGENTS, `${label}.plist`)); } catch {}
  }
}
