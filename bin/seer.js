#!/usr/bin/env node
// seer: run a build and get a private link that opens it on your phone.
import { parseArgs } from 'node:util';
import * as core from '../src/core.js';
import { uninstallAgents } from '../src/services.js';

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
  seer uninstall          stop the background services
`;

const { values: o, positionals: [cmd, arg] } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' }, cmd: { type: 'string' }, port: { type: 'string' }, restart: { type: 'boolean' },
    zone: { type: 'string' }, email: { type: 'string', multiple: true }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  },
});

const show = (x, text) => console.log(o.json ? JSON.stringify(x, null, 2) : text);

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
    case 'daemon': await import('../src/daemon.js'); break;
    case 'uninstall': uninstallAgents(); console.log('background services stopped (previews and links are left as they are)'); break;
    default: console.log(HELP); if (cmd && !o.help) process.exitCode = 1;
  }
} catch (e) {
  console.error(`seer: ${e.message}`);
  process.exitCode = 1;
}
