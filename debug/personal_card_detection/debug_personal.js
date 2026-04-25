#!/usr/bin/env node
/**
 * debug_personal.js
 *
 * Reproduces slot_detector.detectSlots' candidate-by-candidate scoring against
 * a saved game screenshot, then dumps every candidate's score per slot. Use
 * this to diagnose cases where the live overlay picks the wrong card — most
 * importantly when a personal (talent-granted) card loses to a non-personal
 * competitor.
 *
 * Setup:
 *   1. Save your game screenshot as `board.png` next to this file
 *      (PNG only — convert WebP first; see the WIC one-liner in the repo
 *      history if needed).
 *   2. Either copy your `calibration.json` from
 *        %APPDATA%\yixian-overlay\calibration.json
 *      to this folder, or leave it where it is — the script will fall back
 *      automatically.
 *   3. Edit HAND_CARDS below to match the cards visible in your screenshot
 *      (just the names, in any order). Personal/talent-granted card names
 *      go in the same list — the script will look them up under the
 *      `personal/` template path.
 *   4. Run with plain Node from the repo root:
 *        node debug/personal_card_detection/debug_personal.js
 *
 * Output:
 *   - Console: for each of the 8 slots, the top candidates ranked by the
 *     active metric (rgbMse by default, lower is better) with all metrics
 *     printed so you can see what's beating what.
 *   - PNG: `board_diagnosed.png` next to this file. Per slot it draws three
 *     thin dashed rects (orange=normal, purple=dream, green=personal) plus a
 *     thick red rect for the winning candidate, labeled with name + score.
 *
 * What to look for if a personal card is misidentified:
 *   - Does the green dashed rect line up with the personal card on screen?
 *     (If not → personal-geometry offsets aren't right for this character.)
 *   - Is the personal template even in the candidate list at the top of the
 *     console output? (If not → the talent's nameCn isn't in HAND_CARDS, or
 *     the template path can't be found by name lookup.)
 *   - When personal IS a candidate, what's its score vs the winner's?
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { decodePng } = require(path.join(ROOT, 'calibrator'));
const { encodePng, drawRect, drawTextBg } = require(path.join(ROOT, 'calibration_debug_draw'));
const {
  loadBaselineMasks,
  getMaskKeyForTemplate,
  resizeMaskNN
} = require(path.join(ROOT, 'detection_masks'));

// ── EDIT THESE ──────────────────────────────────────────────────────────────

const SCREENSHOT_PATH = path.join(__dirname, 'board.png');

const HAND_CARDS = [
  '木灵•桃花印',  // slot 1: personal card from HuaQinrui (the failing case)
  '火灵•窜',
  '木灵•芽',
  '五行刺'
];

// ── Resolve calibration ─────────────────────────────────────────────────────

const CALIBRATION_PATH = (() => {
  const local = path.join(__dirname, 'calibration.json');
  if (fs.existsSync(local)) return local;
  const userData = path.join(process.env.APPDATA || '', 'yixian-overlay', 'calibration.json');
  if (fs.existsSync(userData)) return userData;
  return local;
})();

// ── Config + constants mirrored from slot_detector ──────────────────────────

const IMAGES_DIR  = path.join(ROOT, 'images');
const CONFIG_PATH = path.join(ROOT, 'slot_detector_config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const STABLE_REGIONS = config.stableRegions;
const DEFAULT_METRIC = config.defaultMetric;

const PERSONAL_BORDER_INSET     = 0.10;
const DEFAULT_DREAM_RATIO       = { width: 0.925, height: 0.977 };
const DEFAULT_DREAM_X_OFFSET    = 8;

// Per-character personal-card geometry. FengXu's personal cards render larger
// and shifted; everyone else's are at normal-card geometry (no shift, no scale).
const PERSONAL_GEO_OVERRIDES = {
  FengXu: {
    ratio:   { width: 1.104, height: 1.102 },
    xOffset: -10,
    yOffset: -16
  }
};
const PERSONAL_GEO_DEFAULT = { ratio: { width: 1, height: 1 }, xOffset: 0, yOffset: 0 };

// ── Name + path helpers (mirror slot_detector) ──────────────────────────────

function normalizeCardName(name) {
  return (name || '').replace(/[·•]/g, '•').trim();
}
function isDreamCardName(name)         { return normalizeCardName(name).startsWith('梦'); }
function isPersonalTemplatePath(p)     { return p.includes(`${path.sep}personal${path.sep}`); }
function isSeasonalTemplatePath(p)     { return p.includes(`${path.sep}seasonal${path.sep}`); }

function walkDir(dir) {
  let res = [];
  if (!fs.existsSync(dir)) return res;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) res = res.concat(walkDir(f));
    else if (e.name.toLowerCase().endsWith('.png')) res.push(f);
  }
  return res;
}

function parseTemplateFilename(filePath) {
  const fileName = path.basename(filePath, '.png');
  const m = fileName.match(/^(.*?)(\d+)$/u);
  if (!m) return null;
  const baseName  = normalizeCardName(m[1]);
  const suffix    = parseInt(m[2], 10);
  const isDream   = isDreamCardName(baseName);
  const personalMatch = filePath.match(/[\\/]personal[\\/]([^\\/]+)[\\/]/);
  const personalCharacter = personalMatch ? personalMatch[1] : null;
  return {
    baseName,
    level:      isDream ? 1 : suffix,
    phase:      isDream ? suffix : null,
    isDream,
    isPersonal: isPersonalTemplatePath(filePath),
    isSeasonal: isSeasonalTemplatePath(filePath),
    personalCharacter,
    filePath,
    fileName:   path.basename(filePath)
  };
}

// ── Pure-Node image primitives (no Electron nativeImage) ────────────────────

function rgbaToGrayRgb(rgba, w, h) {
  const gray = new Float32Array(w * h);
  const rgb  = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i*4], g = rgba[i*4+1], b = rgba[i*4+2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    rgb[i*3] = r; rgb[i*3+1] = g; rgb[i*3+2] = b;
  }
  return {
    gray: { gray, width: w, height: h },
    rgb:  { rgb,  width: w, height: h }
  };
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
        out[di+c] = Math.round(
          (1-wx)*(1-wy)*v00 + wx*(1-wy)*v01 +
          (1-wx)*wy*v10     + wx*wy*v11
        );
      }
    }
  }
  return out;
}

// Crop sub-region with zero-fill on out-of-bounds, then bilinear-resize to dst.
function cropAndResize(srcRgba, srcW, srcH, x, y, w, h, dstW, dstH) {
  const sub = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const sx = x + i, sy = y + j;
      const di = (j * w + i) * 4;
      if (sx >= 0 && sx < srcW && sy >= 0 && sy < srcH) {
        const si = (sy * srcW + sx) * 4;
        sub[di]   = srcRgba[si];
        sub[di+1] = srcRgba[si+1];
        sub[di+2] = srcRgba[si+2];
        sub[di+3] = srcRgba[si+3];
      }
    }
  }
  return resizeRgba(sub, w, h, dstW, dstH);
}

// ── Comparison primitives mirrored from slot_detector ───────────────────────

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
  let sumA = 0, sumB = 0, grayMse = 0, count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      if (mask && mask[i] === 0) continue;
      count++;
      const d = grayA.gray[i] - grayB.gray[i];
      sumA += grayA.gray[i]; sumB += grayB.gray[i]; grayMse += d * d;
    }
  }
  if (count === 0) return { ssim: 0, ncc: 0, grayMse: Infinity };
  const meanA = sumA / count, meanB = sumB / count;
  let varA = 0, varB = 0, cov = 0, num = 0, denA = 0, denB = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      if (mask && mask[i] === 0) continue;
      const a = grayA.gray[i] - meanA, b = grayB.gray[i] - meanB;
      varA += a*a; varB += b*b; cov += a*b;
      num  += grayA.gray[i] * grayB.gray[i];
      denA += grayA.gray[i] * grayA.gray[i];
      denB += grayB.gray[i] * grayB.gray[i];
    }
  }
  const div = Math.max(1, count - 1);
  varA /= div; varB /= div; cov /= div;
  const c1 = 6.5025, c2 = 58.5225;
  const ssimNum = ((2*meanA*meanB) + c1) * ((2*cov) + c2);
  const ssimDen = ((meanA*meanA) + (meanB*meanB) + c1) * (varA + varB + c2);
  const ssim = ssimDen === 0 ? 0 : ssimNum / ssimDen;
  const nccDen = Math.sqrt(denA * denB);
  const ncc = nccDen === 0 ? 0 : num / nccDen;
  return { ssim, ncc, grayMse: grayMse / count };
}

function regionRgbMse(rgbA, rgbB, region, mask) {
  const { width } = rgbA;
  const { x0, y0, x1, y1 } = getRegionBounds(rgbA.width, rgbA.height, region);
  let total = 0, count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const px = y * width + x;
      if (mask && mask[px] === 0) continue;
      count++;
      const i = px * 3;
      const dr = rgbA.rgb[i]   - rgbB.rgb[i];
      const dg = rgbA.rgb[i+1] - rgbB.rgb[i+1];
      const db = rgbA.rgb[i+2] - rgbB.rgb[i+2];
      total += dr*dr + dg*dg + db*db;
    }
  }
  return count === 0 ? Infinity : total / (count * 3);
}

function compareImages(grayA, rgbA, grayB, rgbB, regions, mask) {
  let wssim = 0, wncc = 0, wgrayMse = 0, wrgbMse = 0, totalW = 0;
  for (const r of regions) {
    const { ssim, ncc, grayMse } = regionStats(grayA, grayB, r, mask);
    const rgbMse = regionRgbMse(rgbA, rgbB, r, mask);
    wssim += ssim * r.weight;
    wncc  += ncc  * r.weight;
    wgrayMse += grayMse * r.weight;
    wrgbMse  += rgbMse  * r.weight;
    totalW += r.weight;
  }
  if (totalW === 0) return { ssim: 0, ncc: 0, grayMse: Infinity, rgbMse: Infinity };
  return {
    ssim: wssim / totalW, ncc: wncc / totalW,
    grayMse: wgrayMse / totalW, rgbMse: wrgbMse / totalW
  };
}

function insetRegions(regs, inset) {
  const out = [];
  for (const r of regs) {
    const x0 = Math.max(r.x, inset);
    const y0 = Math.max(r.y, inset);
    const x1 = Math.min(r.x + r.width,  1 - inset);
    const y1 = Math.min(r.y + r.height, 1 - inset);
    if (x1 > x0 && y1 > y0) out.push({ ...r, x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  return out;
}
const PERSONAL_REGIONS = insetRegions(STABLE_REGIONS, PERSONAL_BORDER_INSET);

// ── Geometry (mirror slot_detector.detectSlots) ─────────────────────────────

function makeDreamGeo(g) {
  const ratio = (g.dreamSlotRatio && (g.dreamSlotRatio.width !== 1 || g.dreamSlotRatio.height !== 1))
    ? g.dreamSlotRatio
    : DEFAULT_DREAM_RATIO;
  const xOffset = typeof g.dreamXOffset === 'number' ? g.dreamXOffset : DEFAULT_DREAM_X_OFFSET;
  return {
    ...g,
    slotXPositions: g.slotXPositions.map(x => x + xOffset),
    slotWidth:  Math.max(1, Math.round(g.slotWidth  * ratio.width)),
    slotHeight: Math.max(1, Math.round(g.slotHeight * ratio.height))
  };
}

function makePersonalGeo(g, charName) {
  const cfg = PERSONAL_GEO_OVERRIDES[charName] || PERSONAL_GEO_DEFAULT;
  if (cfg === PERSONAL_GEO_DEFAULT) return g;
  return {
    ...g,
    slotXPositions: g.slotXPositions.map(x => x + cfg.xOffset),
    slotY:      g.slotY + cfg.yOffset,
    slotWidth:  Math.max(1, Math.round(g.slotWidth  * cfg.ratio.width)),
    slotHeight: Math.max(1, Math.round(g.slotHeight * cfg.ratio.height))
  };
}

function scaleRect(slotIdx, geom, srcW, srcH) {
  const sx = srcW / geom.baseScreenWidth;
  const sy = srcH / geom.baseScreenHeight;
  return {
    x: Math.round(geom.slotXPositions[slotIdx] * sx),
    y: Math.round(geom.slotY * sy),
    width:  Math.max(1, Math.round(geom.slotWidth  * sx)),
    height: Math.max(1, Math.round(geom.slotHeight * sy))
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(SCREENSHOT_PATH)) {
    console.error(`ERROR: ${SCREENSHOT_PATH} not found.`);
    console.error('Save your game screenshot as `board.png` next to this script.');
    process.exit(1);
  }
  if (!fs.existsSync(CALIBRATION_PATH)) {
    console.error(`ERROR: calibration.json not found at ${CALIBRATION_PATH}.`);
    console.error('Either copy %APPDATA%\\yixian-overlay\\calibration.json next to this script,');
    console.error('or run the live app once with successful Calibration to generate it.');
    process.exit(1);
  }

  const calibration = JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf8'));
  const normalGeo   = calibration.slots;
  const dreamGeo    = makeDreamGeo(normalGeo);
  // Personal geometry is per-character; build lazily for any character that
  // appears in the candidate pool.
  const personalGeoByChar = new Map();
  function getPersonalGeo(charName) {
    const key = charName || '';
    if (!personalGeoByChar.has(key)) personalGeoByChar.set(key, makePersonalGeo(normalGeo, key));
    return personalGeoByChar.get(key);
  }
  console.log(`Calibration: ${CALIBRATION_PATH}`);
  console.log(`  base ${normalGeo.baseScreenWidth}x${normalGeo.baseScreenHeight}  slotY=${normalGeo.slotY}  ${normalGeo.slotWidth}x${normalGeo.slotHeight}`);
  console.log(`  normal   xs=[${normalGeo.slotXPositions.join(',')}]`);

  const ssImg = decodePng(SCREENSHOT_PATH);
  const { data: ssRgba, width: ssW, height: ssH } = ssImg;
  console.log(`Screenshot: ${SCREENSHOT_PATH} (${ssW}x${ssH})`);

  const baselineMasks = loadBaselineMasks(IMAGES_DIR);

  // Walk the image dir, build a name → templates index.
  const tmplFiles = walkDir(IMAGES_DIR);
  const tmplIndex = new Map();
  for (const f of tmplFiles) {
    const parsed = parseTemplateFilename(f);
    if (!parsed) continue;
    if (!tmplIndex.has(parsed.baseName)) tmplIndex.set(parsed.baseName, []);
    tmplIndex.get(parsed.baseName).push(parsed);
  }

  // Collect candidates exactly the way slot_detector does (incl. personal rail).
  const candidates = [];
  const seen = new Set();
  for (const name of HAND_CARDS) {
    const norm = normalizeCardName(name);
    const isDream = isDreamCardName(norm);
    const stripped = norm.replace(/\d+$/, '');
    const variants = [norm, stripped]
      .flatMap(k => tmplIndex.get(k) || [])
      .filter(t => isDream ? (t.isDream && t.isSeasonal) : !t.isDream);
    for (const v of variants) {
      if (seen.has(v.filePath)) continue;
      seen.add(v.filePath);
      candidates.push(v);
    }
  }
  const personalNames = new Set(candidates.filter(c => c.isPersonal).map(c => c.baseName));
  const finalCandidates = candidates.filter(c => c.isPersonal || !personalNames.has(c.baseName));

  console.log(`\nCandidates (${finalCandidates.length}):`);
  for (const c of finalCandidates) {
    console.log(`  [${c.isPersonal ? 'P' : c.isDream ? 'D' : 'N'}] L${c.level} ${c.baseName.padEnd(12)} ← ${path.relative(ROOT, c.filePath)}`);
  }

  // Output canvas (opaque copy of screenshot).
  const out = new Uint8Array(ssW * ssH * 4);
  for (let i = 0; i < ssW * ssH; i++) {
    out[i*4]   = ssRgba[i*4];
    out[i*4+1] = ssRgba[i*4+1];
    out[i*4+2] = ssRgba[i*4+2];
    out[i*4+3] = 255;
  }

  const metricDef = config.metrics[DEFAULT_METRIC];

  for (let slot = 0; slot < 8; slot++) {
    console.log(`\n=== Slot ${slot + 1} ===`);

    const normalRect = scaleRect(slot, normalGeo, ssW, ssH);
    const dreamRect  = scaleRect(slot, dreamGeo,  ssW, ssH);
    // For per-slot debug, find the personal rect from the first personal
    // candidate's character (only used for the dashed-rect drawing).
    const personalCharForRect =
      finalCandidates.find((c) => c.isPersonal)?.personalCharacter || null;
    const personalGeoForRect = getPersonalGeo(personalCharForRect);
    const personalRect = personalGeoForRect === normalGeo
      ? null
      : scaleRect(slot, personalGeoForRect, ssW, ssH);

    const scored = [];
    for (const c of finalCandidates) {
      const personalGeoForCard = c.isPersonal ? getPersonalGeo(c.personalCharacter) : null;
      const geom = c.isDream ? dreamGeo : (c.isPersonal ? personalGeoForCard : normalGeo);
      const rect = scaleRect(slot, geom, ssW, ssH);
      const dstW = rect.width, dstH = rect.height;

      const cropRgba = cropAndResize(ssRgba, ssW, ssH, rect.x, rect.y, rect.width, rect.height, dstW, dstH);
      const { gray: cropGray, rgb: cropRgb } = rgbaToGrayRgb(cropRgba, dstW, dstH);

      let tmplImg;
      try { tmplImg = decodePng(c.filePath); } catch { continue; }
      const tmplResized = resizeRgba(tmplImg.data, tmplImg.width, tmplImg.height, dstW, dstH);
      const { gray: tmplGray, rgb: tmplRgb } = rgbaToGrayRgb(tmplResized, dstW, dstH);

      let mask = null;
      const maskKey = getMaskKeyForTemplate(c.filePath, c.level);
      if (maskKey) {
        const baseline = baselineMasks[maskKey];
        if (baseline) mask = resizeMaskNN(baseline.mask, baseline.width, baseline.height, dstW, dstH);
      }

      const regions = (c.isPersonal && personalGeoForCard && personalGeoForCard !== normalGeo)
        ? PERSONAL_REGIONS
        : STABLE_REGIONS;
      const m = compareImages(cropGray, cropRgb, tmplGray, tmplRgb, regions, mask);

      scored.push({
        kind:  c.isPersonal ? 'P' : c.isDream ? 'D' : 'N',
        name:  c.baseName,
        level: c.level,
        rect,
        score: m[DEFAULT_METRIC],
        metrics: m,
        fileName: c.fileName
      });
    }

    scored.sort((a, b) => metricDef.higherIsBetter
      ? (b.score - a.score)
      : (a.score - b.score));

    if (scored.length === 0) {
      console.log('  (no candidates)');
      continue;
    }

    console.log(`  Top candidates (${DEFAULT_METRIC}, ${metricDef.higherIsBetter ? 'higher' : 'lower'}-is-better):`);
    for (let i = 0; i < Math.min(8, scored.length); i++) {
      const s = scored[i];
      const winner = i === 0 ? '*' : ' ';
      console.log(
        `   ${winner} [${s.kind}] L${s.level} ${s.name.padEnd(12)} ` +
        `${DEFAULT_METRIC}=${String(s.score.toFixed(1)).padStart(8)}  ` +
        `ssim=${s.metrics.ssim.toFixed(3)} ncc=${s.metrics.ncc.toFixed(3)} ` +
        `grayMse=${s.metrics.grayMse.toFixed(1)} rgbMse=${s.metrics.rgbMse.toFixed(1)}`
      );
    }

    // Draw the three geometry rects (always) and the winner (thick red).
    drawRect(out, ssW, ssH, normalRect.x, normalRect.y, normalRect.width, normalRect.height, 255, 170, 0,   1);
    drawRect(out, ssW, ssH, dreamRect.x,  dreamRect.y,  dreamRect.width,  dreamRect.height,  180, 120, 255, 1);
    if (personalRect) {
      drawRect(out, ssW, ssH, personalRect.x, personalRect.y, personalRect.width, personalRect.height, 0, 220, 100, 1);
    }

    const w = scored[0];
    drawRect(out, ssW, ssH, w.rect.x, w.rect.y, w.rect.width, w.rect.height, 255, 80, 80, 3);
    drawTextBg(out, ssW, ssH, `S${slot + 1} ${w.name} ${w.kind}`, w.rect.x + 4, w.rect.y + 4, 2);
    drawTextBg(out, ssW, ssH, `${DEFAULT_METRIC}=${w.score.toFixed(0)}`,                w.rect.x + 4, w.rect.y + 26, 2);
  }

  const outPath = path.join(__dirname, 'board_diagnosed.png');
  fs.writeFileSync(outPath, encodePng(out, ssW, ssH));
  console.log(`\nWrote ${path.relative(process.cwd(), outPath)}`);
}

main();
