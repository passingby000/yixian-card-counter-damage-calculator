const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');
const { getCodePath } = require('./runtime_paths');
const { getNativeImagePixelSize } = require('./native_image_pixels');
const { computeLayoutTransform } = require('./rect_scale');
const {
  loadBaselineMasks,
  getMaskKeyForTemplate,
  resizeMaskNN
} = require('./detection_masks');

// Dream cards occupy a slightly smaller region that is shifted right relative to
// the normal slot anchor.  Values confirmed by grid-search debug across 8 slots:
//   xOffset ~+8 px (in calibration physical-pixel space)
//   width  ratio ~0.925  (196 / 212)
//   height ratio ~0.977  (335 / 343)
// These defaults are used when calibration was done before dream geometry was stored.
const DEFAULT_DREAM_RATIO = { width: 0.925, height: 0.977 };
const DEFAULT_DREAM_X_OFFSET = 8;  // pixels in calibration coordinate space

// Personal (talent-granted) cards appear larger than normal cards and shifted
// relative to the normal slot anchor.  Values confirmed by grid-search on
// fengxuround2.png (阴符玉简 in slot 1):
//   xOffset  ~ -10 px  (left of normal anchor)
//   yOffset  ~ -16 px  (above normal anchor)
//   width  ratio ~ 1.104  (234 / 212)
//   height ratio ~ 1.102  (378 / 343)
const DEFAULT_PERSONAL_RATIO    = { width: 1.104, height: 1.102 };
const DEFAULT_PERSONAL_X_OFFSET = -10;  // pixels in calibration coordinate space
const DEFAULT_PERSONAL_Y_OFFSET = -16;  // pixels in calibration coordinate space

const CONFIG_PATH = getCodePath('slot_detector_config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const STABLE_REGIONS = config.stableRegions;
const DEFAULT_METRIC = config.defaultMetric;
const NUM_SLOTS = 8;

// Calibration override — set via setCalibration() from main process
let activeCalibration = null;

function setCalibration(data) {
  activeCalibration = data || null;
}

// Returns the effective geometry from calibration, or null if not yet calibrated
function getActiveGeometry() {
  const s = activeCalibration?.slots;
  if (!s) return null;
  return {
    baseScreenWidth:  s.baseScreenWidth,
    baseScreenHeight: s.baseScreenHeight,
    slotXPositions:   s.slotXPositions,
    slotY:            s.slotY,
    slotWidth:        s.slotWidth,
    slotHeight:       s.slotHeight,
    dreamSlotRatio:   s.dreamSlotRatio || null,
    dreamXOffset:     typeof s.dreamXOffset === 'number' ? s.dreamXOffset : null
  };
}

let templateIndexCache = null;

const CARD_NAME_ALIASES = {
  '梦•凝意决': '梦•凝意诀'
};

function normalizeCardName(name) {
  const normalized = (name || '').replace(/[·•]/g, '•').trim();
  return CARD_NAME_ALIASES[normalized] || normalized;
}

function isDreamCardName(name) {
  return normalizeCardName(name).startsWith('梦');
}

function isSeasonalTemplatePath(filePath) {
  const seasonalSegment = `${path.sep}seasonal${path.sep}`;
  return filePath.includes(seasonalSegment);
}

function isPersonalTemplatePath(filePath) {
  const personalSegment = `${path.sep}personal${path.sep}`;
  return filePath.includes(personalSegment);
}

function getTemplatePreferenceScore(filePath) {
  const fileName = path.basename(filePath);
  let score = 0;
  if (isSeasonalTemplatePath(filePath)) score += 10;
  if (fileName.includes('•')) score += 2;
  if (!fileName.includes('·')) score += 1;
  return score;
}

function walkDir(dirPath) {
  let results = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(walkDir(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) {
      results.push(fullPath);
    }
  }
  return results;
}

function parseTemplateFilename(filePath) {
  const fileName = path.basename(filePath, '.png');
  const match = fileName.match(/^(.*?)(\d+)$/u);
  if (!match) return null;
  const baseName = normalizeCardName(match[1]);
  const suffixNumber = Number.parseInt(match[2], 10);
  const isDream = isDreamCardName(baseName);
  return {
    baseName,
    level: isDream ? 1 : suffixNumber,
    phase: isDream ? suffixNumber : null,
    isDream,
    isSeasonal: isSeasonalTemplatePath(filePath),
    isPersonal: isPersonalTemplatePath(filePath)
  };
}

function imageToGray(image) {
  const bitmap = image.toBitmap();
  const { width, height } = getNativeImagePixelSize(image);
  const gray = new Float32Array(width * height);
  for (let i = 0, px = 0; i < bitmap.length; i += 4, px += 1) {
    const b = bitmap[i];
    const g = bitmap[i + 1];
    const r = bitmap[i + 2];
    gray[px] = (0.114 * b) + (0.587 * g) + (0.299 * r);
  }
  return { gray, width, height };
}

function imageToRgb(image) {
  const bitmap = image.toBitmap();
  const { width, height } = getNativeImagePixelSize(image);
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0, px = 0; i < bitmap.length; i += 4, px += 3) {
    rgb[px] = bitmap[i + 2];
    rgb[px + 1] = bitmap[i + 1];
    rgb[px + 2] = bitmap[i];
  }
  return { rgb, width, height };
}

// Extract and bilinear-resize a rectangular sub-region from a full-image gray array.
// Avoids nativeImage.crop() which returns logical-pixel getSize() but physical toBitmap()
// at DPI > 1, causing stride mismatch in comparison.
function extractSubGray(src, cropX, cropY, cropW, cropH, dstW, dstH) {
  const out = new Float32Array(dstW * dstH);
  const scaleX = cropW / dstW;
  const scaleY = cropH / dstH;
  const SW = src.width, SH = src.height;
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const sx = cropX + dx * scaleX, sy = cropY + dy * scaleY;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, SW - 1), y1 = Math.min(y0 + 1, SH - 1);
      const wx = sx - x0, wy = sy - y0;
      out[dy * dstW + dx] =
        (1 - wx) * (1 - wy) * src.gray[y0 * SW + x0] +
        wx       * (1 - wy) * src.gray[y0 * SW + x1] +
        (1 - wx) * wy       * src.gray[y1 * SW + x0] +
        wx       * wy       * src.gray[y1 * SW + x1];
    }
  }
  return { gray: out, width: dstW, height: dstH };
}

function extractSubRgb(src, cropX, cropY, cropW, cropH, dstW, dstH) {
  const out = new Float32Array(dstW * dstH * 3);
  const scaleX = cropW / dstW;
  const scaleY = cropH / dstH;
  const SW = src.width, SH = src.height;
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const sx = cropX + dx * scaleX, sy = cropY + dy * scaleY;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, SW - 1), y1 = Math.min(y0 + 1, SH - 1);
      const wx = sx - x0, wy = sy - y0;
      const base = (dy * dstW + dx) * 3;
      for (let c = 0; c < 3; c++) {
        out[base + c] =
          (1 - wx) * (1 - wy) * src.rgb[(y0 * SW + x0) * 3 + c] +
          wx       * (1 - wy) * src.rgb[(y0 * SW + x1) * 3 + c] +
          (1 - wx) * wy       * src.rgb[(y1 * SW + x0) * 3 + c] +
          wx       * wy       * src.rgb[(y1 * SW + x1) * 3 + c];
      }
    }
  }
  return { rgb: out, width: dstW, height: dstH };
}

// Fast RGB MSE between a source sub-region and a same-size template.
// Used for dream-card jitter search; avoids the resize and regional weighting
// of compareImages so the sweep stays cheap.
function fastRgbMseDirect(srcRgbData, ox, oy, tw, th, tmplRgb) {
  const SW  = srcRgbData.width;
  const src = srcRgbData.rgb;
  const tpl = tmplRgb.rgb;
  let sum = 0;
  for (let ty = 0; ty < th; ty++) {
    const sRow = ((oy + ty) * SW + ox) * 3;
    const tRow = ty * tw * 3;
    for (let tx = 0; tx < tw; tx++) {
      const sp = sRow + tx * 3;
      const tp = tRow + tx * 3;
      const dr = src[sp]     - tpl[tp];
      const dg = src[sp + 1] - tpl[tp + 1];
      const db = src[sp + 2] - tpl[tp + 2];
      sum += dr * dr + dg * dg + db * db;
    }
  }
  return sum / (tw * th * 3);
}

// Cache template raw data (gray + rgb + optional mask) at a given size.
// File-loaded images don't have DPI scaling so imageToGray/imageToRgb are
// reliable on them. The mask is resized via nearest-neighbour from the baseline
// to preserve the binary 0/1 shape exactly at the target dimensions.
function getTemplateRawData(template, width, height, baselineMasks) {
  const key = `${width}x${height}`;
  if (!template.rawDataCache) template.rawDataCache = new Map();
  if (template.rawDataCache.has(key)) return template.rawDataCache.get(key);
  const img = template.originalImage.resize({ width, height, quality: 'best' });

  let mask = null;
  const baseline = template.maskKey ? (baselineMasks && baselineMasks[template.maskKey]) : null;
  if (baseline) {
    mask = resizeMaskNN(baseline.mask, baseline.width, baseline.height, width, height);
  }

  const data = { gray: imageToGray(img), rgb: imageToRgb(img), mask };
  template.rawDataCache.set(key, data);
  return data;
}

function getRegionBounds(width, height, region) {
  const x0 = Math.max(0, Math.floor(region.x * width));
  const y0 = Math.max(0, Math.floor(region.y * height));
  const x1 = Math.min(width, Math.ceil((region.x + region.width) * width));
  const y1 = Math.min(height, Math.ceil((region.y + region.height) * height));
  return { x0, y0, x1, y1 };
}

function regionStats(grayDataA, grayDataB, region, mask = null) {
  const { width } = grayDataA;
  const { x0, y0, x1, y1 } = getRegionBounds(grayDataA.width, grayDataA.height, region);

  let sumA = 0;
  let sumB = 0;
  let grayMse = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const idx = (y * width) + x;
      if (mask && mask[idx] === 0) continue;
      count += 1;
      const diff = grayDataA.gray[idx] - grayDataB.gray[idx];
      sumA += grayDataA.gray[idx];
      sumB += grayDataB.gray[idx];
      grayMse += diff * diff;
    }
  }

  if (count === 0) {
    return { ssim: 0, ncc: 0, grayMse: Number.POSITIVE_INFINITY };
  }

  const meanA = sumA / count;
  const meanB = sumB / count;
  let varianceA = 0;
  let varianceB = 0;
  let covariance = 0;
  let numerator = 0;
  let denomA = 0;
  let denomB = 0;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const idx = (y * width) + x;
      if (mask && mask[idx] === 0) continue;
      const centeredA = grayDataA.gray[idx] - meanA;
      const centeredB = grayDataB.gray[idx] - meanB;
      varianceA += centeredA * centeredA;
      varianceB += centeredB * centeredB;
      covariance += centeredA * centeredB;
      numerator += grayDataA.gray[idx] * grayDataB.gray[idx];
      denomA += grayDataA.gray[idx] * grayDataA.gray[idx];
      denomB += grayDataB.gray[idx] * grayDataB.gray[idx];
    }
  }

  const divisor = Math.max(1, count - 1);
  varianceA /= divisor;
  varianceB /= divisor;
  covariance /= divisor;

  const c1 = 6.5025;
  const c2 = 58.5225;
  const ssimNumerator = ((2 * meanA * meanB) + c1) * ((2 * covariance) + c2);
  const ssimDenominator = ((meanA * meanA) + (meanB * meanB) + c1) * (varianceA + varianceB + c2);
  const ssim = ssimDenominator === 0 ? 0 : ssimNumerator / ssimDenominator;
  const nccDenominator = Math.sqrt(denomA * denomB);
  const ncc = nccDenominator === 0 ? 0 : numerator / nccDenominator;

  return {
    ssim: Number.isFinite(ssim) ? ssim : 0,
    ncc: Number.isFinite(ncc) ? ncc : 0,
    grayMse: grayMse / count
  };
}

function regionRgbMse(rgbDataA, rgbDataB, region, mask = null) {
  const { width } = rgbDataA;
  const { x0, y0, x1, y1 } = getRegionBounds(rgbDataA.width, rgbDataA.height, region);
  let total = 0;
  let count = 0;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const pixelIdx = (y * width) + x;
      if (mask && mask[pixelIdx] === 0) continue;
      count += 1;
      const idx = pixelIdx * 3;
      const dr = rgbDataA.rgb[idx] - rgbDataB.rgb[idx];
      const dg = rgbDataA.rgb[idx + 1] - rgbDataB.rgb[idx + 1];
      const db = rgbDataA.rgb[idx + 2] - rgbDataB.rgb[idx + 2];
      total += (dr * dr) + (dg * dg) + (db * db);
    }
  }

  if (count === 0) return Number.POSITIVE_INFINITY;
  return total / (count * 3);
}

// Clip all stable regions to exclude a border of `inset` fraction on each side.
// Used for personal cards whose decorative border differs from the template.
const PERSONAL_BORDER_INSET = 0.10;

function insetRegions(regions, inset) {
  const result = [];
  for (const r of regions) {
    const x0 = Math.max(r.x, inset);
    const y0 = Math.max(r.y, inset);
    const x1 = Math.min(r.x + r.width,  1 - inset);
    const y1 = Math.min(r.y + r.height, 1 - inset);
    if (x1 > x0 && y1 > y0) result.push({ ...r, x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  return result;
}

const PERSONAL_REGIONS = insetRegions(STABLE_REGIONS, PERSONAL_BORDER_INSET);

function compareImages(grayA, rgbA, grayB, rgbB, regions = STABLE_REGIONS, mask = null) {
  let weightedSSIM = 0;
  let weightedNCC = 0;
  let weightedGrayMse = 0;
  let weightedRgbMse = 0;
  let totalWeight = 0;

  for (const region of regions) {
    const { ssim, ncc, grayMse } = regionStats(grayA, grayB, region, mask);
    const rgbMse = regionRgbMse(rgbA, rgbB, region, mask);
    weightedSSIM += ssim * region.weight;
    weightedNCC += ncc * region.weight;
    weightedGrayMse += grayMse * region.weight;
    weightedRgbMse += rgbMse * region.weight;
    totalWeight += region.weight;
  }

  if (totalWeight === 0) {
    return {
      ssim: 0,
      ncc: 0,
      grayMse: Number.POSITIVE_INFINITY,
      rgbMse: Number.POSITIVE_INFINITY
    };
  }

  return {
    ssim: weightedSSIM / totalWeight,
    ncc: weightedNCC / totalWeight,
    grayMse: weightedGrayMse / totalWeight,
    rgbMse: weightedRgbMse / totalWeight
  };
}

function getMetricDefinition(metricName) {
  const metric = config.metrics[metricName];
  if (!metric) {
    throw new Error(`Unknown slot detector metric: ${metricName}`);
  }
  return metric;
}

function buildTemplateIndex(imagesDir) {
  if (templateIndexCache) return templateIndexCache;

  const files = walkDir(imagesDir);
  const templatesByCard = new Map();

  for (const filePath of files) {
    const parsed = parseTemplateFilename(filePath);
    if (!parsed) continue;

    const image = nativeImage.createFromPath(filePath);
    if (image.isEmpty()) continue;

    const existing = templatesByCard.get(parsed.baseName) || [];
    const nextTemplate = {
      baseName: parsed.baseName,
      level: parsed.level,
      phase: parsed.phase,
      isDream: parsed.isDream,
      isSeasonal: parsed.isSeasonal,
      isPersonal: parsed.isPersonal,
      maskKey: getMaskKeyForTemplate(filePath, parsed.level),
      filePath,
      fileName: path.basename(filePath),
      originalImage: image,
      resizedImages: new Map()
    };

    if (parsed.isDream) {
      const duplicateIndex = existing.findIndex((template) => (
        template.isDream &&
        template.phase === nextTemplate.phase
      ));
      if (duplicateIndex >= 0) {
        const existingTemplate = existing[duplicateIndex];
        if (getTemplatePreferenceScore(nextTemplate.filePath) > getTemplatePreferenceScore(existingTemplate.filePath)) {
          existing[duplicateIndex] = nextTemplate;
        }
      } else {
        existing.push(nextTemplate);
      }
    } else {
      existing.push(nextTemplate);
    }

    templatesByCard.set(parsed.baseName, existing);
  }

  for (const [cardName, variants] of templatesByCard.entries()) {
    variants.sort((a, b) => {
      const aOrder = a.isDream ? (a.phase ?? 0) : a.level;
      const bOrder = b.isDream ? (b.phase ?? 0) : b.level;
      return aOrder - bOrder;
    });
    templatesByCard.set(cardName, variants);
  }

  templateIndexCache = templatesByCard;
  return templateIndexCache;
}

function getScaledSlotRect(slotIndex, sourceImage) {
  const active = getActiveGeometry();
  if (!active) return null;
  return getScaledSlotRectForGeometry(slotIndex, sourceImage, active);
}

function normalizeGeometry(geometry) {
  const active = getActiveGeometry();
  if (!geometry) {
    if (!active) return null;
    return {
      baseScreenWidth:  active.baseScreenWidth,
      baseScreenHeight: active.baseScreenHeight,
      slotXPositions: [...active.slotXPositions],
      slotY:      active.slotY,
      slotWidth:  active.slotWidth,
      slotHeight: active.slotHeight
    };
  }

  const slotXPositions = Array.isArray(geometry.slotXPositions) && geometry.slotXPositions.length === NUM_SLOTS
    ? geometry.slotXPositions.map((value) => Number(value))
    : active ? [...active.slotXPositions] : null;
  if (!slotXPositions) return null;
  const slotY      = Number.isFinite(Number(geometry.slotY))      ? Number(geometry.slotY)      : active?.slotY;
  const slotWidth  = Number.isFinite(Number(geometry.slotWidth))  ? Number(geometry.slotWidth)  : active?.slotWidth;
  const slotHeight = Number.isFinite(Number(geometry.slotHeight)) ? Number(geometry.slotHeight) : active?.slotHeight;
  const baseScreenWidth  = Number.isFinite(Number(geometry.baseScreenWidth))  ? Number(geometry.baseScreenWidth)  : active?.baseScreenWidth;
  const baseScreenHeight = Number.isFinite(Number(geometry.baseScreenHeight)) ? Number(geometry.baseScreenHeight) : active?.baseScreenHeight;

  return { baseScreenWidth, baseScreenHeight, slotXPositions, slotY, slotWidth, slotHeight };
}

function getScaledSlotRectForGeometry(slotIndex, sourceImage, geometry) {
  const sourceSize = getNativeImagePixelSize(sourceImage);
  const baseScreenWidth = Number(geometry.baseScreenWidth) || sourceSize.width || 1;
  const baseScreenHeight = Number(geometry.baseScreenHeight) || sourceSize.height || 1;
  const transform = computeLayoutTransform(
    { width: baseScreenWidth, height: baseScreenHeight },
    sourceSize
  );
  return {
    x: Math.round(geometry.slotXPositions[slotIndex] * transform.scaleX),
    y: Math.round(geometry.slotY * transform.scaleY),
    width: Math.max(1, Math.round(geometry.slotWidth * transform.sizeScale)),
    height: Math.max(1, Math.round(geometry.slotHeight * transform.sizeScale))
  };
}

function roundMetric(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : value;
}

function buildDebugCandidate(candidate, metricName) {
  if (!candidate) return null;
  return {
    name: candidate.baseName,
    level: candidate.level,
    phase: candidate.phase ?? null,
    isDream: !!candidate.isDream,
    templateFile: candidate.fileName,
    templatePath: candidate.filePath,
    primaryScore: roundMetric(candidate.metrics[metricName]),
    metrics: {
      ssim: roundMetric(candidate.metrics.ssim),
      ncc: roundMetric(candidate.metrics.ncc),
      grayMse: roundMetric(candidate.metrics.grayMse),
      rgbMse: roundMetric(candidate.metrics.rgbMse)
    }
  };
}

function buildDisplayConfidence(bestScore, margin, metric) {
  if (!Number.isFinite(bestScore)) return 0;

  let scoreComponent = 0;
  if (metric.higherIsBetter) {
    scoreComponent = metric.threshold <= 0 ? 1 : Math.max(0, Math.min(1, bestScore / metric.threshold));
  } else {
    if (bestScore <= 0) {
      scoreComponent = 1;
    } else {
      scoreComponent = Math.max(0, Math.min(1, metric.threshold / bestScore));
    }
  }

  // Infinite margin means there is no second candidate — treat as maximum margin confidence.
  const marginComponent = (!Number.isFinite(margin) || metric.margin <= 0)
    ? 1
    : Math.max(0, Math.min(1, margin / (margin + metric.margin)));

  return Number(((scoreComponent + marginComponent) / 2).toFixed(4));
}

function detectSlots(sourceImage, handCardNames, imagesDir, options = {}) {
  if (!sourceImage || sourceImage.isEmpty()) {
    return { slots: Array(NUM_SLOTS).fill(null), slotResults: [], debug: { reason: 'empty-source' } };
  }

  const active = getActiveGeometry();
  if (!active) {
    return { slots: Array(NUM_SLOTS).fill(null), slotResults: [], debug: { reason: 'not-calibrated' } };
  }

  const metricName = options.metric || DEFAULT_METRIC;
  const metric = getMetricDefinition(metricName);
  const normalGeometry = normalizeGeometry(options.geometry);
  const templateIndex = buildTemplateIndex(imagesDir);
  const baselineMasks = loadBaselineMasks(imagesDir);
  const candidateTemplates = [];
  const seenTemplateFiles = new Set();
  // Dream card phases differ only in color grading — grayscale structure is identical
  // across phases. Including all phases causes tiny inter-phase margins that prevent
  // acceptance. Use only the first (highest-preference) template per dream card name.
  const seenDreamCardNames = new Set();

  for (const cardName of handCardNames || []) {
    const normalizedCardName = normalizeCardName(cardName);
    const isDream = isDreamCardName(normalizedCardName);
    const strippedCardName = normalizedCardName.replace(/\d+$/, '');
    const lookupKeys = normalizedCardName !== strippedCardName
      ? [normalizedCardName, strippedCardName]
      : [normalizedCardName];
    const variants = lookupKeys
      .flatMap((key) => templateIndex.get(key) || [])
      .filter((template, idx, arr) => arr.indexOf(template) === idx)
      .filter((template) => {
        if (isDream) return template.isDream && template.isSeasonal;
        return !template.isDream;
      });
    for (const template of variants) {
      if (seenTemplateFiles.has(template.filePath)) continue;
      // For dream cards, only keep one template per card name — phases are colour
      // variants of the same art, so extra phases only steal margin from competitors.
      if (template.isDream) {
        if (seenDreamCardNames.has(template.baseName)) continue;
        seenDreamCardNames.add(template.baseName);
      }
      seenTemplateFiles.add(template.filePath);
      candidateTemplates.push(template);
    }
  }

  // Compute dream geometry: dream cards are slightly narrower/shorter and their
  // top-left anchor is shifted right relative to the normal slot x position.
  // Treat stored ratio of {1,1} as the old placeholder (pre-dream-geometry calibration)
  // and fall back to the code defaults so existing calibrations get the correct geometry
  // without needing a re-calibration.
  const storedRatio = active.dreamSlotRatio;
  const ratio = (storedRatio && (storedRatio.width !== 1 || storedRatio.height !== 1))
    ? storedRatio
    : DEFAULT_DREAM_RATIO;
  const xOffset = typeof active.dreamXOffset === 'number'
    ? active.dreamXOffset
    : DEFAULT_DREAM_X_OFFSET;
  let dreamGeometry = normalGeometry;
  if (normalGeometry) {
    const dw = Math.max(1, Math.round(normalGeometry.slotWidth  * ratio.width));
    const dh = Math.max(1, Math.round(normalGeometry.slotHeight * ratio.height));
    dreamGeometry = {
      ...normalGeometry,
      slotXPositions: normalGeometry.slotXPositions.map((x) => x + xOffset),
      slotWidth:  dw,
      slotHeight: dh
    };
  }

  // Personal (talent-granted) cards appear larger than normal cards and are shifted
  // relative to the normal slot anchor (xOffset=-10, yOffset=-16, ratio ~1.10×).
  let personalGeometry = normalGeometry;
  if (normalGeometry) {
    const pw = Math.max(1, Math.round(normalGeometry.slotWidth  * DEFAULT_PERSONAL_RATIO.width));
    const ph = Math.max(1, Math.round(normalGeometry.slotHeight * DEFAULT_PERSONAL_RATIO.height));
    personalGeometry = {
      ...normalGeometry,
      slotXPositions: normalGeometry.slotXPositions.map((x) => x + DEFAULT_PERSONAL_X_OFFSET),
      slotY:      normalGeometry.slotY + DEFAULT_PERSONAL_Y_OFFSET,
      slotWidth:  pw,
      slotHeight: ph
    };
  }

  if (candidateTemplates.length === 0) {
    return {
      slots: Array(NUM_SLOTS).fill(null),
      slotResults: [],
      debug: { reason: 'no-candidates', metric: metricName }
    };
  }

  // Convert full source image to raw arrays ONCE — bypasses nativeImage.crop() DPI stride mismatch
  // (crop().getSize() returns logical pixels but toBitmap() returns physical on Windows DPI > 1).
  const srcGrayData = imageToGray(sourceImage);
  const srcRgbData  = imageToRgb(sourceImage);

  const normalSlotRects = Array.from({ length: NUM_SLOTS }, (_, i) =>
    getScaledSlotRectForGeometry(i, sourceImage, normalGeometry)
  );
  const dreamSlotRects = dreamGeometry !== normalGeometry
    ? Array.from({ length: NUM_SLOTS }, (_, i) =>
        getScaledSlotRectForGeometry(i, sourceImage, dreamGeometry)
      )
    : normalSlotRects;
  const personalSlotRects = personalGeometry !== normalGeometry
    ? Array.from({ length: NUM_SLOTS }, (_, i) =>
        getScaledSlotRectForGeometry(i, sourceImage, personalGeometry)
      )
    : normalSlotRects;

  const slotResults = Array.from({ length: NUM_SLOTS }, (_, slotIndex) => {
    const scored = candidateTemplates.map((template) => {
      const geom = template.isDream ? dreamGeometry : (template.isPersonal ? personalGeometry : normalGeometry);
      const rect = (template.isDream ? dreamSlotRects : (template.isPersonal ? personalSlotRects : normalSlotRects))[slotIndex];
      const dstW = geom.slotWidth, dstH = geom.slotHeight;

      const tmpl = getTemplateRawData(template, dstW, dstH, baselineMasks);

      const cropGray = extractSubGray(srcGrayData, rect.x, rect.y, rect.width, rect.height, dstW, dstH);
      const cropRgb  = extractSubRgb(srcRgbData,  rect.x, rect.y, rect.width, rect.height, dstW, dstH);

      const regions = template.isPersonal ? PERSONAL_REGIONS : STABLE_REGIONS;
      return {
        ...template,
        metrics: compareImages(cropGray, cropRgb, tmpl.gray, tmpl.rgb, regions, tmpl.mask),
        slotRect: { ...rect }
      };
    });

    scored.sort((a, b) => {
      if (a.metrics[metricName] !== b.metrics[metricName]) {
        return metric.higherIsBetter
          ? (b.metrics[metricName] - a.metrics[metricName])
          : (a.metrics[metricName] - b.metrics[metricName]);
      }
      return b.metrics.ncc - a.metrics.ncc;
    });

    const best = scored[0] || null;
    const bestScore = best ? best.metrics[metricName] : Number.NaN;

    // Margin is computed against the best competitor from a *different* card.
    // Using scored[1] (same card, different level/phase) produces a near-zero
    // margin that kills acceptance even when the correct card is obvious.
    const bestCardName = best?.baseName ?? null;
    const rival = scored.find((t) => t.baseName !== bestCardName) || null;
    const rivalScore = rival ? rival.metrics[metricName] : Number.NaN;
    const margin = !Number.isFinite(rivalScore)
      ? Number.POSITIVE_INFINITY
      : metric.higherIsBetter
        ? (bestScore - rivalScore)
        : (rivalScore - bestScore);
    // Keep second for debug display (still the overall runner-up, regardless of card name).
    const second = scored[1] || null;

    const accepted = !!best &&
      ((metric.higherIsBetter && bestScore >= metric.threshold) ||
        (!metric.higherIsBetter && bestScore <= metric.threshold)) &&
      margin >= metric.margin;

    const slotResult = {
      slotIndex,
      rect: best?.slotRect || normalSlotRects[slotIndex],
      metric: metricName,
      accepted,
      bestScore: roundMetric(bestScore),
      margin: roundMetric(margin),
      displayConfidence: best ? buildDisplayConfidence(bestScore, margin, metric) : 0,
      bestCandidate: buildDebugCandidate(best, metricName),
      secondCandidate: buildDebugCandidate(second, metricName),
      allCandidates: options.verboseDebug ? scored.map((c) => buildDebugCandidate(c, metricName)) : undefined,
      card: accepted ? {
        name: best.baseName,
        level: best.level,
        phase: best.phase ?? null,
        isDream: !!best.isDream,
        templateFile: best.fileName,
        confidence: buildDisplayConfidence(bestScore, margin, metric)
      } : null
    };

    return slotResult;
  });

  return {
    slots: slotResults.map((result) => result.card),
    slotResults,
    debug: {
      metric: metricName,
      scoreDirection: metric.higherIsBetter ? 'higher-is-better' : 'lower-is-better',
      threshold: metric.threshold,
      marginThreshold: metric.margin,
      candidateCount: candidateTemplates.length,
      normalGeometry,
      dreamGeometry: dreamGeometry !== normalGeometry ? dreamGeometry : null,
      personalGeometry: personalGeometry !== normalGeometry ? personalGeometry : null
    }
  };
}

module.exports = {
  NUM_SLOTS,
  STABLE_REGIONS,
  DEFAULT_METRIC,
  setCalibration,
  getActiveGeometry,
  buildTemplateIndex,
  detectSlots,
  normalizeCardName
};
