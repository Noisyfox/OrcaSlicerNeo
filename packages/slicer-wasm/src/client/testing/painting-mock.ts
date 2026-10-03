// Deterministic protocol model for UI tests; native picking/topology are tested
// by the real WASM harness, never inferred from this one-triangle fixture.
export function paintingMock(hooks: {
  historySession: () => string | undefined;
  pending: (value: boolean) => void;
  objects: () => { id: number; instanceIds: number[]; volumes: { id: number; paintState?: number; supportState?: number; seamState?: number; fuzzyState?: number }[] }[];
  commit: (mutate: () => void, label: string) => unknown;
  history: () => unknown;
  allocate: (values: number[]) => number;
  free: (pointer: number) => void;
}) {
  let nextId = 1, nextStroke = 1, nextLease = 1;
  const leases = new Map<string, number[]>();
  let session: any = null;
  let before: number[] = [];
  let committed: number[] = [];
  const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const maxState = () => session.channel === 'mmu' ? 16 : session.channel === 'fuzzy' ? 1 : 2;
  const stateField = (channel: string): 'paintState' | 'supportState' | 'seamState' | 'fuzzyState' => {
    switch (channel) { case 'mmu': return 'paintState'; case 'support': return 'supportState'; case 'seam': return 'seamState'; case 'fuzzy': return 'fuzzyState'; default: throw new Error('invalid painting channel'); }
  };
  const validateTool = (tool: string) => {
    const tools = session.channel === 'mmu' ? ['circle','sphere','triangle','height','region','gap','eraseAll']
      : session.channel === 'support' ? ['circle','sphere','smartFill','gap','eraseAll','overhang']
      : session.channel === 'fuzzy' ? ['circle','sphere','triangle','smartFill','eraseAll'] : ['circle','sphere','eraseAll'];
    if (!tools.includes(tool)) throw new Error('painting tool unavailable for channel');
  };
  const require = (request: any, idle = false) => {
    if (!session || session.historySessionId !== hooks.historySession() || request.channel !== session.channel || request.sessionId !== session.id || request.revision !== session.revision) throw new Error('painting session is stale');
    if (idle && session.phase !== 'idle') throw new Error('painting stroke is busy');
  };
  const sync = () => {
    if (!session || session.phase !== 'idle') return;
    const object = hooks.objects().find(o => o.id === session.objectId);
    const states = object?.volumes.map(v => v[stateField(session.channel)] ?? 0) ?? [];
    if (JSON.stringify(states) !== JSON.stringify(committed)) {
      committed = states; session.states = [...states]; session.revision++;
      session.parts.forEach((part: any) => part.generation++);
    }
  };
  const metadata = () => ({ ok: true, version: 1, session: { ...session, candidate: session.candidate ? { revision: session.revision, selectedFacetCount: session.candidate === 'gap' ? 0 : 1,
    gapRegionCount: session.candidate === 'gap' ? 1 : 0, parts: session.parts.map((p: any, i: number) => ({ volumeId: p.volumeId,
      facetCounts: Array.from({ length: 17 }, (_, state) => +(state === session.states[i])) })) } : undefined, instanceTransform: identity,
    parts: session.parts.map((part: any, i: number) => ({ volumeId: part.volumeId, sourceTriangleCount: 1, annotationTimestamp: part.timestamp,
      volumeTransform: identity, facetCounts: Array.from({ length: 17 }, (_, state) => +(state === session.states[i])),
      draftResourceId: `pd-${session.channel}-${session.id.slice(3)}-${part.generation}-${part.volumeId}` })) } });
  const receipt = () => ({ ok: true, version: 1, channel: session.channel, sessionId: session.id, revision: session.revision, strokeId: session.strokeId,
    phase: session.phase, effective: session.states.some((state: number, i: number) => state !== before[i]),
    changedPartIds: session.parts.filter((_: any, i: number) => session.states[i] !== before[i]).map((part: any) => part.volumeId),
    hit: null, candidateRevision: session.candidate ? session.revision : null });
  const validateSettings = (request: any) => {
    const settings = request.settings ?? {};
    if ((settings.overhangAngle !== undefined || settings.restrictToOverhangs) && session.channel !== 'support') throw new Error('overhang settings are support-only');
    if (settings.overhangAngle !== undefined && settings.overhangAngle !== null && (!Number.isFinite(settings.overhangAngle) || settings.overhangAngle < 0 || settings.overhangAngle > 90)) throw new Error('invalid overhang angle');
    if (settings.restrictToOverhangs !== undefined && typeof settings.restrictToOverhangs !== 'boolean') throw new Error('invalid overhang restriction');
    if (settings.restrictToOverhangs && (settings.overhangAngle === undefined || settings.overhangAngle === null)) throw new Error('missing overhang angle');
    if (request.tool === 'smartFill' && settings.angle === null) throw new Error('Smart Fill requires an angle');
    const state = request.settings?.state ?? 1;
    if (!Number.isInteger(state) || state < 0 || state > maxState()) throw new Error('invalid painting state');
  };
  const apply = (request: any) => {
    validateSettings(request);
    const state = request.settings?.erase || request.tool === 'eraseAll' ? 0 : request.settings?.state ?? 1;
    if (session.states[0] !== state) { session.states[0] = state; session.parts[0].generation++; }
  };
  const finish = () => { session.phase = 'idle'; session.strokeId = null; session.candidate = false; before = [...session.states]; };
  const functions: Record<string, (request: any) => unknown> = {
    orc_painting_session_open(request) {
      stateField(request.channel);
      if (session && session.historySessionId !== hooks.historySession()) session = null;
      if (session || request.historySessionId !== hooks.historySession()) throw new Error('painting history session is stale or busy');
      const object = hooks.objects().find(o => o.id === request.objectId && o.instanceIds.includes(request.instanceId));
      if (!object) throw new Error('painting target unavailable');
      committed = object.volumes.map(v => v[stateField(request.channel)] ?? 0); before = [...committed];
      session = { channel: request.channel, id: `ps-${nextId++}`, historySessionId: request.historySessionId, objectId: request.objectId,
        instanceId: request.instanceId, revision: 1, phase: 'idle', strokeId: null, states: [...committed],
        parts: object.volumes.map(v => ({ volumeId: v.id, generation: 1, timestamp: 0 })) };
      return metadata();
    },
    orc_painting_session_read(request) { sync(); require(request.latest ? { ...request, revision: session?.revision } : request); return metadata(); },
    orc_painting_session_target(request) {
      require(request, true); const previous = session; session = null;
      try { const result: any = functions.orc_painting_session_open({ ...request, historySessionId: previous.historySessionId });
        session.id = previous.id; session.revision = previous.revision + 1; session.highlightRevision = previous.highlightRevision ? session.revision : 0; session.parts.forEach((part: any) => part.generation = session.revision); return metadata();
      } catch (error) { session = previous; throw error; }
    },
    orc_painting_session_close(request) { require(request, true); session = null; return { ok: true, version: 1, channel: request.channel }; },
    orc_painting_preview(request) { require(request, true); validateTool(request.tool); validateSettings(request); if (request.tool === 'overhang') { if (request.settings.overhangAngle === undefined) throw new Error('missing overhang angle'); session.highlightRevision = request.settings.overhangAngle === null ? 0 : session.revision + 1; } else session.candidate = request.tool; session.revision++; return { ...receipt(), ...(request.tool === 'overhang' ? { candidateRevision: null } : {}) }; },
    orc_painting_stroke_begin(request) {
      sync(); require(request, true); validateTool(request.tool); validateSettings(request); if (request.tool === 'overhang') throw new Error('overhang is preview-only'); before = [...session.states]; session.strokeId = `pst-${session.id.slice(3)}-${nextStroke++}`;
      session.candidate = false; session.phase = ['gap', 'eraseAll'].includes(request.tool) ? 'finished' : 'drawing'; apply(request); session.revision++; return receipt();
    },
    orc_painting_stroke_sample(request) { require(request); if (session.phase !== 'drawing' || request.strokeId !== session.strokeId) throw new Error('painting stroke stale'); apply(request); session.revision++; return receipt(); },
    orc_painting_stroke_finish(request) { require(request); if (session.phase !== 'drawing' || request.strokeId !== session.strokeId) throw new Error('painting stroke stale'); session.phase = 'finished'; session.revision++; return receipt(); },
    orc_painting_stroke_cancel(request) { require(request); session.states = [...before]; session.parts.forEach((p: any) => p.generation++); session.revision++; finish(); return receipt(); },
    orc_painting_stroke_commit(request) {
      require(request); if (session.phase === 'idle' || request.strokeId !== session.strokeId) throw new Error('painting stroke stale');
      if (request.event) apply(request);
      const effective = session.states.some((s: number, i: number) => s !== before[i]);
      if (effective) hooks.commit(() => {
        const object = hooks.objects().find(o => o.id === session.objectId)!;
        object.volumes.forEach((v, i) => { v[stateField(session.channel)] = session.states[i]; });
      }, session.channel === 'mmu' ? 'Paint' : session.channel === 'support' ? 'Paint Supports' : session.channel === 'seam' ? 'Paint Seam' : 'Paint Fuzzy Skin');
      if (effective) session.parts.forEach((part: any, i: number) => { if (session.states[i] !== before[i]) part.timestamp++; });
      committed = [...session.states]; session.revision++; finish();
      return { ...receipt(), committed: effective, affectedPlateIds: [], history: hooks.history() };
    },
    orc_painting_geometry(request) {
      require(request); const parts = metadata().session.parts.map((p: any) => ({ volumeId: p.volumeId, resourceId: p.draftResourceId }));
      const candidates = session.candidate ? [{ volumeId: parts[0].volumeId,
        resourceId: `pc-${session.channel}-${session.id.slice(3)}-${session.revision}-${parts[0].volumeId}${session.candidate === 'gap' ? '-0' : ''}`, kind: session.candidate }] : [];
      if (session.highlightRevision) candidates.push(...parts.map((part: any) => ({ volumeId: part.volumeId, resourceId: `${part.resourceId.replace(/^pd-/, 'ph-')}-${session.highlightRevision}`, kind: 'overhang' })));
      const resources = [...parts.map((part: any) => ({ ...part, kind: 'draft' })), ...candidates]
        .flatMap((part: any, i: number) => request.knownResourceIds?.includes(part.resourceId) ? [] : [{ ...part,
          vertex_ptr: hooks.allocate([0,0,0,0,0,1,1,0,0,0,0,1,0,1,0,0,0,1]), vertexCount: 3,
          groups: [[session.states[Math.min(i, session.states.length - 1)],0,3]],
          contour_ptr: part.kind === 'region' || part.kind === 'triangle' ? hooks.allocate([0,0,0,1,0,0,1,0,0,0,1,0,0,1,0,0,0,0]) : 0,
          contourVertexCount: part.kind === 'region' || part.kind === 'triangle' ? 6 : 0 }]);
      const leaseId = `pg-${nextLease++}`;
      leases.set(leaseId, resources.flatMap((resource: any) => [resource.vertex_ptr, resource.contour_ptr].filter(Boolean)));
      return { ok: true, version: 1, leaseId, channel: session.channel, sessionId: session.id, revision: session.revision, parts, candidates, resources };
    },
    orc_painting_geometry_release(request) {
      for (const pointer of leases.get(request.leaseId) ?? []) hooks.free(pointer);
      leases.delete(request.leaseId);
    },
    orc_painting_settle() { return { ok: true, version: 1, settledVersion: 0, projections: null }; },
  };
  return Object.fromEntries(Object.entries(functions).map(([name, fn]) => [name, (text: string) => {
    try { const request = JSON.parse(text); if (request.version !== 1) throw new Error('invalid painting version'); const result = fn(request); hooks.pending(!!session && session.phase !== 'idle'); return result; }
    catch (error) { return { error: (error as Error).message }; }
  }]));
}
