const zlib = require('zlib');

// ── Minimal PNG encoder (8-bit RGBA) ────────────────────────────────────────

function writeU32be(buf, off, v) {
  buf[off]=(v>>>24)&0xFF; buf[off+1]=(v>>>16)&0xFF; buf[off+2]=(v>>>8)&0xFF; buf[off+3]=v&0xFF;
}
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function makePngChunk(type, data) {
  const tb = Buffer.from(type, 'ascii');
  const lb = Buffer.alloc(4); writeU32be(lb, 0, data.length);
  const ci = Buffer.concat([tb, data]);
  const cb = Buffer.alloc(4); writeU32be(cb, 0, crc32(ci));
  return Buffer.concat([lb, tb, data, cb]);
}
function encodePng(rgba, width, height) {
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  writeU32be(ihdr, 0, width); writeU32be(ihdr, 4, height);
  ihdr[8] = 8; ihdr[9] = 6;
  const scanline = width * 4;
  const raw = Buffer.alloc(height * (1 + scanline));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + scanline)] = 0;
    for (let x = 0; x < scanline; x++) {
      raw[y * (1 + scanline) + 1 + x] = rgba[y * scanline + x];
    }
  }
  return Buffer.concat([
    sig,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', zlib.deflateSync(raw)),
    makePngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ── Drawing primitives ──────────────────────────────────────────────────────

function drawRect(rgba, w, h, x, y, rw, rh, r, g, b, thickness = 3) {
  for (let t = 0; t < thickness; t++) {
    for (let i = x; i < x + rw; i++) {
      for (const row of [y + t, y + rh - 1 - t]) {
        if (row < 0 || row >= h || i < 0 || i >= w) continue;
        const d = (row * w + i) * 4;
        rgba[d] = r; rgba[d+1] = g; rgba[d+2] = b; rgba[d+3] = 255;
      }
    }
    for (let j = y; j < y + rh; j++) {
      for (const col of [x + t, x + rw - 1 - t]) {
        if (j < 0 || j >= h || col < 0 || col >= w) continue;
        const d = (j * w + col) * 4;
        rgba[d] = r; rgba[d+1] = g; rgba[d+2] = b; rgba[d+3] = 255;
      }
    }
  }
}

// 5×7 pixel-art font — used so debug PNGs self-describe without needing any
// font rasterizer. Keys include digits, punctuation, and a handful of letters.
const FONT = {
  '0':['01110','10001','10011','10101','11001','10001','01110'],
  '1':['00100','01100','00100','00100','00100','00100','01110'],
  '2':['01110','10001','00001','00010','00100','01000','11111'],
  '3':['11110','00001','00001','01110','00001','00001','11110'],
  '4':['00010','00110','01010','10010','11111','00010','00010'],
  '5':['11111','10000','11110','00001','00001','10001','01110'],
  '6':['00110','01000','10000','11110','10001','10001','01110'],
  '7':['11111','00001','00010','00100','01000','01000','01000'],
  '8':['01110','10001','10001','01110','10001','10001','01110'],
  '9':['01110','10001','10001','01111','00001','00010','01100'],
  '.':['00000','00000','00000','00000','00000','00000','00100'],
  ':':['00000','00100','00000','00000','00000','00100','00000'],
  '/':['00001','00010','00010','00100','01000','01000','10000'],
  '-':['00000','00000','00000','01110','00000','00000','00000'],
  'S':['01110','10001','10000','01110','00001','10001','01110'],
  'L':['10000','10000','10000','10000','10000','10000','11111'],
  'O':['01110','10001','10001','10001','10001','10001','01110'],
  'T':['11111','00100','00100','00100','00100','00100','00100'],
  'N':['10001','11001','10101','10011','10001','10001','10001'],
  'C':['01110','10001','10000','10000','10000','10001','01110'],
  ' ':['00000','00000','00000','00000','00000','00000','00000'],
  'x':['00000','00000','10001','01010','00100','01010','10001']
};

function drawText(rgba, w, h, text, x, y, r, g, b, scale = 2) {
  let cx = x;
  for (const ch of text) {
    const glyph = FONT[ch] || FONT[ch.toUpperCase()] || FONT[' '];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = cx + col * scale + sx;
            const py = y + row * scale + sy;
            if (px < 0 || px >= w || py < 0 || py >= h) continue;
            const d = (py * w + px) * 4;
            rgba[d] = r; rgba[d+1] = g; rgba[d+2] = b; rgba[d+3] = 255;
          }
        }
      }
    }
    cx += (5 + 1) * scale;
  }
}

function drawTextBg(rgba, w, h, text, x, y, scale = 2) {
  const tw = text.length * 6 * scale;
  const th = 7 * scale;
  for (let j = y - 2; j < y + th + 2; j++) {
    for (let i = x - 2; i < x + tw + 2; i++) {
      if (i < 0 || i >= w || j < 0 || j >= h) continue;
      const d = (j * w + i) * 4;
      rgba[d] = 0; rgba[d+1] = 0; rgba[d+2] = 0; rgba[d+3] = 255;
    }
  }
  drawText(rgba, w, h, text, x, y, 255, 255, 255, scale);
}

// ── Composite: draw card-slot detection overlay ─────────────────────────────
//
// Given a decoded RGBA screenshot and the output of findCardSlots(), returns
// the annotated RGBA buffer. Coloured rects mark slots detected above NCC
// threshold; a thin white rect at the averaged geometry shows what will
// actually be saved to calibration.json.

const SLOT_COLORS = [
  [255, 80,  80],  [255, 165, 0],  [255, 255, 0],  [ 80, 255, 80],
  [  0, 200, 255], [ 80,  80, 255], [255,  80, 255], [255, 255, 255]
];

function annotateSlotDetection(srcRgba, ssW, ssH, geom) {
  const out = new Uint8Array(ssW * ssH * 4);
  for (let i = 0; i < ssW * ssH; i++) {
    out[i*4]     = srcRgba[i*4];
    out[i*4 + 1] = srcRgba[i*4 + 1];
    out[i*4 + 2] = srcRgba[i*4 + 2];
    out[i*4 + 3] = 255;
  }

  if (!geom) return out;

  for (const s of geom.perSlot || []) {
    if (s.x == null) continue;
    const [rr, gg, bb] = SLOT_COLORS[(s.slot - 1) % SLOT_COLORS.length];
    drawRect(out, ssW, ssH, s.x, s.y, s.w, s.h, rr, gg, bb, 3);
    drawTextBg(out, ssW, ssH, `S${s.slot} ${s.ncc.toFixed(2)}`, s.x + 4, s.y + 4, 2);
    drawTextBg(out, ssW, ssH, `${s.w}x${s.h}`,                  s.x + 4, s.y + 26, 2);
  }

  for (let i = 0; i < 8; i++) {
    const x = geom.slotXPositions?.[i];
    if (x == null) continue;
    drawRect(out, ssW, ssH, x, geom.slotY, geom.slotWidth, geom.slotHeight, 255, 255, 255, 1);
  }

  return out;
}

module.exports = {
  encodePng,
  drawRect,
  drawText,
  drawTextBg,
  annotateSlotDetection,
  SLOT_COLORS,
  FONT
};
