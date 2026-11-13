import multicastDns from 'multicast-dns';
import { isIP } from 'node:net';
import type { WebContents } from 'electron';
import type { MdnsService } from '@orca/platform-contract';

type RecordType = 'PTR' | 'SRV' | 'TXT' | 'A' | 'AAAA';
interface WireRecord { name: string; type: string; ttl?: number; data?: unknown; flush?: boolean }
export interface MdnsPacket { answers?: readonly WireRecord[]; additionals?: readonly WireRecord[] }
export interface MdnsSocket {
  query(questions: { name: string; type: RecordType }[]): void;
  destroy(): void;
}
type SocketFactory = (receive: (packet: MdnsPacket) => void, failed: () => void) => MdnsSocket;
interface CachedRecord { name: string; type: RecordType; data: unknown; expiresAtMs: number }
interface Browse {
  owner: WebContents; serviceType: string; socket: MdnsSocket; records: Map<string, CachedRecord>;
  failed: boolean; lastQuery: number; lastResolve: number;
}
const dnsName = (name: string) => `${name.replace(/\.$/, '').toLowerCase()}.`;
const defaultSocket: SocketFactory = (receive, failed) => {
  const socket = multicastDns({ reuseAddr: true });
  socket.on('response', receive);
  socket.on('error', failed);
  return { query: questions => socket.query(questions), destroy: () => socket.destroy() };
};

/** Generic, renderer-owned DNS-SD browser. The DNS library only supplies wire I/O;
 * this cache merges split packets, refreshes TTLs and withdraws goodbye/expired records. */
export class MdnsHost {
  private readonly browsers = new Map<string, Browse>();
  private readonly owners = new Map<WebContents, () => void>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly socketFactory: SocketFactory = defaultSocket, private readonly now = Date.now) {}

  start(owner: WebContents, id: unknown, serviceType: unknown): void {
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id) || typeof serviceType !== 'string'
      || !/^_[a-z0-9-]{1,63}\._(?:tcp|udp)\.local\.$/i.test(serviceType)) throw new Error('Invalid mDNS browse request.');
    if (this.browsers.has(id) || this.browsers.size >= 16 || [...this.browsers.values()].filter(b => b.owner === owner).length >= 4)
      throw new Error('Too many mDNS browse requests.');
    const browse: Browse = { owner, serviceType: dnsName(serviceType), records: new Map(), failed: false,
      lastQuery: this.now(), lastResolve: -Infinity, socket: undefined as unknown as MdnsSocket };
    try {
      browse.socket = this.socketFactory(packet => this.receive(browse, packet), () => { browse.failed = true; });
      this.browsers.set(id, browse);
      if (!this.owners.has(owner)) {
        const cleanup = () => { for (const [key, value] of this.browsers) if (value.owner === owner) this.stop(owner, key); };
        const navigating = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean) => { if (mainFrame) cleanup(); };
        this.owners.set(owner, () => {
          owner.removeListener('destroyed', cleanup);
          owner.removeListener('render-process-gone', cleanup);
          owner.removeListener('did-start-navigation', navigating);
        });
        owner.once('destroyed', cleanup);
        owner.on('render-process-gone', cleanup);
        owner.on('did-start-navigation', navigating);
      }
      browse.socket.query([{ name: browse.serviceType, type: 'PTR' }]);
      this.timer ??= setInterval(() => this.tick(), 1000);
    } catch {
      this.stop(owner, id);
      throw new Error('mDNS discovery could not start.');
    }
  }
  snapshot(owner: WebContents, id: unknown): MdnsService[] {
    const browse = typeof id === 'string' ? this.browsers.get(id) : undefined;
    if (!browse || browse.owner !== owner) throw new Error('Unknown mDNS browse request.');
    if (browse.failed) throw new Error('mDNS discovery is unavailable. Check local network permissions.');
    this.expire(browse);
    const records = [...browse.records.values()];
    const result: MdnsService[] = [];
    for (const ptr of records.filter(r => r.type === 'PTR' && r.name === browse.serviceType)) {
      const fqdn = dnsName(ptr.data as string);
      if (!fqdn.endsWith(`.${browse.serviceType}`)) continue;
      const srv = records.find(r => r.type === 'SRV' && r.name === fqdn);
      const txt = records.find(r => r.type === 'TXT' && r.name === fqdn);
      if (!srv) continue;
      const { target, port } = srv.data as { target: string; port: number };
      const addresses = records.filter(r => (r.type === 'A' || r.type === 'AAAA') && r.name === dnsName(target));
      if (!addresses.length) continue;
      result.push({ id: fqdn, serviceType: browse.serviceType, name: (ptr.data as string).slice(0, -browse.serviceType.length),
        host: dnsName(target), port, addresses: [...new Set(addresses.map(r => r.data as string))].sort(),
        txt: txt ? txt.data as Record<string, string> : {},
        expiresAtMs: Math.min(ptr.expiresAtMs, srv.expiresAtMs, txt?.expiresAtMs ?? Infinity, ...addresses.map(r => r.expiresAtMs)) });
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }
  stop(owner: WebContents, id: unknown): void {
    const browse = typeof id === 'string' ? this.browsers.get(id) : undefined;
    if (!browse || browse.owner !== owner) return;
    this.browsers.delete(id as string);
    browse.socket.destroy();
    if (![...this.browsers.values()].some(b => b.owner === owner)) {
      this.owners.get(owner)?.();
      this.owners.delete(owner);
    }
    if (!this.browsers.size) { clearInterval(this.timer); this.timer = undefined; }
  }
  close(): void { for (const [id, browse] of this.browsers) this.stop(browse.owner, id); }
  private expire(browse: Browse): void {
    for (const [key, record] of browse.records) if (record.expiresAtMs <= this.now()) browse.records.delete(key);
  }
  private tick(): void {
    for (const browse of this.browsers.values()) {
      this.expire(browse);
      if (!browse.failed && this.now() - browse.lastQuery >= 5000) {
        browse.lastQuery = this.now();
        const questions: { name: string; type: RecordType }[] = [{ name: browse.serviceType, type: 'PTR' }];
        for (const record of browse.records.values()) {
          if (record.type === 'PTR' && record.name === browse.serviceType) {
            const name = dnsName(record.data as string);
            questions.push({ name, type: 'SRV' }, { name, type: 'TXT' });
            const srv = [...browse.records.values()].find(r => r.name === name && r.type === 'SRV');
            if (srv) {
              const host = (srv.data as { target: string }).target;
              questions.push({ name: host, type: 'A' }, { name: host, type: 'AAAA' });
            }
          }
        }
        try { browse.socket.query(questions.slice(0, 64)); } catch { browse.failed = true; }
      }
    }
  }
  private receive(browse: Browse, packet: MdnsPacket): void {
    const flushed = new Set<string>();
    for (const wire of [...(packet.answers ?? []), ...(packet.additionals ?? [])].slice(0, 1024)) {
      if (typeof wire.name !== 'string' || wire.name.length > 255 || typeof wire.ttl !== 'number' || !Number.isFinite(wire.ttl) || wire.ttl < 0) continue;
      const name = dnsName(wire.name), type = wire.type as RecordType;
      let data: unknown = wire.data;
      if (type === 'PTR') { if (typeof data !== 'string' || data.length > 255) continue; data = data.replace(/\.$/, ''); }
      else if (type === 'A' || type === 'AAAA') { if (typeof data !== 'string' || !isIP(data)) continue; }
      else if (type === 'SRV') {
        const srv = data as { target?: unknown; port?: unknown } | null;
        if (!srv || typeof srv.target !== 'string' || srv.target.length > 255 || !Number.isInteger(srv.port) || Number(srv.port) < 1 || Number(srv.port) > 65535) continue;
        data = { target: dnsName(srv.target), port: srv.port };
      } else if (type === 'TXT') {
        if (!Array.isArray(data)) continue;
        const txt: Record<string, string> = Object.create(null);
        for (const item of data.slice(0, 128)) {
          if (!(item instanceof Uint8Array)) continue;
          const text = Buffer.from(item).toString('utf8'), index = text.indexOf('=');
          const key = (index < 0 ? text : text.slice(0, index)).toLowerCase();
          if (key && !Object.hasOwn(txt, key)) txt[key] = index < 0 ? '' : text.slice(index + 1);
        }
        data = txt;
      } else continue;
      const group = `${name}/${type}`;
      const unique = type === 'SRV' || type === 'TXT';
      if ((unique || wire.flush) && !flushed.has(group) && wire.ttl > 0) {
        for (const [key, old] of browse.records) if (old.name === name && old.type === type) browse.records.delete(key);
        flushed.add(group);
      }
      const key = unique ? group : `${group}/${JSON.stringify(data).toLowerCase()}`;
      if (wire.ttl === 0) browse.records.delete(key);
      else browse.records.set(key, { name, type, data, expiresAtMs: this.now() + wire.ttl * 1000 });
    }
    this.expire(browse);
    while (browse.records.size > 2048) browse.records.delete(browse.records.keys().next().value!);
    // DNS-SD records may arrive separately. Resolve missing SRV/TXT and host addresses.
    const records = [...browse.records.values()];
    const questions: { name: string; type: RecordType }[] = [];
    for (const ptr of records.filter(r => r.type === 'PTR' && r.name === browse.serviceType)) {
      const name = dnsName(ptr.data as string);
      for (const type of ['SRV', 'TXT'] as const) if (!records.some(r => r.name === name && r.type === type)) questions.push({ name, type });
      const srv = records.find(r => r.name === name && r.type === 'SRV');
      if (srv) {
        const host = (srv.data as { target: string }).target;
        if (!records.some(r => r.name === host && (r.type === 'A' || r.type === 'AAAA'))) questions.push({ name: host, type: 'A' }, { name: host, type: 'AAAA' });
      }
    }
    // At most one follow-up batch per second; unrelated multicast traffic cannot flood queries.
    if (questions.length && this.now() - browse.lastResolve >= 1000) {
      browse.lastResolve = this.now();
      try { browse.socket.query(questions.slice(0, 64)); } catch { browse.failed = true; }
    }
  }
}
