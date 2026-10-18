// Seer's icons, stamped with a fingerprint of the files: any new icon gets new URLs, so browsers, iOS and
// Cloudflare's cache fetch it fresh instead of keeping the old one for a day. Unstamped requests (a browser asking
// for /favicon.ico on its own) are cached for 5 minutes only.
import fs from 'node:fs';
import crypto from 'node:crypto';

const FILES = ['logo/seer-favicon.svg', 'icon-32.png', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
const read = f => fs.readFileSync(new URL(`../assets/${f}`, import.meta.url));
export const ICON_V = crypto.createHash('sha256').update(Buffer.concat(FILES.map(read))).digest('hex').slice(0, 10);
export const ICON_HEAD = `<link rel="manifest" href="/manifest.webmanifest?v=${ICON_V}"><link rel="apple-touch-icon" href="/icon-180.png?v=${ICON_V}"><link rel="icon" href="/favicon.svg?v=${ICON_V}" type="image/svg+xml"><link rel="icon" href="/icon-32.png?v=${ICON_V}" sizes="32x32" type="image/png">`;
// The typeface: Plus Jakarta Sans (SIL OFL, assets/fonts/OFL.txt), a geometric sans with its own quirks.
export const FONT_V = crypto.createHash('sha256').update(read('fonts/jakarta.woff2')).digest('hex').slice(0, 10);
export const FONT_URL = `/font/jakarta.woff2?v=${FONT_V}`;
export const iconCache = url => (url.searchParams.get('v') === ICON_V ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
