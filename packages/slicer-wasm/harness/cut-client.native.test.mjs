import { beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, fixtureProfileOptions, installProfilePackages } from './profile-installer.mjs';
import { buildPaintingChannelProject } from './painted-facet-fixture-builder.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';
import { createWorkerClient, startWorker } from '../src/client/worker.ts';

const artifact = process.env.ORCA_CUT_MODULE;
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {} };
const decoder = new TextDecoder();
const encoder = new TextEncoder();
function models(bytes) {
  return readZipEntries(bytes).filter(e => e.name.endsWith('.model')).map(e => decoder.decode(e.content)).join('\n');
}
function boundaries(xml) {
  let open = 0;
  for (const [, mesh] of xml.matchAll(/<mesh>([\s\S]*?)<\/mesh>/g)) {
    const edges = new Map();
    for (const triangle of mesh.matchAll(/<triangle\b[^>]*>/g)) {
      const ids = ['v1','v2','v3'].map(key => triangle[0].match(new RegExp(key + '="(\\d+)"'))[1]);
      for (let i = 0; i < 3; ++i) {
        const edge = [ids[i], ids[(i+1)%3]].sort().join(',');
        edges.set(edge, (edges.get(edge) ?? 0) + 1);
      }
    }
    open += [...edges.values()].filter(count => count === 1).length;
  }
  return open;
}
describe.skipIf(!artifact)('Cut on a real Worker protocol and WASM module', () => {
  let client;
  beforeAll(async () => {
    const module = await (await loadModuleFactory(resolve(artifact)))({ noInitialRun: true, print: () => {}, printErr: () => {} });
    await installProfilePackages(module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
    const ptr = Number(module.ccall('orc_init', 'number', ['string'], [fixtureProfileOptions(module)]));
    try { expect(JSON.parse(module.UTF8ToString(ptr)).ok).toBe(true); } finally { module._free(ptr); }
    let receive, reply;
    startWorker(async () => module, message => reply(message), listener => { receive = listener; });
    client = createWorkerClient({ post: message => receive(message), onMessage: listener => { reply = listener; } });
  }, 120_000);
  async function apply(request) {
    return (await client.runProjectHistoryTransaction('Cut', 'project', context, () => client.applyCut(request), context)).result;
  }
  async function requestFor(object) {
    return { revision: (await client.getHistoryStatus()).revision, objectId: object.id, instanceId: object.instances[1].id,
      center: [100, 100, 10], rotation: [1,0,0,0,1,0,0,0,1], upper: 'place', lower: 'keep',
      keepPainting: true, openEdges: 'ask', asParts: false };
  }
  it('returns closed section loops in plane coordinates and rejects an obsolete model revision', async () => {
    expect(await client.loadProject(await buildPaintingChannelProject())).toMatchObject({ ok: true });
    const request = await requestFor((await client.getModelStructure()).objects[0]);
    const section = await client.getCutSection(request);
    expect(section, section.error).toMatchObject({ ok: true, loops: [{ hole: false }] });
    expect(section.xy.length).toBe(section.loops[0].count * 2);
    expect(section.xy.every(Number.isFinite)).toBe(true);
    expect(await client.getCutSection({ ...request, center: [100,100,1000] })).toMatchObject({ ok: true, loops: [] });
    expect(await client.getCutSection({ ...request, revision: request.revision+1 })).toMatchObject({ ok: false });
  }, 120_000);
  it.each([true, false])('preserves cross-plate instances, history and 3MF with painting %s', async keepPainting => {
    expect(await client.loadProject(await buildPaintingChannelProject())).toMatchObject({ ok: true });
    const source = (await client.getModelStructure()).objects[0];
    const added = await client.addPlate();
    expect(added.ok).toBe(true);
    const second = added.plates[1];
    expect(await client.setInstanceOffset(0, 1, second.origin[0] + 100, second.origin[1] + 100, 10)).toMatchObject({ ok: true });
    const before = await client.recomputePlateMembership();
    expect(before.plates.map(p => p.instanceIds.length)).toEqual([1, 1]);
    await client.resetHistory(context);
    const request = { ...await requestFor(source), keepPainting };
    const tx = await client.beginHistory('Stale Cut', 'project', context);
    expect(await client.applyCut({ ...request, revision: request.revision + 1 })).toMatchObject({ ok: false });
    await client.abortHistory(tx);
    expect((await client.getModelStructure()).objects).toEqual([source]);
    const result = await apply({ ...request, revision: (await client.getHistoryStatus()).revision });
    expect(result, result.error).toMatchObject({ ok: true, changed: true });
    expect(result.plateSession.affectedPlateIds.sort()).toEqual(before.plates.map(p => p.plateId).sort());
    expect(result.plateSession.plates.map(p => p.instanceIds.length)).toEqual([2, 2]);
    const outputs = (await client.getModelStructure()).objects;
    expect(outputs.map(o => o.id)).toEqual(result.newObjectIds);
    expect(outputs.map(o => o.instanceCount)).toEqual([2,2]);
    expect((await client.undoHistory()).ok).toBe(true);
    expect((await client.getModelStructure()).objects).toEqual([source]);
    expect((await client.getPlateSessionSnapshot()).plates.map(p => p.instanceIds.length)).toEqual([1,1]);
    expect((await client.redoHistory()).ok).toBe(true);
    expect((await client.getModelStructure()).objects).toEqual(outputs);
    const saved = await client.exportProject();
    expect(saved.ok).toBe(true);
    const xml = models(saved.bytes);
    for (const attr of ['paint_color','paint_supports','paint_seam','paint_fuzzy_skin'])
      expect(xml.includes(attr + '="'), attr).toBe(keepPainting);
    expect(await client.loadProject(saved.bytes)).toMatchObject({ ok: true, objects: 2, instances: 4 });
    expect((await client.getPlateSessionSnapshot()).plates.map(p => p.instanceIds.length)).toEqual([2,2]);
  }, 120_000);
  it.each(['apply', 'repair'])('offers one open-edge choice and executes %s', async action => {
    const entries = readZipEntries(await buildPaintingChannelProject());
    const entry = entries.find(e => e.name === '3D/3dmodel.model');
    entry.content = encoder.encode(decoder.decode(entry.content).replace(/<triangle\b[^>]*\/>/, ''));
    expect(await client.loadProject(writeStoredZip(entries))).toMatchObject({ ok: true });
    const source = (await client.getModelStructure()).objects[0];
    const request = await requestFor(source);
    const before = await client.getHistoryStatus();
    expect(await apply(request)).toEqual({ ok: true, changed: false, warning: 'open_edges' });
    expect((await client.getModelStructure()).objects).toEqual([source]);
    expect((await client.getHistoryStatus()).revision).toBe(before.revision);
    const applied = await apply({ ...request, openEdges: action });
    expect(applied, applied.error).toMatchObject({ ok: true, changed: true });
    const xml = models((await client.exportProject()).bytes);
    expect(xml).toContain('<mesh>');
    expect(boundaries(xml) > 0).toBe(action === 'apply');
    expect((await client.undoHistory()).ok).toBe(true);
    expect((await client.getModelStructure()).objects).toEqual([source]);
  }, 120_000);
});
