// Deterministic editing corpus derived from the checked-in two-slot 3MF.
// Subdivide each original triangle without changing its surface or placement.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readZipEntries, writeStoredZip } from '../packages/slicer-wasm/harness/native-3mf-parser.mjs';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(root, 'packages/slicer-wasm/fixtures/painted-facet/painted-facet-instances.3mf');
const outputDir = resolve(root, 'packages/slicer-wasm/.work/painting-benchmark/corpus');
const expectedSourceSha = '10471af07fd7a7c4090d2c56a89874c9fa37a492df2f17f2b78d492e76b3e503';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const source = await readFile(sourcePath);
if (sha(source) !== expectedSourceSha) throw new Error(`source fixture changed: ${sha(source)}`);
const entries = readZipEntries(source);
const modelEntry = entries.find((entry) => entry.name === '3D/3dmodel.model');
if (!modelEntry) throw new Error('source has no 3D model');
const model = new TextDecoder().decode(modelEntry.content);
const originalVertices = [...model.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)]
  .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
const originalTriangles = [...model.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"(?: paint_color="([^"]+)")?\/>/g)]
  .map((m) => ({ vertices: [Number(m[1]), Number(m[2]), Number(m[3])], paint: m[4] }));
if (originalVertices.length !== 8 || originalTriangles.length !== 12) throw new Error('unexpected source cube topology');
await mkdir(outputDir, { recursive: true });
const cases = [];
for (const divisions of [1, 4, 8, 16, 32]) {
  const vertices = [], triangles = [], indexes = new Map();
  const vertex = (coords) => {
    const key = coords.join(',');
    if (!indexes.has(key)) { indexes.set(key, vertices.length); vertices.push(coords); }
    return indexes.get(key);
  };
  for (const original of originalTriangles) {
    const [a, b, c] = original.vertices.map((id) => originalVertices[id]);
    const grid = [];
    for (let i = 0; i <= divisions; i++) {
      grid[i] = [];
      for (let j = 0; j <= divisions - i; j++) {
        grid[i][j] = vertex([0, 1, 2].map((k) => (a[k] * (divisions - i - j) + b[k] * i + c[k] * j) / divisions));
      }
    }
    for (let i = 0; i < divisions; i++) for (let j = 0; j < divisions - i; j++) {
      triangles.push({ vertices: [grid[i][j], grid[i + 1][j], grid[i][j + 1]], paint: original.paint });
      if (i + j + 1 < divisions) triangles.push({ vertices: [grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]], paint: original.paint });
    }
  }
  const vertexXml = vertices.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('');
  const triangleXml = triangles.map((t) => `<triangle v1="${t.vertices[0]}" v2="${t.vertices[1]}" v3="${t.vertices[2]}"${t.paint ? ` paint_color="${t.paint}"` : ''}/>`).join('');
  const nextModel = model.replace(/<vertices>[\s\S]*?<\/vertices>/, `<vertices>${vertexXml}</vertices>`)
    .replace(/<triangles>[\s\S]*?<\/triangles>/, `<triangles>${triangleXml}</triangles>`);
  const bytes = writeStoredZip(entries.map((entry) => entry.name === modelEntry.name
    ? { ...entry, content: new TextEncoder().encode(nextModel) } : entry));
  const path = resolve(outputDir, `cube-${triangles.length}-triangles.3mf`);
  await writeFile(path, bytes);
  cases.push({ id: `cube-${triangles.length}`, path, sha256: sha(bytes), bytes: bytes.length,
    originalTriangles: triangles.length, solidParts: 1, divisions, source: sourcePath });
  if (divisions === 8) {
    // Four coincident solid volumes hold original triangle count constant
    // against cube-3072 while increasing part traversal/selector ownership.
    const mesh = `<mesh><vertices>${vertexXml}</vertices><triangles>${triangleXml}</triangles></mesh>`;
    const components = [2, 3, 4, 5].map((id) => `<component objectid="${id}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`).join('');
    const objects = `<object id="1" type="model"><components>${components}</components></object>` +
      [2, 3, 4, 5].map((id) => `<object id="${id}" type="model">${mesh}</object>`).join('');
    const partModel = model.replace(/<object id="1" type="model"><mesh>[\s\S]*?<\/mesh><\/object>/, objects);
    if (partModel === model) throw new Error('could not create component object');
    const settingsEntry = entries.find((entry) => entry.name === 'Metadata/model_settings.config');
    const settings = new TextDecoder().decode(settingsEntry.content);
    const originalPart = settings.match(/<part id="1"[\s\S]*?<\/part>/)?.[0];
    if (!originalPart) throw new Error('source part metadata missing');
    const partSettings = settings.replace(originalPart,
      [2, 3, 4, 5].map((id) => originalPart.replace('part id="1"', `part id="${id}"`)).join(''));
    const partBytes = writeStoredZip(entries.map((entry) => entry.name === modelEntry.name
      ? { ...entry, content: new TextEncoder().encode(partModel) }
      : entry.name === settingsEntry.name ? { ...entry, content: new TextEncoder().encode(partSettings) } : entry));
    const partPath = resolve(outputDir, 'cube-3072-triangles-4-parts.3mf');
    await writeFile(partPath, partBytes);
    cases.push({ id: 'cube-3072-4parts', path: partPath, sha256: sha(partBytes), bytes: partBytes.length,
      originalTriangles: 3072, solidParts: 4, divisions: 8, coincidentParts: true, source: sourcePath });
  }
}
const fixed = [resolve(root, 'packages/slicer-wasm/fixtures/big-proj.3mf')];
for (const path of fixed) {
  const bytes = await readFile(path);
  cases.push({ id: 'big-project-fixed', path,
    sha256: sha(bytes), bytes: bytes.length, kind: 'fixed-project',
    acquisition: 'repository-tracked fixture packages/slicer-wasm/fixtures/big-proj.3mf; no external download' });
}
const manifest = { schemaVersion: 1, generator: 'scripts/painting-benchmark-corpus.mjs',
  sourceSha256: sha(source), sourceAcquisition: 'repository-tracked fixture packages/slicer-wasm/fixtures/painted-facet/painted-facet-instances.3mf', cases };
await writeFile(resolve(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest));
