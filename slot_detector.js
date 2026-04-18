const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');
const { getCodePath } = require('./runtime_paths');

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
    slotHeight:       s.slotHeight
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
    isSeasonal: isSeasonalTemplatePath(filePath)
  };
}

function imageToGray(image) {
  const bitmap = image.toBitmap();
  const { width, height } = image.getSize();
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
  const { width, height } = image.getSize();
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0, px = 0; i < bitmap.length; i += 4, px += 3) {
    rgb[px] = bitmap[i + 2];
    rgb[px + 1] = bitmap[i + 1];
    rgb[px + 2] = bitmap[i];
  }
  return { rgb, width, height };
}

function getRegionBounds(width, height, region) {
  const x0 = Math.max(0, Math.floor(region.x * width));
  const y0 = Math.max(0, Math.floor(region.y * height));
  const x1 = Math.min(width, Math.ceil((region.x + region.width) * width));
  const y1 = Math.min(height, Math.ceil((region.y + region.height) * height));
  return { x0, y0, x1, y1 };
}

function regionStats(grayDataA, grayDataB, region) {
  const { width } = grayDataA;
  const { x0, y0, x1, y1 } = getRegionBounds(grayDataA.width, grayDataA.height, region);
  const count = Math.max(1, (x1 - x0) * (y1 - y0));

  let sumA = 0;
  let sumB = 0;
  let grayMse = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const idx = (y * width) + x;
      const diff = grayDataA.gray[idx] - grayDataB.gray[idx];
      sumA += grayDataA.gray[idx];
      sumB += grayDataB.gray[idx];
      grayMse += diff * diff;
    }
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

function regionRgbMse(rgbDataA, rgbDataB, region) {
  const { width } = rgbDataA;
  const { x0, y0, x1, y1 } = getRegionBounds(rgbDataA.width, rgbDataA.height, region);
  const count = Math.max(1, (x1 - x0) * (y1 - y0) * 3);
  let total = 0;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const idx = ((y * width) + x) * 3;
      const dr = rgbDataA.rgb[idx] - rgbDataB.rgb[idx];
      const dg = rgbDataA.rgb[idx + 1] - rgbDataB.rgb[idx + 1];
      const db = rgbDataA.rgb[idx + 2] - rgbDataB.rgb[idx + 2];
      total += (dr * dr) + (dg * dg) + (db * db);
    }
  }

  return total / count;
}

function compareImages(imageA, imageB) {
  const grayA = imageToGray(imageA);
  const grayB = imageToGray(imageB);
  const rgbA = imageToRgb(imageA);
  const rgbB = imageToRgb(imageB);

  let weightedSSIM = 0;
  let weightedNCC = 0;
  let weightedGrayMse = 0;
  let weightedRgbMse = 0;
  let totalWeight = 0;

  for (const region of STABLE_REGIONS) {
    const { ssim, ncc, grayMse } = regionStats(grayA, grayB, region);
    const rgbMse = regionRgbMse(rgbA, rgbB, region);
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
  const size = sourceImage.getSize();
  const scaleX = size.width  / geometry.baseScreenWidth;
  const scaleY = size.height / geometry.baseScreenHeight;
  return {
    x: Math.round(geometry.slotXPositions[slotIndex] * scaleX),
    y: Math.round(geometry.slotY * scaleY),
    width: Math.max(1, Math.round(geometry.slotWidth * scaleX)),
    height: Math.max(1, Math.round(geometry.slotHeight * scaleY))
  };
}

function cropSlot(sourceImage, slotIndex) {
  const active = getActiveGeometry();
  if (!active) return null;
  return cropSlotWithGeometry(sourceImage, slotIndex, active);
}

function cropSlotWithGeometry(sourceImage, slotIndex, geometry) {
  const cropRect = getScaledSlotRectForGeometry(slotIndex, sourceImage, geometry);
  return {
    rect: cropRect,
    image: sourceImage.crop(cropRect).resize({
      width: geometry.slotWidth,
      height: geometry.slotHeight,
      quality: 'best'
    })
  };
}

function scoreCandidates(slotImage, candidates, metricName) {
  const metric = getMetricDefinition(metricName);
  const scored = candidates.map((template) => ({
    ...template,
    metrics: compareImages(slotImage, template.image)
  }));

  scored.sort((a, b) => {
    if (a.metrics[metricName] !== b.metrics[metricName]) {
      return metric.higherIsBetter
        ? (b.metrics[metricName] - a.metrics[metricName])
        : (a.metrics[metricName] - b.metrics[metricName]);
    }
    return b.metrics.ncc - a.metrics.ncc;
  });

  return scored;
}

function getPreparedTemplateImage(template, width, height) {
  const cacheKey = `${width}x${height}`;
  if (template.resizedImages.has(cacheKey)) {
    return template.resizedImages.get(cacheKey);
  }

  const prepared = template.originalImage.resize({
    width,
    height,
    quality: 'best'
  });
  template.resizedImages.set(cacheKey, prepared);
  return prepared;
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
  if (!Number.isFinite(bestScore) || !Number.isFinite(margin)) return 0;

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

  const marginComponent = metric.margin <= 0
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
  const candidateTemplates = [];
  const seenTemplateFiles = new Set();

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
      seenTemplateFiles.add(template.filePath);
      candidateTemplates.push(template);
    }
  }

  if (candidateTemplates.length === 0) {
    return {
      slots: Array(NUM_SLOTS).fill(null),
      slotResults: [],
      debug: { reason: 'no-candidates', metric: metricName }
    };
  }

  const normalSlotCrops = Array.from({ length: NUM_SLOTS }, (_, slotIndex) => (
    cropSlotWithGeometry(sourceImage, slotIndex, normalGeometry)
  ));

  const slotResults = Array.from({ length: NUM_SLOTS }, (_, slotIndex) => {
    const scored = candidateTemplates.map((template) => {
      const slotCrop = normalSlotCrops[slotIndex];
      const slotImage = slotCrop.image;
      const templateImage = getPreparedTemplateImage(
        template,
        normalGeometry.slotWidth,
        normalGeometry.slotHeight
      );

      return {
        ...template,
        metrics: compareImages(slotImage, templateImage),
        slotRect: slotCrop.rect
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
    const second = scored[1] || null;
    const bestScore = best ? best.metrics[metricName] : Number.NaN;
    const secondScore = second ? second.metrics[metricName] : Number.NaN;
    const margin = !Number.isFinite(secondScore)
      ? Number.POSITIVE_INFINITY
      : metric.higherIsBetter
        ? (bestScore - secondScore)
        : (secondScore - bestScore);

    const accepted = !!best &&
      ((metric.higherIsBetter && bestScore >= metric.threshold) ||
        (!metric.higherIsBetter && bestScore <= metric.threshold)) &&
      margin >= metric.margin;

    const slotResult = {
      slotIndex,
      rect: best?.slotRect || normalSlotCrops[slotIndex].rect,
      metric: metricName,
      accepted,
      bestScore: roundMetric(bestScore),
      margin: roundMetric(margin),
      displayConfidence: best ? buildDisplayConfidence(bestScore, margin, metric) : 0,
      bestCandidate: buildDebugCandidate(best, metricName),
      secondCandidate: buildDebugCandidate(second, metricName),
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
      normalGeometry
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
