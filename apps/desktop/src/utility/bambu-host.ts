import { isBambuControlRequest } from '../shared/bambuControl';
import { isBambuHostRequest } from '../shared/bambuHost';
import { isAbsolute } from 'node:path';
import { isBambuRead, type BambuHostConfig } from '../shared/bambu';
import { BambuRuntime } from './bambu/runtime';

let runtime: BambuRuntime | null = null;
let initialized = false;
function validConfig(value: unknown): value is BambuHostConfig {
  if (!value || typeof value !== 'object') return false;
  const config = value as BambuHostConfig;
  return ['addonPath', 'pluginPath', 'directory', 'certificateDirectory'].every(key => {
    const path = config[key as keyof BambuHostConfig]; return typeof path === 'string' && isAbsolute(path) && !path.includes('\0');
  }) && ['windows', 'windows_arm', 'macos', 'linux'].includes(config.osType) && typeof config.osVersion === 'string';
}
process.parentPort.on('message', event => {
  const message: unknown = event.data;
  if (!message || typeof message !== 'object') return;
  const data = message as Record<string, unknown>;
  if (data.type === 'init' && !initialized && validConfig(data.config)) {
    initialized = true;
    runtime = new BambuRuntime(data.config, change => process.parentPort.postMessage({ type: 'changed', change }));
    process.parentPort.postMessage({ type: 'ready' });
  } else if (data.type === 'read' && Number.isSafeInteger(data.id) && isBambuRead(data.request) && runtime) {
    const id = data.id;
    void runtime.read(data.request).then(value => process.parentPort.postMessage({ type: 'reply', id, value }))
      .catch(() => process.parentPort.postMessage({ type: 'reply', id, error: 'unavailable' }));
  } else if (data.type === 'control' && Number.isSafeInteger(data.id) && isBambuControlRequest(data.request) && runtime) {
    const id = data.id;
    void runtime.control(data.request).then(value => process.parentPort.postMessage({ type: 'reply', id, value }))
      .catch(() => process.parentPort.postMessage({ type: 'reply', id, error: 'unavailable' }));
  } else if (data.type === 'host' && Number.isSafeInteger(data.id) && isBambuHostRequest(data.request) && runtime) {
    const id = data.id;
    void runtime.host(data.request).then(value => process.parentPort.postMessage({ type: 'reply', id, value }))
      .catch(() => process.parentPort.postMessage({ type: 'reply', id, error: 'unavailable' }));
  } else if (data.type === 'shutdown' && initialized) {
    void runtime?.close().finally(() => process.exit(0));
  }
});
