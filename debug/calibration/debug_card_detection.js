#!/usr/bin/env node
/**
 * debug_card_detection.js
 *
 * Runs the same card-slot detection that calibrator.js uses against each PNG
 * in this folder, then writes an annotated copy showing where each slot was
 * detected, what NCC it scored, and the winning scale's tw × th.
 *
 * Usage (from repo root):
 *   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron debug/calibration/debug_card_detection.js
 *   # or simply, if pure-node imports resolve:
 *   node debug/calibration/debug_card_detection.js
 *
 * Inputs: any *.png in debug/calibration/ EXCEPT the output suffix.
 * Outputs: debug/calibration/<name>_detected.png alongside each input.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const {
  decodePng,
  findCardSlots,
  IMAGES_DIR
} = require('../../calibrator');
const { encodePng, annotateSlotDetection } = require('../../calibration_debug_draw');

const INPUT_DIR      = __dirname;
const OUTPUT_SUFFIX  = '_detected.png';

// ── Run detection on one screenshot ─────────────────────────────────────────

async function processImage(inputPath) {
  const name = path.basename(inputPath);
  console.log(`\n=== ${name} ===`);

  const ssImg = decodePng(inputPath);
  const { data: ssRgba, width: ssW, height: ssH } = ssImg;
  console.log(`  Size: ${ssW} × ${ssH}`);

  const ssGray = new Float32Array(ssW * ssH);
  for (let i = 0; i < ssW * ssH; i++) {
    ssGray[i] = 0.299 * ssRgba[i*4] + 0.587 * ssRgba[i*4+1] + 0.114 * ssRgba[i*4+2];
  }

  const t0 = Date.now();
  let geom = null;
  try {
    geom = await findCardSlots(ssGray, ssW, ssH);
  } catch (e) {
    console.log(`  findCardSlots THREW: ${e.message}`);
  }
  const totalMs = Date.now() - t0;

  if (geom) {
    console.log(`  findCardSlots: ${totalMs}ms  slotY=${geom.slotY}  ${geom.slotWidth}×${geom.slotHeight}px`);
    for (const s of geom.perSlot || []) {
      const loc = s.x != null ? `x=${String(s.x).padStart(4)} y=${String(s.y).padStart(4)}` : '(below threshold)  ';
      console.log(`    slot${s.slot}: ${String(s.card).padEnd(14)} ncc=${s.ncc.toFixed(3)}  ${s.w}×${s.h}  ${loc}`);
    }
    console.log(`    xs=[${geom.slotXPositions.join(', ')}]`);
  }

  const annotated = annotateSlotDetection(ssRgba, ssW, ssH, geom);
  const outPath = path.join(
    INPUT_DIR,
    name.replace(/\.png$/i, '') + OUTPUT_SUFFIX
  );
  fs.writeFileSync(outPath, encodePng(annotated, ssW, ssH));
  console.log(`  → wrote ${path.relative(process.cwd(), outPath)}`);
}

async function main() {
  console.log(`Template root: ${IMAGES_DIR}`);

  const entries = fs.readdirSync(INPUT_DIR)
    .filter((f) => f.toLowerCase().endsWith('.png') && !f.endsWith(OUTPUT_SUFFIX));

  if (entries.length === 0) {
    console.error('No *.png inputs found in debug/calibration/.');
    console.error('(The script skips files ending in _detected.png to avoid re-processing its own output.)');
    process.exit(1);
  }

  for (const entry of entries) {
    await processImage(path.join(INPUT_DIR, entry));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
