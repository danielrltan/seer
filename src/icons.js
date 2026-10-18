// Seer's icons, stamped with a fingerprint of the files: any new icon gets new URLs, so browsers, iOS and
// Cloudflare's cache fetch it fresh instead of keeping the old one for a day. Unstamped requests (a browser asking
// for /favicon.ico on its own) are cached for 5 minutes only.
import fs from 'node:fs';
import crypto from 'node:crypto';

const FILES = ['logo/seer-favicon.svg', 'icon-32.png', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
const read = f => fs.readFileSync(new URL(`../assets/${f}`, import.meta.url));
export const ICON_V = crypto.createHash('sha256').update(Buffer.concat(FILES.map(read))).digest('hex').slice(0, 10);
// The home-screen app: opened from its icon, iOS shows Seer with no browser bars (a page cannot hide them itself).
// It opens on Seer home, whichever page it was added from. Its link is stamped with a fingerprint of its text too,
// so a change reaches phones that kept the old one.
export const MANIFEST = JSON.stringify({
  name: 'Seer', short_name: 'Seer', start_url: '/', scope: '/', display: 'standalone', orientation: 'any',
  background_color: '#000000', theme_color: '#000000',
  icons: [{ src: `/icon-192.png?v=${ICON_V}`, sizes: '192x192', type: 'image/png' }, { src: `/icon-512.png?v=${ICON_V}`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' }],
});
const MANIFEST_V = crypto.createHash('sha256').update(MANIFEST).digest('hex').slice(0, 10);
// Every page also installs Seer's service worker (src/asleep.js): the asleep page when the Mac cannot be reached.
export const ICON_HEAD = `<script>navigator.serviceWorker && navigator.serviceWorker.register('/sw.js').catch(() => {});
// Pressed: what is under a finger gets .pressed (at least 120 ms, so a quick tap shows), caught before any handler
// can cancel the press; iOS shows :active unreliably, and not at all where a page prevents the pointerdown.
document.addEventListener('pointerdown', e => {
  const b = e.target.closest && e.target.closest('button,a.btn,.mon,.proj,.key'); if (!b) return;
  const t = Date.now(); b.classList.add('pressed');
  const up = () => { setTimeout(() => b.classList.remove('pressed'), Math.max(0, 120 - (Date.now() - t))); removeEventListener('pointerup', up, true); removeEventListener('pointercancel', up, true); };
  addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true);
}, true);</script><link rel="manifest" href="/manifest.webmanifest?v=${MANIFEST_V}"><link rel="apple-touch-icon" href="/icon-180.png?v=${ICON_V}"><link rel="icon" href="/favicon.svg?v=${ICON_V}" type="image/svg+xml"><link rel="icon" href="/icon-32.png?v=${ICON_V}" sizes="32x32" type="image/png">`;
// The typeface: Plus Jakarta Sans (SIL OFL, assets/fonts/OFL.txt), a geometric sans with its own quirks.
export const FONT_V = crypto.createHash('sha256').update(read('fonts/jakarta.woff2')).digest('hex').slice(0, 10);
export const FONT_URL = `/font/jakarta.woff2?v=${FONT_V}`;
export const iconCache = url => (url.searchParams.get('v') === ICON_V ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
