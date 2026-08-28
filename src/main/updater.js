// ============================================================
//  AUTO UPDATER — Kairon Browser
//  Manages automatic application updates using electron-updater.
//  State is communicated to the renderer via IPC for display in
//  the application menu (no popups or separate windows).
// ============================================================

const { autoUpdater } = require('electron-updater');
const { app, ipcMain } = require('electron');

let currentState = {
  state: 'current', // 'current' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
  currentVersion: app.getVersion(),
  availableVersion: null,
  progress: null,
  hasUpdate: false,
};

let _broadcastCallback = null;

function broadcastState() {
  if (typeof _broadcastCallback === 'function') {
    try {
      _broadcastCallback(getUpdaterState());
    } catch (e) { }
  }
}

function getUpdaterState() {
  return {
    ...currentState,
    currentVersion: app.getVersion(),
  };
}

function initUpdater({ onStateChange } = {}) {
  if (onStateChange) _broadcastCallback = onStateChange;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => {
    currentState.state = 'checking';
    broadcastState();
  });

  autoUpdater.on('update-available', (info) => {
    currentState.state = 'available';
    currentState.availableVersion = (info && info.version) || null;
    currentState.hasUpdate = true;
    broadcastState();
  });

  autoUpdater.on('update-not-available', () => {
    currentState.state = 'current';
    currentState.availableVersion = null;
    currentState.hasUpdate = false;
    broadcastState();
  });

  autoUpdater.on('download-progress', (progressObj) => {
    currentState.state = 'downloading';
    currentState.progress = progressObj ? Math.round(progressObj.percent) : null;
    currentState.hasUpdate = true;
    broadcastState();
  });

  autoUpdater.on('update-downloaded', (info) => {
    currentState.state = 'ready';
    currentState.availableVersion = (info && info.version) || currentState.availableVersion;
    currentState.hasUpdate = true;
    broadcastState();
  });

  autoUpdater.on('error', (err) => {
    console.warn('[updater] Update check error:', (err && err.message) || err);
    if (currentState.state !== 'ready') {
      currentState.state = 'error';
    }
    broadcastState();
  });

  // Initial check after startup (delayed so app startup remains fast and smooth)
  setTimeout(() => {
    checkForUpdates();
  }, 5000);
}

function checkForUpdates() {
  try {
    return autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[updater] Check for updates failed:', (err && err.message) || err);
    });
  } catch (err) {
    console.warn('[updater] Check for updates error:', (err && err.message) || err);
  }
}

function installUpdate() {
  try {
    autoUpdater.quitAndInstall(false, true);
  } catch (err) {
    console.error('[updater] quitAndInstall failed:', err);
  }
}

module.exports = {
  initUpdater,
  checkForUpdates,
  installUpdate,
  getUpdaterState,
};
