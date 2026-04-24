const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const { getYisimPath, getAssetPath, getWritablePath } = require('./runtime_paths');
const { encodePng, annotateSlotDetection } = require('./calibration_debug_draw');

// Reference geometry used to anchor the multi-scale card search. At 1920×1080
// fullscreen, in-game cards are ~343 px tall, so the "base" template scale is
// chosen to match that. The multi-scale sweep then covers ±30% to absorb
// differences in in-game UI scale, Windows DPI, aspect ratio, and windowed mode.
const SLOT_BASE_H   = 1080;
const SLOT_CONFIG_H = 343;
// Dream cards are slightly narrower/shorter and shifted right vs normal cards.
// Values from grid-search debug over 8 confirmed dream slots (dream_geometry_report.json):
//   xOffset +8 px, widthDelta -16 px → ratio 196/212 ≈ 0.925
//   heightDelta -8 px                → ratio 335/343 ≈ 0.977
const DREAM_WIDTH_RATIO  = 0.925;
const DREAM_HEIGHT_RATIO = 0.977;
const DREAM_X_OFFSET     = 8;

const TALENT_TEMPLATES_DIR = getYisimPath('lanke', 'talent_templates');
const IMAGES_DIR           = getAssetPath('images');

// Calibration reference deck/talents. The user must have this exact board loaded
// in-game when clicking Calibrate. These are the cards that will be searched for
// in the screenshot to establish slot geometry; talents likewise establish the
// five talent rects. Hardcoded here so calibration doesn't depend on an
// external cards_and_talent.txt file at runtime.
const CALIBRATION_SLOT_CARDS = {
  1: '云剑•闪风1',
  2: '云剑•飞刺3',
  3: '运笔如飞1',
  4: '云剑•汇灵2',
  5: '破气剑1',
  6: '巨鹏灵剑2',
  7: '水月剑阵2',
  8: '镜花剑阵2'
};
const CALIBRATION_TALENTS = {
  1: 'Shift As Cloud',
  2: 'Sword In Sheathed',
  3: 'Endurance As Cloud Sea',
  4: 'Shade Of Cloud',
  5: 'Spring Course Tea'
};

// ── Pure Node.js PNG decoder (no color profile transforms) ──────────────────

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

function decodePng(source) {
  // Accepts either a file path (string) or a PNG buffer directly.
  const buf = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
  const srcLabel = Buffer.isBuffer(source) ? '<buffer>' : source;

  const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIGNATURE[i]) throw new Error(`Not a valid PNG: ${srcLabel}`);
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

  if (!width || !height) throw new Error(`Invalid PNG (no IHDR): ${srcLabel}`);
  if (bitDepth !== 8)    throw new Error(`Unsupported bit depth ${bitDepth} in ${srcLabel}`);

  const BPP_MAP = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bpp = BPP_MAP[colorType];
  if (!bpp) throw new Error(`Unsupported color type ${colorType} in ${srcLabel}`);

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

// Load a PNG template from disk as grayscale using raw PNG bytes (no color transforms)
function loadTemplateGray(templatePath) {
  try {
    const img = decodePng(templatePath);
    const { data, width, height } = img;
    const gray = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      gray[i] = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2];
    }
    return { gray, width, height };
  } catch (e) {
    return null;
  }
}

// Bilinear resize of a Float32Array grayscale image
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

// Nearest-neighbour downsample by integer factor
function downsample(gray, w, h, ds) {
  const dw = Math.floor(w / ds);
  const dh = Math.floor(h / ds);
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++)
    for (let x = 0; x < dw; x++)
      out[y * dw + x] = gray[(y * ds) * w + (x * ds)];
  return { gray: out, w: dw, h: dh };
}

// Zero-mean Normalized Cross-Correlation using only pixels inside the inscribed circle
function znccCircular(ssGray, ssW, sx, sy, tmplGray, tw, th) {
  const cx = (tw - 1) / 2;
  const cy = (th - 1) / 2;
  const r2 = cx * cx;
  let n = 0, sumI = 0, sumT = 0;
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const dx = tx - cx, dy = ty - cy;
      if (dx * dx / r2 + dy * dy / (cy * cy || 1) > 1) continue;
      sumI += ssGray[(sy + ty) * ssW + (sx + tx)];
      sumT += tmplGray[ty * tw + tx];
      n++;
    }
  }
  if (n === 0) return 0;
  const mI = sumI / n, mT = sumT / n;
  let num = 0, denI = 0, denT = 0;
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const dx = tx - cx, dy = ty - cy;
      if (dx * dx / r2 + dy * dy / (cy * cy || 1) > 1) continue;
      const di = ssGray[(sy + ty) * ssW + (sx + tx)] - mI;
      const dt = tmplGray[ty * tw + tx] - mT;
      num += di * dt; denI += di * di; denT += dt * dt;
    }
  }
  const denom = Math.sqrt(denI * denT);
  return denom < 1 ? 0 : num / denom;
}

// Rectangular ZNCC over the full template
function znccAt(ssGray, ssW, sx, sy, tmplGray, tw, th) {
  const n = tw * th;
  let sumI = 0, sumT = 0;
  for (let ty = 0; ty < th; ty++)
    for (let tx = 0; tx < tw; tx++) {
      sumI += ssGray[(sy + ty) * ssW + (sx + tx)];
      sumT += tmplGray[ty * tw + tx];
    }
  const mI = sumI / n, mT = sumT / n;
  let num = 0, denI = 0, denT = 0;
  for (let ty = 0; ty < th; ty++)
    for (let tx = 0; tx < tw; tx++) {
      const di = ssGray[(sy + ty) * ssW + (sx + tx)] - mI;
      const dt = tmplGray[ty * tw + tx] - mT;
      num += di * dt; denI += di * di; denT += dt * dt;
    }
  const denom = Math.sqrt(denI * denT);
  return denom < 1 ? 0 : num / denom;
}

// Card-search primitives.
//
// Detection is split into three building blocks so that findCardSlots can share
// the expensive work (downsampling, scale discovery) across all 8 slots:
//
//   coarseMultiScale(ss4, ...)   — sweep ±30% around baseScale on the already-
//                                  downsampled image; returns winning scale +
//                                  coarse position. Template aspect preserved
//                                  (tw = tmplW*s, th = tmplH*s, same scalar).
//   coarseAtScale(ss4, ...)      — single-scale coarse scan at a known scale,
//                                  used once the scale has been locked by the
//                                  multi-scale pass on the first slot.
//   fineRefine(ssGray, ..., cx, cy) — full-res ZNCC in a small window around
//                                     the coarse winner.
//
// All three operate on a pre-computed `ss4 = downsample(ssGray, ssW, ssH, 4)`
// so the 480×270 downsampled buffer is reused for every slot and every scale.

const DS = 4;

function coarseMultiScale(ss4, ssW, ssH, tmplGray, tmplW, tmplH, yMin, yMax) {
  // Base scale anchors the template at the same screen-height fraction as a
  // 343 px card at 1080p. Sweeping ±30% covers in-game UI scale, Windows DPI,
  // aspect-ratio, and windowed-mode variation.
  const baseScale = (ssH / SLOT_BASE_H) * (SLOT_CONFIG_H / tmplH);
  const cy0 = Math.max(0, Math.floor(yMin / DS));
  const cyCap = Math.floor(yMax / DS);

  let best = { ncc: -Infinity, x: 0, y: 0, scale: baseScale, tw: 0, th: 0 };
  for (let mult = 0.70; mult <= 1.30 + 1e-9; mult += 0.05) {
    const s = baseScale * mult;
    const tw = Math.max(1, Math.round(tmplW * s));
    const th = Math.max(1, Math.round(tmplH * s));
    if (tw >= ssW || th >= ssH) continue;

    const tw4 = Math.max(1, Math.floor(tw / DS));
    const th4 = Math.max(1, Math.floor(th / DS));
    const tm4 = resizeGray(tmplGray, tmplW, tmplH, tw4, th4);

    const cx1 = ss4.w - tw4;
    const cy1 = Math.min(ss4.h - th4, cyCap);
    for (let y = cy0; y <= cy1; y++) {
      for (let x = 0; x <= cx1; x++) {
        const score = znccAt(ss4.gray, ss4.w, x, y, tm4, tw4, th4);
        if (score > best.ncc) {
          best = { ncc: score, x: x * DS, y: y * DS, scale: s, tw, th };
        }
      }
    }
  }
  return best;
}

function coarseAtScale(ss4, ssW, ssH, tmplGray, tmplW, tmplH, scale, yMin, yMax) {
  const tw = Math.max(1, Math.round(tmplW * scale));
  const th = Math.max(1, Math.round(tmplH * scale));
  if (tw >= ssW || th >= ssH) return null;

  const tw4 = Math.max(1, Math.floor(tw / DS));
  const th4 = Math.max(1, Math.floor(th / DS));
  const tm4 = resizeGray(tmplGray, tmplW, tmplH, tw4, th4);

  const cx1 = ss4.w - tw4;
  const cy0 = Math.max(0, Math.floor(yMin / DS));
  const cy1 = Math.min(ss4.h - th4, Math.floor(yMax / DS));

  let best = { ncc: -Infinity, x: 0, y: 0, tw, th };
  for (let y = cy0; y <= cy1; y++) {
    for (let x = 0; x <= cx1; x++) {
      const score = znccAt(ss4.gray, ss4.w, x, y, tm4, tw4, th4);
      if (score > best.ncc) { best = { ncc: score, x: x * DS, y: y * DS, tw, th }; }
    }
  }
  return best;
}

function fineRefine(ssGray, ssW, ssH, tmplGray, tmplW, tmplH, tw, th, cx, cy) {
  const scaled = resizeGray(tmplGray, tmplW, tmplH, tw, th);
  const margin = DS * 3;
  const fx0 = Math.max(0, cx - margin);
  const fy0 = Math.max(0, cy - margin);
  const fx1 = Math.min(ssW - tw, cx + margin);
  const fy1 = Math.min(ssH - th, cy + margin);

  let best = -Infinity, bestX = cx, bestY = cy;
  for (let y = fy0; y <= fy1; y++) {
    for (let x = fx0; x <= fx1; x++) {
      const score = znccAt(ssGray, ssW, x, y, scaled, tw, th);
      if (score > best) { best = score; bestX = x; bestY = y; }
    }
  }
  return { x: bestX, y: bestY, ncc: best, w: tw, h: th };
}

// Back-compat wrapper: two-step multi-scale detection for a single slot.
// Kept so external callers (e.g. debug scripts that want an isolated API)
// still work; findCardSlots now uses the primitives directly to share ss4.
function findBestCardPositionMultiScale(ssGray, ssW, ssH, tmplGray, tmplW, tmplH, yMin, yMax) {
  const ss4 = downsample(ssGray, ssW, ssH, DS);
  const coarse = coarseMultiScale(ss4, ssW, ssH, tmplGray, tmplW, tmplH, yMin, yMax);
  if (coarse.ncc === -Infinity) return { x: 0, y: 0, w: 0, h: 0, ncc: 0 };
  return fineRefine(ssGray, ssW, ssH, tmplGray, tmplW, tmplH,
                    coarse.tw, coarse.th, coarse.x, coarse.y);
}

// Two-pass talent search: DS=4 coarse scan → full-res fine pass around best hit
function findBestPositionTalent(ssGray, ssW, ssH, tmplGray, tw, th, yMin, yMax, xMin, xMax) {
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

// Multi-scale circular ZNCC: search bottom-left quadrant at scales 0.40–1.26
function findTalentMultiScale(ssGray, ssW, ssH, tmpl) {
  const { gray: tmplGray, width: tmplW, height: tmplH } = tmpl;
  const xMax = Math.floor(ssW * 0.30);
  const yMin = Math.floor(ssH * 0.50);
  let best = null;

  for (let scale = 0.40; scale <= 1.26; scale += 0.05) {
    const tw = Math.max(1, Math.round(tmplW * scale));
    const th = Math.max(1, Math.round(tmplH * scale));
    if (tw >= xMax || th >= ssH) continue;
    const scaled = resizeGray(tmplGray, tmplW, tmplH, tw, th);
    const result = findBestPositionTalent(ssGray, ssW, ssH, scaled, tw, th, yMin, ssH, 0, xMax);
    if (!best || result.ncc > best.ncc) best = result;
  }

  return best; // { x, y, w, h, ncc }
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ── Card slot detection via template matching ─────────────────────────────

function walkDir(dir) {
  let out = [];
  if (!fs.existsSync(dir)) return out;
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

function findCardImagePath(cardName, idx) {
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

// NCC below this counts as "didn't find the card" — prevents garbage positions
// from being treated as valid detections when the template doesn't match well
// (wrong scale, wrong card on screen, UI obscured).
const CARD_NCC_THRESHOLD = 0.45;

async function findCardSlots(ssGray, ssW, ssH) {
  const yMin = Math.floor(ssH * 0.10);
  const yMax = Math.floor(ssH * 0.88);

  const imageIndex = buildImageIndex(IMAGES_DIR);

  // Load every available template up front; skipped slots simply have no entry.
  const slotTemplates = {};
  for (let slot = 1; slot <= 8; slot++) {
    const cardName = CALIBRATION_SLOT_CARDS[slot];
    if (!cardName) continue;
    const imgPath = findCardImagePath(cardName, imageIndex);
    if (!imgPath) continue;
    const tmpl = loadTemplateGray(imgPath);
    if (!tmpl) continue;
    slotTemplates[slot] = { cardName, ...tmpl };
  }

  const slotIndices = Object.keys(slotTemplates).map(Number).sort((a, b) => a - b);
  if (slotIndices.length === 0) {
    throw new Error('No calibration card templates could be loaded from images/.');
  }

  // Share the downsampled screenshot across all slots and all scales.
  const ss4 = downsample(ssGray, ssW, ssH, DS);

  // Phase 1 — lock the scale from the first available slot via the full
  // multi-scale sweep. All 8 cards in the hand render at the same scale, so we
  // only need to discover it once.
  const seedSlot = slotIndices[0];
  const seedT    = slotTemplates[seedSlot];
  await yieldToEventLoop();
  const seedCoarse = coarseMultiScale(ss4, ssW, ssH, seedT.gray, seedT.width, seedT.height, yMin, yMax);
  const seedFine   = fineRefine(ssGray, ssW, ssH, seedT.gray, seedT.width, seedT.height,
                                seedCoarse.tw, seedCoarse.th, seedCoarse.x, seedCoarse.y);

  const allScores = [{
    slot: seedSlot, card: seedT.cardName,
    ncc: +seedFine.ncc.toFixed(3), w: seedFine.w, h: seedFine.h
  }];
  const found = [];
  if (seedFine.ncc >= CARD_NCC_THRESHOLD) {
    found.push({ slot: seedSlot, x: seedFine.x, y: seedFine.y, w: seedFine.w, h: seedFine.h });
  }

  // Phase 2 — single-scale coarse scan for every remaining slot at the locked
  // scale, with a tight y-band around the seed slot's row (cards are in a
  // single horizontal row, so y shouldn't vary more than a few pixels).
  const lockedScale = seedCoarse.scale;
  const rowY        = seedFine.y;
  const yBand       = Math.max(20, Math.floor(ssH * 0.03));
  const yMinFast    = Math.max(yMin, rowY - yBand);
  const yMaxFast    = Math.min(yMax, rowY + seedFine.h + yBand);

  for (const slot of slotIndices) {
    if (slot === seedSlot) continue;
    await yieldToEventLoop();
    const t = slotTemplates[slot];
    const coarse = coarseAtScale(ss4, ssW, ssH, t.gray, t.width, t.height, lockedScale, yMinFast, yMaxFast);
    if (!coarse) continue;
    const fine = fineRefine(ssGray, ssW, ssH, t.gray, t.width, t.height,
                            coarse.tw, coarse.th, coarse.x, coarse.y);
    allScores.push({ slot, card: t.cardName, ncc: +fine.ncc.toFixed(3), w: fine.w, h: fine.h });
    if (fine.ncc >= CARD_NCC_THRESHOLD) {
      found.push({ slot, x: fine.x, y: fine.y, w: fine.w, h: fine.h });
    }
  }
  allScores.sort((a, b) => a.slot - b.slot);

  if (found.length < 4) {
    throw new Error(
      `Card slot detection found only ${found.length}/8 slots above NCC ${CARD_NCC_THRESHOLD}. ` +
      `Make sure the calibration reference deck is loaded in-game. ` +
      `Per-slot scores: ${JSON.stringify(allScores)}`
    );
  }

  // Average Y and detected size across well-matched slots — these reflect the
  // game's actual card dimensions on the user's screen, not the assumed
  // 212/1920 × 343/1080 ratio.
  const slotY      = Math.round(found.reduce((s, r) => s + r.y, 0) / found.length);
  const slotWidth  = Math.round(found.reduce((s, r) => s + r.w, 0) / found.length);
  const slotHeight = Math.round(found.reduce((s, r) => s + r.h, 0) / found.length);

  // Build X position array; fill missing slots by interpolating from the average spacing
  const slotXPositions = new Array(8).fill(null);
  for (const r of found) slotXPositions[r.slot - 1] = r.x;

  if (found.length < 8) {
    const knownX = found.sort((a, b) => a.slot - b.slot);
    const gaps = [];
    for (let i = 1; i < knownX.length; i++)
      gaps.push((knownX[i].x - knownX[0].x) / (knownX[i].slot - knownX[0].slot));
    const avgGap = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length);
    const anchor = knownX[0];
    for (let i = 0; i < 8; i++) {
      if (slotXPositions[i] === null)
        slotXPositions[i] = Math.max(0, anchor.x + (i - (anchor.slot - 1)) * avgGap);
    }
  }

  return { slotY, slotHeight, slotWidth, slotXPositions, perSlot: allScores.map((s) => {
    const f = found.find((r) => r.slot === s.slot);
    return { ...s, x: f?.x ?? null, y: f?.y ?? null };
  }) };
}

// ── Talent detection ─────────────────────────────────────────────────────────

function findTalentTemplate(position, talentName) {
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

async function findTalentPositions(ssGray, ssW, ssH, onProgress = null) {
  const rects = [];

  for (let pos = 1; pos <= 5; pos++) {
    onProgress?.(pos + 1, 7, `Finding talent ${pos}`);
    await yieldToEventLoop();

    // Prefer the hardcoded reference talent if available for this position
    const talentName = CALIBRATION_TALENTS[pos];
    const namedPath = talentName ? findTalentTemplate(pos, talentName) : null;

    let best = null;

    if (namedPath) {
      const tmpl = loadTemplateGray(namedPath);
      if (tmpl) best = findTalentMultiScale(ssGray, ssW, ssH, tmpl);
    }

    // If no named template or poor match, try all templates in this position's directory
    if (!best || best.ncc < 0.5) {
      const posDir = path.join(TALENT_TEMPLATES_DIR, `position_${pos}`);
      if (fs.existsSync(posDir)) {
        for (const file of fs.readdirSync(posDir)) {
          if (!file.toLowerCase().endsWith('.png')) continue;
          const tmpl = loadTemplateGray(path.join(posDir, file));
          if (!tmpl) continue;
          const r = findTalentMultiScale(ssGray, ssW, ssH, tmpl);
          if (!best || r.ncc > best.ncc) best = r;
          if (best.ncc >= 0.7) break; // good enough — stop early
        }
      }
    }

    rects.push(best ? { x: best.x, y: best.y, width: best.w, height: best.h, score: best.ncc } : null);
  }

  return rects;
}

// ── Main calibration entry point ───────────────────────────────────────────

async function performCalibration(screenshot, onProgress = null) {
  // Decode screenshot from raw PNG bytes (same path as templates — no color profile transforms)
  // Use ssW/ssH from the decoded PNG (physical pixels), NOT screenshot.getSize() which returns logical pixels
  const ssImg = decodePng(screenshot.toPNG());
  const { data: ssRgba, width: ssW, height: ssH } = ssImg;
  const ssGray = (() => {
    const gray = new Float32Array(ssW * ssH);
    for (let i = 0; i < ssW * ssH; i++)
      gray[i] = 0.299 * ssRgba[i*4] + 0.587 * ssRgba[i*4+1] + 0.114 * ssRgba[i*4+2];
    return gray;
  })();

  // Find card slot geometry via two-step multi-scale template matching.
  onProgress?.(0, 7, 'Finding card slots');
  const slotGeom = await findCardSlots(ssGray, ssW, ssH);
  const { slotY, slotHeight, slotWidth, slotXPositions } = slotGeom;
  onProgress?.(1, 7, 'Card slots found');

  await yieldToEventLoop();

  // Find talent positions via multi-scale circular ZNCC
  const talentRects = await findTalentPositions(ssGray, ssW, ssH, onProgress);
  onProgress?.(7, 7, 'Done');

  // Write an annotated debug PNG to userData so the user can inspect whether
  // the detector actually found each card. Non-fatal if it fails (e.g. when
  // running outside Electron).
  try {
    const annotated = annotateSlotDetection(ssRgba, ssW, ssH, slotGeom);
    const debugPath = getWritablePath('calibration_debug.png');
    fs.writeFileSync(debugPath, encodePng(annotated, ssW, ssH));
  } catch (_err) {
    // ignore — debug artifact, not part of the calibration contract
  }

  return {
    version: 1,
    screenshotSize: { width: ssW, height: ssH },
    slots: {
      baseScreenWidth:  ssW,
      baseScreenHeight: ssH,
      slotY,
      slotWidth,
      slotHeight,
      slotXPositions,
      dreamSlotRatio: { width: DREAM_WIDTH_RATIO, height: DREAM_HEIGHT_RATIO },
      dreamXOffset: DREAM_X_OFFSET
    },
    talents: talentRects.map((r) => r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null),
    scores: { talents: talentRects.map((r) => r?.score ?? 0) },
    calibratedAt: new Date().toISOString()
  };
}

module.exports = {
  performCalibration,
  // Exposed for offline debug scripts (e.g. debug/calibration/debug_card_detection.js)
  // that want to run card detection against a saved screenshot without going
  // through the Electron runtime.
  decodePng,
  findCardSlots,
  findBestCardPositionMultiScale,
  loadTemplateGray,
  buildImageIndex,
  findCardImagePath,
  CALIBRATION_SLOT_CARDS,
  IMAGES_DIR
};
