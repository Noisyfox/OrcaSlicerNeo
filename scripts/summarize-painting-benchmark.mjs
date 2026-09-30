import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const indexPath = resolve(process.argv[2] ?? resolve(root, 'packages/slicer-wasm/.work/painting-benchmark/results/index.json'));
const index = JSON.parse(await readFile(indexPath, 'utf8'));
const percentile = (values, fraction) => values.length
  ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;
const stats = (values) => ({ count: values.length, min: values.length ? Math.min(...values) : null,
  median: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length ? Math.max(...values) : null });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const flatten = (value) => Array.isArray(value) ? value : value ? [value] : [];
function workingSet(sample, host) {
  if (host === 'electron') return flatten(sample.metrics).reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0) * 1024, 0);
  return flatten(sample.processes).reduce((sum, m) => sum + (m.WorkingSet64 ?? 0), 0);
}
function terminal(input, phases, calls, frames, phaseName, nextInputAt) {
  const lifecycle = calls.find((call) => call.at > input.at
    && ['openPaintingSession', 'closePaintingSession'].includes(call.name));
  const receiptUntil = Math.min(nextInputAt ?? Infinity, lifecycle?.at ?? Infinity);
  const name = phaseName === 'ending' ? 'commitPaintingStroke' : 'cancelPaintingStroke';
  const receipt = calls.find((call) => call.name === name && call.at >= input.at && call.at < receiptUntil);
  const nextTerminal = receipt && calls.find((call) => call.at > receipt.at
    && ['commitPaintingStroke', 'cancelPaintingStroke'].includes(call.name));
  const until = Math.min(lifecycle?.at ?? Infinity, nextTerminal?.at ?? Infinity);
  const selected = receipt && phases.find((phase) => phase.phase === phaseName
    && phase.at >= input.at && phase.at <= receipt.at + receipt.ms);
  const idle = selected && phases.find((phase) => phase.phase === 'idle'
    && phase.at > selected.at && phase.at < until);
  const geometry = receipt && calls.find((call) => call.name === 'getPaintingGeometry'
    && call.at >= receipt.at && call.at < until && call.revision === receipt.revision);
  const visible = geometry && frames.find((frame) => frame.at >= geometry.at + geometry.ms
    && frame.at < until && frame.revision === receipt.revision);
  return { inputAt: input.at, status: !receipt ? 'no_terminal_receipt' : !selected ? 'no_terminal_phase'
    : !idle ? 'no_idle_phase' : !geometry ? 'no_geometry_receipt'
      : !visible ? 'no_revision_frame' : 'matched',
    inputToIdleMs: idle ? idle.at - input.at : null,
    inputToVisibleMs: visible ? visible.at - input.at : null,
    visibleRevision: receipt?.revision ?? null, phaseAt: selected?.at ?? null,
    receiptAt: receipt?.at ?? null, nextInputAt,
    boundaryAt: Number.isFinite(until) ? until : null };
}
const rows = [];
for (const sample of index.samples) {
  const rawPath = resolve(dirname(indexPath), sample.file);
  const stored = await readFile(rawPath);
  const bytes = rawPath.endsWith('.gz') ? gunzipSync(stored) : stored;
  const r = JSON.parse(bytes);
  const performance = r.beforeClose;
  const native = performance.calls.filter((call) => call.native).at(-1)?.native ?? null;
  const geometry = performance.calls.filter((call) => call.name === 'getPaintingGeometry');
  const reopenedGeometry = r.reopened?.beforeClose?.calls?.filter((call) => call.name === 'getPaintingGeometry') ?? [];
  const badLeases = [...geometry, ...reopenedGeometry].filter((call) => call.native
    && (call.native.previousGeometryLeases !== 0 || call.native.currentGeometryLeases !== 1));
  const frameTimes = performance.frames;
  const intervals = frameTimes.slice(1).map((frame, i) => frame.at - frameTimes[i].at).filter((ms) => ms > 0);
  const final = r.afterClose.resources;
  const reopenedFinal = r.reopened?.afterClose;
  const terminalInputs = performance.inputs.filter((input) => ['pointerup', 'escape'].includes(input.kind));
  const nextAt = (input) => terminalInputs.find((later) => later.at > input.at)?.at ?? null;
  const normalTerminals = terminalInputs.filter((input) => input.kind === 'pointerup')
    .map((input) => terminal(input, performance.phases, performance.calls, performance.frames, 'ending', nextAt(input)));
  const escapeTerminals = terminalInputs.filter((input) => input.kind === 'escape')
    .map((input) => terminal(input, performance.phases, performance.calls, performance.frames, 'cancelling', nextAt(input)));
  for (const group of [normalTerminals, escapeTerminals]) {
    const seen = new Set();
    for (const item of group) if (item.receiptAt !== null) {
      if (seen.has(item.receiptAt)) item.status = 'duplicate_terminal_input';
      seen.add(item.receiptAt);
    }
  }
  const rpc = Object.fromEntries([...new Set(performance.calls.map((call) => call.name))]
    .map((name) => [name, stats(performance.calls.filter((call) => call.name === name).map((call) => call.ms))]));
  const facets = Object.fromEntries(Object.entries(r.facets).map(([name, parts]) => [name,
    parts?.map((part) => ({ volumeId: part.volumeId, originalTriangles: part.sourceTriangleCount,
      selectorFacets: part.facetCounts.reduce((sum, count) => sum + count, 0) })) ?? null]));
  rows.push({ host: sample.host, caseId: sample.caseId, trial: sample.trial, rawFile: sample.file, rawSha256: hash(bytes),
    browserEnvironment: r.browserEnvironment, browserVersion: r.browserVersion ?? r.electronVersion,
    automationWallMs: r.automationWallMs, rpcMs: rpc, nativeCumulative: native,
    normalRelease: normalTerminals, escape: escapeTerminals,
    closeInputToDisposedMs: r.afterClose.inputToDisposedMs,
    recloseInputToDisposedMs: r.reopened?.inputToDisposedMs ?? null,
    renderFrameIntervalMs: stats(intervals), glBufferSubmission: {
      calls: performance.glUploads.length, bytes: performance.glUploads.reduce((sum, upload) => sum + upload.bytes, 0),
      cpuSubmissionMs: performance.glUploads.reduce((sum, upload) => sum + upload.ms, 0) },
    rendererResourceConstructionMs: stats(performance.resources.map((entry) => entry.ms)),
    peakObservedWorkingSetBytes: Math.max(0, ...r.memorySamples.map((memory) => workingSet(memory, sample.host))),
    peakObservedJsHeapBytes: performance.peakJsHeapBytes,
    retainedHistoryBytesBeforeClose: r.expandedHistory.bytesUsed,
    retainedHistoryBytesAfterClose: r.compactedHistory.bytesUsed,
    resources: { created: final?.totalCreated ?? null, released: final?.totalReleased ?? null,
      liveAfterClose: final?.liveResources ?? null, nativeLeaseViolations: badLeases.length,
      reopenedCreated: reopenedFinal?.totalCreated ?? null, reopenedReleased: reopenedFinal?.totalReleased ?? null,
      liveAfterReclose: reopenedFinal?.liveResources ?? null },
    input: r.input,
    toolOutcomes: Object.fromEntries(Object.entries(r.toolOutcomes).map(([tool, committed]) =>
      [tool, { effectiveEdit: committed === true, noOp: committed === false, committed }])),
    facets });
}
const aggregates = [];
for (const host of [...new Set(rows.map((row) => row.host))]) {
  for (const caseId of [...new Set(rows.filter((row) => row.host === host).map((row) => row.caseId))]) {
    const group = rows.filter((row) => row.host === host && row.caseId === caseId);
    const normal = group.flatMap((row) => row.normalRelease);
    const escape = group.flatMap((row) => row.escape);
    const matchedNormal = normal.filter((event) => event.status === 'matched');
    const matchedEscape = escape.filter((event) => event.status === 'matched');
    const coverage = (events) => ({ totalInputs: events.length, statuses: Object.fromEntries(
      [...new Set(events.map((event) => event.status))].map((status) => [status, events.filter((event) => event.status === status).length])) });
    aggregates.push({ host, caseId, trials: group.length,
      normalCoverage: coverage(normal), escapeCoverage: coverage(escape),
      normalInputToIdleMs: stats(matchedNormal.map((item) => item.inputToIdleMs)),
      normalInputToVisibleMs: stats(matchedNormal.map((item) => item.inputToVisibleMs)),
      escapeInputToIdleMs: stats(matchedEscape.map((item) => item.inputToIdleMs)),
      escapeInputToVisibleMs: stats(matchedEscape.map((item) => item.inputToVisibleMs)),
      closeInputToDisposedMs: stats(group.map((row) => row.closeInputToDisposedMs).filter((ms) => ms !== null)),
      recloseInputToDisposedMs: stats(group.map((row) => row.recloseInputToDisposedMs).filter((ms) => ms !== null)),
      nativeHitTotalUs: stats(group.map((row) => row.nativeCumulative?.nativeHitUs ?? 0)),
      nativeSelectorTotalUs: stats(group.map((row) => row.nativeCumulative?.nativeSelectorUs ?? 0)),
      nativeGeometryTotalUs: stats(group.map((row) => row.nativeCumulative?.nativeGeometryUs ?? 0)),
      renderFrameIntervalMaxMs: stats(group.map((row) => row.renderFrameIntervalMs.max)),
      renderFrameIntervalP95Ms: stats(group.map((row) => row.renderFrameIntervalMs.p95)),
      peakObservedWorkingSetBytes: stats(group.map((row) => row.peakObservedWorkingSetBytes)),
      retainedHistoryBytesBeforeClose: stats(group.map((row) => row.retainedHistoryBytesBeforeClose)),
      retainedHistoryBytesAfterClose: stats(group.map((row) => row.retainedHistoryBytesAfterClose)),
      rendererResourcesBalanced: group.every((row) => row.resources.created === row.resources.released
        && row.resources.reopenedCreated === row.resources.reopenedReleased
        && row.resources.liveAfterClose === 0 && row.resources.liveAfterReclose === 0),
      nativeGeometryLeasesBalanced: group.every((row) => row.resources.nativeLeaseViolations === 0),
    });
  }
}
const summary = { schemaVersion: 1, sourceIndex: indexPath, sourceHead: index.hardware.gitHead,
  analysisScriptSha256: hash(await readFile(import.meta.filename)),
  measurementSemantics: {
    nativeCounters: 'Cumulative Worker-thread microseconds for native picking, instrumented selector work and geometry generation. Selector scopes include their cloning/comparison and related selector serialization; counters exclude project-history commits, bridge response serialization and JS transfer.',
    rpcMs: 'Renderer-side API wall time including Worker transfer, JS decoding and native work; not a pure transport measure.',
    automationWallMs: 'Playwright action plus polling wall time; not browser input latency.',
    glBufferSubmission: 'CPU time in WebGL bufferData/bufferSubData calls during painting; GPU execution time unavailable.',
    peakObservedWorkingSetBytes: 'Largest sampled sum across host processes; nominal 1 s polling with PowerShell/CDP overhead can miss a shorter peak.',
    inputToVisibleMs: 'Browser event to first useFrame observing the terminal receipt revision after its geometry RPC completes; this is logical frame cadence, not verified display pixel or GPU presentation completion. Every terminal input has an explicit correlation status.',
    closeInputToDisposedMs: 'Close button pointerup in browser to painting probe disposal after panel unmount; this includes native closure and renderer resource cleanup.',
    equivalentWork: 'Only identical admitted sequences are comparable. Busy movement drops are reported separately.',
    toolOutcomes: 'A committed=true Paint history operation means the native candidate was effective. The receipt effective flag is reset after commit and is not the outcome indicator; per-tool facet counts give additional state evidence.' },
  nativeOrcaComparison: { status: 'unavailable', reason: 'available executable sits beside a checkout whose revision differs from the pinned Orca source; binary provenance is unverified, and no equivalent pinned painting instrumentation is available',
    availableExecutable: index.hardware.nativeOrca, pinnedCppHead: index.hardware.pinnedOrca },
  hardware: index.hardware, corpus: index.corpus.cases, aggregates, rows };
const output = resolve(dirname(indexPath), 'summary.json');
await writeFile(output, JSON.stringify(summary, null, 2) + '\n');
console.log(`wrote ${output} (${rows.length} rows)`);
