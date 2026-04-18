const fs = require('fs');
const { getWritablePath } = require('./runtime_paths');

const CALIBRATION_FILE = 'calibration.json';

function loadCalibration() {
  try {
    const filePath = getWritablePath(CALIBRATION_FILE);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !data.slots || !data.talents) return null;
    return data;
  } catch (_error) {
    return null;
  }
}

function saveCalibration(data) {
  const filePath = getWritablePath(CALIBRATION_FILE);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = { loadCalibration, saveCalibration };
