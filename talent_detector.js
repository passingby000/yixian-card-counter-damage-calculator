const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');
const { getCodePath, getYisimPath } = require('./runtime_paths');
const { normalizeTalentName, getTalentMetadata } = require('./talent_catalog');

const CONFIG_PATH = getCodePath('talent_detector_config.json');
const detectorConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const TALENT_THRESHOLD = Number.isFinite(Number(detectorConfig.threshold))
  ? Number(detectorConfig.threshold)
  : 0.693;
const TALENT_TEMPLATE_DIR = getYisimPath('lanke', 'talent_templates');
const NUM_TALENT_POSITIONS = 5;

let templateCache = null;

// Calibration override — set via setCalibration() from main process
let activeCalibration = null;

function setCalibration(data) {
  activeCalibration = data || null;
}

// Compute scaled talent rects from calibration data for a given source size
function computeTalentRects(sourceSize) {
  if (!activeCalibration?.talents || !activeCalibration.screenshotSize) return null;
  const calW = activeCalibration.screenshotSize.width;
  const calH = activeCalibration.screenshotSize.height;
  const scaleX = sourceSize.width / calW;
  const scaleY = sourceSize.height / calH;
  return activeCalibration.talents.map((rect) => rect ? ({
    x: Math.round(rect.x * scaleX),
    y: Math.round(rect.y * scaleY),
    width: Math.max(1, Math.round(rect.width * scaleX)),
    height: Math.max(1, Math.round(rect.height * scaleY))
  }) : null);
}

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

  const positions = Array.from({ length: NUM_TALENT_POSITIONS }, (_, index) => {
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
  return computeTalentRects(sourceImage.getSize());
}

// Convert a nativeImage to a gray Float32Array using its physical pixel dimensions.
// For the full source image, getSize() matches toBitmap() dimensions correctly.
// (Avoid using this on cropped nativeImages — crop returns logical size but bitmap
//  is physical, causing stride mismatch at DPI > 1.)
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

// Cache grayscale array on the template object (computed once per template).
// Template images are loaded from files — getSize() is reliable for them.
function getTemplateGray(template) {
  if (!template.grayData) {
    template.grayData = imageToGrayscaleArray(template.image);
  }
  return template.grayData;
}

function resizeGray(srcGray, srcW, srcH, dstW, dstH) {
  const out = new Float32Array(dstW * dstH);
  const rx = srcW / dstW;
  const ry = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const fx = dx * rx, fy = dy * ry;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, srcW - 1), y1 = Math.min(y0 + 1, srcH - 1);
      const wx = fx - x0, wy = fy - y0;
      out[dy * dstW + dx] =
        (1 - wx) * (1 - wy) * srcGray[y0 * srcW + x0] +
        wx       * (1 - wy) * srcGray[y0 * srcW + x1] +
        (1 - wx) * wy       * srcGray[y1 * srcW + x0] +
        wx       * wy       * srcGray[y1 * srcW + x1];
    }
  }
  return out;
}

// Circular-masked zero-mean NCC — matches calibrator.js and debug_talent1.js exactly.
function znccCircular(ssGray, ssW, sx, sy, tmplGray, tw, th) {
  const cx = (tw - 1) / 2, cy = (th - 1) / 2;
  const r2 = (Math.min(tw, th) / 2) ** 2;
  let sumI = 0, sumT = 0, n = 0;
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      if ((tx - cx) ** 2 + (ty - cy) ** 2 > r2) continue;
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
      if ((tx - cx) ** 2 + (ty - cy) ** 2 > r2) continue;
      const di = ssGray[(sy + ty) * ssW + (sx + tx)] - mI;
      const dt = tmplGray[ty * tw + tx] - mT;
      num += di * dt; denI += di * di; denT += dt * dt;
    }
  }
  const denom = Math.sqrt(denI * denT);
  return denom < 1 ? 0 : num / denom;
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

  if (!rects) return buildFallbackTalentResults(sourceImage.getSize(), 'not-calibrated');

  // Convert the full source image to gray ONCE using its actual dimensions.
  // This avoids the nativeImage.crop() stride mismatch bug on Windows with DPI scaling,
  // where crop().getSize() returns logical pixels but toBitmap() returns physical pixels.
  const { gray: ssGray, width: ssW, height: ssH } = imageToGrayscaleArray(sourceImage);

  const talents = rects.map((rect, index) => {
    if (!rect) return createEmptyTalentSlot(index + 1, null);
    const templates = positionTemplates[index] || [];

    // For position 1, also try slightly shrunk rects (same center) to handle icons that are 1-2px smaller
    const rectsToTry = [rect];
    if (index === 0) {
      for (const d of [1, 2]) {
        rectsToTry.push({
          x: rect.x + d,
          y: rect.y + d,
          width:  Math.max(1, rect.width  - 2 * d),
          height: Math.max(1, rect.height - 2 * d)
        });
      }
    }

    const scoredCandidates = templates.flatMap((template) => {
      const tmplGray = getTemplateGray(template);
      return rectsToTry.map((r) => {
        const rx = Math.max(0, Math.min(r.x, ssW - 1));
        const ry = Math.max(0, Math.min(r.y, ssH - 1));
        const rw = Math.max(1, Math.min(r.width,  ssW - rx));
        const rh = Math.max(1, Math.min(r.height, ssH - ry));
        const scaledTmpl = resizeGray(tmplGray.gray, tmplGray.width, tmplGray.height, rw, rh);
        const score = znccCircular(ssGray, ssW, rx, ry, scaledTmpl, rw, rh);
        return { ...template, score };
      });
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
      geometry: { rects },
      unmatchedPositions,
      templatesDir,
      templateCounts: positionTemplates.map((templates) => templates.length)
    }
  };
}

function buildFallbackTalentResults(sourceSize, status = 'idle') {
  const rects = sourceSize ? computeTalentRects(sourceSize) : null;
  const emptyRects = Array.from({ length: NUM_TALENT_POSITIONS }, () => null);
  const effectiveRects = rects || emptyRects;

  return {
    talents: effectiveRects.map((rect, index) => createEmptyTalentSlot(index + 1, rect)),
    debug: {
      status,
      threshold: TALENT_THRESHOLD,
      screenshotSize: sourceSize || null,
      geometry: { rects: effectiveRects },
      unmatchedPositions: effectiveRects.map((_, index) => index + 1),
      templatesDir: TALENT_TEMPLATE_DIR,
      templateCounts: []
    }
  };
}

module.exports = {
  NUM_TALENT_POSITIONS,
  TALENT_THRESHOLD,
  TALENT_TEMPLATE_DIR,
  setCalibration,
  loadTalentTemplates,
  detectTalents,
  buildFallbackTalentResults,
  getScaledTalentRects
};
