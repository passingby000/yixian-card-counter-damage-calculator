const deleteButton = document.getElementById('delete-button');
const listButton = document.getElementById('list-button');
const boardButton = document.getElementById('board-button');
const settingsButton = document.getElementById('settings-button');
const settingsPanel = document.getElementById('settings-panel');
const rollModeButtons = Array.from(document.querySelectorAll('.roll-option'));
const languageButtons = Array.from(document.querySelectorAll('.language-option'));
const debugModeButton = document.getElementById('debug-mode-button');
const calibrateButton = document.getElementById('calibrate-button');
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
  calibrated: false,
  calibratedAt: null
};
let settingsOpen = false;
let calibrating = false;

function renderControls() {
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
  if (debugModeButton) {
    debugModeButton.classList.toggle('active', !!uiState.debugMode);
  }
  if (calibrateButton) {
    calibrateButton.disabled = calibrating;
    calibrateButton.textContent = calibrating ? 'Calibrating...' : 'Calibrate';
  }
  if (calibrationProgressEl) {
    calibrationProgressEl.classList.toggle('running', calibrating);
  }
  if (calibrationStatusEl && !calibrating) {
    if (uiState.calibrated && uiState.calibratedAt) {
      const date = new Date(uiState.calibratedAt).toLocaleDateString();
      calibrationStatusEl.textContent = `Calibrated ${date}`;
      calibrationStatusEl.className = 'calibration-status ok';
    } else {
      calibrationStatusEl.textContent = 'Not calibrated';
      calibrationStatusEl.className = 'calibration-status';
    }
  }

  deleteButton.title = uiState.deleteMode ? 'Delete mode enabled' : 'Enable delete mode';
  listButton.title = uiState.showCardList ? 'Hide card list' : 'Show card list';
  boardButton.title = uiState.showBoardPanel ? 'Hide detected cards table' : 'Show detected cards table';
  if (debugModeButton) {
    debugModeButton.title = uiState.debugMode ? 'Hide detection overlay' : 'Show detection overlay';
  }
  settingsButton.title = `Damage: ${damageRollMode} · Cards: ${uiState.cardLanguage} · Board: ${uiState.debugMode ? 'debug' : 'normal'}`;
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

if (debugModeButton) {
  debugModeButton.addEventListener('click', async () => {
    uiState = await window.api.setDebugMode(!uiState.debugMode);
    await setSettingsOpen(false);
    renderControls();
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
