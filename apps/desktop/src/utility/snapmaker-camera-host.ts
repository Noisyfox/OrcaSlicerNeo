import { normalizePrinterConfigurationDocument } from '@orca/printer-control';
import { isCameraRequest, isCameraAttachment } from '../shared/snapmakerCamera';
import { SnapmakerCameraRuntime, type CameraGrant } from './snapmaker/runtime';
import { cameraHttpTransport } from './snapmaker/http';

const runtime = new SnapmakerCameraRuntime({ http: cameraHttpTransport, sockets: { create: url => new WebSocket(url) } },
  () => process.parentPort.postMessage({ type: 'changed' }));
process.parentPort.on('message', event => {
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'configuration') {
    try { runtime.updateConfiguration(normalizePrinterConfigurationDocument(data.document)); } catch { /* Main supplies validated records. */ }
  } else if (data.type === 'call' && Number.isSafeInteger(data.id) && typeof data.owner === 'string' && isCameraRequest(data.request)) {
    void runtime.call(data.owner, data.request, data.grant as CameraGrant | undefined)
      .then(value => process.parentPort.postMessage({ type: 'reply', id: data.id, value }))
      .catch(() => process.parentPort.postMessage({ type: 'reply', id: data.id, value: { ok: false, error: { code: 'transport', message: 'Camera unavailable.' } } }));
  } else if (data.type === 'port' && typeof data.owner === 'string' && isCameraAttachment(data.request) && event.ports.length === 1) {
    runtime.connect(data.owner, data.request, event.ports[0]);
  } else if (data.type === 'owner-close' && typeof data.owner === 'string') {
    void runtime.closeOwner(data.owner);
  } else if (data.type === 'shutdown') {
    void runtime.dispose().finally(() => process.exit(0));
  }
});
process.parentPort.postMessage({ type: 'ready' });
