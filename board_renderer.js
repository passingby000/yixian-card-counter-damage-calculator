const boardSlotsRoot = document.getElementById('board-slots');
const damageSummaryRoot = document.getElementById('damage-summary');
const boardTalentsRoot = document.getElementById('board-talents');

let cardTranslations = {};
let cardLanguage = 'zh';
let boardState = {
  slots: Array(8).fill(null),
  damagePreview: {
    first8Turns: null,
    perTurnDamage: [],
    cumulativeDamage: [],
    turnsSimulated: 0,
    playerCharacter: null,
    error: null
  },
  capture: { status: 'idle' }
};

function normalizeTranslationKey(name = '') {
  return String(name).replace(/[•·]/g, '·').trim();
}

function translateCardName(name) {
  if (cardLanguage !== 'en') return name;
  return cardTranslations[normalizeTranslationKey(name)] || name;
}

function getTalentDisplayName(talent) {
  if (!talent?.detected) return 'Undetected';
  if (cardLanguage === 'en') {
    return talent.name || talent.nameCn || 'Unknown';
  }
  return talent.nameCn || talent.name || 'Unknown';
}

function getTalentKindLabel(simulationKind) {
  switch (simulationKind) {
    case 'runtime-stack':
      return 'Direct';
    case 'card-grant':
      return 'Cards';
    case 'transform':
      return 'Transform';
    case 'non-combat-or-unsupported':
      return 'Indirect';
    default:
      return '--';
  }
}

function getDisplaySlot(slot, slotResult) {
  if (slot) {
    return {
      ...slot,
      accepted: true
    };
  }
  return null;
}

function renderBoardPanel() {
  if (!damageSummaryRoot || !boardSlotsRoot || !boardTalentsRoot) return;

  const preview = boardState.damagePreview || {};
  const currentRound = boardState.capture?.currentRound;
  const openSlots = boardState.capture?.boardOpenSlots ?? boardState.capture?.openSlots ?? boardState.slots.length;
  const battlePlayer = boardState.capture?.battle?.player;
  const talents = Array.isArray(boardState.capture?.talents) ? boardState.capture.talents : [];
  const talentIntegration = preview.talentIntegration || null;
  const parts = [];
  if (battlePlayer?.character || preview.playerCharacter) {
    parts.push(battlePlayer?.character || preview.playerCharacter);
  }
  if (currentRound) {
    parts.push(`R${currentRound}`);
  }
  if (openSlots) {
    parts.push(`${openSlots} open`);
  }
  if (talentIntegration) {
    const unsupported = Array.isArray(talentIntegration.unsupportedDirectTalents) ? talentIntegration.unsupportedDirectTalents : [];
    const applied = Array.isArray(talentIntegration.appliedRuntimeTalents) ? talentIntegration.appliedRuntimeTalents : [];
    if (unsupported.length > 0) {
      parts.push(`Talents partially applied · ignored: ${unsupported.join(', ')}`);
    } else if (applied.length > 0) {
      parts.push('Talents applied');
    }
  }
  if (boardState.capture?.status !== 'ok') {
    parts.push(boardState.capture?.message || boardState.capture?.status || 'idle');
  }
  if (preview.error) {
    parts.push(preview.error);
  }
  damageSummaryRoot.textContent = parts.length > 0 ? parts.join(' · ') : 'Waiting for board detection';

  boardTalentsRoot.innerHTML = '';
  for (let index = 0; index < 5; index += 1) {
    const talent = talents[index] || {
      position: index + 1,
      detected: false,
      simulationKind: null
    };
    const el = document.createElement('div');
    el.className = `talent-chip${talent.detected ? '' : ' undetected'}${talent.simulationKind ? ` ${talent.simulationKind}` : ''}`;

    const positionEl = document.createElement('div');
    positionEl.className = 'talent-chip-position';
    positionEl.textContent = `${talent.position || index + 1}`;

    const nameEl = document.createElement('div');
    nameEl.className = 'talent-chip-name';
    nameEl.textContent = getTalentDisplayName(talent);

    const metaEl = document.createElement('div');
    metaEl.className = 'talent-chip-meta';
    metaEl.textContent = talent.detected
      ? `${getTalentKindLabel(talent.simulationKind)} · ${(Number(talent.confidence || 0) * 100).toFixed(0)}%`
      : '--';

    el.appendChild(positionEl);
    el.appendChild(nameEl);
    el.appendChild(metaEl);
    boardTalentsRoot.appendChild(el);
  }

  boardSlotsRoot.innerHTML = '';
  boardState.slots.forEach((slot, index) => {
    const slotResult = boardState.capture?.slotResults?.[index] || null;
    const displaySlot = getDisplaySlot(slot, slotResult);
    const isClosed = index >= openSlots;
    const el = document.createElement('div');
    el.className = `board-slot${displaySlot ? '' : isClosed ? ' closed' : ' empty'}${displaySlot && displaySlot.accepted === false ? ' debug-rejected' : ''}`;

    const slotIndex = document.createElement('div');
    slotIndex.className = 'board-slot-index';
    slotIndex.textContent = `${index + 1}`;

    const slotName = document.createElement('div');
    slotName.className = 'board-slot-name';
    slotName.textContent = displaySlot ? translateCardName(displaySlot.name) : (isClosed ? 'Closed' : 'Undetected');

    const slotMeta = document.createElement('div');
    slotMeta.className = 'board-slot-meta';
    slotMeta.textContent = displaySlot
      ? `${displaySlot.accepted === false ? 'Rejected · ' : ''}${displaySlot.isDream ? `P${displaySlot.phase ?? '?'}` : `Lv ${displaySlot.level}`} · ${(displaySlot.confidence * 100).toFixed(0)}%`
      : (isClosed ? 'Opens later' : '--');

    el.appendChild(slotIndex);
    el.appendChild(slotName);
    el.appendChild(slotMeta);
    boardSlotsRoot.appendChild(el);
  });
}

window.api.onBoardDetectionUpdated((payload) => {
  boardState = payload || boardState;
  renderBoardPanel();
});

window.api.onUiStateUpdated((uiState) => {
  cardLanguage = uiState?.cardLanguage === 'en' ? 'en' : 'zh';
  renderBoardPanel();
});

Promise.all([
  window.api.readCardNameTranslations(),
  window.api.getUiState()
]).then(([translations, uiState]) => {
  cardTranslations = translations || {};
  cardLanguage = uiState?.cardLanguage === 'en' ? 'en' : 'zh';
  renderBoardPanel();
});

renderBoardPanel();
