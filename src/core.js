// What every Seer command does, shared by the CLI and the MCP server. Nothing here prints: callers report.
//
// Publishing fails closed. A preview's Access app (sign-in) is made BEFORE its tunnel route and DNS record, and
// after publishing the link is fetched without a session: anything but a redirect to the Access login pulls the
// route at once. A dev server must never be reachable from the internet without sign-in in front of it.
import dns from 'node:dns';
import https from 'node:https';
import path from 'node:path';
import { loadConfig, saveConfig, loadPreviews, savePreviews, withLock, cleanName, writeSecret } from './store.js';
import * as dev from './devserver.js';
import * as cf from './cloudflare.js';
import { installAgents, HOME_PORT } from './services.js';

export const hostFor = (cfg, name) => `seer-${name}.${cfg.zone}`;
export const homeHost = cfg => `seer.${cfg.zone}`;

function requireSetup() {
  const cfg = loadConfig();
  if (!cfg.tunnelId || !cfg.policyId) throw new Error('Seer is not set up yet: run `seer setup --zone yourdomain.com --email you@example.com`');
  return cfg;
}

function routes(cfg, previews) {
  const list = [{ host: homeHost(cfg), service: `http://127.0.0.1:${HOME_PORT}` }];
  for (const p of Object.values(previews)) if (p.published) list.push({ host: p.host, service: `http://${p.origin || '127.0.0.1'}:${p.port}` });
  return list;
}
const syncRoutes = (cfg, previews) => cf.putIngress(cfg.accountId, cfg.tunnelId, routes(cfg, previews));

// The link without a session must land on the Access login. 'protected' | 'pending' (DNS not live yet) | 'OPEN'.
// Resolved through 1.1.1.1, not the Mac's resolver: macOS caches the "no such host" from the moments before the
// record existed, and the check would then never see the new name.
const publicDns = new dns.Resolver();
publicDns.setServers(['1.1.1.1', '1.0.0.1']);
function probe(host) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host, path: '/', timeout: 8000,
      lookup: (name, opts, cb) => publicDns.resolve4(name, (err, ips) => opts?.all ? cb(err, (ips || []).map(address => ({ address, family: 4 }))) : cb(err, ips?.[0], 4)),
    }, res => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location || '' }); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
export async function checkProtected(cfg, host) {
  for (let i = 0; i < 10; i++) {
    try {
      const { status, location } = await probe(host);
      if (status >= 300 && status < 400 && /cloudflareaccess\.com/.test(location)) return 'protected';
      if (status === 200 || (status >= 300 && status < 400)) return 'OPEN';
    } catch {}                                 // not resolving yet
    await new Promise(r => setTimeout(r, 3000));
  }
  return 'pending';
}

async function unpublish(cfg, name) {
  await withLock(async () => {
    const previews = loadPreviews(), p = previews[name];
    if (!p) return;
    p.published = false;
    savePreviews(previews);
    await syncRoutes(cfg, previews);
    await cf.removeCname(cfg.zoneId, p.host, cfg.tunnelId);
  });
}

export async function stateOf(p) {
  if (!p) return 'unknown';
  if (p.managed && !dev.alive(p.pid)) return p.status === 'failed' ? 'failed' : 'stopped';
  return (await dev.anyHostOpen(p.port)) ? 'running' : (p.status === 'starting' ? 'starting' : 'not answering');
}

// up: run (or reuse) a dev server and give it a private link.
//   { path, port, name, cmd, restart }  port = an already-running server Seer does not manage.
export async function up(opts = {}) {
  const cfg = requireSetup();
  const dir = path.resolve(opts.path || process.cwd());
  const name = cleanName(opts.name || path.basename(dir));
  const host = hostFor(cfg, name), url = `https://${host}`;

  // 1. reserve the name and a port (locked), 2. start it (unlocked: it can take a minute), 3. publish (locked)
  const plan = await withLock(async () => {
    const previews = loadPreviews(), prev = previews[name];
    if (prev && prev.dir && prev.dir !== dir && (await stateOf(prev)) === 'running')
      throw new Error(`the name "${name}" is in use by ${prev.dir}; pass another --name`);
    if (prev && !opts.restart && !opts.port && (await stateOf(prev)) === 'running' && prev.published)
      return { reuse: prev };
    if (prev?.managed) await dev.stop(prev.pid);
    let entry;
    if (opts.port) {
      const port = Number(opts.port);
      if (!(await dev.anyHostOpen(port))) throw new Error(`nothing is listening on port ${port}`);
      entry = { name, host, url, dir: opts.path ? dir : null, port, managed: false, status: 'running' };
    } else {
      const { cmd, how } = dev.detect(dir, opts.cmd || prev?.cmd);
      const taken = new Set(Object.values(previews).filter(p => p.name !== name).map(p => p.port));
      const port = await dev.freePort(taken);
      entry = { name, host, url, dir, cmd, how, port, managed: true, status: 'starting', published: !!prev?.published };
    }
    entry.updatedAt = new Date().toISOString();
    previews[name] = { ...prev, ...entry };
    savePreviews(previews);
    return { entry: previews[name] };
  });
  if (plan.reuse) return { name, url, status: 'running', reused: true, port: plan.reuse.port };

  let entry = plan.entry;
  if (entry.managed) {
    const pid = dev.start(entry);
    const ok = await dev.waitReady(pid, entry.port);
    await withLock(async () => {
      const previews = loadPreviews();
      previews[name] = { ...previews[name], pid, status: ok ? 'running' : 'failed' };
      savePreviews(previews);
      entry = previews[name];
    });
    if (!ok) { await dev.stop(pid); return { name, url, status: 'failed', how: entry.how, log: dev.tail(name) }; }
  }
  const origin = (await dev.portOpen(entry.port, '127.0.0.1')) ? '127.0.0.1' : '[::1]';

  await withLock(async () => {
    await cf.ensureAccessApp(cfg.accountId, host, cfg.policyId);          // sign-in first: fail closed
    const previews = loadPreviews();
    previews[name] = { ...previews[name], origin, published: true };
    savePreviews(previews);
    try {
      await syncRoutes(cfg, previews);
      await cf.ensureCname(cfg.zoneId, host, cfg.tunnelId);
    } catch (e) {
      previews[name].published = false;
      savePreviews(previews);
      await syncRoutes(cfg, previews).catch(() => {});
      throw e;
    }
  });

  const guard = await checkProtected(cfg, host);
  if (guard === 'OPEN') {
    await unpublish(cfg, name);
    throw new Error(`${url} answered without sign-in, so it was taken down again. Check the Access app for ${host}.`);
  }
  return { name, url, status: 'running', how: entry.how, port: entry.port, signIn: guard };
}

export async function down(name) {
  const cfg = requireSetup();
  name = cleanName(name);
  return withLock(async () => {
    const previews = loadPreviews(), p = previews[name];
    if (!p) throw new Error(`no preview named ${name}`);
    if (p.managed) await dev.stop(p.pid);
    delete previews[name];
    savePreviews(previews);
    await syncRoutes(cfg, previews);
    await cf.removeCname(cfg.zoneId, p.host, cfg.tunnelId);
    await cf.removeAccessApp(cfg.accountId, p.host);
    return { name, stopped: true };
  });
}

export async function restart(name) {
  const p = loadPreviews()[cleanName(name)];
  if (!p) throw new Error(`no preview named ${name}`);
  if (!p.managed) throw new Error(`${name} is a server Seer did not start (port ${p.port}); restart it where it runs`);
  return up({ path: p.dir, name: p.name, cmd: p.cmd, restart: true });
}

export async function status(name) {
  const p = loadPreviews()[cleanName(name)];
  if (!p) throw new Error(`no preview named ${name}`);
  const state = await stateOf(p);
  return { name: p.name, url: p.url, state, port: p.port, dir: p.dir, how: p.how, ...(state === 'running' ? {} : { log: dev.tail(p.name) }) };
}

export async function list() {
  const out = [];
  for (const p of Object.values(loadPreviews())) out.push({ name: p.name, url: p.url, state: await stateOf(p), port: p.port, dir: p.dir });
  return out;
}

// One-time setup: check the token, the zone and Zero Trust; make the tunnel, the sign-in policy and the home page.
export async function setup({ zone, emails }) {
  if (!zone) throw new Error('pass --zone (a domain whose DNS is on Cloudflare)');
  if (!emails?.length) throw new Error('pass --email: who may open your previews');
  const steps = [];
  const { zoneId, accountId } = await cf.zoneInfo(zone);
  steps.push(`token can manage ${zone}`);
  const problem = await cf.accessProblem(accountId);
  if (problem) throw new Error(`Cloudflare Access is not usable yet: open dash.cloudflare.com > Zero Trust, pick a team name and the Free plan (or click Enable Access), then run setup again.\n(${problem})`);
  steps.push('Cloudflare Access is on');
  const idps = await cf.identityProviders(accountId);
  if (idps && !idps.length) steps.push('WARNING: no login method yet. Zero Trust > Settings > Authentication > add "One-time PIN"');
  const { tunnelId, tunnelToken } = await cf.ensureTunnel(accountId);
  writeSecret('tunnel-token', tunnelToken);
  steps.push(`tunnel ${tunnelId}`);
  const prev = loadConfig();
  const policyId = await cf.ensurePolicy(accountId, emails, prev.policyId);
  const cfg = saveConfig({ zone, zoneId, accountId, tunnelId, policyId, emails });
  steps.push(`sign-in allowed for ${emails.join(', ')}`);

  await installAgents();
  steps.push('background services: tunnel + home page (launchd)');
  await withLock(async () => {
    await cf.ensureAccessApp(accountId, homeHost(cfg), policyId);
    await syncRoutes(cfg, loadPreviews());
    await cf.ensureCname(zoneId, homeHost(cfg), tunnelId);
  });
  const guard = await checkProtected(cfg, homeHost(cfg));
  if (guard === 'OPEN') throw new Error(`https://${homeHost(cfg)} answered without sign-in: check its Access app before using Seer`);
  steps.push(`home: https://${homeHost(cfg)} (${guard})`);
  return steps;
}
