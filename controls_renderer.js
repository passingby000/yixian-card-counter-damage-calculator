const deleteButton = document.getElementById('delete-button');
const listButton = document.getElementById('list-button');
const boardButton = document.getElementById('board-button');
const settingsButton = document.getElementById('settings-button');
const settingsPanel = document.getElementById('settings-panel');
const rollModeButtons = Array.from(document.querySelectorAll('.roll-option'));
const languageButtons = Array.from(document.querySelectorAll('.language-option'));
const debugModeButton = document.getElementById('debug-mode-button');

let uiState = {
  deleteMode: false,
  debugMode: false,
  showCardList: true,
  showBoardPanel: true,
  cardLanguage: 'zh',
  damageRollMode: 'average'
};
let settingsOpen = false;

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

  deleteButton.title = uiState.deleteMode ? 'Delete mode enabled' : 'Enable delete mode';
  listButton.title = uiState.showCardList ? 'Hide card list' : 'Show card list';
  boardButton.title = uiState.showBoardPanel ? 'Hide detected cards table' : 'Show detected cards table';
  if (debugModeButton) {
    debugModeButton.title = uiState.debugMode ? 'Show rejected best candidates and open all 8 board slots' : 'Show only accepted detections';
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

window.api.onUiStateUpdated((nextUiState) => {
  uiState = nextUiState || uiState;
  renderControls();
});

window.api.getUiState().then((nextUiState) => {
  uiState = nextUiState || uiState;
  renderControls();
});
