import { fileURLToPath } from 'node:url';
import { loadBambuNative } from '../dist/index.js';
import { acquire, manifest } from './acquire.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const plugin = await acquire();
const addon = fileURLToPath(new URL('../build/Release/bambu.node', import.meta.url));
const agent = loadBambuNative(addon, plugin, () => {});
let temporary;
try {
  const version = await agent.getVersion();
  if (!version.startsWith(`${manifest.series}.`)) throw new Error('Unexpected plugin version');
  console.log(JSON.stringify({ release: manifest.release, target: `${process.platform}-${process.arch}`, pluginVersion: version }));
  if (process.argv.includes('--print-abi')) {
    temporary = await mkdtemp(join(tmpdir(), 'neo-print-abi-'));
    await agent.createAgent(temporary);
    // Pinned LAN implementation rejects missing IP/access code before file or network I/O.
    // This tests the real by-value ABI without an address, credentials or a printable file.
    const result = await agent.startPrint('lan', { dev_id: 'abi-fixture', filename: '/nonexistent/abi.3mf', plate_index: 1 });
    assert.deepEqual(result, { code: -6010, mayHaveStarted: false, cancelRequested: false });
    console.log(JSON.stringify({ printAbi: 'passed', networkDispatch: false }));
  }
} finally { await agent.close(); if (temporary) await rm(temporary, { recursive: true, force: true }); }
