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
  const { detectTalents } = require('../../talent_detector');

  const SCRIPT_DIR = __dirname;
  const DEFAULT_SCREENSHOT_PATH = path.join(SCRIPT_DIR, 'Screenshot 2026-04-13 at 11.22.51 AM.png');
  const DEFAULT_REPORT_PATH = path.join(SCRIPT_DIR, 'talent_detector_report.json');
  const DEFAULT_ANNOTATED_PATH = path.join(SCRIPT_DIR, 'talent_detector_report.annotated.png');

  function resolveInputPath(inputPath, fallbackPath) {
    if (!inputPath) return fallbackPath;
    return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function createAnnotatedImage(sourceImage, screenshotPath, talents, outputPath) {
    const { width, height } = sourceImage.getSize();
    const screenshotUrl = pathToFileURL(screenshotPath).href;
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
      border: 3px solid rgba(93, 221, 118, 0.95);
      border-radius: 8px;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
    }
    .box.undetected {
      border-color: rgba(255, 176, 79, 0.96);
    }
    .label {
      position: absolute;
      min-width: 200px;
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
    <img src="${screenshotUrl}" />
    ${talents.map((talent) => {
      const rect = talent.rect || { x: 0, y: 0, width: 0, height: 0 };
      const labelLeft = Math.min(width - 220, Math.max(0, rect.x));
      const labelTop = Math.max(0, rect.y - 30);
      const label = talent.detected
        ? `${talent.position}. ${escapeHtml(talent.name)} · ${Math.round((talent.confidence || 0) * 100)}% · ${escapeHtml(talent.simulationKind || 'unknown')}`
        : `${talent.position}. Undetected${talent.bestCandidate?.name ? ` · best ${escapeHtml(talent.bestCandidate.name)} ${Math.round((talent.bestCandidate.score || 0) * 100)}%` : ''}`;
      return `
        <div class="box ${talent.detected ? '' : 'undetected'}" style="left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;"></div>
        <div class="label" style="left:${labelLeft}px;top:${labelTop}px;">${label}</div>
      `;
    }).join('\n')}
  </div>
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

    try {
      await win.loadURL(`data:text/html;base64,${Buffer.from(overlayHtml).toString('base64')}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const captured = await win.capturePage();
      fs.writeFileSync(outputPath, captured.toPNG());
    } finally {
      win.destroy();
    }
  }

  async function run() {
    const screenshotPath = resolveInputPath(process.argv[2], DEFAULT_SCREENSHOT_PATH);
    if (!fs.existsSync(screenshotPath)) {
      throw new Error(`Screenshot not found: ${screenshotPath}`);
    }

    const screenshot = nativeImage.createFromPath(screenshotPath);
    if (screenshot.isEmpty()) {
      throw new Error(`Failed to load screenshot: ${screenshotPath}`);
    }

    const detection = detectTalents(screenshot);
    const report = {
      generatedAt: new Date().toISOString(),
      screenshotPath,
      talents: detection.talents,
      talentDetection: detection.debug
    };

    fs.writeFileSync(DEFAULT_REPORT_PATH, JSON.stringify(report, null, 2));
    await createAnnotatedImage(screenshot, screenshotPath, detection.talents, DEFAULT_ANNOTATED_PATH);
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
