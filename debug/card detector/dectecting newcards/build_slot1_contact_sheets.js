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
} else {
  const { app, nativeImage } = electronModule;

  const INPUT_DIR = path.join(__dirname, 'unsorted cards');
  const OUTPUT_DIR = path.join(__dirname, 'contact sheets');
  const THUMB_WIDTH = 220;
  const THUMB_HEIGHT = 370;
  const COLS = 4;
  const ROWS = 5;
  const PAGE_SIZE = COLS * ROWS;
  const BACKGROUND = { r: 20, g: 20, b: 20 };
  const LABEL_BG = { r: 0, g: 0, b: 0 };
  const LABEL_TEXT = { r: 255, g: 255, b: 255 };
  const SUBLABEL_TEXT = { r: 200, g: 200, b: 200 };
  const FONT = {
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
    '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110']
  };

  function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  function setPixel(bitmap, width, height, x, y, color) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = ((y * width) + x) * 4;
    bitmap[index] = color.b;
    bitmap[index + 1] = color.g;
    bitmap[index + 2] = color.r;
    bitmap[index + 3] = 255;
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

  function drawNumber(bitmap, width, height, x, y, value, color) {
    const text = String(value).padStart(2, '0');
    let cursor = x;
    for (const glyph of text) {
      drawGlyph(bitmap, width, height, cursor, y, glyph, color);
      cursor += 6;
    }
  }

  function drawMiniText(bitmap, width, height, x, y, text, color) {
    const sanitized = String(text).slice(0, 18);
    for (let index = 0; index < sanitized.length; index += 1) {
      const charCode = sanitized.charCodeAt(index);
      const baseX = x + (index * 4);
      for (let bit = 0; bit < 3; bit += 1) {
        const lit = ((charCode >> bit) & 1) === 1;
        if (!lit) continue;
        setPixel(bitmap, width, height, baseX + bit, y, color);
        setPixel(bitmap, width, height, baseX + bit, y + 1, color);
      }
    }
  }

  function createBlankCanvas(width, height) {
    const bitmap = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        setPixel(bitmap, width, height, x, y, BACKGROUND);
      }
    }
    return bitmap;
  }

  function copyImageToCanvas(targetBitmap, targetWidth, targetHeight, image, offsetX, offsetY) {
    const imageBitmap = image.toBitmap();
    const { width, height } = image.getSize();
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const sourceIndex = ((y * width) + x) * 4;
        const targetIndex = (((offsetY + y) * targetWidth) + (offsetX + x)) * 4;
        targetBitmap[targetIndex] = imageBitmap[sourceIndex];
        targetBitmap[targetIndex + 1] = imageBitmap[sourceIndex + 1];
        targetBitmap[targetIndex + 2] = imageBitmap[sourceIndex + 2];
        targetBitmap[targetIndex + 3] = imageBitmap[sourceIndex + 3];
      }
    }
  }

  function buildPage(entries, pageIndex) {
    const pageWidth = COLS * THUMB_WIDTH;
    const pageHeight = ROWS * THUMB_HEIGHT;
    const bitmap = createBlankCanvas(pageWidth, pageHeight);

    entries.forEach((entry, index) => {
      const cellX = (index % COLS) * THUMB_WIDTH;
      const cellY = Math.floor(index / COLS) * THUMB_HEIGHT;
      const image = nativeImage.createFromPath(entry.imagePath);
      const thumb = image.resize({
        width: THUMB_WIDTH - 12,
        height: THUMB_HEIGHT - 40,
        quality: 'best'
      });
      const thumbSize = thumb.getSize();
      const thumbX = cellX + Math.floor((THUMB_WIDTH - thumbSize.width) / 2);
      const thumbY = cellY + 4;
      copyImageToCanvas(bitmap, pageWidth, pageHeight, thumb, thumbX, thumbY);

      drawFilledRect(bitmap, pageWidth, pageHeight, {
        x: cellX + 4,
        y: cellY + THUMB_HEIGHT - 28,
        width: 46,
        height: 22
      }, LABEL_BG);
      drawNumber(bitmap, pageWidth, pageHeight, cellX + 8, cellY + THUMB_HEIGHT - 24, entry.index, LABEL_TEXT);
      drawMiniText(bitmap, pageWidth, pageHeight, cellX + 58, cellY + THUMB_HEIGHT - 22, entry.shortLabel, SUBLABEL_TEXT);
    });

    const outputImage = nativeImage.createFromBitmap(bitmap, {
      width: pageWidth,
      height: pageHeight
    });
    const outputPath = path.join(OUTPUT_DIR, `page-${pageIndex + 1}.png`);
    fs.writeFileSync(outputPath, outputImage.toPNG());
    return outputPath;
  }

  function run() {
    ensureDir(OUTPUT_DIR);
    const folders = fs.readdirSync(INPUT_DIR)
      .filter((entry) => fs.statSync(path.join(INPUT_DIR, entry)).isDirectory())
      .sort();

    const entries = folders.map((folder, index) => ({
      index: index + 1,
      folder,
      imagePath: path.join(INPUT_DIR, folder, 'slot-1.png'),
      shortLabel: folder
        .replace('Screenshot 2026-04-09 at ', '')
        .replace(' PM', 'P')
        .replace(' AM', 'A')
    }));

    const pages = [];
    for (let pageIndex = 0; pageIndex * PAGE_SIZE < entries.length; pageIndex += 1) {
      const pageEntries = entries.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE);
      pages.push(buildPage(pageEntries, pageIndex));
    }

    process.stdout.write(`${pages.join('\n')}\n`);
  }

  app.whenReady().then(() => {
    try {
      run();
      app.exit(0);
    } catch (error) {
      process.stderr.write(`${error.stack || error.message}\n`);
      app.exit(1);
    }
  });
}
