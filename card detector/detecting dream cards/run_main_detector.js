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

  const {
    detectSlots,
    BASE_SCREEN_WIDTH,
    BASE_SCREEN_HEIGHT,
    SLOT_X_POSITIONS,
    SLOT_Y,
    SLOT_WIDTH,
    SLOT_HEIGHT
  } = require('../../slot_detector');

  const SCRIPT_DIR = __dirname;
  const ROOT_DIR = path.resolve(__dirname, '..', '..');
  const IMAGES_DIR = path.join(ROOT_DIR, 'images');

  const DEFAULT_SCREENSHOT_PATH = path.join(SCRIPT_DIR, 'dream card detection.png');
  const DEFAULT_HAND_JSON_PATH = path.join(SCRIPT_DIR, 'dreamcarddetection.json');
  const DEFAULT_DREAM_GEOMETRY_REPORT_PATH = path.join(SCRIPT_DIR, 'dream_geometry_report.json');
  const DEFAULT_REPORT_PATH = path.join(SCRIPT_DIR, 'main_detector_report.json');
  const DEFAULT_CROPS_DIR = path.join(SCRIPT_DIR, 'main_detector_debug_slots');

  function resolveInputPath(inputPath, fallbackPath) {
    if (!inputPath) return fallbackPath;
    return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
  }

  function loadHandCandidates(handJsonPath) {
    const raw = fs.readFileSync(handJsonPath, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    const cards = parsed?.cards;
    if (!cards || typeof cards !== 'object') {
      throw new Error(`Invalid hand JSON at ${handJsonPath}: expected { "cards": { ... } }`);
    }
    return Object.keys(cards).filter((name) => !!name);
  }

  function getScaledSlotRect(slotIndex, sourceImage) {
    return getScaledSlotRectForGeometry(slotIndex, sourceImage, {
      slotXPositions: SLOT_X_POSITIONS,
      slotY: SLOT_Y,
      slotWidth: SLOT_WIDTH,
      slotHeight: SLOT_HEIGHT
    });
  }

  function getScaledSlotRectForGeometry(slotIndex, sourceImage, geometry) {
    const size = sourceImage.getSize();
    const scaleX = size.width / BASE_SCREEN_WIDTH;
    const scaleY = size.height / BASE_SCREEN_HEIGHT;
    return {
      x: Math.round(geometry.slotXPositions[slotIndex] * scaleX),
      y: Math.round(geometry.slotY * scaleY),
      width: Math.max(1, Math.round(geometry.slotWidth * scaleX)),
      height: Math.max(1, Math.round(geometry.slotHeight * scaleY))
    };
  }

  function cropSlotForDetector(sourceImage, slotIndex, geometry) {
    const rect = getScaledSlotRectForGeometry(slotIndex, sourceImage, geometry);
    const image = sourceImage.crop(rect).resize({
      width: geometry.slotWidth,
      height: geometry.slotHeight,
      quality: 'best'
    });
    return { rect, image };
  }

  function loadDreamGeometry(reportPath) {
    if (!fs.existsSync(reportPath)) {
      return null;
    }

    const raw = fs.readFileSync(reportPath, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    const geometry = parsed?.winningEvaluation?.geometry;
    if (!geometry || !Array.isArray(geometry.slotXPositions) || geometry.slotXPositions.length !== SLOT_X_POSITIONS.length) {
      return null;
    }

    return {
      slotXPositions: geometry.slotXPositions,
      slotY: geometry.slotY,
      slotWidth: geometry.slotWidth,
      slotHeight: geometry.slotHeight
    };
  }

  function writeSlotCrops(sourceImage, slotResults, cropsDir, dreamGeometry) {
    fs.mkdirSync(cropsDir, { recursive: true });

    const normalGeometry = {
      slotXPositions: SLOT_X_POSITIONS,
      slotY: SLOT_Y,
      slotWidth: SLOT_WIDTH,
      slotHeight: SLOT_HEIGHT
    };

    return SLOT_X_POSITIONS.map((_, slotIndex) => {
      const slotResult = slotResults[slotIndex] || null;
      const useDreamGeometry = !!(dreamGeometry && slotResult?.bestCandidate?.isDream);
      const geometry = useDreamGeometry ? dreamGeometry : normalGeometry;
      const { rect, image } = cropSlotForDetector(sourceImage, slotIndex, geometry);
      const cropPath = path.join(cropsDir, `slot-${slotIndex + 1}.png`);
      fs.writeFileSync(cropPath, image.toPNG());
      return {
        slotIndex,
        rect,
        cropPath,
        geometryType: useDreamGeometry ? 'dream' : 'normal'
      };
    });
  }

  async function run() {
    const screenshotPath = resolveInputPath(process.argv[2], DEFAULT_SCREENSHOT_PATH);
    const handJsonPath = resolveInputPath(process.argv[3], DEFAULT_HAND_JSON_PATH);

    if (!fs.existsSync(screenshotPath)) {
      throw new Error(`Screenshot not found: ${screenshotPath}`);
    }
    if (!fs.existsSync(handJsonPath)) {
      throw new Error(`Hand JSON not found: ${handJsonPath}`);
    }

    const screenshot = nativeImage.createFromPath(screenshotPath);
    if (screenshot.isEmpty()) {
      throw new Error(`Failed to load screenshot: ${screenshotPath}`);
    }

    const handCardNames = loadHandCandidates(handJsonPath);
    const dreamGeometry = loadDreamGeometry(DEFAULT_DREAM_GEOMETRY_REPORT_PATH);
    const detection = detectSlots(screenshot, handCardNames, IMAGES_DIR, {
      dreamGeometry
    });
    const slotCrops = writeSlotCrops(screenshot, detection.slotResults || [], DEFAULT_CROPS_DIR, dreamGeometry);

    const report = {
      generatedAt: new Date().toISOString(),
      screenshotPath,
      handJsonPath,
      dreamGeometryReportPath: fs.existsSync(DEFAULT_DREAM_GEOMETRY_REPORT_PATH)
        ? DEFAULT_DREAM_GEOMETRY_REPORT_PATH
        : null,
      imagesDir: IMAGES_DIR,
      handCardNames,
      detector: detection.debug || null,
      slots: detection.slots || [],
      slotResults: detection.slotResults || [],
      slotCrops
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
