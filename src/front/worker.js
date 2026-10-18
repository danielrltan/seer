// Seer's front door: a Cloudflare Worker on every cloud-copy link (seer-<name>.<zone>).
// Cloudflare Access signs the visitor in before this runs; the Worker then forwards to the project's Fly
// machine with the copy's key, which is the only way past the machine's gate. A request that did not come
// through Access is refused here too.
// SEER_ROUTES (a secret binding): { "<hostname>": { "app": "seer-<name>-<suffix>", "key": "<gate key>" } }
//
// Desktop view: /__seer/desktop shows the project in a 1440 px wide frame scaled to the phone, and while the
// seer_view=desktop cookie is set the project is told it runs on a computer: a desktop User-Agent to its
// server, and to its scripts no touch points, a fine pointer, a 1440x900 screen and a Mac platform. A small
// eye button (on the project's own pages, in the phone view) switches to it.
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const WIDTH = 1440;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const routes = JSON.parse(env.SEER_ROUTES || '{}'), route = routes[url.hostname];
    if (!route) return new Response('Not found', { status: 404 });
    if (!request.headers.get('cf-access-jwt-assertion')) return new Response('Sign in first', { status: 403 });

    const dest = request.headers.get('sec-fetch-dest') || '';
    let desktop = /(?:^|;\s*)seer_view=desktop/.test(request.headers.get('cookie') || ''), reset = false;
    if (desktop && dest === 'document') { desktop = false; reset = true; }   // opened directly: back to phone view
    if (url.pathname === '/__seer/desktop') return desktopFrame(url.searchParams.get('path'));
    if (url.pathname === '/__seer/phone') return redirectClearing(safePath(url.searchParams.get('path')));

    const target = new URL(url.pathname + url.search, `https://${route.app}.fly.dev`);
    const headers = new Headers(request.headers);
    headers.set('x-seer-key', route.key);
    headers.delete('cf-access-jwt-assertion');
    if (desktop) { headers.set('user-agent', DESKTOP_UA); headers.delete('sec-ch-ua-mobile'); headers.delete('sec-ch-ua-platform'); }
    // Access's own cookie and Seer's view cookie stay at the front door; the project never sees them.
    const cookies = (headers.get('cookie') || '').split(/;\s*/).filter(c => c && !/^(CF_Authorization|seer_view)=/.test(c));
    if (cookies.length) headers.set('cookie', cookies.join('; ')); else headers.delete('cookie');

    const init = { method: request.method, headers, redirect: 'manual', body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body };
    let res = await fetch(target, init);
    // A machine that was asleep can answer 502/503 while it starts: one retry after a short wait.
    if ((res.status === 502 || res.status === 503) && init.body === undefined && !request.headers.get('upgrade')) {
      await new Promise(r => setTimeout(r, 1500));
      res = await fetch(target, init);
    }

    if (reset) { res = new Response(res.body, res); res.headers.append('set-cookie', 'seer_view=; Path=/; Max-Age=0; Secure; SameSite=Lax'); }
    if (!(res.headers.get('content-type') || '').includes('text/html')) return res;
    if (desktop && dest === 'iframe') return new HTMLRewriter().on('head', { element: e => e.prepend(DESKTOP_SHIM, { html: true }) }).transform(res);
    if (!desktop && (dest === 'document' || !dest)) return new HTMLRewriter().on('body', { element: e => e.append(VIEW_BUTTON, { html: true }) }).transform(res);
    return res;
  },
};

const safePath = p => (p && p.startsWith('/') && !p.startsWith('//') ? p : '/');

function redirectClearing(path) {
  return new Response(null, { status: 302, headers: { location: path, 'set-cookie': 'seer_view=; Path=/; Max-Age=0; Secure; SameSite=Lax' } });
}

// The frame page: the project at 1440 px wide, scaled to the phone's width; pinch to zoom; Phone to go back.
function desktopFrame(rawPath) {
  const path = safePath(rawPath);
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#000"><title>Desktop view</title>
<style>
html,body{margin:0;height:100%;background:#000;overflow:auto}
#f{position:absolute;top:0;left:0;width:${WIDTH}px;border:0;transform-origin:0 0;background:#fff}
#phone{position:fixed;right:calc(10px + env(safe-area-inset-right));bottom:calc(10px + env(safe-area-inset-bottom));z-index:2;height:34px;padding:0 12px;border-radius:17px;border:1px solid #262626;background:rgba(10,10,10,.85);color:#ededed;font:500 13px -apple-system,system-ui,sans-serif}
</style></head><body>
<iframe id="f" src="${path.replace(/"/g, '&quot;')}"></iframe>
<button id="phone">Phone view</button>
<script>
const f = document.getElementById('f');
function fit() { const s = document.documentElement.clientWidth / ${WIDTH}; f.style.transform = 'scale(' + s + ')'; f.style.height = Math.ceil(innerHeight / s) + 'px'; }
addEventListener('resize', fit); fit();
document.getElementById('phone').onclick = () => {
  let p = '/'; try { const l = f.contentWindow.location; p = l.pathname + l.search + l.hash; } catch {}
  location.href = '/__seer/phone?path=' + encodeURIComponent(p);
};
</script></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': 'seer_view=desktop; Path=/; Secure; SameSite=Lax' } });
}

// Runs first in every page of the desktop view, before the project's own scripts.
const DESKTOP_SHIM = `<script>(() => {
  const def = (o, k, v) => { try { Object.defineProperty(o, k, { get: () => v, configurable: true }); } catch {} };
  def(navigator, 'userAgent', ${JSON.stringify(DESKTOP_UA)}); def(navigator, 'platform', 'MacIntel');
  def(navigator, 'maxTouchPoints', 0); def(screen, 'width', ${WIDTH}); def(screen, 'height', 900);
  def(screen, 'availWidth', ${WIDTH}); def(screen, 'availHeight', 875);
  const mm = window.matchMedia.bind(window);
  window.matchMedia = q => mm(String(q)
    .replace(/\\(\\s*(any-)?pointer\\s*:\\s*coarse\\s*\\)/g, '(max-width: 0px)').replace(/\\(\\s*(any-)?pointer\\s*:\\s*fine\\s*\\)/g, '(min-width: 0px)')
    .replace(/\\(\\s*(any-)?hover\\s*:\\s*none\\s*\\)/g, '(max-width: 0px)').replace(/\\(\\s*(any-)?hover\\s*:\\s*hover\\s*\\)/g, '(min-width: 0px)'));
})();</script>`;

// The switch to desktop view: one small eye in the corner, in its own shadow root so the project's CSS
// cannot touch it (and it cannot touch the project's).
const VIEW_BUTTON = `<div id="seer-view-switch"></div><script>(() => {
  const host = document.getElementById('seer-view-switch'), root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<style>a{position:fixed;left:calc(10px + env(safe-area-inset-left));bottom:calc(10px + env(safe-area-inset-bottom));z-index:2147483647;width:36px;height:36px;border-radius:18px;background:rgba(10,10,10,.8);border:1px solid #262626;display:flex;align-items:center;justify-content:center;opacity:.75}</style>'
    + '<a aria-label="Desktop view"><svg width="20" height="13" viewBox="0 0 22 14"><path d="M1 7C4 2 7.5 1 11 1s7 1 10 6c-3 5-6.5 6-10 6S4 12 1 7Z" fill="none" stroke="#ededed" stroke-width="1.4"/><circle cx="11" cy="7" r="2.6" fill="#00e676"/></svg></a>';
  root.querySelector('a').onclick = () => { location.href = '/__seer/desktop?path=' + encodeURIComponent(location.pathname + location.search + location.hash); };
})();</script>`;
