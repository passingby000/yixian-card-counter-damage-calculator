const damageOverlayRoot = document.getElementById('damage-overlay');

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
    badge.style.left = `${rect.x + rect.width - 46}px`;
    badge.style.top = `${rect.y + rect.height - 28}px`;
    damageOverlayRoot.appendChild(badge);
  }
}

window.api.onBoardDetectionUpdated((payload) => {
  boardState = payload || boardState;
  renderDamageOverlay();
});

renderDamageOverlay();
