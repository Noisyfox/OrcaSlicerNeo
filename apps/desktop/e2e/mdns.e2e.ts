import type { ElectronBridge } from '../src/shared/ipc';
type HostWindow = Window & { orca: ElectronBridge };
import multicastDns from 'multicast-dns';
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, desktopLaunchOptions } from './electron-fixture';

test('Electron resolves real multicast packets through the generic mDNS preload boundary', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'neo-mdns-'));
  const configuration = join(directory, 'printers.json');
  writeFileSync(configuration, JSON.stringify({ version: 1, printers: [] }));
  const serviceType = `_neo-${Date.now()}._tcp.local.`;
  const fqdn = `Fixture.${serviceType}`;
  const host = `fixture-${Date.now()}.local`;
  const socket = multicastDns({ reuseAddr: true });
  const errors: string[] = [];
  socket.on('error', error => errors.push(error.message));
  socket.on('query', packet => {
    if (!packet.questions?.some(question => question.name.replace(/\.$/, '').toLowerCase() === serviceType.slice(0, -1))) return;
    socket.respond({ answers: [{ name: serviceType, type: 'PTR', ttl: 120, data: fqdn }], additionals: [
      { name: fqdn, type: 'SRV', ttl: 120, data: { target: host, port: 1884, priority: 0, weight: 0 } },
      { name: fqdn, type: 'TXT', ttl: 120, data: [Buffer.from('model=fixture')] },
      { name: host, type: 'A', ttl: 120, data: '127.0.0.1' },
    ] });
  });
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_PRINTER_CONFIG: configuration } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = desktopLaunchOptions();
  const app = await _electron.launch({ ...launch, args: [...(launch.args ?? []), `--user-data-dir=${join(directory, 'user-data')}`],
    cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean((window as unknown as HostWindow).orca?.mdns));
    await page.evaluate(type => (window as unknown as HostWindow).orca!.mdns.start('generic-mdns-e2e', type), serviceType);
    await expect.poll(() => page.evaluate(() => (window as unknown as HostWindow).orca!.mdns.snapshot('generic-mdns-e2e')), { timeout: 20_000 })
      .toMatchObject([{ serviceType, name: 'Fixture', port: 1884, addresses: ['127.0.0.1'], txt: { model: 'fixture' } }]);
    await page.evaluate(() => (window as unknown as HostWindow).orca!.mdns.stop('generic-mdns-e2e'));
    expect(await page.evaluate(async () => {
      try { await (window as unknown as HostWindow).orca!.mdns.snapshot('generic-mdns-e2e'); return false; } catch { return true; }
    })).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await app.close(); socket.destroy(); rmSync(directory, { recursive: true, force: true });
  }
});
