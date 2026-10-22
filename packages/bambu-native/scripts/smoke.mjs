import { fileURLToPath } from 'node:url';
import { loadBambuNative } from '../dist/index.js';
import { acquire, manifest } from './acquire.mjs';
const plugin = await acquire();
const addon = fileURLToPath(new URL('../build/Release/bambu.node', import.meta.url));
const agent = loadBambuNative(addon, plugin, () => {});
try {
  const version = await agent.getVersion();
  if (!version.startsWith(`${manifest.series}.`)) throw new Error('Unexpected plugin version');
  console.log(JSON.stringify({ release: manifest.release, target: `${process.platform}-${process.arch}`, pluginVersion: version }));
} finally { await agent.close(); }
