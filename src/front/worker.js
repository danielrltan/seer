// Seer's front door: a Cloudflare Worker on every cloud-copy link (seer-<name>.<zone>).
// Cloudflare Access signs the visitor in before this runs; the Worker then forwards to the project's Fly
// machine with the copy's key, which is the only way past the machine's gate. A request that did not come
// through Access is refused here too.
// SEER_ROUTES (a secret binding): { "<hostname>": { "app": "seer-<name>-<suffix>", "key": "<gate key>" } }
//   or { "<hostname>": { "mac": true } }: a live link to the Mac, passed on to the hostname's own origin (the tunnel).
//
// Desktop view: /__seer/desktop shows the project in a 1440x900 frame scaled to the phone. While the
// seer_view=desktop cookie is set, the project gets a desktop-sized screen and a Mac (a desktop User-Agent to
// its server; screen size and platform to its scripts), the way an iPad asks for desktop sites, but stays
// honest about the touchscreen and the phone's hardware: sites key their memory protections to those, and
// faking a mouse or a laptop's cores made danielrltan.com stand up every 3D section at once and crash the tab.
// If a desktop view crashes anyway, the next load is light (seer_lite: the site is told the device is short on
// memory, so it serves its own fallbacks). A small eye button on the project's pages switches to the view.
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const WIDTH = 1440, HEIGHT = 900;   // a laptop screen: a taller frame would render several screens of the page at once

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const routes = JSON.parse(env.SEER_ROUTES || '{}'), route = routes[url.hostname];
    if (!route) return new Response('Not found', { status: 404 });
    if (!request.headers.get('cf-access-jwt-assertion')) return new Response('Sign in first', { status: 403 });

    const dest = request.headers.get('sec-fetch-dest') || '';
    const cookieHeader = request.headers.get('cookie') || '';
    const mode = (cookieHeader.match(/(?:^|;\s*)seer_view=(laptop|tablet)/) || [])[1];
    let desktop = !!mode, reset = false;
    const lite = /(?:^|;\s*)seer_lite=1/.test(cookieHeader);
    if (desktop && dest === 'document') { desktop = false; reset = true; }   // opened directly: back to phone view
    if (url.pathname === '/__seer/desktop') return desktopFrame(url.searchParams.get('path'), mode, lite);
    if (url.pathname === '/__seer/phone') return redirectClearing(safePath(url.searchParams.get('path')));

    const target = route.mac ? new URL(request.url) : new URL(url.pathname + url.search, `https://${route.app}.fly.dev`);
    const headers = new Headers(request.headers);
    if (!route.mac) headers.set('x-seer-key', route.key);
    // A live Mac link is passed to the same hostname, which Access guards too: it keeps the sign-in (cookie and
    // token) or Access would send it back to the login page, round and round. A cloud copy never sees them.
    if (!route.mac) headers.delete('cf-access-jwt-assertion');
    if (desktop) { headers.set('user-agent', DESKTOP_UA); headers.delete('sec-ch-ua-mobile'); headers.delete('sec-ch-ua-platform'); }
    // Seer's view cookie stays at the front door; so does Access's, except on the way to the Mac (above).
    const cookies = (headers.get('cookie') || '').split(/;\s*/).filter(c => c && !(route.mac ? /^seer_(view|lite)=/ : /^(CF_Authorization|seer_view|seer_lite)=/).test(c));
    if (cookies.length) headers.set('cookie', cookies.join('; ')); else headers.delete('cookie');

    const init = { method: request.method, headers, redirect: 'manual', body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body };
    let res = await fetch(target, init);
    // A machine that was asleep can answer 502/503 while it starts: one retry after a short wait.
    if ((res.status === 502 || res.status === 503) && init.body === undefined && !request.headers.get('upgrade')) {
      await new Promise(r => setTimeout(r, 1500));
      res = await fetch(target, init);
    }

    console.log(JSON.stringify({ host: url.hostname, path: url.pathname, dest, mac: !!route.mac, desktop, status: res.status, location: res.headers.get('location') || undefined }));
    if (reset) { res = new Response(res.body, res); res.headers.append('set-cookie', 'seer_view=; Path=/; Max-Age=0; Secure; SameSite=Lax'); }
    if (!(res.headers.get('content-type') || '').includes('text/html')) return res;
    if (desktop && dest === 'iframe') return new HTMLRewriter().on('head', { element: e => e.prepend((mode === 'tablet' ? TABLET_SHIM : LAPTOP_SHIM) + (lite ? LITE_SHIM : ''), { html: true }) }).transform(res);
    if (!desktop && (dest === 'document' || !dest)) return new HTMLRewriter().on('body', { element: e => e.append(VIEW_BUTTON, { html: true }) }).transform(res);
    return res;
  },
};

const safePath = p => (p && p.startsWith('/') && !p.startsWith('//') ? p : '/');

function redirectClearing(path) {
  const h = new Headers({ location: path });
  for (const c of ['seer_view', 'seer_lite']) h.append('set-cookie', `${c}=; Path=/; Max-Age=0; Secure; SameSite=Lax`);
  return new Response(null, { status: 302, headers: h });
}

// The frame page: the project at 1440 px wide, scaled to the phone's width; pinch to zoom; Phone to go back.
function desktopFrame(rawPath, mode, lite) {
  const path = safePath(rawPath);
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#000"><title>Desktop view</title>
<style>
html,body{margin:0;height:100%;background:#000;overflow:auto}
#f{position:absolute;top:0;left:0;width:${WIDTH}px;height:${HEIGHT}px;border:0;transform-origin:0 0;background:#fff}
#bar{position:fixed;right:calc(10px + env(safe-area-inset-right));bottom:calc(10px + env(safe-area-inset-bottom));z-index:2;display:flex;gap:6px}
#bar button{height:34px;padding:0 12px;border-radius:17px;border:1px solid #262626;background:rgba(10,10,10,.85);color:#a1a1a1;font:500 13px -apple-system,system-ui,sans-serif}
#bar button.on{color:#ededed;border-color:#00e676}
</style></head><body>
<iframe id="f"></iframe>
<div id="bar"><button id="laptop">Laptop</button><button id="tablet">iPad</button><button id="phone">Phone</button></div>
<script>
const f = document.getElementById('f');
const setCookie = (k, v) => { document.cookie = k + '=' + v + '; Path=/; Secure; SameSite=Lax'; };
// A view that crashed the tab (iOS reloads it) never reached pagehide: step down, laptop -> iPad -> light.
let mode = ${JSON.stringify(mode || 'laptop')}, crashed = false;
try { crashed = sessionStorage.getItem('seer-desktop-open') === '1'; sessionStorage.setItem('seer-desktop-open', '1'); } catch {}
addEventListener('pagehide', () => { try { sessionStorage.removeItem('seer-desktop-open'); } catch {} });
if (crashed) { if (mode === 'laptop') mode = 'tablet'; else setCookie('seer_lite', '1'); }
setCookie('seer_view', mode);
const mark = () => { for (const m of ['laptop', 'tablet']) document.getElementById(m).classList.toggle('on', m === mode); };
mark();
f.src = ${JSON.stringify(path)};
const here = () => { try { const l = f.contentWindow.location; return l.pathname + l.search + l.hash; } catch { return ${JSON.stringify(path)}; } };
for (const m of ['laptop', 'tablet']) document.getElementById(m).onclick = () => {
  if (m === mode) return;
  mode = m; setCookie('seer_view', m); document.cookie = 'seer_lite=; Path=/; Max-Age=0; Secure; SameSite=Lax'; mark();
  f.src = here();
};
function fit() {
  const w = document.documentElement.clientWidth, h = innerHeight, s = Math.min(w / ${WIDTH}, h / ${HEIGHT});
  f.style.transform = 'translate(' + Math.max(0, (w - ${WIDTH} * s) / 2) + 'px,' + Math.max(0, (h - ${HEIGHT} * s) / 2) + 'px) scale(' + s + ')';
}
addEventListener('resize', fit); fit();
document.getElementById('phone').onclick = () => { location.href = '/__seer/phone?path=' + encodeURIComponent(here()); };
</script></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

// Runs first in every page of the desktop view, before the project's own scripts.
// Every desktop mode: a desktop-sized screen, a Mac, and 1x pixels (the frame is scaled down anyway; a phone's
// 3x would make canvases 9x the pixels).
const BASE_SHIM = `
  const def = (o, k, v) => { try { Object.defineProperty(o, k, { get: () => v, configurable: true }); } catch {} };
  def(navigator, 'userAgent', ${JSON.stringify(DESKTOP_UA)}); def(navigator, 'platform', 'MacIntel');
  def(screen, 'width', ${WIDTH}); def(screen, 'height', ${HEIGHT}); def(screen, 'availWidth', ${WIDTH}); def(screen, 'availHeight', ${HEIGHT - 25});
  def(window, 'devicePixelRatio', 1);`;
// Laptop (the default): exactly a laptop to the page's scripts: no touch points, a fine pointer that hovers,
// a laptop's cores and memory. Pages then do what they do on a computer, eager loading included. Only CSS
// written for touch (@media (pointer: coarse) in a stylesheet) still sees the phone; a script cannot change that.
const LAPTOP_SHIM = `<script>(() => {${BASE_SHIM}
  def(navigator, 'maxTouchPoints', 0); def(navigator, 'hardwareConcurrency', 8); def(navigator, 'deviceMemory', 8);
  const mm = window.matchMedia.bind(window);
  window.matchMedia = q => mm(String(q)
    .replace(/\\(\\s*(any-)?pointer\\s*:\\s*coarse\\s*\\)/g, '(max-width: 0px)').replace(/\\(\\s*(any-)?pointer\\s*:\\s*fine\\s*\\)/g, '(min-width: 0px)')
    .replace(/\\(\\s*(any-)?hover\\s*:\\s*none\\s*\\)/g, '(max-width: 0px)').replace(/\\(\\s*(any-)?hover\\s*:\\s*hover\\s*\\)/g, '(min-width: 0px)'));
})();</script>`;
// iPad: the desktop layout with the phone's own touch and hardware, as an iPad asks for desktop sites; sites
// keep the memory protections they give touch devices. Where a laptop view crashed the tab, it comes next.
const TABLET_SHIM = `<script>(() => {${BASE_SHIM}
})();</script>`;
// After an iPad view crashed too: the site is told the device is short on memory, so it serves its fallbacks.
const LITE_SHIM = `<script>(() => {
  const def = (o, k, v) => { try { Object.defineProperty(o, k, { get: () => v, configurable: true }); } catch {} };
  def(navigator, 'deviceMemory', 2); def(navigator, 'hardwareConcurrency', 2);
})();</script>`;

// The switch to desktop view: one small eye in the corner, in its own shadow root so the project's CSS
// cannot touch it (and it cannot touch the project's).
const VIEW_BUTTON = `<div id="seer-view-switch"></div><script>(() => {
  const host = document.getElementById('seer-view-switch'), root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<style>a{position:fixed;left:calc(10px + env(safe-area-inset-left));bottom:calc(10px + env(safe-area-inset-bottom));z-index:2147483647;width:36px;height:36px;border-radius:18px;background:rgba(10,10,10,.8);border:1px solid #262626;display:flex;align-items:center;justify-content:center;opacity:.75}</style>'
    + '<a aria-label="Desktop view"><svg width="20" height="13" viewBox="0 0 22 14"><path d="M1 7C4 2 7.5 1 11 1s7 1 10 6c-3 5-6.5 6-10 6S4 12 1 7Z" fill="none" stroke="#ededed" stroke-width="1.4"/><circle cx="11" cy="7" r="2.6" fill="#00e676"/></svg></a>';
  root.querySelector('a').onclick = () => { location.href = '/__seer/desktop?path=' + encodeURIComponent(location.pathname + location.search + location.hash); };
})();</script>`;
