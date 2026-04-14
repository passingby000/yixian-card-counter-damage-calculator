const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { getYisimPath } = require('./runtime_paths');

const YISIM_DIR = getYisimPath();
const DEFAULT_ROLL_MODE = 'average';
const AVERAGE_SIM_RUNS = 100;

let yisimRuntimePromise = null;
let lastSimulationKey = null;
let lastSimulationResult = null;
let cardNameTranslationsCache = null;
let exactDetectedCardIdsCache = null;

const DREAM_NAME_ALIASES = {
  '梦·凝意决': '梦·凝意诀'
};

function normalizeDetectedName(name) {
  const normalized = (name || '').replace(/[•·]/g, '·').trim();
  return DREAM_NAME_ALIASES[normalized] || normalized;
}

function loadCardNameTranslations() {
  if (cardNameTranslationsCache) return cardNameTranslationsCache;

  const translations = {};
  try {
    const namesPath = path.join(YISIM_DIR, 'names.json');
    const names = JSON.parse(fs.readFileSync(namesPath, 'utf8'));
    if (Array.isArray(names)) {
      names.forEach((entry) => {
        const chineseName = normalizeDetectedName(entry?.namecn);
        const englishName = typeof entry?.name === 'string' ? entry.name.trim() : '';
        if (!chineseName || !englishName || translations[chineseName]) return;
        translations[chineseName] = englishName;
      });
    }
  } catch (error) {
    console.error('Failed to load yi-sim card name translations', error);
  }

  cardNameTranslationsCache = translations;
  return cardNameTranslationsCache;
}

function loadExactDetectedCardIds() {
  if (exactDetectedCardIdsCache) return exactDetectedCardIdsCache;

  const exactIds = {};

  try {
    const namesPath = path.join(YISIM_DIR, 'names.json');
    const swogiPath = path.join(YISIM_DIR, 'swogi.json');
    const names = JSON.parse(fs.readFileSync(namesPath, 'utf8'));
    const swogi = JSON.parse(fs.readFileSync(swogiPath, 'utf8'));

    const baseNames = {};
    if (Array.isArray(names)) {
      names.forEach((entry) => {
        const id = String(entry?.id || '');
        const chineseName = normalizeDetectedName(entry?.namecn);
        if (!id || !chineseName) return;
        baseNames[id] = chineseName;
      });
    }

    Object.keys(swogi || {}).forEach((cardId) => {
      const level = Number.parseInt(cardId.slice(-1), 10);
      if (!Number.isFinite(level)) return;
      const baseId = `${cardId.slice(0, -1)}1`;
      const chineseName = baseNames[cardId] || baseNames[baseId];
      if (!chineseName) return;
      exactIds[`${chineseName} (level ${level})`] = cardId;
      if (cardId.endsWith('1')) {
        exactIds[chineseName] = cardId;
      }
    });
  } catch (error) {
    console.error('Failed to load exact yi-sim detected-card ids', error);
  }

  exactDetectedCardIdsCache = exactIds;
  return exactDetectedCardIdsCache;
}

function isDreamSlot(slot) {
  if (!slot) return false;
  if (slot.isDream) return true;
  return normalizeDetectedName(slot.name).startsWith('梦');
}

async function loadYisimRuntime() {
  if (yisimRuntimePromise) return yisimRuntimePromise;

  yisimRuntimePromise = (async () => {
    const gamestateUrl = pathToFileURL(path.join(YISIM_DIR, 'gamestate_full_nolog.js')).href;
    const fuzzyUrl = pathToFileURL(path.join(YISIM_DIR, 'card_name_to_id_fuzzy.js')).href;

    const gamestateModule = await import(gamestateUrl);
    const fuzzyModule = await import(fuzzyUrl);

    await Promise.all([
      gamestateModule.ready,
      fuzzyModule.ready
    ]);

    return {
      GameState: gamestateModule.GameState,
      guess_character: gamestateModule.guess_character,
      card_name_to_id_fuzzy: fuzzyModule.card_name_to_id_fuzzy
    };
  })();

  return yisimRuntimePromise;
}

function formatDetectedCard(slot) {
  if (!slot) return '普通攻击';
  const normalizedName = normalizeDetectedName(slot.name);
  const phaseLevel = Number.parseInt(slot?.phase, 10);
  const fallbackLevel = Number.parseInt(slot?.level, 10);
  const level = isDreamSlot(slot)
    ? (Number.isFinite(phaseLevel) && phaseLevel > 0 ? phaseLevel : 1)
    : (Number.isFinite(fallbackLevel) && fallbackLevel > 0 ? fallbackLevel : 1);
  return `${normalizedName} (level ${level})`;
}

function resolveDetectedCardId(slot, card_name_to_id_fuzzy) {
  const formatted = formatDetectedCard(slot);
  const exactDetectedCardIds = loadExactDetectedCardIds();
  if (exactDetectedCardIds[formatted]) {
    return exactDetectedCardIds[formatted];
  }
  try {
    if (isDreamSlot(slot)) {
      throw new Error(`yi-sim does not support detected dream card "${formatted}"`);
    }
    return card_name_to_id_fuzzy(formatted);
  } catch (error) {
    if (!slot) {
      throw error;
    }
    if (isDreamSlot(slot)) {
      throw new Error(`yi-sim does not support detected dream card "${formatted}"`);
    }
    throw new Error(`yi-sim could not map detected card "${formatted}"`);
  }
}

function normalizeRollMode(rollMode) {
  if (rollMode === 'high' || rollMode === 'low' || rollMode === 'average') {
    return rollMode;
  }
  return DEFAULT_ROLL_MODE;
}

function normalizeDeckSlots(deckSlots) {
  const parsed = Number.parseInt(deckSlots, 10);
  if (!Number.isFinite(parsed)) return 8;
  return Math.max(0, Math.min(8, parsed));
}

function normalizePlayerState(playerState = {}) {
  const source = playerState && typeof playerState === 'object' ? playerState : {};
  const normalized = {
    hp: Number(source.hp),
    maxHp: Number(source.maxHp),
    physique: Number(source.physique),
    maxPhysique: Number(source.maxPhysique),
    cultivation: Number(source.cultivation),
    character: source.character || null
  };

  return {
    hp: Number.isFinite(normalized.hp) ? normalized.hp : 110,
    maxHp: Number.isFinite(normalized.maxHp) ? normalized.maxHp : null,
    physique: Number.isFinite(normalized.physique) ? normalized.physique : 0,
    maxPhysique: Number.isFinite(normalized.maxPhysique) ? normalized.maxPhysique : 0,
    cultivation: Number.isFinite(normalized.cultivation) ? normalized.cultivation : 100,
    character: normalized.character
  };
}

function buildEmptyResult(error = null) {
  return {
    first8Turns: null,
    perTurnDamage: [],
    cumulativeDamage: [],
    turnsSimulated: 0,
    playerCharacter: null,
    error
  };
}

function buildPlayers(normalizedSlots, card_name_to_id_fuzzy, guess_character, options = {}) {
  const playerState = normalizePlayerState(options.playerState);
  const playerCards = normalizedSlots.map((slot) => resolveDetectedCardId(slot, card_name_to_id_fuzzy));
  const opponentCards = Array(Math.max(1, normalizedSlots.length)).fill(resolveDetectedCardId(null, card_name_to_id_fuzzy));

  const player = {
    hp: playerState.hp,
    physique: playerState.physique,
    max_physique: playerState.maxPhysique,
    cultivation: playerState.cultivation,
    cards: playerCards
  };
  player.max_hp = Number.isFinite(playerState.maxHp) ? Math.max(playerState.maxHp, player.hp) : (player.hp + player.physique);
  player.character = guess_character(player);

  const opponent = {
    hp: 9999,
    physique: 0,
    max_physique: 0,
    cultivation: 0,
    cards: opponentCards
  };
  opponent.max_hp = opponent.hp + opponent.physique;
  opponent.character = guess_character(opponent);

  return { player, opponent };
}

function padSimulationSeries(perTurnDamage) {
  const paddedPerTurnDamage = perTurnDamage.slice(0, 8);
  while (paddedPerTurnDamage.length < 8) {
    paddedPerTurnDamage.push(0);
  }

  const cumulativeDamage = [];
  let runningTotal = 0;
  paddedPerTurnDamage.forEach((damage) => {
    runningTotal += damage;
    cumulativeDamage.push(runningTotal);
  });

  return {
    perTurnDamage: paddedPerTurnDamage,
    cumulativeDamage,
    first8Turns: cumulativeDamage[cumulativeDamage.length - 1] ?? 0,
    turnsSimulated: 8
  };
}

function applyRollModeOverrides(game, rollMode) {
  if (rollMode !== 'high' && rollMode !== 'low') {
    return;
  }

  game.rand_range = function randRangeWithPolicy(lo_inclusive, hi_inclusive) {
    if (this.trigger_hexagram(0)) {
      return hi_inclusive;
    }
    this.used_randomness = true;
    return rollMode === 'high' ? hi_inclusive : lo_inclusive;
  };

  game.if_c_pct = function ifCPctWithPolicy(c) {
    if (this.trigger_hexagram(0)) {
      return true;
    }
    this.used_randomness = true;
    return rollMode === 'high';
  };
}

function runSingleSimulation(GameState, player, opponent, rollMode) {
  const game = new GameState();
  Object.assign(game.players[0], {
    ...player,
    cards: [...player.cards]
  });
  Object.assign(game.players[1], {
    ...opponent,
    cards: [...opponent.cards]
  });
  applyRollModeOverrides(game, rollMode);
  game.start_of_game_setup();

  const perTurnDamage = [];
  for (let turnIndex = 0; turnIndex < 8; turnIndex += 1) {
    const before = game.players[1].hp ?? 0;
    game.sim_turn();
    const after = game.players[1].hp ?? before;
    perTurnDamage.push(Math.max(0, before - after));
    if (game.game_over) {
      break;
    }
  }

  return padSimulationSeries(perTurnDamage);
}

function averageSimulationResults(results) {
  const perTurnDamage = [];
  const cumulativeDamage = [];

  for (let turnIndex = 0; turnIndex < 8; turnIndex += 1) {
    const averagePerTurn = results.reduce((sum, result) => sum + (result.perTurnDamage[turnIndex] || 0), 0) / results.length;
    const averageCumulative = results.reduce((sum, result) => sum + (result.cumulativeDamage[turnIndex] || 0), 0) / results.length;
    perTurnDamage.push(Math.round(averagePerTurn));
    cumulativeDamage.push(Math.round(averageCumulative));
  }

  return {
    perTurnDamage,
    cumulativeDamage,
    first8Turns: cumulativeDamage[cumulativeDamage.length - 1] ?? 0,
    turnsSimulated: 8
  };
}

async function simulateFirstEightTurns(slots, options = {}) {
  const rollMode = normalizeRollMode(options.rollMode);
  const deckSlots = normalizeDeckSlots(options.deckSlots);
  const playerState = normalizePlayerState(options.playerState);
  const normalizedSlots = (slots || []).slice(0, deckSlots);
  while (normalizedSlots.length < deckSlots) normalizedSlots.push(null);

  const cacheKey = JSON.stringify({
    deckSlots,
    rollMode,
    playerState: {
      hp: playerState.hp,
      maxHp: playerState.maxHp,
      physique: playerState.physique,
      maxPhysique: playerState.maxPhysique,
      cultivation: playerState.cultivation,
      character: playerState.character
    },
    slots: normalizedSlots.map((slot) => slot ? {
      name: slot.name,
      level: slot.level,
      phase: slot.phase ?? null,
      isDream: !!slot.isDream
    } : null)
  });
  if (cacheKey === lastSimulationKey && lastSimulationResult) {
    return lastSimulationResult;
  }

  try {
    const { GameState, guess_character, card_name_to_id_fuzzy } = await loadYisimRuntime();

    if (deckSlots <= 0) {
      const emptyResult = buildEmptyResult();
      lastSimulationKey = cacheKey;
      lastSimulationResult = emptyResult;
      return emptyResult;
    }

    const { player, opponent } = buildPlayers(normalizedSlots, card_name_to_id_fuzzy, guess_character, {
      playerState
    });
    const simulationSummary = rollMode === 'average'
      ? averageSimulationResults(
          Array.from({ length: AVERAGE_SIM_RUNS }, () => runSingleSimulation(GameState, player, opponent, DEFAULT_ROLL_MODE))
        )
      : runSingleSimulation(GameState, player, opponent, rollMode);

    const result = {
      ...simulationSummary,
      playerCharacter: playerState.character || player.character,
      error: null
    };
    lastSimulationKey = cacheKey;
    lastSimulationResult = result;
    return result;
  } catch (error) {
    const failedResult = buildEmptyResult(error.message);
    lastSimulationKey = cacheKey;
    lastSimulationResult = failedResult;
    return failedResult;
  }
}

module.exports = {
  loadCardNameTranslations,
  simulateFirstEightTurns
};
