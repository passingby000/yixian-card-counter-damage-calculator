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

  const ROOT_DIR = path.join(__dirname, 'unsorted cards');
  const OUTPUT_PATH = path.join(__dirname, 'new_card_matches.json');
  const TARGET_PREFIX = 'Screenshot 2026-04-22';
  const REFERENCE_PREFIX = 'Screenshot 2026-04-09';
  const RESIZE_SIZE = { width: 120, height: 202 };

  function resizeBitmap(imagePath) {
    const image = nativeImage.createFromPath(imagePath);
    if (image.isEmpty()) {
      throw new Error(`failed to load image: ${imagePath}`);
    }
    const resized = image.resize({
      width: RESIZE_SIZE.width,
      height: RESIZE_SIZE.height,
      quality: 'best'
    });
    return resized.toBitmap();
  }

  function scoreBitmap(targetBitmap, referenceBitmap) {
    let error = 0;
    const pixelCount = RESIZE_SIZE.width * RESIZE_SIZE.height;
    for (let offset = 0; offset < targetBitmap.length; offset += 4) {
      const db = targetBitmap[offset] - referenceBitmap[offset];
      const dg = targetBitmap[offset + 1] - referenceBitmap[offset + 1];
      const dr = targetBitmap[offset + 2] - referenceBitmap[offset + 2];
      error += (dr * dr) + (dg * dg) + (db * db);
    }
    return error / (pixelCount * 3);
  }

  function getReferenceEntries() {
    const folders = fs.readdirSync(ROOT_DIR)
      .filter((entry) => entry.startsWith(REFERENCE_PREFIX))
      .sort();
    const phases = new Map();
    for (const folder of folders) {
      const folderPath = path.join(ROOT_DIR, folder);
      const entries = fs.readdirSync(folderPath)
        .filter((entry) => entry.toLowerCase().endsWith('.png'))
        .filter((entry) => entry !== 'annotated.png')
        .filter((entry) => !entry.startsWith('slot-'));
      for (const entry of entries) {
        const match = entry.match(/^(.*?)([1-5])\.png$/);
        if (!match) continue;
        const [, cardName, phaseString] = match;
        const phase = Number(phaseString);
        const imagePath = path.join(folderPath, entry);
        if (!phases.has(phase)) {
          phases.set(phase, []);
        }
        phases.get(phase).push({
          cardName,
          folder,
          phase,
          imagePath,
          bitmap: resizeBitmap(imagePath)
        });
      }
    }
    return phases;
  }

  function getTargetFolders() {
    return fs.readdirSync(ROOT_DIR)
      .filter((entry) => entry.startsWith(TARGET_PREFIX))
      .sort();
  }

  function scoreTargetFolder(folder, referenceEntriesByPhase) {
    const folderPath = path.join(ROOT_DIR, folder);
    const phaseScores = new Map();
    const slotResults = [];

    for (let slot = 1; slot <= 5; slot += 1) {
      const slotPath = path.join(folderPath, `slot-${slot}.png`);
      const targetBitmap = resizeBitmap(slotPath);
      const references = referenceEntriesByPhase.get(slot) || [];
      const scored = references.map((reference) => ({
        cardName: reference.cardName,
        phase: slot,
        folder: reference.folder,
        imagePath: reference.imagePath,
        mse: Number(scoreBitmap(targetBitmap, reference.bitmap).toFixed(4))
      })).sort((a, b) => a.mse - b.mse);

      const topMatches = scored.slice(0, 10);
      slotResults.push({
        slot,
        slotPath,
        topMatches
      });

      for (const match of topMatches) {
        if (!phaseScores.has(match.cardName)) {
          phaseScores.set(match.cardName, []);
        }
        phaseScores.get(match.cardName).push(match.mse);
      }
    }

    const aggregated = [...phaseScores.entries()]
      .filter(([, scores]) => scores.length === 5)
      .map(([cardName, scores]) => ({
        cardName,
        phaseCount: scores.length,
        totalMse: Number(scores.reduce((sum, value) => sum + value, 0).toFixed(4)),
        averageMse: Number((scores.reduce((sum, value) => sum + value, 0) / scores.length).toFixed(4)),
        perPhaseMse: scores
      }))
      .sort((a, b) => a.totalMse - b.totalMse);

    return {
      folder,
      slotResults,
      topCardMatches: aggregated.slice(0, 10)
    };
  }

  function run() {
    const referenceEntriesByPhase = getReferenceEntries();
    const targetFolders = getTargetFolders();
    const results = targetFolders.map((folder) => scoreTargetFolder(folder, referenceEntriesByPhase));
    const payload = {
      generatedAt: new Date().toISOString(),
      rootDir: ROOT_DIR,
      resizeSize: RESIZE_SIZE,
      targetFolders,
      results
    };
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    process.stdout.write(`${OUTPUT_PATH}\n`);
    for (const result of results) {
      const best = result.topCardMatches[0];
      if (best) {
        process.stdout.write(`${result.folder}: ${best.cardName} avgMse=${best.averageMse}\n`);
      } else {
        process.stdout.write(`${result.folder}: no 5-phase match found\n`);
      }
    }
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
