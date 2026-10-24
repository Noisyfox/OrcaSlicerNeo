/** Deterministic utility fixture: production media ownership and channels, synthetic native reader. */
import { appendFile } from 'node:fs/promises';
import type { BambuNative } from '@orca/bambu-native';
import { BambuMedia } from '../src/utility/bambu/media';
import type { BambuMediaRequest, BambuMediaAttachment } from '../src/shared/bambuMedia';
import type { BambuHostConfig } from '../src/shared/bambu';
let media: BambuMedia;
process.parentPort.on('message', ({ data, ports }) => {
  if (data.type === 'init') {
    const config: BambuHostConfig = data.config;
    const monitor = { acquire: async () => ({ ok: true as const, value: 'fixture-lease' }), stop: async () => ({ ok: true as const, value: null }),
      context: async () => ({ ok: true as const, value: { report: { ipcam: { ipcam_dev: '1', liveview: { local: 'local' } } } } }) };
    media = new BambuMedia(config, { installDeviceCertificate: async () => {} } as unknown as BambuNative, monitor,
      { list: async () => [{ deviceId: 'fixture', name: 'Camera fixture', model: null, routes: [{ channel: 'lan', address: '192.0.2.1', revision: 'r1' }] }] },
      { read: async () => ({ version: 1, region: 'Others', clientId: 'fixture', lan: [{ deviceId: 'fixture', name: 'Camera fixture', model: '', ip: '192.0.2.1', accessCode: 'fixture-secret', revision: 'r1' }] }) },
      () => process.parentPort.postMessage({ type: 'changed', change: 'media' }), () => ({
        poll: () => ({ ready: true, format: 'jpeg' as const, width: 16, height: 16, samples: [{ flags: 1, time100ns: BigInt(Date.now()) * 10000n, bytes: new Uint8Array([255, 216, 255, 217]) }] }),
        close: () => appendFile(`${config.directory}/camera-closed`, 'closed\n'),
      }));
    process.parentPort.postMessage({ type: 'ready' });
  } else if (data.type === 'media') {
    void media.call(data.owner as string, data.request as BambuMediaRequest).then(value => process.parentPort.postMessage({ type: 'reply', id: data.id, value }));
  } else if (data.type === 'media-port') media.attach(data.owner as string, data.request as BambuMediaAttachment, ports[0]);
  else if (data.type === 'media-owner-close') void media.closeOwner(data.owner as string);
  else if (data.type === 'shutdown') void media.close().then(() => process.exit(0));
});
