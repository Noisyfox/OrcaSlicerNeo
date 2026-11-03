import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ utilityProcess: {} }));
import { BambuUtility } from './bambuUtility';
import { createBambuIpc } from './bambuUtility';
import { bambuRegionChoices, isBambuReadResult, type BambuHostConfig } from '../shared/bambu';
const config: BambuHostConfig = { addonPath: '/addon', pluginPath: '/plugin', directory: '/neo/bambu', certificateDirectory: '/cert', osType: 'macos', osVersion: '15.6.0' };
class Child extends EventEmitter {
  messages: Record<string, unknown>[] = [];
  postMessage(message: Record<string, unknown>) {
    this.messages.push(message);
    if (message.type === 'init') queueMicrotask(() => this.emit('message', { type: 'ready' }));
    if (message.type === 'shutdown') queueMicrotask(() => this.emit('exit', 0));
  }
}

describe('application-owned Bambu utility', () => {
  it('shares one process between clients and retains it after a client unsubscribes', async () => {
    const child = new Child(); const fork = vi.fn(() => child);
    const host = new BambuUtility('/bambu-host.js', config, fork);
    const first = vi.fn(); const second = vi.fn();
    const stop = host.onChanged(first); host.onChanged(second);
    child.emit('message', { type: 'changed', change: 'printers', private: 'not-forwarded' });
    expect(first).toHaveBeenCalledWith('printers'); expect(second).toHaveBeenCalledWith('printers');
    stop(); child.emit('message', { type: 'changed', change: 'account' });
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledTimes(2);
    expect(fork).toHaveBeenCalledOnce(); expect(child.messages.map(message => message.type)).toEqual(['init']);
    await host.close(); await host.close();
    expect(child.messages.map(message => message.type)).toEqual(['init', 'shutdown']);
  });

  it('correlates concurrent reads and rejects native data outside the public shape', async () => {
    const child = new Child(); const host = new BambuUtility('/bambu-host.js', config, () => child);
    const first = host.read('account.state'); const second = host.read('printers.saved');
    await Promise.resolve(); await Promise.resolve();
    const requests = child.messages.filter(message => message.type === 'read');
    child.emit('message', { type: 'reply', id: requests[1].id, value: { ok: true, value: [] } });
    child.emit('message', { type: 'reply', id: requests[0].id, value: { status: 'signed-out', error: null, token: 'private' } });
    await expect(first).rejects.toThrow('reply unavailable');
    expect(await second).toEqual({ ok: true, value: [] });
    await host.close();
    await expect(host.read('account.state')).rejects.toThrow('unavailable');
  });
});

it('rejects untrusted frames and requests that try to call native functions', async () => {
  const trusted = {}; const read = vi.fn(async () => ({ status: 'signed-out' as const, error: null }));
  const handler = createBambuIpc(read as never, event => event === trusted);
  expect(await handler(trusted, 'account.state')).toEqual({ status: 'signed-out', error: null });
  await expect(handler({}, 'account.state')).rejects.toThrow('rejected');
  await expect(handler(trusted, { method: 'change_user', token: 'secret' })).rejects.toThrow('rejected');
  await expect(handler(trusted, 'get_my_token')).rejects.toThrow('rejected');
  expect(read).toHaveBeenCalledOnce();
});

it('accepts only the public account and settings data', () => {
  expect(isBambuReadResult('account.state', { status: 'signed-in', account: { displayName: 'User', avatarUrl: null }, error: null })).toBe(true);
  expect(isBambuReadResult('account.state', { status: 'signed-in', account: { displayName: 'User', avatarUrl: null, token: 'private' }, error: null })).toBe(false);
  expect(isBambuReadResult('account.settings', [{ key: 'region', label: 'Region', value: 'Others', choices: bambuRegionChoices }])).toBe(true);
  expect(isBambuReadResult('account.settings', [{ key: 'region', label: 'Region', value: 'Others', choices: [], accessCode: 'private' }])).toBe(false);
});

it('rejects in-flight and future calls when the execution host exits', async () => {
  const child = new Child(), host = new BambuUtility('/host', config, () => child);
  const pending = host.host('download.cancel', { id: 'task' });
  const rejected = expect(pending).rejects.toThrow('exited');
  await Promise.resolve(); await Promise.resolve(); child.emit('exit', 1);
  await rejected; await expect(host.read('printers.saved')).rejects.toThrow('unavailable'); await host.close();
});
it('settles initialization waiters after an early utility exit', async () => {
  const child = new Child(); child.postMessage = message => { child.messages.push(message); };
  const host = new BambuUtility('/host', config, () => child);
  const pending = expect(host.read('printers.saved')).rejects.toThrow('exited');
  child.emit('exit', 1); await pending; await host.close();
});
it('isolates progress listeners and rejects extra private fields and inconsistent progress', async () => {
  const child = new Child(), host = new BambuUtility('/host', config, () => child), listener = vi.fn();
  host.onDownloadProgress(() => { throw new Error('view failed'); }); const stop = host.onDownloadProgress(listener);
  const progress = { phase: 'transferring', writtenBytes: 1, totalBytes: 3, canCancel: true };
  child.emit('message', { type: 'download-progress', id: 'task', progress: { ...progress, path: '/private' } });
  child.emit('message', { type: 'download-progress', id: 'task', progress: { ...progress, writtenBytes: 4 } });
  expect(listener).not.toHaveBeenCalled();
  child.emit('message', { type: 'download-progress', id: 'task', progress }); expect(listener).toHaveBeenCalledWith('task', progress);
  stop(); child.emit('message', { type: 'download-progress', id: 'task', progress }); expect(listener).toHaveBeenCalledOnce(); await host.close();
});
