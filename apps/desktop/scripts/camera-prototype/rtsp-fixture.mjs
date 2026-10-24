// AGPL-3.0. Loopback-only, unauthenticated RTSP fixture; not a printer server.
import { createServer } from 'node:tls';

export function annexBNals(bytes) {
  const starts = [];
  for (let i = 0; i < bytes.length - 2; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      starts.push({ start: i > 0 && bytes[i - 1] === 0 ? i - 1 : i, data: i + 3 }); i += 2;
    }
  }
  return starts.map((entry, i) => Buffer.from(bytes.subarray(entry.data, starts[i + 1]?.start ?? bytes.length)));
}

export async function startRtspFixture(frames, { fps, jitter = false, tls }) {
  const parameters = annexBNals(Buffer.from(frames[0].bytes));
  const sps = parameters.find(n => (n[0] & 31) === 7), pps = parameters.find(n => (n[0] & 31) === 8);
  if (!sps || !pps) throw new Error('Fixture needs in-band SPS/PPS');
  const sockets = new Set(), timers = new Set(), sent = [];
  let seq = 0, failure = null;
  const server = createServer(tls, socket => {
    sockets.add(socket); socket.setNoDelay(true);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', error => { failure = error; });
    let pending = Buffer.alloc(0), started = false;
    const sendNal = (nal, timestamp, marker) => {
      const payloads = [];
      if (nal.length <= 1200) payloads.push(nal);
      else for (let offset = 1; offset < nal.length; offset += 1198) {
        const end = Math.min(offset + 1198, nal.length);
        payloads.push(Buffer.concat([Buffer.from([(nal[0] & 0xe0) | 28,
          (nal[0] & 31) | (offset === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0)]), nal.subarray(offset, end)]));
      }
      payloads.forEach((payload, i) => {
        const header = Buffer.alloc(16); header[0] = 36; header[1] = 0;
        header.writeUInt16BE(12 + payload.length, 2);
        header[4] = 0x80; header[5] = 96 | (marker && i === payloads.length - 1 ? 0x80 : 0);
        header.writeUInt16BE(seq++ & 0xffff, 6); header.writeUInt32BE(timestamp >>> 0, 8); header.writeUInt32BE(42, 12);
        socket.write(Buffer.concat([header, payload]));
      });
    };
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]);
      while (pending.length) {
        // Drain receiver RTCP; the fixture reports only the media send times.
        if (pending[0] === 36) {
          if (pending.length < 4 || pending.length < 4 + pending.readUInt16BE(2)) break;
          pending = pending.subarray(4 + pending.readUInt16BE(2)); continue;
        }
        const end = pending.indexOf('\r\n\r\n'); if (end < 0) break;
        const text = pending.subarray(0, end).toString();
        const length = Number(/Content-Length:\s*(\d+)/i.exec(text)?.[1] ?? 0);
        if (pending.length < end + 4 + length) break;
        pending = pending.subarray(end + 4 + length);
        const method = text.split(' ')[0], cseq = /CSeq:\s*(\d+)/i.exec(text)?.[1];
        let body = '', headers = '';
        if (method === 'DESCRIBE') {
          body = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=Neo synthetic camera', 'c=IN IP4 127.0.0.1', 't=0 0',
            'a=control:*', 'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H264/90000',
            `a=fmtp:96 packetization-mode=1;profile-level-id=${sps.subarray(1, 4).toString('hex')};sprop-parameter-sets=${sps.toString('base64')},${pps.toString('base64')}`,
            'a=control:trackID=0', ''].join('\r\n');
          headers = `Content-Type: application/sdp\r\nContent-Base: rtsp://127.0.0.1:${server.address().port}/streaming/live/1/\r\n`;
        } else if (method === 'SETUP') headers = 'Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n';
        socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nSession: neo-fixture;timeout=30\r\n${headers}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
        if (method === 'PLAY' && !started) {
          started = true;
          frames.forEach((frame, i) => {
            const delay = 150 + i * 1000 / fps + (jitter ? [0, 8, -6, 12, -4][i % 5] : 0);
            const timer = setTimeout(() => {
              timers.delete(timer); if (socket.destroyed) return;
              const nals = annexBNals(Buffer.from(frame.bytes)).filter(n => ![7, 8].includes(n[0] & 31));
              sent.push({ index: i, atMs: Date.now(), rtpTimestamp: Math.round(i * 90000 / fps) });
              nals.forEach((nal, n) => sendNal(nal, Math.round(i * 90000 / fps), n === nals.length - 1));
            }, delay);
            timers.add(timer);
          });
        }
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `bambu:///rtsps___127.0.0.1:${server.address().port}/streaming/live/1?proto=rtsps&device=neo-camera-fixture`, sent,
    get failure() { return failure; },
    async close() { for (const timer of timers) clearTimeout(timer); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
