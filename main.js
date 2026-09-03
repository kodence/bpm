const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const DATA_FILE_NAME = 'bp-data.json';

// The folder holding bp-data.json: the user's chosen folder from preferences.json,
// or the app's own data folder when none is set or the chosen one is unreachable.
let dataFolderWarningShown = false;
function dataDir() {
  const chosen = readPrefsFile().dataFolder;
  if (chosen) {
    if (fs.existsSync(chosen)) return chosen;
    if (!dataFolderWarningShown) {
      dataFolderWarningShown = true;
      dialog.showMessageBox({
        type: 'warning',
        title: 'Data folder not found',
        message: `The data folder set in preferences is not available:\n${chosen}\n\nUsing the default folder for now:\n${app.getPath('userData')}`,
      });
    }
  }
  return app.getPath('userData');
}
const DATA_FILE = () => path.join(dataDir(), DATA_FILE_NAME);

function loadEntries() {
  try {
    const raw = fs.readFileSync(DATA_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function saveEntries(entries) {
  const file = DATA_FILE();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---- Preferences (thresholds, data folder), stored as an editable JSON file ----
const PREFS_FILE = () => path.join(app.getPath('userData'), 'preferences.json');
const DEFAULT_PREFS = {
  normalMax: { sys: 135, dia: 89 },   // readings at or below this are "Normal"
  highFrom: { sys: 140, dia: 90 },    // readings at or above this are "High"
  crisisAbove: { sys: 180, dia: 120 } // readings above this are "Crisis"
};

function readPrefsFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function loadPrefs() {
  const prefs = readPrefsFile();
  const merged = {
    normalMax: { ...DEFAULT_PREFS.normalMax, ...(prefs.normalMax || {}) },
    highFrom: { ...DEFAULT_PREFS.highFrom, ...(prefs.highFrom || {}) },
    crisisAbove: { ...DEFAULT_PREFS.crisisAbove, ...(prefs.crisisAbove || {}) },
    dataFolder: typeof prefs.dataFolder === 'string' && prefs.dataFolder.trim() ? prefs.dataFolder : null,
  };
  // Write the file on first run so the user can find and edit it
  if (!fs.existsSync(PREFS_FILE())) savePrefs(merged);
  return merged;
}

// Merge into the existing file so a partial update (e.g. thresholds only) keeps the rest.
function savePrefs(partial) {
  const next = { ...readPrefsFile(), ...partial };
  fs.writeFileSync(PREFS_FILE(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function dataInfo() {
  const chosen = loadPrefs().dataFolder;
  return { folder: dataDir(), file: DATA_FILE(), isDefault: !chosen, defaultFolder: app.getPath('userData') };
}

// Switch the data folder. Copies the current readings there when the folder has no data file yet.
function switchDataFolder(folder) {
  const target = folder ? path.join(folder, DATA_FILE_NAME) : path.join(app.getPath('userData'), DATA_FILE_NAME);
  const current = DATA_FILE();
  if (path.resolve(target) !== path.resolve(current) && !fs.existsSync(target) && fs.existsSync(current)) {
    fs.copyFileSync(current, target);
  }
  savePrefs({ dataFolder: folder || null });
  dataFolderWarningShown = false;
  return { ok: true, info: dataInfo(), entries: loadEntries() };
}

function toCsv(entries) {
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = ['Date,Time,Systolic,Diastolic,Pulse,Notes'];
  for (const e of entries) {
    lines.push([e.date, e.time, e.sys, e.dia, e.pulse ?? '', esc(e.note)].join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    title: 'BP Tracker',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#f4f6fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');
}

ipcMain.handle('entries:load', () => loadEntries());

ipcMain.handle('entries:save', (_evt, entries) => {
  saveEntries(entries);
  return true;
});

ipcMain.handle('entries:exportCsv', async (evt, entries) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  const today = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export blood pressure log',
    defaultPath: `bp-log-${today}.csv`,
    filters: [{ name: 'CSV file', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, toCsv(entries), 'utf8');
  return { ok: true, filePath };
});

ipcMain.handle('entries:importCsv', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import CSV (Date,Time,Systolic,Diastolic,Pulse,Notes)',
    filters: [{ name: 'CSV file', extensions: ['csv'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { ok: false };
  const text = fs.readFileSync(filePaths[0], 'utf8');
  return { ok: true, text };
});

ipcMain.handle('prefs:load', () => loadPrefs());

ipcMain.handle('prefs:save', (_evt, prefs) => {
  savePrefs(prefs);
  return true;
});

ipcMain.handle('prefs:openFile', () => {
  loadPrefs(); // make sure the file exists
  shell.showItemInFolder(PREFS_FILE());
  return true;
});

ipcMain.handle('data:info', () => dataInfo());

ipcMain.handle('data:chooseFolder', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose the folder where readings are saved',
    defaultPath: dataDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths.length) return { ok: false };
  const folder = filePaths[0];
  const target = path.join(folder, DATA_FILE_NAME);
  if (fs.existsSync(target) && path.resolve(target) !== path.resolve(DATA_FILE())) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Use that file', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Existing readings found',
      message: `That folder already contains ${DATA_FILE_NAME}.`,
      detail: 'The app will switch to the readings in that file. Your current readings stay where they are and are not merged.',
    });
    if (response !== 0) return { ok: false };
  }
  try {
    return switchDataFolder(folder);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('data:useDefaultFolder', () => {
  try {
    return switchDataFolder(null);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('app:openDataFolder', () => {
  shell.showItemInFolder(DATA_FILE());
  return true;
});

ipcMain.handle('app:confirmDelete', async (evt, message) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Confirm',
    message,
  });
  return response === 0;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Exposed for automated tests; unused by the app itself.
module.exports = { loadPrefs, savePrefs, loadEntries, saveEntries, dataInfo, switchDataFolder, DATA_FILE };
