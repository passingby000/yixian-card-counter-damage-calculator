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
    BASE_SCREEN_HEIGHT
  } = require('../../talent_detector');

  const SCRIPT_DIR = __dirname;
  const ROOT_DIR = path.resolve(__dirname, '..', '..');
  const MANUAL_ANCHOR_PATH = path.join(SCRIPT_DIR, 'manual_talent_positions.txt');
  const POSITION_CONFIGS = {
    position1: {
      key: 'position1',
      label: 'position_1',
      talentName: 'Surge of Qi',
      templatePath: path.join(
        ROOT_DIR,
        'vendor',
        'yisim-master',
        'lanke',
        'talent_templates',
        'position_1',
        'Surge of Qi.png'
      ),
      reportPath: path.join(SCRIPT_DIR, 'talent_position1_report.json'),
      annotatedPath: path.join(SCRIPT_DIR, 'talent_position1_annotated.png'),
      debugDir: path.join(SCRIPT_DIR, 'talent_position1_debug'),
      baselineIndex: 0,
      approvedAnchor: {
        x: 357,
        y: 1693,
        width: 95,
        height: 95,
        status: 'manually confirmed'
      }
    },
    position2: {
      key: 'position2',
      label: 'position_2',
      talentName: 'Counter Move',
      templatePath: path.join(
        ROOT_DIR,
        'vendor',
        'yisim-master',
        'lanke',
        'talent_templates',
        'position_2',
        'Counter Move.png'
      ),
      reportPath: path.join(SCRIPT_DIR, 'talent_position2_report.json'),
      annotatedPath: path.join(SCRIPT_DIR, 'talent_position2_annotated.png'),
      debugDir: path.join(SCRIPT_DIR, 'talent_position2_debug'),
      baselineIndex: 1,
      approvedAnchor: {
        x: 196,
        y: 1663,
        width: 102,
        height: 102,
        status: 'manually confirmed'
      }
    },
    position3: {
      key: 'position3',
      label: 'position_3',
      talentName: 'Indomitable Will',
      templatePath: path.join(
        ROOT_DIR,
        'vendor',
        'yisim-master',
        'lanke',
        'talent_templates',
        'position_3',
        'Indomitable Will.png'
      ),
      reportPath: path.join(SCRIPT_DIR, 'talent_position3_report.json'),
      annotatedPath: path.join(SCRIPT_DIR, 'talent_position3_annotated.png'),
      debugDir: path.join(SCRIPT_DIR, 'talent_position3_debug'),
      baselineIndex: 2,
      approvedAnchor: {
        x: 64,
        y: 1558,
        width: 110,
        height: 110,
        status: 'manually confirmed'
      },
      searchBounds: {
        baseXMin: 0,
        baseXMaxExclusive: 460,
        baseYMin: 1180,
        baseYMaxExclusive: 1800,
        minSize: 85,
        maxSize: 120
      }
    },
    position4: {
      key: 'position4',
      label: 'position_4',
      talentName: 'Shift Stance',
      templatePath: path.join(
        ROOT_DIR,
        'vendor',
        'yisim-master',
        'lanke',
        'talent_templates',
        'position_4',
        'Shift Stance.png'
      ),
      reportPath: path.join(SCRIPT_DIR, 'talent_position4_report.json'),
      annotatedPath: path.join(SCRIPT_DIR, 'talent_position4_annotated.png'),
      debugDir: path.join(SCRIPT_DIR, 'talent_position4_debug'),
      baselineIndex: 3,
      approvedAnchor: {
        x: 49,
        y: 1402,
        width: 118,
        height: 118,
        status: 'manually confirmed'
      },
      searchBounds: {
        baseXMin: 0,
        baseXMaxExclusive: 460,
        baseYMin: 1180,
        baseYMaxExclusive: 1800,
        minSize: 85,
        maxSize: 120
      }
    },
    position5: {
      key: 'position5',
      label: 'position_5',
      talentName: 'Attain Qi',
      templatePath: path.join(
        ROOT_DIR,
        'vendor',
        'yisim-master',
        'lanke',
        'talent_templates',
        'position_5',
        'Attain Qi.png'
      ),
      reportPath: path.join(SCRIPT_DIR, 'talent_position5_report.json'),
      annotatedPath: path.join(SCRIPT_DIR, 'talent_position5_annotated.png'),
      debugDir: path.join(SCRIPT_DIR, 'talent_position5_debug'),
      baselineIndex: 4,
      approvedAnchor: {
        x: 122,
        y: 1255,
        width: 120,
        height: 120,
        status: 'manually confirmed'
      },
      searchBounds: {
        baseXMin: 0,
        baseXMaxExclusive: 460,
        baseYMin: 1180,
        baseYMaxExclusive: 1800,
        minSize: 85,
        maxSize: 120
      }
    }
  };

  const REGION_X_MAX_FRACTION = 0.25;
  const REGION_Y_MIN_FRACTION = 0.5;
  const MIN_SIZE = 50;
  const MAX_SIZE = 200;
  const ALPHA_THRESHOLD = 8;
  const TOP_CANDIDATE_COUNT = 25;
  const TOP_DEBUG_COUNT = 10;

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

  function roundNumber(value, digits = 4) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
  }

  function scaleRect(rect, width, height) {
    const scaleX = width / BASE_SCREEN_WIDTH;
    const scaleY = height / BASE_SCREEN_HEIGHT;
    return {
      x: Math.round(rect.x * scaleX),
      y: Math.round(rect.y * scaleY),
      width: Math.max(1, Math.round(rect.width * scaleX)),
      height: Math.max(1, Math.round(rect.height * scaleY))
    };
  }

  function normalizeRect(rect) {
    return {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height))
    };
  }

  function assertImageLoaded(image, label, filePath) {
    if (image.isEmpty()) {
      throw new Error(`Failed to load ${label}: ${filePath}`);
    }
  }

  function scaleCoordinate(value, actualSize, baseSize, rounding = 'round') {
    const scaled = (value / baseSize) * actualSize;
    if (rounding === 'floor') return Math.floor(scaled);
    if (rounding === 'ceil') return Math.ceil(scaled);
    return Math.round(scaled);
  }

  function computeSearchSettings(positionConfig, width, height) {
    if (!positionConfig.searchBounds) {
      return {
        region: {
          xMin: 0,
          xMaxExclusive: Math.floor(width * REGION_X_MAX_FRACTION),
          yMin: Math.floor(height * REGION_Y_MIN_FRACTION),
          yMaxExclusive: height
        },
        sizeRange: {
          min: MIN_SIZE,
          max: MAX_SIZE
        }
      };
    }

    return {
      region: {
        xMin: Math.max(0, scaleCoordinate(positionConfig.searchBounds.baseXMin, width, BASE_SCREEN_WIDTH, 'floor')),
        xMaxExclusive: Math.min(width, scaleCoordinate(positionConfig.searchBounds.baseXMaxExclusive, width, BASE_SCREEN_WIDTH, 'ceil')),
        yMin: Math.max(0, scaleCoordinate(positionConfig.searchBounds.baseYMin, height, BASE_SCREEN_HEIGHT, 'floor')),
        yMaxExclusive: Math.min(height, scaleCoordinate(positionConfig.searchBounds.baseYMaxExclusive, height, BASE_SCREEN_HEIGHT, 'ceil'))
      },
      sizeRange: {
        min: Math.max(1, scaleCoordinate(positionConfig.searchBounds.minSize, width, BASE_SCREEN_WIDTH)),
        max: Math.max(1, scaleCoordinate(positionConfig.searchBounds.maxSize, width, BASE_SCREEN_WIDTH))
      }
    };
  }

  function computeSearchRegion(width, height) {
    return {
      xMin: 0,
      xMaxExclusive: Math.floor(width * REGION_X_MAX_FRACTION),
      yMin: Math.floor(height * REGION_Y_MIN_FRACTION),
      yMaxExclusive: height
    };
  }

  function getPositionConfig(argument) {
    if (argument && POSITION_CONFIGS[argument]) {
      return POSITION_CONFIGS[argument];
    }
    return POSITION_CONFIGS.position1;
  }

  function getBaselineRect(width, height, baselineIndex) {
    return scaleRect(BASE_TALENT_RECTS[baselineIndex], width, height);
  }

  function getRectCenter(rect) {
    return {
      x: rect.x + (rect.width / 2),
      y: rect.y + (rect.height / 2)
    };
  }

  function compareCandidates(a, b) {
    if (a.rgbMse !== b.rgbMse) return a.rgbMse - b.rgbMse;
    if (a.size !== b.size) return b.size - a.size;
    if (a.distanceToBaseline !== b.distanceToBaseline) return a.distanceToBaseline - b.distanceToBaseline;
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  }

  function insertTopCandidate(list, candidate, maxCount) {
    const existingIndex = list.findIndex((entry) => (
      entry.x === candidate.x &&
      entry.y === candidate.y &&
      entry.size === candidate.size
    ));
    if (existingIndex >= 0) {
      if (compareCandidates(candidate, list[existingIndex]) < 0) {
        list[existingIndex] = candidate;
      }
      list.sort(compareCandidates);
      return;
    }
    list.push(candidate);
    list.sort(compareCandidates);
    if (list.length > maxCount) {
      list.length = maxCount;
    }
  }

  function buildPreparedTemplate(templateImage, size, screenWidth) {
    const resized = templateImage.resize({
      width: size,
      height: size,
      quality: 'best'
    });
    const bitmap = resized.toBitmap();
    const activePixels = [];
    let meanBlue = 0;
    let meanGreen = 0;
    let meanRed = 0;
    let count = 0;

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const idx = ((y * size) + x) * 4;
        const alpha = bitmap[idx + 3];
        if (alpha <= ALPHA_THRESHOLD) continue;
        const blue = bitmap[idx];
        const green = bitmap[idx + 1];
        const red = bitmap[idx + 2];
        activePixels.push({
          screenOffset: (y * screenWidth * 4) + (x * 4),
          blue,
          green,
          red
        });
        meanBlue += blue;
        meanGreen += green;
        meanRed += red;
        count += 1;
      }
    }

    if (count === 0) {
      throw new Error(`Template produced no opaque pixels at size ${size}`);
    }

    meanBlue /= count;
    meanGreen /= count;
    meanRed /= count;

    for (const pixel of activePixels) {
      const dBlue = pixel.blue - meanBlue;
      const dGreen = pixel.green - meanGreen;
      const dRed = pixel.red - meanRed;
      pixel.importance = (dBlue * dBlue) + (dGreen * dGreen) + (dRed * dRed);
    }

    activePixels.sort((a, b) => b.importance - a.importance);

    const screenOffsets = new Int32Array(activePixels.length);
    const templateBlue = new Uint8Array(activePixels.length);
    const templateGreen = new Uint8Array(activePixels.length);
    const templateRed = new Uint8Array(activePixels.length);

    for (let index = 0; index < activePixels.length; index += 1) {
      const pixel = activePixels[index];
      screenOffsets[index] = pixel.screenOffset;
      templateBlue[index] = pixel.blue;
      templateGreen[index] = pixel.green;
      templateRed[index] = pixel.red;
    }

    return {
      size,
      activePixelCount: activePixels.length,
      channelCount: activePixels.length * 3,
      screenOffsets,
      templateBlue,
      templateGreen,
      templateRed
    };
  }

  function computeMaskedRgbMse(screenshotBitmap, baseOffset, preparedTemplate, bestMse) {
    const {
      screenOffsets,
      templateBlue,
      templateGreen,
      templateRed,
      channelCount
    } = preparedTemplate;

    const errorLimit = Number.isFinite(bestMse) ? bestMse * channelCount : Number.POSITIVE_INFINITY;
    let sumSquaredError = 0;

    for (let index = 0; index < screenOffsets.length; index += 1) {
      const screenshotIdx = baseOffset + screenOffsets[index];
      const dBlue = screenshotBitmap[screenshotIdx] - templateBlue[index];
      const dGreen = screenshotBitmap[screenshotIdx + 1] - templateGreen[index];
      const dRed = screenshotBitmap[screenshotIdx + 2] - templateRed[index];
      sumSquaredError += (dBlue * dBlue) + (dGreen * dGreen) + (dRed * dRed);
      if (sumSquaredError > errorLimit) {
        return sumSquaredError / channelCount;
      }
    }

    return sumSquaredError / channelCount;
  }

  function computeExactRectRgbMse(screenshotBitmap, screenshotStride, width, templateImage, rect, templateCache) {
    const size = rect.width;
    let preparedTemplate = templateCache.get(size);
    if (!preparedTemplate) {
      preparedTemplate = buildPreparedTemplate(templateImage, size, width);
      templateCache.set(size, preparedTemplate);
    }

    const baseOffset = (rect.y * screenshotStride) + (rect.x * 4);
    return computeMaskedRgbMse(
      screenshotBitmap,
      baseOffset,
      preparedTemplate,
      Number.POSITIVE_INFINITY
    );
  }

  function cropRectImage(sourceImage, rect) {
    return sourceImage.crop(normalizeRect(rect));
  }

  function buildCandidateFromRect(rect, rgbMse, baselineCenter) {
    const center = getRectCenter(rect);
    const dx = center.x - baselineCenter.x;
    const dy = center.y - baselineCenter.y;
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      size: rect.width,
      rgbMse,
      distanceToBaseline: roundNumber((dx * dx) + (dy * dy), 3)
    };
  }

  function readJsonFile(filePath) {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_error) {
      return null;
    }
  }

  function buildManualAnchorSection(positionConfig, report, screenshotPath) {
    const approvedAnchor = positionConfig.approvedAnchor;
    const rect = approvedAnchor || report?.recommendedRect || report?.winner?.rect;
    const status = approvedAnchor?.status || (report ? 'candidate from brute-force search' : 'pending');
    const templatePath = report?.templatePath || positionConfig.templatePath;

    const lines = [
      `${positionConfig.label}`,
      `talent: ${positionConfig.talentName}`,
      `template: ${templatePath}`
    ];

    if (rect) {
      lines.push(
        `x = ${rect.x}`,
        `y = ${rect.y}`,
        `width = ${rect.width}`,
        `height = ${rect.height}`
      );
    } else {
      lines.push('x = unknown', 'y = unknown', 'width = unknown', 'height = unknown');
    }

    lines.push(`status: ${status}`);
    if (report?.winner?.rgbMse !== undefined) {
      lines.push(`winner rgbMse = ${report.winner.rgbMse}`);
    }
    if (screenshotPath) {
      lines.push(`screenshot: ${screenshotPath}`);
    }

    return lines.join('\n');
  }

  function updateManualAnchorFile(fallbackScreenshotPath) {
    const orderedConfigs = Object.values(POSITION_CONFIGS).sort((a, b) => a.baselineIndex - b.baselineIndex);
    const reports = new Map(orderedConfigs.map((config) => [config.key, readJsonFile(config.reportPath)]));
    const screenshotPath = fallbackScreenshotPath ||
      orderedConfigs.map((config) => reports.get(config.key)?.screenshotPath).find(Boolean) ||
      findDefaultScreenshotPath();

    const content = [
      'Manual Talent Positions',
      'These are manual review anchors for later calibration/runtime promotion.',
      '',
      ...orderedConfigs.flatMap((config, index) => (
        index === orderedConfigs.length - 1
          ? [buildManualAnchorSection(config, reports.get(config.key), screenshotPath)]
          : [buildManualAnchorSection(config, reports.get(config.key), screenshotPath), '']
      )),
      ''
    ].join('\n');

    fs.writeFileSync(MANUAL_ANCHOR_PATH, content, 'utf8');
  }

  async function createAnnotatedImage(screenshotPath, sourceImage, baseline, winner, outputPath) {
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
    .box {
      position: absolute;
      box-sizing: border-box;
      border: 3px solid rgba(64, 156, 255, 0.95);
      border-radius: 8px;
    }
    .box.winner {
      border-color: rgba(95, 221, 118, 0.95);
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
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <div class="canvas">
    <img id="screenshot" src="${screenshotFileUrl}" />
    <div class="box" style="left:${baseline.x}px;top:${baseline.y}px;width:${baseline.width}px;height:${baseline.height}px;"></div>
    <div class="box winner" style="left:${winner.x}px;top:${winner.y}px;width:${winner.width}px;height:${winner.height}px;"></div>
    <div class="label" style="left:${Math.max(0, Math.min(width - 260, baseline.x + baseline.width + 8))}px;top:${Math.max(0, baseline.y - 32)}px;">Baseline · ${roundNumber(baseline.rgbMse, 2)} MSE</div>
    <div class="label" style="left:${Math.max(0, Math.min(width - 260, winner.x + winner.width + 8))}px;top:${Math.max(0, winner.y - 32)}px;">Winner · ${roundNumber(winner.rgbMse, 2)} MSE</div>
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

    const tempHtmlPath = path.join(path.dirname(outputPath), '.talent_position1_overlay.html');
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

  function writeDebugCrops(sourceImage, baseline, winner, topCandidates, outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    const baselinePath = path.join(outputDir, 'baseline.png');
    const winnerPath = path.join(outputDir, 'winner.png');
    fs.writeFileSync(baselinePath, cropRectImage(sourceImage, baseline).toPNG());
    fs.writeFileSync(winnerPath, cropRectImage(sourceImage, winner).toPNG());

    const topCropPaths = [];
    topCandidates.slice(0, TOP_DEBUG_COUNT).forEach((candidate, index) => {
      const cropPath = path.join(
        outputDir,
        `top-${String(index + 1).padStart(2, '0')}-size-${candidate.size}-x-${candidate.x}-y-${candidate.y}.png`
      );
      fs.writeFileSync(cropPath, cropRectImage(sourceImage, candidate).toPNG());
      topCropPaths.push(cropPath);
    });

    return { baselinePath, winnerPath, topCropPaths };
  }

  function printProgress(size, current, total, bestMse) {
    const percent = Math.round((current / total) * 100);
    const bestText = Number.isFinite(bestMse) ? roundNumber(bestMse, 2) : 'n/a';
    process.stderr.write(`\rSize ${size}: ${current}/${total} (${percent}%) · best ${bestText}`);
  }

  function buildSizeCandidateCount(width, height, size) {
    const xCount = Math.max(0, Math.floor(width * REGION_X_MAX_FRACTION) - size + 1);
    const yCount = Math.max(0, height - size - Math.floor(height * REGION_Y_MIN_FRACTION) + 1);
    return xCount * yCount;
  }

  function recomputeExactCandidates(sourceImage, templateImage, baselineCenter, baseline, winner, topCandidates) {
    const { width } = sourceImage.getSize();
    const screenshotBitmap = sourceImage.toBitmap();
    const screenshotStride = width * 4;
    const templateCache = new Map();
    const uniqueCandidates = new Map();

    for (const candidate of [baseline, winner, ...topCandidates]) {
      const key = `${candidate.x}:${candidate.y}:${candidate.size}`;
      if (!uniqueCandidates.has(key)) {
        uniqueCandidates.set(key, candidate);
      }
    }

    const exactCandidates = Array.from(uniqueCandidates.values()).map((candidate) => {
      const rect = {
        x: candidate.x,
        y: candidate.y,
        width: candidate.size,
        height: candidate.size
      };
      const rgbMse = computeExactRectRgbMse(
        screenshotBitmap,
        screenshotStride,
        width,
        templateImage,
        rect,
        templateCache
      );
      return buildCandidateFromRect(rect, rgbMse, baselineCenter);
    });

    exactCandidates.sort(compareCandidates);
    const baselineKey = `${baseline.x}:${baseline.y}:${baseline.size}`;
    const winnerKey = `${winner.x}:${winner.y}:${winner.size}`;

    return {
      baseline: exactCandidates.find((candidate) => `${candidate.x}:${candidate.y}:${candidate.size}` === baselineKey) || baseline,
      winner: exactCandidates.find((candidate) => `${candidate.x}:${candidate.y}:${candidate.size}` === winnerKey) || exactCandidates[0] || winner,
      topCandidates: exactCandidates.slice(0, TOP_CANDIDATE_COUNT)
    };
  }

  function searchPosition(sourceImage, templateImage, positionConfig) {
    const { width, height } = sourceImage.getSize();
    const screenshotBitmap = sourceImage.toBitmap();
    const screenshotStride = width * 4;
    const searchSettings = computeSearchSettings(positionConfig, width, height);
    const searchRegion = searchSettings.region;
    const sizeRange = searchSettings.sizeRange;
    const baselineRect = getBaselineRect(width, height, positionConfig.baselineIndex);
    const baselineCenter = getRectCenter(baselineRect);
    const preparedBaseline = buildPreparedTemplate(templateImage, baselineRect.width, width);
    const baselineBaseOffset = (baselineRect.y * screenshotStride) + (baselineRect.x * 4);
    const baselineRgbMse = computeMaskedRgbMse(
      screenshotBitmap,
      baselineBaseOffset,
      preparedBaseline,
      Number.POSITIVE_INFINITY
    );
    const baseline = buildCandidateFromRect(baselineRect, baselineRgbMse, baselineCenter);

    let winner = baseline;
    const topCandidates = [baseline];
    let evaluatedCandidates = 0;

    for (let size = sizeRange.min; size <= sizeRange.max; size += 1) {
      const xMax = searchRegion.xMaxExclusive - size;
      const yMax = searchRegion.yMaxExclusive - size;
      if (xMax < searchRegion.xMin || yMax < searchRegion.yMin) {
        continue;
      }

      const xCount = xMax - searchRegion.xMin + 1;
      const yCount = yMax - searchRegion.yMin + 1;
      const totalForSize = xCount * yCount;
      let currentForSize = 0;
      const preparedTemplate = buildPreparedTemplate(templateImage, size, width);

      for (let y = searchRegion.yMin; y <= yMax; y += 1) {
        const rowBaseOffset = y * screenshotStride;
        for (let x = searchRegion.xMin; x <= xMax; x += 1) {
          currentForSize += 1;
          evaluatedCandidates += 1;
          if (currentForSize % 25000 === 0 || currentForSize === totalForSize) {
            printProgress(size, currentForSize, totalForSize, winner.rgbMse);
          }

          const baseOffset = rowBaseOffset + (x * 4);
          const rgbMse = computeMaskedRgbMse(
            screenshotBitmap,
            baseOffset,
            preparedTemplate,
            winner.rgbMse
          );
          const candidate = buildCandidateFromRect(
            { x, y, width: size, height: size },
            rgbMse,
            baselineCenter
          );

          if (compareCandidates(candidate, winner) < 0) {
            winner = candidate;
          }
          insertTopCandidate(topCandidates, candidate, TOP_CANDIDATE_COUNT);
        }
      }

      process.stderr.write('\n');
    }

    const exactResults = recomputeExactCandidates(
      sourceImage,
      templateImage,
      baselineCenter,
      baseline,
      winner,
      topCandidates
    );

    return {
      searchRegion,
      sizeRange,
      baseline: exactResults.baseline,
      winner: exactResults.winner,
      topCandidates: exactResults.topCandidates,
      evaluatedCandidates
    };
  }

  async function run() {
    const args = process.argv.slice(2);
    const positionConfig = getPositionConfig(args[0]);
    const screenshotArg = positionConfig.key === args[0] ? args[1] : args[0];
    const templateArg = positionConfig.key === args[0] ? args[2] : args[1];
    const screenshotPath = resolveInputPath(screenshotArg, findDefaultScreenshotPath());
    const templatePath = resolveInputPath(templateArg, positionConfig.templatePath);

    if (!fs.existsSync(screenshotPath)) {
      throw new Error(`Screenshot not found: ${screenshotPath}`);
    }
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Template not found: ${templatePath}`);
    }

    const sourceImage = nativeImage.createFromPath(screenshotPath);
    const templateImage = nativeImage.createFromPath(templatePath);
    assertImageLoaded(sourceImage, 'screenshot', screenshotPath);
    assertImageLoaded(templateImage, 'template', templatePath);

    const result = searchPosition(sourceImage, templateImage, positionConfig);
    const debugCrops = writeDebugCrops(
      sourceImage,
      result.baseline,
      result.winner,
      result.topCandidates,
      positionConfig.debugDir
    );

    await createAnnotatedImage(
      screenshotPath,
      sourceImage,
      result.baseline,
      result.winner,
      positionConfig.annotatedPath
    );

    const report = {
      generatedAt: new Date().toISOString(),
      positionKey: positionConfig.key,
      talentName: positionConfig.talentName,
      screenshotPath,
      templatePath,
      searchRegion: result.searchRegion,
      sizeRange: result.sizeRange,
      evaluatedCandidates: result.evaluatedCandidates,
      baseline: {
        rect: normalizeRect(result.baseline),
        rgbMse: roundNumber(result.baseline.rgbMse),
        cropPath: debugCrops.baselinePath
      },
      winner: {
        rect: normalizeRect(result.winner),
        rgbMse: roundNumber(result.winner.rgbMse),
        cropPath: debugCrops.winnerPath
      },
      topCandidates: result.topCandidates.map((candidate, index) => ({
        rank: index + 1,
        rect: normalizeRect(candidate),
        rgbMse: roundNumber(candidate.rgbMse),
        distanceToBaseline: roundNumber(candidate.distanceToBaseline, 3),
        cropPath: index < debugCrops.topCropPaths.length ? debugCrops.topCropPaths[index] : null
      })),
      recommendedRect: normalizeRect(result.winner)
    };

    fs.writeFileSync(positionConfig.reportPath, JSON.stringify(report, null, 2));
    updateManualAnchorFile(screenshotPath);
    process.stdout.write(`${positionConfig.reportPath}\n${positionConfig.annotatedPath}\n${MANUAL_ANCHOR_PATH}\n`);
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
