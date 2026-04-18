#!/usr/bin/env node
/**
 * find_positions.js
 * Brute-force MSE template matching to locate card slots and talent positions.
 *
 * Run:  node calibration/find_positions.js
 *
 * Prerequisites:
 *   - calibration/calibration_capture.png  (saved when you click Calibrate in-game)
 *   - calibration/cards_and_talent.txt     (lists the board cards + talent names)
 *   - images/                              (card art PNGs)
 *   - yisim/lanke/talent_templates/        (talent PNGs per position)
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT_DIR             = path.resolve(__dirname, '..');
const CAPTURE_PATH         = path.join(__dirname, 'test position.png');
const CARDS_TXT_PATH       = path.join(__dirname, 'cards_and_talent.txt');
const IMAGES_DIR           = path.join(ROOT_DIR, 'images');
const TALENT_TEMPLATES_DIR = path.join(ROOT_DIR, 'yisim', 'lanke', 'talent_templates');

// Expected card aspect ratio from config (width / height)
const CARD_ASPECT = 212 / 343;
// Search range for card width (pixels in screenshot space)
const CARD_W_MIN  = 150;
const CARD_W_MAX  = 280;
const CARD_W_STEP = 4;
// Only compare the top fraction of each card (avoids overlaid level/count UI at bottom)
const CARD_MATCH_FRACTION = 0.60;

// ── PNG decoder (no external deps) ──────────────────────────────────────────

function readU32(buf, off) {
  return ((buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]) >>> 0;
}

function paethPredictor(a, b, c) {
  const p  = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(filePath) {
  const buf = fs.readFileSync(filePath);

  const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIGNATURE[i]) throw new Error(`Not a valid PNG: ${filePath}`);
  }

  let width, height, bitDepth, colorType;
  let palette = null;
  const idatChunks = [];

  let pos = 8;
  while (pos < buf.length - 4) {
    const length = readU32(buf, pos);
    const type   = buf.slice(pos + 4, pos + 8).toString('ascii');
    const data   = buf.slice(pos + 8, pos + 8 + length);
    pos += 12 + length;

    if (type === 'IHDR') {
      width     = readU32(data, 0);
      height    = readU32(data, 4);
      bitDepth  = data[8];
      colorType = data[9];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!width || !height) throw new Error(`Invalid PNG (no IHDR): ${filePath}`);
  if (bitDepth !== 8)    throw new Error(`Unsupported bit depth ${bitDepth} in ${filePath}`);

  // channels per pixel: 0=gray, 2=RGB, 3=indexed, 4=grayA, 6=RGBA
  const BPP_MAP = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bpp = BPP_MAP[colorType];
  if (!bpp) throw new Error(`Unsupported color type ${colorType} in ${filePath}`);

  const raw     = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride  = width * bpp;
  const rgba    = new Uint8Array(width * height * 4);
  let   rawPos  = 0;
  const prevRow = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++];
    const row    = new Uint8Array(stride);

    for (let i = 0; i < stride; i++) {
      const v = raw[rawPos++];
      const a = i >= bpp ? row[i - bpp]     : 0;
      const b = prevRow[i];
      const c = i >= bpp ? prevRow[i - bpp] : 0;
      if      (filter === 0) row[i] = v;
      else if (filter === 1) row[i] = (v + a)                    & 0xFF;
      else if (filter === 2) row[i] = (v + b)                    & 0xFF;
      else if (filter === 3) row[i] = (v + ((a + b) >> 1))       & 0xFF;
      else if (filter === 4) row[i] = (v + paethPredictor(a, b, c)) & 0xFF;
      else throw new Error(`Unknown PNG filter ${filter} at row ${y}`);
    }

    for (let x = 0; x < width; x++) {
      const s = x * bpp;
      const d = (y * width + x) * 4;
      if      (colorType === 0) { rgba[d]=rgba[d+1]=rgba[d+2]=row[s]; rgba[d+3]=255; }
      else if (colorType === 2) { rgba[d]=row[s]; rgba[d+1]=row[s+1]; rgba[d+2]=row[s+2]; rgba[d+3]=255; }
      else if (colorType === 3) {
        const p = row[s] * 3;
        rgba[d]=palette[p]; rgba[d+1]=palette[p+1]; rgba[d+2]=palette[p+2]; rgba[d+3]=255;
      }
      else if (colorType === 4) { rgba[d]=rgba[d+1]=rgba[d+2]=row[s]; rgba[d+3]=row[s+1]; }
      else if (colorType === 6) { rgba[d]=row[s]; rgba[d+1]=row[s+1]; rgba[d+2]=row[s+2]; rgba[d+3]=row[s+3]; }
    }

    prevRow.set(row);
  }

  return { data: rgba, width, height };
}

// ── Image utilities ──────────────────────────────────────────────────────────

function toGray(img) {
  const { data, width, height } = img;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    gray[i] = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2];
  }
  return { gray, width, height };
}

function resizeGray(srcGray, srcW, srcH, dstW, dstH) {
  const out = new Float32Array(dstW * dstH);
  const rx  = srcW / dstW;
  const ry  = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const fx = dx * rx, fy = dy * ry;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const y1 = Math.min(y0 + 1, srcH - 1);
      const wx = fx - x0, wy = fy - y0;
      out[dy * dstW + dx] =
        (1-wx)*(1-wy)*srcGray[y0*srcW+x0] +
        wx   *(1-wy)*srcGray[y0*srcW+x1] +
        (1-wx)*wy   *srcGray[y1*srcW+x0] +
        wx   *wy   *srcGray[y1*srcW+x1];
    }
  }
  return out;
}

// ── ZNCC matching (lighting-invariant) ──────────────────────────────────────
// Returns a value in [-1, 1]. Higher = better match.
// Invariant to brightness/contrast differences between template and screenshot.

// Rectangular ZNCC over the top CARD_MATCH_FRACTION of the template (avoids level UI).
function znccAt(ssGray, ssW, sx, sy, tmplGray, tw, th) {
  const rows = Math.floor(th * CARD_MATCH_FRACTION);
  const n    = tw * rows;
  let sumI = 0, sumT = 0;
  for (let ty = 0; ty < rows; ty++)
    for (let tx = 0; tx < tw; tx++) {
      sumI += ssGray[(sy + ty) * ssW + (sx + tx)];
      sumT += tmplGray[ty * tw + tx];
    }
  const mI = sumI / n, mT = sumT / n;
  let num = 0, denI = 0, denT = 0;
  for (let ty = 0; ty < rows; ty++)
    for (let tx = 0; tx < tw; tx++) {
      const di = ssGray[(sy + ty) * ssW + (sx + tx)] - mI;
      const dt = tmplGray[ty * tw + tx] - mT;
      num += di * dt; denI += di * di; denT += dt * dt;
    }
  const denom = Math.sqrt(denI * denT);
  return denom < 1 ? 0 : num / denom;
}

// Circular ZNCC — only pixels inside the inscribed circle contribute.
// Ignores corner background that doesn't belong to the circular talent icon.
function znccCircular(ssGray, ssW, sx, sy, tmplGray, tw, th) {
  const cx = (tw - 1) / 2, cy = (th - 1) / 2;
  const r2 = (Math.min(tw, th) / 2) ** 2;
  let sumI = 0, sumT = 0, n = 0;
  for (let ty = 0; ty < th; ty++)
    for (let tx = 0; tx < tw; tx++) {
      if ((tx - cx) ** 2 + (ty - cy) ** 2 > r2) continue;
      sumI += ssGray[(sy + ty) * ssW + (sx + tx)];
      sumT += tmplGray[ty * tw + tx];
      n++;
    }
  if (n === 0) return 0;
  const mI = sumI / n, mT = sumT / n;
  let num = 0, denI = 0, denT = 0;
  for (let ty = 0; ty < th; ty++)
    for (let tx = 0; tx < tw; tx++) {
      if ((tx - cx) ** 2 + (ty - cy) ** 2 > r2) continue;
      const di = ssGray[(sy + ty) * ssW + (sx + tx)] - mI;
      const dt = tmplGray[ty * tw + tx] - mT;
      num += di * dt; denI += di * di; denT += dt * dt;
    }
  const denom = Math.sqrt(denI * denT);
  return denom < 1 ? 0 : num / denom;
}

// Downsample grayscale by integer factor DS (nearest-neighbour)
function downsample(gray, w, h, ds) {
  const dw = Math.floor(w / ds);
  const dh = Math.floor(h / ds);
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      out[y * dw + x] = gray[(y * ds) * w + (x * ds)];
    }
  }
  return { gray: out, w: dw, h: dh };
}

// Two-pass ZNCC: DS=4 coarse scan, then full-res fine scan around winner.
// Maximises NCC (higher = better match, lighting-invariant).
function findBestPosition(ssGray, ssW, ssH, tmplGray, tw, th, yMin, yMax, xMin = 0, xMax = ssW) {
  const DS = 4;
  const ss4 = downsample(ssGray, ssW, ssH, DS);
  const tw4 = Math.max(1, Math.floor(tw / DS));
  const th4 = Math.max(1, Math.floor(th / DS));
  const tm4 = resizeGray(tmplGray, tw, th, tw4, th4);

  const cx0 = Math.max(0, Math.floor(xMin / DS));
  const cx1 = Math.min(ss4.w - tw4, Math.floor((xMax - tw) / DS));
  const cy0 = Math.max(0, Math.floor(yMin / DS));
  const cy1 = Math.min(ss4.h - th4, Math.floor(yMax / DS));

  let coarseBest = -Infinity, coarseX = cx0, coarseY = cy0;
  for (let y = cy0; y <= cy1; y++)
    for (let x = cx0; x <= cx1; x++) {
      const score = znccAt(ss4.gray, ss4.w, x, y, tm4, tw4, th4);
      if (score > coarseBest) { coarseBest = score; coarseX = x; coarseY = y; }
    }

  const margin = DS * 3;
  const fy0 = Math.max(yMin, coarseY * DS - margin);
  const fy1 = Math.min(Math.min(yMax, ssH - th), coarseY * DS + margin);
  const fx0 = Math.max(xMin, coarseX * DS - margin);
  const fx1 = Math.min(Math.min(xMax - tw, ssW - tw), coarseX * DS + margin);

  let fineBest = -Infinity, bestX = coarseX * DS, bestY = coarseY * DS;
  for (let y = fy0; y <= fy1; y++)
    for (let x = fx0; x <= fx1; x++) {
      const score = znccAt(ssGray, ssW, x, y, tmplGray, tw, th);
      if (score > fineBest) { fineBest = score; bestX = x; bestY = y; }
    }

  return { x: bestX, y: bestY, ncc: fineBest, w: tw, h: th };
}

// Single-scale card search using config-estimated dimensions
function findCard(ssGray, ssW, ssH, tmplImg, yMin, yMax) {
  const { gray: tmplGray, width: tmplW, height: tmplH } = toGray(tmplImg);
  // Estimate target slot size from config ratio (212×343 at 1920×1080)
  const tw = Math.round(ssW * 212 / 1920);
  const th = Math.round(ssH * 343 / 1080);
  const scaled = resizeGray(tmplGray, tmplW, tmplH, tw, th);
  return findBestPosition(ssGray, ssW, ssH, scaled, tw, th, yMin, yMax);
}

// Two-pass circular ZNCC for talents: DS=4 coarse + full-res fine.
// If allCandidates array is provided, every coarse hit is pushed into it.
function findBestPositionTalent(ssGray, ssW, ssH, tmplGray, tw, th, yMin, yMax, xMin, xMax, allCandidates) {
  const DS = 4;
  const ss4 = downsample(ssGray, ssW, ssH, DS);
  const tw4 = Math.max(1, Math.floor(tw / DS));
  const th4 = Math.max(1, Math.floor(th / DS));
  const tm4 = resizeGray(tmplGray, tw, th, tw4, th4);

  const cx0 = Math.max(0, Math.floor(xMin / DS));
  const cx1 = Math.min(ss4.w - tw4, Math.floor((xMax - tw) / DS));
  const cy0 = Math.max(0, Math.floor(yMin / DS));
  const cy1 = Math.min(ss4.h - th4, Math.floor(yMax / DS));

  let coarseBest = -Infinity, coarseX = cx0, coarseY = cy0;
  for (let y = cy0; y <= cy1; y++)
    for (let x = cx0; x <= cx1; x++) {
      const score = znccCircular(ss4.gray, ss4.w, x, y, tm4, tw4, th4);
      if (score > coarseBest) { coarseBest = score; coarseX = x; coarseY = y; }
      if (allCandidates) allCandidates.push({ x: x * DS, y: y * DS, score, w: tw, h: th });
    }

  const margin = DS * 4;
  const fy0 = Math.max(yMin, coarseY * DS - margin);
  const fy1 = Math.min(Math.min(yMax, ssH - th), coarseY * DS + margin);
  const fx0 = Math.max(xMin, coarseX * DS - margin);
  const fx1 = Math.min(Math.min(xMax - tw, ssW - tw), coarseX * DS + margin);

  let fineBest = -Infinity, bestX = coarseX * DS, bestY = coarseY * DS;
  for (let y = fy0; y <= fy1; y++)
    for (let x = fx0; x <= fx1; x++) {
      const score = znccCircular(ssGray, ssW, x, y, tmplGray, tw, th);
      if (score > fineBest) { fineBest = score; bestX = x; bestY = y; }
    }

  return { x: bestX, y: bestY, ncc: fineBest, w: tw, h: th };
}

// Talent search: multi-scale circular ZNCC, restricted to bottom-left quadrant.
function findTalentMultiScale(ssGray, ssW, ssH, tmplImg) {
  const { gray: tmplGray, width: tmplW, height: tmplH } = toGray(tmplImg);
  const xMax = Math.floor(ssW * 0.30);
  const yMin = Math.floor(ssH * 0.50);
  let best = null;

  for (let scale = 0.40; scale <= 1.26; scale += 0.05) {
    const tw = Math.max(1, Math.round(tmplW * scale));
    const th = Math.max(1, Math.round(tmplH * scale));
    if (tw >= xMax || th >= ssH) continue;

    const scaled = resizeGray(tmplGray, tmplW, tmplH, tw, th);
    const result = findBestPositionTalent(ssGray, ssW, ssH, scaled, tw, th, yMin, ssH, 0, xMax, null);
    if (!best || result.ncc > best.ncc) { best = result; }
  }

  return best;
}

// ── Calibration text parser ──────────────────────────────────────────────────

function parseCalibrationTxt(filePath) {
  const slots = {}, talents = {};
  if (!fs.existsSync(filePath)) return { slots, talents };

  for (const rawLine of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const sm = line.match(/^slot(\d+):\s*(.+)$/);
    if (sm)  { slots[parseInt(sm[1], 10)]   = sm[2].trim();  continue; }

    const tm = line.match(/^talent(\d+):\s*(.+)$/);
    if (tm)  { talents[parseInt(tm[1], 10)] = tm[2].trim(); }
  }

  return { slots, talents };
}

// ── File finders ─────────────────────────────────────────────────────────────

function walkDir(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkDir(full));
    else if (e.name.toLowerCase().endsWith('.png')) out.push(full);
  }
  return out;
}

function buildImageIndex(dir) {
  const idx = new Map();
  for (const f of walkDir(dir)) {
    const key = path.basename(f, '.png').trim().toLowerCase();
    if (!idx.has(key)) idx.set(key, f);
  }
  return idx;
}

function findCardImage(cardName, idx) {
  const variants = [
    cardName.trim().toLowerCase(),
    cardName.trim().toLowerCase().replace(/·/g, '•'),
    cardName.trim().toLowerCase().replace(/•/g, '·'),
  ];
  for (const v of variants) {
    if (idx.has(v)) return idx.get(v);
  }
  return null;
}

function findTalentImage(position, talentName) {
  const posDir = path.join(TALENT_TEMPLATES_DIR, `position_${position}`);
  if (!fs.existsSync(posDir)) return null;
  const key = talentName.trim().toLowerCase().replace(/\s+/g, '');
  for (const entry of fs.readdirSync(posDir)) {
    if (!entry.toLowerCase().endsWith('.png')) continue;
    const eKey = path.basename(entry, '.png').trim().toLowerCase().replace(/\s+/g, '');
    if (eKey === key) return path.join(posDir, entry);
  }
  return null;
}

// ── PNG encoder + drawing ─────────────────────────────────────────────────────

function encodePng(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((1 + stride) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (1 + stride)] = 0;
    for (let x = 0; x < stride; x++) raw[y * (1 + stride) + 1 + x] = rgba[(y * stride) + x];
  }
  const deflated = zlib.deflateSync(raw, { level: 6 });
  const crcTbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTbl[n] = c;
  }
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = crcTbl[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const tb = Buffer.from(type, 'ascii');
    const lb = Buffer.alloc(4); lb.writeUInt32BE(data.length);
    const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])));
    return Buffer.concat([lb, tb, data, cb]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflated), chunk('IEND', Buffer.alloc(0))
  ]);
}

// Minimal 4×5 pixel-art bitmap font for digits 1–9, drawn at 2× scale.
function drawRect(imgData, imgW, imgH, x, y, w, h, r, g, b, thickness = 3) {
  for (let t = 0; t < thickness; t++) {
    for (let px = x; px < x + w; px++) {
      for (const py of [y + t, y + h - 1 - t]) {
        if (px < 0 || px >= imgW || py < 0 || py >= imgH) continue;
        const o = (py * imgW + px) * 4;
        imgData[o] = r; imgData[o+1] = g; imgData[o+2] = b; imgData[o+3] = 255;
      }
    }
    for (let py = y; py < y + h; py++) {
      for (const px of [x + t, x + w - 1 - t]) {
        if (px < 0 || px >= imgW || py < 0 || py >= imgH) continue;
        const o = (py * imgW + px) * 4;
        imgData[o] = r; imgData[o+1] = g; imgData[o+2] = b; imgData[o+3] = 255;
      }
    }
  }
}

// Paste the template image (resized to tw×th) into the result image at (x, y).
// Draws the template at 60% opacity blended over the screenshot so both are visible.
function drawTemplateInBox(imgData, imgW, imgH, x, y, tmplImg, tw, th) {
  const { data: tData, width: tW, height: tH } = tmplImg;
  const scaled = new Float32Array(tw * th * 3);  // RGB
  const rx = tW / tw, ry = tH / th;
  // Bilinear-resize template RGB into the box dimensions
  for (let dy = 0; dy < th; dy++) {
    for (let dx = 0; dx < tw; dx++) {
      const fx = dx * rx, fy = dy * ry;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, tW - 1), y1 = Math.min(y0 + 1, tH - 1);
      const wx = fx - x0, wy = fy - y0;
      for (let c = 0; c < 3; c++) {
        scaled[(dy * tw + dx) * 3 + c] =
          (1 - wx) * (1 - wy) * tData[(y0 * tW + x0) * 4 + c] +
          wx       * (1 - wy) * tData[(y0 * tW + x1) * 4 + c] +
          (1 - wx) * wy       * tData[(y1 * tW + x0) * 4 + c] +
          wx       * wy       * tData[(y1 * tW + x1) * 4 + c];
      }
    }
  }
  // Blend onto the result image at 60% template / 40% screenshot
  const ALPHA = 0.6;
  for (let dy = 0; dy < th; dy++) {
    for (let dx = 0; dx < tw; dx++) {
      const px = x + dx, py = y + dy;
      if (px < 0 || px >= imgW || py < 0 || py >= imgH) continue;
      const o = (py * imgW + px) * 4;
      for (let c = 0; c < 3; c++) {
        imgData[o + c] = Math.round(
          ALPHA * scaled[(dy * tw + dx) * 3 + c] + (1 - ALPHA) * imgData[o + c]
        );
      }
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(CAPTURE_PATH)) {
    console.error('ERROR: calibration_capture.png not found.');
    console.error('  Open the game and click Settings → Calibrate to capture a screenshot first.');
    process.exit(1);
  }

  console.log('Loading screenshot:', CAPTURE_PATH);
  const ssImg = decodePng(CAPTURE_PATH);
  const { gray: ssGray, width: ssW, height: ssH } = toGray(ssImg);
  console.log(`  Size: ${ssW} × ${ssH}\n`);

  // Build RGBA buffer for annotated output
  const rgba = new Uint8Array(ssW * ssH * 4);
  for (let i = 0; i < ssW * ssH; i++) {
    rgba[i*4]   = ssImg.data[i*4];
    rgba[i*4+1] = ssImg.data[i*4+1];
    rgba[i*4+2] = ssImg.data[i*4+2];
    rgba[i*4+3] = 255;
  }

  const yMin = Math.floor(ssH * 0.10);
  const yMax = Math.floor(ssH * 0.88);

  const { slots: slotNames, talents: talentNames } = parseCalibrationTxt(CARDS_TXT_PATH);
  const imageIndex = buildImageIndex(IMAGES_DIR);

  // ── Card slots ─────────────────────────────────────────────────────────────
  console.log('=== Card Slots ===');
  const slotResults = [];

  for (let i = 1; i <= 8; i++) {
    const cardName = slotNames[i];
    if (!cardName) { console.log(`  slot${i}: (no name in cards_and_talent.txt)`); continue; }

    const imgPath = findCardImage(cardName, imageIndex);
    if (!imgPath) {
      console.log(`  slot${i}: "${cardName}" → image NOT FOUND in ${path.relative(ROOT_DIR, IMAGES_DIR)}`);
      continue;
    }

    process.stdout.write(`  slot${i}: ${cardName} ... `);
    let tmplImg;
    try { tmplImg = decodePng(imgPath); }
    catch (e) { console.log(`DECODE ERROR: ${e.message}`); continue; }

    const t0 = Date.now();
    const r  = findCard(ssGray, ssW, ssH, tmplImg, yMin, yMax);
    console.log(`x=${r.x}  y=${r.y}  w=${r.w}  h=${r.h}  ncc=${r.ncc.toFixed(3)}  (${Date.now()-t0}ms)`);
    slotResults.push({ slot: i, name: cardName, ...r });
    drawRect(rgba, ssW, ssH, r.x, r.y, r.w, r.h, 0, 220, 60);
  }

  if (slotResults.length > 0) {
    const avgY = Math.round(slotResults.reduce((s, r) => s + r.y, 0) / slotResults.length);
    const avgW = Math.round(slotResults.reduce((s, r) => s + r.w, 0) / slotResults.length);
    const avgH = Math.round(slotResults.reduce((s, r) => s + r.h, 0) / slotResults.length);
    const xPositions = slotResults.sort((a, b) => a.slot - b.slot).map((r) => r.x);

    console.log('\n  → Suggested slot_detector_config.json values:');
    console.log(`    "baseScreenWidth":  ${ssW},`);
    console.log(`    "baseScreenHeight": ${ssH},`);
    console.log(`    "slotY":            ${avgY},`);
    console.log(`    "slotWidth":        ${avgW},`);
    console.log(`    "slotHeight":       ${avgH},`);
    console.log(`    "slotXPositions":   [${xPositions.join(', ')}]`);
  }

  // ── Talents ───────────────────────────────────────────────────────────────
  console.log('\n=== Talents ===');
  const talentResults = [];

  for (let i = 1; i <= 5; i++) {
    const talentName = talentNames[i];
    if (!talentName) { console.log(`  talent${i}: (no name in cards_and_talent.txt)`); continue; }

    const imgPath = findTalentImage(i, talentName);
    if (!imgPath) {
      console.log(`  talent${i}: "${talentName}" → image NOT FOUND in position_${i}/`);
      continue;
    }

    process.stdout.write(`  talent${i}: ${talentName} ... `);
    let tmplImg;
    try { tmplImg = decodePng(imgPath); }
    catch (e) { console.log(`DECODE ERROR: ${e.message}`); continue; }

    const t0 = Date.now();
    const r = findTalentMultiScale(ssGray, ssW, ssH, tmplImg);
    console.log(`x=${r.x}  y=${r.y}  w=${r.w}  h=${r.h}  ncc=${r.ncc.toFixed(3)}  (${Date.now()-t0}ms)`);
    talentResults.push({ talent: i, name: talentName, ...r });

    drawTemplateInBox(rgba, ssW, ssH, r.x, r.y, tmplImg, r.w, r.h);
    drawRect(rgba, ssW, ssH, r.x, r.y, r.w, r.h, 255, 120, 0);  // orange = best
  }

  if (talentResults.length > 0) {
    console.log('\n  → Suggested talent rects (for calibrator.js TALENT_CONFIG_RECTS):');
    for (const r of talentResults) {
      console.log(`    talent${r.talent} "${r.name}": { x: ${r.x}, y: ${r.y}, width: ${r.w}, height: ${r.h} }`);
    }
  }

  // ── Write annotated output ────────────────────────────────────────────────
  const OUTPUT_PATH = path.join(__dirname, 'find_positions_result.png');
  fs.writeFileSync(OUTPUT_PATH, encodePng(rgba, ssW, ssH));
  console.log(`\n✓ Annotated image saved to: ${OUTPUT_PATH}`);
  console.log('  Green  = card slots   Orange = talent slots');
}

main();
