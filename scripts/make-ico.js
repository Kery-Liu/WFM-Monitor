'use strict';

/**
 * 把 assets/icon.png（256x256）封装成单尺寸 ICO，供 rcedit 写入 exe 资源。
 * 说明：256x256 用 PNG 压缩存储是 Windows Vista+ 支持的合法 ICO 形式，无需额外图形库。
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const png = fs.readFileSync(path.join(root, 'assets', 'icon.png'));
const outDir = path.join(root, 'build');
fs.mkdirSync(outDir, { recursive: true });

const header = Buffer.alloc(6 + 16);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(1, 4); // count

const entry = 6;
header.writeUInt8(0, entry); // width 256 -> 0
header.writeUInt8(0, entry + 1); // height 256 -> 0
header.writeUInt8(0, entry + 2); // palette
header.writeUInt8(0, entry + 3); // reserved
header.writeUInt16LE(1, entry + 4); // planes
header.writeUInt16LE(32, entry + 6); // bpp
header.writeUInt32LE(png.length, entry + 8); // bytes
header.writeUInt32LE(22, entry + 12); // offset

const out = path.join(outDir, 'icon.ico');
fs.writeFileSync(out, Buffer.concat([header, png]));
console.log(`ICO 已生成：${path.relative(root, out)}（${((6 + 16 + png.length) / 1024).toFixed(1)} KB）`);
