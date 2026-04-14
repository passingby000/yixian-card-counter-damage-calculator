const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const REPO_ROOT = path.resolve(__dirname);

function isPackagedApp() {
  try {
    return !!app?.isPackaged;
  } catch (error) {
    return false;
  }
}

function getCodeRoot() {
  if (isPackagedApp()) {
    return path.join(process.resourcesPath, 'app.asar');
  }
  return REPO_ROOT;
}

function getAssetRoot() {
  if (isPackagedApp()) {
    return process.resourcesPath;
  }
  return REPO_ROOT;
}

function getWritableRoot() {
  let writableRoot = REPO_ROOT;
  try {
    if (typeof app?.getPath === 'function') {
      writableRoot = app.getPath('userData');
    }
  } catch (error) {}

  fs.mkdirSync(writableRoot, { recursive: true });
  return writableRoot;
}

function getCodePath(...segments) {
  return path.join(getCodeRoot(), ...segments);
}

function getAssetPath(...segments) {
  return path.join(getAssetRoot(), ...segments);
}

function getWritablePath(...segments) {
  return path.join(getWritableRoot(), ...segments);
}

function getLegacyRepoPath(...segments) {
  return path.join(REPO_ROOT, ...segments);
}

function getYisimRoot() {
  const assetRoot = getAssetRoot();
  const candidates = isPackagedApp()
    ? [
        path.join(assetRoot, 'vendor', 'yisim'),
        path.join(assetRoot, 'yisim')
      ]
    : [
        path.join(REPO_ROOT, 'yisim'),
        path.join(REPO_ROOT, 'vendor', 'yisim'),
        path.join(REPO_ROOT, 'vendor', 'yisim-master')
      ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function getYisimPath(...segments) {
  return path.join(getYisimRoot(), ...segments);
}

module.exports = {
  isPackagedApp,
  getCodeRoot,
  getAssetRoot,
  getWritableRoot,
  getCodePath,
  getAssetPath,
  getWritablePath,
  getLegacyRepoPath,
  getYisimRoot,
  getYisimPath
};
