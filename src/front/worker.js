// Seer's front door: a Cloudflare Worker on every cloud-copy link (seer-<name>.<zone>).
// Cloudflare Access signs the visitor in before this runs; the Worker then forwards to the project's Fly
// machine with the copy's key, which is the only way past the machine's gate. A request that did not come
// through Access is refused here too.
// SEER_ROUTES (a secret binding): { "<hostname>": { "app": "seer-<name>-<suffix>", "key": "<gate key>" } }
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const routes = JSON.parse(env.SEER_ROUTES || '{}'), route = routes[url.hostname];
    if (!route) return new Response('Not found', { status: 404 });
    if (!request.headers.get('cf-access-jwt-assertion')) return new Response('Sign in first', { status: 403 });

    const target = new URL(url.pathname + url.search, `https://${route.app}.fly.dev`);
    const headers = new Headers(request.headers);
    headers.set('x-seer-key', route.key);
    headers.delete('cf-access-jwt-assertion');
    // Access's own cookie stays at the front door; the project never sees it.
    const cookies = (headers.get('cookie') || '').split(/;\s*/).filter(c => c && !c.startsWith('CF_Authorization='));
    if (cookies.length) headers.set('cookie', cookies.join('; ')); else headers.delete('cookie');

    const init = { method: request.method, headers, redirect: 'manual', body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body };
    let res = await fetch(target, init);
    // A machine that was asleep can answer 502/503 while it starts: one retry after a short wait.
    if ((res.status === 502 || res.status === 503) && init.body === undefined && !request.headers.get('upgrade')) {
      await new Promise(r => setTimeout(r, 1500));
      res = await fetch(target, init);
    }
    return res;
  },
};
