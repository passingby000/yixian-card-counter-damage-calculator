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

  const INPUT_DIR = path.join(__dirname, 'images to detect');
  const OUTPUT_DIR = path.join(__dirname, 'unsorted cards');
  const BASE_IMAGE_SIZE = { width: 2880, height: 1800 };
  const BASE_GEOMETRY = {
    xPositions: [131, 686, 1241, 1796, 2351],
    y: 155,
    width: 395,
    height: 663
  };
  const SLOT_COLORS = {
    1: { r: 244, g: 95, b: 83 },
    2: { r: 243, g: 161, b: 58 },
    3: { r: 65, g: 176, b: 110 },
    4: { r: 67, g: 146, b: 236 },
    5: { r: 165, g: 105, b: 245 }
  };
  const FONT = {
    S: [
      '01111',
      '10000',
      '10000',
      '01110',
      '00001',
      '00001',
      '11110'
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

  function buildAnnotatedImage(sourceImage, cards) {
    const sourceSize = sourceImage.getSize();
    const bitmap = Buffer.from(sourceImage.toBitmap());
    for (const card of cards) {
      const color = SLOT_COLORS[card.slot] || { r: 255, g: 255, b: 255 };
      drawRect(bitmap, sourceSize.width, sourceSize.height, card.rect, color, 4);
      const labelY = Math.max(0, card.rect.y - 18);
      drawLabel(bitmap, sourceSize.width, sourceSize.height, card.rect.x, labelY, `S${card.slot}`, color);
    }
    return nativeImage.createFromBitmap(bitmap, {
      width: sourceSize.width,
      height: sourceSize.height
    });
  }

  function buildAppliedGeometry(imageSize) {
    const xScale = imageSize.width / BASE_IMAGE_SIZE.width;
    const yScale = imageSize.height / BASE_IMAGE_SIZE.height;
    return {
      xPositions: BASE_GEOMETRY.xPositions.map((x) => Math.round(x * xScale)),
      y: Math.round(BASE_GEOMETRY.y * yScale),
      width: Math.round(BASE_GEOMETRY.width * xScale),
      height: Math.round(BASE_GEOMETRY.height * yScale)
    };
  }

  function buildCardsFromGeometry(appliedGeometry) {
    return appliedGeometry.xPositions.map((x, index) => ({
      slot: index + 1,
      rect: {
        x,
        y: appliedGeometry.y,
        width: appliedGeometry.width,
        height: appliedGeometry.height
      }
    }));
  }

  function validateRect(rect, imageSize) {
    if (rect.x < 0 || rect.y < 0) {
      return `Rect starts outside image bounds: ${JSON.stringify(rect)}`;
    }
    if (rect.width <= 0 || rect.height <= 0) {
      return `Rect has non-positive size: ${JSON.stringify(rect)}`;
    }
    if ((rect.x + rect.width) > imageSize.width || (rect.y + rect.height) > imageSize.height) {
      return `Rect exceeds image bounds ${imageSize.width}x${imageSize.height}: ${JSON.stringify(rect)}`;
    }
    return null;
  }

  function writeManifest(manifestPath, payload) {
    fs.writeFileSync(manifestPath, JSON.stringify(payload, null, 2));
  }

  function processImage(imagePath) {
    const sourceImage = nativeImage.createFromPath(imagePath);
    if (sourceImage.isEmpty()) {
      throw new Error(`Failed to load image: ${imagePath}`);
    }

    const imageSize = sourceImage.getSize();
    const appliedGeometry = buildAppliedGeometry(imageSize);
    const cards = buildCardsFromGeometry(appliedGeometry);
    const baseName = sanitizeFilePart(path.basename(imagePath, path.extname(imagePath)));
    const outputDir = path.join(OUTPUT_DIR, baseName);
    fs.rmSync(outputDir, { recursive: true, force: true });
    ensureDir(outputDir);

    const validationErrors = cards
      .map((card) => ({
        slot: card.slot,
        error: validateRect(card.rect, imageSize)
      }))
      .filter((entry) => entry.error);

    const manifestPath = path.join(outputDir, 'manifest.json');
    if (validationErrors.length > 0) {
      writeManifest(manifestPath, {
        sourceImage: imagePath,
        imageSize,
        baseGeometry: BASE_GEOMETRY,
        appliedGeometry,
        cards: cards.map((card) => ({
          slot: card.slot,
          rect: card.rect,
          cropPath: null
        })),
        error: 'One or more crop rectangles are out of bounds.',
        validationErrors
      });
      return { manifestPath, outputDir, error: true };
    }

    const writtenCards = cards.map((card) => {
      const cropImage = sourceImage.crop(card.rect);
      const cropPath = path.join(outputDir, `slot-${card.slot}.png`);
      fs.writeFileSync(cropPath, cropImage.toPNG());
      return {
        slot: card.slot,
        rect: card.rect,
        cropPath
      };
    });

    const annotatedImage = buildAnnotatedImage(sourceImage, cards);
    const annotatedPath = path.join(outputDir, 'annotated.png');
    fs.writeFileSync(annotatedPath, annotatedImage.toPNG());

    writeManifest(manifestPath, {
      sourceImage: imagePath,
      imageSize,
      baseGeometry: BASE_GEOMETRY,
      appliedGeometry,
      cards: writtenCards
    });

    return { manifestPath, outputDir, error: false };
  }

  async function run() {
    ensureDir(OUTPUT_DIR);
    const inputImages = resolveInputImages(process.argv[2]);
    if (inputImages.length === 0) {
      throw new Error(`No PNG files found in ${process.argv[2] || INPUT_DIR}`);
    }

    const results = [];
    for (const imagePath of inputImages) {
      process.stdout.write(`Processing ${imagePath}\n`);
      results.push(processImage(imagePath));
    }

    process.stdout.write(`${results.map((entry) => entry.manifestPath).join('\n')}\n`);
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
