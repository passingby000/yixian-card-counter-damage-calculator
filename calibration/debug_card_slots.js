#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT_DIR          = path.resolve(__dirname, '..');
const CAPTURE_PATH      = path.join(__dirname, 'calibration_capture.png');
const CARDS_TXT_PATH    = path.join(__dirname, 'cards_and_talent.txt');
const IMAGES_DIR        = path.join(ROOT_DIR, 'images');
const OUT_PATH          = path.join(__dirname, 'debug_card_slots_result.png');

const SLOT_BASE_W   = 1920;
const SLOT_BASE_H   = 1080;
const SLOT_CONFIG_W = 212;
const SLOT_CONFIG_H = 343;

// ── PNG decoder ──────────────────────────────────────────────────────────────

function readU32(buf, off) {
  return ((buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]) >>> 0;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(filePath) {
  const buf = fs.readFileSync(filePath);
  const SIG = [137,80,78,71,13,10,26,10];
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('Not a PNG: ' + filePath);

  let width, height, bitDepth, colorType, palette = null;
  const idatChunks = [];
  let pos = 8;
  while (pos < buf.length - 4) {
    const length = readU32(buf, pos);
    const type   = buf.slice(pos+4, pos+8).toString('ascii');
    const data   = buf.slice(pos+8, pos+8+length);
    pos += 12 + length;
    if      (type === 'IHDR') { width=readU32(data,0); height=readU32(data,4); bitDepth=data[8]; colorType=data[9]; }
    else if (type === 'PLTE') { palette = data; }
    else if (type === 'IDAT') { idatChunks.push(data); }
    else if (type === 'IEND') { break; }
  }

  if (bitDepth !== 8) throw new Error('Unsupported bit depth: ' + bitDepth);
  const BPP = {0:1,2:3,3:1,4:2,6:4};
  const bpp = BPP[colorType];
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * bpp;
  const rgba = new Uint8Array(width * height * 4);
  let rawPos = 0;
  const prev = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++];
    const row = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const v = raw[rawPos++];
      const a = i >= bpp ? row[i-bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i-bpp] : 0;
      if      (filter === 0) row[i] = v;
      else if (filter === 1) row[i] = (v+a) & 0xFF;
      else if (filter === 2) row[i] = (v+b) & 0xFF;
      else if (filter === 3) row[i] = (v+((a+b)>>1)) & 0xFF;
      else if (filter === 4) row[i] = (v+paethPredictor(a,b,c)) & 0xFF;
    }
    for (let x = 0; x < width; x++) {
      const s = x*bpp, d = (y*width+x)*4;
      if      (colorType===0) { rgba[d]=rgba[d+1]=rgba[d+2]=row[s]; rgba[d+3]=255; }
      else if (colorType===2) { rgba[d]=row[s]; rgba[d+1]=row[s+1]; rgba[d+2]=row[s+2]; rgba[d+3]=255; }
      else if (colorType===3) { const p=row[s]*3; rgba[d]=palette[p]; rgba[d+1]=palette[p+1]; rgba[d+2]=palette[p+2]; rgba[d+3]=255; }
      else if (colorType===4) { rgba[d]=rgba[d+1]=rgba[d+2]=row[s]; rgba[d+3]=row[s+1]; }
      else if (colorType===6) { rgba[d]=row[s]; rgba[d+1]=row[s+1]; rgba[d+2]=row[s+2]; rgba[d+3]=row[s+3]; }
    }
    prev.set(row);
  }
  return { data: rgba, width, height };
}

// ── PNG encoder (RGB, filter-none) ───────────────────────────────────────────

function writeU32(buf, off, v) {
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

function makeChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  writeU32(len, 0, data.length);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  writeU32(crc, 0, crc32(crcInput));
  return Buffer.concat([len, typeBytes, data, crc]);
}

function encodePng(rgba, width, height) {
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);

  const ihdrData = Buffer.alloc(13);
  writeU32(ihdrData, 0, width); writeU32(ihdrData, 4, height);
  ihdrData[8]=8; ihdrData[9]=6; // 8-bit RGBA
  const ihdr = makeChunk('IHDR', ihdrData);

  // Build raw scanlines (filter byte 0 = None)
  const scanline = width * 4;
  const raw = Buffer.alloc(height * (1 + scanline));
  for (let y = 0; y < height; y++) {
    raw[y * (1+scanline)] = 0;
    for (let x = 0; x < width; x++) {
      const src = (y*width+x)*4;
      const dst = y*(1+scanline)+1+x*4;
      raw[dst]=rgba[src]; raw[dst+1]=rgba[src+1]; raw[dst+2]=rgba[src+2]; raw[dst+3]=rgba[src+3];
    }
  }
  const idat = makeChunk('IDAT', zlib.deflateSync(raw));
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

// ── Image utilities ──────────────────────────────────────────────────────────

function toGray(img) {
  const { data, width, height } = img;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++)
    gray[i] = 0.299*data[i*4] + 0.587*data[i*4+1] + 0.114*data[i*4+2];
  return { gray, width, height };
}

function resizeGray(srcGray, srcW, srcH, dstW, dstH) {
  const out = new Float32Array(dstW * dstH);
  const rx = srcW / dstW, ry = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const fx = dx*rx, fy = dy*ry;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(x0+1, srcW-1), y1 = Math.min(y0+1, srcH-1);
      const wx = fx-x0, wy = fy-y0;
      out[dy*dstW+dx] = (1-wx)*(1-wy)*srcGray[y0*srcW+x0] + wx*(1-wy)*srcGray[y0*srcW+x1]
                      + (1-wx)*wy*srcGray[y1*srcW+x0]     + wx*wy*srcGray[y1*srcW+x1];
    }
  }
  return out;
}

function downsample(gray, w, h, ds) {
  const dw = Math.floor(w/ds), dh = Math.floor(h/ds);
  const out = new Float32Array(dw*dh);
  for (let y = 0; y < dh; y++)
    for (let x = 0; x < dw; x++)
      out[y*dw+x] = gray[(y*ds)*w+(x*ds)];
  return { gray: out, w: dw, h: dh };
}

function znccAt(ssGray, ssW, sx, sy, tmplGray, tw, th) {
  const n = tw * th;
  let sumI = 0, sumT = 0;
  for (let ty = 0; ty < th; ty++)
    for (let tx = 0; tx < tw; tx++) {
      sumI += ssGray[(sy+ty)*ssW+(sx+tx)];
      sumT += tmplGray[ty*tw+tx];
    }
  const mI = sumI/n, mT = sumT/n;
  let num = 0, denI = 0, denT = 0;
  for (let ty = 0; ty < th; ty++)
    for (let tx = 0; tx < tw; tx++) {
      const di = ssGray[(sy+ty)*ssW+(sx+tx)] - mI;
      const dt = tmplGray[ty*tw+tx] - mT;
      num += di*dt; denI += di*di; denT += dt*dt;
    }
  const denom = Math.sqrt(denI*denT);
  return denom < 1 ? 0 : num/denom;
}

function findBestPosition(ssGray, ssW, ssH, tmplGray, tw, th, yMin, yMax) {
  const DS = 4;
  const ss4 = downsample(ssGray, ssW, ssH, DS);
  const tw4 = Math.max(1, Math.floor(tw/DS));
  const th4 = Math.max(1, Math.floor(th/DS));
  const tm4 = resizeGray(tmplGray, tw, th, tw4, th4);

  const cy0 = Math.max(0, Math.floor(yMin/DS));
  const cy1 = Math.min(ss4.h-th4, Math.floor(yMax/DS));
  const cx1 = ss4.w - tw4;

  let coarseBest = -Infinity, coarseX = 0, coarseY = cy0;
  for (let y = cy0; y <= cy1; y++)
    for (let x = 0; x <= cx1; x++) {
      const score = znccAt(ss4.gray, ss4.w, x, y, tm4, tw4, th4);
      if (score > coarseBest) { coarseBest = score; coarseX = x; coarseY = y; }
    }

  const margin = DS * 3;
  const fy0 = Math.max(yMin, coarseY*DS-margin);
  const fy1 = Math.min(Math.min(yMax, ssH-th), coarseY*DS+margin);
  const fx0 = Math.max(0, coarseX*DS-margin);
  const fx1 = Math.min(ssW-tw, coarseX*DS+margin);

  let fineBest = -Infinity, bestX = coarseX*DS, bestY = coarseY*DS;
  for (let y = fy0; y <= fy1; y++)
    for (let x = fx0; x <= fx1; x++) {
      const score = znccAt(ssGray, ssW, x, y, tmplGray, tw, th);
      if (score > fineBest) { fineBest = score; bestX = x; bestY = y; }
    }
  return { x: bestX, y: bestY, ncc: fineBest };
}

// ── Drawing ──────────────────────────────────────────────────────────────────

function drawRect(rgba, imgW, imgH, x, y, w, h, r, g, b, thickness = 3) {
  for (let t = 0; t < thickness; t++) {
    for (let i = x; i < x+w; i++) {
      for (const row of [y+t, y+h-1-t]) {
        if (row < 0 || row >= imgH || i < 0 || i >= imgW) continue;
        const d = (row*imgW+i)*4;
        rgba[d]=r; rgba[d+1]=g; rgba[d+2]=b; rgba[d+3]=255;
      }
    }
    for (let j = y; j < y+h; j++) {
      for (const col of [x+t, x+w-1-t]) {
        if (j < 0 || j >= imgH || col < 0 || col >= imgW) continue;
        const d = (j*imgW+col)*4;
        rgba[d]=r; rgba[d+1]=g; rgba[d+2]=b; rgba[d+3]=255;
      }
    }
  }
}

function drawLabel(rgba, imgW, imgH, x, y, text) {
  // Simple 1-char label using a dot marker (no font rendering)
  for (let dy = -4; dy <= 4; dy++)
    for (let dx = -4; dx <= 4; dx++) {
      const px = x+dx, py = y+dy;
      if (px < 0 || px >= imgW || py < 0 || py >= imgH) continue;
      const d = (py*imgW+px)*4;
      rgba[d]=255; rgba[d+1]=255; rgba[d+2]=0; rgba[d+3]=255;
    }
}

// ── File helpers ─────────────────────────────────────────────────────────────

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
  if (!fs.existsSync(CARDS_TXT_PATH)) return {};
  const names = {};
  for (const line of fs.readFileSync(CARDS_TXT_PATH, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith('#') || !t) continue;
    const m = t.match(/^slot(\d+):\s*(.+)$/);
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
  for (const v of variants) if (idx.has(v)) return idx.get(v);
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(CAPTURE_PATH)) {
    console.error('Missing:', CAPTURE_PATH);
    process.exit(1);
  }

  console.log('Loading screenshot...');
  const ssImg = decodePng(CAPTURE_PATH);
  const { gray: ssGray, width: ssW, height: ssH } = toGray(ssImg);

  const tw = Math.round(ssW * SLOT_CONFIG_W / SLOT_BASE_W);
  const th = Math.round(ssH * SLOT_CONFIG_H / SLOT_BASE_H);
  const yMin = Math.floor(ssH * 0.10);
  const yMax = Math.floor(ssH * 0.88);

  console.log(`Screenshot: ${ssW}x${ssH}  Template size: ${tw}x${th}`);

  const cardNames = parseCardNames();
  const imageIndex = buildImageIndex(IMAGES_DIR);

  // Make a mutable copy of the screenshot RGBA for drawing
  const outRgba = new Uint8Array(ssImg.data);

  const COLORS = [
    [255,  80,  80], [255,165,   0], [255,255,   0], [80, 255,  80],
    [  0, 200, 255], [ 80,  80, 255], [255,  80, 255], [255,255,255],
  ];

  for (let slot = 1; slot <= 8; slot++) {
    const cardName = cardNames[slot];
    if (!cardName) { console.log(`Slot ${slot}: no name in cards_and_talent.txt`); continue; }

    const imgPath = findCardImagePath(cardName, imageIndex);
    if (!imgPath) { console.log(`Slot ${slot}: image not found for "${cardName}"`); continue; }

    process.stdout.write(`Slot ${slot} (${cardName})... `);
    const tmplImg = decodePng(imgPath);
    const { gray: tmplGray, width: tmplW, height: tmplH } = toGray(tmplImg);
    const scaled = resizeGray(tmplGray, tmplW, tmplH, tw, th);
    const r = findBestPosition(ssGray, ssW, ssH, scaled, tw, th, yMin, yMax);

    console.log(`x=${r.x} y=${r.y} ncc=${r.ncc.toFixed(3)}`);
    const [cr, cg, cb] = COLORS[(slot-1) % COLORS.length];
    drawRect(outRgba, ssW, ssH, r.x, r.y, tw, th, cr, cg, cb, 3);
    drawLabel(outRgba, ssW, ssH, r.x + 10, r.y + 10, String(slot));
  }

  fs.writeFileSync(OUT_PATH, encodePng(outRgba, ssW, ssH));
  console.log('\nSaved:', OUT_PATH);
}

main();
