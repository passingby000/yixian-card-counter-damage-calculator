#!/usr/bin/env node
/**
 * debug_dream_phase.js
 *
 * Reproduces the same scoring slot_detector uses for dream-card phase
 * resolution, against a saved board screenshot. Output: per-slot, per-phase
 * scores so we can see whether the wrong phase wins because of (a) the
 * primary-metric ordering, (b) the discriminant-mask phase resolver, or (c)
 * a slot-rect alignment issue (the rect is over the wrong pixels, so the
 * text-region comparison is garbage).
 *
 * Setup:
 *   1. Save the failing board screenshot as `board.png` in this folder.
 *   2. Edit DREAM_CARD below to the dream card whose phase mis-detects
 *      (default: 梦•蜻蜓点水). The script will look up all of its phases
 *      under images/seasonal/<set>/<name>{1..5}.png.
 *   3. Edit SLOT_INDEX (default 0 = first slot) to point at the on-screen
 *      slot containing that card. Calibration is read from
 *      %APPDATA%\yixian-overlay\calibration.json.
 *   4. Run from the repo root:  node debug/dream_card_phase_differentiation/debug_dream_phase.js
 *
 * Output:
 *   - Console: for each phase 1..5 — primary metric (rgbMse) and the
 *     phase-mask scores (grayMse + rgbMse) computed via the same
 *     discriminant-mask logic the runtime uses. The winner per metric is
 *     marked with `*`.
 *   - PNG: `board_phase_diagnosed.png` — slot rect drawn on the screenshot,
 *     per-phase score labels stacked beside it, plus the discriminant mask
 *     overlay so we can see which pixels actually drove the phase decision.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { decodePng } = require(path.join(ROOT, 'calibrator'));
const { encodePng, drawRect, drawTextBg } = require(path.join(ROOT, 'calibration_debug_draw'));

// ── EDIT THESE ──────────────────────────────────────────────────────────────

const SCREENSHOT_PATH = path.join(__dirname, 'board.png');
const DREAM_CARD      = '梦•蜻蜓点水';
const SLOT_INDEX      = 0; // 0-based; first hand slot

// ── Calibration ─────────────────────────────────────────────────────────────

const CALIBRATION_PATH = (() => {
  const local = path.join(__dirname, 'calibration.json');
  if (fs.existsSync(local)) return local;
  const userData = path.join(process.env.APPDATA || '', 'yixian-overlay', 'calibration.json');
  if (fs.existsSync(userData)) return userData;
  return local;
})();

// ── Constants mirrored from slot_detector ───────────────────────────────────

const IMAGES_DIR  = path.join(ROOT, 'images');
const CONFIG_PATH = path.join(ROOT, 'slot_detector_config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const STABLE_REGIONS = config.stableRegions;
const DEFAULT_METRIC = config.defaultMetric;

const DREAM_PHASE_MASK_REGIONS = [
  { x: 0.06, y: 0.45, width: 0.88, height: 0.48, weight: 1 }
];
const DREAM_PHASE_FALLBACK_REGIONS = [
  { x: 0.08, y: 0.48, width: 0.84, height: 0.18, weight: 0.30 },
  { x: 0.08, y: 0.64, width: 0.84, height: 0.24, weight: 0.60 },
  { x: 0.18, y: 0.86, width: 0.64, height: 0.08, weight: 0.10 }
];
const DREAM_PHASE_MIN_MASK_PIXELS    = 200;
const DREAM_PHASE_MASK_TOP_FRACTION  = 0.16;
const DREAM_PHASE_MASK_MIN_GRAY_DIFF = 3;
const DREAM_PHASE_GRAY_WEIGHT        = 0.65;
const DREAM_PHASE_RGB_WEIGHT         = 0.35;
const DREAM_PHASE_CHROMATIC_REGIONS = [
  { x: 0.00, y: 0.00, width: 0.10, height: 1.00 }, // left edge
  { x: 0.00, y: 0.90, width: 1.00, height: 0.10 }  // bottom border
];
const DREAM_PHASE_CHROMATIC_RANK_W = 0.8;
const DREAM_PHASE_MASK_RANK_W      = 0.2;

const DEFAULT_DREAM_RATIO    = { width: 0.925, height: 0.977 };
const DEFAULT_DREAM_X_OFFSET = 8;

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalizeCardName(n) { return (n || '').replace(/[·•]/g, '•').trim(); }

function rgbaToGrayRgb(rgba, w, h) {
  const gray = new Float32Array(w * h);
  const rgb  = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i*4], g = rgba[i*4+1], b = rgba[i*4+2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    rgb[i*3] = r; rgb[i*3+1] = g; rgb[i*3+2] = b;
  }
  return { gray: { gray, width: w, height: h }, rgb: { rgb, width: w, height: h } };
}

function resizeRgba(srcRgba, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 4);
  const rx = srcW / dstW, ry = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const fx = dx * rx, fy = dy * ry;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, srcW - 1), y1 = Math.min(y0 + 1, srcH - 1);
      const wx = fx - x0, wy = fy - y0;
      const di = (dy * dstW + dx) * 4;
      for (let c = 0; c < 4; c++) {
        const v00 = srcRgba[(y0*srcW+x0)*4+c];
        const v01 = srcRgba[(y0*srcW+x1)*4+c];
        const v10 = srcRgba[(y1*srcW+x0)*4+c];
        const v11 = srcRgba[(y1*srcW+x1)*4+c];
        out[di+c] = Math.round((1-wx)*(1-wy)*v00 + wx*(1-wy)*v01 + (1-wx)*wy*v10 + wx*wy*v11);
      }
    }
  }
  return out;
}

function cropAndResize(srcRgba, srcW, srcH, x, y, w, h, dstW, dstH) {
  const sub = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const sx = x + i, sy = y + j;
      if (sx >= 0 && sx < srcW && sy >= 0 && sy < srcH) {
        const si = (sy * srcW + sx) * 4;
        const di = (j * w + i) * 4;
        sub[di]   = srcRgba[si];
        sub[di+1] = srcRgba[si+1];
        sub[di+2] = srcRgba[si+2];
        sub[di+3] = srcRgba[si+3];
      }
    }
  }
  return resizeRgba(sub, w, h, dstW, dstH);
}

function getRegionBounds(width, height, region) {
  const x0 = Math.max(0, Math.floor(region.x * width));
  const y0 = Math.max(0, Math.floor(region.y * height));
  const x1 = Math.min(width,  Math.ceil((region.x + region.width)  * width));
  const y1 = Math.min(height, Math.ceil((region.y + region.height) * height));
  return { x0, y0, x1, y1 };
}

function regionStats(grayA, grayB, region, mask) {
  const { width } = grayA;
  const { x0, y0, x1, y1 } = getRegionBounds(grayA.width, grayA.height, region);
  let sumA=0, sumB=0, grayMse=0, count=0;
  for (let y=y0; y<y1; y++) for (let x=x0; x<x1; x++) {
    const i = y*width+x; if (mask && mask[i]===0) continue;
    count++; const d=grayA.gray[i]-grayB.gray[i];
    sumA+=grayA.gray[i]; sumB+=grayB.gray[i]; grayMse+=d*d;
  }
  if (count===0) return { ssim:0, ncc:0, grayMse:Infinity };
  const meanA=sumA/count, meanB=sumB/count;
  let varA=0,varB=0,cov=0,num=0,denA=0,denB=0;
  for (let y=y0; y<y1; y++) for (let x=x0; x<x1; x++) {
    const i = y*width+x; if (mask && mask[i]===0) continue;
    const a=grayA.gray[i]-meanA, b=grayB.gray[i]-meanB;
    varA+=a*a; varB+=b*b; cov+=a*b;
    num+=grayA.gray[i]*grayB.gray[i]; denA+=grayA.gray[i]**2; denB+=grayB.gray[i]**2;
  }
  const div=Math.max(1,count-1); varA/=div; varB/=div; cov/=div;
  const c1=6.5025, c2=58.5225;
  const ssim = (((2*meanA*meanB)+c1)*((2*cov)+c2)) / (((meanA*meanA)+(meanB*meanB)+c1)*(varA+varB+c2));
  const nccDen = Math.sqrt(denA*denB);
  return { ssim: Number.isFinite(ssim)?ssim:0, ncc: nccDen===0?0:num/nccDen, grayMse: grayMse/count };
}

function regionRgbMse(rgbA, rgbB, region, mask) {
  const { width } = rgbA;
  const { x0, y0, x1, y1 } = getRegionBounds(rgbA.width, rgbA.height, region);
  let total=0, count=0;
  for (let y=y0; y<y1; y++) for (let x=x0; x<x1; x++) {
    const px=y*width+x; if (mask && mask[px]===0) continue;
    count++;
    const i=px*3;
    const dr=rgbA.rgb[i]-rgbB.rgb[i], dg=rgbA.rgb[i+1]-rgbB.rgb[i+1], db=rgbA.rgb[i+2]-rgbB.rgb[i+2];
    total += dr*dr + dg*dg + db*db;
  }
  return count===0 ? Infinity : total/(count*3);
}

function compareImages(grayA, rgbA, grayB, rgbB, regions, mask) {
  let wssim=0, wncc=0, wgray=0, wrgb=0, total=0;
  for (const r of regions) {
    const { ssim, ncc, grayMse } = regionStats(grayA, grayB, r, mask);
    const rgbMse = regionRgbMse(rgbA, rgbB, r, mask);
    wssim += ssim*r.weight; wncc += ncc*r.weight;
    wgray += grayMse*r.weight; wrgb += rgbMse*r.weight; total += r.weight;
  }
  return total===0 ? { ssim:0, ncc:0, grayMse:Infinity, rgbMse:Infinity }
                   : { ssim:wssim/total, ncc:wncc/total, grayMse:wgray/total, rgbMse:wrgb/total };
}

function buildRegionMask(width, height, regions) {
  const mask = new Uint8Array(width*height);
  for (const r of regions) {
    const { x0, y0, x1, y1 } = getRegionBounds(width, height, r);
    for (let y=y0; y<y1; y++) for (let x=x0; x<x1; x++) mask[y*width+x] = 1;
  }
  return mask;
}

function buildDreamPhaseDiscriminantMask(phaseData, width, height) {
  const regionMask = buildRegionMask(width, height, DREAM_PHASE_MASK_REGIONS);
  const diffs = [];
  for (let i=0; i<width*height; i++) {
    if (regionMask[i] === 0) continue;
    let minG=Infinity, maxG=-Infinity;
    for (const d of phaseData) {
      const g = d.gray.gray[i]; if (g<minG) minG=g; if (g>maxG) maxG=g;
    }
    const diff = maxG-minG;
    if (diff > 0) diffs.push({ idx: i, grayDiff: diff });
  }
  diffs.sort((a,b) => b.grayDiff - a.grayDiff);
  const target = Math.min(diffs.length, Math.max(DREAM_PHASE_MIN_MASK_PIXELS, Math.floor(diffs.length*DREAM_PHASE_MASK_TOP_FRACTION)));
  let selected = diffs.slice(0, target).filter(e => e.grayDiff >= DREAM_PHASE_MASK_MIN_GRAY_DIFF);
  if (selected.length < DREAM_PHASE_MIN_MASK_PIXELS) {
    selected = diffs.slice(0, Math.min(diffs.length, DREAM_PHASE_MIN_MASK_PIXELS));
  }
  if (selected.length < DREAM_PHASE_MIN_MASK_PIXELS) return { mask: null, pixelCount: selected.length, mode: 'fallback' };
  const mask = new Uint8Array(width*height);
  for (const e of selected) mask[e.idx] = 1;
  return { mask, pixelCount: selected.length, mode: 'mask' };
}

function combinePhaseScore(grayMse, rgbMse) {
  return (grayMse * DREAM_PHASE_GRAY_WEIGHT) + (rgbMse * DREAM_PHASE_RGB_WEIGHT);
}

function computeRegionAverageRgb(rgbData, mask, width, height, region) {
  const { x0, y0, x1, y1 } = getRegionBounds(width, height, region);
  let r=0, g=0, b=0, n=0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = y * width + x;
      if (mask && mask[idx] === 0) continue;
      const ri = idx * 3;
      r += rgbData.rgb[ri]; g += rgbData.rgb[ri+1]; b += rgbData.rgb[ri+2]; n++;
    }
  }
  return n === 0 ? null : { r: r/n, g: g/n, b: b/n };
}

function rgbToChromaticity(avg) {
  if (!avg) return null;
  const sum = avg.r + avg.g + avg.b;
  if (sum < 1) return null;
  return { r: avg.r / sum, g: avg.g / sum, b: avg.b / sum };
}

function chromaticRegionsDistance(cropAvgs, tmplAvgs) {
  if (!cropAvgs || !tmplAvgs) return Infinity;
  let total = 0;
  for (let i = 0; i < cropAvgs.length; i++) {
    const a = rgbToChromaticity(cropAvgs[i]);
    const b = rgbToChromaticity(tmplAvgs[i]);
    if (!a || !b) return Infinity;
    const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
    total += Math.sqrt(dr*dr + dg*dg + db*db);
  }
  return total;
}

function scoreMaskedDreamPhase(cropGray, cropRgb, tmpl, mask) {
  let grayTotal=0, rgbTotal=0, count=0;
  for (let i=0; i<mask.length; i++) {
    if (mask[i] === 0) continue;
    count++;
    const dg = cropGray.gray[i] - tmpl.gray.gray[i];
    grayTotal += dg*dg;
    const ri = i*3;
    const dr = cropRgb.rgb[ri] - tmpl.rgb.rgb[ri];
    const dgg = cropRgb.rgb[ri+1] - tmpl.rgb.rgb[ri+1];
    const db = cropRgb.rgb[ri+2] - tmpl.rgb.rgb[ri+2];
    rgbTotal += dr*dr + dgg*dgg + db*db;
  }
  if (count === 0) return { grayMse: Infinity, rgbMse: Infinity, phaseScore: Infinity };
  const grayMse = grayTotal/count, rgbMse = rgbTotal/(count*3);
  return { grayMse, rgbMse, phaseScore: combinePhaseScore(grayMse, rgbMse) };
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(SCREENSHOT_PATH)) {
    console.error(`ERROR: ${SCREENSHOT_PATH} not found`);
    process.exit(1);
  }
  if (!fs.existsSync(CALIBRATION_PATH)) {
    console.error(`ERROR: calibration.json not found at ${CALIBRATION_PATH}`);
    process.exit(1);
  }

  const calibration = JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf8'));
  const normal = calibration.slots;
  // Dream geometry (matches slot_detector.detectSlots).
  const ratio = (normal.dreamSlotRatio && (normal.dreamSlotRatio.width !== 1 || normal.dreamSlotRatio.height !== 1))
    ? normal.dreamSlotRatio : DEFAULT_DREAM_RATIO;
  const xOff  = typeof normal.dreamXOffset === 'number' ? normal.dreamXOffset : DEFAULT_DREAM_X_OFFSET;
  const dream = {
    ...normal,
    slotXPositions: normal.slotXPositions.map(x => x + xOff),
    slotWidth:  Math.max(1, Math.round(normal.slotWidth  * ratio.width)),
    slotHeight: Math.max(1, Math.round(normal.slotHeight * ratio.height))
  };

  const ssImg = decodePng(SCREENSHOT_PATH);
  const { data: ssRgba, width: ssW, height: ssH } = ssImg;
  console.log(`Screenshot: ${ssW}x${ssH}`);

  const sx = ssW / dream.baseScreenWidth, sy = ssH / dream.baseScreenHeight;
  const slotRect = {
    x: Math.round(dream.slotXPositions[SLOT_INDEX] * sx),
    y: Math.round(dream.slotY * sy),
    width:  Math.max(1, Math.round(dream.slotWidth  * sx)),
    height: Math.max(1, Math.round(dream.slotHeight * sy))
  };
  console.log(`Slot ${SLOT_INDEX+1} dream rect: x=${slotRect.x} y=${slotRect.y} ${slotRect.width}x${slotRect.height}`);

  // Locate the 5 phase templates.
  const dreamRoot = path.join(IMAGES_DIR, 'seasonal');
  const target = normalizeCardName(DREAM_CARD);
  const phaseTemplates = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.toLowerCase().endsWith('.png')) {
        const m = path.basename(e.name, '.png').match(/^(.*?)(\d+)$/u);
        if (!m) continue;
        const baseName = normalizeCardName(m[1]);
        if (baseName !== target) continue;
        phaseTemplates.push({ phase: parseInt(m[2], 10), filePath: f, baseName });
      }
    }
  }
  walk(dreamRoot);
  phaseTemplates.sort((a, b) => a.phase - b.phase);
  console.log(`Phase templates for "${DREAM_CARD}": ${phaseTemplates.length}`);
  for (const t of phaseTemplates) console.log(`  P${t.phase}: ${path.relative(ROOT, t.filePath)}`);
  if (phaseTemplates.length < 2) {
    console.error('Need at least 2 phase templates to score discriminantly.');
    process.exit(1);
  }

  // Resize each template to slot dim and convert.
  const dstW = slotRect.width, dstH = slotRect.height;
  const phaseData = phaseTemplates.map(t => {
    const img = decodePng(t.filePath);
    const r = resizeRgba(img.data, img.width, img.height, dstW, dstH);
    const { gray, rgb } = rgbaToGrayRgb(r, dstW, dstH);
    return { ...t, gray, rgb };
  });

  // Build discriminant mask.
  const maskInfo = buildDreamPhaseDiscriminantMask(phaseData, dstW, dstH);
  console.log(`Phase discriminant mask: mode=${maskInfo.mode}  pixelCount=${maskInfo.pixelCount}`);

  // Crop screenshot at slot rect.
  const cropRgba = cropAndResize(ssRgba, ssW, ssH, slotRect.x, slotRect.y, slotRect.width, slotRect.height, dstW, dstH);
  const { gray: cropGray, rgb: cropRgb } = rgbaToGrayRgb(cropRgba, dstW, dstH);

  // Crop's chromatic profile — RGB averages over the same regions used by
  // the runtime resolveDreamPhase. Alignment-invariant.
  const cropChromatic = DREAM_PHASE_CHROMATIC_REGIONS.map((region) =>
    computeRegionAverageRgb(cropRgb, null, dstW, dstH, region)
  );

  // Score each phase: full-card primary metric, phase-mask metric, and the
  // chromatic-strip distance (top + desc).
  console.log(`\nPer-phase scoring (slot ${SLOT_INDEX+1} vs ${DREAM_CARD}):`);
  const fullScores = phaseData.map(p => {
    const m = compareImages(cropGray, cropRgb, p.gray, p.rgb, STABLE_REGIONS, null);
    return { phase: p.phase, ...m };
  });
  const phaseScores = phaseData.map(p => {
    const s = maskInfo.mask
      ? scoreMaskedDreamPhase(cropGray, cropRgb, { gray: p.gray, rgb: p.rgb }, maskInfo.mask)
      : (() => {
          const m = compareImages(cropGray, cropRgb, p.gray, p.rgb, DREAM_PHASE_FALLBACK_REGIONS, null);
          return { grayMse: m.grayMse, rgbMse: m.rgbMse, phaseScore: combinePhaseScore(m.grayMse, m.rgbMse) };
        })();
    return { phase: p.phase, ...s };
  });
  const chromaticScores = phaseData.map(p => {
    const tmplAvgs = DREAM_PHASE_CHROMATIC_REGIONS.map((region) =>
      computeRegionAverageRgb(p.rgb, null, dstW, dstH, region)
    );
    const total = chromaticRegionsDistance(cropChromatic, tmplAvgs);
    return { phase: p.phase, regionAvgs: tmplAvgs, total };
  });

  const fullWinner      = [...fullScores].sort     ((a,b) => a[DEFAULT_METRIC] - b[DEFAULT_METRIC])[0];
  const phaseWinner     = [...phaseScores].sort    ((a,b) => a.phaseScore - b.phaseScore)[0];
  const chromaticWinner = [...chromaticScores].sort((a,b) => a.total - b.total)[0];

  console.log(`\nFull-card primary metric (${DEFAULT_METRIC}, lower-is-better):`);
  for (const f of fullScores) {
    const w = f.phase === fullWinner.phase ? '*' : ' ';
    console.log(`  ${w} P${f.phase}  rgbMse=${f.rgbMse.toFixed(1).padStart(8)}  ssim=${f.ssim.toFixed(3)}  ncc=${f.ncc.toFixed(3)}  grayMse=${f.grayMse.toFixed(1)}`);
  }
  console.log(`\nPhase-mask scoring (combined gray*0.65 + rgb*0.35, lower-is-better):`);
  for (const p of phaseScores) {
    const w = p.phase === phaseWinner.phase ? '*' : ' ';
    console.log(`  ${w} P${p.phase}  phaseScore=${p.phaseScore.toFixed(1).padStart(8)}  grayMse=${p.grayMse.toFixed(1)}  rgbMse=${p.rgbMse.toFixed(1)}`);
  }
  console.log(`\nChromatic region distance (sum of euclidean RGB over ${DREAM_PHASE_CHROMATIC_REGIONS.length} regions, lower-is-better):`);
  for (const c of chromaticScores) {
    const w = c.phase === chromaticWinner.phase ? '*' : ' ';
    console.log(`  ${w} P${c.phase}  total=${c.total.toFixed(2).padStart(7)}`);
  }

  // Rank-weighted combination (chromatic 0.8, mask 0.2) — what the runtime
  // resolveDreamPhase will pick.
  const byMask = [...phaseScores].sort((a,b) =>
    a.phaseScore !== b.phaseScore ? a.phaseScore - b.phaseScore : a.phase - b.phase
  );
  const byChromatic = [...chromaticScores].sort((a,b) =>
    a.total !== b.total ? a.total - b.total : a.phase - b.phase
  );
  const rankByPhase = new Map();
  for (const p of phaseData) rankByPhase.set(p.phase, { mask: 0, chrom: 0 });
  byMask.forEach     ((c,i) => rankByPhase.get(c.phase).mask  = i + 1);
  byChromatic.forEach((c,i) => rankByPhase.get(c.phase).chrom = i + 1);

  const combinedRanks = phaseData.map(p => {
    const r = rankByPhase.get(p.phase);
    return { phase: p.phase, mask: r.mask, chrom: r.chrom,
             combined: (DREAM_PHASE_CHROMATIC_RANK_W * r.chrom) + (DREAM_PHASE_MASK_RANK_W * r.mask) };
  }).sort((a,b) => a.combined !== b.combined ? a.combined - b.combined : a.phase - b.phase);

  console.log(`\nRank-weighted combination (chromatic*${DREAM_PHASE_CHROMATIC_RANK_W} + mask*${DREAM_PHASE_MASK_RANK_W}, lower-is-better):`);
  const combinedWinner = combinedRanks[0];
  for (const r of combinedRanks) {
    const w = r.phase === combinedWinner.phase ? '*' : ' ';
    console.log(`  ${w} P${r.phase}  combinedRank=${r.combined.toFixed(2)}  chromRank=${r.chrom}  maskRank=${r.mask}`);
  }
  console.log(`\nWinners — full:P${fullWinner.phase}  mask:P${phaseWinner.phase}  chromatic:P${chromaticWinner.phase}  combined:P${combinedWinner.phase}`);

  // Annotated PNG.
  const out = new Uint8Array(ssW * ssH * 4);
  for (let i = 0; i < ssW * ssH; i++) {
    out[i*4]   = ssRgba[i*4];
    out[i*4+1] = ssRgba[i*4+1];
    out[i*4+2] = ssRgba[i*4+2];
    out[i*4+3] = 255;
  }
  // Slot rect.
  drawRect(out, ssW, ssH, slotRect.x, slotRect.y, slotRect.width, slotRect.height, 255, 80, 80, 3);
  // Mark mask pixels with green tint over the slot.
  if (maskInfo.mask) {
    for (let dy = 0; dy < dstH; dy++) {
      for (let dx = 0; dx < dstW; dx++) {
        if (maskInfo.mask[dy*dstW+dx] === 0) continue;
        const sx = slotRect.x + Math.round(dx * (slotRect.width  / dstW));
        const sy = slotRect.y + Math.round(dy * (slotRect.height / dstH));
        if (sx < 0 || sx >= ssW || sy < 0 || sy >= ssH) continue;
        const o = (sy*ssW + sx) * 4;
        out[o]   = Math.min(255, out[o]   * 0.4 + 0);
        out[o+1] = Math.min(255, out[o+1] * 0.4 + 200);
        out[o+2] = Math.min(255, out[o+2] * 0.4 + 0);
      }
    }
  }
  // Stack score labels next to the slot — combined-rank winner is the one
  // the runtime will pick.
  const labelX = slotRect.x + slotRect.width + 6;
  let labelY = slotRect.y;
  drawTextBg(out, ssW, ssH, `${DREAM_CARD}`, labelX, labelY, 2); labelY += 22;
  for (const r of combinedRanks) {
    const tag = r.phase === combinedWinner.phase ? '*' : ' ';
    drawTextBg(out, ssW, ssH, `${tag}P${r.phase} R${r.combined.toFixed(1)}`, labelX, labelY, 2);
    labelY += 22;
  }

  const outPath = path.join(__dirname, 'board_phase_diagnosed.png');
  fs.writeFileSync(outPath, encodePng(out, ssW, ssH));
  console.log(`\nWrote ${path.relative(process.cwd(), outPath)}`);
}

main();
