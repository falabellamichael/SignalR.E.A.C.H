// Generates tray-icon.png (32x32 bold gold "R" mark on transparent) with pure
// Node zlib — no image deps. Run once: node gen-icon.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const S = 32;
const px = Buffer.alloc(S * S * 4); // RGBA

function set(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    const na = a / 255, oa = px[i + 3] / 255;
    const outA = na + oa * (1 - na);
    if (outA === 0) return;
    px[i]     = Math.round((r * na + px[i]     * oa * (1 - na)) / outA);
    px[i + 1] = Math.round((g * na + px[i + 1] * oa * (1 - na)) / outA);
    px[i + 2] = Math.round((b * na + px[i + 2] * oa * (1 - na)) / outA);
    px[i + 3] = Math.round(outA * 255);
}

// dark rounded-square backdrop (fills most of the tile so it reads in the tray)
const R = 7; // corner radius
for (let y = 1; y < S - 1; y++) for (let x = 1; x < S - 1; x++) {
    const dx = Math.max((R + 1) - x, x - (S - 2 - R), 0);
    const dy = Math.max((R + 1) - y, y - (S - 2 - R), 0);
    if (dx * dx + dy * dy > R * R) continue;
    set(x, y, 24, 24, 28, 255);
}

// gold letter "R" (bold, centered) — REACH
const G = [214, 182, 62];   // warm gold
const GG = [240, 210, 98];  // highlight
// stem
for (let y = 7; y <= 25; y++) for (let x = 9; x <= 12; x++) set(x, y, G[0], G[1], G[2], 255);
// top bar of the bowl
for (let y = 7; y <= 10; y++) for (let x = 9; x <= 20; x++) set(x, y, G[0], G[1], G[2], 255);
// right side of the bowl
for (let y = 8; y <= 16; y++) for (let x = 18; x <= 21; x++) set(x, y, G[0], G[1], G[2], 255);
// middle bar
for (let y = 14; y <= 17; y++) for (let x = 9; x <= 20; x++) set(x, y, G[0], G[1], G[2], 255);
// diagonal leg
for (let k = 0; k <= 8; k++) {
    const x = 15 + k, y = 17 + k;
    for (let oy = 0; oy < 4; oy++) for (let ox = 0; ox < 2; ox++) set(x + ox, y + oy, G[0], G[1], G[2], 255);
}
// highlight on the stem top
for (let y = 7; y <= 10; y++) for (let x = 9; x <= 10; x++) set(x, y, GG[0], GG[1], GG[2], 255);

// --- PNG encode ---
function crc32(buf) {
    let c, table = crc32.t || (crc32.t = (() => {
        const t = new Int32Array(256);
        for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
        return t;
    })());
    c = -1;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0; // filter none
    px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
]);
const out = join(dirname(fileURLToPath(import.meta.url)), 'tray-icon.png');
writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
