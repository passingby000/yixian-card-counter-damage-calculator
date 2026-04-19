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
  const INPUT_DIR = path.join(__dirname, 'images to detect');
  const RESULTS_DIR = path.join(__dirname, 'results');
  const TEMPLATE_DIR = path.join(ROOT_DIR, 'images', 'seasonal', 'cloud-spirit');
  const CONFIG_PATH = path.join(ROOT_DIR, 'slot_detector_config.json');
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const STABLE_REGIONS = config.stableRegions;

  const TARGET_NAME = '梦·灵气灌注';
  const TARGET_TEMPLATE_NAME = '梦•灵气灌注';
  const TARGET_PHASES = [1, 2, 3, 4, 5];
  const ACCEPT_THRESHOLD = 2200;
  const COARSE_KEEP = 24;
  const REFINE_KEEP = 16;
  const FINAL_KEEP = 12;
  const COARSE_SIZE = { width: 24, height: 40 };
  const REFINE_SIZE = { width: 96, height: 162 };
  const FINAL_SIZE = { width: 200, height: 336 };
  const COARSE_SCALE_MIN = 0.70;
  const COARSE_SCALE_MAX = 1.05;
  const COARSE_SCALE_STEP = 0.025;
  const COARSE_STRIDE = 10;
  const REFINE_SCALE_WINDOW = 0.03;
  const REFINE_SCALE_STEP = 0.005;
  const REFINE_XY_WINDOW = 16;
  const REFINE_STRIDE = 2;
  const FINAL_XY_WINDOW = 3;
  const FINAL_STRIDE = 1;
  const COARSE_WINDOW_PADDING = 36;
  const COARSE_SCALE_WINDOW = 0.12;
  const ROW_FALLBACK_Y_WINDOW = 90;
  const CANDIDATE_DEDUPE_IOU = 0.35;
  const FINAL_MAX_OVERLAP_IOU = 0.10;
  const CANDIDATE_BOX_EXPANSION = 72;
  const CANDIDATE_BOX_MIN_HEIGHT = 400;
  const CANDIDATE_BOX_MIN_WIDTH = 240;
  const CANDIDATE_BOX_MAX_ASPECT = 0.78;
  const CANDIDATE_BOX_MIN_ASPECT = 0.42;
  const CANDIDATE_DOWNSCALE_WIDTH = 720;
  const CANDIDATE_BRIGHTNESS_THRESHOLD = 102;
  const CANDIDATE_MIN_COMPONENT_AREA = 900;
  const PHASE_COLORS = {
    1: { r: 244, g: 95, b: 83 },
    2: { r: 243, g: 161, b: 58 },
    3: { r: 65, g: 176, b: 110 },
    4: { r: 67, g: 146, b: 236 },
    5: { r: 165, g: 105, b: 245 }
  };
  const FONT = {
    P: [
      '11110',
      '10001',
      '10001',
      '11110',
      '10000',
      '10000',
      '10000'
    ],
    1: [
      '00100',
      '01100',
      '00100',
      '00100',
      '00100',
      '00100',
      '01110'
    ],
    2: [
      '01110',
      '10001',
      '00001',
      '00010',
      '00100',
      '01000',
      '11111'
    ],
    3: [
      '11110',
      '00001',
      '00001',
      '01110',
      '00001',
      '00001',
      '11110'
    ],
    4: [
      '00010',
      '00110',
      '01010',
      '10010',
      '11111',
      '00010',
      '00010'
    ],
    5: [
      '11111',
      '10000',
      '10000',
      '11110',
      '00001',
      '00001',
      '11110'
    ]
  };

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

  function resolveInputImages(inputArg) {
    const resolved = inputArg
      ? (path.isAbsolute(inputArg) ? inputArg : path.resolve(process.cwd(), inputArg))
      : INPUT_DIR;
    const stats = fs.statSync(resolved);
    if (stats.isDirectory()) {
      return walkDir(resolved).sort();
    }
    return [resolved];
  }

  function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  function sanitizeFilePart(name) {
    return String(name || '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function roundNumber(value) {
    return Number.isFinite(value) ? Number(value.toFixed(4)) : value;
  }

  function normalizeDisplayName(name) {
    return String(name || '').replace(/[•·]/g, '·').trim();
  }

  function getTemplatePreferenceScore(filePath) {
    const fileName = path.basename(filePath);
    let score = 0;
    if (fileName.includes('•')) score += 2;
    if (!fileName.includes('·')) score += 1;
    return score;
  }

  function parseTargetPhaseTemplate(filePath) {
    const fileName = path.basename(filePath, '.png');
    const match = fileName.match(/^(.*?)(\d+)$/u);
    if (!match) return null;
    const normalized = match[1].replace(/[·•]/g, '•').trim();
    if (normalized !== TARGET_TEMPLATE_NAME) return null;
    const phase = Number.parseInt(match[2], 10);
    if (!TARGET_PHASES.includes(phase)) return null;
    return { phase, filePath, fileName: path.basename(filePath) };
  }

  function imageToRgbData(image) {
    const bitmap = image.toBitmap();
    const { width, height } = image.getSize();
    return { bitmap, width, height };
  }

  function buildRegionBounds(width, height) {
    return STABLE_REGIONS.map((region) => {
      const x0 = Math.max(0, Math.floor(region.x * width));
      const y0 = Math.max(0, Math.floor(region.y * height));
      const x1 = Math.min(width, Math.ceil((region.x + region.width) * width));
      const y1 = Math.min(height, Math.ceil((region.y + region.height) * height));
      return {
        x0,
        y0,
        x1,
        y1,
        weight: region.weight
      };
    });
  }

  function sampleRectToRgb(sourceData, rect, targetWidth, targetHeight) {
    const rgb = new Float32Array(targetWidth * targetHeight * 3);
    const xScale = rect.width / targetWidth;
    const yScale = rect.height / targetHeight;

    for (let ty = 0; ty < targetHeight; ty += 1) {
      const sourceY = Math.min(sourceData.height - 1, rect.y + Math.floor((ty + 0.5) * yScale));
      for (let tx = 0; tx < targetWidth; tx += 1) {
        const sourceX = Math.min(sourceData.width - 1, rect.x + Math.floor((tx + 0.5) * xScale));
        const sourceIndex = ((sourceY * sourceData.width) + sourceX) * 4;
        const targetIndex = ((ty * targetWidth) + tx) * 3;
        rgb[targetIndex] = sourceData.bitmap[sourceIndex + 2];
        rgb[targetIndex + 1] = sourceData.bitmap[sourceIndex + 1];
        rgb[targetIndex + 2] = sourceData.bitmap[sourceIndex];
      }
    }

    return { rgb, width: targetWidth, height: targetHeight };
  }

  function compareRgbMse(sample, template, regionBounds) {
    let weightedTotal = 0;
    let totalWeight = 0;

    for (const region of regionBounds) {
      const count = Math.max(1, (region.x1 - region.x0) * (region.y1 - region.y0) * 3);
      let total = 0;
      for (let y = region.y0; y < region.y1; y += 1) {
        for (let x = region.x0; x < region.x1; x += 1) {
          const index = ((y * sample.width) + x) * 3;
          const dr = sample.rgb[index] - template.rgb[index];
          const dg = sample.rgb[index + 1] - template.rgb[index + 1];
          const db = sample.rgb[index + 2] - template.rgb[index + 2];
          total += (dr * dr) + (dg * dg) + (db * db);
        }
      }
      weightedTotal += (total / count) * region.weight;
      totalWeight += region.weight;
    }

    if (totalWeight === 0) {
      return Number.POSITIVE_INFINITY;
    }
    return weightedTotal / totalWeight;
  }

  function iou(a, b) {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    const intersectionWidth = Math.max(0, right - left);
    const intersectionHeight = Math.max(0, bottom - top);
    const intersection = intersectionWidth * intersectionHeight;
    if (intersection === 0) return 0;
    const union = (a.width * a.height) + (b.width * b.height) - intersection;
    return union <= 0 ? 0 : intersection / union;
  }

  function addCandidateWithDedupe(list, candidate, threshold, keepLimit) {
    const duplicateIndex = list.findIndex((existing) => iou(existing.rect, candidate.rect) > threshold);
    if (duplicateIndex >= 0) {
      if (candidate.score < list[duplicateIndex].score) {
        list[duplicateIndex] = candidate;
      }
    } else {
      list.push(candidate);
    }
    list.sort((a, b) => a.score - b.score);
    if (list.length > keepLimit) {
      list.length = keepLimit;
    }
  }

  function buildPhaseTemplates() {
    const preferredByPhase = new Map();
    walkDir(TEMPLATE_DIR).forEach((filePath) => {
      const parsed = parseTargetPhaseTemplate(filePath);
      if (!parsed) return;
      const existing = preferredByPhase.get(parsed.phase);
      if (!existing || getTemplatePreferenceScore(parsed.filePath) > getTemplatePreferenceScore(existing.filePath)) {
        preferredByPhase.set(parsed.phase, parsed);
      }
    });

    return TARGET_PHASES.map((phase) => {
      const selected = preferredByPhase.get(phase);
      if (!selected) {
        throw new Error(`Missing template for ${TARGET_NAME}${phase}`);
      }
      const originalImage = nativeImage.createFromPath(selected.filePath);
      if (originalImage.isEmpty()) {
        throw new Error(`Failed to load template image: ${selected.filePath}`);
      }
      const originalSize = originalImage.getSize();
      const resizedByStage = new Map();

      const getStageTemplate = (stageSize) => {
        const key = `${stageSize.width}x${stageSize.height}`;
        if (resizedByStage.has(key)) {
          return resizedByStage.get(key);
        }
        const resized = originalImage.resize({
          width: stageSize.width,
          height: stageSize.height,
          quality: 'best'
        });
        const value = {
          image: resized,
          rgb: sampleRectToRgb(imageToRgbData(resized), { x: 0, y: 0, width: stageSize.width, height: stageSize.height }, stageSize.width, stageSize.height),
          regionBounds: buildRegionBounds(stageSize.width, stageSize.height)
        };
        resizedByStage.set(key, value);
        return value;
      };

      return {
        phase,
        name: TARGET_NAME,
        templatePath: selected.filePath,
        templateFile: selected.fileName,
        originalImage,
        originalWidth: originalSize.width,
        originalHeight: originalSize.height,
        getStageTemplate
      };
    });
  }

  function findCandidateBoxes(sourceImage) {
    const sourceSize = sourceImage.getSize();
    const scale = CANDIDATE_DOWNSCALE_WIDTH / sourceSize.width;
    const thumbnailWidth = CANDIDATE_DOWNSCALE_WIDTH;
    const thumbnailHeight = Math.max(1, Math.round(sourceSize.height * scale));
    const thumbnail = sourceImage.resize({
      width: thumbnailWidth,
      height: thumbnailHeight,
      quality: 'best'
    });
    const thumbBitmap = thumbnail.toBitmap();
    const mask = new Uint8Array(thumbnailWidth * thumbnailHeight);

    for (let y = 0; y < thumbnailHeight; y += 1) {
      for (let x = 0; x < thumbnailWidth; x += 1) {
        const index = ((y * thumbnailWidth) + x) * 4;
        const b = thumbBitmap[index];
        const g = thumbBitmap[index + 1];
        const r = thumbBitmap[index + 2];
        const brightness = (0.114 * b) + (0.587 * g) + (0.299 * r);
        if (brightness >= CANDIDATE_BRIGHTNESS_THRESHOLD) {
          mask[(y * thumbnailWidth) + x] = 1;
        }
      }
    }

    const visited = new Uint8Array(thumbnailWidth * thumbnailHeight);
    const boxes = [];
    const queueX = [];
    const queueY = [];

    for (let y = 0; y < thumbnailHeight; y += 1) {
      for (let x = 0; x < thumbnailWidth; x += 1) {
        const startIndex = (y * thumbnailWidth) + x;
        if (!mask[startIndex] || visited[startIndex]) continue;

        let head = 0;
        queueX.length = 0;
        queueY.length = 0;
        queueX.push(x);
        queueY.push(y);
        visited[startIndex] = 1;

        let minX = x;
        let maxX = x;
        let minY = y;
        let maxY = y;
        let area = 0;

        while (head < queueX.length) {
          const currentX = queueX[head];
          const currentY = queueY[head];
          head += 1;
          area += 1;

          if (currentX < minX) minX = currentX;
          if (currentX > maxX) maxX = currentX;
          if (currentY < minY) minY = currentY;
          if (currentY > maxY) maxY = currentY;

          const neighbors = [
            [currentX - 1, currentY],
            [currentX + 1, currentY],
            [currentX, currentY - 1],
            [currentX, currentY + 1]
          ];
          for (const [nextX, nextY] of neighbors) {
            if (nextX < 0 || nextY < 0 || nextX >= thumbnailWidth || nextY >= thumbnailHeight) continue;
            const nextIndex = (nextY * thumbnailWidth) + nextX;
            if (!mask[nextIndex] || visited[nextIndex]) continue;
            visited[nextIndex] = 1;
            queueX.push(nextX);
            queueY.push(nextY);
          }
        }

        if (area < CANDIDATE_MIN_COMPONENT_AREA) continue;

        const downWidth = (maxX - minX) + 1;
        const downHeight = (maxY - minY) + 1;
        const aspect = downWidth / downHeight;
        if (aspect < CANDIDATE_BOX_MIN_ASPECT || aspect > CANDIDATE_BOX_MAX_ASPECT) continue;

        const fullRect = {
          x: Math.max(0, Math.round((minX / scale) - CANDIDATE_BOX_EXPANSION)),
          y: Math.max(0, Math.round((minY / scale) - CANDIDATE_BOX_EXPANSION)),
          width: Math.min(sourceSize.width, Math.round((downWidth / scale) + (CANDIDATE_BOX_EXPANSION * 2))),
          height: Math.min(sourceSize.height, Math.round((downHeight / scale) + (CANDIDATE_BOX_EXPANSION * 2)))
        };
        fullRect.width = Math.min(fullRect.width, sourceSize.width - fullRect.x);
        fullRect.height = Math.min(fullRect.height, sourceSize.height - fullRect.y);
        if (fullRect.width < CANDIDATE_BOX_MIN_WIDTH || fullRect.height < CANDIDATE_BOX_MIN_HEIGHT) continue;

        boxes.push(fullRect);
      }
    }

    boxes.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    const merged = [];
    for (const box of boxes) {
      const duplicateIndex = merged.findIndex((existing) => iou(existing, box) > 0.2);
      if (duplicateIndex >= 0) {
        const existing = merged[duplicateIndex];
        const unionLeft = Math.min(existing.x, box.x);
        const unionTop = Math.min(existing.y, box.y);
        const unionRight = Math.max(existing.x + existing.width, box.x + box.width);
        const unionBottom = Math.max(existing.y + existing.height, box.y + box.height);
        merged[duplicateIndex] = {
          x: unionLeft,
          y: unionTop,
          width: unionRight - unionLeft,
          height: unionBottom - unionTop
        };
      } else {
        merged.push(box);
      }
    }

    merged.sort((a, b) => {
      if (b.height !== a.height) {
        return b.height - a.height;
      }
      return (b.width * b.height) - (a.width * a.height);
    });
    return merged.slice(0, 16);
  }

  function buildCandidateSearchWindows(sourceSize, candidateBoxes, template) {
    if (!candidateBoxes || candidateBoxes.length === 0) {
      return [{
        xMin: 0,
        yMin: 0,
        xMax: sourceSize.width - 1,
        yMax: sourceSize.height - 1
      }];
    }

    const windows = candidateBoxes.map((box) => {
      const estimateScaleWidth = box.width / template.originalWidth;
      const estimateScaleHeight = box.height / template.originalHeight;
      const estimateScale = Math.max(COARSE_SCALE_MIN, Math.min(COARSE_SCALE_MAX, (estimateScaleWidth + estimateScaleHeight) / 2));
      const estimatedWidth = Math.max(1, Math.round(template.originalWidth * estimateScale));
      const estimatedHeight = Math.max(1, Math.round(template.originalHeight * estimateScale));
      return {
        xMin: Math.max(0, box.x - COARSE_WINDOW_PADDING),
        yMin: Math.max(0, box.y - COARSE_WINDOW_PADDING),
        xMax: Math.min(sourceSize.width - 1, box.x + Math.max(0, box.width - estimatedWidth) + COARSE_WINDOW_PADDING),
        yMax: Math.min(sourceSize.height - 1, box.y + Math.max(0, box.height - estimatedHeight) + COARSE_WINDOW_PADDING),
        estimateScale
      };
    });

    if (candidateBoxes.length < TARGET_PHASES.length && candidateBoxes.length >= 2) {
      const sortedBoxes = candidateBoxes.slice().sort((a, b) => a.x - b.x);
      const sortedY = candidateBoxes.map((box) => box.y).sort((a, b) => a - b);
      const medianY = sortedY[Math.floor(sortedY.length / 2)];
      const scaleEstimates = candidateBoxes
        .map((box) => {
          const widthScale = box.width / template.originalWidth;
          const heightScale = box.height / template.originalHeight;
          return Math.max(COARSE_SCALE_MIN, Math.min(COARSE_SCALE_MAX, (widthScale + heightScale) / 2));
        })
        .sort((a, b) => a - b);
      const medianScale = scaleEstimates[Math.floor(scaleEstimates.length / 2)];
      const sortedDiffs = [];
      for (let index = 1; index < sortedBoxes.length; index += 1) {
        sortedDiffs.push(sortedBoxes[index].x - sortedBoxes[index - 1].x);
      }
      sortedDiffs.sort((a, b) => a - b);
      const medianStep = sortedDiffs.length > 0
        ? sortedDiffs[Math.floor(sortedDiffs.length / 2)]
        : Math.round(template.originalWidth * medianScale);
      const typicalEstimatedWidth = Math.max(1, Math.round(template.originalWidth * medianScale));
      const typicalEstimatedHeight = Math.max(1, Math.round(template.originalHeight * medianScale));
      const predictedXs = [];
      let leftX = sortedBoxes[0].x - medianStep;
      let rightX = sortedBoxes[sortedBoxes.length - 1].x + medianStep;

      while ((sortedBoxes.length + predictedXs.length) < TARGET_PHASES.length) {
        const canAddRight = rightX <= (sourceSize.width - typicalEstimatedWidth + COARSE_WINDOW_PADDING);
        const canAddLeft = leftX >= -COARSE_WINDOW_PADDING;
        if (!canAddRight && !canAddLeft) {
          break;
        }
        if (canAddRight) {
          predictedXs.push(rightX);
          rightX += medianStep;
          if ((sortedBoxes.length + predictedXs.length) >= TARGET_PHASES.length) {
            break;
          }
        }
        if (canAddLeft) {
          predictedXs.unshift(leftX);
          leftX -= medianStep;
        }
      }

      for (const predictedX of predictedXs) {
        windows.push({
          xMin: Math.max(0, Math.round(predictedX - COARSE_WINDOW_PADDING)),
          yMin: Math.max(0, medianY - ROW_FALLBACK_Y_WINDOW),
          xMax: Math.min(sourceSize.width - 1, Math.round(predictedX + COARSE_WINDOW_PADDING)),
          yMax: Math.min(sourceSize.height - 1, medianY + ROW_FALLBACK_Y_WINDOW),
          estimateScale: medianScale
        });
      }
    } else if (candidateBoxes.length < TARGET_PHASES.length) {
      const sortedY = candidateBoxes.map((box) => box.y).sort((a, b) => a - b);
      const medianY = sortedY[Math.floor(sortedY.length / 2)];
      const scaleEstimates = candidateBoxes
        .map((box) => {
          const widthScale = box.width / template.originalWidth;
          const heightScale = box.height / template.originalHeight;
          return Math.max(COARSE_SCALE_MIN, Math.min(COARSE_SCALE_MAX, (widthScale + heightScale) / 2));
        })
        .sort((a, b) => a - b);
      const medianScale = scaleEstimates[Math.floor(scaleEstimates.length / 2)];
      windows.push({
        xMin: 0,
        yMin: Math.max(0, medianY - ROW_FALLBACK_Y_WINDOW),
        xMax: sourceSize.width - 1,
        yMax: Math.min(sourceSize.height - 1, medianY + ROW_FALLBACK_Y_WINDOW),
        estimateScale: medianScale
      });
    }

    return windows;
  }

  function clampRectToSource(rect, sourceSize) {
    if (rect.width <= 0 || rect.height <= 0) return null;
    if (rect.x < 0 || rect.y < 0) return null;
    if (rect.x + rect.width > sourceSize.width) return null;
    if (rect.y + rect.height > sourceSize.height) return null;
    return rect;
  }

  function runCoarseSearchForTemplate(sourceData, template, candidateBoxes) {
    const stageTemplate = template.getStageTemplate(COARSE_SIZE);
    const sourceSize = { width: sourceData.width, height: sourceData.height };
    const searchWindows = buildCandidateSearchWindows(sourceSize, candidateBoxes, template);
    const candidates = [];
    const coarseScales = [];
    for (let scale = COARSE_SCALE_MIN; scale <= (COARSE_SCALE_MAX + 0.0001); scale += COARSE_SCALE_STEP) {
      coarseScales.push(Number(scale.toFixed(4)));
    }

    for (const window of searchWindows) {
      const preferredScale = Number.isFinite(window.estimateScale) ? window.estimateScale : null;
      const orderedScales = coarseScales
        .slice()
        .filter((scale) => {
          if (preferredScale == null) return true;
          return Math.abs(scale - preferredScale) <= COARSE_SCALE_WINDOW;
        })
        .sort((a, b) => {
          if (preferredScale == null) return a - b;
          return Math.abs(a - preferredScale) - Math.abs(b - preferredScale);
        });

      for (const scale of orderedScales) {
        const rectWidth = Math.max(1, Math.round(template.originalWidth * scale));
        const rectHeight = Math.max(1, Math.round(template.originalHeight * scale));
        const xStart = window.xMin;
        const yStart = window.yMin;
        const xEnd = Math.min(sourceSize.width - rectWidth, window.xMax);
        const yEnd = Math.min(sourceSize.height - rectHeight, window.yMax);
        if (xEnd < xStart || yEnd < yStart) continue;

        for (let y = yStart; y <= yEnd; y += COARSE_STRIDE) {
          for (let x = xStart; x <= xEnd; x += COARSE_STRIDE) {
            const rect = { x, y, width: rectWidth, height: rectHeight };
            const sampled = sampleRectToRgb(sourceData, rect, COARSE_SIZE.width, COARSE_SIZE.height);
            const score = compareRgbMse(sampled, stageTemplate.rgb, stageTemplate.regionBounds);
            addCandidateWithDedupe(candidates, {
              phase: template.phase,
              name: template.name,
              score,
              rect,
              scale
            }, CANDIDATE_DEDUPE_IOU, COARSE_KEEP);
          }
        }
      }
    }

    return candidates;
  }

  function runRefineSearch(sourceData, template, coarseCandidates) {
    const stageTemplate = template.getStageTemplate(REFINE_SIZE);
    const candidates = [];
    const sourceSize = { width: sourceData.width, height: sourceData.height };

    for (const coarseCandidate of coarseCandidates) {
      const scaleMin = Math.max(COARSE_SCALE_MIN, coarseCandidate.scale - REFINE_SCALE_WINDOW);
      const scaleMax = Math.min(COARSE_SCALE_MAX, coarseCandidate.scale + REFINE_SCALE_WINDOW);
      for (let scale = scaleMin; scale <= (scaleMax + 0.0001); scale += REFINE_SCALE_STEP) {
        const roundedScale = Number(scale.toFixed(4));
        const rectWidth = Math.max(1, Math.round(template.originalWidth * roundedScale));
        const rectHeight = Math.max(1, Math.round(template.originalHeight * roundedScale));
        for (let y = coarseCandidate.rect.y - REFINE_XY_WINDOW; y <= coarseCandidate.rect.y + REFINE_XY_WINDOW; y += REFINE_STRIDE) {
          for (let x = coarseCandidate.rect.x - REFINE_XY_WINDOW; x <= coarseCandidate.rect.x + REFINE_XY_WINDOW; x += REFINE_STRIDE) {
            const rect = clampRectToSource({ x, y, width: rectWidth, height: rectHeight }, sourceSize);
            if (!rect) continue;
            const sampled = sampleRectToRgb(sourceData, rect, REFINE_SIZE.width, REFINE_SIZE.height);
            const score = compareRgbMse(sampled, stageTemplate.rgb, stageTemplate.regionBounds);
            addCandidateWithDedupe(candidates, {
              phase: template.phase,
              name: template.name,
              score,
              rect,
              scale: roundedScale
            }, CANDIDATE_DEDUPE_IOU, REFINE_KEEP);
          }
        }
      }
    }

    return candidates;
  }

  function runFinalRefine(sourceData, template, refineCandidates) {
    const stageTemplate = template.getStageTemplate(FINAL_SIZE);
    const candidates = [];
    const sourceSize = { width: sourceData.width, height: sourceData.height };

    for (const refineCandidate of refineCandidates) {
      const rectWidth = Math.max(1, Math.round(template.originalWidth * refineCandidate.scale));
      const rectHeight = Math.max(1, Math.round(template.originalHeight * refineCandidate.scale));
      for (let y = refineCandidate.rect.y - FINAL_XY_WINDOW; y <= refineCandidate.rect.y + FINAL_XY_WINDOW; y += FINAL_STRIDE) {
        for (let x = refineCandidate.rect.x - FINAL_XY_WINDOW; x <= refineCandidate.rect.x + FINAL_XY_WINDOW; x += FINAL_STRIDE) {
          const rect = clampRectToSource({ x, y, width: rectWidth, height: rectHeight }, sourceSize);
          if (!rect) continue;
          const sampled = sampleRectToRgb(sourceData, rect, FINAL_SIZE.width, FINAL_SIZE.height);
          const score = compareRgbMse(sampled, stageTemplate.rgb, stageTemplate.regionBounds);
          addCandidateWithDedupe(candidates, {
            phase: template.phase,
            name: template.name,
            score,
            rect,
            scale: refineCandidate.scale,
            templateFile: template.templateFile
          }, CANDIDATE_DEDUPE_IOU, FINAL_KEEP);
        }
      }
    }

    return candidates;
  }

  function chooseBestNonOverlappingSet(candidatesByPhase) {
    const phases = TARGET_PHASES.slice();
    let best = null;

    function visit(index, picked, totalScore) {
      if (index >= phases.length) {
        const result = {
          matches: picked.slice(),
          totalScore,
          count: picked.length
        };
        if (!best ||
            result.count > best.count ||
            (result.count === best.count && result.totalScore < best.totalScore)) {
          best = result;
        }
        return;
      }

      const phase = phases[index];
      const candidates = (candidatesByPhase.get(phase) || []).filter((candidate) => candidate.score <= ACCEPT_THRESHOLD);

      visit(index + 1, picked, totalScore);

      for (const candidate of candidates) {
        if (picked.some((existing) => iou(existing.rect, candidate.rect) >= FINAL_MAX_OVERLAP_IOU)) {
          continue;
        }
        picked.push(candidate);
        visit(index + 1, picked, totalScore + candidate.score);
        picked.pop();
      }
    }

    visit(0, [], 0);
    return best || { matches: [], totalScore: 0, count: 0 };
  }

  function setPixel(bitmap, width, height, x, y, color) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = ((y * width) + x) * 4;
    bitmap[index] = color.b;
    bitmap[index + 1] = color.g;
    bitmap[index + 2] = color.r;
    bitmap[index + 3] = 255;
  }

  function drawRect(bitmap, width, height, rect, color, thickness = 4) {
    for (let offset = 0; offset < thickness; offset += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        setPixel(bitmap, width, height, x, rect.y + offset, color);
        setPixel(bitmap, width, height, x, rect.y + rect.height - 1 - offset, color);
      }
      for (let y = rect.y; y < rect.y + rect.height; y += 1) {
        setPixel(bitmap, width, height, rect.x + offset, y, color);
        setPixel(bitmap, width, height, rect.x + rect.width - 1 - offset, y, color);
      }
    }
  }

  function drawFilledRect(bitmap, width, height, rect, color) {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        setPixel(bitmap, width, height, x, y, color);
      }
    }
  }

  function drawGlyph(bitmap, width, height, x, y, glyph, color) {
    const rows = FONT[glyph];
    if (!rows) return;
    rows.forEach((row, rowIndex) => {
      for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
        if (row[colIndex] !== '1') continue;
        setPixel(bitmap, width, height, x + colIndex, y + rowIndex, color);
      }
    });
  }

  function drawLabel(bitmap, width, height, x, y, label, boxColor) {
    const padding = 3;
    const glyphWidth = 5;
    const glyphHeight = 7;
    const gap = 1;
    const labelWidth = (label.length * glyphWidth) + ((label.length - 1) * gap);
    const bgRect = {
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: labelWidth + (padding * 2),
      height: glyphHeight + (padding * 2)
    };
    drawFilledRect(bitmap, width, height, bgRect, boxColor);
    const textColor = { r: 255, g: 255, b: 255 };
    let cursorX = bgRect.x + padding;
    for (const glyph of label.split('')) {
      drawGlyph(bitmap, width, height, cursorX, bgRect.y + padding, glyph, textColor);
      cursorX += glyphWidth + gap;
    }
  }

  function buildAnnotatedImage(sourceImage, matches) {
    const sourceSize = sourceImage.getSize();
    const bitmap = Buffer.from(sourceImage.toBitmap());
    for (const match of matches) {
      const color = PHASE_COLORS[match.phase] || { r: 255, g: 255, b: 255 };
      drawRect(bitmap, sourceSize.width, sourceSize.height, match.rect, color, 4);
      const labelY = Math.max(0, match.rect.y - 18);
      drawLabel(bitmap, sourceSize.width, sourceSize.height, match.rect.x, labelY, `P${match.phase}`, color);
    }
    return nativeImage.createFromBitmap(bitmap, {
      width: sourceSize.width,
      height: sourceSize.height
    });
  }

  function writeResultArtifacts(sourceImage, sourcePath, templates, finalSelection, candidatesByPhase, candidateBoxes) {
    const baseName = sanitizeFilePart(path.basename(sourcePath, path.extname(sourcePath)));
    const resultDir = path.join(RESULTS_DIR, baseName);
    const cropsDir = path.join(resultDir, 'crops');
    ensureDir(cropsDir);

    const matches = finalSelection.matches
      .slice()
      .sort((a, b) => a.phase - b.phase)
      .map((match) => {
        const cropPath = path.join(cropsDir, `${sanitizeFilePart(TARGET_NAME)}${match.phase}.png`);
        const cropImage = sourceImage.crop(match.rect);
        fs.writeFileSync(cropPath, cropImage.toPNG());
        return {
          name: TARGET_NAME,
          phase: match.phase,
          score: roundNumber(match.score),
          rect: match.rect,
          cropPath,
          templateFile: match.templateFile
        };
      });

    const missingPhases = TARGET_PHASES.filter((phase) => !matches.some((match) => match.phase === phase));
    const annotatedImage = buildAnnotatedImage(sourceImage, matches);
    const annotatedPath = path.join(resultDir, 'annotated.png');
    fs.writeFileSync(annotatedPath, annotatedImage.toPNG());

    const report = {
      generatedAt: new Date().toISOString(),
      sourceImage: sourcePath,
      annotatedImage: annotatedPath,
      templates: templates.map((template) => ({
        name: TARGET_NAME,
        phase: template.phase,
        templatePath: template.templatePath,
        templateFile: template.templateFile,
        originalWidth: template.originalWidth,
        originalHeight: template.originalHeight
      })),
      matches,
      missingPhases,
      candidateBoxCount: candidateBoxes.length,
      topCandidatesByPhase: TARGET_PHASES.map((phase) => ({
        name: TARGET_NAME,
        phase,
        candidates: (candidatesByPhase.get(phase) || []).slice(0, 10).map((candidate) => ({
          score: roundNumber(candidate.score),
          rect: candidate.rect,
          scale: roundNumber(candidate.scale),
          templateFile: candidate.templateFile
        }))
      }))
    };

    const reportPath = path.join(resultDir, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    return { reportPath, annotatedPath, matches, missingPhases };
  }

  function processImage(imagePath, templates) {
    const sourceImage = nativeImage.createFromPath(imagePath);
    if (sourceImage.isEmpty()) {
      throw new Error(`Failed to load image: ${imagePath}`);
    }

    const sourceData = imageToRgbData(sourceImage);
    const candidateBoxes = findCandidateBoxes(sourceImage);
    const candidatesByPhase = new Map();

    for (const template of templates) {
      const coarseCandidates = runCoarseSearchForTemplate(sourceData, template, candidateBoxes);
      const refineCandidates = runRefineSearch(sourceData, template, coarseCandidates);
      const finalCandidates = runFinalRefine(sourceData, template, refineCandidates);
      candidatesByPhase.set(template.phase, finalCandidates);
    }

    const finalSelection = chooseBestNonOverlappingSet(candidatesByPhase);
    return writeResultArtifacts(sourceImage, imagePath, templates, finalSelection, candidatesByPhase, candidateBoxes);
  }

  async function run() {
    const inputImages = resolveInputImages(process.argv[2]);
    if (inputImages.length === 0) {
      throw new Error(`No PNG files found in ${process.argv[2] || INPUT_DIR}`);
    }

    ensureDir(RESULTS_DIR);
    const templates = buildPhaseTemplates();
    const reports = [];

    for (const imagePath of inputImages) {
      process.stdout.write(`Processing ${imagePath}\n`);
      reports.push(processImage(imagePath, templates));
    }

    process.stdout.write(`${reports.map((entry) => entry.reportPath).join('\n')}\n`);
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
