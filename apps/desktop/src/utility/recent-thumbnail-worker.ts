import { parentPort } from 'node:worker_threads';
import type { RecentThumbnailRequest, RecentThumbnailResponse } from '../shared/recentThumbnailWorker';
import { RecentThumbnailCache } from './recentThumbnailCache';

const port = parentPort;
if (!port) throw new Error('Recent thumbnails require a Node Worker');
const cache = new RecentThumbnailCache();
port.on('message', (request: RecentThumbnailRequest) => {
  if (request.type === 'retain') cache.retain(request.paths);
  else void cache.get(request.path).then(url => {
    port.postMessage({ requestId: request.requestId, url } satisfies RecentThumbnailResponse);
  });
});
