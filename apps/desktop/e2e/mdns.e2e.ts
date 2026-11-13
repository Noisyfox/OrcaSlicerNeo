import type { ElectronBridge } from '../src/shared/ipc';
type HostWindow = Window & { orca: ElectronBridge };
import multicastDns from 'multicast-dns';
import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, desktopLaunchOptions } from './electron-fixture';

test('Electron resolves multicast through generic IPC and adopts U1 into the existing device list', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'neo-mdns-'));
  const configuration = join(directory, 'printers.json');
  writeFileSync(configuration, JSON.stringify({ version: 1, printers: [] }));
  const serviceType = `_neo-${Date.now()}._tcp.local.`;
  const fqdn = `Fixture.${serviceType}`;
  const host = `fixture-${Date.now()}.local`;
  const serial = `fixture-${Date.now()}`;
  const u1Name = `U1 ${serial}`;
  const socket = multicastDns({ reuseAddr: true });
  const errors: string[] = [];
  socket.on('error', error => errors.push(error.message));
  socket.on('query', packet => {
    const u1 = packet.questions?.some(question => question.name.replace(/\.$/, '').toLowerCase() === '_snapmaker._tcp.local');
    if (!u1 && !packet.questions?.some(question => question.name.replace(/\.$/, '').toLowerCase() === serviceType.slice(0, -1))) return;
    const type = u1 ? '_snapmaker._tcp.local.' : serviceType;
    const instance = u1 ? `Fixture.${type}` : fqdn;
    socket.respond({ answers: [{ name: type, type: 'PTR', ttl: 120, data: instance }], additionals: [
      { name: instance, type: 'SRV', ttl: 120, data: { target: host, port: 1884, priority: 0, weight: 0 } },
      { name: instance, type: 'TXT', ttl: 120, data: (u1 ? ['machine_type=Snapmaker U1', `sn=${serial}`, `device_name=${u1Name}`, 'link_mode=wan'] : ['model=fixture']).map(text => Buffer.from(text)) },
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
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await page.getByTestId('tab-device').click();
    expect(JSON.parse(readFileSync(configuration, 'utf8')).printers).toEqual([]);
    await page.getByTestId('device-discover').click();
    const choice = page.getByTestId('printer-discovery-dialog').getByRole('button', { name: new RegExp(u1Name) });
    await expect(choice).toBeVisible({ timeout: 20_000 });
    expect(JSON.parse(readFileSync(configuration, 'utf8')).printers).toEqual([]);
    await choice.click();
    await expect(page.getByTestId('printer-access-code')).toHaveCount(0);
    await page.getByRole('button', { name: 'Add LAN connection' }).click();
    await expect.poll(() => JSON.parse(readFileSync(configuration, 'utf8')).printers).toMatchObject([
      { driverId: 'snapmaker', displayName: u1Name, apiBaseUrl: 'http://127.0.0.1:7125/', consoleUrl: 'http://127.0.0.1/',
        printerModel: { vendorId: 'Snapmaker', model: 'Snapmaker U1' },
        discoveredIdentity: { manufacturer: 'Snapmaker', model: 'Snapmaker U1', serialNumber: serial } },
    ]);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByTestId('device-printer-select').click();
    await expect(page.getByTestId(`device-select-snapmaker:${serial}`)).toContainText(u1Name);
    await page.getByTestId(`device-select-snapmaker:${serial}`).click();
    await page.getByTestId(`device-edit-snapmaker:${serial}`).click();
    await expect(page.getByTestId('device-printer-model')).toContainText('Snapmaker U1');
    await expect(page.getByTestId('device-console-url')).toHaveValue('http://127.0.0.1/');
    expect(errors).toEqual([]);
  } finally {
    await app.close(); socket.destroy(); rmSync(directory, { recursive: true, force: true });
  }
});
