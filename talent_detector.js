const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');
const { getCodePath, getYisimPath } = require('./runtime_paths');
const { normalizeTalentName, getTalentMetadata } = require('./talent_catalog');

const CONFIG_PATH = getCodePath('talent_detector_config.json');
const detectorConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const BASE_SCREEN_WIDTH = detectorConfig.baseScreenWidth;
const BASE_SCREEN_HEIGHT = detectorConfig.baseScreenHeight;
const TALENT_THRESHOLD = Number.isFinite(Number(detectorConfig.threshold))
  ? Number(detectorConfig.threshold)
  : 0.693;
const TALENT_TEMPLATE_DIR = getYisimPath('lanke', 'talent_templates');
const BASE_TALENT_RECTS = Array.isArray(detectorConfig.rects)
  ? detectorConfig.rects.map((rect) => ({
      x: Number(rect.x),
      y: Number(rect.y),
      width: Number(rect.width),
      height: Number(rect.height)
    }))
  : [];

let templateCache = null;

function getTemplatePreferenceScore(filePath) {
  const fileName = path.basename(filePath, '.png');
  const trimmed = fileName.trim();
  let score = 0;
  if (fileName === trimmed) score += 10;
  if (!/\s\./.test(fileName)) score += 2;
  return score - filePath.length / 10000;
}

function loadTalentTemplates(templatesDir = TALENT_TEMPLATE_DIR) {
  if (templateCache && templateCache.templatesDir === templatesDir) {
    return templateCache.positions;
  }

  const positions = BASE_TALENT_RECTS.map((_, index) => {
    const positionDir = path.join(templatesDir, `position_${index + 1}`);
    const templatesByName = new Map();
    if (!fs.existsSync(positionDir)) {
      return [];
    }

    for (const entry of fs.readdirSync(positionDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.png')) continue;
      const filePath = path.join(positionDir, entry.name);
      const image = nativeImage.createFromPath(filePath);
      if (image.isEmpty()) continue;

      const normalizedName = normalizeTalentName(path.basename(entry.name, '.png'));
      const nextTemplate = {
        name: normalizedName,
        fileName: entry.name,
        filePath,
        image,
        resizedImages: new Map()
      };
      const existing = templatesByName.get(normalizedName);
      if (!existing || getTemplatePreferenceScore(nextTemplate.filePath) > getTemplatePreferenceScore(existing.filePath)) {
        templatesByName.set(normalizedName, nextTemplate);
      }
    }

    return Array.from(templatesByName.values()).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  });

  templateCache = {
    templatesDir,
    positions
  };
  return positions;
}

function getScaledTalentRects(sourceImage) {
  const { width, height } = sourceImage.getSize();
  const scaleX = width / BASE_SCREEN_WIDTH;
  const scaleY = height / BASE_SCREEN_HEIGHT;
  return BASE_TALENT_RECTS.map((rect) => ({
    x: Math.round(rect.x * scaleX),
    y: Math.round(rect.y * scaleY),
    width: Math.max(1, Math.round(rect.width * scaleX)),
    height: Math.max(1, Math.round(rect.height * scaleY))
  }));
}

function cropTalentSlot(sourceImage, rect) {
  return sourceImage.crop(rect);
}

function getResizedTemplateImage(template, width, height) {
  const cacheKey = `${width}x${height}`;
  if (template.resizedImages.has(cacheKey)) {
    return template.resizedImages.get(cacheKey);
  }

  const resized = template.image.resize({
    width,
    height,
    quality: 'best'
  });
  template.resizedImages.set(cacheKey, resized);
  return resized;
}

function imageToGrayscaleArray(image) {
  const bitmap = image.toBitmap();
  const { width, height } = image.getSize();
  const gray = new Float32Array(width * height);
  for (let i = 0, pixelIndex = 0; i < bitmap.length; i += 4, pixelIndex += 1) {
    const blue = bitmap[i];
    const green = bitmap[i + 1];
    const red = bitmap[i + 2];
    gray[pixelIndex] = (0.114 * blue) + (0.587 * green) + (0.299 * red);
  }
  return { gray, width, height };
}

function getCenterCropBounds(width, height) {
  return {
    x0: Math.max(0, Math.floor(width * 0.15)),
    y0: Math.max(0, Math.floor(height * 0.15)),
    x1: Math.min(width, Math.ceil(width * 0.85)),
    y1: Math.min(height, Math.ceil(height * 0.85))
  };
}

function computeNormalizedCorrelation(imageA, imageB) {
  const grayA = imageToGrayscaleArray(imageA);
  const grayB = imageToGrayscaleArray(imageB);
  const { x0, y0, x1, y1 } = getCenterCropBounds(grayA.width, grayA.height);

  let sumA = 0;
  let sumB = 0;
  let count = 0;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const idx = (y * grayA.width) + x;
      sumA += grayA.gray[idx];
      sumB += grayB.gray[idx];
      count += 1;
    }
  }

  if (count === 0) {
    return 0;
  }

  const meanA = sumA / count;
  const meanB = sumB / count;
  let numerator = 0;
  let denomA = 0;
  let denomB = 0;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const idx = (y * grayA.width) + x;
      const centeredA = grayA.gray[idx] - meanA;
      const centeredB = grayB.gray[idx] - meanB;
      numerator += centeredA * centeredB;
      denomA += centeredA * centeredA;
      denomB += centeredB * centeredB;
    }
  }

  const denominator = Math.sqrt(denomA * denomB);
  return denominator === 0 ? 0 : numerator / denominator;
}

function roundScore(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : value;
}

function buildCandidate(candidate) {
  if (!candidate) return null;
  return {
    name: candidate.name,
    templateFile: candidate.fileName,
    score: roundScore(candidate.score)
  };
}

function createEmptyTalentSlot(position, rect) {
  return {
    position,
    name: null,
    nameCn: null,
    confidence: 0,
    matchedTemplate: null,
    rect,
    detected: false,
    simulationKind: null,
    runtimeKey: null,
    grantedCardBaseIds: null,
    bestCandidate: null,
    secondCandidate: null
  };
}

function buildTalentResult(position, rect, best, second, threshold) {
  if (!best || !Number.isFinite(best.score) || best.score < threshold) {
    return {
      ...createEmptyTalentSlot(position, rect),
      bestCandidate: buildCandidate(best),
      secondCandidate: buildCandidate(second)
    };
  }

  const metadata = getTalentMetadata(best.name);
  return {
    position,
    name: best.name,
    nameCn: metadata?.nameCn || null,
    confidence: roundScore(best.score),
    matchedTemplate: best.fileName,
    rect,
    detected: true,
    simulationKind: metadata?.simulationKind || 'non-combat-or-unsupported',
    runtimeKey: metadata?.runtimeKey || null,
    grantedCardBaseIds: metadata?.grantedCardBaseIds || null,
    bestCandidate: buildCandidate(best),
    secondCandidate: buildCandidate(second)
  };
}

function detectTalents(sourceImage, options = {}) {
  const threshold = Number.isFinite(Number(options.threshold))
    ? Number(options.threshold)
    : TALENT_THRESHOLD;
  const templatesDir = options.templatesDir || TALENT_TEMPLATE_DIR;
  const positionTemplates = loadTalentTemplates(templatesDir);
  const rects = getScaledTalentRects(sourceImage);

  const talents = rects.map((rect, index) => {
    const roi = cropTalentSlot(sourceImage, rect);
    const templates = positionTemplates[index] || [];
    const scoredCandidates = templates.map((template) => {
      const resizedTemplate = getResizedTemplateImage(template, rect.width, rect.height);
      return {
        ...template,
        score: computeNormalizedCorrelation(roi, resizedTemplate)
      };
    }).sort((a, b) => b.score - a.score);

    return buildTalentResult(index + 1, rect, scoredCandidates[0] || null, scoredCandidates[1] || null, threshold);
  });

  const unmatchedPositions = talents.filter((talent) => !talent.detected).map((talent) => talent.position);

  return {
    talents,
    debug: {
      status: 'ok',
      threshold,
      screenshotSize: sourceImage.getSize(),
      geometry: {
        baseScreenWidth: BASE_SCREEN_WIDTH,
        baseScreenHeight: BASE_SCREEN_HEIGHT,
        baseRects: BASE_TALENT_RECTS,
        rects
      },
      unmatchedPositions,
      templatesDir,
      templateCounts: positionTemplates.map((templates) => templates.length)
    }
  };
}

function buildFallbackTalentResults(sourceSize = { width: BASE_SCREEN_WIDTH, height: BASE_SCREEN_HEIGHT }, status = 'idle') {
  const scaleX = (sourceSize.width || BASE_SCREEN_WIDTH) / BASE_SCREEN_WIDTH;
  const scaleY = (sourceSize.height || BASE_SCREEN_HEIGHT) / BASE_SCREEN_HEIGHT;
  const rects = BASE_TALENT_RECTS.map((rect) => ({
    x: Math.round(rect.x * scaleX),
    y: Math.round(rect.y * scaleY),
    width: Math.max(1, Math.round(rect.width * scaleX)),
    height: Math.max(1, Math.round(rect.height * scaleY))
  }));

  return {
    talents: rects.map((rect, index) => createEmptyTalentSlot(index + 1, rect)),
    debug: {
      status,
      threshold: TALENT_THRESHOLD,
      screenshotSize: sourceSize,
      geometry: {
        baseScreenWidth: BASE_SCREEN_WIDTH,
        baseScreenHeight: BASE_SCREEN_HEIGHT,
        baseRects: BASE_TALENT_RECTS,
        rects
      },
      unmatchedPositions: rects.map((_, index) => index + 1),
      templatesDir: TALENT_TEMPLATE_DIR,
      templateCounts: []
    }
  };
}

module.exports = {
  BASE_TALENT_RECTS,
  BASE_SCREEN_WIDTH,
  BASE_SCREEN_HEIGHT,
  TALENT_THRESHOLD,
  TALENT_TEMPLATE_DIR,
  loadTalentTemplates,
  detectTalents,
  buildFallbackTalentResults,
  getScaledTalentRects
};
