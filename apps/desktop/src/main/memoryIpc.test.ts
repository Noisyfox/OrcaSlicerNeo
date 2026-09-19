import { describe, expect, it } from 'vitest';
import { summarizeElectronMemory } from './memoryIpc';

describe('Electron memory IPC summary', () => {
  it('sums every app process and groups working sets by process type', () => {
    const result = summarizeElectronMemory([
      { type: 'Browser', memory: { workingSetSize: 10 } },
      { type: 'Tab', memory: { workingSetSize: 20 } },
      { type: 'Tab', memory: { workingSetSize: 30 } },
      { type: 'GPU', memory: { workingSetSize: 40 } },
    ]);
    expect(result).toEqual({
      totalBytes: 100 * 1024,
      entries: [
        { id: 'electron:Browser', label: 'Main process', bytes: 10 * 1024 },
        { id: 'electron:GPU', label: 'GPU process', bytes: 40 * 1024 },
        { id: 'electron:Tab', label: 'Tab process', bytes: 50 * 1024 },
      ],
    });
  });

  it('rejects malformed metrics instead of exposing them to the renderer', () => {
    expect(summarizeElectronMemory([
      { type: 'Tab', memory: { workingSetSize: -1 } },
      { type: '', memory: { workingSetSize: 10 } },
      { type: 'GPU', memory: { workingSetSize: Number.NaN } },
    ])).toEqual({ totalBytes: 0, entries: [] });
  });
});
