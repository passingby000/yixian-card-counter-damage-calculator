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

const I18N = {
  en: {
    'slot.closed': 'Closed',
    'slot.undetected': 'Undetected',
    'slot.opensLater': 'Opens later',
    'slot.dash': '--',
    'slot.rejected': 'Rejected',
    'slot.lv': 'Lv',
    'slot.phase': 'P',
    'summary.waiting': 'Waiting for board detection',
    'summary.idle': 'idle',
    'summary.open': 'open',
    'summary.talentsApplied': 'Talents applied',
    'summary.talentsPartiallyApplied': 'Talents partially applied · ignored: {names}',
    'summary.round': 'R{round}',
    'talentKind.direct': 'Direct',
    'talentKind.cards': 'Cards',
    'talentKind.transform': 'Transform',
    'talentKind.indirect': 'Indirect',
    'talentKind.none': '--',
    'talent.unknown': 'Unknown'
  },
  zh: {
    'slot.closed': '未开启',
    'slot.undetected': '未识别',
    'slot.opensLater': '稍后开启',
    'slot.dash': '--',
    'slot.rejected': '已拒绝',
    'slot.lv': '等级',
    'slot.phase': '阶',
    'summary.waiting': '等待面板识别',
    'summary.idle': '空闲',
    'summary.open': '开启',
    'summary.talentsApplied': '已应用天赋',
    'summary.talentsPartiallyApplied': '天赋部分应用 · 忽略: {names}',
    'summary.round': 'R{round}',
    'talentKind.direct': '直接',
    'talentKind.cards': '卡牌',
    'talentKind.transform': '变换',
    'talentKind.indirect': '间接',
    'talentKind.none': '--',
    'talent.unknown': '未知'
  }
};

function t(key, vars = {}) {
  const lang = cardLanguage === 'zh' ? 'zh' : 'en';
  const tmpl = (I18N[lang] && I18N[lang][key]) || (I18N.en[key]) || key;
  return tmpl.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

function translateCardName(name) {
  if (cardLanguage !== 'en') return name;
  return cardTranslations[normalizeTranslationKey(name)] || name;
}

function getTalentDisplayName(talent) {
  if (!talent?.detected) return t('slot.undetected');
  if (cardLanguage === 'en') {
    return talent.name || talent.nameCn || t('talent.unknown');
  }
  return talent.nameCn || talent.name || t('talent.unknown');
}

function getTalentKindLabel(simulationKind) {
  switch (simulationKind) {
    case 'runtime-stack':              return t('talentKind.direct');
    case 'card-grant':                 return t('talentKind.cards');
    case 'transform':                  return t('talentKind.transform');
    case 'non-combat-or-unsupported':  return t('talentKind.indirect');
    default:                           return t('talentKind.none');
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
    parts.push(t('summary.round', { round: currentRound }));
  }
  if (openSlots) {
    parts.push(`${openSlots} ${t('summary.open')}`);
  }
  if (talentIntegration) {
    const unsupported = Array.isArray(talentIntegration.unsupportedDirectTalents) ? talentIntegration.unsupportedDirectTalents : [];
    const applied = Array.isArray(talentIntegration.appliedRuntimeTalents) ? talentIntegration.appliedRuntimeTalents : [];
    if (unsupported.length > 0) {
      parts.push(t('summary.talentsPartiallyApplied', { names: unsupported.join(', ') }));
    } else if (applied.length > 0) {
      parts.push(t('summary.talentsApplied'));
    }
  }
  if (boardState.capture?.status !== 'ok') {
    parts.push(boardState.capture?.message || boardState.capture?.status || t('summary.idle'));
  }
  if (preview.error) {
    parts.push(preview.error);
  }
  damageSummaryRoot.textContent = parts.length > 0 ? parts.join(' · ') : t('summary.waiting');

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
      : t('slot.dash');

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
    slotName.textContent = displaySlot
      ? translateCardName(displaySlot.name)
      : (isClosed ? t('slot.closed') : t('slot.undetected'));

    const slotMeta = document.createElement('div');
    slotMeta.className = 'board-slot-meta';
    slotMeta.textContent = displaySlot
      ? `${displaySlot.accepted === false ? `${t('slot.rejected')} · ` : ''}${displaySlot.isDream ? `${t('slot.phase')}${displaySlot.phase ?? '?'}` : `${t('slot.lv')} ${displaySlot.level}`} · ${(displaySlot.confidence * 100).toFixed(0)}%`
      : (isClosed ? t('slot.opensLater') : t('slot.dash'));

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
