const damageOverlayRoot = document.getElementById('damage-overlay');
const debugCanvas = document.getElementById('debug-overlay-canvas');

// Cache for template images loaded from disk via file:// URLs.
// Map from filePath -> HTMLImageElement (loaded) or null (failed).
const templateImageCache = new Map();
const templateImagePending = new Set();

function filePathToUrl(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}

function getTemplateImage(filePath) {
  if (templateImageCache.has(filePath)) return templateImageCache.get(filePath);
  if (templateImagePending.has(filePath)) return null;
  templateImagePending.add(filePath);
  const img = new Image();
  img.onload = () => {
    templateImageCache.set(filePath, img);
    templateImagePending.delete(filePath);
    renderDebugOverlay();
  };
  img.onerror = () => {
    templateImageCache.set(filePath, null);
    templateImagePending.delete(filePath);
  };
  img.src = filePathToUrl(filePath);
  return null;
}

let boardState = {
  damagePreview: {
    cumulativeDamage: []
  },
  capture: {
    fallbackSlotRects: []
  }
};

function getSlotRect(index) {
  return boardState.capture?.slotResults?.[index]?.rect ||
    boardState.capture?.fallbackSlotRects?.[index] ||
    null;
}

function renderDamageOverlay() {
  if (!damageOverlayRoot) return;

  const cumulativeDamage = boardState.damagePreview?.cumulativeDamage || [];
  damageOverlayRoot.innerHTML = '';

  const dpr = window.devicePixelRatio || 1;
  const scaleX = 1 / dpr;
  const scaleY = 1 / dpr;

  for (let index = 0; index < 8; index += 1) {
    const rect = getSlotRect(index);
    if (!rect) continue;

    const badge = document.createElement('div');
    badge.className = 'damage-badge';
    const turnLabel = document.createElement('span');
    turnLabel.className = 'damage-badge-turn';
    turnLabel.textContent = `T${index + 1}`;

    const damageValue = document.createElement('span');
    damageValue.className = 'damage-badge-value';
    damageValue.textContent = cumulativeDamage[index] == null ? '--' : `${cumulativeDamage[index]}`;

    badge.appendChild(turnLabel);
    badge.appendChild(damageValue);
    badge.style.left = `${(rect.x + rect.width) * scaleX - 46}px`;
    badge.style.top  = `${(rect.y + rect.height) * scaleY - 28}px`;
    damageOverlayRoot.appendChild(badge);
  }
}

function sizeCanvas() {
  if (!debugCanvas) return;
  debugCanvas.width = window.innerWidth;
  debugCanvas.height = window.innerHeight;
}

function truncateText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && ctx.measureText(truncated + '\u2026').width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + '\u2026';
}

function renderDebugOverlay() {
  if (!debugCanvas) return;
  const ctx = debugCanvas.getContext('2d');
  ctx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);

  if (!boardState.capture?.debugMode) return;

  const dpr = window.devicePixelRatio || 1;
  const scaleX = 1 / dpr;
  const scaleY = 1 / dpr;

  const slotResults = boardState.capture?.slotResults || [];
  const fallbackSlotRects = boardState.capture?.fallbackSlotRects || [];

  // For the box outline and template overlay, always use slotResult.rect — this carries
  // the actual matched coordinates including dream-card dimensions and jitter-adjusted
  // x/y position.  Fall back to normalGeometry only when there is no slot result at all
  // (e.g. slot is closed or no hand candidates), and only for non-dream slots.
  const geo = boardState.capture?.detector?.normalGeometry;

  for (let i = 0; i < 8; i += 1) {
    const slotResult = slotResults[i];
    const isDreamCandidate = !!slotResult?.bestCandidate?.isDream;

    let rect;
    if (slotResult?.rect) {
      // Use the detector's rect — already jitter-corrected and sized for dream cards
      rect = slotResult.rect;
    } else if (!isDreamCandidate && geo) {
      // No detection result for a normal slot — use stable calibration position
      rect = {
        x: Math.round(geo.slotXPositions[i]),
        y: Math.round(geo.slotY),
        width: Math.round(geo.slotWidth),
        height: Math.round(geo.slotHeight)
      };
    } else {
      rect = fallbackSlotRects[i];
    }
    if (!rect) continue;

    const x = rect.x * scaleX;
    const y = rect.y * scaleY;
    const w = rect.width * scaleX;
    const h = rect.height * scaleY;

    const candidate = slotResult?.bestCandidate;
    const accepted = !!slotResult?.accepted;
    const color = accepted ? '0, 220, 100' : '255, 160, 0';

    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(${color}, 0.9)`;
    ctx.fillStyle = `rgba(${color}, 0.12)`;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);

    // Draw the matched template image semi-transparently so you can compare
    // the template against the actual game card visible underneath.
    if (candidate?.templatePath) {
      const img = getTemplateImage(candidate.templatePath);
      if (img) {
        ctx.globalAlpha = 0.5;
        ctx.drawImage(img, x, y, w, h);
        ctx.globalAlpha = 1.0;
      }
    }

    // Text background strip at top of box
    const pad = 4;
    const lineH = 14;
    const rows = candidate ? 4 : 2;
    const bgH = pad + lineH * rows;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.68)';
    ctx.fillRect(x, y, w, bgH);

    ctx.fillStyle = `rgba(${color}, 1)`;
    ctx.textAlign = 'left';

    // Row 1: slot number + dream indicator
    ctx.font = 'bold 10px Arial';
    const slotLabel = `Slot ${i + 1}${isDreamCandidate ? ' (dream)' : ''}`;
    ctx.fillText(slotLabel, x + pad, y + pad + 10);

    // Row 2: actual rect dimensions in screenshot pixels — shows exactly what
    // the detector is comparing, so you can see if the dream size is correct
    ctx.font = '10px Arial';
    ctx.fillText(`${rect.x},${rect.y}  ${rect.width}\u00d7${rect.height}px`, x + pad, y + pad + lineH + 10);

    if (candidate) {
      const maxTextW = w - pad * 2;

      // Row 3: card name (truncated to fit the box width)
      ctx.font = '11px Arial';
      const displayName = truncateText(ctx, candidate.name || '?', maxTextW);
      ctx.fillText(displayName, x + pad, y + pad + lineH * 2 + 10);

      // Row 4: accepted/rejected + confidence %
      const conf = Math.round((slotResult?.displayConfidence ?? 0) * 100);
      const statusText = `${accepted ? '\u2713' : '\u2717'} ${conf}%`;
      ctx.font = '10px Arial';
      ctx.fillText(statusText, x + pad, y + pad + lineH * 3 + 10);
    }
  }

  const talentRects = boardState.capture?.talentDetection?.geometry?.rects || [];
  for (let i = 0; i < talentRects.length; i += 1) {
    const rect = talentRects[i];
    if (!rect) continue;
    const x = rect.x * scaleX;
    const y = rect.y * scaleY;
    const w = rect.width * scaleX;
    const h = rect.height * scaleY;
    ctx.strokeStyle = 'rgba(255, 160, 0, 0.9)';
    ctx.fillStyle = 'rgba(255, 160, 0, 0.12)';
    ctx.lineWidth = 2;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    const talentInfo = boardState.capture?.talents?.[i];
    const score = talentInfo?.confidence ?? talentInfo?.score ?? null;
    const label = score != null ? `T${i + 1} ${score.toFixed(2)}` : `T${i + 1}`;
    ctx.fillStyle = 'rgba(255, 160, 0, 0.9)';
    ctx.font = 'bold 11px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(label, x + w / 2, y + 14);
  }
}

window.addEventListener('resize', () => {
  sizeCanvas();
  renderDebugOverlay();
});

window.api.onBoardDetectionUpdated((payload) => {
  boardState = payload || boardState;
  renderDamageOverlay();
  renderDebugOverlay();
});

sizeCanvas();
renderDamageOverlay();
renderDebugOverlay();
