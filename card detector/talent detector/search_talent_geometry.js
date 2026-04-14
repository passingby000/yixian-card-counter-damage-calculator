const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const electronModule = require('electron');

if (typeof electronModule === 'string') {
  const { spawn } = require('child_process');
  const runnerAppDir = path.join(__dirname, 'electron_runner_app');
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    electronModule,
    ['--disable-gpu', runnerAppDir, __filename, ...process.argv.slice(2)],
    { stdio: 'inherit', windowsHide: false, env: childEnv }
  );

  child.on('close', (code, signal) => {
    if (code === null) {
      process.stderr.write(`${electronModule} exited with signal ${signal}\n`);
      process.exit(1);
      return;
    }
    process.exit(code);
  });

  for (const signalName of ['SIGINT', 'SIGTERM']) {
    process.on(signalName, () => {
      if (!child.killed) {
        child.kill(signalName);
      }
    });
  }
} else {
  const { app, nativeImage, BrowserWindow } = electronModule;
  const {
    BASE_TALENT_RECTS,
    BASE_SCREEN_WIDTH,
    BASE_SCREEN_HEIGHT,
    TALENT_THRESHOLD
  } = require('../../talent_detector');

  const ROOT_DIR = path.resolve(__dirname, '..', '..');
  const TEMPLATES_ROOT = path.join(ROOT_DIR, 'vendor', 'yisim', 'lanke', 'talent_templates');
  const SCRIPT_DIR = __dirname;
  const DEFAULT_REPORT_PATH = path.join(SCRIPT_DIR, 'talent_geometry_report.json');
  const DEFAULT_ANNOTATED_PATH = path.join(SCRIPT_DIR, 'talent_geometry_annotated.png');
  const DEFAULT_CROPS_DIR = path.join(SCRIPT_DIR, 'talent_geometry_debug_slots');

  const EXPECTED_TALENTS = [
    { slot: 1, name: 'Surge of Qi' },
    { slot: 2, name: 'Counter Move' },
    { slot: 3, name: 'Indomitable Will' },
    { slot: 4, name: 'Shift Stance' },
    { slot: 5, name: 'Attain Qi' }
  ].map((entry, index) => ({
    ...entry,
    baselineRect: { ...BASE_TALENT_RECTS[index] },
    templatePath: path.join(TEMPLATES_ROOT, `position_${entry.slot}`, `${entry.name}.png`)
  }));

  const SHARED_LAYOUT_COARSE = {
    dxMin: -56,
    dxMax: 56,
    dxStep: 4,
    dyMin: -56,
    dyMax: 56,
    dyStep: 4,
    layoutScaleMin: 0.88,
    layoutScaleMax: 1.18,
    layoutScaleStep: 0.04,
    iconScaleMin: 0.65,
    iconScaleMax: 1.25,
    iconScaleStep: 0.05
  };

  const SHARED_LAYOUT_REFINE = {
    dxMin: -8,
    dxMax: 8,
    dxStep: 1,
    dyMin: -8,
    dyMax: 8,
    dyStep: 1,
    layoutScaleDeltaMin: -0.08,
    layoutScaleDeltaMax: 0.08,
    layoutScaleDeltaStep: 0.01,
    iconScaleDeltaMin: -0.12,
    iconScaleDeltaMax: 0.12,
    iconScaleDeltaStep: 0.02
  };

  const LOCAL_REFINEMENT = {
    dxMin: -6,
    dxMax: 6,
    dxStep: 1,
    dyMin: -6,
    dyMax: 6,
    dyStep: 1,
    widthDeltaMin: -6,
    widthDeltaMax: 6,
    widthDeltaStep: 1,
    heightDeltaMin: -6,
    heightDeltaMax: 6,
    heightDeltaStep: 1,
    keepTopN: 18
  };

  const ORDER_AXIS_EPSILON = 4;

  const originalTemplateCache = new Map();
  const preparedTemplateCache = new Map();
  const circleMaskCache = new Map();

  const BASE_LAYOUT_CENTERS = BASE_TALENT_RECTS.map((rect) => ({
    x: rect.x + (rect.width / 2),
    y: rect.y + (rect.height / 2)
  }));
  const BASE_LAYOUT_CENTROID = BASE_LAYOUT_CENTERS.reduce((acc, center) => ({
    x: acc.x + center.x,
    y: acc.y + center.y
  }), { x: 0, y: 0 });
  BASE_LAYOUT_CENTROID.x /= BASE_LAYOUT_CENTERS.length;
  BASE_LAYOUT_CENTROID.y /= BASE_LAYOUT_CENTERS.length;

  function roundNumber(value) {
    return Number.isFinite(value) ? Number(value.toFixed(4)) : value;
  }

  function makeRange(min, max, step) {
    const values = [];
    for (let value = min; value <= max + 1e-9; value += step) {
      values.push(Number(value.toFixed(6)));
    }
    return values;
  }

  function findDefaultScreenshotPath() {
    const entries = fs.readdirSync(SCRIPT_DIR)
      .filter((entry) => entry.toLowerCase().endsWith('.png'))
      .sort();

    const preferred = entries.find((entry) => /^Screenshot 2026-04-13 at 11\.22\.51.*\.png$/u.test(entry));
    if (preferred) {
      return path.join(SCRIPT_DIR, preferred);
    }

    if (entries.length > 0) {
      return path.join(SCRIPT_DIR, entries[0]);
    }

    return path.join(SCRIPT_DIR, 'Screenshot 2026-04-13 at 11.22.51 AM.png');
  }

  function resolveInputPath(inputPath, fallbackPath) {
    if (!inputPath) return fallbackPath;
    return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
  }

  function loadOriginalTemplate(filePath) {
    if (originalTemplateCache.has(filePath)) {
      return originalTemplateCache.get(filePath);
    }

    const image = nativeImage.createFromPath(filePath);
    if (image.isEmpty()) {
      throw new Error(`Failed to load template image: ${filePath}`);
    }
    originalTemplateCache.set(filePath, image);
    return image;
  }

  function imageToGrayAlpha(image) {
    const bitmap = image.toBitmap();
    const { width, height } = image.getSize();
    const gray = new Float32Array(width * height);
    const alpha = new Uint8Array(width * height);
    for (let i = 0, pixelIndex = 0; i < bitmap.length; i += 4, pixelIndex += 1) {
      const blue = bitmap[i];
      const green = bitmap[i + 1];
      const red = bitmap[i + 2];
      alpha[pixelIndex] = bitmap[i + 3];
      gray[pixelIndex] = (0.114 * blue) + (0.587 * green) + (0.299 * red);
    }
    return { gray, alpha, width, height };
  }

  function getPreparedTemplate(filePath, width, height) {
    const cacheKey = `${filePath}|${width}|${height}`;
    if (preparedTemplateCache.has(cacheKey)) {
      return preparedTemplateCache.get(cacheKey);
    }

    const resizedImage = loadOriginalTemplate(filePath).resize({
      width,
      height,
      quality: 'best'
    });
    const prepared = {
      image: resizedImage,
      grayAlpha: imageToGrayAlpha(resizedImage)
    };
    preparedTemplateCache.set(cacheKey, prepared);
    return prepared;
  }

  function buildScaledRect(sourceImage, rect) {
    const size = sourceImage.getSize();
    const scaleX = size.width / BASE_SCREEN_WIDTH;
    const scaleY = size.height / BASE_SCREEN_HEIGHT;
    return {
      x: Math.round(rect.x * scaleX),
      y: Math.round(rect.y * scaleY),
      width: Math.max(1, Math.round(rect.width * scaleX)),
      height: Math.max(1, Math.round(rect.height * scaleY))
    };
  }

  function sanitizeInteger(value) {
    const rounded = Math.round(value);
    return Object.is(rounded, -0) ? 0 : rounded;
  }

  function normalizeCropRect(rect) {
    return {
      x: sanitizeInteger(rect.x),
      y: sanitizeInteger(rect.y),
      width: Math.max(1, sanitizeInteger(rect.width)),
      height: Math.max(1, sanitizeInteger(rect.height))
    };
  }

  function cropImage(sourceImage, rect) {
    const normalizedRect = normalizeCropRect(rect);
    const imageSize = sourceImage.getSize();
    if (
      !Number.isFinite(normalizedRect.x) ||
      !Number.isFinite(normalizedRect.y) ||
      !Number.isFinite(normalizedRect.width) ||
      !Number.isFinite(normalizedRect.height) ||
      normalizedRect.x < 0 ||
      normalizedRect.y < 0 ||
      normalizedRect.width <= 0 ||
      normalizedRect.height <= 0 ||
      normalizedRect.x + normalizedRect.width > imageSize.width ||
      normalizedRect.y + normalizedRect.height > imageSize.height
    ) {
      return null;
    }
    return sourceImage.crop(normalizedRect);
  }

  function getCenter50CircleMask(width, height) {
    const cacheKey = `${width}x${height}`;
    if (circleMaskCache.has(cacheKey)) {
      return circleMaskCache.get(cacheKey);
    }

    const x0 = Math.max(0, Math.floor(width * 0.25));
    const y0 = Math.max(0, Math.floor(height * 0.25));
    const x1 = Math.min(width, Math.ceil(width * 0.75));
    const y1 = Math.min(height, Math.ceil(height * 0.75));
    const cropWidth = Math.max(1, x1 - x0);
    const cropHeight = Math.max(1, y1 - y0);
    const radius = Math.min(cropWidth, cropHeight) / 2;
    const centerX = x0 + (cropWidth / 2);
    const centerY = y0 + (cropHeight / 2);
    const indices = [];

    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const dx = (x + 0.5) - centerX;
        const dy = (y + 0.5) - centerY;
        if ((dx * dx) + (dy * dy) <= radius * radius) {
          indices.push((y * width) + x);
        }
      }
    }

    const mask = { indices, radius, bounds: { x0, y0, x1, y1 } };
    circleMaskCache.set(cacheKey, mask);
    return mask;
  }

  function computeMaskedCorrelation(roiGrayAlpha, templateGrayAlpha) {
    const mask = getCenter50CircleMask(roiGrayAlpha.width, roiGrayAlpha.height);
    let sumA = 0;
    let sumB = 0;
    let count = 0;

    for (const idx of mask.indices) {
      if (templateGrayAlpha.alpha[idx] <= 8) continue;
      sumA += roiGrayAlpha.gray[idx];
      sumB += templateGrayAlpha.gray[idx];
      count += 1;
    }

    if (count === 0) {
      return Number.NEGATIVE_INFINITY;
    }

    const meanA = sumA / count;
    const meanB = sumB / count;
    let numerator = 0;
    let denomA = 0;
    let denomB = 0;

    for (const idx of mask.indices) {
      if (templateGrayAlpha.alpha[idx] <= 8) continue;
      const centeredA = roiGrayAlpha.gray[idx] - meanA;
      const centeredB = templateGrayAlpha.gray[idx] - meanB;
      numerator += centeredA * centeredB;
      denomA += centeredA * centeredA;
      denomB += centeredB * centeredB;
    }

    const denominator = Math.sqrt(denomA * denomB);
    return denominator === 0 ? Number.NEGATIVE_INFINITY : numerator / denominator;
  }

  function rectArea(rect) {
    return rect.width * rect.height;
  }

  function rectCenter(rect) {
    return {
      x: rect.x + (rect.width / 2),
      y: rect.y + (rect.height / 2)
    };
  }

  function buildOrderConstraints(rects) {
    const centers = rects.map((rect) => rectCenter(rect));
    const constraints = [];

    for (let i = 0; i < centers.length; i += 1) {
      for (let j = i + 1; j < centers.length; j += 1) {
        const dx = centers[j].x - centers[i].x;
        const dy = centers[j].y - centers[i].y;
        if (Math.abs(dx) > ORDER_AXIS_EPSILON) {
          constraints.push({ i, j, axis: 'x', sign: Math.sign(dx) });
        }
        if (Math.abs(dy) > ORDER_AXIS_EPSILON) {
          constraints.push({ i, j, axis: 'y', sign: Math.sign(dy) });
        }
      }
    }

    return constraints;
  }

  const BASE_ORDER_CONSTRAINTS = buildOrderConstraints(BASE_TALENT_RECTS);

  function respectsOrderConstraints(rects, constraints) {
    const centers = rects.map((rect) => rectCenter(rect));
    return constraints.every((constraint) => {
      const delta = constraint.axis === 'x'
        ? centers[constraint.j].x - centers[constraint.i].x
        : centers[constraint.j].y - centers[constraint.i].y;
      return constraint.sign > 0
        ? delta > ORDER_AXIS_EPSILON
        : delta < -ORDER_AXIS_EPSILON;
    });
  }

  function rectsOverlap(rectA, rectB) {
    return !(
      rectA.x + rectA.width <= rectB.x ||
      rectB.x + rectB.width <= rectA.x ||
      rectA.y + rectA.height <= rectB.y ||
      rectB.y + rectB.height <= rectA.y
    );
  }

  function hasOverlaps(rects) {
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        if (rectsOverlap(rects[i], rects[j])) {
          return true;
        }
      }
    }
    return false;
  }

  function buildSharedLayoutRects(dx, dy, layoutScale, iconScale) {
    return BASE_TALENT_RECTS.map((baselineRect, index) => {
      const baseCenter = BASE_LAYOUT_CENTERS[index];
      const centerX = BASE_LAYOUT_CENTROID.x + ((baseCenter.x - BASE_LAYOUT_CENTROID.x) * layoutScale) + dx;
      const centerY = BASE_LAYOUT_CENTROID.y + ((baseCenter.y - BASE_LAYOUT_CENTROID.y) * layoutScale) + dy;
      const width = Math.max(1, Math.round(baselineRect.width * iconScale));
      const height = Math.max(1, Math.round(baselineRect.height * iconScale));
      return {
        x: Math.round(centerX - (width / 2)),
        y: Math.round(centerY - (height / 2)),
        width,
        height
      };
    });
  }

  function evaluateRect(sourceImage, templatePath, baseRect) {
    const scaledRect = buildScaledRect(sourceImage, baseRect);
    const roi = cropImage(sourceImage, scaledRect);
    if (!roi) {
      return {
        valid: false,
        baseRect,
        scaledRect,
        score: Number.NEGATIVE_INFINITY
      };
    }

    const preparedTemplate = getPreparedTemplate(templatePath, scaledRect.width, scaledRect.height);
    const roiGrayAlpha = imageToGrayAlpha(roi);

    return {
      valid: true,
      baseRect,
      scaledRect,
      score: computeMaskedCorrelation(roiGrayAlpha, preparedTemplate.grayAlpha)
    };
  }

  function evaluateLayout(sourceImage, params) {
    const rects = buildSharedLayoutRects(params.dx, params.dy, params.layoutScale, params.iconScale);
    if (hasOverlaps(rects) || !respectsOrderConstraints(rects, BASE_ORDER_CONSTRAINTS)) {
      return { valid: false, params, rects, totalScore: Number.NEGATIVE_INFINITY, averageScore: Number.NEGATIVE_INFINITY, minScore: Number.NEGATIVE_INFINITY, positions: [] };
    }

    const positions = EXPECTED_TALENTS.map((entry, index) => ({
      slot: entry.slot,
      name: entry.name,
      templatePath: entry.templatePath,
      ...evaluateRect(sourceImage, entry.templatePath, rects[index])
    }));

    if (positions.some((entry) => !entry.valid)) {
      return {
        valid: false,
        params,
        rects,
        totalScore: Number.NEGATIVE_INFINITY,
        averageScore: Number.NEGATIVE_INFINITY,
        minScore: Number.NEGATIVE_INFINITY,
        positions
      };
    }

    const totalScore = positions.reduce((sum, entry) => sum + entry.score, 0);
    const averageScore = totalScore / positions.length;
    const minScore = Math.min(...positions.map((entry) => entry.score));
    return {
      valid: true,
      params,
      rects,
      positions,
      totalScore,
      averageScore,
      minScore
    };
  }

  function computeSharedDeviation(params) {
    return (
      Math.abs(params.dx) +
      Math.abs(params.dy) +
      (Math.abs(params.layoutScale - 1) * 100) +
      (Math.abs(params.iconScale - 1) * 100)
    );
  }

  function isBetterLayout(nextEvaluation, currentBest) {
    if (!nextEvaluation?.valid) return false;
    if (!currentBest) return true;
    if (nextEvaluation.totalScore !== currentBest.totalScore) {
      return nextEvaluation.totalScore > currentBest.totalScore;
    }
    if (nextEvaluation.minScore !== currentBest.minScore) {
      return nextEvaluation.minScore > currentBest.minScore;
    }
    return computeSharedDeviation(nextEvaluation.params) < computeSharedDeviation(currentBest.params);
  }

  function searchSharedLayout(sourceImage, ranges) {
    const dxValues = makeRange(ranges.dxMin, ranges.dxMax, ranges.dxStep);
    const dyValues = makeRange(ranges.dyMin, ranges.dyMax, ranges.dyStep);
    const layoutScaleValues = makeRange(ranges.layoutScaleMin, ranges.layoutScaleMax, ranges.layoutScaleStep);
    const iconScaleValues = makeRange(ranges.iconScaleMin, ranges.iconScaleMax, ranges.iconScaleStep);
    const total = dxValues.length * dyValues.length * layoutScaleValues.length * iconScaleValues.length;

    let current = 0;
    let best = null;

    for (const dx of dxValues) {
      for (const dy of dyValues) {
        for (const layoutScale of layoutScaleValues) {
          for (const iconScale of iconScaleValues) {
            current += 1;
            if (current % 250 === 0 || current === total) {
              printProgress('Shared layout search', current, total);
            }
            const evaluation = evaluateLayout(sourceImage, { dx, dy, layoutScale, iconScale });
            if (isBetterLayout(evaluation, best)) {
              best = evaluation;
            }
          }
        }
      }
    }

    return best;
  }

  function refineSharedLayout(sourceImage, bestSharedLayout) {
    const dxValues = makeRange(
      bestSharedLayout.params.dx + SHARED_LAYOUT_REFINE.dxMin,
      bestSharedLayout.params.dx + SHARED_LAYOUT_REFINE.dxMax,
      SHARED_LAYOUT_REFINE.dxStep
    );
    const dyValues = makeRange(
      bestSharedLayout.params.dy + SHARED_LAYOUT_REFINE.dyMin,
      bestSharedLayout.params.dy + SHARED_LAYOUT_REFINE.dyMax,
      SHARED_LAYOUT_REFINE.dyStep
    );
    const layoutScaleValues = makeRange(
      bestSharedLayout.params.layoutScale + SHARED_LAYOUT_REFINE.layoutScaleDeltaMin,
      bestSharedLayout.params.layoutScale + SHARED_LAYOUT_REFINE.layoutScaleDeltaMax,
      SHARED_LAYOUT_REFINE.layoutScaleDeltaStep
    );
    const iconScaleValues = makeRange(
      bestSharedLayout.params.iconScale + SHARED_LAYOUT_REFINE.iconScaleDeltaMin,
      bestSharedLayout.params.iconScale + SHARED_LAYOUT_REFINE.iconScaleDeltaMax,
      SHARED_LAYOUT_REFINE.iconScaleDeltaStep
    );

    const total = dxValues.length * dyValues.length * layoutScaleValues.length * iconScaleValues.length;
    let current = 0;
    let best = null;

    for (const dx of dxValues) {
      for (const dy of dyValues) {
        for (const layoutScale of layoutScaleValues) {
          for (const iconScale of iconScaleValues) {
            current += 1;
            if (current % 500 === 0 || current === total) {
              printProgress('Shared layout refine', current, total);
            }
            const evaluation = evaluateLayout(sourceImage, { dx, dy, layoutScale, iconScale });
            if (isBetterLayout(evaluation, best)) {
              best = evaluation;
            }
          }
        }
      }
    }

    return best || bestSharedLayout;
  }

  function buildLocalCandidatePool(sourceImage, slotEntry, anchorRect) {
    const candidates = [];
    const dxValues = makeRange(LOCAL_REFINEMENT.dxMin, LOCAL_REFINEMENT.dxMax, LOCAL_REFINEMENT.dxStep);
    const dyValues = makeRange(LOCAL_REFINEMENT.dyMin, LOCAL_REFINEMENT.dyMax, LOCAL_REFINEMENT.dyStep);
    const widthDeltaValues = makeRange(LOCAL_REFINEMENT.widthDeltaMin, LOCAL_REFINEMENT.widthDeltaMax, LOCAL_REFINEMENT.widthDeltaStep);
    const heightDeltaValues = makeRange(LOCAL_REFINEMENT.heightDeltaMin, LOCAL_REFINEMENT.heightDeltaMax, LOCAL_REFINEMENT.heightDeltaStep);

    for (const dx of dxValues) {
      for (const dy of dyValues) {
        for (const widthDelta of widthDeltaValues) {
          for (const heightDelta of heightDeltaValues) {
            const candidateRect = {
              x: Math.round(anchorRect.x + dx),
              y: Math.round(anchorRect.y + dy),
              width: Math.max(1, Math.round(anchorRect.width + widthDelta)),
              height: Math.max(1, Math.round(anchorRect.height + heightDelta))
            };
            const evaluation = evaluateRect(sourceImage, slotEntry.templatePath, candidateRect);
            if (!evaluation.valid) continue;
            candidates.push({
              slot: slotEntry.slot,
              name: slotEntry.name,
              templatePath: slotEntry.templatePath,
              baseRect: candidateRect,
              scaledRect: evaluation.scaledRect,
              score: evaluation.score,
              adjustmentMagnitude: Math.abs(dx) + Math.abs(dy) + Math.abs(widthDelta) + Math.abs(heightDelta),
              anchorRect
            });
          }
        }
      }
    }

    candidates.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.adjustmentMagnitude - b.adjustmentMagnitude;
    });

    return candidates.slice(0, LOCAL_REFINEMENT.keepTopN);
  }

  function respectsConstraintsWithExisting(candidate, chosenRects, constraints, slotIndex, fallbackRects) {
    const rects = [];
    for (let index = 0; index < EXPECTED_TALENTS.length; index += 1) {
      if (index === slotIndex) {
        rects.push(candidate.baseRect);
      } else if (chosenRects[index]) {
        rects.push(chosenRects[index]);
      } else {
        rects.push(fallbackRects[index]);
      }
    }

    if (!respectsOrderConstraints(rects, constraints)) {
      return false;
    }

    for (let i = 0; i < chosenRects.length; i += 1) {
      if (!chosenRects[i] || i === slotIndex) continue;
      if (rectsOverlap(candidate.baseRect, chosenRects[i])) {
        return false;
      }
    }
    return true;
  }

  function chooseBestLocalCombination(candidatePools, sharedRects) {
    const constraints = buildOrderConstraints(sharedRects);
    let best = null;

    function dfs(slotIndex, chosenCandidates, chosenRects, totalScore, totalAdjustment) {
      if (slotIndex === candidatePools.length) {
        const candidateResult = {
          candidates: [...chosenCandidates],
          rects: [...chosenRects],
          totalScore,
          averageScore: totalScore / candidatePools.length,
          totalAdjustment
        };
        if (
          !best ||
          candidateResult.totalScore > best.totalScore ||
          (candidateResult.totalScore === best.totalScore && candidateResult.totalAdjustment < best.totalAdjustment)
        ) {
          best = candidateResult;
        }
        return;
      }

      for (const candidate of candidatePools[slotIndex]) {
        if (!respectsConstraintsWithExisting(candidate, chosenRects, constraints, slotIndex, sharedRects)) {
          continue;
        }
        chosenCandidates[slotIndex] = candidate;
        chosenRects[slotIndex] = candidate.baseRect;
        dfs(
          slotIndex + 1,
          chosenCandidates,
          chosenRects,
          totalScore + candidate.score,
          totalAdjustment + candidate.adjustmentMagnitude
        );
        chosenCandidates[slotIndex] = null;
        chosenRects[slotIndex] = null;
      }
    }

    dfs(0, new Array(candidatePools.length).fill(null), new Array(candidatePools.length).fill(null), 0, 0);
    return best;
  }

  function evaluateRectList(sourceImage, rects) {
    const positions = EXPECTED_TALENTS.map((entry, index) => ({
      slot: entry.slot,
      name: entry.name,
      templatePath: entry.templatePath,
      ...evaluateRect(sourceImage, entry.templatePath, rects[index])
    }));
    const totalScore = positions.reduce((sum, entry) => sum + entry.score, 0);
    return {
      rects,
      positions,
      totalScore,
      averageScore: totalScore / positions.length,
      minScore: Math.min(...positions.map((entry) => entry.score))
    };
  }

  function writeCrops(sourceImage, baselineEvaluation, finalEvaluation, outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });

    return EXPECTED_TALENTS.map((entry, index) => {
      const baselinePath = path.join(outputDir, `slot-${entry.slot}-baseline.png`);
      const calibratedPath = path.join(outputDir, `slot-${entry.slot}-calibrated.png`);
      fs.writeFileSync(
        baselinePath,
        sourceImage.crop(normalizeCropRect(baselineEvaluation.positions[index].scaledRect)).toPNG()
      );
      fs.writeFileSync(
        calibratedPath,
        sourceImage.crop(normalizeCropRect(finalEvaluation.positions[index].scaledRect)).toPNG()
      );
      return {
        slot: entry.slot,
        baselineCropPath: baselinePath,
        calibratedCropPath: calibratedPath
      };
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function createAnnotatedImage(sourceImage, screenshotPath, baselineEvaluation, finalEvaluation, outputPath) {
    const { width, height } = sourceImage.getSize();
    const screenshotFileUrl = pathToFileURL(screenshotPath).href;
    const overlayHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: ${width}px;
      height: ${height}px;
      overflow: hidden;
      background: #000;
      font-family: Arial, Helvetica, sans-serif;
    }
    .canvas {
      position: relative;
      width: ${width}px;
      height: ${height}px;
    }
    .canvas img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }
    .circle {
      position: absolute;
      box-sizing: border-box;
      border-radius: 999px;
    }
    .circle.baseline {
      border: 3px solid rgba(64, 156, 255, 0.95);
    }
    .circle.calibrated {
      border: 3px solid rgba(95, 221, 118, 0.95);
    }
    .label {
      position: absolute;
      min-width: 220px;
      padding: 4px 6px;
      border-radius: 6px;
      background: rgba(15, 15, 15, 0.88);
      color: #fff;
      font-size: 16px;
      line-height: 1.35;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <div class="canvas">
    <img id="screenshot" src="${screenshotFileUrl}" />
    ${EXPECTED_TALENTS.map((entry, index) => {
      const baselineRect = baselineEvaluation.positions[index].scaledRect;
      const finalRect = finalEvaluation.positions[index].scaledRect;
      const score = Math.round(finalEvaluation.positions[index].score * 100);
      const baselineScore = Math.round(baselineEvaluation.positions[index].score * 100);
      const labelLeft = Math.min(width - 240, Math.max(0, finalRect.x + finalRect.width + 8));
      const labelTop = Math.max(0, finalRect.y - 6);
      return `
        <div class="circle baseline" style="left:${baselineRect.x}px;top:${baselineRect.y}px;width:${baselineRect.width}px;height:${baselineRect.height}px;"></div>
        <div class="circle calibrated" style="left:${finalRect.x}px;top:${finalRect.y}px;width:${finalRect.width}px;height:${finalRect.height}px;"></div>
        <div class="label" style="left:${labelLeft}px;top:${labelTop}px;">${entry.slot}. ${escapeHtml(entry.name)} · ${score}% (base ${baselineScore}%)</div>
      `;
    }).join('\n')}
  </div>
  <script>
    window.__overlayReady = new Promise((resolve, reject) => {
      const img = document.getElementById('screenshot');
      if (!img) {
        reject(new Error('missing screenshot element'));
        return;
      }
      if (img.complete && img.naturalWidth > 0) {
        resolve(true);
        return;
      }
      img.addEventListener('load', () => resolve(true), { once: true });
      img.addEventListener('error', () => reject(new Error('failed to load screenshot image')), { once: true });
    });
  </script>
</body>
</html>`;

    const win = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      frame: false,
      transparent: false,
      webPreferences: {
        offscreen: false,
        backgroundThrottling: false
      }
    });

    const tempHtmlPath = path.join(path.dirname(outputPath), '.talent_geometry_overlay.html');

    try {
      fs.writeFileSync(tempHtmlPath, overlayHtml, 'utf8');
      await win.loadFile(tempHtmlPath);
      await win.webContents.executeJavaScript('window.__overlayReady');
      await new Promise((resolve) => setTimeout(resolve, 150));
      const captured = await win.capturePage();
      fs.writeFileSync(outputPath, captured.toPNG());
    } finally {
      win.destroy();
      if (fs.existsSync(tempHtmlPath)) {
        fs.unlinkSync(tempHtmlPath);
      }
    }
  }

  function printProgress(label, current, total) {
    const percent = Math.round((current / total) * 100);
    process.stderr.write(`\r${label}: ${current}/${total} (${percent}%)`);
    if (current >= total) {
      process.stderr.write('\n');
    }
  }

  function formatEvaluationForReport(evaluation) {
    return {
      params: evaluation.params || null,
      totalScore: roundNumber(evaluation.totalScore),
      averageScore: roundNumber(evaluation.averageScore),
      minScore: roundNumber(evaluation.minScore),
      positions: evaluation.positions.map((entry) => ({
        slot: entry.slot,
        name: entry.name,
        rect: entry.baseRect,
        scaledRect: entry.scaledRect,
        score: roundNumber(entry.score)
      }))
    };
  }

  async function run() {
    const defaultScreenshotPath = findDefaultScreenshotPath();
    const screenshotPath = resolveInputPath(process.argv[2], defaultScreenshotPath);

    if (!fs.existsSync(screenshotPath)) {
      throw new Error(`Screenshot not found: ${screenshotPath}`);
    }

    const screenshot = nativeImage.createFromPath(screenshotPath);
    if (screenshot.isEmpty()) {
      throw new Error(`Failed to load screenshot: ${screenshotPath}`);
    }

    EXPECTED_TALENTS.forEach((entry) => {
      if (!fs.existsSync(entry.templatePath)) {
        throw new Error(`Missing template for ${entry.name}: ${entry.templatePath}`);
      }
    });

    const baselineEvaluation = evaluateRectList(screenshot, BASE_TALENT_RECTS.map((rect) => ({ ...rect })));

    const coarseSharedLayout = searchSharedLayout(screenshot, SHARED_LAYOUT_COARSE);
    if (!coarseSharedLayout) {
      throw new Error('No valid shared-layout result found in coarse search');
    }

    const refinedSharedLayout = refineSharedLayout(screenshot, coarseSharedLayout);
    if (!refinedSharedLayout) {
      throw new Error('Shared-layout refinement failed');
    }

    const sharedCandidatePools = EXPECTED_TALENTS.map((entry, index) => (
      buildLocalCandidatePool(screenshot, entry, refinedSharedLayout.rects[index])
    ));

    if (sharedCandidatePools.some((pool) => pool.length === 0)) {
      throw new Error('Local refinement produced an empty candidate pool for at least one slot');
    }

    const bestLocalCombination = chooseBestLocalCombination(sharedCandidatePools, refinedSharedLayout.rects);
    if (!bestLocalCombination) {
      throw new Error('Failed to find a valid constrained local refinement combination');
    }

    const finalRefinedEvaluation = evaluateRectList(screenshot, bestLocalCombination.rects);
    const cropOutputs = writeCrops(screenshot, baselineEvaluation, finalRefinedEvaluation, DEFAULT_CROPS_DIR);
    const cropPathBySlot = new Map(cropOutputs.map((entry) => [entry.slot, entry]));

    const positions = EXPECTED_TALENTS.map((entry, index) => {
      const baselinePosition = baselineEvaluation.positions[index];
      const sharedPosition = refinedSharedLayout.positions[index];
      const finalPosition = finalRefinedEvaluation.positions[index];
      const cropInfo = cropPathBySlot.get(entry.slot) || {};
      return {
        slot: entry.slot,
        name: entry.name,
        baselineRect: entry.baselineRect,
        rect: finalPosition.baseRect,
        baselineScaledRect: baselinePosition.scaledRect,
        scaledRect: finalPosition.scaledRect,
        baselineScore: roundNumber(baselinePosition.score),
        sharedLayoutRect: sharedPosition.baseRect,
        sharedLayoutScore: roundNumber(sharedPosition.score),
        score: roundNumber(finalPosition.score),
        scoreDelta: roundNumber(finalPosition.score - baselinePosition.score),
        sharedScoreDelta: roundNumber(sharedPosition.score - baselinePosition.score),
        baselineCropPath: cropInfo.baselineCropPath || null,
        calibratedCropPath: cropInfo.calibratedCropPath || null
      };
    });

    const report = {
      generatedAt: new Date().toISOString(),
      screenshotPath,
      expectedTalents: EXPECTED_TALENTS.map((entry) => ({
        slot: entry.slot,
        name: entry.name,
        templatePath: entry.templatePath
      })),
      searchSettings: {
        sharedLayoutCoarse: SHARED_LAYOUT_COARSE,
        sharedLayoutRefine: SHARED_LAYOUT_REFINE,
        localRefinement: LOCAL_REFINEMENT,
        thresholdReference: TALENT_THRESHOLD,
        scoringMode: 'center50-circle-mask'
      },
      baselineEvaluation: formatEvaluationForReport(baselineEvaluation),
      sharedLayoutResult: formatEvaluationForReport(refinedSharedLayout),
      finalRefinedResult: {
        totalScore: roundNumber(finalRefinedEvaluation.totalScore),
        averageScore: roundNumber(finalRefinedEvaluation.averageScore),
        minScore: roundNumber(finalRefinedEvaluation.minScore),
        totalAdjustment: roundNumber(bestLocalCombination.totalAdjustment),
        positions: positions.map((entry) => ({
          slot: entry.slot,
          name: entry.name,
          rect: entry.rect,
          score: entry.score,
          scoreDelta: entry.scoreDelta
        }))
      },
      positions,
      recommendedDetectorConfig: {
        baseScreenWidth: BASE_SCREEN_WIDTH,
        baseScreenHeight: BASE_SCREEN_HEIGHT,
        scoringMode: 'center50-circle-mask',
        talentThreshold: TALENT_THRESHOLD,
        baseTalentRects: positions.map((entry) => entry.rect)
      }
    };

    fs.writeFileSync(DEFAULT_REPORT_PATH, JSON.stringify(report, null, 2));
    await createAnnotatedImage(screenshot, screenshotPath, baselineEvaluation, finalRefinedEvaluation, DEFAULT_ANNOTATED_PATH);
    process.stdout.write(`${DEFAULT_REPORT_PATH}\n${DEFAULT_ANNOTATED_PATH}\n`);
  }

  app.whenReady().then(async () => {
    try {
      await run();
      app.exit(0);
    } catch (error) {
      process.stderr.write(`${error.stack || error.message}\n`);
      app.exit(1);
    }
  });
}
