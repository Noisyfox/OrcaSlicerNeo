import { contextBridge, ipcRenderer } from 'electron';
// The official page receives only Orca's wx message bridge, never window.orca.
contextBridge.exposeInMainWorld('wx', { postMessage: (value: unknown) => {
  if (typeof value === 'string' && value.length <= 1024 * 1024) ipcRenderer.send('bambu:login-message', value);
} });
ipcRenderer.on('bambu:login-reply', (_event, value: unknown) => {
  window.postMessage(value, window.location.origin);
});
