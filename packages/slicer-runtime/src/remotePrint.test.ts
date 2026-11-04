import { expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import type { OrcaModule } from '../../slicer-wasm/src/client';
import { inspectRemotePrintBundle } from '../../slicer-wasm/src/client';
import { inspectRemotePrintResources } from './remotePrint';
vi.mock('../../slicer-wasm/src/client', () => ({ inspectRemotePrintBundle: vi.fn(() => ({ configuration: {}, targets: [] })) }));
it('packages supplied resources without imposing metadata size or required-file validation', async () => {
  const bytes = new Uint8Array(17 * 1024 * 1024);
  bytes[0] = 42;
  const module = {} as OrcaModule, load = vi.fn(async () => module);
  await expect(inspectRemotePrintResources([{ name: 'Metadata/project_settings.config', bytes }], load)).resolves.toEqual({ configuration: {}, targets: [] });
  expect(load).toHaveBeenCalledOnce();
  const [received, zip] = vi.mocked(inspectRemotePrintBundle).mock.calls[0];
  expect(received).toBe(module);
  const unpacked = unzipSync(zip)['Metadata/project_settings.config'];
  expect(unpacked.byteLength).toBe(bytes.byteLength);
  expect(unpacked[0]).toBe(42);
  expect(unpacked.at(-1)).toBe(0);
});
