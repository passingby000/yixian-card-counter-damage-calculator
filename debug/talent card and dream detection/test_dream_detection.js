/**
 * test_dream_detection.js  (v3 — adds personal/talent-card geometry grid search)
 *
 * Replicates the production detectSlots() logic in pure Node.js (no Electron):
 *  - All hand candidates compared against ALL 8 slots
 *  - Dream candidates use dream geometry; normal candidates use normal geometry
 *  - Grid search over dream xOffset / size to find the best geometry      [B]
 *  - Grid search over personal (talent-card) xOffset / size               [C]
 *
 * Run from project root:
 *   node "debug/talent card and dream detection/test_dream_detection.js"
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const os   = require('os');

const PROJECT_ROOT   = path.resolve(__dirname, '..', '..');
const DEBUG_DIR      = __dirname;
const CAL_PATH       = path.join(os.homedir(), 'AppData', 'Roaming', 'yixian-overlay', 'calibration.json');
const CONFIG_PATH    = path.join(PROJECT_ROOT, 'slot_detector_config.json');
const SEASONAL_DIR   = path.join(PROJECT_ROOT, 'images', 'seasonal');
const PERSONAL_DIR   = path.join(PROJECT_ROOT, 'images', 'personal');

const DREAM_JITTER = 14;  // jitter sweep radius for dream card grid search (diagnostic only)

// ── PNG decoder ──────────────────────────────────────────────────────────────

function readU32(buf, off) {
  return ((buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]) >>> 0;
}
function paeth(a, b, c) {
  const p=a+b-c, pa=Math.abs(p-a), pb=Math.abs(p-b), pc=Math.abs(p-c);
  return (pa<=pb && pa<=pc) ? a : pb<=pc ? b : c;
}
function decodePng(filePath) {
  const buf = fs.readFileSync(filePath);
  const SIG = [137,80,78,71,13,10,26,10];
  for (let i=0;i<8;i++) if(buf[i]!==SIG[i]) throw new Error(`Not a PNG: ${filePath}`);
  let width,height,bitDepth,colorType,palette=null; const idatChunks=[]; let pos=8;
  while(pos<buf.length-4){
    const length=readU32(buf,pos), type=buf.slice(pos+4,pos+8).toString('ascii'), data=buf.slice(pos+8,pos+8+length);
    pos+=12+length;
    if(type==='IHDR'){width=readU32(data,0);height=readU32(data,4);bitDepth=data[8];colorType=data[9];}
    else if(type==='PLTE') palette=data;
    else if(type==='IDAT') idatChunks.push(data);
    else if(type==='IEND') break;
  }
  if(!width||!height) throw new Error(`Invalid PNG: ${filePath}`);
  const BPP={0:1,2:3,3:1,4:2,6:4}, bpp=BPP[colorType];
  const raw=zlib.inflateSync(Buffer.concat(idatChunks)), stride=width*bpp;
  const rgba=new Uint8Array(width*height*4); let rawPos=0;
  const prevRow=new Uint8Array(stride);
  for(let y=0;y<height;y++){
    const filter=raw[rawPos++], row=new Uint8Array(stride);
    for(let i=0;i<stride;i++){
      const v=raw[rawPos++],a=i>=bpp?row[i-bpp]:0,b=prevRow[i],c=i>=bpp?prevRow[i-bpp]:0;
      if(filter===0)row[i]=v; else if(filter===1)row[i]=(v+a)&0xFF;
      else if(filter===2)row[i]=(v+b)&0xFF; else if(filter===3)row[i]=(v+((a+b)>>1))&0xFF;
      else if(filter===4)row[i]=(v+paeth(a,b,c))&0xFF;
    }
    for(let x=0;x<width;x++){
      const s=x*bpp,d=(y*width+x)*4;
      if(colorType===0){rgba[d]=rgba[d+1]=rgba[d+2]=row[s];rgba[d+3]=255;}
      else if(colorType===2){rgba[d]=row[s];rgba[d+1]=row[s+1];rgba[d+2]=row[s+2];rgba[d+3]=255;}
      else if(colorType===3){const p=row[s]*3;rgba[d]=palette[p];rgba[d+1]=palette[p+1];rgba[d+2]=palette[p+2];rgba[d+3]=255;}
      else if(colorType===4){rgba[d]=rgba[d+1]=rgba[d+2]=row[s];rgba[d+3]=row[s+1];}
      else if(colorType===6){rgba[d]=row[s];rgba[d+1]=row[s+1];rgba[d+2]=row[s+2];rgba[d+3]=row[s+3];}
    }
    prevRow.set(row);
  }
  return {data:rgba,width,height};
}

// Convert RGBA → Float32 RGB (R,G,B 0-255)
function toRgb(dec) {
  const {data,width,height}=dec, rgb=new Float32Array(width*height*3);
  for(let i=0;i<width*height;i++){rgb[i*3]=data[i*4];rgb[i*3+1]=data[i*4+1];rgb[i*3+2]=data[i*4+2];}
  return {rgb,width,height};
}
// Convert RGBA → Float32 gray (BT.601)
function toGray(dec) {
  const {data,width,height}=dec, gray=new Float32Array(width*height);
  for(let i=0;i<width*height;i++) gray[i]=0.299*data[i*4]+0.587*data[i*4+1]+0.114*data[i*4+2];
  return {gray,width,height};
}

// ── Image operations ─────────────────────────────────────────────────────────

// Bilinear crop+resize (RGB)
function extractSubRgb(src, cx, cy, cw, ch, dstW, dstH) {
  const out=new Float32Array(dstW*dstH*3), scaleX=cw/dstW, scaleY=ch/dstH, SW=src.width;
  for(let dy=0;dy<dstH;dy++) for(let dx=0;dx<dstW;dx++){
    const sx=cx+dx*scaleX, sy=cy+dy*scaleY, x0=Math.floor(sx), y0=Math.floor(sy);
    const x1=Math.min(x0+1,SW-1), y1=Math.min(y0+1,src.height-1), wx=sx-x0, wy=sy-y0;
    const base=(dy*dstW+dx)*3;
    for(let c=0;c<3;c++) out[base+c]=(1-wx)*(1-wy)*src.rgb[(y0*SW+x0)*3+c]+wx*(1-wy)*src.rgb[(y0*SW+x1)*3+c]+(1-wx)*wy*src.rgb[(y1*SW+x0)*3+c]+wx*wy*src.rgb[(y1*SW+x1)*3+c];
  }
  return {rgb:out,width:dstW,height:dstH};
}
// Bilinear crop+resize (gray)
function extractSubGray(src, cx, cy, cw, ch, dstW, dstH) {
  const out=new Float32Array(dstW*dstH), scaleX=cw/dstW, scaleY=ch/dstH, SW=src.width;
  for(let dy=0;dy<dstH;dy++) for(let dx=0;dx<dstW;dx++){
    const sx=cx+dx*scaleX, sy=cy+dy*scaleY, x0=Math.floor(sx), y0=Math.floor(sy);
    const x1=Math.min(x0+1,SW-1), y1=Math.min(y0+1,src.height-1), wx=sx-x0, wy=sy-y0;
    out[dy*dstW+dx]=(1-wx)*(1-wy)*src.gray[y0*SW+x0]+wx*(1-wy)*src.gray[y0*SW+x1]+(1-wx)*wy*src.gray[y1*SW+x0]+wx*wy*src.gray[y1*SW+x1];
  }
  return {gray:out,width:dstW,height:dstH};
}

// Fast direct RGB MSE at integer offset (no resize) — for jitter sweep
function fastMseDirect(src, ox, oy, tw, th, tmplRgb) {
  const SW=src.width, sr=src.rgb, tr=tmplRgb.rgb; let sum=0;
  for(let ty=0;ty<th;ty++){
    const sRow=((oy+ty)*SW+ox)*3, tRow=ty*tw*3;
    for(let tx=0;tx<tw;tx++){
      const sp=sRow+tx*3, tp=tRow+tx*3;
      const dr=sr[sp]-tr[tp], dg=sr[sp+1]-tr[tp+1], db=sr[sp+2]-tr[tp+2];
      sum+=dr*dr+dg*dg+db*db;
    }
  }
  return sum/(tw*th*3);
}

// Region-weighted RGB MSE (matches production regionRgbMse)
function regionRgbMse(rgbA, rgbB, region) {
  const {width,height}=rgbA;
  const x0=Math.max(0,Math.floor(region.x*width)), y0=Math.max(0,Math.floor(region.y*height));
  const x1=Math.min(width,Math.ceil((region.x+region.width)*width)), y1=Math.min(height,Math.ceil((region.y+region.height)*height));
  const count=Math.max(1,(x1-x0)*(y1-y0)*3); let total=0;
  for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){
    const idx=(y*width+x)*3;
    const dr=rgbA.rgb[idx]-rgbB.rgb[idx], dg=rgbA.rgb[idx+1]-rgbB.rgb[idx+1], db=rgbA.rgb[idx+2]-rgbB.rgb[idx+2];
    total+=dr*dr+dg*dg+db*db;
  }
  return total/count;
}

// Region stats for SSIM/NCC/grayMSE (matches production regionStats)
function regionStats(gA, gB, region) {
  const {width,height}=gA;
  const x0=Math.max(0,Math.floor(region.x*width)), y0=Math.max(0,Math.floor(region.y*height));
  const x1=Math.min(width,Math.ceil((region.x+region.width)*width)), y1=Math.min(height,Math.ceil((region.y+region.height)*height));
  const count=Math.max(1,(x1-x0)*(y1-y0));
  let sumA=0,sumB=0,gMse=0;
  for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){
    const idx=y*width+x, d=gA.gray[idx]-gB.gray[idx];
    sumA+=gA.gray[idx];sumB+=gB.gray[idx];gMse+=d*d;
  }
  const mA=sumA/count, mB=sumB/count;
  let vA=0,vB=0,cov=0,num=0,denA=0,denB=0;
  for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){
    const idx=y*width+x, ca=gA.gray[idx]-mA, cb=gB.gray[idx]-mB;
    vA+=ca*ca;vB+=cb*cb;cov+=ca*cb;
    num+=gA.gray[idx]*gB.gray[idx];denA+=gA.gray[idx]*gA.gray[idx];denB+=gB.gray[idx]*gB.gray[idx];
  }
  const div=Math.max(1,count-1); vA/=div;vB/=div;cov/=div;
  const c1=6.5025,c2=58.5225;
  const ssim=((2*mA*mB+c1)*(2*cov+c2))/(((mA*mA+mB*mB+c1)*(vA+vB+c2))||1);
  const ncc=(Math.sqrt(denA*denB))<1?0:num/Math.sqrt(denA*denB);
  return {ssim:Number.isFinite(ssim)?ssim:0,ncc:Number.isFinite(ncc)?ncc:0,grayMse:gMse/count};
}

// Full weighted-region comparison (matches production compareImages)
function compareImages(grayA, rgbA, grayB, rgbB, regions) {
  let wSSIM=0,wNCC=0,wGMse=0,wRMse=0,wTotal=0;
  for(const r of regions){
    const {ssim,ncc,grayMse}=regionStats(grayA,grayB,r);
    wSSIM+=ssim*r.weight;wNCC+=ncc*r.weight;wGMse+=grayMse*r.weight;
    wRMse+=regionRgbMse(rgbA,rgbB,r)*r.weight;wTotal+=r.weight;
  }
  if(wTotal===0) return {ssim:0,ncc:0,grayMse:Infinity,rgbMse:Infinity};
  return {ssim:wSSIM/wTotal,ncc:wNCC/wTotal,grayMse:wGMse/wTotal,rgbMse:wRMse/wTotal};
}

// ── Card name helpers ────────────────────────────────────────────────────────

function normalizeName(name) {
  return (name||'').replace(/[·•]/g,'•').trim();
}
function isDream(name) {
  return normalizeName(name).startsWith('梦');
}

// ── Template loading ─────────────────────────────────────────────────────────

function walkDir(dir) {
  let out=[];
  for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,e.name);
    if(e.isDirectory()) out=out.concat(walkDir(full));
    else if(e.isFile()&&e.name.toLowerCase().endsWith('.png')) out.push(full);
  }
  return out;
}

// Build index: normalizedCardName → [{filePath, isDream, isSeasonal, isPersonal, gray, rgb, width, height}]
// Loads from both seasonal and personal directories.
function buildIndex(seasonalDir, personalDir) {
  const index = new Map();

  function ingest(dirPath) {
    if(!fs.existsSync(dirPath)) return;
    for(const fp of walkDir(dirPath)){
      const base = path.basename(fp,'.png');
      // Require a trailing number (matches production parseTemplateFilename)
      const m = base.match(/^(.*?)(\d+)$/u);
      if(!m) continue;
      const cardName = normalizeName(m[1]);
      if(!cardName) continue;
      const isSeasonal  = fp.includes(`${path.sep}seasonal${path.sep}`);
      const isPersonal  = fp.includes(`${path.sep}personal${path.sep}`);
      const isD = isDream(cardName);
      let tmpl;
      try {
        const dec = decodePng(fp);
        const grayData = toGray(dec);
        const rgbData  = toRgb(dec);
        tmpl = {filePath:fp,fileName:path.basename(fp),isDream:isD,isSeasonal,isPersonal,
                 gray:grayData,rgb:rgbData,width:dec.width,height:dec.height};
      } catch(e) { continue; }
      if(!index.has(cardName)) index.set(cardName,[]);
      index.get(cardName).push(tmpl);
    }
  }

  ingest(seasonalDir);
  ingest(personalDir);
  return index;
}

// Get templates for a candidate card name filtered by type.
// type: 'dream' (seasonal dream), 'personal', 'normal' (non-dream, non-personal)
function getTemplates(cardName, index, type) {
  const norm = normalizeName(cardName);
  const strippedName = norm.replace(/\d+$/,'');
  const keys = norm!==strippedName ? [norm,strippedName] : [norm];
  const all = keys.flatMap(k=>index.get(k)||[]);
  const seen = new Set();
  return all.filter(t=>{
    if(seen.has(t.filePath)) return false;
    seen.add(t.filePath);
    if(type==='dream')     return t.isDream && t.isSeasonal;
    if(type==='personal')  return t.isPersonal && !t.isDream;
    return !t.isDream && !t.isPersonal;  // normal/sect
  });
}

// ── Hand candidate parser ────────────────────────────────────────────────────

function parseHand(filePath) {
  const text = fs.readFileSync(filePath,'utf8');
  const match = text.match(/Hand candidates:\s*(.+)/i);
  const list = match ? match[1] : text;
  return list.split(/[,，]/).map(s=>s.trim()).filter(Boolean);
}

// ── Per-slot scoring (matches detectSlots logic) ─────────────────────────────

/**
 * Score a single template against a single slot using a given dream geometry.
 * Returns {mse, bestCropX, bestCropY} — uses jitter for dream, direct for normal.
 */
function scoreTemplateAtSlot(srcRgb, srcGray, slotIndex, template, normalGeo, dreamXOff, dreamW, dreamH, regions) {
  const isD = template.isDream;
  const tmplW = template.width, tmplH = template.height;

  // Anchor x/y for this slot
  const anchorX = isD
    ? normalGeo.slotXPositions[slotIndex] + dreamXOff
    : normalGeo.slotXPositions[slotIndex];
  const anchorY  = normalGeo.slotY;
  const cropW    = isD ? dreamW : normalGeo.slotWidth;
  const cropH    = isD ? dreamH : normalGeo.slotHeight;

  // Bounds check
  if(anchorX+cropW>srcRgb.width||anchorY+cropH>srcRgb.height||anchorX<0||anchorY<0) return null;

  let cropX=anchorX, cropY=anchorY;

  // Jitter sweep for dream cards (same as DREAM_JITTER in production)
  if(isD && DREAM_JITTER>0){
    // First resize template to crop size for jitter comparison
    const tmplAtCropSize = {rgb:resizeRgb(template.rgb,tmplW,tmplH,cropW,cropH),width:cropW,height:cropH};
    let bestFast=Infinity;
    for(let dy=-DREAM_JITTER;dy<=DREAM_JITTER;dy++){
      const ty=anchorY+dy; if(ty<0||ty+cropH>srcRgb.height) continue;
      for(let dx=-DREAM_JITTER;dx<=DREAM_JITTER;dx++){
        const tx=anchorX+dx; if(tx<0||tx+cropW>srcRgb.width) continue;
        const mse=fastMseDirect(srcRgb,tx,ty,cropW,cropH,tmplAtCropSize);
        if(mse<bestFast){bestFast=mse;cropX=tx;cropY=ty;}
      }
    }
  }

  // Full weighted-region comparison at best crop origin
  const cropRgb  = extractSubRgb (srcRgb,  cropX, cropY, cropW, cropH, tmplW, tmplH);
  const cropGray = extractSubGray(srcGray, cropX, cropY, cropW, cropH, tmplW, tmplH);

  const tmplGray = template.gray;
  const tmplRgb  = template.rgb;

  const m = compareImages(cropGray, cropRgb, tmplGray, tmplRgb, regions);
  return {rgbMse:m.rgbMse, ssim:m.ssim, ncc:m.ncc, grayMse:m.grayMse, cropX, cropY, cropW, cropH};
}

// Bilinear resize RGB array
function resizeRgb(srcRgb, sw, sh, dstW, dstH) {
  const out=new Float32Array(dstW*dstH*3), scaleX=sw/dstW, scaleY=sh/dstH;
  for(let dy=0;dy<dstH;dy++) for(let dx=0;dx<dstW;dx++){
    const fx=dx*scaleX,fy=dy*scaleY,x0=Math.floor(fx),y0=Math.floor(fy);
    const x1=Math.min(x0+1,sw-1),y1=Math.min(y0+1,sh-1),wx=fx-x0,wy=fy-y0;
    const base=(dy*dstW+dx)*3;
    for(let c=0;c<3;c++) out[base+c]=(1-wx)*(1-wy)*srcRgb[(y0*sw+x0)*3+c]+wx*(1-wy)*srcRgb[(y0*sw+x1)*3+c]+(1-wx)*wy*srcRgb[(y1*sw+x0)*3+c]+wx*wy*srcRgb[(y1*sw+x1)*3+c];
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const config   = JSON.parse(fs.readFileSync(CONFIG_PATH,'utf8'));
  const regions  = config.stableRegions;
  const MSE_THR  = config.metrics.rgbMse.threshold;
  const MSE_MAR  = config.metrics.rgbMse.margin;

  const cal  = JSON.parse(fs.readFileSync(CAL_PATH,'utf8'));
  const s    = cal.slots;
  const normalGeo = {
    slotXPositions: s.slotXPositions,
    slotY:   s.slotY,
    slotWidth:  s.slotWidth,
    slotHeight: s.slotHeight,
    baseScreenWidth:  s.baseScreenWidth,
    baseScreenHeight: s.baseScreenHeight,
  };

  console.log('=== Dream Card Detection Test (v2) ===\n');
  console.log(`Normal geometry: y=${normalGeo.slotY}  ${normalGeo.slotWidth}×${normalGeo.slotHeight}px`);
  console.log(`x[0..3]:  ${normalGeo.slotXPositions.slice(0,4).join(', ')}`);
  console.log(`Threshold=${MSE_THR}  Margin=${MSE_MAR}\n`);

  console.log('Loading template index (seasonal + personal)…');
  const tmplIndex = buildIndex(SEASONAL_DIR, PERSONAL_DIR);
  console.log(`  ${tmplIndex.size} card names indexed.\n`);

  const TEST_CASES = [
    { name:'Round 2', screenshot: path.join(DEBUG_DIR,'fengxuround2.png'),  handFile: path.join(DEBUG_DIR,'hand_output.txt'),
      personalHintSlots: [1] },  // 阴符玉简 is in slot 1
    { name:'Round 4', screenshot: path.join(DEBUG_DIR,'round4fengxu.png'),  handFile: path.join(DEBUG_DIR,'hand_outputtound4.txt') },
  ];

  for(const tc of TEST_CASES){
    if(!fs.existsSync(tc.screenshot)){console.log(`Skip ${tc.name}: no screenshot`);continue;}
    const hand = parseHand(tc.handFile);
    const dreamCards    = hand.filter(isDream);
    const nonDreamCards = hand.filter(n=>!isDream(n));
    // Personal = non-dream cards that have personal templates
    const personalCards = nonDreamCards.filter(n=>getTemplates(n,tmplIndex,'personal').length>0);
    const normalCards   = nonDreamCards.filter(n=>!personalCards.includes(n));

    console.log(`${'═'.repeat(60)}`);
    console.log(`${tc.name}`);
    console.log(`  Hand (${hand.length}): ${hand.join(', ')}`);
    console.log(`  Dream: ${dreamCards.join(', ')||'(none)'}`);
    console.log(`  Personal: ${personalCards.join(', ')||'(none)'}`);
    console.log(`  Normal: ${normalCards.join(', ')||'(none)'}`);

    // Load templates
    const dreamTmpls    = dreamCards.flatMap(n=>getTemplates(n,tmplIndex,'dream'));
    const personalTmpls = personalCards.flatMap(n=>getTemplates(n,tmplIndex,'personal'));
    const normalTmpls   = normalCards.flatMap(n=>getTemplates(n,tmplIndex,'normal'));
    console.log(`  Dream templates: ${dreamTmpls.length}   Personal templates: ${personalTmpls.length}   Normal templates: ${normalTmpls.length}`);

    if(dreamTmpls.length===0 && personalTmpls.length===0){console.log('  No dream or personal templates — skipping.');continue;}

    // Decode screenshot
    let ss;
    try { ss = decodePng(tc.screenshot); } catch(e){console.log(`  Error: ${e.message}`);continue;}
    const srcRgb  = toRgb(ss);
    const srcGray = toGray(ss);
    const ssW=ss.width, ssH=ss.height;
    console.log(`  Screenshot: ${ssW}×${ssH}\n`);

    // Scale factor (1.0 for 1920×1080 screenshots matching calibration base)
    const scaleX = ssW / normalGeo.baseScreenWidth;
    const scaleY = ssH / normalGeo.baseScreenHeight;
    const nW = Math.round(normalGeo.slotWidth  * scaleX);
    const nH = Math.round(normalGeo.slotHeight * scaleY);

    // ── A. Full slot scan at normal geometry (no dream offset) ───────────────
    // Finds which slot each normal card is in (baseline: no dream geometry)
    console.log('  [A] Normal geometry — best match per slot:');
    console.log(`       ${'Slot'.padEnd(6)} ${'Best card'.padEnd(20)} ${'MSE'.padEnd(9)} ${'Accept?'}`);

    for(let slot=0;slot<8;slot++){
      const anchorX = Math.round(normalGeo.slotXPositions[slot]*scaleX);
      const anchorY = Math.round(normalGeo.slotY*scaleY);
      if(anchorX+nW>ssW||anchorY+nH>ssH) continue;

      let bestMse=Infinity, bestCard='?', bestTag='';

      for(const tmpl of [...normalTmpls,...dreamTmpls,...personalTmpls]){
        // Use normal geometry for all cards in this pass
        const cropRgb  = extractSubRgb (srcRgb,  anchorX, anchorY, nW, nH, tmpl.width, tmpl.height);
        const cropGray = extractSubGray(srcGray, anchorX, anchorY, nW, nH, tmpl.width, tmpl.height);
        const m = compareImages(cropGray, cropRgb, tmpl.gray, tmpl.rgb, regions);
        if(m.rgbMse < bestMse){
          bestMse=m.rgbMse;
          bestCard=tmpl.fileName.replace(/\.png$/,'');
          bestTag=tmpl.isDream?' (dream)':tmpl.isPersonal?' (personal)':'';
        }
      }
      const mark = bestMse<=MSE_THR ? '✓' : '✗';
      console.log(`       Slot ${slot+1}  ${(bestCard+bestTag).padEnd(24)} ${bestMse.toFixed(1).padEnd(9)} ${mark}`);
    }

    // ── B. Dream-geometry scan — try different geometries ────────────────────
    // Grid over xOffset and dream size to find what makes dream cards match
    console.log('\n  [B] Dream card scan across all slots and geometries:');
    console.log('      (for each dream candidate: which slot/geometry gives lowest MSE?)');

    // Group dream templates by card name
    const dreamByCard = new Map();
    for(const t of dreamTmpls){
      const key = normalizeName(t.fileName.replace(/\d*\.png$/,''));
      if(!dreamByCard.has(key)) dreamByCard.set(key,[]);
      dreamByCard.get(key).push(t);
    }

    // Grid parameters
    const X_OFFSETS    = [0,4,8,12,16,20];
    const WIDTH_DELTAS = [0,-4,-8,-12,-16,-20];  // relative to normal slot width
    const HEIGHT_DELTAS= [0,-4,-8];

    for(const [cardName, tmpls] of dreamByCard.entries()){
      console.log(`\n    Card: "${cardName}" (${tmpls.length} templates)`);
      let overallBest = { mse:Infinity, slot:-1, xOff:0, wDelta:0, hDelta:0, cropX:0, cropY:0, cropW:0, cropH:0 };

      for(const xOff of X_OFFSETS){
        for(const wDelta of WIDTH_DELTAS){
          for(const hDelta of HEIGHT_DELTAS){
            const dreamW = nW + wDelta;
            const dreamH = nH + hDelta;
            if(dreamW<50||dreamH<50) continue;

            for(let slot=0;slot<8;slot++){
              const cropX = Math.round(normalGeo.slotXPositions[slot]*scaleX) + xOff;
              const cropY = Math.round(normalGeo.slotY*scaleY);
              if(cropX+dreamW>ssW||cropY+dreamH>ssH||cropX<0) continue;

              // Direct comparison (no jitter — geometry confirmed in previous run)
              for(const tmpl of tmpls){
                const cropRgb  = extractSubRgb (srcRgb,  cropX, cropY, dreamW, dreamH, tmpl.width, tmpl.height);
                const cropGray = extractSubGray(srcGray, cropX, cropY, dreamW, dreamH, tmpl.width, tmpl.height);
                const m = compareImages(cropGray, cropRgb, tmpl.gray, tmpl.rgb, regions);
                if(m.rgbMse<overallBest.mse){
                  overallBest={mse:m.rgbMse,slot:slot+1,xOff,wDelta,hDelta,cropX,cropY,cropW:dreamW,cropH:dreamH,template:tmpl.fileName};
                }
              }
            }
          }
        }
      }

      const b = overallBest;
      const accept = b.mse <= MSE_THR;
      console.log(`    Best: Slot ${b.slot}  xOff=${b.xOff}  wDelta=${b.wDelta}  hDelta=${b.hDelta}  size=${b.cropW}×${b.cropH}`);
      console.log(`           crop=(${b.cropX},${b.cropY})  MSE=${b.mse.toFixed(1)}  template=${b.template}`);
      console.log(`           ${accept ? '✓ ACCEPTED' : `✗ REJECTED (${(b.mse-MSE_THR).toFixed(0)} above threshold)`}`);
    }

    // ── C. Personal card geometry scan ──────────────────────────────────────
    if(personalTmpls.length > 0){
      console.log('\n  [C] Personal (talent-card) scan across all slots and geometries:');
      console.log('      (for each personal card: which slot/geometry gives lowest MSE?)');

      const personalByCard = new Map();
      for(const t of personalTmpls){
        const key = normalizeName(t.fileName.replace(/\d*\.png$/,''));
        if(!personalByCard.has(key)) personalByCard.set(key,[]);
        personalByCard.get(key).push(t);
      }

      // Grid: step 4px, wider range to find the correct personal card geometry
      const X_OFFSETS_P    = [-16,-12,-8,-4,0,4,8,12,16,20,24,28,32,36,40];
      const WIDTH_DELTAS_P = [-60,-52,-44,-36,-28,-20,-12,-4,0,4,12,20,28];
      const HEIGHT_DELTAS_P= [-60,-52,-44,-36,-28,-20,-12,-4,0,4,12,20,28];

      for(const [cardName, tmpls] of personalByCard.entries()){
        console.log(`\n    Card: "${cardName}" (${tmpls.length} templates)`);
        let overallBest = { mse:Infinity, slot:-1, xOff:0, wDelta:0, hDelta:0, cropX:0, cropY:0, cropW:0, cropH:0, template:'?' };

        // Phase 1: grid search with first template only (fast).
        // hintSlots: if you know which slot(s) the card is in, list them (1-based) to skip others.
        const hintSlots = tc.personalHintSlots || null;
        const probe = tmpls[0];
        for(const xOff of X_OFFSETS_P){
          for(const wDelta of WIDTH_DELTAS_P){
            for(const hDelta of HEIGHT_DELTAS_P){
              const pW = nW + wDelta;
              const pH = nH + hDelta;
              if(pW<50||pH<50) continue;

              for(let slot=0;slot<8;slot++){
                if(hintSlots && !hintSlots.includes(slot+1)) continue;
                const baseX = Math.round(normalGeo.slotXPositions[slot]*scaleX) + xOff;
                const baseY = Math.round(normalGeo.slotY*scaleY);
                if(baseX+pW>ssW||baseY+pH>ssH||baseX<0) continue;

                const cropRgb  = extractSubRgb (srcRgb,  baseX, baseY, pW, pH, probe.width, probe.height);
                const cropGray = extractSubGray(srcGray, baseX, baseY, pW, pH, probe.width, probe.height);
                const m = compareImages(cropGray, cropRgb, probe.gray, probe.rgb, regions);
                if(m.rgbMse<overallBest.mse){
                  overallBest={mse:m.rgbMse,slot:slot+1,xOff,wDelta,hDelta,cropX:baseX,cropY:baseY,cropW:pW,cropH:pH,template:probe.fileName};
                }
              }
            }
          }
        }

        // Phase 2: verify best geometry against all templates
        if(overallBest.slot>0){
          const b0=overallBest;
          for(const tmpl of tmpls){
            if(tmpl===probe) continue;
            const cropRgb  = extractSubRgb (srcRgb,  b0.cropX, b0.cropY, b0.cropW, b0.cropH, tmpl.width, tmpl.height);
            const cropGray = extractSubGray(srcGray, b0.cropX, b0.cropY, b0.cropW, b0.cropH, tmpl.width, tmpl.height);
            const m = compareImages(cropGray, cropRgb, tmpl.gray, tmpl.rgb, regions);
            if(m.rgbMse<overallBest.mse){
              overallBest={...b0,mse:m.rgbMse,template:tmpl.fileName};
            }
          }
        }

        const b = overallBest;
        const accept = b.mse <= MSE_THR;
        const wRatio = (nW+b.wDelta)/nW, hRatio = (nH+b.hDelta)/nH;
        console.log(`    Best: Slot ${b.slot}  xOff=${b.xOff}  wDelta=${b.wDelta}  hDelta=${b.hDelta}  size=${b.cropW}×${b.cropH}`);
        console.log(`           ratio: width=${wRatio.toFixed(3)}  height=${hRatio.toFixed(3)}`);
        console.log(`           crop=(${b.cropX},${b.cropY})  MSE=${b.mse.toFixed(1)}  template=${b.template}`);
        console.log(`           ${accept ? '✓ ACCEPTED' : `✗ REJECTED (${(b.mse-MSE_THR).toFixed(0)} above threshold)`}`);
      }
    }
    console.log('');
  }

  console.log('\n=== DONE ===');
}

main();
