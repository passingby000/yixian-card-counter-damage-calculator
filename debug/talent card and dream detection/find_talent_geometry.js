/**
 * find_talent_geometry.js
 *
 * Finds the position and size of talent (personal) cards in a screenshot.
 * Grid-searches over x/y offset and width/height around a known slot anchor.
 *
 * Both template and each crop are downsampled to THUMB×THUMB for fast MSE —
 * no need to compare every pixel of a 422×692 image.
 *
 * Usage:
 *   node "debug/talent card and dream detection/find_talent_geometry.js"
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const os   = require('os');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEBUG_DIR    = __dirname;
const CAL_PATH     = path.join(os.homedir(), 'AppData', 'Roaming', 'yixian-overlay', 'calibration.json');

// ── Config ────────────────────────────────────────────────────────────────────

const SCREENSHOT = path.join(DEBUG_DIR, 'fengxuround2.png');
const TEMPLATE   = path.join(PROJECT_ROOT, 'images', 'personal', 'FengXu', '阴符玉简1.png');

const SLOT_INDEX = 0;   // talent card is in slot 1 (0-based)
const THUMB      = 32;  // downsample size for fast MSE comparison

// Grid search (screenshot pixels, step 2)
const X_OFFSETS = range(-40, 48, 2);
const Y_OFFSETS = range(-20, 24, 2);
const WIDTHS    = range(140, 260, 2);
const HEIGHTS   = range(240, 380, 2);

const TOP_N = 10;

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
      else if (filter === 1) row[i] = (v+a)&0xFF;
      else if (filter === 2) row[i] = (v+b)&0xFF;
      else if (filter === 3) row[i] = (v+((a+b)>>1))&0xFF;
      else if (filter === 4) row[i] = (v+paeth(a,b,c))&0xFF;
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
  return { data: rgba, width, height };
}

// Convert RGBA to Float32 RGB
function toRgb(dec) {
  const { data, width, height } = dec;
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i*3] = data[i*4]; rgb[i*3+1] = data[i*4+1]; rgb[i*3+2] = data[i*4+2];
  }
  return { rgb, width, height };
}

// ── Bilinear downsample of a sub-region to THUMB×THUMB ───────────────────────

function thumbRgb(src, cx, cy, cw, ch) {
  const out = new Float32Array(THUMB * THUMB * 3);
  const scaleX = cw / THUMB, scaleY = ch / THUMB, SW = src.width;
  for (let dy = 0; dy < THUMB; dy++) {
    for (let dx = 0; dx < THUMB; dx++) {
      const sx = cx + dx * scaleX, sy = cy + dy * scaleY;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(x0+1, SW-1), y1 = Math.min(y0+1, src.height-1);
      const wx = sx-x0, wy = sy-y0;
      const base = (dy*THUMB+dx)*3;
      for (let c = 0; c < 3; c++) {
        out[base+c] =
          (1-wx)*(1-wy)*src.rgb[(y0*SW+x0)*3+c] +
          wx    *(1-wy)*src.rgb[(y0*SW+x1)*3+c] +
          (1-wx)*wy    *src.rgb[(y1*SW+x0)*3+c] +
          wx    *wy    *src.rgb[(y1*SW+x1)*3+c];
      }
    }
  }
  return out;
}

// MSE between two THUMB×THUMB RGB buffers
function mse(a, b) {
  const n = a.length;
  let sum = 0;
  for (let i = 0; i < n; i++) { const d = a[i]-b[i]; sum += d*d; }
  return sum / n;
}

function range(start, end, step) {
  const out = [];
  for (let v = start; v < end; v += step) out.push(v);
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const cal = JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'));
  const s   = cal.slots;
  const anchorX = s.slotXPositions[SLOT_INDEX];
  const anchorY = s.slotY;
  const normalW = s.slotWidth;
  const normalH = s.slotHeight;

  console.log('=== Talent Card Geometry Finder ===\n');
  console.log(`Screenshot : ${path.basename(SCREENSHOT)}`);
  console.log(`Template   : ${path.basename(TEMPLATE)}`);
  console.log(`Slot ${SLOT_INDEX+1} anchor: x=${anchorX}  y=${anchorY}  normal=${normalW}×${normalH}`);
  const total = X_OFFSETS.length * Y_OFFSETS.length * WIDTHS.length * HEIGHTS.length;
  console.log(`Grid combos: ${total}  (thumb=${THUMB}×${THUMB})\n`);

  console.log('Decoding images…');
  const ss     = decodePng(SCREENSHOT);
  const tmplDec = decodePng(TEMPLATE);
  const srcRgb  = toRgb(ss);
  const tmplRgb = toRgb(tmplDec);
  console.log(`  Screenshot: ${ss.width}×${ss.height}   Template: ${tmplDec.width}×${tmplDec.height}\n`);

  // Pre-downsample template once
  const tmplThumb = thumbRgb(tmplRgb, 0, 0, tmplDec.width, tmplDec.height);

  console.log('Searching…');
  const results = [];

  for (const xOff of X_OFFSETS) {
    for (const yOff of Y_OFFSETS) {
      const cropX = anchorX + xOff;
      const cropY = anchorY + yOff;
      for (const w of WIDTHS) {
        if (cropX < 0 || cropX + w > ss.width) continue;
        for (const h of HEIGHTS) {
          if (cropY < 0 || cropY + h > ss.height) continue;
          const cropThumb = thumbRgb(srcRgb, cropX, cropY, w, h);
          const score     = mse(cropThumb, tmplThumb);
          results.push({ score, xOff, yOff, w, h, cropX, cropY });
        }
      }
    }
  }

  results.sort((a, b) => a.score - b.score);

  console.log(`\nTop ${TOP_N} results (lowest MSE = best match):\n`);
  console.log(`${'Rank'.padEnd(5)} ${'MSE'.padEnd(10)} ${'xOff'.padEnd(6)} ${'yOff'.padEnd(6)} ${'w'.padEnd(6)} ${'h'.padEnd(6)} ${'origin'.padEnd(12)} ${'wRatio'.padEnd(8)} hRatio`);
  console.log('─'.repeat(75));
  for (let i = 0; i < Math.min(TOP_N, results.length); i++) {
    const r = results[i];
    console.log(
      `#${(i+1).toString().padEnd(4)} ${r.score.toFixed(1).padEnd(10)} ` +
      `${r.xOff.toString().padEnd(6)} ${r.yOff.toString().padEnd(6)} ` +
      `${r.w.toString().padEnd(6)} ${r.h.toString().padEnd(6)} ` +
      `(${r.cropX},${r.cropY})`.padEnd(12) + '  ' +
      `${(r.w/normalW).toFixed(3).padEnd(8)} ${(r.h/normalH).toFixed(3)}`
    );
  }

  const best = results[0];
  console.log(`\n→ Best: xOff=${best.xOff}  yOff=${best.yOff}  size=${best.w}×${best.h}`);
  console.log(`        widthRatio=${(best.w/normalW).toFixed(4)}  heightRatio=${(best.h/normalH).toFixed(4)}`);
  console.log(`        cropOrigin=(${best.cropX},${best.cropY})  MSE=${best.score.toFixed(1)}`);
  console.log('\n=== DONE ===');
}

main();
