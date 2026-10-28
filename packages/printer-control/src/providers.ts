/** Dispatch by provider-owned route identity; account/session state never participates. */
import type * as D from './domain';

const invalid = (message: string): D.PrinterError => ({ code: 'invalid-target', message });
class RoutingError extends Error {
  constructor(readonly detail: D.PrinterError) { super(detail.message); }
}
const errorOf = (error: unknown): D.PrinterError => error instanceof RoutingError ? error.detail : { code: 'transport', message: 'Provider catalogue unavailable' };
const key = (target: D.PrinterTarget) => JSON.stringify([target.printerId, target.routeId]);

export function createPrinterService(providers: readonly D.PrinterProvider[]): D.PrinterService {
  const registry = new Map(providers.map(provider => [provider.id, provider.printers]));
  if (registry.size !== providers.length) throw new Error('Duplicate printer provider');
  // Retain route ownership for outstanding operations after a device is forgotten.
  const owners = new Map<string, D.PrinterService>();
  async function collect(options?: D.ReadOptions): Promise<readonly D.SavedPrinter[]> {
    const lists = await Promise.all(providers.map(async provider => ({ provider, result: await provider.printers.listSaved(options) })));
    const devices = new Map<string, D.SavedPrinter>();
    const updates = new Map<string, D.PrinterService>();
    for (const { provider, result } of lists) {
      if (!result.ok) throw new RoutingError(result.error);
      for (const device of result.value) {
        if (devices.has(device.identity.id)) throw new RoutingError(invalid('Ambiguous printer identity'));
        devices.set(device.identity.id, device);
        for (const route of device.routes) {
          if (route.providerId !== provider.id || route.printerId !== device.identity.id) throw new RoutingError(invalid('Invalid provider route'));
          const routeKey = key({ printerId: device.identity.id, routeId: route.id });
          if (updates.has(routeKey) || (owners.has(routeKey) && owners.get(routeKey) !== provider.printers)) throw new RoutingError(invalid('Ambiguous route ownership'));
          updates.set(routeKey, provider.printers);
        }
      }
    }
    for (const [route, owner] of updates) owners.set(route, owner);
    return [...devices.values()];
  }
  async function owner(target: D.PrinterTarget): Promise<D.PrinterService> {
    if (owners.has(key(target))) return owners.get(key(target))!;
    await collect();
    const service = owners.get(key(target));
    if (!service) throw new RoutingError(invalid('Unknown printer route'));
    return service;
  }
  async function call<T>(target: D.PrinterTarget, work: (service: D.PrinterService) => Promise<D.Result<T>>): Promise<D.Result<T>> {
    let service: D.PrinterService;
    try { service = await owner(target); } catch (error) { return { ok: false, error: errorOf(error) }; }
    return work(service);
  }
  async function submit(target: D.PrinterTarget, work: (service: D.PrinterService) => Promise<D.Submission>): Promise<D.Submission> {
    let service: D.PrinterService;
    try { service = await owner(target); } catch (error) { return { kind: 'rejected', error: errorOf(error) }; }
    return work(service);
  }
  async function* stream<T>(target: D.PrinterTarget, work: (service: D.PrinterService) => AsyncIterable<T>): AsyncIterable<T> {
    let service: D.PrinterService;
    try { service = await owner(target); } catch (error) { throw new RoutingError(errorOf(error)); }
    yield* work(service);
  }
  async function providerCall<T>(id: D.Id<'provider'>, work: (service: D.PrinterService) => Promise<D.Result<T>>): Promise<D.Result<T>> {
    const service = registry.get(id);
    return service ? work(service) : { ok: false, error: invalid('Unknown provider') };
  }
  async function list<T>(work: (service: D.PrinterService) => Promise<D.Result<readonly T[]>>): Promise<D.Result<readonly T[]>> {
    const results = await Promise.all(providers.map(p => work(p.printers)));
    const failed = results.find(result => !result.ok);
    if (failed && !failed.ok) return failed;
    return { ok: true, value: results.flatMap(result => result.ok ? [...result.value] : []) };
  }
  return {
    listProviders: options => list(s => s.listProviders(options)),
    listTypes: options => list(s => s.listTypes(options)),
    listSaved: async options => { try { return { ok: true, value: await collect(options) }; } catch (error) { return { ok: false, error: errorOf(error) }; } },
    onSavedChanged: listener => { const stops = providers.map(p => p.printers.onSavedChanged(listener)); return () => stops.forEach(stop => stop()); },
    describe: (t, o) => call(t, s => s.describe(t, o)),
    add: async request => {
      const types = await list(s => s.listTypes());
      if (!types.ok) return types;
      const ids = request.routes.map(route => types.value.filter(type => type.id === route.typeId));
      if (ids.some(matches => matches.length !== 1) || !ids.length || ids.some(matches => matches[0].providerId !== ids[0][0].providerId)) return { ok: false, error: invalid('Routes must belong to one known provider') };
      return providerCall(ids[0][0].providerId, s => s.add(request));
    },
    updateRoute: r => call(r.target, s => s.updateRoute(r)),
    rename: (t, name) => call(t, s => s.rename(t, name)),
    forget: t => call(t, s => s.forget(t)),
    discover: async function* (id, scope, options) {
      const service = registry.get(id);
      if (!service) { yield { type: 'failed', error: invalid('Unknown provider') }; return; }
      yield* service.discover(id, scope, options);
    },
    adopt: r => providerCall(r.candidate.providerId, s => s.adopt(r)),
    authorize: r => providerCall(r.candidate.providerId, s => s.authorize(r)),
    observations: { read: (r, o) => call(r.target, s => s.observations.read(r, o)), watch: (r, o) => stream(r.target, s => s.observations.watch(r, o)) },
    webInterfaces: { describe: (t, o) => call(t, s => s.webInterfaces.describe(t, o)), resolve: (r, o) => call(r.target, s => s.webInterfaces.resolve(r, o)) },
    submissions: {
      prepare: (r, o) => call(r.target, s => s.submissions.prepare(r, o)),
      submit: (r, a) => call(r.target, s => s.submissions.submit(r, a)),
      get: r => call(r, s => s.submissions.get(r)), cancel: r => call(r, s => s.submissions.cancel(r)),
      watch: (r, o) => stream(r, s => s.submissions.watch(r, o)),
    },
    controls: { evaluate: (t, c, o) => call(t, s => s.controls.evaluate(t, c, o)), submit: r => submit(r.target, s => s.controls.submit(r)) },
    operations: { get: (r, o) => call(r, s => s.operations.get(r, o)), find: (r, o) => call(r, s => s.operations.find(r, o)), watch: (r, o) => stream(r, s => s.operations.watch(r, o)), requestUploadCancellation: r => call(r, s => s.operations.requestUploadCancellation(r)) },
    files: {
      listStorages: (t, o) => call(t, s => s.files.listStorages(t, o)), list: (r, o) => call(r.target, s => s.files.list(r, o)),
      stat: (r, o) => call(r.file, s => s.files.stat(r, o)), listPreviews: (r, o) => call(r.file, s => s.files.listPreviews(r, o)),
      download: (r, o) => call(r.target.file, s => s.files.download(r, o)), upload: (r, source) => submit(r.target, s => s.files.upload(r, source)),
      watchChanges: (t, o) => stream(t, s => s.files.watchChanges(t, o)),
    },
    media: {
      readStream: (r, o) => stream(r.media, s => s.media.readStream(r, o)),
      readCurrentPrintPreview: (t, o) => call(t, s => s.media.readCurrentPrintPreview(t, o)),
      open: (r, o) => call(r.target, s => s.media.open(r, o)), watch: (r, o) => stream(r, s => s.media.watch(r, o)), renew: (r, o) => call(r, s => s.media.renew(r, o)),
      sendSignal: (r, signal) => call(r, s => s.media.sendSignal(r, signal)), readContent: (r, o) => call(r.media, s => s.media.readContent(r, o)),
      close: r => call(r, s => s.media.close(r)), captureSnapshot: (t, camera, o) => call(t, s => s.media.captureSnapshot(t, camera, o)),
    },
  };
}
