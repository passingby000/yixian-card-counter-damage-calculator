const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── Pure Node.js PNG decoder (no color profile transforms) ────────────────
// Same approach as calibrator.js decodePng — kept here to avoid a cross-file
// dependency between slot_detector (runtime) and calibrator (one-shot job).

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
    if      (type === 'IHDR') { width = readU32(data, 0); height = readU32(data, 4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'PLTE') { palette = data; }
    else if (type === 'IDAT') { idatChunks.push(data); }
    else if (type === 'IEND') { break; }
  }

  if (!width || !height) throw new Error(`Invalid PNG (no IHDR): ${filePath}`);
  if (bitDepth !== 8)    throw new Error(`Unsupported bit depth ${bitDepth} in ${filePath}`);

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
      else if (filter === 1) row[i] = (v + a)                       & 0xFF;
      else if (filter === 2) row[i] = (v + b)                       & 0xFF;
      else if (filter === 3) row[i] = (v + ((a + b) >> 1))          & 0xFF;
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

// ── Mask builders ─────────────────────────────────────────────────────────
// Mask convention: mask[i] = 0 means "skip this pixel" (transparent/border),
//                  mask[i] = 1 means "compare this pixel" (card content).

function buildAlphaMask(filePath) {
  const { data, width, height } = decodePng(filePath);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    mask[i] = data[i * 4 + 3] === 0 ? 0 : 1;
  }
  return { mask, width, height };
}

// Near-black threshold (sum R+G+B <= threshold). Used for RGB-only baselines
// where the card's outer region is padded with near-black pixels instead of
// real alpha transparency (e.g., sect level-2 and level-3 templates).
function buildNearBlackMask(filePath, threshold = 10) {
  const { data, width, height } = decodePng(filePath);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    mask[i] = (r + g + b) <= threshold ? 0 : 1;
  }
  return { mask, width, height };
}

// Nearest-neighbour resize preserves the binary 0/1 nature of the mask.
function resizeMaskNN(srcMask, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH);
  for (let dy = 0; dy < dstH; dy++) {
    const sy = Math.min(srcH - 1, Math.floor(dy * srcH / dstH));
    for (let dx = 0; dx < dstW; dx++) {
      const sx = Math.min(srcW - 1, Math.floor(dx * srcW / dstW));
      out[dy * dstW + dx] = srcMask[sy * srcW + sx];
    }
  }
  return out;
}

// ── Baseline mask registry ────────────────────────────────────────────────
// Each entry: { file: relative-to-imagesDir, kind: 'alpha' | 'near-black' }
//
// sect-L1 / sect-L2 / sect-L3 — 剑劈1/2/3 at 425x685. L1 is RGBA; L2 & L3 are
//   RGB-only, so their border comes from near-black padding. These masks are
//   also used for non-FengXu personal cards (all 425x685, share the sect shape).
// dream — 梦·灵气灌注1 at 395x663 RGBA. Two of 405 dream templates are 400x675;
//   the baseline is resized to match each template's dims before comparison,
//   absorbing the ~1% scale mismatch.
// fengxu — 击虚1 at 422x692 RGBA. Used for all FengXu personal cards (the only
//   personal character with a 422x692 canvas instead of 425x685).

const BASELINE_DEFS = {
  'sect-L1': { file: path.join('sect', 'cloud-spirit', '1', '剑劈1.png'),           kind: 'alpha'      },
  'sect-L2': { file: path.join('sect', 'cloud-spirit', '1', '剑劈2.png'),           kind: 'near-black' },
  'sect-L3': { file: path.join('sect', 'cloud-spirit', '1', '剑劈3.png'),           kind: 'near-black' },
  'dream':   { file: path.join('seasonal', 'cloud-spirit', '梦·灵气灌注1.png'),     kind: 'alpha'      },
  'fengxu':  { file: path.join('personal', 'FengXu', '击虚1.png'),                  kind: 'alpha'      }
};

let baselineMasksCache = null;
let baselineMasksImagesDir = null;

function loadBaselineMasks(imagesDir) {
  if (baselineMasksCache && baselineMasksImagesDir === imagesDir) return baselineMasksCache;
  const out = {};
  for (const [key, def] of Object.entries(BASELINE_DEFS)) {
    const full = path.join(imagesDir, def.file);
    try {
      out[key] = def.kind === 'alpha' ? buildAlphaMask(full) : buildNearBlackMask(full);
    } catch (_err) {
      // Missing baseline file → no mask for that category (falls back to
      // unmasked comparison, preserving pre-mask behaviour).
      out[key] = null;
    }
  }
  baselineMasksCache = out;
  baselineMasksImagesDir = imagesDir;
  return out;
}

// Decide which baseline applies to a given template filepath + level.
// Returns a key into BASELINE_DEFS, or null for templates that don't get masked
// (e.g., avatars, fortune, sigils — these aren't card templates anyway).
function getMaskKeyForTemplate(filePath, level) {
  const norm = filePath.replace(/\\/g, '/');
  const lvlKey = (level === 1 || level === 2 || level === 3) ? ('sect-L' + level) : null;

  if (norm.includes('/seasonal/')) return 'dream';
  if (norm.includes('/personal/FengXu/')) return 'fengxu';
  if (norm.includes('/personal/')) return lvlKey;
  if (norm.includes('/sect/')) return lvlKey;
  return null;
}

module.exports = {
  decodePng,
  buildAlphaMask,
  buildNearBlackMask,
  resizeMaskNN,
  loadBaselineMasks,
  getMaskKeyForTemplate
};
