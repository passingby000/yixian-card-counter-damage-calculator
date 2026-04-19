const fs = require('fs');
const path = require('path');
const electronModule = require('electron');

if (typeof electronModule === 'string') {
  const { spawn } = require('child_process');
  const runnerAppDir = path.join(__dirname, 'electron_runner_app');
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    electronModule,
    [runnerAppDir, __filename, ...process.argv.slice(2)],
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

  const handleTerminationSignal = (signalName) => {
    process.on(signalName, () => {
      if (!child.killed) {
        child.kill(signalName);
      }
    });
  };

  handleTerminationSignal('SIGINT');
  handleTerminationSignal('SIGTERM');
} else {
  const { app, nativeImage } = electronModule;

  const ROOT_DIR = path.resolve(__dirname, '..', '..');
  const CONFIG_PATH = path.join(ROOT_DIR, 'slot_detector_config.json');
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  const BASE_SCREEN_WIDTH = config.baseScreenWidth;
  const BASE_SCREEN_HEIGHT = config.baseScreenHeight;
  const BASE_SLOT_X_POSITIONS = config.slotXPositions;
  const BASE_SLOT_Y = config.slotY;
  const BASE_SLOT_WIDTH = config.slotWidth;
  const BASE_SLOT_HEIGHT = config.slotHeight;
  const STABLE_REGIONS = config.stableRegions;

  const SEASONAL_IMAGES_DIR = path.join(ROOT_DIR, 'images', 'seasonal');

  const DEFAULT_SCREENSHOT_PATH = path.join(__dirname, 'dream position recalibrate.png');
  const DEFAULT_TRUTH_PATH = path.join(__dirname, 'dreamrecalibratecards.txt');
  const DEFAULT_REPORT_PATH = path.join(__dirname, 'dream_geometry_report.json');
  const DEFAULT_CROPS_DIR = path.join(__dirname, 'dream_geometry_debug_slots');

  const PASS1_SEARCH = {
    xOffsetMin: -40,
    xOffsetMax: 40,
    xOffsetStep: 8,
    yOffsetMin: -40,
    yOffsetMax: 40,
    yOffsetStep: 8,
    widthDeltaMin: -24,
    widthDeltaMax: 24,
    widthDeltaStep: 8,
    heightDeltaMin: -32,
    heightDeltaMax: 32,
    heightDeltaStep: 8
  };

  const PASS2_X_REFINEMENT = {
    min: -18,
    max: 18,
    step: 1
  };

  const SCALE_REFINEMENT = {
    min: 0.94,
    max: 1.06,
    step: 0.002
  };

  const DREAM_NAME_ALIASES = {
    '梦•星轨推演': '梦•星轨推衍'
  };

  const originalTemplateCache = new Map();
  const resizedTemplateCache = new Map();

  function normalizeCardName(name) {
    return String(name || '').replace(/[·•]/g, '•').trim();
  }

  function applyDreamNameAlias(name) {
    const normalized = normalizeCardName(name);
    return DREAM_NAME_ALIASES[normalized] || normalized;
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

function parseDreamTemplateFilename(filePath) {
  const fileName = path.basename(filePath, '.png');
  const match = fileName.match(/^(.*?)(\d+)$/u);
  if (!match) return null;

  const baseName = applyDreamNameAlias(match[1]);
  const phase = Number.parseInt(match[2], 10);
  if (!baseName.startsWith('梦')) return null;
  if (!Number.isFinite(phase)) return null;

  return {
    baseName,
    phase,
    filePath,
    fileName: path.basename(filePath)
  };
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

function getResizedTemplate(filePath, width, height) {
  const cacheKey = `${filePath}|${width}|${height}`;
  if (resizedTemplateCache.has(cacheKey)) {
    return resizedTemplateCache.get(cacheKey);
  }
  const resized = loadOriginalTemplate(filePath).resize({
    width,
    height,
    quality: 'best'
  });
  resizedTemplateCache.set(cacheKey, resized);
  return resized;
}

function buildDreamTemplateLibrary() {
  const library = new Map();
  const files = walkDir(SEASONAL_IMAGES_DIR);

  files.forEach((filePath) => {
    const parsed = parseDreamTemplateFilename(filePath);
    if (!parsed) return;

    const entry = library.get(parsed.baseName) || {};
    entry[parsed.phase] = {
      filePath: parsed.filePath,
      fileName: parsed.fileName
    };
    library.set(parsed.baseName, entry);
  });

  return library;
}

function parseTruthFile(truthPath, templateLibrary) {
  const raw = fs.readFileSync(truthPath, 'utf8');
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length !== BASE_SLOT_X_POSITIONS.length) {
    throw new Error(`Expected ${BASE_SLOT_X_POSITIONS.length} truth lines in ${truthPath}, found ${lines.length}`);
  }

  return lines.map((line, index) => {
    const match = line.match(/^(.*?)(\d+)$/u);
    if (!match) {
      throw new Error(`Invalid truth line ${index + 1}: ${line}`);
    }

    const name = applyDreamNameAlias(match[1]);
    const phase = Number.parseInt(match[2], 10);
    if (!name.startsWith('梦')) {
      throw new Error(`Truth line ${index + 1} is not a dream card: ${line}`);
    }

    const phaseMap = templateLibrary.get(name);
    if (!phaseMap || !phaseMap[phase]) {
      throw new Error(`Missing seasonal dream template for ${name}${phase}`);
    }

    const adjacentPhases = [];
    if (phaseMap[phase - 1]) adjacentPhases.push(phase - 1);
    if (phaseMap[phase + 1]) adjacentPhases.push(phase + 1);

    return {
      slotIndex: index,
      originalLine: line,
      normalizedName: name,
      expectedPhase: phase,
      expectedTemplate: phaseMap[phase],
      adjacentTemplates: adjacentPhases.map((adjacentPhase) => ({
        phase: adjacentPhase,
        ...phaseMap[adjacentPhase]
      }))
    };
  });
}

function buildScaledRect(sourceImage, x, y, width, height) {
  const size = sourceImage.getSize();
  const scaleX = size.width / BASE_SCREEN_WIDTH;
  const scaleY = size.height / BASE_SCREEN_HEIGHT;
  return {
    x: Math.round(x * scaleX),
    y: Math.round(y * scaleY),
    width: Math.max(1, Math.round(width * scaleX)),
    height: Math.max(1, Math.round(height * scaleY))
  };
}

function cropAndResize(sourceImage, rect, targetWidth, targetHeight) {
  const imageSize = sourceImage.getSize();
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.x + rect.width > imageSize.width ||
    rect.y + rect.height > imageSize.height
  ) {
    return null;
  }

  return sourceImage.crop(rect).resize({
    width: targetWidth,
    height: targetHeight,
    quality: 'best'
  });
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

function makeRange(min, max, step) {
  const values = [];
  for (let value = min; value <= max; value += step) {
    values.push(value);
  }
  return values;
}

function buildGeometry(xOffset, yOffset, widthDelta, heightDelta, scale = 1) {
  const baseWidth = BASE_SLOT_WIDTH + widthDelta;
  const baseHeight = BASE_SLOT_HEIGHT + heightDelta;
  return {
    slotXPositions: BASE_SLOT_X_POSITIONS.map((x) => x + xOffset),
    slotY: BASE_SLOT_Y + yOffset,
    slotWidth: Math.round(baseWidth * scale),
    slotHeight: Math.round(baseHeight * scale),
    xOffset,
    yOffset,
    widthDelta,
    heightDelta,
    scale
  };
}

function evaluateTruthSlot(sourceImage, truthEntry, geometry, slotX) {
  const rect = buildScaledRect(
    sourceImage,
    slotX,
    geometry.slotY,
    geometry.slotWidth,
    geometry.slotHeight
  );
  const resizedCrop = cropAndResize(sourceImage, rect, geometry.slotWidth, geometry.slotHeight);
  if (!resizedCrop) {
    return {
      valid: false,
      rect,
      exactScore: Number.POSITIVE_INFINITY,
      adjacentPhaseComparisons: [],
      phaseSeparation: Number.NEGATIVE_INFINITY
    };
  }

  const exactTemplate = getResizedTemplate(
    truthEntry.expectedTemplate.filePath,
    geometry.slotWidth,
    geometry.slotHeight
  );
  const exactMetrics = compareImages(resizedCrop, exactTemplate);
  const adjacentPhaseComparisons = truthEntry.adjacentTemplates.map((adjacent) => {
    const adjacentTemplate = getResizedTemplate(
      adjacent.filePath,
      geometry.slotWidth,
      geometry.slotHeight
    );
    const adjacentMetrics = compareImages(resizedCrop, adjacentTemplate);
    return {
      phase: adjacent.phase,
      templateFile: adjacent.fileName,
      rgbMse: adjacentMetrics.rgbMse
    };
  });

  const bestAdjacentScore = adjacentPhaseComparisons.length > 0
    ? Math.min(...adjacentPhaseComparisons.map((entry) => entry.rgbMse))
    : Number.NaN;

  return {
    valid: true,
    rect,
    exactScore: exactMetrics.rgbMse,
    adjacentPhaseComparisons,
    phaseSeparation: Number.isFinite(bestAdjacentScore)
      ? (bestAdjacentScore - exactMetrics.rgbMse)
      : Number.POSITIVE_INFINITY
  };
}

function roundNumber(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : value;
}

function evaluateGeometry(sourceImage, truthEntries, geometry) {
  const perSlot = truthEntries.map((truthEntry, slotIndex) => {
    const slotX = geometry.slotXPositions[slotIndex];
    return {
      slotIndex,
      expectedName: truthEntry.normalizedName,
      expectedPhase: truthEntry.expectedPhase,
      templateFile: truthEntry.expectedTemplate.fileName,
      ...evaluateTruthSlot(sourceImage, truthEntry, geometry, slotX)
    };
  });

  const totalExactScore = perSlot.reduce((sum, slot) => sum + slot.exactScore, 0);
  const totalPhaseSeparation = perSlot.reduce((sum, slot) => (
    Number.isFinite(slot.phaseSeparation) ? sum + slot.phaseSeparation : sum
  ), 0);

  return {
    geometry: {
      slotXPositions: geometry.slotXPositions,
      slotY: geometry.slotY,
      slotWidth: geometry.slotWidth,
      slotHeight: geometry.slotHeight,
      xOffset: geometry.xOffset,
      yOffset: geometry.yOffset,
      widthDelta: geometry.widthDelta,
      heightDelta: geometry.heightDelta,
      scale: geometry.scale
    },
    totalExactScore,
    totalPhaseSeparation,
    averageExactScore: totalExactScore / perSlot.length,
    perSlot
  };
}

function isBetterEvaluation(nextEvaluation, currentBest) {
  if (!currentBest) return true;
  if (nextEvaluation.totalExactScore !== currentBest.totalExactScore) {
    return nextEvaluation.totalExactScore < currentBest.totalExactScore;
  }
  return nextEvaluation.totalPhaseSeparation > currentBest.totalPhaseSeparation;
}

function refineSlotXPositions(sourceImage, truthEntries, coarseGeometry) {
  return BASE_SLOT_X_POSITIONS.map((_, slotIndex) => {
    const truthEntry = truthEntries[slotIndex];
    const baseX = coarseGeometry.slotXPositions[slotIndex];
    let best = null;

    for (const delta of makeRange(PASS2_X_REFINEMENT.min, PASS2_X_REFINEMENT.max, PASS2_X_REFINEMENT.step)) {
      const slotX = baseX + delta;
      const evaluation = evaluateTruthSlot(sourceImage, truthEntry, coarseGeometry, slotX);
      const candidate = { slotX, ...evaluation };
      if (!best) {
        best = candidate;
        continue;
      }
      if (candidate.exactScore < best.exactScore) {
        best = candidate;
        continue;
      }
      if (candidate.exactScore === best.exactScore && candidate.phaseSeparation > best.phaseSeparation) {
        best = candidate;
      }
    }

    return {
      slotIndex,
      slotX: best.slotX,
      exactScore: best.exactScore,
      phaseSeparation: best.phaseSeparation,
      rect: best.rect
    };
  });
}

function writeWinningCrops(sourceImage, evaluation, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });

  return evaluation.perSlot.map((slot) => {
    const rawCrop = sourceImage.crop(slot.rect);
    const cropPath = path.join(outputDir, `slot-${slot.slotIndex + 1}.png`);
    fs.writeFileSync(cropPath, rawCrop.toPNG());
    return {
      slotIndex: slot.slotIndex,
      cropPath
    };
  });
}

function formatEvaluationForReport(evaluation, cropOutputs = []) {
  const cropPathBySlot = new Map(cropOutputs.map((entry) => [entry.slotIndex, entry.cropPath]));
  return {
    geometry: evaluation.geometry,
    totalExactScore: roundNumber(evaluation.totalExactScore),
    totalPhaseSeparation: roundNumber(evaluation.totalPhaseSeparation),
    averageExactScore: roundNumber(evaluation.averageExactScore),
    perSlot: evaluation.perSlot.map((slot) => ({
      slotIndex: slot.slotIndex,
      expectedName: slot.expectedName,
      expectedPhase: slot.expectedPhase,
      templateFile: slot.templateFile,
      rect: slot.rect,
      exactScore: roundNumber(slot.exactScore),
      phaseSeparation: roundNumber(slot.phaseSeparation),
      adjacentPhaseComparisons: slot.adjacentPhaseComparisons.map((adjacent) => ({
        phase: adjacent.phase,
        templateFile: adjacent.templateFile,
        rgbMse: roundNumber(adjacent.rgbMse),
        differenceFromExact: roundNumber(adjacent.rgbMse - slot.exactScore)
      })),
      cropPath: cropPathBySlot.get(slot.slotIndex) || null
    }))
  };
}

function buildBaselineEvaluation(sourceImage, truthEntries) {
  return evaluateGeometry(sourceImage, truthEntries, {
    slotXPositions: [...BASE_SLOT_X_POSITIONS],
    slotY: BASE_SLOT_Y,
    slotWidth: BASE_SLOT_WIDTH,
    slotHeight: BASE_SLOT_HEIGHT,
    xOffset: 0,
    yOffset: 0,
    widthDelta: 0,
    heightDelta: 0,
    scale: 1
  });
}

function refineScale(sourceImage, truthEntries, coarseGeometry) {
  let best = null;

  for (const scale of makeRange(SCALE_REFINEMENT.min, SCALE_REFINEMENT.max, SCALE_REFINEMENT.step)) {
    const geometry = buildGeometry(
      coarseGeometry.xOffset,
      coarseGeometry.yOffset,
      coarseGeometry.widthDelta,
      coarseGeometry.heightDelta,
      scale
    );

    if (geometry.slotWidth <= 0 || geometry.slotHeight <= 0) {
      continue;
    }

    const evaluation = evaluateGeometry(sourceImage, truthEntries, geometry);
    if (isBetterEvaluation(evaluation, best)) {
      best = evaluation;
    }
  }

  return best || evaluateGeometry(sourceImage, truthEntries, coarseGeometry);
}

function printProgress(current, total, label) {
  const percent = Math.round((current / total) * 100);
  process.stderr.write(`\r${label}: ${current}/${total} (${percent}%)`);
  if (current === total) {
    process.stderr.write('\n');
  }
}

async function run() {
  const screenshotPath = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : DEFAULT_SCREENSHOT_PATH;
  const truthPath = process.argv[3]
    ? path.resolve(process.cwd(), process.argv[3])
    : DEFAULT_TRUTH_PATH;

  if (!fs.existsSync(screenshotPath)) {
    throw new Error(`Screenshot not found: ${screenshotPath}`);
  }
  if (!fs.existsSync(truthPath)) {
    throw new Error(`Truth file not found: ${truthPath}`);
  }

  const screenshot = nativeImage.createFromPath(screenshotPath);
  if (screenshot.isEmpty()) {
    throw new Error(`Failed to load screenshot: ${screenshotPath}`);
  }

  const templateLibrary = buildDreamTemplateLibrary();
  const truthEntries = parseTruthFile(truthPath, templateLibrary);
  const baselineEvaluation = buildBaselineEvaluation(screenshot, truthEntries);

  const xOffsets = makeRange(PASS1_SEARCH.xOffsetMin, PASS1_SEARCH.xOffsetMax, PASS1_SEARCH.xOffsetStep);
  const yOffsets = makeRange(PASS1_SEARCH.yOffsetMin, PASS1_SEARCH.yOffsetMax, PASS1_SEARCH.yOffsetStep);
  const widthDeltas = makeRange(PASS1_SEARCH.widthDeltaMin, PASS1_SEARCH.widthDeltaMax, PASS1_SEARCH.widthDeltaStep);
  const heightDeltas = makeRange(PASS1_SEARCH.heightDeltaMin, PASS1_SEARCH.heightDeltaMax, PASS1_SEARCH.heightDeltaStep);
  const pass1Total = xOffsets.length * yOffsets.length * widthDeltas.length * heightDeltas.length;

  let pass1Index = 0;
  let bestPass1 = null;

  for (const xOffset of xOffsets) {
    for (const yOffset of yOffsets) {
      for (const widthDelta of widthDeltas) {
        for (const heightDelta of heightDeltas) {
          pass1Index += 1;
          printProgress(pass1Index, pass1Total, 'Pass 1');

          const geometry = buildGeometry(xOffset, yOffset, widthDelta, heightDelta);
          if (geometry.slotWidth <= 0 || geometry.slotHeight <= 0) {
            continue;
          }

          const evaluation = evaluateGeometry(screenshot, truthEntries, geometry);
          if (isBetterEvaluation(evaluation, bestPass1)) {
            bestPass1 = evaluation;
          }
        }
      }
    }
  }

  if (!bestPass1) {
    throw new Error('Dream geometry search failed to find a valid coarse geometry');
  }

  const bestScaledEvaluation = refineScale(screenshot, truthEntries, bestPass1.geometry);

  const refinedSlotXPositions = refineSlotXPositions(screenshot, truthEntries, bestScaledEvaluation.geometry)
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .map((entry) => entry.slotX);

  const finalGeometry = {
    ...bestScaledEvaluation.geometry,
    slotXPositions: refinedSlotXPositions
  };
  const winningEvaluation = evaluateGeometry(screenshot, truthEntries, finalGeometry);
  const cropOutputs = writeWinningCrops(screenshot, winningEvaluation, DEFAULT_CROPS_DIR);

  const report = {
    generatedAt: new Date().toISOString(),
    screenshotPath,
    truthPath,
    seasonalImagesDir: SEASONAL_IMAGES_DIR,
    aliasMap: DREAM_NAME_ALIASES,
    searchSettings: {
      pass1: PASS1_SEARCH,
      scaleRefinement: SCALE_REFINEMENT,
      pass2XRefinement: PASS2_X_REFINEMENT
    },
    truthEntries: truthEntries.map((entry) => ({
      slotIndex: entry.slotIndex,
      originalLine: entry.originalLine,
      normalizedName: entry.normalizedName,
      expectedPhase: entry.expectedPhase,
      templateFile: entry.expectedTemplate.fileName,
      adjacentTemplates: entry.adjacentTemplates.map((adjacent) => ({
        phase: adjacent.phase,
        templateFile: adjacent.fileName
      }))
    })),
    baselineEvaluation: formatEvaluationForReport(baselineEvaluation),
    coarseBestEvaluation: formatEvaluationForReport(bestPass1),
    scaledBestEvaluation: formatEvaluationForReport(bestScaledEvaluation),
    winningEvaluation: formatEvaluationForReport(winningEvaluation, cropOutputs),
    improvementVsBaseline: {
      totalExactScoreDelta: roundNumber(baselineEvaluation.totalExactScore - winningEvaluation.totalExactScore),
      averageExactScoreDelta: roundNumber(baselineEvaluation.averageExactScore - winningEvaluation.averageExactScore)
    }
  };

  fs.writeFileSync(DEFAULT_REPORT_PATH, JSON.stringify(report, null, 2));
  process.stdout.write(`${DEFAULT_REPORT_PATH}\n`);
}

  app.whenReady().then(async () => {
    try {
      await run();
      app.exit(0);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      app.exit(1);
    }
  });
}
