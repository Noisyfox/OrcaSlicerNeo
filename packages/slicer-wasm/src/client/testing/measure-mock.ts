// Deterministic protocol fixture only; geometric correctness is established by
// the real WASM tests. Pointer coordinates choose between a synthetic edge and plane.
export function measureMock(hooks: {
  objects: () => { id: number; instanceIds: number[]; volumes: { id: number }[] }[];
  busy: () => boolean;
  allocate: (values: number[]) => number;
  free: (pointer: number) => void;
}) {
  let nextSession = 1, nextDisplay = 1, nextLease = 1;
  let session: any = null;
  const displays = new Map<string, any>();
  const leases = new Map<string, number>();
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const copy = <T>(value: T): T => structuredClone(value);
  const sameTarget = (a: any, b: any) => a.objectId === b.objectId && a.instanceId === b.instanceId && a.volumeId === b.volumeId;
  const exists = (target: any) => hooks.objects().some(object => object.id === target.objectId &&
    object.instanceIds.includes(target.instanceId) && object.volumes.some(volume => volume.id === target.volumeId));
  const requireSession = (request: any, checkTarget = true) => {
    if (!session || request.sessionId !== session.id || (checkTarget && request.targetRevision !== session.targetRevision))
      throw new Error('measurement session is stale');
    if (checkTarget && !session.targets.every(exists)) throw new Error('measurement target is stale');
  };
  const requireDisplay = (request: any) => {
    const display = displays.get(request.displayId);
    if (!display || display.sessionId !== session?.id || display.targetRevision !== session?.targetRevision)
      throw new Error('measurement display is stale');
    return display;
  };
  const planeId = (target: any) => `mp-${session.id.slice(3)}-${session.targetRevision}-${target.objectId}-${target.instanceId}-${target.volumeId}-0`;
  const withPlaneId = (feature: any, target: any) => feature.type === 'plane' ? { ...feature, resourceId: planeId(target) } : copy(feature);
  const selection = (entry: any) => entry ? { ...copy(entry), source: withPlaneId(entry.source, entry.target), value: withPlaneId(entry.value, entry.target) } : null;
  const status = () => {
    const first = selection(session.first), second = selection(session.second);
    return { ok: true, version: 1, sessionId: session.id, targetRevision: session.targetRevision, selectionRevision: session.selectionRevision,
      first, second, sameTarget: !!(first && (!second || sameTarget(first.target, second.target))),
      result: second ? { angle: null, infinite: null, strict: { value: 1, from: [0, 0, 0], to: [1, 0, 0] }, xyz: [1, 0, 0], showStrict: true, showXyz: true } : null };
  };
  const source = (request: any) => request.event.pointer[0] < request.event.viewport[0] + request.event.viewport[2] / 2
    ? { type: 'edge', start: [-10, 0, 20], end: [10, 0, 20], length: 20, center: null }
    : { type: 'plane', point: [0, 0, 20], normal: [0, 0, 1], resourceId: planeId(session.targets[0]), transform: identity };
  const item = (feature: any, kind = 'feature') => ({ target: copy(session.targets[0]), kind, source: copy(feature),
    value: kind === 'feature' ? copy(feature) : { type: 'point', point: [0, 0, 20] } });
  const markersFor = (hover: any, first: any, second: any) => {
    const values = [first, second].filter((entry: any) => entry?.value.type === 'point').map((entry: any) => selection(entry));
    if (hover?.feature.type === 'edge') values.push(item(hover.feature, 'midpoint'));
    return values.map((entry: any, index: number) => ({ index, position: entry.value.point, item: entry }));
  };
  const choose = (chosen: any) => {
    const equal = (a: any, b: any) => a && b && JSON.stringify(a) === JSON.stringify(b);
    const sameSource = (a: any, b: any) => a && b && sameTarget(a.target, b.target) && JSON.stringify(a.source) === JSON.stringify(b.source);
    if (!session.first) session.first = chosen;
    else if (equal(session.first, chosen)) { session.first = session.second; session.second = null; }
    else if (equal(session.second, chosen)) session.second = null;
    else if (sameSource(session.first, chosen) && chosen.kind !== 'pointOnFeature') session.first = chosen;
    else if (sameSource(session.second, chosen) && chosen.kind !== 'pointOnFeature') session.second = chosen;
    else session.second = chosen;
    session.selectionRevision++;
  };
  const reset = () => { session = null; displays.clear(); };
  const functions: Record<string, (request: any) => unknown> = {
    orc_measure_open(request) {
      if (!Array.isArray(request.targets) || !request.targets.length || !request.targets.every(exists) ||
          new Set(request.targets.map((t: any) => `${t.objectId}:${t.instanceId}:${t.volumeId}`)).size !== request.targets.length)
        throw new Error('invalid measurement target');
      reset(); session = { id: `ms-${nextSession++}`, targetRevision: 1, selectionRevision: 1,
        targets: copy(request.targets), first: null, second: null };
      return status();
    },
    orc_measure_read(request) { requireSession(request); return status(); },
    orc_measure_display(request) {
      requireSession(request);
      const feature = source(request), hover = { target: copy(session.targets[0]), originalFacet: 0, world: [0, 0, 20], local: [0, 0, 20], feature };
      const display = { ...status(), displayId: `md-${nextDisplay++}`, hover, markers: markersFor(hover, session.first, session.second) };
      displays.set(display.displayId, copy(display)); return display;
    },
    orc_measure_click(request) {
      requireSession(request);
      const display = request.displayId ? requireDisplay(request) : null;
      if (request.marker !== undefined && request.marker !== null && (!display || !display.markers[request.marker])) throw new Error('measurement marker is stale');
      const chosen = request.marker !== undefined && request.marker !== null ? copy(display.markers[request.marker].item)
        : item(source(request), request.shift ? 'pointOnFeature' : 'feature');
      choose(chosen); return { ...status(), outcome: 'selected' };
    },
    orc_measure_reset(request) {
      requireSession(request);
      const before = JSON.stringify([session.first, session.second]);
      if (request.action === 'first') { session.first = session.second; session.second = null; }
      else if (request.action === 'second') session.second = null;
      else if (request.action === 'all') { session.first = null; session.second = null; }
      else if (request.action === 'escape') { if (session.second) session.second = null; else if (session.first) session.first = null; else return { ...status(), outcome: 'close' }; }
      else throw new Error('invalid measurement reset action');
      const changed = before !== JSON.stringify([session.first, session.second]);
      if (changed) session.selectionRevision++;
      return { ...status(), outcome: changed ? 'selected' : 'unchanged' };
    },
    orc_measure_rebase(request) {
      requireSession(request); displays.clear(); session.targetRevision++; session.selectionRevision++;
      return status();
    },
    orc_measure_close(request) { requireSession(request, false); const id = session.id; reset(); return { ok: true, version: 1, sessionId: id }; },
    orc_measure_display_release(request) { if (displays.get(request.displayId)?.sessionId === request.sessionId) displays.delete(request.displayId); },
    orc_measure_plane(request) {
      requireSession(request);
      const display = requireDisplay(request);
      const selected = request.role === 'hover' ? display.hover : request.role === 'first' ? display.first : request.role === 'second' ? display.second : null;
      const feature = request.role === 'hover' ? selected?.feature : selected?.source;
      if (feature?.type !== 'plane' || feature.resourceId !== request.resourceId) throw new Error('measurement plane is stale');
      const vertex_ptr = hooks.allocate([0, 0, 0, 1, 0, 0, 0, 1, 0]);
      const leaseId = `ml-${nextLease++}`; leases.set(leaseId, vertex_ptr);
      return { ok: true, version: 1, sessionId: session.id, targetRevision: session.targetRevision, displayId: request.displayId,
        resourceId: request.resourceId, leaseId, vertex_ptr, vertexCount: 3, transform: identity };
    },
    orc_measure_plane_release(request) { const pointer = leases.get(request.leaseId); if (pointer) hooks.free(pointer); leases.delete(request.leaseId); },
  };
  return { reset, functions: Object.fromEntries(Object.entries(functions).map(([name, fn]) => [name, (text: string) => {
    try {
      const request = JSON.parse(text);
      if (request.version !== 1) throw new Error('invalid measurement protocol version');
      if (hooks.busy() && !['orc_measure_close', 'orc_measure_display_release', 'orc_measure_plane_release'].includes(name)) throw new Error('measurement history is busy');
      return fn(request);
    } catch (error) { return { error: (error as Error).message }; }
  }])) };
}
