/**
 * save_talent_overlay.js
 *
 * Saves a side-by-side PNG:
 *   left  = screenshot crop at the found talent-card geometry
 *   right = template (阴符玉简1.png) resized to the same size
 *
 * Run from project root:
 *   node "debug/talent card and dream detection/save_talent_overlay.js"
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const os   = require('os');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEBUG_DIR    = __dirname;
const CAL_PATH     = path.join(os.homedir(), 'AppData', 'Roaming', 'yixian-overlay', 'calibration.json');

const SCREENSHOT = path.join(DEBUG_DIR, 'fengxuround2.png');
const TEMPLATE   = path.join(PROJECT_ROOT, 'images', 'personal', 'FengXu', '阴符玉简1.png');
const OUT_PATH   = path.join(DEBUG_DIR, 'talent_overlay.png');

// Best geometry from grid search
const CROP_X = 35, CROP_Y = 257, CROP_W = 234, CROP_H = 378;
// Also show the normal slot for reference
const NORMAL_X = 45, NORMAL_Y = 273, NORMAL_W = 212, NORMAL_H = 343;

// ── PNG decoder ───────────────────────────────────────────────────────────────

function readU32(buf, off) {
  return ((buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]) >>> 0;
}
function paeth(a, b, c) {
  const p = a+b-c, pa = Math.abs(p-a), pb = Math.abs(p-b), pc = Math.abs(p-c);
  return (pa <= pb && pa <= pc) ? a : pb <= pc ? b : c;
}
function decodePng(filePath) {
  const buf = fs.readFileSync(filePath);
  let width, height, colorType, palette = null;
  const idatChunks = [];
  let pos = 8;
  while (pos < buf.length - 4) {
    const length = readU32(buf, pos);
    const type   = buf.slice(pos+4, pos+8).toString('ascii');
    const data   = buf.slice(pos+8, pos+8+length);
    pos += 12 + length;
    if      (type === 'IHDR') { width = readU32(data,0); height = readU32(data,4); colorType = data[9]; }
    else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idatChunks.push(data);
    else if (type === 'IEND') break;
  }
  const BPP = {0:1, 2:3, 3:1, 4:2, 6:4}, bpp = BPP[colorType];
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * bpp;
  const rgba = new Uint8Array(width * height * 4);
  const prevRow = new Uint8Array(stride);
  let rawPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++], row = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const v = raw[rawPos++], a = i>=bpp?row[i-bpp]:0, b = prevRow[i], c = i>=bpp?prevRow[i-bpp]:0;
      if      (filter === 0) row[i] = v;
      else if (filter === 1) row[i] = (v+a) & 0xFF;
      else if (filter === 2) row[i] = (v+b) & 0xFF;
      else if (filter === 3) row[i] = (v+((a+b)>>1)) & 0xFF;
      else if (filter === 4) row[i] = (v+paeth(a,b,c)) & 0xFF;
    }
    for (let x = 0; x < width; x++) {
      const s = x*bpp, d = (y*width+x)*4;
      if      (colorType === 0) { rgba[d]=rgba[d+1]=rgba[d+2]=row[s]; rgba[d+3]=255; }
      else if (colorType === 2) { rgba[d]=row[s]; rgba[d+1]=row[s+1]; rgba[d+2]=row[s+2]; rgba[d+3]=255; }
      else if (colorType === 3) { const p=row[s]*3; rgba[d]=palette[p]; rgba[d+1]=palette[p+1]; rgba[d+2]=palette[p+2]; rgba[d+3]=255; }
      else if (colorType === 4) { rgba[d]=rgba[d+1]=rgba[d+2]=row[s]; rgba[d+3]=row[s+1]; }
      else if (colorType === 6) { rgba[d]=row[s]; rgba[d+1]=row[s+1]; rgba[d+2]=row[s+2]; rgba[d+3]=row[s+3]; }
    }
    prevRow.set(row);
  }
  return { rgba, width, height };
}

// ── Bilinear resize ───────────────────────────────────────────────────────────

// Crop a sub-region from rgba image and resize to dstW×dstH, returns Uint8Array rgba
function cropResize(src, cx, cy, cw, ch, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 4);
  const scaleX = cw / dstW, scaleY = ch / dstH, SW = src.width;
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const sx = cx + dx * scaleX, sy = cy + dy * scaleY;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(x0+1, SW-1), y1 = Math.min(y0+1, src.height-1);
      const wx = sx-x0, wy = sy-y0;
      const base = (dy*dstW+dx)*4;
      for (let c = 0; c < 3; c++) {
        out[base+c] = Math.round(
          (1-wx)*(1-wy)*src.rgba[(y0*SW+x0)*4+c] +
          wx    *(1-wy)*src.rgba[(y0*SW+x1)*4+c] +
          (1-wx)*wy    *src.rgba[(y1*SW+x0)*4+c] +
          wx    *wy    *src.rgba[(y1*SW+x1)*4+c]
        );
      }
      out[base+3] = 255;
    }
  }
  return out;
}

// ── PNG encoder ───────────────────────────────────────────────────────────────

function crc32(buf) {
  const table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();
  let crc = 0xFFFFFFFF;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u32be(n) {
  return Buffer.from([(n>>>24)&0xFF,(n>>>16)&0xFF,(n>>>8)&0xFF,n&0xFF]);
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf  = u32be(data.length);
  const crcBuf  = u32be(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(rgba, width, height) {
  const sig  = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = pngChunk('IHDR', Buffer.concat([u32be(width), u32be(height), Buffer.from([8,2,0,0,0])]));
  const raw  = [];
  for (let y = 0; y < height; y++) {
    raw.push(0);  // filter type None
    for (let x = 0; x < width; x++) {
      const i = (y*width+x)*4;
      raw.push(rgba[i], rgba[i+1], rgba[i+2]);
    }
  }
  const idat = pngChunk('IDAT', zlib.deflateSync(Buffer.from(raw)));
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

// ── Draw a coloured rectangle border on rgba buffer ───────────────────────────

function drawRect(rgba, imgW, x, y, w, h, r, g, b) {
  const draw = (px, py) => {
    if (px < 0 || py < 0 || px >= imgW || py >= Math.floor(rgba.length / imgW / 4)) return;
    const i = (py * imgW + px) * 4;
    rgba[i] = r; rgba[i+1] = g; rgba[i+2] = b; rgba[i+3] = 255;
  };
  for (let t = 0; t < 3; t++) {
    for (let i = x; i < x+w; i++) { draw(i, y+t); draw(i, y+h-1-t); }
    for (let j = y; j < y+h; j++) { draw(x+t, j); draw(x+w-1-t, j); }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  console.log('Decoding images…');
  const ss   = decodePng(SCREENSHOT);
  const tmpl = decodePng(TEMPLATE);
  console.log(`  Screenshot: ${ss.width}×${ss.height}`);
  console.log(`  Template  : ${tmpl.width}×${tmpl.height}`);

  // Panel 1: screenshot context around slot 1 (wider area so you can see placement)
  const CTX_PAD = 40;
  const ctxX = Math.max(0, CROP_X - CTX_PAD);
  const ctxY = Math.max(0, CROP_Y - CTX_PAD);
  const ctxW = CROP_W + CTX_PAD * 2;
  const ctxH = CROP_H + CTX_PAD * 2;
  const panel1 = cropResize(ss, ctxX, ctxY, ctxW, ctxH, ctxW, ctxH);
  // Draw talent-card box (yellow)
  drawRect(panel1, ctxW, CROP_X-ctxX, CROP_Y-ctxY, CROP_W, CROP_H, 255,255,0);
  // Draw normal slot box (cyan)
  drawRect(panel1, ctxW, NORMAL_X-ctxX, NORMAL_Y-ctxY, NORMAL_W, NORMAL_H, 0,220,255);

  // Panel 2: talent crop at display size CROP_W×CROP_H
  const panel2 = cropResize(ss, CROP_X, CROP_Y, CROP_W, CROP_H, CROP_W, CROP_H);

  // Panel 3: template resized to CROP_W×CROP_H
  const panel3 = cropResize(tmpl, 0, 0, tmpl.width, tmpl.height, CROP_W, CROP_H);

  // Compose side-by-side: [context | crop | template]
  const GAP     = 4;
  const outW    = ctxW + GAP + CROP_W + GAP + CROP_W;
  const outH    = Math.max(ctxH, CROP_H);
  const out     = new Uint8Array(outW * outH * 4);

  // Fill background grey
  for (let i = 0; i < out.length; i += 4) { out[i]=30; out[i+1]=30; out[i+2]=30; out[i+3]=255; }

  function blit(panel, pw, ph, dstX, dstY) {
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const si = (y*pw+x)*4, di = ((dstY+y)*outW+(dstX+x))*4;
        out[di]=panel[si]; out[di+1]=panel[si+1]; out[di+2]=panel[si+2]; out[di+3]=255;
      }
    }
  }

  blit(panel1, ctxW, ctxH, 0, 0);
  blit(panel2, CROP_W, CROP_H, ctxW+GAP, 0);
  blit(panel3, CROP_W, CROP_H, ctxW+GAP+CROP_W+GAP, 0);

  const png = encodePng(out, outW, outH);
  fs.writeFileSync(OUT_PATH, png);
  console.log(`\nSaved: ${OUT_PATH}`);
  console.log(`  Left panel : screenshot context  (yellow=talent box, cyan=normal box)`);
  console.log(`  Mid panel  : talent crop (${CROP_W}×${CROP_H} from ${CROP_X},${CROP_Y})`);
  console.log(`  Right panel: template resized to same size`);
}

main();
