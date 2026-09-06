#!/usr/bin/env node
// Generates packages/web/webapp/public/badge-96.png, the Android notification badge.
//
// Android renders a notification's `badge` by discarding color and keeping only the
// alpha channel, so the badge MUST be a transparent-background silhouette. Reusing the
// opaque square icon-192.png produces a solid filled rectangle in the status bar.
//
// The glyph is the sparkle from icon.svg. That path's cubic segments trace an astroid
// with points on the axes at radius 72; fitting the t=0.5 midpoint (-25.5, -24) gives
// |x/R|^p + |y/R|^p = 1 with p = 0.65 to within 0.1%.
//
// Run: node scripts/generate-web-notification-badge.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 96;
const RADIUS = 45;
const EXPONENT = 0.65;
const SAMPLES = 4;

function coverage(px, py) {
  let hits = 0;
  for (let sy = 0; sy < SAMPLES; sy += 1) {
    for (let sx = 0; sx < SAMPLES; sx += 1) {
      const x = px + (sx + 0.5) / SAMPLES - SIZE / 2;
      const y = py + (sy + 0.5) / SAMPLES - SIZE / 2;
      const u = Math.abs(x) / RADIUS;
      const v = Math.abs(y) / RADIUS;
      if (u ** EXPONENT + v ** EXPONENT <= 1) hits += 1;
    }
  }
  return hits / (SAMPLES * SAMPLES);
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let offset = 0;
for (let y = 0; y < SIZE; y += 1) {
  raw[offset] = 0; // filter type: none
  offset += 1;
  for (let x = 0; x < SIZE; x += 1) {
    const alpha = Math.round(coverage(x, y) * 255);
    raw[offset] = 255;
    raw[offset + 1] = 255;
    raw[offset + 2] = 255;
    raw[offset + 3] = alpha;
    offset += 4;
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let c = index;
  for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xff_ff_ff_ff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xff_ff_ff_ff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const target = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/web/webapp/public/badge-96.png",
);
writeFileSync(target, png);
process.stdout.write(`Wrote ${target} (${String(png.length)} bytes)\n`);
