// When the Mac cannot be reached (asleep, off, or off the network), Cloudflare answers for it with an error page.
// A small service worker on Seer's own site catches that for page loads and shows the asleep page instead: the eye
// shut, what to do, and a retry that reloads once the Mac answers again. The page is kept in the phone's cache
// when the worker installs, since the Mac cannot serve it while it sleeps. Nothing else is intercepted.
import crypto from 'node:crypto';
import { GLASS_CSS, MARK, BACKDROP } from './glass.js';
import { FONT_URL } from './icons.js';

export function asleepPage(head, model = 'Mac') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#020403"><title>Seer</title>
${head}
<style>${GLASS_CSS}
main{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:14px;padding-bottom:calc(60px + env(safe-area-inset-bottom))}
.eye{width:132px;height:97px;margin-bottom:10px}
h1{margin:0;font:750 30px/1.1 var(--round);letter-spacing:-.03em}
p{margin:0 0 10px;max-width:290px;color:var(--ink2);font-size:15.5px}
</style></head><body>
${BACKDROP}
<main>
  ${MARK.replace('class="eye"', 'class="eye asleep"').replace('id="pupil"', '')}
  <h1 id="t">Your ${model} is asleep</h1>
  <p id="s"></p>
  <button class="btn tint" id="again">Try again</button>
</main>
<script>
const offline = () => navigator.onLine === false;
function say() {
  document.getElementById('t').textContent = offline() ? "You're offline" : ${JSON.stringify(`Your ${model} is asleep`)};
  document.getElementById('s').textContent = offline() ? 'Seer reconnects once you are.' : ${JSON.stringify(/MacBook/.test(model) ? 'Open the lid to wake it.' : 'Press a key to wake it.')};
}
say(); addEventListener('online', say); addEventListener('offline', say);
// Back on its own: look every 20 s while the page is on screen, and reload once the Mac answers.
async function look() {
  try { const r = await fetch('/ping', { cache: 'no-store' }); if (r.status === 204) { location.reload(); return true; } } catch {}
  return false;
}
document.getElementById('again').onclick = async e => { e.currentTarget.disabled = true; if (!(await look())) e.currentTarget.disabled = false; };
setInterval(() => { if (!document.hidden) look(); }, 20000);
</script></body></html>`;
}

// The worker. Versioned by the page's text, so a new page replaces the cached one.
export function serviceWorker(page) {
  const v = crypto.createHash('sha256').update(page).digest('hex').slice(0, 10);
  return `// Seer: show the asleep page when the Mac cannot be reached (see src/asleep.js).
const CACHE = 'seer-${v}', PAGE = '/asleep?v=${v}', FONT = ${JSON.stringify(FONT_URL)};
const DOWN = [502, 503, 504, 521, 522, 523, 524, 530];   // Cloudflare's answers for an origin it cannot reach
self.addEventListener('install', e => e.waitUntil((async () => {
  const c = await caches.open(CACHE);
  await c.add(new Request(PAGE, { credentials: 'include' }));
  try { await c.add(new Request(FONT, { credentials: 'include' })); } catch {}
  await self.skipWaiting();
})()));
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname + url.search === FONT) { e.respondWith(caches.match(FONT).then(r => r || fetch(e.request))); return; }
  if (e.request.mode !== 'navigate') return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      return DOWN.includes(res.status) ? (await caches.match(PAGE)) || res : res;
    } catch (err) {
      const page = await caches.match(PAGE);
      if (page) return page;
      throw err;
    }
  })());
});
`;
}
