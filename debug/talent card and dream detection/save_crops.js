/**
 * save_crops.js
 * Saves card crop regions from the debug screenshots as PNG files so you can
 * visually compare what the detector sees against the templates.
 *
 * Run from project root:
 *   node "debug/talent card and dream detection/save_crops.js"
 *
 * Outputs PNGs to debug/talent card and dream detection/crops/
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const os   = require('os');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEBUG_DIR    = __dirname;
const OUT_DIR      = path.join(DEBUG_DIR, 'crops');
const CAL_PATH     = path.join(os.homedir(), 'AppData', 'Roaming', 'yixian-overlay', 'calibration.json');
const IMAGES_DIR   = path.join(PROJECT_ROOT, 'images', 'seasonal');

// ── PNG decoder ──────────────────────────────────────────────────────────────
function readU32(buf, off) {
  return ((buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]) >>> 0;
}
function paethPredictor(a, b, c) {
  const p=a+b-c, pa=Math.abs(p-a), pb=Math.abs(p-b), pc=Math.abs(p-c);
  if (pa<=pb && pa<=pc) return a; if (pb<=pc) return b; return c;
}
function decodePng(filePath) {
  const buf = fs.readFileSync(filePath);
  const SIG = [137,80,78,71,13,10,26,10];
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error(`Not a PNG: ${filePath}`);
  let width, height, bitDepth, colorType, palette=null;
  const idatChunks=[];
  let pos=8;
  while (pos < buf.length-4) {
    const length=readU32(buf,pos), type=buf.slice(pos+4,pos+8).toString('ascii');
    const data=buf.slice(pos+8,pos+8+length);
    pos+=12+length;
    if (type==='IHDR'){width=readU32(data,0);height=readU32(data,4);bitDepth=data[8];colorType=data[9];}
    else if (type==='PLTE') palette=data;
    else if (type==='IDAT') idatChunks.push(data);
    else if (type==='IEND') break;
  }
  if (!width||!height) throw new Error(`Invalid PNG: ${filePath}`);
  const BPP={0:1,2:3,3:1,4:2,6:4};
  const bpp=BPP[colorType];
  const raw=zlib.inflateSync(Buffer.concat(idatChunks));
  const stride=width*bpp, rgba=new Uint8Array(width*height*4);
  let rawPos=0; const prevRow=new Uint8Array(stride);
  for (let y=0;y<height;y++){
    const filter=raw[rawPos++], row=new Uint8Array(stride);
    for (let i=0;i<stride;i++){
      const v=raw[rawPos++],a=i>=bpp?row[i-bpp]:0,b=prevRow[i],c=i>=bpp?prevRow[i-bpp]:0;
      if(filter===0)row[i]=v; else if(filter===1)row[i]=(v+a)&0xFF;
      else if(filter===2)row[i]=(v+b)&0xFF; else if(filter===3)row[i]=(v+((a+b)>>1))&0xFF;
      else if(filter===4)row[i]=(v+paethPredictor(a,b,c))&0xFF;
    }
    for (let x=0;x<width;x++){
      const s=x*bpp,d=(y*width+x)*4;
      if(colorType===0){rgba[d]=rgba[d+1]=rgba[d+2]=row[s];rgba[d+3]=255;}
      else if(colorType===2){rgba[d]=row[s];rgba[d+1]=row[s+1];rgba[d+2]=row[s+2];rgba[d+3]=255;}
      else if(colorType===3){const p=row[s]*3;rgba[d]=palette[p];rgba[d+1]=palette[p+1];rgba[d+2]=palette[p+2];rgba[d+3]=255;}
      else if(colorType===4){rgba[d]=rgba[d+1]=rgba[d+2]=row[s];rgba[d+3]=row[s+1];}
      else if(colorType===6){rgba[d]=row[s];rgba[d+1]=row[s+1];rgba[d+2]=row[s+2];rgba[d+3]=row[s+3];}
    }
    prevRow.set(row);
  }
  return { data: rgba, width, height };
}

// ── PNG encoder ──────────────────────────────────────────────────────────────
// Simple CRC32 for PNG chunks
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function makeChunk(type, data) {
  const tBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length);
  const payload = Buffer.concat([tBuf, data]);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(payload));
  return Buffer.concat([lenBuf, tBuf, data, crcBuf]);
}
function encodePng(rgbaData, width, height) {
  const rowBytes = width * 3;
  const raw = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4;
      const di = y * (rowBytes + 1) + 1 + x * 3;
      raw[di]   = rgbaData[si];
      raw[di+1] = rgbaData[si+1];
      raw[di+2] = rgbaData[si+2];
    }
  }
  const compressed = zlib.deflateSync(raw, { level: 1 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8]=8; ihdr[9]=2; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Bilinear crop+resize (RGBA) ───────────────────────────────────────────────
function cropRgba(src, cx, cy, cw, ch) {
  // Direct pixel copy (no resize) of a rectangle from decoded RGBA
  const out = new Uint8Array(cw * ch * 4);
  const SW = src.width;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = ((cy + y) * SW + (cx + x)) * 4;
      const di = (y * cw + x) * 4;
      out[di]   = src.data[si];
      out[di+1] = src.data[si+1];
      out[di+2] = src.data[si+2];
      out[di+3] = src.data[si+3];
    }
  }
  return { data: out, width: cw, height: ch };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalizeCardName(name) {
  return (name || '').replace(/[·•]/g, '•').trim();
}
function isDreamCard(name) {
  return normalizeCardName(name).startsWith('梦');
}
function parseHandCandidates(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const match = text.match(/Hand candidates:\s*(.+)/i);
  const list = match ? match[1] : text;
  // Handle both half-width and full-width commas
  return list.split(/[,，]/).map(s => s.trim()).filter(Boolean);
}

function walkDir(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkDir(full));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.png')) out.push(full);
  }
  return out;
}
function buildTemplateIndex(imagesDir) {
  const index = new Map();
  for (const fp of walkDir(imagesDir)) {
    const base = path.basename(fp, '.png');
    const m = base.match(/^(.*?)(\d+)?$/u);
    if (!m) continue;
    const norm = normalizeCardName(m[1]);
    if (!index.has(norm)) index.set(norm, []);
    index.get(norm).push(fp);
  }
  return index;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const cal    = JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'));
  const slots  = cal.slots;
  const normalGeo = {
    slotXPositions: slots.slotXPositions,
    slotY:    slots.slotY,
    slotWidth:  slots.slotWidth,
    slotHeight: slots.slotHeight,
  };
  const dreamGeo = slots.dreamGeometry;
  const tmplIndex = buildTemplateIndex(IMAGES_DIR);

  const TEST_CASES = [
    {
      name: 'round2',
      screenshot: path.join(DEBUG_DIR, 'fengxuround2.png'),
      handFile:   path.join(DEBUG_DIR, 'hand_outputround2.txt'),
    },
    {
      name: 'round4',
      screenshot: path.join(DEBUG_DIR, 'round4fengxu.png'),
      handFile:   path.join(DEBUG_DIR, 'hand_outputtound4.txt'),
    },
  ];

  for (const tc of TEST_CASES) {
    if (!fs.existsSync(tc.screenshot)) { console.log(`Skip ${tc.name}: no screenshot`); continue; }
    const hand = parseHandCandidates(tc.handFile);
    console.log(`\n=== ${tc.name} (${hand.length} cards) ===`);
    console.log(`Hand: ${hand.join(', ')}`);

    const ss = decodePng(tc.screenshot);

    // Save all 8 normal-slot crops
    for (let i = 0; i < Math.min(hand.length, 8); i++) {
      const cx = normalGeo.slotXPositions[i];
      const cy = normalGeo.slotY;
      const cw = normalGeo.slotWidth;
      const ch = normalGeo.slotHeight;
      if (cx + cw > ss.width || cy + ch > ss.height) continue;
      const crop = cropRgba(ss, cx, cy, cw, ch);
      const outPath = path.join(OUT_DIR, `${tc.name}_slot${i+1}_normal_${normalizeCardName(hand[i]).replace(/[•·]/g,'_')}.png`);
      fs.writeFileSync(outPath, encodePng(crop.data, crop.width, crop.height));
      console.log(`  Saved slot ${i+1} normal crop: ${path.basename(outPath)}`);
    }

    // For dream slots, also save the dream-geometry crop (both stored and +8 offset)
    for (let i = 0; i < Math.min(hand.length, 8); i++) {
      if (!isDreamCard(hand[i])) continue;

      if (dreamGeo) {
        const cx = dreamGeo.slotXPositions[i];
        const cy = dreamGeo.slotY;
        const cw = dreamGeo.slotWidth;
        const ch = dreamGeo.slotHeight;
        if (cx + cw <= ss.width && cy + ch <= ss.height) {
          const crop = cropRgba(ss, cx, cy, cw, ch);
          const outPath = path.join(OUT_DIR, `${tc.name}_slot${i+1}_dreamGeo_${normalizeCardName(hand[i]).replace(/[•·]/g,'_')}.png`);
          fs.writeFileSync(outPath, encodePng(crop.data, crop.width, crop.height));
          console.log(`  Saved slot ${i+1} dreamGeo crop: ${path.basename(outPath)}`);
        }
      }
    }

    // Save template images for dream cards in this hand
    const saved = new Set();
    for (const card of hand) {
      if (!isDreamCard(card)) continue;
      const norm = normalizeCardName(card);
      if (saved.has(norm)) continue;
      saved.add(norm);
      const tmpls = tmplIndex.get(norm) || [];
      console.log(`  Templates for "${norm}": ${tmpls.length} files`);
      for (const tp of tmpls) {
        const basename = path.basename(tp);
        const destPath = path.join(OUT_DIR, `TEMPLATE_${basename}`);
        if (!fs.existsSync(destPath)) fs.copyFileSync(tp, destPath);
        console.log(`    Copied template: ${basename}`);
      }
    }
  }

  console.log(`\nAll crops saved to: ${OUT_DIR}`);
  console.log('Open this folder and compare the slot crops against the TEMPLATE_ files.');
  console.log('If the crops look completely different from the templates, the templates need to be recaptured for that card phase/level.');
}

main();
