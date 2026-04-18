const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  readSettings: () => ipcRenderer.invoke('read-settings'),
  readCardLibrary: () => ipcRenderer.invoke('read-card-library'),
  readCardNameTranslations: () => ipcRenderer.invoke('read-card-name-translations'),
  writeSettings: (s) => ipcRenderer.invoke('write-settings', s),
  getUiState: () => ipcRenderer.invoke('get-ui-state'),
  setDeleteMode: (v) => ipcRenderer.invoke('set-delete-mode', v),
  toggleCardListVisibility: () => ipcRenderer.invoke('toggle-card-list-visibility'),
  toggleBoardVisibility: () => ipcRenderer.invoke('toggle-board-visibility'),
  setCardLanguage: (language) => ipcRenderer.invoke('set-card-language', language),
  setDamageRollMode: (mode) => ipcRenderer.invoke('set-damage-roll-mode', mode),
  setDebugMode: (enabled) => ipcRenderer.invoke('set-debug-mode', enabled),
  setControlsExpanded: (expanded) => ipcRenderer.invoke('set-controls-expanded', expanded),
  performCalibration: () => ipcRenderer.invoke('perform-calibration'),
  readDerivedFile: (fileName) => ipcRenderer.invoke('read-derived-file', fileName),
  onCalibrationProgress: (cb) => {
    const wrapped = (_, payload) => cb(payload);
    ipcRenderer.on('calibration-progress', wrapped);
    return () => ipcRenderer.removeListener('calibration-progress', wrapped);
  },
  onUiStateUpdated: (cb) => {
    const wrapped = (_, state) => cb(state);
    ipcRenderer.on('ui-state-updated', wrapped);
    return () => ipcRenderer.removeListener('ui-state-updated', wrapped);
  },
  onCardOperationLogUpdated: (cb) => {
    const wrapped = () => cb();
    ipcRenderer.on('card-operation-log-updated', wrapped);
    return () => ipcRenderer.removeListener('card-operation-log-updated', wrapped);
  },
  onBoardDetectionUpdated: (cb) => {
    const wrapped = (_, payload) => cb(payload);
    ipcRenderer.on('board-detection-updated', wrapped);
    return () => ipcRenderer.removeListener('board-detection-updated', wrapped);
  }
});
