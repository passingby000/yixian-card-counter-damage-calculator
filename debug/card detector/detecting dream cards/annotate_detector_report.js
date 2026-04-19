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
  const { app, BrowserWindow } = electronModule;

  const SCRIPT_DIR = __dirname;
  const ROOT_DIR = path.resolve(SCRIPT_DIR, '..', '..');
  const DEFAULT_REPORT_PATH = path.join(SCRIPT_DIR, 'main_detector_report.json');

  function resolveInputPath(inputPath, fallbackPath) {
    if (!inputPath) return fallbackPath;
    return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
  }

  function imagePathToDataUrl(imagePath) {
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'application/octet-stream';
    const base64 = fs.readFileSync(imagePath).toString('base64');
    return `data:${mimeType};base64,${base64}`;
  }

  function findTemplatePath(templateFileName) {
    if (!templateFileName) return null;
    const matches = [];

    function walk(dirPath) {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name === templateFileName) {
          matches.push(fullPath);
        }
      }
    }

    walk(path.join(ROOT_DIR, 'images'));
    return matches[0] || null;
  }

  async function buildAnnotatedImage(reportPath, overlaySlotNumber = null) {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const screenshotPath = report.screenshotPath;
    const outputSuffix = overlaySlotNumber
      ? `.slot-${overlaySlotNumber}.template-overlay.png`
      : '.annotated.png';
    const outputPath = screenshotPath.replace(/\.png$/i, outputSuffix);
    const screenshotUrl = imagePathToDataUrl(screenshotPath);

    const width = report.imageSize?.width || 2880;
    const height = report.imageSize?.height || 1800;

    const win = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      webPreferences: {
        contextIsolation: false,
        sandbox: false,
        nodeIntegration: false
      }
    });

    const overlays = (report.slotResults || []).map((slotResult, index) => {
      const rect = slotResult.rect;
      if (!rect) return '';

      let color = slotResult.accepted ? '#1ecb68' : '#ff9f1a';
      let lineWidth = 4;
      if (index === 0 && slotResult.bestCandidate && slotResult.bestCandidate.isDream) {
        color = '#ff4d6d';
        lineWidth = 8;
      }

      const best = slotResult.bestCandidate || {};
      const label = [
        'S' + (index + 1),
        best.name || 'None',
        best.phase ? 'P' + best.phase : (best.level ? 'L' + best.level : ''),
        Number.isFinite(slotResult.bestScore) ? String(slotResult.bestScore) : ''
      ].filter(Boolean).join(' · ');

      const labelTop = Math.max(0, rect.y - 44);
      return `
        <div style="position:absolute;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;border:${lineWidth}px solid ${color};box-sizing:border-box;"></div>
        <div style="position:absolute;left:${rect.x}px;top:${labelTop}px;background:${color};color:#fff;font:28px sans-serif;padding:6px 10px;line-height:1;white-space:nowrap;">${label}</div>
      `;
    }).join('\n');

    let templateOverlay = '';
    if (overlaySlotNumber) {
      const slotResult = report.slotResults?.[overlaySlotNumber - 1] || null;
      const rect = slotResult?.rect || null;
      const templateFile = slotResult?.bestCandidate?.templateFile || null;
      const templatePath = findTemplatePath(templateFile);
      if (rect && templatePath) {
        const templateUrl = imagePathToDataUrl(templatePath);
        const labelTop = Math.min(height - 44, rect.y + rect.height + 8);
        templateOverlay = `
          <img
            id="template-overlay"
            src="${templateUrl}"
            style="position:absolute;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;opacity:0.62;outline:8px solid #ff4d6d;box-sizing:border-box;"
          />
          <div style="position:absolute;left:${rect.x}px;top:${labelTop}px;background:#ff4d6d;color:#fff;font:28px sans-serif;padding:6px 10px;line-height:1;white-space:nowrap;">
            Overlay · ${slotResult.bestCandidate.name} · P${slotResult.bestCandidate.phase || 1}
          </div>
        `;
      }
    }

    const html = `
      <html>
        <body style="margin:0;overflow:hidden;background:#000;position:relative;width:${width}px;height:${height}px;">
          <img id="bg" src="${screenshotUrl}" style="position:absolute;left:0;top:0;width:${width}px;height:${height}px;" />
          ${templateOverlay}
          ${overlays}
        </body>
      </html>
    `;

    const tempHtmlPath = path.join(SCRIPT_DIR, '.annotate_detector_report.tmp.html');
    fs.writeFileSync(tempHtmlPath, html, 'utf8');
    await win.loadFile(tempHtmlPath);
    await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const images = Array.from(document.images);
        const failed = images.find((img) => img.complete && img.naturalWidth === 0);
        if (failed) {
          reject(new Error('Failed to decode one of the embedded images'));
          return;
        }
        const pending = images.filter((img) => !img.complete);
        if (pending.length === 0) {
          resolve(true);
          return;
        }
        let remaining = pending.length;
        const done = () => {
          remaining -= 1;
          if (remaining <= 0) resolve(true);
        };
        pending.forEach((img) => {
          img.onload = done;
          img.onerror = () => reject(new Error('Failed to load one of the overlay images'));
        });
      });
    `);

    const captured = await win.webContents.capturePage();
    fs.writeFileSync(outputPath, captured.toPNG());
    win.destroy();
    try {
      fs.unlinkSync(tempHtmlPath);
    } catch (error) {}
    return outputPath;
  }

  app.whenReady().then(async () => {
    try {
      const reportPath = resolveInputPath(process.argv[2], DEFAULT_REPORT_PATH);
      const overlaySlotNumber = Number.parseInt(process.argv[3], 10);
      const outputPath = await buildAnnotatedImage(
        reportPath,
        Number.isFinite(overlaySlotNumber) ? overlaySlotNumber : null
      );
      process.stdout.write(`${outputPath}\n`);
      app.exit(0);
    } catch (error) {
      process.stderr.write(`${error.stack || error.message}\n`);
      app.exit(1);
    }
  });
}
