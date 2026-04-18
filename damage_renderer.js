const damageOverlayRoot = document.getElementById('damage-overlay');
const debugCanvas = document.getElementById('debug-overlay-canvas');

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

  ctx.lineWidth = 2;
  ctx.font = 'bold 11px Arial';
  ctx.textAlign = 'center';

  for (let i = 0; i < 8; i += 1) {
    const rect = slotResults[i]?.rect || fallbackSlotRects[i];
    if (!rect) continue;
    const x = rect.x * scaleX;
    const y = rect.y * scaleY;
    const w = rect.width * scaleX;
    const h = rect.height * scaleY;
    ctx.strokeStyle = 'rgba(0, 220, 100, 0.9)';
    ctx.fillStyle = 'rgba(0, 220, 100, 0.12)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = 'rgba(0, 220, 100, 0.9)';
    ctx.fillText(`Slot ${i + 1}`, x + w / 2, y + 14);
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
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    const talentInfo = boardState.capture?.talents?.[i];
    const score = talentInfo?.confidence ?? talentInfo?.score ?? null;
    const label = score != null ? `T${i + 1} ${score.toFixed(2)}` : `T${i + 1}`;
    ctx.fillStyle = 'rgba(255, 160, 0, 0.9)';
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
