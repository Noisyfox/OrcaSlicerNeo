// Isolated test entrypoint; production main never imports this file.
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 960, height: 760,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  await window.loadURL(process.env.ORCA_CAMERA_PROBE_URL);
});
app.on('window-all-closed', () => app.quit());
