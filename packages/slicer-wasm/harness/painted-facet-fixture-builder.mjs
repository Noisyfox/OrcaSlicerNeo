// Deterministic project fixture for Preview's imported painted-model path.
// It starts from the checked-in two-slot reader project, adds native split
// facet metadata, and duplicates the placed model instance on its plate.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';

const here = import.meta.dirname;
const fixturePath = resolve(here, '../fixtures/painted-facet/painted-facet-instances.3mf');
const sourcePath = resolve(here, '../fixtures/multi-filament/independent-reader-basic.3mf');
const sourceSha256 = 'd15f956c50e70d1368033528e49e835330e74cd007196f66a094277a09a91785';
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function replaceOnce(source, expression, replacement, context) {
  const result = source.replace(expression, replacement);
  if (result === source) throw new Error(`painted facet fixture could not update ${context}`);
  return result;
}

export async function buildPaintedFacetProject() {
  const source = new Uint8Array(await readFile(sourcePath));
  const digest = createHash('sha256').update(source).digest('hex');
  if (digest !== sourceSha256)
    throw new Error(`painted facet fixture source changed: expected ${sourceSha256}, got ${digest}`);

  const entries = readZipEntries(source);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const modelEntry = byName.get('3D/3dmodel.model');
  const settingsEntry = byName.get('Metadata/model_settings.config');
  if (!modelEntry || !settingsEntry) throw new Error('base project is missing model/settings entries');

  const sourceModel = decoder.decode(modelEntry.content);
  const states = ['401', '', '4', '8', '0C', '1C', '4', '8', '0C', '1C', '4', '8'];
  let triangle = 0;
  let model = sourceModel.replace(/<triangle\b[^>]*\/>/g, (original) => {
    const state = states[triangle++];
    return state ? original.replace('/>', ` paint_color="${state}"/>`) : original;
  });
  if (triangle !== states.length)
    throw new Error(`expected ${states.length} cube facets, found ${triangle}`);
  model = replaceOnce(model, /<build>([\s\S]*?)<\/build>/,
    // The fixture's Bambu H2D profile uses positive plate coordinates; keep
    // both instances inside its printable area so the imported project can be
    // sliced after the integration test's transform/Undo/Redo round-trip.
    '<build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 100 10" printable="1" auto_drop="1"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 130 100 10" printable="1" auto_drop="1"/></build>',
    'two build items');

  let settings = decoder.decode(settingsEntry.content);
  settings = settings.replaceAll('Two Material Cube', 'Painted Facet Cube')
    .replaceAll('independent-reader-basic.3mf', 'painted-facet-instances.3mf')
    .replaceAll('Independent Two Material Plate', 'Painted Facet Plate');
  settings = replaceOnce(settings,
    '<model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="1"/></model_instance>',
    '<model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="1"/></model_instance><model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="1"/><metadata key="identify_id" value="2"/></model_instance>',
    'second native model instance');

  // BBS imports may materialize native options which are absent from older
  // project metadata using their default single-slot shape. Keep every slot
  // array explicit so real project mutations (including the filament colour
  // edit used by the Preview integration test) pass the same validation as a
  // project saved by the current application.
  const projectEntry = byName.get('Metadata/project_settings.config');
  if (!projectEntry) throw new Error('base project is missing project settings');
  const project = JSON.parse(decoder.decode(projectEntry.content));
  Object.assign(project, {
    filament_multi_colour: ['', ''],
    filament_colour_type: ['RGB', 'RGB'],
    filament_map: ['1', '1'],
    filament_volume_map: ['0', '0'],
    filament_nozzle_map: ['0', '0'],
    filament_map_2: ['1', '1'],
    filament_self_index: ['0', '0'],
    filament_extruder_variant: ['0', '0'],
  });

  const result = writeStoredZip(entries.map((entry) => {
    if (entry.name === modelEntry.name) return { ...entry, content: encoder.encode(model) };
    if (entry.name === settingsEntry.name) return { ...entry, content: encoder.encode(settings) };
    if (entry.name === projectEntry.name) return { ...entry, content: encoder.encode(JSON.stringify(project)) };
    return entry;
  }));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const bytes = await buildPaintedFacetProject();
  await mkdir(resolve(fixturePath, '..'), { recursive: true });
  await writeFile(fixturePath, bytes);
  console.log(`wrote ${fixturePath} (${bytes.byteLength} bytes; sha256 ${createHash('sha256').update(bytes).digest('hex')})`);
}
