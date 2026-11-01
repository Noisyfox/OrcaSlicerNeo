import { readdir, readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

/** Type-only back-references also couple owners, even when erased at runtime. */
async function dependencyGraph() {
  const directory = new URL('.', import.meta.url);
  const files = (await readdir(directory)).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'));
  const graph = new Map<string, string[]>();
  await Promise.all(files.map(async file => {
    const source = await readFile(new URL(file, directory), 'utf8');
    const imports = [...source.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^;'\"]*?\sfrom\s*)?['\"](\.\/[^'\"]+)['\"]/g)]
      .map(match => `${match[1].slice(2)}.ts`).filter(dependency => files.includes(dependency));
    graph.set(file, imports);
  }));
  return graph;
}
function reachable(graph: Map<string, string[]>, file: string, seen = new Set<string>()): Set<string> {
  for (const dependency of graph.get(file) ?? []) {
    if (seen.has(dependency)) continue;
    seen.add(dependency); reachable(graph, dependency, seen);
  }
  return seen;
}
it('keeps Bambu production modules acyclic, including type-only imports', async () => {
  const graph = await dependencyGraph();
  const cycles = [...graph.keys()].filter(file => reachable(graph, file).has(file));
  expect(cycles).toEqual([]);
});
it('keeps protocol, resource, context and device-access foundations independent of feature composition', async () => {
  const graph = await dependencyGraph();
  const features = ['monitor.ts', 'commands.ts', 'recovery.ts', 'objectSkipping.ts'];
  for (const file of ['protocol.ts', 'printResources.ts', 'telemetry.ts', 'controlContext.ts', 'deviceAccess.ts']) {
    const dependencies = reachable(graph, file);
    expect(features.filter(feature => dependencies.has(feature)), file).toEqual([]);
  }
});
