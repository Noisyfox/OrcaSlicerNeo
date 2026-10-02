import { expect, it } from 'vitest';
import type { PaintingSessionMetadata, ModelObjectStructure, NativeScopedConfigSnapshot } from '@slicer/client';
import { fuzzyConfigurationProjection, fuzzyModeKnown, fuzzyModeLabel } from './fuzzyConfiguration';
const session = { objectId: 10, parts: [{volumeId:20}, {volumeId:21}] } as unknown as PaintingSessionMetadata;
const metadata = {fuzzy_skin:{type:'enum' as const,scopes:['project','object','part'] as const}};
const structure = [{id:10,volumes:[{id:22,type:'parameter_modifier'}]}] as ModelObjectStructure[];
it('projects each part/modifier through native preset, Project, object and part inheritance',()=>{
  const snapshot:NativeScopedConfigSnapshot={project:{},objects:{},parts:{},plates:{}};
  const resolve=()=>fuzzyConfigurationProjection(session,metadata,{fuzzy_skin:'disabled_fuzzy'},snapshot,structure).map(p=>[p.volumeId,p.modifier,p.field?.value,p.field?.source]);
  expect(resolve().map(p=>p.slice(2))).toEqual(Array(3).fill(['disabled_fuzzy','preset']));
  (snapshot.project as Record<string,string>).fuzzy_skin='all'; expect(resolve().map(p=>p.slice(2))).toEqual(Array(3).fill(['all','project']));
  (snapshot.objects as Record<string,Record<string,string>>)['10']={fuzzy_skin:'none'};
  (snapshot.parts as Record<string,Record<string,string>>)['21']={fuzzy_skin:'disabled_fuzzy'};
  (snapshot.parts as Record<string,Record<string,string>>)['22']={fuzzy_skin:'external'};
  expect(resolve()).toEqual([[20,false,'none','object'],[21,false,'disabled_fuzzy','part'],[22,true,'external','part']]);
});
it('does not assume an unavailable native configuration is disabled or enabled',()=>{
  expect(fuzzyConfigurationProjection(session,null,{}, {project:{},objects:{},parts:{},plates:{}})).toEqual([]);
});

it('recognizes and labels all pinned native modes while rejecting incomplete projection',()=>{
  for(const [mode,label] of Object.entries({none:'Painted only',external:'Contour',hole:'Hole',all:'Contour and hole',allwalls:'All walls',disabled_fuzzy:'Disabled'})){
    expect(fuzzyModeKnown(mode)).toBe(true);expect(fuzzyModeLabel(mode,null)).toBe(label);
  }
  expect(fuzzyModeKnown('')).toBe(false);expect(fuzzyModeKnown('unsupported')).toBe(false);
  const fields=fuzzyConfigurationProjection(session,metadata,{}, {project:{},objects:{},parts:{},plates:{}});expect(fields.every(p=>!fuzzyModeKnown(p.field?.value))).toBe(true);
});
