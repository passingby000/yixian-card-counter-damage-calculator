const deleteButton = document.getElementById('delete-button');
const listButton = document.getElementById('list-button');
const boardButton = document.getElementById('board-button');
const settingsButton = document.getElementById('settings-button');
const settingsPanel = document.getElementById('settings-panel');
const rollModeButtons = Array.from(document.querySelectorAll('.roll-option'));
const languageButtons = Array.from(document.querySelectorAll('.language-option'));
const cardListModeButtons = Array.from(document.querySelectorAll('[data-card-list-mode]'));
const debugModeButton = document.getElementById('debug-mode-button');
const calibrateButton = document.getElementById('calibrate-button');
const quitButton = document.getElementById('quit-button');
const calibrationStatusEl = document.getElementById('calibration-status');
const calibrationProgressEl = document.getElementById('calibration-progress');
const calibrationFillEl = document.getElementById('calibration-progress-fill');

let uiState = {
  deleteMode: false,
  debugMode: false,
  showCardList: true,
  showBoardPanel: true,
  cardLanguage: 'zh',
  damageRollMode: 'average',
  cardListMode: 'all',
  calibrated: false,
  calibratedAt: null
};
let settingsOpen = false;
let calibrating = false;

// ── i18n ─────────────────────────────────────────────────────────────────
const I18N = {
  en: {
    'btn.delete': 'Del',
    'btn.list': 'List',
    'btn.board': 'Board',
    'btn.set': 'Set',
    'btn.debug': 'Debug',
    'btn.calibrate': 'Calibrate',
    'btn.calibrating': 'Calibrating...',
    'btn.quit': 'Quit',
    'label.damage': 'Damage',
    'label.cards': 'Cards',
    'label.cardListMode': 'Card list',
    'label.debug': 'Debug',
    'label.calibration': 'Calibration',
    'label.app': 'App',
    'roll.average': 'Average',
    'roll.high': 'High Roll',
    'roll.low': 'Low Roll',
    'lang.zh': 'Chinese',
    'lang.en': 'English',
    'cardListMode.all': 'All in hand',
    'cardListMode.lowStock': 'Remaining < 2',
    'status.calibrated': 'Calibrated {date}',
    'status.notCalibrated': 'Not calibrated',
    'status.calibrationFailed': 'Calibration failed',
    'title.deleteOn': 'Delete mode enabled',
    'title.deleteOff': 'Enable delete mode',
    'title.listShow': 'Show card list',
    'title.listHide': 'Hide card list',
    'title.boardShow': 'Show detected cards table',
    'title.boardHide': 'Hide detected cards table',
    'title.debugShow': 'Show detection overlay',
    'title.debugHide': 'Hide detection overlay',
    'title.set': 'Damage: {mode} · Cards: {lang} · Board: {state}'
  },
  zh: {
    'btn.delete': '删除',
    'btn.list': '卡牌',
    'btn.board': '面板',
    'btn.set': '设置',
    'btn.debug': '调试',
    'btn.calibrate': '校准',
    'btn.calibrating': '校准中…',
    'btn.quit': '退出',
    'label.damage': '伤害',
    'label.cards': '卡牌语言',
    'label.cardListMode': '卡牌列表',
    'label.debug': '调试',
    'label.calibration': '校准',
    'label.app': '应用',
    'roll.average': '平均',
    'roll.high': '高骰',
    'roll.low': '低骰',
    'lang.zh': '中文',
    'lang.en': 'English',
    'cardListMode.all': '手牌全部',
    'cardListMode.lowStock': '剩余<2',
    'status.calibrated': '已校准 {date}',
    'status.notCalibrated': '未校准',
    'status.calibrationFailed': '校准失败',
    'title.deleteOn': '删除模式已开启',
    'title.deleteOff': '开启删除模式',
    'title.listShow': '显示卡牌列表',
    'title.listHide': '隐藏卡牌列表',
    'title.boardShow': '显示识别卡牌',
    'title.boardHide': '隐藏识别卡牌',
    'title.debugShow': '显示调试覆盖',
    'title.debugHide': '隐藏调试覆盖',
    'title.set': '伤害: {mode} · 卡牌: {lang} · 面板: {state}'
  }
};

function t(key, vars = {}) {
  const lang = uiState.cardLanguage === 'zh' ? 'zh' : 'en';
  const tmpl = (I18N[lang] && I18N[lang][key]) || (I18N.en[key]) || key;
  return tmpl.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

function applyStaticTranslations() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = el.dataset.i18n;
    if (!key) continue;
    el.textContent = t(key);
  }
}

function renderControls() {
  applyStaticTranslations();

  deleteButton.classList.toggle('active', !!uiState.deleteMode);
  listButton.classList.toggle('active', !!uiState.showCardList);
  boardButton.classList.toggle('active', !!uiState.showBoardPanel);
  settingsButton.classList.toggle('active', settingsOpen);
  settingsPanel.classList.toggle('hidden', !settingsOpen);

  const damageRollMode = uiState.damageRollMode || 'average';
  rollModeButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.rollMode === damageRollMode);
  });
  languageButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.cardLanguage === uiState.cardLanguage);
  });
  const cardListMode = uiState.cardListMode || 'all';
  cardListModeButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.cardListMode === cardListMode);
  });
  if (debugModeButton) {
    debugModeButton.classList.toggle('active', !!uiState.debugMode);
  }
  if (calibrateButton) {
    calibrateButton.disabled = calibrating;
    calibrateButton.textContent = calibrating ? t('btn.calibrating') : t('btn.calibrate');
  }
  if (calibrationProgressEl) {
    calibrationProgressEl.classList.toggle('running', calibrating);
  }
  if (calibrationStatusEl && !calibrating) {
    if (uiState.calibrated && uiState.calibratedAt) {
      const date = new Date(uiState.calibratedAt).toLocaleDateString();
      calibrationStatusEl.textContent = t('status.calibrated', { date });
      calibrationStatusEl.className = 'calibration-status ok';
    } else {
      calibrationStatusEl.textContent = t('status.notCalibrated');
      calibrationStatusEl.className = 'calibration-status';
    }
  }

  deleteButton.title = uiState.deleteMode ? t('title.deleteOn') : t('title.deleteOff');
  listButton.title   = uiState.showCardList ? t('title.listHide') : t('title.listShow');
  boardButton.title  = uiState.showBoardPanel ? t('title.boardHide') : t('title.boardShow');
  if (debugModeButton) {
    debugModeButton.title = uiState.debugMode ? t('title.debugHide') : t('title.debugShow');
  }
  settingsButton.title = t('title.set', {
    mode: damageRollMode,
    lang: uiState.cardLanguage,
    state: uiState.debugMode ? 'debug' : 'normal'
  });
}

async function setSettingsOpen(nextOpen) {
  settingsOpen = !!nextOpen;
  await window.api.setControlsExpanded(settingsOpen);
  renderControls();
}

deleteButton.addEventListener('click', async () => {
  uiState = await window.api.setDeleteMode(!uiState.deleteMode);
  renderControls();
});

listButton.addEventListener('click', async () => {
  uiState = await window.api.toggleCardListVisibility();
  renderControls();
});

boardButton.addEventListener('click', async () => {
  uiState = await window.api.toggleBoardVisibility();
  renderControls();
});

settingsButton.addEventListener('click', async () => {
  await setSettingsOpen(!settingsOpen);
});

rollModeButtons.forEach((button) => {
  button.addEventListener('click', async () => {
    uiState = await window.api.setDamageRollMode(button.dataset.rollMode);
    await setSettingsOpen(false);
    renderControls();
  });
});

languageButtons.forEach((button) => {
  button.addEventListener('click', async () => {
    uiState = await window.api.setCardLanguage(button.dataset.cardLanguage);
    await setSettingsOpen(false);
    renderControls();
  });
});

cardListModeButtons.forEach((button) => {
  button.addEventListener('click', async () => {
    uiState = await window.api.setCardListMode(button.dataset.cardListMode);
    await setSettingsOpen(false);
    renderControls();
  });
});

if (debugModeButton) {
  debugModeButton.addEventListener('click', async () => {
    uiState = await window.api.setDebugMode(!uiState.debugMode);
    await setSettingsOpen(false);
    renderControls();
  });
}

if (quitButton) {
  quitButton.addEventListener('click', () => {
    window.api.quitApp();
  });
}

if (calibrateButton) {
  calibrateButton.addEventListener('click', async () => {
    if (calibrating) return;
    calibrating = true;
    if (calibrationFillEl) calibrationFillEl.style.width = '0%';
    if (calibrationStatusEl) {
      calibrationStatusEl.textContent = '';
      calibrationStatusEl.className = 'calibration-status';
    }
    renderControls();
    try {
      await window.api.performCalibration();
    } catch (error) {
      if (calibrationStatusEl) {
        calibrationStatusEl.textContent = error?.message || 'Calibration failed';
        calibrationStatusEl.className = 'calibration-status error';
      }
    } finally {
      calibrating = false;
      renderControls();
    }
  });
}

window.api.onUiStateUpdated((nextUiState) => {
  uiState = nextUiState || uiState;
  renderControls();
});

window.api.onCalibrationProgress(({ step, total }) => {
  if (calibrationFillEl) {
    calibrationFillEl.style.width = `${Math.round((step / total) * 100)}%`;
  }
});

window.api.getUiState().then((nextUiState) => {
  uiState = nextUiState || uiState;
  renderControls();
});
