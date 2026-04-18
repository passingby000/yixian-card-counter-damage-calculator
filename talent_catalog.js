const fs = require('fs');
const { getYisimPath } = require('./runtime_paths');

const TALENTS_PATH = getYisimPath('lanke', 'talents.json');
const TALENT_ANALYSIS_PATH = getYisimPath('localization', '1.5.9', 'talent_analysis.json');

const TALENT_CLASSIFICATION_OVERRIDES = {
  'Surge of Qi': {
    simulationKind: 'runtime-stack',
    runtimeKey: 'surge_of_qi_stacks'
  },
  'Indomitable Will': {
    simulationKind: 'runtime-stack',
    runtimeKey: 'indomitable_will_stacks'
  },
  'Counter Move': {
    simulationKind: 'card-grant',
    grantedCardBaseIds: [221]
  },
  'Shift Stance': {
    simulationKind: 'card-grant',
    grantedCardBaseIds: [222]
  },
  'Attain Qi': {
    simulationKind: 'transform'
  },
  'Wind in Sky': {
    simulationKind: 'non-combat-or-unsupported'
  },
  'Jade Scroll of Yin Symbol': {
    simulationKind: 'card-grant',
    grantedCardBaseIds: [214]
  },
  'Spirit Hexagram Evolves': {
    simulationKind: 'runtime-stack',
    runtimeKey: 'spirit_hexagram_evolves_stacks'
  },
  'Hexagrams Explain': {
    simulationKind: 'runtime-stack',
    runtimeKey: 'hexagrams_explain_stacks'
  },
  'Solitary Void Golden Scroll': {
    simulationKind: 'transform',
    grantedCardBaseIds: [215]
  }
};

let cachedCatalog = null;

function normalizeTalentName(name = '') {
  return String(name).replace(/\s+/g, ' ').trim();
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function buildTalentEntry(analysisEntry, runtimeKey) {
  const name = normalizeTalentName(analysisEntry?.name_en || '');
  const override = TALENT_CLASSIFICATION_OVERRIDES[name] || null;
  const normalizedRuntimeKey = typeof runtimeKey === 'string' && runtimeKey.trim()
    ? runtimeKey.trim()
    : null;
  const normalizedOtherParams = Array.isArray(analysisEntry?.other_params)
    ? analysisEntry.other_params
        .flatMap((group) => Array.isArray(group) ? group : [])
        .filter((value) => Number.isFinite(Number(value)))
        .map((value) => Number(value))
    : [];

  let simulationKind = 'non-combat-or-unsupported';
  let resolvedRuntimeKey = normalizedRuntimeKey;
  let grantedCardBaseIds = [];

  if (override) {
    simulationKind = override.simulationKind;
    if (override.runtimeKey) {
      resolvedRuntimeKey = override.runtimeKey;
    }
    if (Array.isArray(override.grantedCardBaseIds)) {
      grantedCardBaseIds = override.grantedCardBaseIds.map((value) => Number(value));
    }
  } else if (resolvedRuntimeKey) {
    simulationKind = 'runtime-stack';
  }

  if (simulationKind === 'card-grant' && grantedCardBaseIds.length === 0) {
    grantedCardBaseIds = normalizedOtherParams;
  }

  return {
    name,
    nameCn: analysisEntry?.name_cn || null,
    baseId: Number.isFinite(Number(analysisEntry?.base_id)) ? Number(analysisEntry.base_id) : null,
    phase: Array.isArray(analysisEntry?.phases) && analysisEntry.phases.length > 0
      ? Number(analysisEntry.phases[0])
      : null,
    phases: Array.isArray(analysisEntry?.phases)
      ? analysisEntry.phases.map((value) => Number(value)).filter((value) => Number.isFinite(value))
      : [],
    type: analysisEntry?.type || null,
    simulationKind,
    runtimeKey: simulationKind === 'runtime-stack' ? resolvedRuntimeKey : null,
    grantedCardBaseIds: grantedCardBaseIds.length > 0 ? grantedCardBaseIds : null
  };
}

function loadTalentCatalog() {
  if (cachedCatalog) {
    return cachedCatalog;
  }

  const runtimeTalentMap = loadJson(TALENTS_PATH);
  const talentAnalysis = loadJson(TALENT_ANALYSIS_PATH);
  const byName = new Map();

  for (const analysisEntry of talentAnalysis) {
    const name = normalizeTalentName(analysisEntry?.name_en);
    if (!name) continue;
    const runtimeKey = runtimeTalentMap[name] ?? null;
    byName.set(name, buildTalentEntry(analysisEntry, runtimeKey));
  }

  for (const [rawName, runtimeKey] of Object.entries(runtimeTalentMap)) {
    const name = normalizeTalentName(rawName);
    if (!name || byName.has(name)) continue;
    byName.set(name, {
      name,
      nameCn: null,
      baseId: null,
      phase: null,
      phases: [],
      type: null,
      simulationKind: runtimeKey ? 'runtime-stack' : 'non-combat-or-unsupported',
      runtimeKey: runtimeKey || null,
      grantedCardBaseIds: null
    });
  }

  cachedCatalog = byName;
  return cachedCatalog;
}

function getTalentMetadata(name) {
  const catalog = loadTalentCatalog();
  return catalog.get(normalizeTalentName(name)) || null;
}

module.exports = {
  normalizeTalentName,
  loadTalentCatalog,
  getTalentMetadata
};
