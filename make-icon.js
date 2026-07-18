// Dependency-free 1024x1024 app-icon generator matching the Resonance favicon:
// concentric rings (gold / violet / teal / faint gold) + centre dot on dark.
// Writes assets/icon.png.  Run:  node make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;
const cx = SIZE / 2, cy = SIZE / 2;

// palette (r,g,b)
const BG   = [11, 15, 26];    // #0b0f1a
const GOLD = [231, 201, 134]; // #e7c986
const VIO  = [155, 140, 255]; // #9b8cff
const TEAL = [111, 227, 208]; // #6fe3d0

// rings: [radius, thickness, color, alpha]
const rings = [
  [430, 22, GOLD, 0.45],
  [330, 30, TEAL, 0.80],
  [215, 40, VIO,  1.0],
  [95,   0, GOLD, 1.0], // filled centre dot (thickness 0 => solid disc)
];

function blend(base, col, a) {
  return [
    Math.round(base[0] * (1 - a) + col[0] * a),
    Math.round(base[1] * (1 - a) + col[1] * a),
    Math.round(base[2] * (1 - a) + col[2] * a),
  ];
}

// build raw RGBA
const raw = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let px = BG.slice();
    const d = Math.hypot(x - cx, y - cy);
    for (const [r, th, col, alpha] of rings) {
      let cov = 0;
      if (th === 0) {
        // solid disc with 1.5px antialias edge
        cov = Math.max(0, Math.min(1, (r - d) / 1.5 + 0.5));
      } else {
        // ring: distance from the ring's centre-line within half-thickness
        const edge = Math.abs(d - r);
        cov = Math.max(0, Math.min(1, (th / 2 - edge) / 1.5 + 0.5));
      }
      if (cov > 0) px = blend(px, col, cov * alpha);
    }
    // round the outer corners slightly (icon safe-zone friendly): keep square, launcher masks it
    const i = (y * SIZE + x) * 4;
    raw[i] = px[0]; raw[i + 1] = px[1]; raw[i + 2] = px[2]; raw[i + 3] = 255;
  }
}

// ---- minimal PNG encoder ----
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
// add filter byte (0) per scanline
const stride = SIZE * 4;
const filtered = Buffer.alloc((stride + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  filtered[y * (stride + 1)] = 0;
  raw.copy(filtered, y * (stride + 1) + 1, y * stride, y * stride + stride);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(filtered, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, 'assets', 'icon.png');
fs.writeFileSync(out, png);
console.log('icon.png written:', (png.length / 1024).toFixed(1), 'KB,', SIZE + 'x' + SIZE);
