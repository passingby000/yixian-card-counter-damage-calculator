#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT_DIR        = path.resolve(__dirname, '..');
const SCREENSHOT_PATH = path.join(__dirname, 'fengxu phase1 test.png');
const CALIBRATION_PATH = path.join(process.env.APPDATA || '', 'yixian-overlay', 'calibration.json');
const TEMPLATES_DIR   = path.join(ROOT_DIR, 'vendor', 'yisim-master', 'lanke', 'talent_templates', 'position_1');
const OUTPUT_PATH     = path.join(__dirname, 'debug_talent1_result.png');

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
  let width, height, bitDepth, colorType, palette = null;
  const idatChunks = [];
  let pos = 8;
  while (pos < buf.length - 4) {
    const length = readU32(buf, pos);
    const type   = buf.slice(pos + 4, pos + 8).toString('ascii');
    const data   = buf.slice(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === 'IHDR') { width=readU32(data,0); height=readU32(data,4); bitDepth=data[8]; colorType=data[9]; }
    else if (type === 'PLTE') { palette = data; }
    else if (type === 'IDAT') { idatChunks.push(data); }
    else if (type === 'IEND') { break; }
  }
  const BPP_MAP = { 0:1, 2:3, 3:1, 4:2, 6:4 };
  const bpp = BPP_MAP[colorType];
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * bpp;
  const rgba = new Uint8Array(width * height * 4);
  let rawPos = 0;
  const prevRow = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++];
    const row = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const v=raw[rawPos++], a=i>=bpp?row[i-bpp]:0, b=prevRow[i], c=i>=bpp?prevRow[i-bpp]:0;
      if      (filter===0) row[i]=v;
      else if (filter===1) row[i]=(v+a)&0xFF;
      else if (filter===2) row[i]=(v+b)&0xFF;
      else if (filter===3) row[i]=(v+((a+b)>>1))&0xFF;
      else if (filter===4) row[i]=(v+paethPredictor(a,b,c))&0xFF;
    }
    for (let x = 0; x < width; x++) {
      const s=x*bpp, d=(y*width+x)*4;
      if      (colorType===0) { rgba[d]=rgba[d+1]=rgba[d+2]=row[s]; rgba[d+3]=255; }
      else if (colorType===2) { rgba[d]=row[s]; rgba[d+1]=row[s+1]; rgba[d+2]=row[s+2]; rgba[d+3]=255; }
      else if (colorType===3) { const p=row[s]*3; rgba[d]=palette[p]; rgba[d+1]=palette[p+1]; rgba[d+2]=palette[p+2]; rgba[d+3]=255; }
      else if (colorType===4) { rgba[d]=rgba[d+1]=rgba[d+2]=row[s]; rgba[d+3]=row[s+1]; }
      else if (colorType===6) { rgba[d]=row[s]; rgba[d+1]=row[s+1]; rgba[d+2]=row[s+2]; rgba[d+3]=row[s+3]; }
    }
    prevRow.set(row);
  }
  return { data: rgba, width, height };
}

function toGray({ data, width, height }) {
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
      const fx=dx*rx, fy=dy*ry;
      const x0=Math.floor(fx), y0=Math.floor(fy);
      const x1=Math.min(x0+1,srcW-1), y1=Math.min(y0+1,srcH-1);
      const wx=fx-x0, wy=fy-y0;
      out[dy*dstW+dx] = (1-wx)*(1-wy)*srcGray[y0*srcW+x0] + wx*(1-wy)*srcGray[y0*srcW+x1]
                      + (1-wx)*wy*srcGray[y1*srcW+x0]     + wx*wy*srcGray[y1*srcW+x1];
    }
  }
  return out;
}

// Circular ZNCC
function znccCircular(ssGray, ssW, sx, sy, tmplGray, tw, th) {
  const cx=(tw-1)/2, cy=(th-1)/2, r2=(Math.min(tw,th)/2)**2;
  let sumI=0, sumT=0, n=0;
  for (let ty=0; ty<th; ty++) for (let tx=0; tx<tw; tx++) {
    if ((tx-cx)**2+(ty-cy)**2>r2) continue;
    sumI+=ssGray[(sy+ty)*ssW+(sx+tx)]; sumT+=tmplGray[ty*tw+tx]; n++;
  }
  if (n===0) return 0;
  const mI=sumI/n, mT=sumT/n;
  let num=0, denI=0, denT=0;
  for (let ty=0; ty<th; ty++) for (let tx=0; tx<tw; tx++) {
    if ((tx-cx)**2+(ty-cy)**2>r2) continue;
    const di=ssGray[(sy+ty)*ssW+(sx+tx)]-mI, dt=tmplGray[ty*tw+tx]-mT;
    num+=di*dt; denI+=di*di; denT+=dt*dt;
  }
  const denom=Math.sqrt(denI*denT);
  return denom<1?0:num/denom;
}

// ── PNG encoder ──────────────────────────────────────────────────────────────

function encodePng(rgba, width, height) {
  function u32(n) { const b=Buffer.alloc(4); b.writeUInt32BE(n,0); return b; }
  function chunk(type, data) {
    const t=Buffer.from(type,'ascii');
    const crc=require('zlib').crc32 ? 0 : (() => {
      let c=0xFFFFFFFF;
      const poly=0xEDB88320;
      const all=Buffer.concat([t,data]);
      for (const byte of all) { c^=byte; for (let i=0;i<8;i++) c=(c&1)?(c>>>1)^poly:(c>>>1); }
      return (c^0xFFFFFFFF)>>>0;
    })();
    // manual crc32
    let c=0xFFFFFFFF; const poly=0xEDB88320;
    for (const byte of Buffer.concat([t,data])) { c^=byte; for(let i=0;i<8;i++) c=(c&1)?(c>>>1)^poly:(c>>>1); }
    c=(c^0xFFFFFFFF)>>>0;
    return Buffer.concat([u32(data.length), t, data, u32(c)]);
  }
  const ihdr=Buffer.alloc(13);
  ihdr.writeUInt32BE(width,0); ihdr.writeUInt32BE(height,4);
  ihdr[8]=8; ihdr[9]=6; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;
  const raw=Buffer.alloc(height*(1+width*4));
  for (let y=0;y<height;y++) {
    raw[y*(1+width*4)]=0;
    for (let x=0;x<width;x++) {
      const si=(y*width+x)*4, di=y*(1+width*4)+1+x*4;
      raw[di]=rgba[si]; raw[di+1]=rgba[si+1]; raw[di+2]=rgba[si+2]; raw[di+3]=rgba[si+3];
    }
  }
  const idat=zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR',ihdr), chunk('IDAT',idat), chunk('IEND',Buffer.alloc(0))
  ]);
}

function drawRect(rgba, width, r, g, b, rx, ry, rw, rh, thick=2) {
  for (let t=0;t<thick;t++) {
    for (let x=rx;x<rx+rw;x++) {
      for (const y of [ry+t, ry+rh-1-t]) {
        if (x>=0&&x<width&&y>=0&&y<rgba.length/4/width) {
          const i=(y*width+x)*4; rgba[i]=r; rgba[i+1]=g; rgba[i+2]=b; rgba[i+3]=255;
        }
      }
    }
    for (let y=ry;y<ry+rh;y++) {
      for (const x of [rx+t, rx+rw-1-t]) {
        if (x>=0&&x<width&&y>=0&&y<rgba.length/4/width) {
          const i=(y*width+x)*4; rgba[i]=r; rgba[i+1]=g; rgba[i+2]=b; rgba[i+3]=255;
        }
      }
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const ss    = decodePng(SCREENSHOT_PATH);
const ssG   = toGray(ss);
const cal   = JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf8'));
const calRect = cal.talents?.[0];

console.log('Screenshot:', ss.width, 'x', ss.height);
console.log('Calibration talent[0] rect:', calRect);
console.log('Calibration screenshotSize:', cal.screenshotSize);

if (!calRect) { console.error('No talent[0] in calibration.json'); process.exit(1); }

// Scale rect to current screenshot size
const scaleX = ss.width  / cal.screenshotSize.width;
const scaleY = ss.height / cal.screenshotSize.height;
const scaledRect = {
  x:      Math.round(calRect.x      * scaleX),
  y:      Math.round(calRect.y      * scaleY),
  width:  Math.round(calRect.width  * scaleX),
  height: Math.round(calRect.height * scaleY),
};
console.log('Scaled rect:', scaledRect);

// Load all templates from position_1
const templates = fs.readdirSync(TEMPLATES_DIR)
  .filter(f => f.toLowerCase().endsWith('.png'))
  .map(f => ({ name: path.basename(f, '.png'), img: decodePng(path.join(TEMPLATES_DIR, f)) }));

console.log(`Loaded ${templates.length} templates from position_1`);

// Try rect at multiple size offsets (d = 0, -1, -2, -3, 1, 2, 3)
const offsets = [0, -1, 1, -2, 2, -3, 3];
let best = null;

for (const tmpl of templates) {
  const tmplG = toGray(tmpl.img);
  for (const d of offsets) {
    const rw = Math.max(4, scaledRect.width  + d * 2);
    const rh = Math.max(4, scaledRect.height + d * 2);
    const rx = scaledRect.x - d;
    const ry = scaledRect.y - d;
    if (rx < 0 || ry < 0 || rx + rw > ss.width || ry + rh > ss.height) continue;
    const scaled = resizeGray(tmplG.gray, tmplG.width, tmplG.height, rw, rh);
    const score = znccCircular(ssG.gray, ss.width, rx, ry, scaled, rw, rh);
    if (!best || score > best.score) {
      best = { score, name: tmpl.name, d, rect: { x: rx, y: ry, width: rw, height: rh } };
    }
  }
  console.log(`  ${tmpl.name}: best score across offsets = ${
    offsets.map(d => {
      const rw=Math.max(4,scaledRect.width+d*2), rh=Math.max(4,scaledRect.height+d*2);
      const rx=scaledRect.x-d, ry=scaledRect.y-d;
      if (rx<0||ry<0||rx+rw>ss.width||ry+rh>ss.height) return 'OOB';
      const sc=resizeGray(tmplG.gray,tmplG.width,tmplG.height,rw,rh);
      const s=znccCircular(ssG.gray,ss.width,rx,ry,sc,rw,rh);
      return s.toFixed(3);
    }).join(', ')
  }`);
}

console.log('\nBest overall:', best);

// Draw calibrated rect (white) and best rect (green) on screenshot
const out = new Uint8Array(ss.data);
drawRect(out, ss.width, 255, 255, 255, scaledRect.x, scaledRect.y, scaledRect.width, scaledRect.height);
if (best) drawRect(out, ss.width, 0, 255, 80, best.rect.x, best.rect.y, best.rect.width, best.rect.height, 3);

fs.writeFileSync(OUTPUT_PATH, encodePng(out, ss.width, ss.height));
console.log('Saved:', OUTPUT_PATH);
