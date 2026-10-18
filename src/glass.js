// The look shared by every Seer page: Apple's Liquid Glass, tinted dark. Smoked glass panels (blur and saturate
// what is behind, a bright rim lit from the top left, an inner sheen, a soft deep shadow) float over a tunnel
// receding into the dark and slow green glows that the glass picks up as they drift under it. iPhone Safari
// cannot refract through a backdrop filter, so the glass is built from what it can do. SF Pro for text, SF Pro
// Rounded for big numbers, monospace for small readouts. Dark only.
export const GLASS_CSS = `
:root{
  --bg:#020403;--ink:#fff;--ink2:rgba(255,255,255,.78);--ink3:rgba(255,255,255,.5);--hair:rgba(255,255,255,.09);
  --live:#2bf08a;--glow:rgba(43,240,138,.45);--amber:#ffc44d;--red:#ff5a5f;
  --sans:-apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;
  --round:ui-rounded,'SF Pro Rounded',-apple-system,system-ui,sans-serif;
  --mono:ui-monospace,'SF Mono',Menlo,monospace;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
[hidden]{display:none!important}
html{background:var(--bg);color-scheme:dark}
body{margin:0;min-height:100vh;color:var(--ink);font:15px/1.4 var(--sans);background:transparent;-webkit-font-smoothing:antialiased}
main{position:relative;max-width:520px;margin:0 auto;padding:calc(10px + env(safe-area-inset-top)) 14px calc(40px + env(safe-area-inset-bottom))}
a{color:inherit;text-decoration:none}
small{font-size:.5em;font-weight:600;color:var(--ink3);letter-spacing:0}
.k{font:600 13px var(--sans);color:var(--ink3)}

.glass{position:relative;isolation:isolate;
  background:linear-gradient(160deg,rgba(255,255,255,.10),rgba(255,255,255,.025) 42%,rgba(255,255,255,.045)),rgba(12,16,14,.46);
  -webkit-backdrop-filter:blur(26px) saturate(190%);backdrop-filter:blur(26px) saturate(190%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.16),inset 0 -1px 0 rgba(255,255,255,.04),0 18px 44px rgba(0,0,0,.55),0 2px 6px rgba(0,0,0,.35)}
.glass:before{content:'';position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;z-index:-1;
  background:linear-gradient(140deg,rgba(255,255,255,.55),rgba(255,255,255,.08) 30%,rgba(255,255,255,.02) 62%,rgba(43,240,138,.32));
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude}
.glass:after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:-1;
  background:radial-gradient(120% 60% at 15% -10%,rgba(255,255,255,.13),transparent 55%)}

/* top bar: a floating glass capsule */
.bar{display:flex;align-items:center;gap:10px;height:52px;padding:0 7px 0 16px;border-radius:26px;margin-bottom:14px;position:sticky;top:calc(8px + env(safe-area-inset-top));z-index:5}
.bar .word{font:700 18px var(--round);letter-spacing:-.01em}
.bar .title{font:650 17px var(--sans)}
.bar .clock{margin-left:auto;font:600 14px var(--round);color:var(--ink2);font-variant-numeric:tabular-nums}
.icon-btn{width:38px;height:38px;border-radius:19px;display:grid;place-items:center;color:var(--ink);background:rgba(255,255,255,.07);box-shadow:inset 0 1px 0 rgba(255,255,255,.12);flex:none}
.icon-btn:active{background:rgba(255,255,255,.14)}
.chip{display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 11px;border-radius:13px;background:rgba(255,255,255,.07);font:600 12px var(--sans);color:var(--ink2)}
.pip{width:8px;height:8px;border-radius:50%;flex:none;background:rgba(255,255,255,.25)}
.pip.on{background:var(--live);box-shadow:0 0 10px var(--glow)}.pip.red{background:var(--red);box-shadow:0 0 10px var(--red)}
.pip.amber{background:var(--amber);box-shadow:0 0 10px var(--amber)}
/* a sunken capsule track with a glowing fill */
.track{flex:1;height:10px;border-radius:5px;background:rgba(0,0,0,.38);box-shadow:inset 0 1px 2px rgba(0,0,0,.6),inset 0 -1px 0 rgba(255,255,255,.06);overflow:hidden}
.track i{display:block;height:100%;width:0;border-radius:5px;background:linear-gradient(90deg,#14b863,var(--live));box-shadow:0 0 12px var(--glow);transition:width .4s}
.track i.red{background:var(--red);box-shadow:none}
/* buttons: glass capsules; .tint is the green one */
.btn{position:relative;height:40px;padding:0 18px;border:0;border-radius:20px;color:#fff;font:600 14.5px var(--sans);cursor:pointer;
  background:rgba(255,255,255,.08);box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 6px 16px rgba(0,0,0,.35)}
.btn:active{transform:scale(.97)}
.btn.tint{background:linear-gradient(160deg,rgba(43,240,138,.42),rgba(43,240,138,.16));color:#eafff3;text-shadow:0 0 12px var(--glow);
  box-shadow:inset 0 1px 0 rgba(200,255,225,.4),0 0 0 .5px rgba(43,240,138,.5),0 6px 18px rgba(43,240,138,.18)}
.btn.warn{background:rgba(255,90,95,.16);color:#ffd9da}
.btns{display:flex;gap:8px}
/* slider: a sunken track, a green fill, a round glass knob */
.slider{-webkit-appearance:none;appearance:none;width:100%;height:36px;margin:10px 0 8px;background:transparent;--p:36%}
.slider::-webkit-slider-runnable-track{height:8px;border-radius:4px;box-shadow:inset 0 1px 2px rgba(0,0,0,.6);
  background:linear-gradient(90deg,var(--live) 0 var(--p),rgba(0,0,0,.42) var(--p) 100%)}
.slider::-webkit-slider-thumb{-webkit-appearance:none;width:30px;height:30px;margin-top:-11px;border-radius:50%;
  background:radial-gradient(circle at 35% 30%,#fff,rgba(235,245,240,.88) 45%,rgba(196,212,204,.82));
  box-shadow:0 4px 12px rgba(0,0,0,.5),inset 0 -2px 3px rgba(0,0,0,.18),0 0 0 .5px rgba(255,255,255,.6)}
/* toggle: an iOS switch */
.switch{-webkit-appearance:none;appearance:none;flex:none;position:relative;width:52px;height:32px;margin:0;border-radius:16px;cursor:pointer;
  background:rgba(0,0,0,.42);box-shadow:inset 0 1px 3px rgba(0,0,0,.6),inset 0 0 0 .5px rgba(255,255,255,.1);transition:background .2s}
.switch:checked{background:linear-gradient(160deg,#3cf598,#14b863);box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 0 14px rgba(43,240,138,.35)}
.switch:before{content:'';position:absolute;left:2px;top:2px;width:28px;height:28px;border-radius:50%;transition:transform .22s cubic-bezier(.3,1.4,.5,1);
  background:radial-gradient(circle at 35% 30%,#fff,#e8f0ec 60%,#cfdad5);box-shadow:0 3px 8px rgba(0,0,0,.4)}
.switch:checked:before{transform:translateX(20px)}
.switch:disabled{opacity:.4}

/* the eye; its spinner pupil turns while an agent works */
#pupil{transform-box:view-box;transform-origin:512px 512px}
#pupil.spin{animation:spin 1s steps(8) infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* backdrop: the tunnel, and slow glows for the glass to pick up */
.backdrop{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none}
.backdrop svg{position:absolute;inset:0;width:100%;height:100%}
.backdrop line,.backdrop rect{vector-effect:non-scaling-stroke}
.backdrop .tun{position:absolute;inset:0;-webkit-mask:radial-gradient(closest-side at 50% 46%,transparent 0,#000 80%);mask:radial-gradient(closest-side at 50% 46%,transparent 0,#000 80%)}
.backdrop .fly{position:absolute;inset:0;transform-origin:50% 46%;animation:fly 9s linear infinite;will-change:transform}
@keyframes fly{to{transform:scale(1.4286)}}
.orb{position:absolute;border-radius:50%;filter:blur(48px);will-change:transform}
.orb.a{width:70vw;height:70vw;left:-22vw;top:6vh;opacity:.5;background:radial-gradient(circle,#12c672,transparent 68%);animation:drift-a 22s ease-in-out infinite alternate}
.orb.b{width:78vw;height:78vw;right:-30vw;top:44vh;opacity:.45;background:radial-gradient(circle,#0c8f86,transparent 68%);animation:drift-b 27s ease-in-out infinite alternate}
.orb.c{width:50vw;height:50vw;left:22vw;top:78vh;opacity:.3;background:radial-gradient(circle,#2bf08a,transparent 68%);animation:drift-a 31s ease-in-out infinite alternate-reverse}
@keyframes drift-a{to{transform:translate(18vw,-10vh) scale(1.15)}}
@keyframes drift-b{to{transform:translate(-20vw,12vh) scale(.9)}}
.backdrop:after{content:'';position:absolute;inset:0;background:radial-gradient(130% 90% at 50% 46%,transparent 40%,rgba(0,0,0,.6) 100%)}
@media (prefers-reduced-motion: reduce){.backdrop .fly,.orb,#pupil.spin{animation:none}}
`;

// The eye with a spinner for a pupil (eight spokes, fading behind the lead one).
export const MARK = (() => {
  const spokes = Array.from({ length: 8 }, (_, i) => {
    const a = -Math.PI / 2 + i * Math.PI / 4, op = i === 0 ? 1 : 0.14 + 0.86 * (i / 8);
    const p = r => [512 + r * Math.cos(a), 512 + r * Math.sin(a)].map(Math.round);
    const [x1, y1] = p(49), [x2, y2] = p(120);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-opacity="${op.toFixed(2)}"/>`;
  }).join('');
  return `<svg width="30" height="22" viewBox="96 208 832 608" aria-hidden="true"><path d="M150 512C260 322 386 262 512 262s252 60 362 250c-110 190-236 250-362 250S260 702 150 512Z" fill="none" stroke="#fff" stroke-width="96" stroke-linejoin="round"/><g id="pupil" stroke="var(--live)" stroke-width="48" stroke-linecap="round">${spokes}</g></svg>`;
})();

// The tunnel (frames shrinking to a vanishing point, drifting forward one ring per loop) and three glows.
export const BACKDROP = (() => {
  const r = 0.7, rects = Array.from({ length: 10 }, (_, k) => {
    const w = 50 * r ** k, h = 54 * r ** k;
    return `<rect x="${(50 - w).toFixed(2)}" y="${(46 - h).toFixed(2)}" width="${(2 * w).toFixed(2)}" height="${(2 * h).toFixed(2)}"/>`;
  }).join('');
  const ends = [[0, 0], [25, 0], [50, 0], [75, 0], [100, 0], [100, 25], [100, 50], [100, 75], [100, 100], [75, 100], [50, 100], [25, 100], [0, 100], [0, 75], [0, 50], [0, 25]];
  const lines = ends.map(([x, y]) => `<line x1="${x}" y1="${y}" x2="50" y2="46"/>`).join('');
  return `<div class="backdrop" aria-hidden="true"><span class="orb a"></span><span class="orb b"></span><span class="orb c"></span>
<div class="tun"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><g fill="none" stroke="#2bf08a" stroke-opacity=".14" stroke-width="1">${lines}</g></svg>
<div class="fly"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><g fill="none" stroke="#2bf08a" stroke-opacity=".22" stroke-width="1">${rects}</g></svg></div></div></div>`;
})();

export const GEAR = `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h9M19 7h1M4 17h1M11 17h9"/><circle cx="16" cy="7" r="2.4"/><circle cx="8" cy="17" r="2.4"/></g></svg>`;
export const BACK = `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
