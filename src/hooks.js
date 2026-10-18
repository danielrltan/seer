// Claude Code hooks that tell Seer when an agent is working: busy on each prompt, waiting when it needs the owner,
// idle when it stops. Added to ~/.claude/settings.json (backed up first) beside the hooks already there; run
// again, it changes nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = path.join(os.homedir(), '.claude', 'settings.json');
const EVENTS = [['UserPromptSubmit', 'busy'], ['Notification', 'waiting'], ['Stop', 'idle']];
const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } };

// How many of the three are in place (3 = all).
export function hooksInstalled() {
  const settings = read();
  return EVENTS.filter(([event, state]) => JSON.stringify(settings?.hooks?.[event] || []).includes('seer-hook.js ' + state)).length;
}

export function installHooks() {
  const settings = read();
  if (!settings) throw new Error(`could not read ${FILE}`);
  const cmd = state => `${process.execPath} ${new URL('../bin/seer-hook.js', import.meta.url).pathname} ${state}`;
  settings.hooks ||= {};
  let added = 0;
  for (const [event, state] of EVENTS) {
    const list = settings.hooks[event] ||= [];
    if (JSON.stringify(list).includes('seer-hook.js ' + state)) continue;
    list.push({ hooks: [{ type: 'command', command: cmd(state), timeout: 5 }] });
    added++;
  }
  if (!added) return 'Claude Code hooks already in place';
  fs.copyFileSync(FILE, `${FILE}.bak-before-seer-hooks`);
  fs.writeFileSync(FILE, JSON.stringify(settings, null, 2) + '\n');
  return `added ${added} Claude Code hook${added > 1 ? 's' : ''} (backup: ${FILE}.bak-before-seer-hooks)`;
}
