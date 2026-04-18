const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const { nativeImage } = require('electron');
const { getCodePath, getYisimPath, getAssetPath } = require('./runtime_paths');

// Slot geometry ratios (used to estimate expected sizes)
const SLOT_BASE_W        = 1920;
const SLOT_BASE_H        = 1080;
const SLOT_CONFIG_W      = 212;
const SLOT_CONFIG_H      = 343;

const TALENT_TEMPLATES_DIR     = getYisimPath('lanke', 'talent_templates');
const IMAGES_DIR               = getAssetPath('images');
const CALIBRATION_INFO_PATH    = getCodePath('calibration', 'cards_and_talent.txt');
const CALIBRATION_CAPTURE_PATH = getCodePath('calibration', 'calibration_capture.png');
const CALIBRATION_DEBUG_PATH   = getCodePath('calibration', 'calibration_debug.png');

// ── Gray helpers ────────────────────────────────────────────────────────────

// Convert NativeImage to Float32Array grayscale (Electron bitmap is BGRA)
function imageToGray(image) {
  const bm = image.toBitmap();
  const { width, height } = image.getSize();
  const gray = new Float32Array(width * height);
  for (let i = 0, px = 0; i < bm.length; i += 4, px++) {
    gray[px] = 0.114 * bm[i] + 0.587 * bm[i + 1] + 0.299 * bm[i + 2]; // BGRA→gray
  }
  return { gray, width, height };
}

// ── Pure Node.js PNG decoder (no color profile transforms) ──────────────────

function readU32(buf, off) {
  return ((buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]) >>> 0;
}

function paethPredictor(a, b, c) {
  const p  = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(filePath) {
  const buf = fs.readFileSync(filePath);

  const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIGNATURE[i]) throw new Error(`Not a valid PNG: ${filePath}`);
  }

  let width, height, bitDepth, colorType;
  let palette = null;
  const idatChunks = [];

  let pos = 8;
  while (pos < buf.length - 4) {
    const length = readU32(buf, pos);
    const type   = buf.slice(pos + 4, pos + 8).toString('ascii');
    const data   = buf.slice(pos + 8, pos + 8 + length);
    pos += 12 + length;

    if (type === 'IHDR') {
      width     = readU32(data, 0);
      height    = readU32(data, 4);
      bitDepth  = data[8];
      colorType = data[9];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!width || !height) throw new Error(`Invalid PNG (no IHDR): ${filePath}`);
  if (bitDepth !== 8)    throw new Error(`Unsupported bit depth ${bitDepth} in ${filePath}`);

  const BPP_MAP = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bpp = BPP_MAP[colorType];
  if (!bpp) throw new Error(`Unsupported color type ${colorType} in ${filePath}`);

  const raw     = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride  = width * bpp;
  const rgba    = new Uint8Array(width * height * 4);
  let   rawPos  = 0;
  const prevRow = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++];
    const row    = new Uint8Array(stride);

    for (let i = 0; i < stride; i++) {
      const v = raw[rawPos++];
      const a = i >= bpp ? row[i - bpp]     : 0;
      const b = prevRow[i];
      const c = i >= bpp ? prevRow[i - bpp] : 0;
      if      (filter === 0) row[i] = v;
      else if (filter === 1) row[i] = (v + a)                       & 0xFF;
      else if (filter === 2) row[i] = (v + b)                       & 0xFF;
      else if (filter === 3) row[i] = (v + ((a + b) >> 1))          & 0xFF;
      else if (filter === 4) row[i] = (v + paethPredictor(a, b, c)) & 0xFF;
      else throw new Error(`Unknown PNG filter ${filter} at row ${y}`);
    }

    for (let x = 0; x < width; x++) {
      const s = x * bpp;
      const d = (y * width + x) * 4;
      if      (colorType === 0) { rgba[d]=rgba[d+1]=rgba[d+2]=row[s]; rgba[d+3]=255; }
      else if (colorType === 2) { rgba[d]=row[s]; rgba[d+1]=row[s+1]; rgba[d+2]=row[s+2]; rgba[d+3]=255; }
      else if (colorType === 3) {
        const p = row[s] * 3;
        rgba[d]=palette[p]; rgba[d+1]=palette[p+1]; rgba[d+2]=palette[p+2]; rgba[d+3]=255;
      }
      else if (colorType === 4) { rgba[d]=rgba[d+1]=rgba[d+2]=row[s]; rgba[d+3]=row[s+1]; }
      else if (colorType === 6) { rgba[d]=row[s]; rgba[d+1]=row[s+1]; rgba[d+2]=row[s+2]; rgba[d+3]=row[s+3]; }
    }

    prevRow.set(row);
  }

  return { data: rgba, width, height };
}

// Load a PNG template from disk as grayscale using raw PNG bytes (no color transforms)
function loadTemplateGray(templatePath) {
  try {
    const img = decodePng(templatePath);
    const { data, width, height } = img;
    const gray = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      gray[i] = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2];
    }
    return { gray, width, height };
  } catch (e) {
    return null;
  }
}

// Bilinear resize of a Float32Array grayscale image
function resizeGray(srcGray, srcW, srcH, dstW, dstH) {
  const out = new Float32Array(dstW * dstH);
  const rx  = srcW / dstW;
  const ry  = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const fx = dx * rx, fy = dy * ry;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const y1 = Math.min(y0 + 1, srcH - 1);
      const wx = fx - x0, wy = fy - y0;
      out[dy * dstW + dx] =
        (1-wx)*(1-wy)*srcGray[y0*srcW+x0] +
        wx   *(1-wy)*srcGray[y0*srcW+x1] +
        (1-wx)*wy   *srcGray[y1*srcW+x0] +
        wx   *wy   *srcGray[y1*srcW+x1];
    }
  }
  return out;
}

// Nearest-neighbour downsample by integer factor
function downsample(gray, w, h, ds) {
  const dw = Math.floor(w / ds);
  const dh = Math.floor(h / ds);
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++)
    for (let x = 0; x < dw; x++)
      out[y * dw + x] = gray[(y * ds) * w + (x * ds)];
  return { gray: out, w: dw, h: dh };
}

// Zero-mean Normalized Cross-Correlation using only pixels inside the inscribed circle
function znccCircular(ssGray, ssW, sx, sy, tmplGray, tw, th) {
  const cx = (tw - 1) / 2;
  const cy = (th - 1) / 2;
  const r2 = cx * cx;
  let n = 0, sumI = 0, sumT = 0;
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const dx = tx - cx, dy = ty - cy;
      if (dx * dx / r2 + dy * dy / (cy * cy || 1) > 1) continue;
      sumI += ssGray[(sy + ty) * ssW + (sx + tx)];
      sumT += tmplGray[ty * tw + tx];
      n++;
    }
  }
  if (n === 0) return 0;
  const mI = sumI / n, mT = sumT / n;
  let num = 0, denI = 0, denT = 0;
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const dx = tx - cx, dy = ty - cy;
      if (dx * dx / r2 + dy * dy / (cy * cy || 1) > 1) continue;
      const di = ssGray[(sy + ty) * ssW + (sx + tx)] - mI;
      const dt = tmplGray[ty * tw + tx] - mT;
      num += di * dt; denI += di * di; denT += dt * dt;
    }
  }
  const denom = Math.sqrt(denI * denT);
  return denom < 1 ? 0 : num / denom;
}

// Rectangular ZNCC over the full template
function znccAt(ssGray, ssW, sx, sy, tmplGray, tw, th) {
  const n = tw * th;
  let sumI = 0, sumT = 0;
  for (let ty = 0; ty < th; ty++)
    for (let tx = 0; tx < tw; tx++) {
      sumI += ssGray[(sy + ty) * ssW + (sx + tx)];
      sumT += tmplGray[ty * tw + tx];
    }
  const mI = sumI / n, mT = sumT / n;
  let num = 0, denI = 0, denT = 0;
  for (let ty = 0; ty < th; ty++)
    for (let tx = 0; tx < tw; tx++) {
      const di = ssGray[(sy + ty) * ssW + (sx + tx)] - mI;
      const dt = tmplGray[ty * tw + tx] - mT;
      num += di * dt; denI += di * di; denT += dt * dt;
    }
  const denom = Math.sqrt(denI * denT);
  return denom < 1 ? 0 : num / denom;
}

// Two-pass card search: DS=4 coarse scan → full-res fine pass around best hit
function findBestCardPosition(ssGray, ssW, ssH, tmplGray, tw, th, yMin, yMax) {
  const DS = 4;
  const ss4 = downsample(ssGray, ssW, ssH, DS);
  const tw4 = Math.max(1, Math.floor(tw / DS));
  const th4 = Math.max(1, Math.floor(th / DS));
  const tm4 = resizeGray(tmplGray, tw, th, tw4, th4);

  const cx1 = ss4.w - tw4;
  const cy0 = Math.max(0, Math.floor(yMin / DS));
  const cy1 = Math.min(ss4.h - th4, Math.floor(yMax / DS));

  let coarseBest = -Infinity, coarseX = 0, coarseY = cy0;
  for (let y = cy0; y <= cy1; y++)
    for (let x = 0; x <= cx1; x++) {
      const score = znccAt(ss4.gray, ss4.w, x, y, tm4, tw4, th4);
      if (score > coarseBest) { coarseBest = score; coarseX = x; coarseY = y; }
    }

  const margin = DS * 3;
  const fy0 = Math.max(yMin, coarseY * DS - margin);
  const fy1 = Math.min(Math.min(yMax, ssH - th), coarseY * DS + margin);
  const fx0 = Math.max(0, coarseX * DS - margin);
  const fx1 = Math.min(ssW - tw, coarseX * DS + margin);

  let fineBest = -Infinity, bestX = coarseX * DS, bestY = coarseY * DS;
  for (let y = fy0; y <= fy1; y++)
    for (let x = fx0; x <= fx1; x++) {
      const score = znccAt(ssGray, ssW, x, y, tmplGray, tw, th);
      if (score > fineBest) { fineBest = score; bestX = x; bestY = y; }
    }
  return { x: bestX, y: bestY, ncc: fineBest };
}

// Two-pass talent search: DS=4 coarse scan → full-res fine pass around best hit
function findBestPositionTalent(ssGray, ssW, ssH, tmplGray, tw, th, yMin, yMax, xMin, xMax) {
  const DS = 4;
  const ss4 = downsample(ssGray, ssW, ssH, DS);
  const tw4 = Math.max(1, Math.floor(tw / DS));
  const th4 = Math.max(1, Math.floor(th / DS));
  const tm4 = resizeGray(tmplGray, tw, th, tw4, th4);

  const cx0 = Math.max(0, Math.floor(xMin / DS));
  const cx1 = Math.min(ss4.w - tw4, Math.floor((xMax - tw) / DS));
  const cy0 = Math.max(0, Math.floor(yMin / DS));
  const cy1 = Math.min(ss4.h - th4, Math.floor(yMax / DS));

  let coarseBest = -Infinity, coarseX = cx0, coarseY = cy0;
  for (let y = cy0; y <= cy1; y++)
    for (let x = cx0; x <= cx1; x++) {
      const score = znccCircular(ss4.gray, ss4.w, x, y, tm4, tw4, th4);
      if (score > coarseBest) { coarseBest = score; coarseX = x; coarseY = y; }
    }

  const margin = DS * 4;
  const fy0 = Math.max(yMin, coarseY * DS - margin);
  const fy1 = Math.min(Math.min(yMax, ssH - th), coarseY * DS + margin);
  const fx0 = Math.max(xMin, coarseX * DS - margin);
  const fx1 = Math.min(Math.min(xMax - tw, ssW - tw), coarseX * DS + margin);

  let fineBest = -Infinity, bestX = coarseX * DS, bestY = coarseY * DS;
  for (let y = fy0; y <= fy1; y++)
    for (let x = fx0; x <= fx1; x++) {
      const score = znccCircular(ssGray, ssW, x, y, tmplGray, tw, th);
      if (score > fineBest) { fineBest = score; bestX = x; bestY = y; }
    }

  return { x: bestX, y: bestY, ncc: fineBest, w: tw, h: th };
}

// Multi-scale circular ZNCC: search bottom-left quadrant at scales 0.40–1.26
function findTalentMultiScale(ssGray, ssW, ssH, tmpl) {
  const { gray: tmplGray, width: tmplW, height: tmplH } = tmpl;
  const xMax = Math.floor(ssW * 0.30);
  const yMin = Math.floor(ssH * 0.50);
  let best = null;

  for (let scale = 0.40; scale <= 1.26; scale += 0.05) {
    const tw = Math.max(1, Math.round(tmplW * scale));
    const th = Math.max(1, Math.round(tmplH * scale));
    if (tw >= xMax || th >= ssH) continue;
    const scaled = resizeGray(tmplGray, tmplW, tmplH, tw, th);
    const result = findBestPositionTalent(ssGray, ssW, ssH, scaled, tw, th, yMin, ssH, 0, xMax);
    if (!best || result.ncc > best.ncc) best = result;
  }

  return best; // { x, y, w, h, ncc }
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ── Card slot detection via template matching ─────────────────────────────

function walkDir(dir) {
  let out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkDir(full));
    else if (e.name.toLowerCase().endsWith('.png')) out.push(full);
  }
  return out;
}

function buildImageIndex(dir) {
  const idx = new Map();
  for (const f of walkDir(dir)) {
    const key = path.basename(f, '.png').trim().toLowerCase();
    if (!idx.has(key)) idx.set(key, f);
  }
  return idx;
}

function parseCardNames() {
  if (!fs.existsSync(CALIBRATION_INFO_PATH)) return {};
  const names = {};
  for (const line of fs.readFileSync(CALIBRATION_INFO_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed) continue;
    const m = trimmed.match(/^slot(\d+):\s*(.+)$/);
    if (m) names[parseInt(m[1], 10)] = m[2].trim();
  }
  return names;
}

function findCardImagePath(cardName, idx) {
  const variants = [
    cardName.trim().toLowerCase(),
    cardName.trim().toLowerCase().replace(/·/g, '•'),
    cardName.trim().toLowerCase().replace(/•/g, '·'),
  ];
  for (const v of variants) {
    if (idx.has(v)) return idx.get(v);
  }
  return null;
}

async function findCardSlots(ssGray, ssW, ssH) {
  const tw = Math.round(ssW * SLOT_CONFIG_W / SLOT_BASE_W);
  const th = Math.round(ssH * SLOT_CONFIG_H / SLOT_BASE_H);
  const yMin = Math.floor(ssH * 0.10);
  const yMax = Math.floor(ssH * 0.88);

  const cardNames = parseCardNames();
  const imageIndex = buildImageIndex(IMAGES_DIR);
  const found = [];

  for (let slot = 1; slot <= 8; slot++) {
    await yieldToEventLoop();
    const cardName = cardNames[slot];
    if (!cardName) continue;
    const imgPath = findCardImagePath(cardName, imageIndex);
    if (!imgPath) continue;
    const tmpl = loadTemplateGray(imgPath);
    if (!tmpl) continue;
    const scaled = resizeGray(tmpl.gray, tmpl.width, tmpl.height, tw, th);
    const r = findBestCardPosition(ssGray, ssW, ssH, scaled, tw, th, yMin, yMax);
    found.push({ slot, x: r.x, y: r.y });
  }

  if (found.length < 4) {
    throw new Error(
      `Card slot detection found only ${found.length}/8 slots via template matching. ` +
      `Make sure cards_and_talent.txt lists the correct card names for all 8 slots.`
    );
  }

  // Average Y across all found cards for a stable slotY
  const slotY = Math.round(found.reduce((s, r) => s + r.y, 0) / found.length);

  // Build X position array; fill missing slots by interpolating from the average spacing
  const slotXPositions = new Array(8).fill(null);
  for (const r of found) slotXPositions[r.slot - 1] = r.x;

  if (found.length < 8) {
    const knownX = found.sort((a, b) => a.slot - b.slot);
    const gaps = [];
    for (let i = 1; i < knownX.length; i++)
      gaps.push((knownX[i].x - knownX[0].x) / (knownX[i].slot - knownX[0].slot));
    const avgGap = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length);
    const anchor = knownX[0];
    for (let i = 0; i < 8; i++) {
      if (slotXPositions[i] === null)
        slotXPositions[i] = Math.max(0, anchor.x + (i - (anchor.slot - 1)) * avgGap);
    }
  }

  return { slotY, slotHeight: th, slotWidth: tw, slotXPositions };
}

// ── Talent detection ─────────────────────────────────────────────────────────

function parseTalentNames() {
  if (!fs.existsSync(CALIBRATION_INFO_PATH)) return {};
  const names = {};
  for (const line of fs.readFileSync(CALIBRATION_INFO_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed) continue;
    const match = trimmed.match(/^talent(\d+):\s*(.+)$/);
    if (match) names[parseInt(match[1], 10)] = match[2].trim();
  }
  return names;
}

function findTalentTemplate(position, talentName) {
  const posDir = path.join(TALENT_TEMPLATES_DIR, `position_${position}`);
  if (!fs.existsSync(posDir)) return null;
  const key = talentName.trim().toLowerCase().replace(/\s+/g, '');
  for (const entry of fs.readdirSync(posDir)) {
    if (!entry.toLowerCase().endsWith('.png')) continue;
    const eKey = path.basename(entry, '.png').trim().toLowerCase().replace(/\s+/g, '');
    if (eKey === key) return path.join(posDir, entry);
  }
  return null;
}

async function findTalentPositions(ssGray, ssW, ssH, onProgress = null) {
  const talentNames = parseTalentNames();
  const rects = [];

  for (let pos = 1; pos <= 5; pos++) {
    onProgress?.(pos + 1, 7, `Finding talent ${pos}`);
    await yieldToEventLoop();

    // Prefer the named template from cards_and_talent.txt if available
    const talentName = talentNames[pos];
    const namedPath = talentName ? findTalentTemplate(pos, talentName) : null;

    let best = null;

    if (namedPath) {
      const tmpl = loadTemplateGray(namedPath);
      if (tmpl) best = findTalentMultiScale(ssGray, ssW, ssH, tmpl);
    }

    // If no named template or poor match, try all templates in this position's directory
    if (!best || best.ncc < 0.5) {
      const posDir = path.join(TALENT_TEMPLATES_DIR, `position_${pos}`);
      if (fs.existsSync(posDir)) {
        for (const file of fs.readdirSync(posDir)) {
          if (!file.toLowerCase().endsWith('.png')) continue;
          const tmpl = loadTemplateGray(path.join(posDir, file));
          if (!tmpl) continue;
          const r = findTalentMultiScale(ssGray, ssW, ssH, tmpl);
          if (!best || r.ncc > best.ncc) best = r;
          if (best.ncc >= 0.7) break; // good enough — stop early
        }
      }
    }

    rects.push(best ? { x: best.x, y: best.y, width: best.w, height: best.h, score: best.ncc } : null);
  }

  return rects;
}

// ── PNG encoder ──────────────────────────────────────────────────────────────

function writeU32be(buf, off, v) {
  buf[off]=(v>>>24)&0xFF; buf[off+1]=(v>>>16)&0xFF; buf[off+2]=(v>>>8)&0xFF; buf[off+3]=v&0xFF;
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makePngChunk(type, data) {
  const tb = Buffer.from(type, 'ascii');
  const lb = Buffer.alloc(4); writeU32be(lb, 0, data.length);
  const ci = Buffer.concat([tb, data]);
  const cb = Buffer.alloc(4); writeU32be(cb, 0, crc32(ci));
  return Buffer.concat([lb, tb, data, cb]);
}

function encodePng(rgba, width, height) {
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdrData = Buffer.alloc(13);
  writeU32be(ihdrData, 0, width); writeU32be(ihdrData, 4, height);
  ihdrData[8]=8; ihdrData[9]=6;
  const scanline = width * 4;
  const raw = Buffer.alloc(height * (1 + scanline));
  for (let y = 0; y < height; y++) {
    raw[y*(1+scanline)] = 0;
    for (let x = 0; x < width; x++) {
      const s=(y*width+x)*4, d=y*(1+scanline)+1+x*4;
      raw[d]=rgba[s]; raw[d+1]=rgba[s+1]; raw[d+2]=rgba[s+2]; raw[d+3]=rgba[s+3];
    }
  }
  return Buffer.concat([
    sig,
    makePngChunk('IHDR', ihdrData),
    makePngChunk('IDAT', zlib.deflateSync(raw)),
    makePngChunk('IEND', Buffer.alloc(0))
  ]);
}

function drawRect(rgba, imgW, imgH, x, y, w, h, r, g, b, thickness = 3) {
  for (let t = 0; t < thickness; t++) {
    for (let i = x; i < x+w; i++) {
      for (const row of [y+t, y+h-1-t]) {
        if (row < 0 || row >= imgH || i < 0 || i >= imgW) continue;
        const d=(row*imgW+i)*4; rgba[d]=r; rgba[d+1]=g; rgba[d+2]=b; rgba[d+3]=255;
      }
    }
    for (let j = y; j < y+h; j++) {
      for (const col of [x+t, x+w-1-t]) {
        if (j < 0 || j >= imgH || col < 0 || col >= imgW) continue;
        const d=(j*imgW+col)*4; rgba[d]=r; rgba[d+1]=g; rgba[d+2]=b; rgba[d+3]=255;
      }
    }
  }
}

// ── Main calibration entry point ───────────────────────────────────────────

async function performCalibration(screenshot, onProgress = null) {
  fs.writeFileSync(CALIBRATION_CAPTURE_PATH, screenshot.toPNG());

  // Decode screenshot from raw PNG bytes (same path as templates — no color profile transforms)
  // Use ssW/ssH from the decoded PNG (physical pixels), NOT screenshot.getSize() which returns logical pixels
  const ssImg = decodePng(CALIBRATION_CAPTURE_PATH);
  const { width: ssW, height: ssH } = ssImg;
  const ssGray = (() => {
    const { data, width, height } = ssImg;
    const gray = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++)
      gray[i] = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2];
    return gray;
  })();

  // Find card slot geometry via template matching (znccAt top-60%)
  onProgress?.(0, 7, 'Finding card slots');
  const { slotY, slotHeight, slotWidth, slotXPositions } = await findCardSlots(ssGray, ssW, ssH);
  onProgress?.(1, 7, 'Card slots found');

  // Save annotated debug image showing detected slot boxes
  const debugRgba = new Uint8Array(ssImg.data);
  const SLOT_COLORS = [[255,80,80],[255,165,0],[255,255,0],[80,255,80],[0,200,255],[80,80,255],[255,80,255],[255,255,255]];
  for (let i = 0; i < slotXPositions.length; i++) {
    const [r, g, b] = SLOT_COLORS[i % SLOT_COLORS.length];
    drawRect(debugRgba, ssW, ssH, slotXPositions[i], slotY, slotWidth, slotHeight, r, g, b, 3);
  }
  fs.writeFileSync(CALIBRATION_DEBUG_PATH, encodePng(debugRgba, ssW, ssH));

  await yieldToEventLoop();

  // Find talent positions via multi-scale circular ZNCC
  // TODO: re-enable when done debugging card slots
  const talentRects = await findTalentPositions(ssGray, ssW, ssH, onProgress);
  onProgress?.(7, 7, 'Done');

  return {
    version: 1,
    screenshotSize: { width: ssW, height: ssH },
    slots: {
      baseScreenWidth:  ssW,
      baseScreenHeight: ssH,
      slotY,
      slotWidth,
      slotHeight,
      slotXPositions
    },
    talents: talentRects.map((r) => r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null),
    scores: { talents: talentRects.map((r) => r?.score ?? 0) },
    calibratedAt: new Date().toISOString()
  };
}

module.exports = { performCalibration };
