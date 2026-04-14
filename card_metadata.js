const fs = require('fs');
const { getAssetPath, getYisimPath } = require('./runtime_paths');

const CARD_DATA_CSV_PATH = getYisimPath('localization', '1.5.9', 'card_data.csv');
const LEGACY_CARD_LIB_PATH = getAssetPath('data', 'card_lib.json');
const SEASONAL_CARD_LIB_PATH = getAssetPath('data', 'seasonal_card_lib.json');

const CARD_NAME_ALIASES = {
  '查体': '察体',
  '梦•凝意决': '梦•凝意诀',
  '梦·凝意决': '梦·凝意诀'
};

const CSV_CATEGORY_MAP = {
  character_specific: { type: 'personal', category: 'personal' },
  normal_attack: { type: 'general', category: 'general' },
  talisman: { type: 'talisman', category: 'talisman' },
  spiritual_pet: { type: 'spiritual-pet', category: 'spiritual-pet' },
  side_job_elixirist: { type: 'side-job', category: 'elixirist' },
  side_job_formation: { type: 'side-job', category: 'formation' },
  side_job_fortune_teller: { type: 'side-job', category: 'fortune-teller' },
  side_job_music: { type: 'side-job', category: 'music' },
  side_job_painter: { type: 'side-job', category: 'painter' },
  side_job_plant_master: { type: 'side-job', category: 'plant-master' },
  side_job_talisman: { type: 'side-job', category: 'talisman' },
  sect_1_cloud_spirit_sword: { type: 'sect', category: 'cloud-spirit' },
  sect_2_heptastar: { type: 'sect', category: 'heptastar' },
  sect_3_five_elements: { type: 'sect', category: 'five-elements' },
  sect_4_forge_body_soul: { type: 'sect', category: 'forge-body' }
};

let mergedCardLibraryCache = null;

function normalizeCardLibraryKey(name = '') {
  const normalized = String(name).replace(/[•·]/g, '•').trim();
  return CARD_NAME_ALIASES[normalized] || normalized;
}

function loadJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return {};
  }
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    if (char === '\r') {
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function buildCsvRowObjects(csvText) {
  const rows = parseCsv(csvText);
  const headers = rows[0] || [];
  return rows.slice(1).map((values) => {
    const entry = {};
    headers.forEach((header, index) => {
      entry[header] = values[index] ?? '';
    });
    return entry;
  });
}

function normalizeCategory(category) {
  if (CSV_CATEGORY_MAP[category]) return CSV_CATEGORY_MAP[category];

  if (category.startsWith('seasonal_')) {
    return { type: 'seasonal', category: category.replace(/^seasonal_/, '').replace(/_/g, '-') };
  }

  if (category.startsWith('side_job_')) {
    return { type: 'side-job', category: category.replace(/^side_job_/, '').replace(/_/g, '-') };
  }

  if (category.startsWith('sect_')) {
    return { type: 'sect', category: category.replace(/^sect_\d+_/, '').replace(/_/g, '-') };
  }

  return { type: 'special', category: String(category || 'unknown').replace(/_/g, '-') };
}

function addLibraryEntry(target, key, entry) {
  if (!key) return;
  const normalizedKey = normalizeCardLibraryKey(key);
  const value = {
    ...entry,
    name: normalizeCardLibraryKey(entry?.name || normalizedKey)
  };

  target[normalizedKey] = value;

  const altDot = normalizedKey.replace(/•/g, '·');
  const altBullet = normalizedKey.replace(/·/g, '•');
  target[altDot] = value;
  target[altBullet] = value;

  Object.entries(CARD_NAME_ALIASES).forEach(([alias, canonical]) => {
    if (canonical !== normalizedKey) return;
    const normalizedAlias = String(alias).replace(/[•·]/g, '•').trim();
    const aliasDot = normalizedAlias.replace(/•/g, '·');
    const aliasBullet = normalizedAlias.replace(/·/g, '•');
    target[normalizedAlias] = value;
    target[aliasDot] = value;
    target[aliasBullet] = value;
  });
}

function buildNonDreamLibraryFromYisim() {
  const csvText = fs.readFileSync(CARD_DATA_CSV_PATH, 'utf8');
  const rows = buildCsvRowObjects(csvText);
  const library = {};

  rows.forEach((row) => {
    const name = normalizeCardLibraryKey(row.name_zh);
    if (!name || name.startsWith('梦')) return;

    const current = library[name];
    const level = Number.parseInt(row.level, 10);
    if (current && Number.isFinite(level) && current.level <= level) {
      return;
    }

    const normalizedCategory = normalizeCategory(row.category);
    library[name] = {
      name,
      phase: Number.parseInt(row.phase, 10) || 0,
      type: normalizedCategory.type,
      category: normalizedCategory.category,
      level: Number.isFinite(level) ? level : null
    };
  });

  Object.keys(library).forEach((key) => {
    delete library[key].level;
  });

  return library;
}

function mergeLegacyExtras(runtimeLibrary, legacyLibrary) {
  const merged = {};

  Object.entries(legacyLibrary || {}).forEach(([rawName, legacyEntry]) => {
    const name = normalizeCardLibraryKey(rawName);
    const runtimeEntry = runtimeLibrary[name];
    const nextEntry = runtimeEntry
      ? { ...legacyEntry, ...runtimeEntry }
      : { ...legacyEntry, name };
    addLibraryEntry(merged, name, nextEntry);
  });

  Object.entries(runtimeLibrary).forEach(([name, runtimeEntry]) => {
    if (merged[name]) return;
    addLibraryEntry(merged, name, runtimeEntry);
  });

  return merged;
}

function loadCardLibrary() {
  if (mergedCardLibraryCache) return mergedCardLibraryCache;

  const legacyLibrary = loadJsonFile(LEGACY_CARD_LIB_PATH);
  const seasonalLibrary = loadJsonFile(SEASONAL_CARD_LIB_PATH);
  const nonDreamRuntimeLibrary = buildNonDreamLibraryFromYisim();
  const mergedLibrary = mergeLegacyExtras(nonDreamRuntimeLibrary, legacyLibrary);

  Object.entries(seasonalLibrary || {}).forEach(([name, entry]) => {
    addLibraryEntry(mergedLibrary, name, entry);
  });

  mergedCardLibraryCache = mergedLibrary;
  return mergedCardLibraryCache;
}

module.exports = {
  loadCardLibrary,
  normalizeCardLibraryKey
};
