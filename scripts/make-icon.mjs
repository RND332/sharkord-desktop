/**
 * Generates build/icon.png (1024x1024 RGBA) with no image dependencies:
 * dark rounded square, a screen, and a waveform that stands for the audio being captured.
 * Run with `node scripts/make-icon.mjs`.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const SIZE = 1024;
const pixels = new Uint8Array(SIZE * SIZE * 4);

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** Signed distance to a rounded rectangle centred at (cx, cy). */
const roundedRect = (x, y, cx, cy, halfW, halfH, radius) => {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
};

/** Shortest distance from a point to a polyline. */
const distanceToPath = (x, y, points) => {
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy || 1;
    const t = clamp01(((x - x1) * dx + (y - y1) * dy) / lengthSq);
    best = Math.min(best, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)));
  }
  return best;
};

const wave = [];
const waveY = SIZE * 0.44;
const waveAmplitude = SIZE * 0.075;
for (let i = 0; i <= 120; i += 1) {
  const t = i / 120;
  wave.push([SIZE * 0.26 + t * SIZE * 0.48, waveY + Math.sin(t * Math.PI * 4) * waveAmplitude * (1 - 0.25 * t)]);
}

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const px = x + 0.5;
    const py = y + 0.5;
    const offset = (y * SIZE + x) * 4;

    const background = roundedRect(px, py, SIZE / 2, SIZE / 2, SIZE * 0.46, SIZE * 0.46, SIZE * 0.22);
    const backgroundAlpha = clamp01(0.5 - background);
    if (backgroundAlpha <= 0) continue;

    const shade = py / SIZE;
    let r = Math.round(17 + 26 * shade);
    let g = Math.round(24 + 34 * shade);
    let b = Math.round(39 + 50 * shade);

    const screen = roundedRect(px, py, SIZE / 2, SIZE * 0.43, SIZE * 0.33, SIZE * 0.21, SIZE * 0.05);
    const screenAlpha = clamp01(0.5 - screen);
    if (screenAlpha > 0) {
      const inner = Math.round(226 + 12 * (1 - shade));
      r = Math.round(r * (1 - screenAlpha) + inner * screenAlpha);
      g = Math.round(g * (1 - screenAlpha) + (inner + 6) * screenAlpha);
      b = Math.round(b * (1 - screenAlpha) + (inner + 12) * screenAlpha);
    }

    const stroke = clamp01(0.5 - (distanceToPath(px, py, wave) - SIZE * 0.022));
    if (stroke > 0 && screenAlpha > 0) {
      r = Math.round(r * (1 - stroke) + 14 * stroke);
      g = Math.round(g * (1 - stroke) + 165 * stroke);
      b = Math.round(b * (1 - stroke) + 233 * stroke);
    }

    const stand = roundedRect(px, py, SIZE / 2, SIZE * 0.71, SIZE * 0.16, SIZE * 0.035, SIZE * 0.03);
    const standAlpha = clamp01(0.5 - stand);
    if (standAlpha > 0) {
      r = Math.round(r * (1 - standAlpha) + 148 * standAlpha);
      g = Math.round(g * (1 - standAlpha) + 163 * standAlpha);
      b = Math.round(b * (1 - standAlpha) + 184 * standAlpha);
    }

    const neck = roundedRect(px, py, SIZE / 2, SIZE * 0.655, SIZE * 0.05, SIZE * 0.03, SIZE * 0.01);
    const neckAlpha = clamp01(0.5 - neck);
    if (neckAlpha > 0) {
      r = Math.round(r * (1 - neckAlpha) + 148 * neckAlpha);
      g = Math.round(g * (1 - neckAlpha) + 163 * neckAlpha);
      b = Math.round(b * (1 - neckAlpha) + 184 * neckAlpha);
    }

    pixels[offset] = r;
    pixels[offset + 1] = g;
    pixels[offset + 2] = b;
    pixels[offset + 3] = Math.round(255 * backgroundAlpha);
  }
}

const crcTable = Array.from({ length: 256 }, (_unused, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const payload = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(pixels.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

mkdirSync('build', { recursive: true });
writeFileSync('build/icon.png', png);
console.log('build/icon.png', png.length, 'bytes');
