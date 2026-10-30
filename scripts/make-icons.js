'use strict';
// Draws the app and tray icons into build/ (no image tools needed): node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'build');

// ---- PNG encoder ----------------------------------------------------------------
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- Tiny rasterizer: rounded rectangles in a 0..1 coordinate space, supersampled ----
function inRoundRect(x, y, r) {
  const cx = Math.min(Math.max(x, r.x0 + r.r), r.x1 - r.r);
  const cy = Math.min(Math.max(y, r.y0 + r.r), r.y1 - r.r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r.r * r.r && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

function render(size, shapes, ss = 4) {
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          // composite shapes back to front over transparent
          let cr = 0, cg = 0, cb = 0, ca = 0;
          for (const s of shapes) {
            if (!inRoundRect(x, y, s)) continue;
            const [sr, sg, sb] = typeof s.color === 'function' ? s.color(x, y) : s.color;
            const sa = s.alpha == null ? 1 : s.alpha;
            if (s.erase) {
              ca *= 1 - sa;
              continue;
            }
            const na = sa + ca * (1 - sa);
            cr = (sr * sa + cr * ca * (1 - sa)) / (na || 1);
            cg = (sg * sa + cg * ca * (1 - sa)) / (na || 1);
            cb = (sb * sa + cb * ca * (1 - sa)) / (na || 1);
            ca = na;
          }
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      out[i + 3] = Math.round((a / n) * 255);
      out[i] = a ? Math.round(r / a) : 0;
      out[i + 1] = a ? Math.round(g / a) : 0;
      out[i + 2] = a ? Math.round(b / a) : 0;
    }
  }
  return out;
}

const rr = (x0, y0, x1, y1, r, color, alpha, extra) => ({ x0, y0, x1, y1, r, color, alpha, ...extra });
const mix = (c1, c2, t) => c1.map((v, i) => v + (c2[i] - v) * t);
const TEAL_TOP = [20, 184, 166];
const TEAL_BOTTOM = [15, 118, 110];
const WHITE = [255, 255, 255];
const INK = [15, 94, 88];

// Three stacked cards (memories), the front one with text lines.
function glyph(color, lineColor, scale = 1, dx = 0, dy = 0) {
  const t = (v) => 0.5 + (v - 0.5) * scale;
  const tx = (v) => t(v) + dx;
  const ty = (v) => t(v) + dy;
  return [
    rr(tx(0.30), ty(0.22), tx(0.78), ty(0.62), 0.05 * scale, color, 0.38),
    rr(tx(0.26), ty(0.30), tx(0.74), ty(0.70), 0.05 * scale, color, 0.62),
    rr(tx(0.22), ty(0.38), tx(0.70), ty(0.80), 0.055 * scale, color, 1),
    rr(tx(0.30), ty(0.49), tx(0.62), ty(0.545), 0.022 * scale, lineColor, 1),
    rr(tx(0.30), ty(0.60), tx(0.55), ty(0.645), 0.022 * scale, lineColor, 1),
    rr(tx(0.30), ty(0.70), tx(0.48), ty(0.745), 0.022 * scale, lineColor, 1),
  ];
}

function appIcon(size) {
  // macOS-style rounded square with a little margin, teal gradient.
  const bg = rr(0.08, 0.08, 0.92, 0.92, 0.19, (x, y) => mix(TEAL_TOP, TEAL_BOTTOM, (y - 0.08) / 0.84));
  return render(size, [bg, ...glyph(WHITE, INK, 0.92, 0.02, 0)]);
}

// Menu bar (macOS template: black + alpha) and tray (Windows: teal tile) icons.
function trayTemplate(size) {
  const shapes = [
    rr(0.34, 0.08, 0.94, 0.62, 0.09, [0, 0, 0], 0.45),
    rr(0.20, 0.22, 0.80, 0.78, 0.09, [0, 0, 0], 0.7),
    rr(0.06, 0.36, 0.66, 0.94, 0.1, [0, 0, 0], 1),
    rr(0.16, 0.54, 0.54, 0.62, 0.04, [0, 0, 0], 1, { erase: true }),
    rr(0.16, 0.72, 0.44, 0.80, 0.04, [0, 0, 0], 1, { erase: true }),
  ];
  return render(size, shapes, 6);
}
function trayColor(size) {
  const bg = rr(0.02, 0.02, 0.98, 0.98, 0.22, (x, y) => mix(TEAL_TOP, TEAL_BOTTOM, y));
  return render(size, [bg, ...glyph(WHITE, INK, 1.1, 0.03, -0.02)], 6);
}

fs.mkdirSync(OUT, { recursive: true });
const write = (name, size, rgba) => {
  fs.writeFileSync(path.join(OUT, name), png(size, rgba));
  console.log(`build/${name}  ${size}x${size}`);
};
write('icon.png', 1024, appIcon(1024));
write('trayTemplate.png', 16, trayTemplate(16));
write('trayTemplate@2x.png', 32, trayTemplate(32));
write('tray.png', 16, trayColor(16));
write('tray@2x.png', 32, trayColor(32));
