// main.js (inline backend, no child process)
const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');

let mainWindow;
const PORT = process.env.PORT || 3000;
const isDev = !app.isPackaged;

function waitForBackendReady(timeoutMs = 20000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const req = http.get(
        { host: '127.0.0.1', port: PORT, path: '/health', timeout: 1500 },
        (res) => {
          if (res.statusCode === 200) { res.resume(); resolve(true); }
          else { res.resume(); schedule(); }
        }
      );
      req.on('error', schedule);
      req.on('timeout', () => { req.destroy(); schedule(); });
    };
    const schedule = () =>
      Date.now() > deadline ? resolve(false) : setTimeout(tryOnce, intervalMs);
    tryOnce();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  waitForBackendReady().then(() => {
    mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
    if (isDev && process.env.DEBUG_TOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // ⤵️ Start backend inline (no child process)
    // IMPORTANT: index.js must bind to 127.0.0.1 and NOT call process.exit()
    require(path.join(__dirname, 'index.js'));

    createWindow();
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (mainWindow === null) createWindow(); });
}
