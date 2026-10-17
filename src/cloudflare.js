// The Cloudflare API calls Seer needs: one remotely managed tunnel, a CNAME and an Access app per preview.
// The token (~/.seer/cf-token) needs Account > Cloudflare Tunnel: Edit, Account > Access: Apps and Policies: Edit,
// and Zone > DNS: Edit on the one zone. It is sent only to api.cloudflare.com and never logged.
import { readSecret } from './store.js';

const API = 'https://api.cloudflare.com/client/v4';

async function cf(method, path, body) {
  const token = readSecret('cf-token');
  if (!token) throw new Error('no Cloudflare token: save one to ~/.seer/cf-token (see `seer setup`)');
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json;
  try { json = await res.json(); } catch { json = {}; }
  if (!res.ok || json.success === false) {
    const why = (json.errors || []).map(e => `${e.code}: ${e.message}`).join('; ') || res.statusText;
    const err = new Error(`Cloudflare ${method} ${path.split('?')[0]} failed (${res.status}): ${why}`);
    err.status = res.status;
    throw err;
  }
  return json.result;
}

export async function zoneInfo(zone) {
  const zones = await cf('GET', `/zones?name=${encodeURIComponent(zone)}`);
  if (!zones?.length) throw new Error(`the token cannot see the zone ${zone}`);
  return { zoneId: zones[0].id, accountId: zones[0].account.id };
}

// ---------- tunnel ----------
export async function ensureTunnel(acc, name = 'seer') {
  const found = await cf('GET', `/accounts/${acc}/cfd_tunnel?name=${name}&is_deleted=false`);
  const t = found?.[0] || await cf('POST', `/accounts/${acc}/cfd_tunnel`, { name, config_src: 'cloudflare' });
  const token = await cf('GET', `/accounts/${acc}/cfd_tunnel/${t.id}/token`);
  return { tunnelId: t.id, tunnelToken: token };
}

// The remote config is replaced whole on every write, so it is always rebuilt from the full list of routes.
// httpHostHeader: dev servers such as Vite refuse a Host they do not know, so they are told it is localhost.
export async function putIngress(acc, tunnelId, routes) {
  const ingress = routes.map(r => ({ hostname: r.host, service: r.service, originRequest: { httpHostHeader: 'localhost' } }));
  ingress.push({ service: 'http_status:404' });
  await cf('PUT', `/accounts/${acc}/cfd_tunnel/${tunnelId}/configurations`, { config: { ingress } });
}

// ---------- DNS: only ever the hostnames Seer made (comment 'seer') ----------
export async function ensureCname(zoneId, host, tunnelId) {
  const target = `${tunnelId}.cfargotunnel.com`;
  const same = await cf('GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(host)}`);
  const mine = same.find(r => r.type === 'CNAME' && r.content === target);
  if (mine) return mine.id;
  if (same.length) throw new Error(`${host} already has a DNS record Seer did not make; pick another name`);
  const r = await cf('POST', `/zones/${zoneId}/dns_records`, { type: 'CNAME', name: host, content: target, proxied: true, ttl: 1, comment: 'seer' });
  return r.id;
}
export async function removeCname(zoneId, host, tunnelId) {
  const same = await cf('GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(host)}`);
  for (const r of same) if (r.type === 'CNAME' && r.content === `${tunnelId}.cfargotunnel.com`) await cf('DELETE', `/zones/${zoneId}/dns_records/${r.id}`);
}

// ---------- Access ----------
export async function accessOrg(acc) {
  try { return await cf('GET', `/accounts/${acc}/access/organizations`); } catch { return null; }   // null: Zero Trust not set up
}

export async function ensurePolicy(acc, emails, existingId) {
  const body = { name: 'seer owner', decision: 'allow', include: emails.map(email => ({ email: { email } })), session_duration: '720h' };
  if (existingId) {
    try { await cf('PUT', `/accounts/${acc}/access/policies/${existingId}`, body); return existingId; } catch (e) { if (e.status !== 404) throw e; }
  }
  return (await cf('POST', `/accounts/${acc}/access/policies`, body)).id;
}

export async function ensureAccessApp(acc, host, policyId) {
  const apps = await cf('GET', `/accounts/${acc}/access/apps`);
  const have = apps.find(a => a.domain === host);
  if (have) return have.id;
  const app = await cf('POST', `/accounts/${acc}/access/apps`, {
    name: `seer ${host}`, domain: host, type: 'self_hosted', session_duration: '720h',
    app_launcher_visible: false, policies: [{ id: policyId, precedence: 1 }],
  });
  return app.id;
}
export async function removeAccessApp(acc, host) {
  const apps = await cf('GET', `/accounts/${acc}/access/apps`);
  for (const a of apps) if (a.domain === host) await cf('DELETE', `/accounts/${acc}/access/apps/${a.id}`);
}

export async function identityProviders(acc) {
  try { return await cf('GET', `/accounts/${acc}/access/identity_providers`); } catch { return null; }   // null: the token may not read them
}
