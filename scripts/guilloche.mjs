// Generates the brand's guilloché artwork (security-printing rosettes, border bands, safety paper).
// Run: node scripts/guilloche.mjs   → writes site/art/*.svg and src/art/*.svg
// Each rosette is ONE wavy circle r(θ) = R + A·sin(kθ), reused at small rotations: the overlap
// produces the moiré of real banknote engraving while keeping files a few KB.
import { mkdirSync, writeFileSync } from 'node:fs';

const INK = '#16120f';
const RED = '#b5121b';
const f = (n) => Number(n.toFixed(2));

function wavyCircle(R, A, k, steps = 360) {
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const r = R + A * Math.sin(k * t);
    d += `${i ? 'L' : 'M'}${f(r * Math.cos(t))} ${f(r * Math.sin(t))}`;
  }
  return `${d}Z`;
}

/** Layers: [R, A, k, copies, strokeWidth]. Copies are spread across one lobe so the pattern interlocks. */
function rosette(id, layers, color, { center = true } = {}) {
  const defs = layers.map(([R, A, k], i) => `<path id="${id}${i}" d="${wavyCircle(R, A, k)}"/>`).join('');
  const uses = layers.map(([, , k, copies, sw], i) => {
    const step = 360 / k / copies;
    return `<g stroke-width="${sw}">${Array.from({ length: copies }, (_, c) => `<use href="#${id}${i}" transform="rotate(${f(c * step)})"/>`).join('')}</g>`;
  }).join('');
  const dot = center ? `<circle r="4.5" fill="${RED}" stroke="none"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-100 -100 200 200"><defs>${defs}</defs><g fill="none" stroke="${color}">${uses}</g>${dot}</svg>`;
}

/** Horizontal border band that tiles seamlessly (period = tile width). */
function band(color, { w = 64, h = 20, waves = 9 } = {}) {
  let paths = '';
  for (let i = 0; i < waves; i++) {
    const phase = (i / waves) * Math.PI * 2;
    for (const [amp, sw] of [[h * 0.38, 0.45], [h * 0.18, 0.3]]) {
      let d = '';
      for (let x = 0; x <= w; x += 1) d += `${x ? 'L' : 'M'}${x} ${f(h / 2 + amp * Math.sin((x / w) * Math.PI * 2 + phase))}`;
      paths += `<path d="${d}" stroke-width="${sw}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><g fill="none" stroke="${color}">${paths}</g></svg>`;
}

/** Safety-paper tile: fine wavy lines whose phase cycles every tile, so it repeats in both directions. */
function paper(color, opacity) {
  const W = 48, H = 48, gap = 6, n = H / gap;
  let paths = '';
  for (let k = 0; k < n; k++) {
    let d = '';
    for (let x = 0; x <= W; x += 1.5) d += `${x ? 'L' : 'M'}${f(x)} ${f(k * gap + 1.6 * Math.sin((x / W) * Math.PI * 2 + (k / n) * Math.PI * 2))}`;
    paths += `<path d="${d}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><g fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width=".5">${paths}</g></svg>`;
}

const ROSETTE = [[89, 9, 24, 12, 0.3], [66, 15, 14, 12, 0.3], [52, 34, 6, 18, 0.26], [38, 11, 10, 10, 0.3], [20, 6, 8, 8, 0.3]];
const files = {
  'rosette-red.svg': rosette('r', ROSETTE, RED),
  'rosette-ink.svg': rosette('r', ROSETTE, INK),
  'rosette-faint.svg': rosette('r', [[92, 7, 28, 9, 0.25], [70, 12, 16, 9, 0.25], [50, 30, 7, 12, 0.22], [34, 9, 11, 8, 0.25]], INK, { center: false }),
  'rosette-faint-red.svg': rosette('r', [[92, 7, 28, 9, 0.25], [70, 12, 16, 9, 0.25], [50, 30, 7, 12, 0.22], [34, 9, 11, 8, 0.25]], RED, { center: false }),
  'band-red.svg': band(RED),
  'band-ink.svg': band(INK),
  'paper.svg': paper(INK, 0.05),
};
for (const dir of ['site/art', 'src/art']) {
  mkdirSync(dir, { recursive: true });
  for (const [name, svg] of Object.entries(files)) writeFileSync(`${dir}/${name}`, svg);
}
console.log(Object.entries(files).map(([n, s]) => `${n} ${(s.length / 1024).toFixed(1)} KB`).join('\n'));
