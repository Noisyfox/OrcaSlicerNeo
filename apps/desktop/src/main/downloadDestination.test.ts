import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserWindow } from 'electron';
import type { DownloadSelection } from '@orca/printer-control/domain';
const electron = vi.hoisted(() => ({ app: { getPath: vi.fn(() => '/default/downloads') }, dialog: {
  showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn(),
}, shell: { openPath: vi.fn(async () => '') } }));
vi.mock('electron', () => electron);
import { downloadDestinationHost } from './downloadDestination';
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { force: true, recursive: true }))); });
const files = [{ name: '../../video.mp4' }] as DownloadSelection[];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'neo-download-dialog-')); roots.push(root);
  return { root, host: downloadDestinationHost(root, () => ({} as BrowserWindow)) };
}
it('defaults to the OS downloads folder and persists a chosen directory privately', async () => {
  const { root, host } = await fixture(); expect(await host.directory()).toEqual({ label: 'downloads' });
  electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [join(root, 'chosen')] });
  expect(await host.chooseDirectory()).toEqual({ status: 'selected', label: 'chosen' });
  expect(await host.destination(files, false)).toEqual({ kind: 'directory', directory: join(root, 'chosen') });
  expect(JSON.parse(await readFile(join(root, 'download-directory.json'), 'utf8')).directory).toBe(join(root, 'chosen'));
  // Reopening Preferences/the application and changing the source agent share the same host preference.
  const reopened = downloadDestinationHost(root, () => ({} as BrowserWindow));
  for (const provider of ['bambu', 'future-agent']) {
    const selection = [{ name: 'file.bin', file: { printerId: `${provider}:printer`, routeId: `${provider}:route` } }] as DownloadSelection[];
    expect(await reopened.destination(selection, false)).toEqual({ kind: 'directory', directory: join(root, 'chosen') });
  }
  electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
  expect(await reopened.chooseDirectory()).toEqual({ status: 'cancelled' });
  expect(await reopened.directory()).toEqual({ label: 'chosen' });

});
it('sanitizes a suggested name and explicitly confirms replacement before admitting it', async () => {
  const { root, host } = await fixture(), path = join(root, 'video.mp4'); await writeFile(path, 'original');
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path });
  electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 });
  expect(await host.destination(files, true)).toBe(null);
  expect(electron.dialog.showSaveDialog.mock.calls[0][1].defaultPath).toBe('/default/downloads/.._.._video.mp4');
  expect(await host.destination(files, true)).toEqual({ kind: 'file', path, overwriteConfirmed: true });
  expect(await readFile(path, 'utf8')).toBe('original');
});
it('uses a folder dialog for batches and honors cancellation before any save', async () => {
  const { host } = await fixture(); electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
  expect(await host.destination([...files, ...files], true)).toBe(null); expect(electron.dialog.showSaveDialog).not.toHaveBeenCalled();
});
