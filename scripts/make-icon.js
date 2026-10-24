'use strict';

/** 生成应用图标（无第三方依赖，手写 PNG 编码） */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const buf = Buffer.alloc(SIZE * SIZE * 4);

function px(x, y, r, g, b, a) {
  const i = (y * SIZE + x) * 4;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
  buf[i + 3] = a;
}

const RAD = 52;
function inRoundRect(x, y) {
  const m = 8;
  const x0 = m;
  const y0 = m;
  const x1 = SIZE - m;
  const y1 = SIZE - m;
  if (x < x0 + RAD && y < y0 + RAD) return (x - (x0 + RAD)) ** 2 + (y - (y0 + RAD)) ** 2 <= RAD ** 2;
  if (x > x1 - RAD && y < y0 + RAD) return (x - (x1 - RAD)) ** 2 + (y - (y0 + RAD)) ** 2 <= RAD ** 2;
  if (x < x0 + RAD && y > y1 - RAD) return (x - (x0 + RAD)) ** 2 + (y - (y1 - RAD)) ** 2 <= RAD ** 2;
  if (x > x1 - RAD && y > y1 - RAD) return (x - (x1 - RAD)) ** 2 + (y - (y1 - RAD)) ** 2 <= RAD ** 2;
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    if (!inRoundRect(x, y)) {
      px(x, y, 0, 0, 0, 0);
      continue;
    }
    // 背景渐变
    const t = (x + y) / (SIZE * 2);
    const r = Math.round(16 + t * 10);
    const g = Math.round(24 + t * 14);
    const b = Math.round(34 + t * 18);
    px(x, y, r, g, b, 255);
  }
}

// 金色菱形
const cx = 128;
const cy = 124;
const R = 74;
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    if (d < R) {
      const edge = Math.min(1, (R - d) / 10);
      const shade = 0.65 + 0.35 * Math.min(1, d / R);
      const gold = [
        Math.round(224 * shade + 20 * edge),
        Math.round(179 * shade + 16 * edge),
        Math.round(84 * shade + 8 * edge),
      ];
      const a = Math.round(255 * edge);
      const i = (y * SIZE + x) * 4;
      const oldA = buf[i + 3] / 255;
      const newA = a / 255 + oldA * (1 - a / 255);
      buf[i] = Math.round((gold[0] * (a / 255) + buf[i] * oldA * (1 - a / 255)) / (newA || 1));
      buf[i + 1] = Math.round((gold[1] * (a / 255) + buf[i + 1] * oldA * (1 - a / 255)) / (newA || 1));
      buf[i + 2] = Math.round((gold[2] * (a / 255) + buf[i + 2] * oldA * (1 - a / 255)) / (newA || 1));
      buf[i + 3] = Math.round(newA * 255);
    }
  }
}

// 中央镂空小菱形（形成环形感）
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    if (d < R - 30) {
      const t = (x + y) / (SIZE * 2);
      const edge = Math.min(1, (R - 30 - d) / 8);
      const i = (y * SIZE + x) * 4;
      const r = 16 + t * 10;
      const g = 24 + t * 14;
      const b = 34 + t * 18;
      buf[i] = Math.round(r * edge + buf[i] * (1 - edge));
      buf[i + 1] = Math.round(g * edge + buf[i + 1] * (1 - edge));
      buf[i + 2] = Math.round(b * edge + buf[i + 2] * (1 - edge));
    }
  }
}

// ---- PNG 编码 ----
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcBuf) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}

let table = null;
function crc32(b) {
  if (!table) {
    table = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < b.length; i += 1) crc = table[(crc ^ b[i]) & 0xff] ^ (crc >>> 8);
  return crc ^ 0xffffffff;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
// eslint-disable-next-line no-console
console.log(`icon written: ${out} (${png.length} bytes)`);
