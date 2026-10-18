#!/usr/bin/env node
// seer: run a build and get a private link that opens it on your phone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import * as core from '../src/core.js';
import * as away from '../src/awake.js';
import * as cloud from '../src/cloud.js';
import { recordHook } from '../src/activity.js';
import { uninstallAgents, installAgents } from '../src/services.js';
import { HOME, loadConfig, saveConfig, loadPreviews } from '../src/store.js';

const HELP = `seer: run a build and get a private link to open it on your phone

  seer up [path] [--name N] [--cmd "..."] [--port P] [--restart]
        run the dev server in path (default: here) and print its link
        --cmd   how to start it; {port} and $PORT are its port
        --port  publish a server that is already running instead
  seer status <name>      running, stopped or failed (with its log)
  seer restart <name>     start it again from the same folder
  seer down <name>        stop it; the link stops working
  seer list               every preview and its link
  seer setup --zone example.com --email you@example.com [--email ...]
  seer cloud up [path] --name N --cmd "start command" [--build "cmd"]   a cloud copy on Fly (sleeps when idle)
  seer cloud status | stop | down <name>
  seer desktop on|off     the parked remote desktop (/desktop): off unless turned on
  seer away on|off        keep the Mac awake while previews run, even with the lid closed (off by default)
  seer away install       let Seer keep the Mac awake with the lid closed (asks for sudo once)
  seer away hotspot "SSID"  fail over to this phone hotspot when the Wi-Fi goes (password on stdin)
  seer away status        what away mode is doing now
  seer away hooks         tell Seer when Claude Code agents are working (adds two hooks)
  seer away reachable N   stay reachable N minutes after the last activity (default 15)
  seer away join          join the hotspot now, to test it (switches Wi-Fi)
  seer uninstall          stop the background services and let the Mac sleep normally
`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' }, cmd: { type: 'string' }, port: { type: 'string' }, restart: { type: 'boolean' },
    zone: { type: 'string' }, build: { type: 'string' }, idle: { type: 'string' }, email: { type: 'string', multiple: true }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  },
});

const [cmd, arg] = positionals;
const show = (x, text) => console.log(o.json ? JSON.stringify(x, null, 2) : text);

async function readHidden(prompt) {            // a typed password without echo, or whatever is piped in
  if (!process.stdin.isTTY) { let s = ''; for await (const c of process.stdin) s += c; return s.trim(); }
  process.stdout.write(prompt);
  execFileSync('/bin/stty', ['-echo'], { stdio: 'inherit' });
  try { return (await new Promise(r => process.stdin.once('data', d => r(String(d))))).trim(); }
  finally { execFileSync('/bin/stty', ['echo'], { stdio: 'inherit' }); process.stdout.write('\n'); process.stdin.pause(); }
}

// Claude Code hooks that tell Seer when an agent is working: busy on each prompt, idle when it stops. Added to
// ~/.claude/settings.json (backed up first) beside the hooks already there; run again, it changes nothing.
function installHooks() {
  const file = path.join(os.homedir(), '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cmd = state => `${process.execPath} ${new URL('./seer-hook.js', import.meta.url).pathname} ${state}`;
  settings.hooks ||= {};
  let added = 0;
  for (const [event, state] of [['UserPromptSubmit', 'busy'], ['Notification', 'waiting'], ['Stop', 'idle']]) {
    const list = settings.hooks[event] ||= [];
    if (JSON.stringify(list).includes('seer-hook.js ' + state)) continue;
    list.push({ hooks: [{ type: 'command', command: cmd(state), timeout: 5 }] });
    added++;
  }
  if (!added) return 'Claude Code hooks already in place';
  fs.copyFileSync(file, `${file}.bak-before-seer-hooks`);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return `added ${added} Claude Code hook${added > 1 ? 's' : ''} (backup: ${file}.bak-before-seer-hooks)`;
}

async function awayCmd(sub, value) {
  if (sub === 'install') {
    const file = path.join(HOME, 'sudoers-seer');
    fs.writeFileSync(file, away.sudoersRule(os.userInfo().username), { mode: 0o644 });
    if (await away.ruleInstalled()) return console.log('away mode is already allowed (sudoers rule found)');
    console.log(`Seer needs one sudoers rule, allowing only these pmset commands without a password:\n\n${fs.readFileSync(file, 'utf8')}`);
    console.log(`Run this in Terminal (it asks for your password once):\n\n  sudo visudo -cf ${file} && sudo install -m 440 -o root -g wheel ${file} ${away.SUDOERS_FILE}\n\nthen: seer away status`);
    return;
  }
  if (sub === 'hotspot') {
    if (!value) throw new Error('pass the hotspot name exactly as the phone shows it, e.g. seer away hotspot "Daniel\'s iPhone"');
    if (!fs.existsSync(away.WIFI_HELPER)) {
      fs.mkdirSync(path.dirname(away.WIFI_HELPER), { recursive: true });
      execFileSync('/usr/bin/swiftc', ['-O', '-o', away.WIFI_HELPER, new URL('../src/helpers/seer-wifi.swift', import.meta.url).pathname], { stdio: 'inherit' });
    }
    const pw = await readHidden(`Password for ${value}: `);
    if (!pw) throw new Error('no password given');
    await away.savePassword(value, pw);
    saveConfig({ hotspotSsid: value });
    return console.log(`hotspot set: ${value} (password in the login keychain). Test it with: seer away join`);
  }
  if (sub === 'on' || sub === 'off') { saveConfig({ away: sub === 'on' }); if (sub === 'off') await away.release(); return console.log(`away mode ${sub}`); }
  if (sub === 'hooks') return console.log(installHooks());
  if (sub === 'reachable') { const m = Number(value); if (!(m >= 0 && m <= 24 * 60)) throw new Error('seer away reachable <minutes>'); saveConfig({ reachableMin: m }); return console.log(`reachable for ${m} min after the last activity`); }
  if (sub === 'join') return console.log(`hotspot join: ${await away.joinHotspot()}`);
  if (sub === 'status' || !sub) {
    const rule = await away.ruleInstalled(), b = await away.battery();
    const st = { lidClosedAwake: rule ? 'allowed' : 'not installed (seer away install)', sleepDisabledNow: await away.sleepDisabled(),
      battery: b.onBattery ? `${b.pct}% on battery` : `plugged in (${b.pct}%)`, hotspot: loadConfig().hotspotSsid || 'not set', online: await away.online() };
    return show(st, Object.entries(st).map(([k, v]) => `${k.padEnd(17)} ${v}`).join('\n'));
  }
  throw new Error(`unknown: seer away ${sub}`);
}

try {
  switch (cmd) {
    case 'up': {
      const r = await core.up({ path: arg, name: o.name, cmd: o.cmd, port: o.port, restart: o.restart });
      if (r.status === 'failed') { show(r, `${r.name} failed to start (${r.how}). Last lines of its log:\n\n${r.log}`); process.exitCode = 1; break; }
      show(r, `${r.url}${r.reused ? '  (already running)' : ''}${r.signIn === 'pending' ? '\n(DNS is still spreading; the link works in a minute)' : ''}`);
      break;
    }
    case 'status': {
      const r = await core.status(arg);
      show(r, `${r.name}: ${r.state}  ${r.url}${r.log ? `\n\n${r.log}` : ''}`);
      break;
    }
    case 'restart': { const r = await core.restart(arg); show(r, r.status === 'failed' ? `${r.name} failed to start:\n\n${r.log}` : r.url); break; }
    case 'down': { const r = await core.down(arg); show(r, `${r.name} stopped`); break; }
    case 'list': case 'ls': {
      const all = await core.list();
      show(all, all.length ? all.map(p => `${p.state.padEnd(13)} ${p.name.padEnd(24)} ${p.url}`).join('\n') : 'No previews running.');
      break;
    }
    case 'setup': { const steps = await core.setup({ zone: o.zone, emails: o.email }); show(steps, steps.map(s => `- ${s}`).join('\n')); break; }
    case 'cloud': {
      const sub = arg, rest = positionals[2];
      if (sub === 'up') { const r = await cloud.cloudUp({ path: rest, name: o.name, cmd: o.cmd, build: o.build, idleMin: o.idle ? Number(o.idle) : undefined }); show(r, `${r.link}  (${r.app}, ${r.shippedMB} MB shipped, sign-in ${r.signIn})`); }
      else if (sub === 'front') { const p = loadPreviews()[rest]; if (!p) throw new Error(`no live preview named ${rest}`); const r = await cloud.frontMacLink(p.host); show(r, `${r.link}  (front door on, ${r.signIn})`); }
      else if (sub === 'link') { const r = await cloud.cloudLink(rest); show(r, `${r.link}  (${r.signIn})`); }
      else if (sub === 'status') { const r = await cloud.cloudStatus(); show(r, r.map(c => `${c.name} (${c.app}): ${c.machines.map(m => `${m.state} ${m.size}`).join(', ') || 'no machines'}`).join('\n') || 'no cloud copies'); }
      else if (sub === 'stop') { const r = await cloud.cloudStopAll(); show(r, r.length ? `stopped ${r.join(', ')}` : 'nothing was running'); }
      else if (sub === 'down') { const r = await cloud.cloudDown(rest); show(r, `destroyed ${r.destroyed}`); }
      else throw new Error('seer cloud up | status | stop | down <name>');
      break;
    }
    case 'desktop': {
      if (!['on', 'off'].includes(arg)) throw new Error('seer desktop on | off');
      saveConfig({ desktop: arg === 'on' });
      await installAgents();
      console.log(`remote desktop ${arg}${arg === 'on' ? ' (needs ~/.seer/SeerStream.app: scripts/build-stream.sh)' : ''}`);
      break;
    }
    case 'hook': {                          // from Claude Code's hooks: never slow, never failing
      let input = ''; if (!process.stdin.isTTY) for await (const c of process.stdin) input += c;
      recordHook(arg === 'busy' ? 'busy' : 'idle', input);
      break;
    }
    case 'away': await awayCmd(arg, positionals[2]); break;
    case 'daemon': await import('../src/daemon.js'); break;
    case 'uninstall': uninstallAgents(); await away.release(); console.log('background services stopped and normal sleep restored (previews and links are left as they are)'); break;
    default: console.log(HELP); if (cmd && !o.help) process.exitCode = 1;
  }
} catch (e) {
  console.error(`seer: ${e.message}`);
  process.exitCode = 1;
}
