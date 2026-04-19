const { app, BrowserWindow, ipcMain, screen, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const {
  detectSlots,
  NUM_SLOTS,
  setCalibration: setSlotCalibration,
  getActiveGeometry: getActiveSlotGeometry
} = require('./slot_detector');
const { loadCardNameTranslations: loadYisimCardNameTranslations, simulateFirstEightTurns } = require('./yisim_adapter');
const { loadCardLibrary } = require('./card_metadata');
const { detectTalents, buildFallbackTalentResults, setCalibration: setTalentCalibration } = require('./talent_detector');
const { performCalibration } = require('./calibrator');
const { loadCalibration, saveCalibration } = require('./calibration_store');
const {
  getAssetPath,
  getCodePath,
  getLegacyRepoPath,
  getWritablePath
} = require('./runtime_paths');

const BOARD_CAPTURE_INTERVAL_MS = 1000;
const GAME_SOURCE_PATTERNS = ['弈仙牌', 'yixianpai', 'yi xian pai', 'yi xian: cultivation card game'];
const SIDE_MARGIN = 20;
const BOARD_TOP_MARGIN = 8;
const CONTROLS_TOP_MARGIN = 2;
const CONTROLS_LIST_GAP = 20;
const CARD_LIST_WINDOW_WIDTH = 260;
const BOARD_WINDOW_WIDTH = 280;
const CONTROLS_WINDOW_WIDTH = 198;
const CONTROLS_WINDOW_HEIGHT = 34;
const CONTROLS_WINDOW_EXPANDED_HEIGHT = 300;

let cardListWindow = null;
let boardWindow = null;
let controlsWindow = null;
let damageWindow = null;
let deleteMode = false;
let debugMode = false;
let controlsExpanded = false;
const watchedPaths = new Map();
let converterInterval = null;
let boardCaptureInterval = null;
let latestBoardPayload = null;
let latestBoardPayloadJson = null;
let boardCaptureInFlight = false;
let boardCapturePending = false;

function getStartupLogPath() {
  try {
    const userDataDir = app.getPath('userData');
    fs.mkdirSync(userDataDir, { recursive: true });
    return path.join(userDataDir, 'startup.log');
  } catch (_error) {
    return path.join(__dirname, 'startup.log');
  }
}

function formatStartupLogDetails(details) {
  if (!details) return '';
  if (details instanceof Error) {
    return details.stack || details.message || String(details);
  }
  if (typeof details === 'string') {
    return details;
  }
  try {
    return JSON.stringify(details);
  } catch (_error) {
    return String(details);
  }
}

function appendStartupLog(message, details) {
  const detailText = formatStartupLogDetails(details);
  const line = `[${new Date().toISOString()}] ${message}${detailText ? `\n${detailText}` : ''}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(getStartupLogPath(), line, 'utf8');
  } catch (_error) {}
}

process.on('uncaughtException', (error) => {
  appendStartupLog('uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
  appendStartupLog('unhandledRejection', reason);
});

if (!app || typeof app.whenReady !== 'function') {
  appendStartupLog(
    'Electron main process started without a valid app object',
    process.env.ELECTRON_RUN_AS_NODE
      ? 'ELECTRON_RUN_AS_NODE is set. Start the app with that variable unset.'
      : 'This file must be started by the Electron runtime.'
  );
  process.exit(1);
}

function getSettingsPath() {
  return getWritablePath('overlay_settings.json');
}

function getConvertedHandPath() {
  return getWritablePath('ConvertedHandCard.json');
}

function getConvertedOperationPath() {
  return getWritablePath('ConvertedCardOperationLog.json');
}

function getImagesDir() {
  return getAssetPath('images');
}

function normalizeSettings(rawSettings = {}) {
  return {
    hiddenCards: rawSettings.hiddenCards || {},
    gamePath: rawSettings.gamePath || null,
    showCardList: rawSettings.showCardList !== false,
    showBoardPanel: rawSettings.showBoardPanel !== false,
    cardLanguage: rawSettings.cardLanguage === 'en' ? 'en' : 'zh',
    damageRollMode: ['average', 'high', 'low'].includes(rawSettings.damageRollMode)
      ? rawSettings.damageRollMode
      : 'average'
  };
}

function loadSettings() {
  try {
    const settingsPath = getSettingsPath();
    if (fs.existsSync(settingsPath)) {
      return normalizeSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    }

    const legacySettingsPath = getLegacyRepoPath('overlay_settings.json');
    if (fs.existsSync(legacySettingsPath)) {
      const migratedSettings = normalizeSettings(JSON.parse(fs.readFileSync(legacySettingsPath, 'utf8')));
      saveSettings(migratedSettings);
      return migratedSettings;
    }
  } catch (e) {}
  return normalizeSettings();
}

function saveSettings(s) {
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(normalizeSettings(s), null, 2));
  } catch (e) {
    console.error('Failed to save settings', e);
  }
}

function getWindowBounds() {
  const primary = screen.getPrimaryDisplay();
  const controlsY = primary.bounds.y + CONTROLS_TOP_MARGIN;
  const cardListX = primary.bounds.x + primary.bounds.width - CARD_LIST_WINDOW_WIDTH - SIDE_MARGIN;
  const cardListY = controlsY + CONTROLS_WINDOW_HEIGHT + CONTROLS_LIST_GAP;
  const boardHeight = primary.bounds.height - (BOARD_TOP_MARGIN * 2);

  return {
    board: {
      x: primary.bounds.x + SIDE_MARGIN,
      y: primary.bounds.y + BOARD_TOP_MARGIN,
      width: BOARD_WINDOW_WIDTH,
      height: boardHeight
    },
    cardList: {
      x: cardListX,
      y: cardListY,
      width: CARD_LIST_WINDOW_WIDTH,
      height: Math.max(1, primary.bounds.height - (cardListY - primary.bounds.y))
    },
    controls: {
      x: primary.bounds.x + primary.bounds.width - CONTROLS_WINDOW_WIDTH - SIDE_MARGIN,
      y: controlsY,
      width: CONTROLS_WINDOW_WIDTH,
      height: controlsExpanded ? CONTROLS_WINDOW_EXPANDED_HEIGHT : CONTROLS_WINDOW_HEIGHT
    },
    damage: {
      x: primary.bounds.x,
      y: primary.bounds.y,
      width: primary.size.width,
      height: primary.size.height
    }
  };
}

function createOverlayWindow(bounds, htmlFile, focusable) {
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    acceptFirstMouse: true,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
      focusable,
      webPreferences: {
      preload: getCodePath('preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(true);
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    appendStartupLog(`did-fail-load for ${htmlFile}`, {
      errorCode,
      errorDescription,
      validatedURL
    });
  });
  win.loadFile(getCodePath(htmlFile));
  return win;
}

function showWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (typeof win.showInactive === 'function') {
    win.showInactive();
    return;
  }
  win.show();
}

function setWindowClickThrough(win, clickThrough) {
  if (!win || win.isDestroyed()) return;
  try {
    if (clickThrough) {
      win.setIgnoreMouseEvents(true);
    } else {
      win.setIgnoreMouseEvents(false);
    }
  } catch (error) {
    console.error('Failed to update click-through state', error);
  }
}

function moveWindowToTop(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.moveTop();
  } catch (error) {
    console.error('Failed to move window to top', error);
  }
}

function ensureControlsOnTop() {
  moveWindowToTop(controlsWindow);
}

function updateControlsWindowBounds() {
  if (!controlsWindow || controlsWindow.isDestroyed()) return;
  controlsWindow.setBounds(getWindowBounds().controls);
  ensureControlsOnTop();
}

function getFallbackSlotRects() {
  const geo = getActiveSlotGeometry();
  if (!geo) return [];
  return geo.slotXPositions.map((x) => ({
    x: Math.round(x),
    y: Math.round(geo.slotY),
    width: Math.max(1, Math.round(geo.slotWidth)),
    height: Math.max(1, Math.round(geo.slotHeight))
  }));
}

let calibrationData = null;

function applyCalibration(data) {
  calibrationData = data || null;
  setSlotCalibration(calibrationData);
  setTalentCalibration(calibrationData);
}

function getUiState() {
  const settings = loadSettings();
  return {
    deleteMode,
    debugMode,
    showCardList: settings.showCardList,
    showBoardPanel: settings.showBoardPanel,
    cardLanguage: settings.cardLanguage,
    damageRollMode: settings.damageRollMode,
    calibrated: !!calibrationData,
    calibratedAt: calibrationData?.calibratedAt || null
  };
}

function broadcastUiState() {
  const payload = getUiState();
  [cardListWindow, boardWindow, controlsWindow, damageWindow].forEach((win) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('ui-state-updated', payload);
  });
}

function updateCardListWindowMouseMode() {
  setWindowClickThrough(cardListWindow, !deleteMode);
}

function applyPanelVisibilityFromSettings() {
  const settings = loadSettings();
  if (cardListWindow && !cardListWindow.isDestroyed()) {
    if (settings.showCardList) {
      showWindow(cardListWindow);
    } else {
      cardListWindow.hide();
    }
  }
  if (boardWindow && !boardWindow.isDestroyed()) {
    if (settings.showBoardPanel) {
      showWindow(boardWindow);
    } else {
      boardWindow.hide();
    }
  }
  updateCardListWindowMouseMode();
  ensureControlsOnTop();
}

function createCardListWindow() {
  if (cardListWindow && !cardListWindow.isDestroyed()) return;
  const bounds = getWindowBounds();
  cardListWindow = createOverlayWindow(bounds.cardList, 'renderer.html', false);
  updateCardListWindowMouseMode();
  cardListWindow.webContents.on('did-finish-load', () => {
    broadcastUiState();
  });
  cardListWindow.once('ready-to-show', () => {
    applyPanelVisibilityFromSettings();
  });
  cardListWindow.on('closed', () => { cardListWindow = null; });
}

function createBoardWindow() {
  if (boardWindow && !boardWindow.isDestroyed()) return;
  const bounds = getWindowBounds();
  boardWindow = createOverlayWindow(bounds.board, 'board.html', false);
  setWindowClickThrough(boardWindow, true);
  boardWindow.webContents.on('did-finish-load', () => {
    if (latestBoardPayload) {
      boardWindow.webContents.send('board-detection-updated', latestBoardPayload);
    }
    broadcastUiState();
  });
  boardWindow.once('ready-to-show', () => {
    applyPanelVisibilityFromSettings();
  });
  boardWindow.on('closed', () => { boardWindow = null; });
}

function createDamageWindow() {
  if (damageWindow && !damageWindow.isDestroyed()) return;
  const bounds = getWindowBounds();
  damageWindow = createOverlayWindow(bounds.damage, 'damage.html', false);
  setWindowClickThrough(damageWindow, true);
  damageWindow.webContents.on('did-finish-load', () => {
    if (latestBoardPayload) {
      damageWindow.webContents.send('board-detection-updated', latestBoardPayload);
    }
  });
  damageWindow.once('ready-to-show', () => {
    showWindow(damageWindow);
    ensureControlsOnTop();
  });
  damageWindow.on('closed', () => { damageWindow = null; });
}

function createControlsWindow() {
  if (controlsWindow && !controlsWindow.isDestroyed()) return;
  controlsExpanded = false;
  const bounds = getWindowBounds();
  controlsWindow = createOverlayWindow(bounds.controls, 'controls.html', false);
  setWindowClickThrough(controlsWindow, false);
  controlsWindow.webContents.on('did-finish-load', () => {
    broadcastUiState();
  });
  controlsWindow.once('ready-to-show', () => {
    showWindow(controlsWindow);
    ensureControlsOnTop();
  });
  controlsWindow.on('closed', () => {
    controlsExpanded = false;
    controlsWindow = null;
  });
}

function createOverlayWindows() {
  createCardListWindow();
  createBoardWindow();
  createDamageWindow();
  createControlsWindow();
}

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch (e) {
    return false;
  }
}

function looksLikeGameDataDir(dirPath) {
  if (!dirPath) return false;
  const requiredSignals = [
    path.join(dirPath, 'BattleLog.json'),
    path.join(dirPath, 'CardOperationLog.json')
  ];
  return requiredSignals.some(fileExists);
}

function findFirstExistingPath(candidates, fallback) {
  for (const candidate of candidates) {
    if (looksLikeGameDataDir(candidate)) return candidate;
  }
  return fallback;
}

function findMacGamePath() {
  const home = process.env.HOME || '';
  const fallback = path.join(home, 'Library', 'Application Support', 'com.darksun.yixianpai');
  const candidates = [
    path.join(home, 'Library', 'Application Support', 'com.darksun.yixianpai'),
    path.join(home, 'Library', 'Containers', 'com.darksun.yixianpai', 'Data', 'Library', 'Application Support', 'com.darksun.yixianpai'),
    path.join(home, 'Library', 'Containers', 'com.darksun.yixianpai')
  ];

  return findFirstExistingPath(candidates, fallback);
}

function findWindowsGamePath() {
  const userProfile = process.env.USERPROFILE || '';
  const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local');
  const fallback = path.join(userProfile, 'AppData', 'LocalLow', 'DarkSunStudio', 'YiXianPai');
  const candidates = [
    path.join(userProfile, 'AppData', 'LocalLow', 'DarkSunStudio', 'YiXianPai'),
    path.join(localAppData, 'Low', 'DarkSunStudio', 'YiXianPai'),
    path.join(localAppData, 'DarkSunStudio', 'YiXianPai'),
    path.join(appData, 'DarkSunStudio', 'YiXianPai')
  ];

  return findFirstExistingPath(candidates, fallback);
}

function getGamePathAuto() {
  if (process.platform === 'darwin') {
    return findMacGamePath();
  }
  if (process.platform === 'win32') {
    return findWindowsGamePath();
  }
  return null;
}

function getResolvedGamePath(settings) {
  if (settings && settings.gamePath && looksLikeGameDataDir(settings.gamePath)) {
    return settings.gamePath;
  }
  const auto = getGamePathAuto();
  if (auto && looksLikeGameDataDir(auto)) {
    return auto;
  }
  return null;
}

function resolveGameFile(filename, settings) {
  const localDerivedPaths = {
    'ConvertedHandCard.json': getConvertedHandPath(),
    'ConvertedCardOperationLog.json': getConvertedOperationPath()
  };
  if (localDerivedPaths[filename] && fileExists(localDerivedPaths[filename])) {
    return localDerivedPaths[filename];
  }

  if (path.isAbsolute(filename) && fileExists(filename)) return filename;

  const gamePath = getResolvedGamePath(settings);
  if (gamePath) {
    const candidate = path.join(gamePath, path.basename(filename));
    if (fileExists(candidate)) return candidate;
  }

  return null;
}

function parseOperationLog(logContent) {
  const lines = (logContent || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const jsonLines = lines.slice(1);
  if (jsonLines.length === 0) return null;
  return jsonLines.map((line) => JSON.parse(line));
}

function parseBattleLog(logContent) {
  const lines = (logContent || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const jsonLines = lines.slice(1);
  if (jsonLines.length === 0) return null;
  return jsonLines.map((line) => JSON.parse(line));
}

function getOpenSlotsForRound(currentRound) {
  const safeRound = Math.max(1, Number(currentRound) || 1);
  return Math.min(NUM_SLOTS, safeRound + 2);
}

function loadBattleState(settings) {
  const fallbackOpenSlots = getOpenSlotsForRound(1);
  const battleLogPath = resolveGameFile('BattleLog.json', settings);
  if (!battleLogPath || !fileExists(battleLogPath)) {
    return {
      status: 'missing-battle-log',
      lastLoggedRound: null,
      currentRound: 1,
      openSlots: fallbackOpenSlots,
      player: null,
      simulationPlayer: null
    };
  }

  try {
    const rounds = parseBattleLog(fs.readFileSync(battleLogPath, 'utf8'));
    if (!rounds || rounds.length === 0) {
      return {
        status: 'waiting-battle-log',
        lastLoggedRound: 0,
        currentRound: 1,
        openSlots: fallbackOpenSlots,
        player: null,
        simulationPlayer: null
      };
    }

    const latestRound = rounds.reduce((latest, round) => {
      if (!latest) return round;
      return (round?.round ?? -Infinity) > (latest?.round ?? -Infinity) ? round : latest;
    }, null);

    const selectedPlayer = latestRound?.players?.[0] || null;
    const currentRound = Math.max(1, (latestRound?.round ?? 0) + 1);
    const openSlots = getOpenSlotsForRound(currentRound);

    return {
      status: 'ok',
      lastLoggedRound: latestRound?.round ?? 0,
      currentRound,
      openSlots,
      player: selectedPlayer ? {
        username: selectedPlayer.username || null,
        character: selectedPlayer.character || null,
        level: selectedPlayer.level ?? null,
        life: selectedPlayer.life ?? null,
        exp: selectedPlayer.exp ?? 0,
        tiPo: selectedPlayer.tiPo ?? 0,
        maxTiPo: selectedPlayer.maxTiPo ?? 0,
        maxHp: selectedPlayer.maxHp ?? null
      } : null,
      simulationPlayer: selectedPlayer ? {
        hp: selectedPlayer.maxHp ?? 110,
        maxHp: selectedPlayer.maxHp ?? 110,
        physique: selectedPlayer.tiPo ?? 0,
        maxPhysique: selectedPlayer.maxTiPo ?? 0,
        cultivation: selectedPlayer.exp ?? 0,
        character: selectedPlayer.character || null
      } : null
    };
  } catch (error) {
    return {
      status: 'battle-log-error',
      message: error.message,
      lastLoggedRound: null,
      currentRound: 1,
      openSlots: fallbackOpenSlots,
      player: null,
      simulationPlayer: null
    };
  }
}

function buildFallbackSlotResults(fallbackSlotRects, openSlots, reason = 'fallback') {
  return fallbackSlotRects.map((rect, slotIndex) => ({
    slotIndex,
    rect,
    metric: null,
    accepted: false,
    bestScore: null,
    margin: null,
    bestCandidate: null,
    secondCandidate: null,
    state: slotIndex < openSlots ? 'undetected' : 'closed',
    reason,
    card: null
  }));
}

function applyOpenSlotStateToResults(slotResults, fallbackSlotRects, openSlots) {
  return fallbackSlotRects.map((rect, slotIndex) => {
    const existing = slotResults?.[slotIndex];
    const state = slotIndex < openSlots
      ? (existing?.card ? 'detected' : 'undetected')
      : 'closed';
    return {
      slotIndex,
      rect: existing?.rect || rect,
      metric: existing?.metric ?? null,
      accepted: !!existing?.accepted,
      bestScore: existing?.bestScore ?? null,
      margin: existing?.margin ?? null,
      bestCandidate: existing?.bestCandidate ?? null,
      secondCandidate: existing?.secondCandidate ?? null,
      card: state === 'detected' ? existing.card : null,
      state
    };
  });
}

function getDeckRemovalCount(card) {
  const rarity = card?.rarity ?? 0;
  if (rarity === 3) return 4;
  if (rarity === 2) return 2;
  return 1;
}

function getHandRemovalCount(card) {
  const rarity = card?.rarity ?? 0;
  if (rarity === 4) return 4;
  if (rarity === 1) return 2;
  return 1;
}

function calculateDeckCards(operations) {
  const cardCounts = {};

  operations.forEach((op) => {
    if (op.operation === 0 && Array.isArray(op.cards)) {
      op.cards.forEach((card) => {
        if (!card?.name) return;
        if (!cardCounts[card.name]) {
          cardCounts[card.name] = { count: 0 };
        }
        cardCounts[card.name].count += getDeckRemovalCount(card);
      });
    }

    if (op.operation === 1 && op.dstCard?.name && !String(op.dstCard.name).startsWith('梦')) {
      if (op.srcCard?.name) {
        if (!cardCounts[op.srcCard.name]) {
          cardCounts[op.srcCard.name] = { count: 0 };
        }
        cardCounts[op.srcCard.name].count += 2 * getDeckRemovalCount(op.srcCard);
      }

      if (!cardCounts[op.dstCard.name]) {
        cardCounts[op.dstCard.name] = { count: 0 };
      }
      cardCounts[op.dstCard.name].count += getDeckRemovalCount(op.dstCard);
    }
  });

  return cardCounts;
}

function calculateHandCards(operations) {
  const handCards = {};

  operations.forEach((op) => {
    if (op.operation === 0 && Array.isArray(op.cards)) {
      op.cards.forEach((card) => {
        if (!card?.name) return;
        handCards[card.name] = (handCards[card.name] || 0) + 1;
      });
    }

    if (op.operation === 1) {
      if (op.srcCard?.name) {
        handCards[op.srcCard.name] = (handCards[op.srcCard.name] || 0) - getHandRemovalCount(op.srcCard);
      }
      if (op.dstCard?.name) {
        handCards[op.dstCard.name] = (handCards[op.dstCard.name] || 0) + 1;
      }
    }

    if (op.operation === 2) {
      if (op.srcCard?.name) {
        handCards[op.srcCard.name] = (handCards[op.srcCard.name] || 0) - getHandRemovalCount(op.srcCard);
      }
    }
  });

  return Object.fromEntries(
    Object.entries(handCards)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => [name, { count }])
  );
}

function writeDerivedData(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadCardNameTranslations() {
  return loadYisimCardNameTranslations();
}

function emitConvertedDataUpdated() {
  if (cardListWindow && !cardListWindow.isDestroyed()) {
    cardListWindow.webContents.send('card-operation-log-updated');
  }
}

function emitBoardDetectionUpdated(payload) {
  latestBoardPayload = payload;
  const comparablePayload = { ...payload };
  delete comparablePayload.updatedAt;
  const nextPayloadJson = JSON.stringify(comparablePayload);
  if (nextPayloadJson === latestBoardPayloadJson) return;
  latestBoardPayloadJson = nextPayloadJson;
  if (boardWindow && !boardWindow.isDestroyed()) {
    boardWindow.webContents.send('board-detection-updated', payload);
  }
  if (damageWindow && !damageWindow.isDestroyed()) {
    damageWindow.webContents.send('board-detection-updated', payload);
  }
}

function processOperationLog() {
  try {
    const settings = loadSettings();
    const operationLogPath = resolveGameFile('CardOperationLog.json', settings);
    if (!operationLogPath || !fileExists(operationLogPath)) return;

    const logContent = fs.readFileSync(operationLogPath, 'utf8');
    const operations = parseOperationLog(logContent);

    if (operations === null) {
      const waitingData = { cards: {}, status: 'waiting' };
      writeDerivedData(getConvertedOperationPath(), waitingData);
      writeDerivedData(getConvertedHandPath(), waitingData);
      emitConvertedDataUpdated();
      return;
    }

    const deckCards = calculateDeckCards(operations);
    const handCards = calculateHandCards(operations);
    writeDerivedData(getConvertedOperationPath(), { cards: deckCards });
    writeDerivedData(getConvertedHandPath(), { cards: handCards });
    emitConvertedDataUpdated();
  } catch (error) {
    console.error('Error in processOperationLog:', error);
  }
}

function startConverters() {
  processOperationLog();
  if (converterInterval) clearInterval(converterInterval);
  converterInterval = setInterval(processOperationLog, 1000);
}

function loadConvertedHandCards() {
  try {
    const convertedHandPath = getConvertedHandPath();
    if (!fileExists(convertedHandPath)) return {};
    return JSON.parse(fs.readFileSync(convertedHandPath, 'utf8') || '{"cards":{}}').cards || {};
  } catch (error) {
    return {};
  }
}

function getCurrentHandCandidates() {
  return Object.keys(loadConvertedHandCards()).filter((name) => !!name);
}

const MAX_CAPTURE_WIDTH  = 1920;
const MAX_CAPTURE_HEIGHT = 1080;

async function findGameWindowSource() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const scale = primaryDisplay.scaleFactor || 1;
  // Cap at MAX_CAPTURE dimensions: templates are captured at 1920×1080 scale,
  // and working at larger sizes only inflates float-array allocation and
  // comparison cost with no accuracy benefit.
  const thumbnailSize = {
    width:  Math.min(Math.round(primaryDisplay.size.width  * scale), MAX_CAPTURE_WIDTH),
    height: Math.min(Math.round(primaryDisplay.size.height * scale), MAX_CAPTURE_HEIGHT)
  };
  if (process.platform === 'win32') {
    const windowSources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize,
      fetchWindowIcons: false
    });
    const windowSource = windowSources.find((source) => {
      const sourceName = (source.name || '').toLowerCase();
      return GAME_SOURCE_PATTERNS.some((pattern) => sourceName.includes(pattern.toLowerCase()));
    });
    if (windowSource && !windowSource.thumbnail.isEmpty()) {
      return windowSource;
    }

    const overlayWindows = [controlsWindow, damageWindow].filter(w => w && !w.isDestroyed());
    overlayWindows.forEach(w => w.hide());
    await new Promise(r => setTimeout(r, 80));
    const screenSources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize,
      fetchWindowIcons: false
    });
    overlayWindows.forEach(w => w.show());
    return screenSources.find((source) =>
      source.display_id === String(primaryDisplay.id)
    ) || screenSources[0] || null;
  }

  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize,
    fetchWindowIcons: false
  });
  return sources.find((source) => {
    const sourceName = (source.name || '').toLowerCase();
    return GAME_SOURCE_PATTERNS.some((pattern) => sourceName.includes(pattern.toLowerCase()));
  }) || null;
}

async function performBoardCapture() {
  const settings = loadSettings();
  const battleState = loadBattleState(settings);
  const realOpenSlots = battleState.openSlots || NUM_SLOTS;
  const boardOpenSlots = debugMode ? NUM_SLOTS : realOpenSlots;
  const fallbackSlotRects = getFallbackSlotRects();
  const fallbackTalentCapture = buildFallbackTalentResults(screen.getPrimaryDisplay().size, 'idle');
  const emptyDamagePreview = (error = null) => ({
    first8Turns: null,
    perTurnDamage: [],
    cumulativeDamage: [],
    turnsSimulated: 0,
    playerCharacter: null,
    error
  });

  const handCandidates = getCurrentHandCandidates();

  try {
    const source = await findGameWindowSource();
    if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
      emitBoardDetectionUpdated({
        slots: Array(8).fill(null),
        damagePreview: emptyDamagePreview('Game window not found'),
        updatedAt: Date.now(),
        capture: {
          status: 'missing-source',
          screenshotSize: screen.getPrimaryDisplay().size,
          fallbackSlotRects,
          slotResults: buildFallbackSlotResults(fallbackSlotRects, boardOpenSlots, 'missing-source'),
          talents: fallbackTalentCapture.talents,
          talentDetection: {
            ...fallbackTalentCapture.debug,
            status: 'missing-source'
          },
          battle: battleState,
          currentRound: battleState.currentRound,
          openSlots: realOpenSlots,
          boardOpenSlots,
          realOpenSlots,
          debugMode
        }
      });
      return;
    }

    const talentCapture = detectTalents(source.thumbnail);

    // For any detected talent, add its Chinese name to hand candidates.
    // Personal card templates (e.g. images/personal/FengXu/阴符玉简1.png) share their
    // name with the talent that grants them, so this lookup finds them automatically.
    const talentCardNames = talentCapture.talents
      .filter((t) => t.detected && t.nameCn)
      .map((t) => t.nameCn);
    const allHandCandidates = talentCardNames.length > 0
      ? [...new Set([...handCandidates, ...talentCardNames])]
      : handCandidates;

    const detection = allHandCandidates.length > 0
      ? detectSlots(source.thumbnail, allHandCandidates, getImagesDir())
      : {
          slots: Array(NUM_SLOTS).fill(null),
          slotResults: [],
          debug: { reason: 'no-hand-candidates' }
        };
    const slotResults = applyOpenSlotStateToResults(detection.slotResults, fallbackSlotRects, boardOpenSlots);
    const slots = slotResults.map((result) => result.card);
    const activeSlots = slots.slice(0, realOpenSlots);
    const damagePreview = await simulateFirstEightTurns(activeSlots, {
      deckSlots: realOpenSlots,
      playerState: battleState.simulationPlayer,
      rollMode: settings.damageRollMode,
      talents: talentCapture.talents
    });

    // Resize damage window to match actual game height (game may be taller than primary.bounds reports)
    if (damageWindow && !damageWindow.isDestroyed()) {
      const ssSize = source.thumbnail.getSize();
      const scaleFactor = screen.getPrimaryDisplay().scaleFactor || 1;
      const logicalH = Math.round(ssSize.height / scaleFactor);
      const logicalW = Math.round(ssSize.width  / scaleFactor);
      const [curW, curH] = damageWindow.getContentSize();
      if (curH !== logicalH || curW !== logicalW) {
        damageWindow.setContentSize(logicalW, logicalH);
      }
    }

    emitBoardDetectionUpdated({
      slots,
      damagePreview,
      updatedAt: Date.now(),
      capture: {
        status: 'ok',
        screenshotSize: source.thumbnail.getSize(),
        sourceName: source.name,
        detector: detection.debug,
        slotResults,
        fallbackSlotRects,
        talents: talentCapture.talents,
        talentDetection: talentCapture.debug,
        battle: battleState,
        currentRound: battleState.currentRound,
        openSlots: realOpenSlots,
        boardOpenSlots,
        realOpenSlots,
        debugMode
      }
    });
  } catch (error) {
    emitBoardDetectionUpdated({
      slots: Array(8).fill(null),
      damagePreview: emptyDamagePreview(error.message),
      updatedAt: Date.now(),
      capture: {
        status: 'error',
        screenshotSize: screen.getPrimaryDisplay().size,
        message: error.message,
        fallbackSlotRects,
        slotResults: buildFallbackSlotResults(fallbackSlotRects, boardOpenSlots, 'error'),
        talents: fallbackTalentCapture.talents,
        talentDetection: {
          ...fallbackTalentCapture.debug,
          status: 'error'
        },
        battle: battleState,
        currentRound: battleState.currentRound,
        openSlots: realOpenSlots,
        boardOpenSlots,
        realOpenSlots,
        debugMode
      }
    });
  }
}

async function captureBoardState() {
  if (boardCaptureInFlight) {
    boardCapturePending = true;
    return;
  }

  boardCaptureInFlight = true;
  try {
    await performBoardCapture();
  } finally {
    boardCaptureInFlight = false;
    if (boardCapturePending) {
      boardCapturePending = false;
      setImmediate(() => {
        captureBoardState().catch((error) => {
          console.error('Error in queued board capture:', error);
        });
      });
    }
  }
}

function startBoardCapture() {
  captureBoardState();
  if (boardCaptureInterval) clearInterval(boardCaptureInterval);
  boardCaptureInterval = setInterval(() => {
    captureBoardState();
  }, BOARD_CAPTURE_INTERVAL_MS);
}

app.whenReady().then(() => {
  try {
    appendStartupLog('app.whenReady');

    // Load saved calibration and apply to detectors before first capture
    const savedCalibration = loadCalibration();
    if (savedCalibration) {
      applyCalibration(savedCalibration);
    }

    createOverlayWindows();

    app.on('activate', () => {
      createOverlayWindows();
      applyPanelVisibilityFromSettings();
      broadcastUiState();
    });
    // load settings and start watching game converted files if possible
    const s = loadSettings();
    const resolvedGamePath = getResolvedGamePath(s);
    if (resolvedGamePath && s.gamePath !== resolvedGamePath) {
      s.gamePath = resolvedGamePath;
      saveSettings(s);
    }
    if (resolvedGamePath) {
      watchPath(path.join(resolvedGamePath, 'BattleLog.json'));
      watchPath(path.join(resolvedGamePath, 'CardOperationLog.json'));
    }
    startConverters();
    startBoardCapture();
    applyPanelVisibilityFromSettings();
    broadcastUiState();
    appendStartupLog('startup complete');
  } catch (error) {
    appendStartupLog('startup failed', error);
    throw error;
  }
});

app.on('will-quit', () => {
  if (converterInterval) clearInterval(converterInterval);
  if (boardCaptureInterval) clearInterval(boardCaptureInterval);
  watchedPaths.forEach((watcher) => {
    try { watcher.close(); } catch (e) {}
  });
  watchedPaths.clear();
});

ipcMain.handle('read-settings', () => {
  return loadSettings();
});

ipcMain.handle('read-card-library', () => {
  return loadCardLibrary();
});

ipcMain.handle('read-card-name-translations', () => {
  return loadCardNameTranslations();
});

ipcMain.handle('write-settings', (_, settings) => {
  saveSettings(settings);
  applyPanelVisibilityFromSettings();
  broadcastUiState();
  return true;
});

ipcMain.handle('get-ui-state', () => {
  return getUiState();
});

ipcMain.handle('set-delete-mode', (_, enable) => {
  deleteMode = !!enable;
  updateCardListWindowMouseMode();
  broadcastUiState();
  return getUiState();
});

ipcMain.handle('toggle-card-list-visibility', () => {
  const settings = loadSettings();
  settings.showCardList = !settings.showCardList;
  saveSettings(settings);
  applyPanelVisibilityFromSettings();
  broadcastUiState();
  return getUiState();
});

ipcMain.handle('toggle-board-visibility', () => {
  const settings = loadSettings();
  settings.showBoardPanel = !settings.showBoardPanel;
  saveSettings(settings);
  applyPanelVisibilityFromSettings();
  broadcastUiState();
  return getUiState();
});

ipcMain.handle('set-card-language', (_, nextLanguage) => {
  const settings = loadSettings();
  settings.cardLanguage = nextLanguage === 'en' ? 'en' : 'zh';
  saveSettings(settings);
  broadcastUiState();
  return getUiState();
});

ipcMain.handle('set-damage-roll-mode', (_, nextMode) => {
  const settings = loadSettings();
  settings.damageRollMode = nextMode;
  saveSettings(settings);
  broadcastUiState();
  captureBoardState().catch((error) => {
    console.error('Failed to refresh board capture after roll mode change', error);
  });
  return getUiState();
});

ipcMain.handle('set-debug-mode', (_, enabled) => {
  debugMode = !!enabled;
  broadcastUiState();
  captureBoardState().catch((error) => {
    console.error('Failed to refresh board capture after debug mode change', error);
  });
  return getUiState();
});

ipcMain.handle('set-controls-expanded', (_, expanded) => {
  controlsExpanded = !!expanded;
  updateControlsWindowBounds();
  return true;
});

ipcMain.handle('perform-calibration', async () => {
  const source = await findGameWindowSource();
  if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
    throw new Error('Game window not found. Open the game before calibrating.');
  }
  const onProgress = (step, total, message) => {
    if (controlsWindow && !controlsWindow.isDestroyed()) {
      controlsWindow.webContents.send('calibration-progress', { step, total, message });
    }
  };
  const result = await performCalibration(source.thumbnail, onProgress);
  saveCalibration(result);
  applyCalibration(result);
  broadcastUiState();
  captureBoardState().catch((error) => {
    console.error('Failed to refresh board capture after calibration', error);
  });
  return { success: true, calibratedAt: result.calibratedAt };
});

function watchPath(p) {
  if (!p || watchedPaths.has(p)) return;
  try {
    const dir = path.dirname(p);
    const base = path.basename(p);
    const watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      atomic: true,
      awaitWriteFinish: {
        stabilityThreshold: 150,
        pollInterval: 25
      }
    });

    const notifyChange = (changedPath) => {
      if (path.basename(changedPath || '') !== base) return;
      if (cardListWindow && !cardListWindow.isDestroyed()) {
        cardListWindow.webContents.send('file-changed', p);
      }
    };

    watcher.on('add', notifyChange);
    watcher.on('change', notifyChange);
    watcher.on('unlink', notifyChange);
    watcher.on('error', (error) => {
      console.warn('watchPath fail', p, error);
    });

    watchedPaths.set(p, watcher);
  } catch (e) {
    console.warn('watchPath fail', e);
  }
}

ipcMain.handle('set-game-path', (_, gamePath) => {
  const s = loadSettings();
  s.gamePath = gamePath;
  saveSettings(s);
  watchPath(path.join(gamePath, 'BattleLog.json'));
  watchPath(path.join(gamePath, 'CardOperationLog.json'));
  processOperationLog();
  return true;
});

ipcMain.handle('read-derived-file', (_, fileName) => {
  const allowedFiles = {
    'ConvertedHandCard.json': getConvertedHandPath(),
    'ConvertedCardOperationLog.json': getConvertedOperationPath()
  };

  try {
    const safeName = path.basename(fileName || '');
    const resolvedPath = allowedFiles[safeName];
    if (resolvedPath && fileExists(resolvedPath)) {
      return fs.readFileSync(resolvedPath, 'utf8');
    }
  } catch (error) {}
  return '';
});
