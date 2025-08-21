const { app, BrowserWindow } = require('electron');
const path = require('path');
const { fork } = require('child_process');

let mainWindow;

app.on('ready', () => {
  // Start backend
  fork(path.join(__dirname, 'index.js'));

  // Create window
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: { nodeIntegration: false }
  });

  // Load UI
  mainWindow.loadFile(path.join(__dirname, 'ui/index.html'));
});
