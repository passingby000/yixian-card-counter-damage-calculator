const root = document.getElementById('overlay');

let settings = { hiddenCards: {}, gamePath: null, showCardList: true, showBoardPanel: true, cardLanguage: 'zh' };
let deleteMode = false;
let cardLibrary = {};
let cardTranslations = {};
let cardLanguage = 'zh';
const CARD_METADATA_ALIASES = {
  '查体': '察体'
};

const phaseColorMap = {
  1: '#808080',
  2: '#28a745',
  3: '#007bff',
  4: '#6f42c1',
  5: '#d4af37',
  6: '#dc3545'
};

const FIXED_COPY_COUNTS = {
  '洗髓丹': 3,
  '锻体玄丹': 3,
  '悟道丹': 3
};

const BONUS_COPY_COUNTS = {
  '培元丹': 1,
  '地灵丹': 1,
  '飞云丹': 2,
  '神力丹': 2,
  '驱邪丹': 1,
  '疗伤丹': 1,
  '大还丹': 2
};

function calculateRemainingCount(cardName, phase, usedCount = 0) {
  const defaultBaseCount = phase === 5 ? 6 : 8;
  const baseCount = FIXED_COPY_COUNTS[cardName] ?? defaultBaseCount;
  const totalCount = baseCount + (BONUS_COPY_COUNTS[cardName] ?? 0);
  return Math.max(0, totalCount - usedCount);
}

function normalizeTranslationKey(name = '') {
  return String(name).replace(/[•·]/g, '·').trim();
}

function normalizeCardMetadataKey(name = '') {
  const normalized = String(name).replace(/[•·]/g, '•').trim();
  return CARD_METADATA_ALIASES[normalized] || normalized;
}

function getCardMeta(name) {
  if (!name) return null;
  return cardLibrary[name] || cardLibrary[normalizeCardMetadataKey(name)] || null;
}

function translateCardName(name) {
  if (cardLanguage !== 'en') return name;
  return cardTranslations[normalizeTranslationKey(name)] || name;
}

function applyUiState(uiState) {
  const nextCardLanguage = uiState?.cardLanguage === 'en' ? 'en' : 'zh';
  const languageChanged = nextCardLanguage !== cardLanguage;
  deleteMode = !!uiState?.deleteMode;
  cardLanguage = nextCardLanguage;
  settings.cardLanguage = cardLanguage;
  if (root) {
    root.classList.toggle('delete-mode', deleteMode);
  }
  if (languageChanged) {
    loadAndRender();
  }
}

function createRow(name, displayName, remaining, phase, currentCount) {
  const row = document.createElement('div');
  row.className = 'overlay-row';

  const label = document.createElement('span');
  label.className = 'card-name';
  label.textContent = displayName;
  label.style.color = phaseColorMap[phase] || '#808080';

  const cnt = document.createElement('span');
  cnt.className = 'card-count';
  cnt.textContent = remaining.toString();

  row.appendChild(label);
  row.appendChild(cnt);

  row.addEventListener('click', async () => {
    if (!deleteMode) return;
    if (settings.hiddenCards[name]) {
      delete settings.hiddenCards[name];
    } else {
      settings.hiddenCards[name] = {
        hiddenAt: Date.now(),
        lastHandCount: currentCount || 0,
        minHandCount: currentCount || 0
      };
    }
    await window.api.writeSettings(settings);
    loadAndRender();
  });

  return row;
}

async function loadAndRender() {
  try {
    settings = await window.api.readSettings();
  } catch (error) {
    settings = { hiddenCards: {}, gamePath: null, showCardList: true, showBoardPanel: true, cardLanguage: 'zh' };
  }
  cardLanguage = settings.cardLanguage === 'en' ? 'en' : cardLanguage;

  try {
    const [handRaw, deckRaw, loadedCardLibrary, loadedCardTranslations] = await Promise.all([
      window.api.readDerivedFile('ConvertedHandCard.json'),
      window.api.readDerivedFile('ConvertedCardOperationLog.json'),
      window.api.readCardLibrary(),
      window.api.readCardNameTranslations()
    ]);
    cardLibrary = loadedCardLibrary || {};
    cardTranslations = loadedCardTranslations || {};
    const handCards = JSON.parse(handRaw || '{"cards":{}}').cards || {};
    const deckCards = JSON.parse(deckRaw || '{"cards":{}}').cards || {};

    const entries = Object.entries(handCards)
      .filter(([name]) => {
        const meta = getCardMeta(name);
        return name && !name.startsWith('梦') && meta?.type !== 'personal';
      })
      .map(([name, info]) => {
        const meta = getCardMeta(name);
        const phase = meta?.phase ?? 0;
        return {
        name,
        displayName: translateCardName(name),
        phase,
        count: info.count ?? 1,
        remaining: calculateRemainingCount(name, phase, (deckCards[name] && deckCards[name].count) || 0)
      };
      })
      .sort((a, b) => a.phase - b.phase || a.displayName.localeCompare(b.displayName));

    let settingsChanged = false;

    Object.entries(settings.hiddenCards || {}).forEach(([name, hiddenMeta]) => {
      const currentCount = handCards[name]?.count ?? 0;
      const baselineCount = Number.isFinite(hiddenMeta?.minHandCount)
        ? hiddenMeta.minHandCount
        : (Number.isFinite(hiddenMeta?.lastHandCount) ? hiddenMeta.lastHandCount : currentCount);
      const minHandCount = Math.min(baselineCount, currentCount);

      if (currentCount > minHandCount) {
        delete settings.hiddenCards[name];
        settingsChanged = true;
        return;
      }

      if (hiddenMeta.lastHandCount !== currentCount || hiddenMeta.minHandCount !== minHandCount) {
        settings.hiddenCards[name] = {
          ...hiddenMeta,
          lastHandCount: currentCount,
          minHandCount
        };
        settingsChanged = true;
      }
    });

    if (settingsChanged) {
      await window.api.writeSettings(settings);
    }

    root.innerHTML = '';
    entries
      .filter((entry) => !settings.hiddenCards[entry.name])
      .forEach((entry) => {
        root.appendChild(createRow(entry.name, entry.displayName, entry.remaining, entry.phase, entry.count));
    });
  } catch (error) {
    root.innerHTML = '<div class="overlay-error">Failed to load data</div>';
  }
}

window.api.onCardOperationLogUpdated(() => {
  loadAndRender();
});

window.api.onUiStateUpdated((uiState) => {
  applyUiState(uiState);
});

window.api.getUiState().then((uiState) => {
  applyUiState(uiState);
});

loadAndRender();
window.loadAndRender = loadAndRender;
