// Real-WASM A/B qualification for Filament vector draft edits on a 3MF project.
// Run the baseline report first, then pass it to the current-mode run:
//   node harness/filament-vector-project-benchmark.mjs --module out/serial/orca_slice.js --project <project.3mf> --output <baseline.json> --mode baseline
//   node harness/filament-vector-project-benchmark.mjs --module out/serial/orca_slice.js --project <project.3mf> --output <current.json> --mode current --compare-report <baseline.json>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { argv } from 'node:process';
import { performance } from 'node:perf_hooks';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const USAGE = 'node filament-vector-project-benchmark.mjs --module <orca_slice.js> --project <project.3mf> --output <report.json> --mode baseline|current [--compare-report <baseline.json>] [--warmups 1] [--samples 5] [--profile-root <directory>]';

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag?.startsWith('--')) throw new Error(`unexpected argument: ${flag ?? ''}`);
    const key = flag.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function positiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || (name === 'samples' && parsed === 0))
    throw new Error(`--${name} must be a ${name === 'samples' ? 'positive' : 'non-negative'} integer`);
  return parsed;
}

function callJson(Module, name, types = [], args = []) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  try {
    return JSON.parse(Module.UTF8ToString(pointer));
  } finally {
    Module._free(pointer);
  }
}

function callJsonTimed(Module, name, types = [], args = []) {
  const startedAt = performance.now();
  const nativeStartedAt = performance.now();
  const pointer = Number(Module.ccall(name, 'number', types, args));
  const nativeCallMs = performance.now() - nativeStartedAt;
  try {
    const decodeStartedAt = performance.now();
    const responseCopyStartedAt = performance.now();
    const responseText = Module.UTF8ToString(pointer);
    const responseBytes = Buffer.byteLength(responseText, 'utf8');
    const responseCopyMs = performance.now() - responseCopyStartedAt;
    const jsonParseStartedAt = performance.now();
    const result = JSON.parse(responseText);
    const jsonParseMs = performance.now() - jsonParseStartedAt;
    const responseDecodeMs = performance.now() - decodeStartedAt;
    return {
      result,
      elapsedMs: performance.now() - startedAt,
      nativeCallMs,
      responseCopyMs,
      jsonParseMs,
      responseDecodeMs,
      responseBytes,
    };
  } finally {
    Module._free(pointer);
  }
}

function requireOk(label, result) {
  assert.equal(result?.ok, true, `${label}: ${JSON.stringify(result)}`);
  return result;
}

function historySummary(status) {
  assert.equal(Object.hasOwn(status, 'editor_bindings'), false);
  assert.equal(Object.hasOwn(status, 'editorBindings'), false);
  assert.ok(Number.isSafeInteger(status.bytesUsed), JSON.stringify(status));
  assert.ok(Number.isSafeInteger(status.byteBudget), JSON.stringify(status));
  return {
    canUndo: status.canUndo,
    canRedo: status.canRedo,
    undoCount: status.undoEntries?.length ?? 0,
    redoCount: status.redoEntries?.length ?? 0,
    undoLabels: (status.undoEntries ?? []).map((entry) => entry.label),
    redoLabels: (status.redoEntries ?? []).map((entry) => entry.label),
    dirty: status.dirty,
    bytesUsed: status.bytesUsed,
    byteBudget: status.byteBudget,
    evictedEntryCount: status.evictedEntryCount,
    oversizedEntryRetained: status.oversizedEntryRetained,
  };
}

function recordHistory(trace, step, status) {
  trace.push({ step, state: historySummary(status) });
}

function expectOneHistoryEntry(label, before, after) {
  const previous = historySummary(before);
  const current = historySummary(after);
  assert.equal(current.undoCount, previous.undoCount + 1, `${label} must add one native history entry`);
  assert.equal(current.redoCount, 0, `${label} must clear the redo stream`);
  assert.equal(current.canUndo, true, `${label} must be undoable`);
}

function expectHistoryUnchanged(label, before, after) {
  assert.deepEqual(historySummary(after), historySummary(before), `${label} must not create history`);
}

function expectUndoTransition(label, before, after) {
  const previous = historySummary(before);
  const current = historySummary(after);
  assert.equal(current.undoCount, previous.undoCount - 1, `${label} must consume one undo entry`);
  assert.equal(current.redoCount, previous.redoCount + 1, `${label} must add one redo entry`);
  assert.equal(current.canRedo, true, `${label} must be redoable`);
}

function expectRedoTransition(label, before, after) {
  const previous = historySummary(before);
  const current = historySummary(after);
  assert.equal(current.undoCount, previous.undoCount + 1, `${label} must restore one undo entry`);
  assert.equal(current.redoCount, previous.redoCount - 1, `${label} must consume one redo entry`);
  assert.equal(current.canUndo, true, `${label} must be undoable again`);
}

function presetDraft(Module, presetName) {
  return requireOk('read selected Filament draft', callJson(Module, 'orc_get_preset_draft',
    ['string', 'string'], ['filament', presetName]));
}

function effectiveNote(draft, mode) {
  if (mode === 'current') {
    const binding = draft.editor_bindings?.filament_notes;
    assert.equal(binding?.scalar_type, 'string', 'current mode must expose native string element metadata');
    assert.equal(binding?.element_count, 1, 'the benchmark notes fixture must be a scalar string element');
    return binding.effective_value;
  }
  const raw = draft.effective_values?.filament_notes;
  assert.equal(typeof raw, 'string', 'baseline mode must expose the complete serialized notes option');
  return JSON.parse(raw);
}

function makeMutation(Module, mode, presetName, action, key, value) {
  const status = callJson(Module, 'orc_history_status');
  const body = {
    version: 1,
    action: action ?? (mode === 'current' ? 'set-element' : 'set'),
    kind: 'filament',
    canonical_name: presetName,
    expected_revision: status.revision,
    key,
  };
  if (action === 'reset-field') return callJsonTimed(Module, 'orc_mutate_preset_draft', ['string'], [JSON.stringify(body)]);
  if (mode === 'current') {
    const scalarType = key === 'filament_notes' ? 'string' : 'float';
    Object.assign(body, { scalar_type: scalarType, index: 0, value });
  } else {
    body.value = key === 'filament_notes' ? JSON.stringify(value) : String(value);
  }
  return callJsonTimed(Module, 'orc_mutate_preset_draft', ['string'], [JSON.stringify(body)]);
}

function currentNumericBinding(draft) {
  const binding = draft.editor_bindings?.filament_change_length;
  assert.equal(binding?.scalar_type, 'float', 'current mode must expose the numeric element metadata');
  assert.equal(binding?.element_count, 1, 'the numeric benchmark field must have one native element');
  return binding.effective_value;
}

function chooseNumericValue(draft) {
  const raw = draft.effective_values?.filament_change_length;
  assert.equal(typeof raw, 'string', 'the project must expose filament_change_length');
  const before = Number(raw);
  assert.ok(Number.isFinite(before), `filament_change_length must serialize as one number: ${raw}`);
  const metadata = draft.option_metadata?.filament_change_length ?? {};
  const min = Number.isFinite(Number(metadata.min)) ? Number(metadata.min) : Number.NEGATIVE_INFINITY;
  const max = Number.isFinite(Number(metadata.max)) ? Number(metadata.max) : Number.POSITIVE_INFINITY;
  const after = [before + 0.5, before - 0.5].find((candidate) => candidate > min && candidate < max);
  assert.notEqual(after, undefined, 'native numeric constraints must allow a distinct filament_change_length');
  return { before, after };
}

function readModelMoveState(Module) {
  const structure = requireOk('read complex project model structure', callJson(Module, 'orc_get_model_structure'));
  const object = structure.objects?.find((candidate) => candidate.instances?.length && candidate.volumes?.length);
  assert.ok(object, 'the complex project must contain an instantiated object with a volume');
  const patch = requireOk('read move target transform', callJson(Module, 'orc_get_model_scene_patch', ['string'], [JSON.stringify({
    object_ids: [object.id],
    known_volume_ids: object.volumes.map((volume) => volume.id),
  })]));
  const renderable = patch.renderables?.[0];
  assert.ok(renderable?.instance_transform?.offset?.length === 3, 'the project must expose a move target transform');
  return { object, renderable, offset: [...renderable.instance_transform.offset] };
}

function semanticStatusTrace(trace) {
  return trace.map(({ step, state }) => ({ step, state }));
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const portion = position - lowerIndex;
  return Number((sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * portion).toFixed(3));
}

function nearestRankPercentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return Number(sorted[rank - 1].toFixed(3));
}

function summarizeSamples(samples, warmupCount, measuredCount) {
  const names = Object.keys(samples[0].operations);
  return Object.fromEntries(names.map((name) => {
    const entries = samples.map((sample) => sample.operations[name]);
    const times = entries.map((entry) => entry.elapsedMs);
    const nativeTimes = entries.map((entry) => entry.nativeCallMs);
    const copyTimes = entries.map((entry) => entry.responseCopyMs);
    const parseTimes = entries.map((entry) => entry.jsonParseMs);
    const decodeTimes = entries.map((entry) => entry.responseDecodeMs);
    const responseSizes = entries.map((entry) => entry.responseBytes);
    return [name, {
      warmupsExcluded: warmupCount,
      sampleCount: measuredCount,
      medianMs: percentile(times, 0.5),
      p95Ms: nearestRankPercentile(times, 0.95),
      nativeCallMedianMs: percentile(nativeTimes, 0.5),
      nativeCallP95Ms: nearestRankPercentile(nativeTimes, 0.95),
      responseCopyMedianMs: percentile(copyTimes, 0.5),
      responseCopyP95Ms: nearestRankPercentile(copyTimes, 0.95),
      jsonParseMedianMs: percentile(parseTimes, 0.5),
      jsonParseP95Ms: nearestRankPercentile(parseTimes, 0.95),
      responseDecodeMedianMs: percentile(decodeTimes, 0.5),
      responseDecodeP95Ms: nearestRankPercentile(decodeTimes, 0.95),
      medianResponseBytes: percentile(responseSizes, 0.5),
      p95ResponseBytes: nearestRankPercentile(responseSizes, 0.95),
      p95Method: 'nearest-rank',
    }];
  }));
}

function compareReports(report, compareReport) {
  assert.notEqual(report.mode, compareReport.mode, 'comparison report must use the other mutation mode');
  assert.equal(report.fixture.sha256, compareReport.fixture.sha256, 'A/B runs must use the same 3MF bytes');
  assert.equal(report.checkpointFingerprint, compareReport.checkpointFingerprint,
    'A/B runs must load and clear history at the same native project checkpoint');
  assert.deepEqual(report.historyTrace, compareReport.historyTrace,
    'A/B equivalent edits must retain the same native history counts, labels, and byte usage');
  assert.deepEqual(report.semanticTrace, compareReport.semanticTrace,
    'A/B modes must reach the same semantic values and Move transforms');
  return {
    modeCompared: compareReport.mode,
    fixtureMatches: true,
    checkpointMatches: true,
    semanticTraceMatches: true,
    nativeHistoryTraceMatches: true,
    projectionStorageParity: 'history bytesUsed and native history metadata match for equivalent raw values',
  };
}

async function main() {
  const options = parseArgs(argv.slice(2));
  if (!options.module || !options.project || !options.output || !['baseline', 'current'].includes(options.mode)) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const warmups = positiveInteger(options.warmups, 'warmups', 1);
  const samplesRequested = positiveInteger(options.samples, 'samples', 5);
  const repositoryRoot = resolve(import.meta.dirname, '../../..');
  const modulePath = resolve(options.module);
  const projectPath = resolve(options.project);
  const outputPath = resolve(options.output);
  const compareReportPath = options['compare-report'] ? resolve(options['compare-report']) : null;
  const profileRoot = resolve(options['profile-root'] ?? resolve(repositoryRoot, 'packages/profile-resources/dist'));
  const projectBytes = await readFile(projectPath);
  const projectHash = sha256(projectBytes);
  const artifactStem = basename(modulePath).replace(/\.js$/i, '');
  const artifactNames = [`${artifactStem}.js`, `${artifactStem}.wasm`, `${artifactStem}.data`];
  const artifacts = [];
  for (const name of artifactNames) {
    const path = resolve(dirname(modulePath), name);
    try {
      const bytes = await readFile(path);
      artifacts.push({ name, sizeBytes: bytes.byteLength, sha256: sha256(bytes) });
    } catch (error) {
      if (name.endsWith('.js') || name.endsWith('.wasm')) throw error;
    }
  }
  const compareReport = compareReportPath ? JSON.parse(await readFile(compareReportPath, 'utf8')) : null;
  const factory = await loadModuleFactory(modulePath);
  const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
  await installProfilePackages(Module, createNodeProfileSource(profileRoot));
  requireOk('initialize real WASM', callJson(Module, 'orc_init', ['string'], ['{"log_level":"error"}']));

  const threading = callJson(Module, 'orc_get_threading_info');
  const threadInfo = threading?.ok === true ? threading : null;
  const shortNote = 'vector qualification short note!';
  const longNote = Array.from({ length: 64 }, (_, index) =>
    `vector line ${index}: "quoted value" \\ option=${'x'.repeat(56)}`,
  ).join('\n');
  const noteSummary = {
    short: { length: shortNote.length, sha256: sha256(shortNote) },
    long: { length: longNote.length, sha256: sha256(longNote) },
  };
  const historyContext = {
    selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
    activePlateId: null,
    gizmo: null,
    nativeScopedConfig: {},
  };
  const allRuns = [];

  async function loadCheckpoint() {
    const startedAt = performance.now();
    const pointer = Number(Module._malloc(projectBytes.byteLength));
    Module.HEAPU8.set(projectBytes, pointer);
    let loaded;
    try {
      loaded = callJson(Module, 'orc_load_project', ['pointer', 'number', 'number', 'string'],
        [pointer, projectBytes.byteLength, 0, 'vector-qualification.3mf']);
    } finally {
      Module._free(pointer);
    }
    requireOk('load the supplied 3MF project', loaded);
    const reset = callJson(Module, 'orc_history_reset', ['string'], [JSON.stringify(historyContext)]);
    assert.equal(reset.canUndo, false, 'history must be clear at the comparison checkpoint');
    assert.equal(reset.canRedo, false, 'redo history must be clear at the comparison checkpoint');
    const session = requireOk('read loaded Filament session', callJson(Module, 'orc_get_filament_session_snapshot'));
    const presetName = session.slots?.[0]?.preset?.name;
    assert.equal(typeof presetName, 'string', 'the project must contain a selected Filament source');
    const initialDraft = presetDraft(Module, presetName);
    assert.ok(Object.hasOwn(initialDraft.effective_values, 'filament_notes'), 'Filament source must contain notes');
    assert.ok(Object.hasOwn(initialDraft.effective_values, 'filament_change_length'),
      'Filament source must contain the numeric edit target');
    if (options.mode === 'current') {
      assert.equal(initialDraft.editor_bindings?.filament_notes?.scalar_type, 'string');
      assert.equal(initialDraft.editor_bindings?.filament_notes?.element_count, 1);
      currentNumericBinding(initialDraft);
    }
    const numeric = chooseNumericValue(initialDraft);
    const model = readModelMoveState(Module);
    const history = callJson(Module, 'orc_history_status');
    const initialHistory = historySummary(history);
    assert.equal(initialHistory.canUndo, false);
    assert.equal(initialHistory.canRedo, false);
    return {
      presetName,
      initialDraft,
      numeric,
      model,
      initialHistory,
      checkpointSetupMs: performance.now() - startedAt,
    };
  }

  async function resetToCheckpoint(checkpoint) {
    const expectedUndoCount = 6;
    let status = callJson(Module, 'orc_history_status');
    assert.equal(status.undoEntries?.length, expectedUndoCount,
      'scenario must leave exactly the six expected project-history edits to restore');
    for (let index = 0; index < expectedUndoCount; index += 1) {
      requireOk(`restore checkpoint with Undo ${index + 1}`, callJson(Module, 'orc_history_undo'));
    }
    const restoredDraft = presetDraft(Module, checkpoint.presetName);
    assert.equal(restoredDraft.effective_values.filament_notes,
      checkpoint.initialDraft.effective_values.filament_notes,
      'sample cleanup must restore the original Filament notes serialization');
    assert.equal(restoredDraft.effective_values.filament_change_length,
      checkpoint.initialDraft.effective_values.filament_change_length,
      'sample cleanup must restore the original numeric option');
    assert.deepEqual(readModelMoveState(Module).offset, checkpoint.model.offset,
      'sample cleanup must restore the original instance transform');
    const reset = callJson(Module, 'orc_history_reset', ['string'], [JSON.stringify(historyContext)]);
    assert.equal(reset.canUndo, false, 'the next sample must start with cleared undo history');
    assert.equal(reset.canRedo, false, 'the next sample must start with cleared redo history');
    status = callJson(Module, 'orc_history_status');
    assert.deepEqual(historySummary(status), checkpoint.initialHistory,
      'the next sample must start with the same empty native history checkpoint');
  }

  async function runScenario(iteration, checkpoint) {
    const historyTrace = [];
    const operations = {};
    const semanticTrace = [];
    let status = callJson(Module, 'orc_history_status');
    recordHistory(historyTrace, 'checkpoint', status);

    function remember(name, timed) {
      operations[name] = {
        elapsedMs: timed.elapsedMs,
        nativeCallMs: timed.nativeCallMs,
        responseCopyMs: timed.responseCopyMs,
        jsonParseMs: timed.jsonParseMs,
        responseDecodeMs: timed.responseDecodeMs,
        responseBytes: timed.responseBytes,
      };
      return timed.result;
    }

    function recordMutationHistory(name, beforeStatus, result) {
      requireOk(name, result);
      assert.equal(result.history_entry_delta, 1, `${name} must remain one native project-history entry`);
      const afterStatus = callJson(Module, 'orc_history_status');
      expectOneHistoryEntry(name, beforeStatus, afterStatus);
      recordHistory(historyTrace, name, afterStatus);
      status = afterStatus;
      return afterStatus;
    }

    let beforeStatus = status;
    let result = remember('note_short_set', makeMutation(
      Module, options.mode, checkpoint.presetName, undefined, 'filament_notes', shortNote,
    ));
    recordMutationHistory('short note edit', beforeStatus, result);
    assert.equal(result.effective_values.filament_notes, JSON.stringify(shortNote));
    assert.equal(effectiveNote(result, options.mode), shortNote);
    semanticTrace.push({ stage: 'short-note-set', length: shortNote.length, sha256: sha256(shortNote) });

    beforeStatus = status;
    const shortRead = callJsonTimed(Module, 'orc_get_preset_draft', ['string', 'string'],
      ['filament', checkpoint.presetName]);
    result = remember('note_short_get', shortRead);
    requireOk('read short note', result);
    assert.equal(effectiveNote(result, options.mode), shortNote);
    expectHistoryUnchanged('short note read', beforeStatus, callJson(Module, 'orc_history_status'));
    recordHistory(historyTrace, 'short note read', status);
    semanticTrace.push({ stage: 'short-note-read', length: shortNote.length, sha256: sha256(effectiveNote(result, options.mode)) });

    beforeStatus = status;
    result = remember('note_long_set', makeMutation(
      Module, options.mode, checkpoint.presetName, undefined, 'filament_notes', longNote,
    ));
    recordMutationHistory('long note edit', beforeStatus, result);
    assert.equal(result.effective_values.filament_notes, JSON.stringify(longNote));
    assert.equal(effectiveNote(result, options.mode), longNote);
    semanticTrace.push({ stage: 'long-note-set', length: longNote.length, sha256: sha256(longNote) });

    beforeStatus = status;
    const longRead = callJsonTimed(Module, 'orc_get_preset_draft', ['string', 'string'],
      ['filament', checkpoint.presetName]);
    result = remember('note_long_get', longRead);
    requireOk('read long note', result);
    assert.equal(effectiveNote(result, options.mode), longNote);
    expectHistoryUnchanged('long note read', beforeStatus, callJson(Module, 'orc_history_status'));
    recordHistory(historyTrace, 'long note read', status);
    semanticTrace.push({ stage: 'long-note-read', length: longNote.length, sha256: sha256(effectiveNote(result, options.mode)) });

    const numericAfter = checkpoint.numeric.after;
    beforeStatus = status;
    result = remember('numeric_edit', makeMutation(
      Module, options.mode, checkpoint.presetName, undefined, 'filament_change_length', numericAfter,
    ));
    recordMutationHistory('numeric draft edit', beforeStatus, result);
    assert.equal(result.effective_values.filament_change_length, String(numericAfter));
    if (options.mode === 'current') assert.equal(currentNumericBinding(result), numericAfter);
    semanticTrace.push({ stage: 'numeric-edit', before: checkpoint.numeric.before, after: numericAfter });

    beforeStatus = status;
    const resetField = remember('numeric_reset', makeMutation(
      Module, options.mode, checkpoint.presetName, 'reset-field', 'filament_change_length', undefined,
    ));
    recordMutationHistory('numeric field reset', beforeStatus, resetField);
    assert.equal(resetField.effective_values.filament_change_length,
      checkpoint.initialDraft.source_values.filament_change_length, 'reset must inherit the exact source serialization');
    semanticTrace.push({ stage: 'numeric-reset', effective: resetField.effective_values.filament_change_length });

    const moveBefore = checkpoint.model.renderable;
    const moveOffset = [...checkpoint.model.offset];
    const moveTransform = structuredClone(moveBefore.instance_transform);
    moveTransform.offset = [...moveTransform.offset];
    moveTransform.offset[0] += 0.5;
    delete moveTransform.matrix;
    const moveRequest = [{
      objectIdx: moveBefore.object_idx,
      volumeIdx: moveBefore.volume_idx,
      instanceIdx: moveBefore.instance_idx,
      instanceTransform: moveTransform,
      volumeTransform: moveBefore.volume_transform,
    }];
    const moveStartedAt = performance.now();
    const moveTransaction = callJsonTimed(Module, 'orc_history_begin',
      ['string', 'string', 'string', 'string'], ['Move', 'project', JSON.stringify(historyContext), '']);
    requireOk('begin pure Move transaction', moveTransaction.result);
    const moveResult = callJsonTimed(Module, 'orc_set_model_transforms', ['string', 'string'],
      [moveTransaction.result.transactionId, JSON.stringify(moveRequest)]);
    requireOk('apply pure Move', moveResult.result);
    const moveCommit = callJsonTimed(Module, 'orc_history_commit', ['string', 'string'],
      [moveTransaction.result.transactionId, JSON.stringify(historyContext)]);
    assert.equal(moveCommit.result.status?.canUndo, true, JSON.stringify(moveCommit.result));
    operations.pure_move = {
      elapsedMs: performance.now() - moveStartedAt,
      nativeCallMs: moveTransaction.nativeCallMs + moveResult.nativeCallMs + moveCommit.nativeCallMs,
      responseCopyMs: moveTransaction.responseCopyMs + moveResult.responseCopyMs + moveCommit.responseCopyMs,
      jsonParseMs: moveTransaction.jsonParseMs + moveResult.jsonParseMs + moveCommit.jsonParseMs,
      responseDecodeMs: moveTransaction.responseDecodeMs + moveResult.responseDecodeMs + moveCommit.responseDecodeMs,
      responseBytes: moveTransaction.responseBytes + moveResult.responseBytes + moveCommit.responseBytes,
    };
    beforeStatus = status;
    status = callJson(Module, 'orc_history_status');
    expectOneHistoryEntry('pure Move', beforeStatus, status);
    recordHistory(historyTrace, 'pure Move', status);
    const moveAfter = readModelMoveState(Module);
    assert.equal(moveAfter.offset[0], moveOffset[0] + 0.5, 'Move must change only the requested instance offset');
    semanticTrace.push({ stage: 'move-after', offset: moveAfter.offset });

    beforeStatus = status;
    const moveUndo = remember('pure_move_undo', callJsonTimed(Module, 'orc_history_undo'));
    requireOk('Undo pure Move', moveUndo);
    status = callJson(Module, 'orc_history_status');
    expectUndoTransition('Undo pure Move', beforeStatus, status);
    recordHistory(historyTrace, 'pure Move Undo', status);
    const moveUndone = readModelMoveState(Module);
    assert.deepEqual(moveUndone.offset, moveOffset, 'Undo must restore the exact pre-Move instance transform');

    beforeStatus = status;
    const moveRedo = remember('pure_move_redo', callJsonTimed(Module, 'orc_history_redo'));
    requireOk('Redo pure Move', moveRedo);
    status = callJson(Module, 'orc_history_status');
    expectRedoTransition('Redo pure Move', beforeStatus, status);
    recordHistory(historyTrace, 'pure Move Redo', status);
    const moveRedone = readModelMoveState(Module);
    assert.deepEqual(moveRedone.offset, moveAfter.offset, 'Redo must restore the exact moved transform');
    semanticTrace.push({ stage: 'move-undo-redo', before: moveUndone.offset, after: moveRedone.offset });

    const draftEditValue = checkpoint.numeric.before + 1.5;
    beforeStatus = status;
    const draftEdit = remember('draft_edit', makeMutation(
      Module, options.mode, checkpoint.presetName, undefined, 'filament_change_length', draftEditValue,
    ));
    recordMutationHistory('draft history edit', beforeStatus, draftEdit);
    assert.equal(draftEdit.effective_values.filament_change_length, String(draftEditValue));
    if (options.mode === 'current') assert.equal(currentNumericBinding(draftEdit), draftEditValue);

    beforeStatus = status;
    const draftUndo = remember('draft_undo', callJsonTimed(Module, 'orc_history_undo'));
    requireOk('Undo draft edit', draftUndo);
    status = callJson(Module, 'orc_history_status');
    expectUndoTransition('Undo draft edit', beforeStatus, status);
    recordHistory(historyTrace, 'draft Undo', status);
    const draftAfterUndo = presetDraft(Module, checkpoint.presetName);
    assert.equal(draftAfterUndo.effective_values.filament_change_length,
      checkpoint.initialDraft.source_values.filament_change_length,
      'draft Undo must restore the source numeric value after the field reset');
    assert.equal(effectiveNote(draftAfterUndo, options.mode), longNote,
      'draft Undo must retain both earlier note edits');
    assert.deepEqual(readModelMoveState(Module).offset, moveAfter.offset,
      'draft Undo must preserve the independently redone Move');

    beforeStatus = status;
    const draftRedo = remember('draft_redo', callJsonTimed(Module, 'orc_history_redo'));
    requireOk('Redo draft edit', draftRedo);
    status = callJson(Module, 'orc_history_status');
    expectRedoTransition('Redo draft edit', beforeStatus, status);
    recordHistory(historyTrace, 'draft Redo', status);
    const draftAfterRedo = presetDraft(Module, checkpoint.presetName);
    assert.equal(draftAfterRedo.effective_values.filament_change_length, String(draftEditValue));
    assert.equal(effectiveNote(draftAfterRedo, options.mode), longNote);
    assert.deepEqual(readModelMoveState(Module).offset, moveAfter.offset);
    semanticTrace.push({ stage: 'draft-undo-redo', before: checkpoint.numeric.before, after: draftEditValue });

    const run = {
      iteration,
      operations,
      historyTrace: semanticStatusTrace(historyTrace),
      semanticTrace,
      checkpoint: {
        filamentSlotCount: callJson(Module, 'orc_get_filament_session_snapshot').slots.length,
        modelObjectCount: callJson(Module, 'orc_get_model_structure').objects.length,
        initialHistory: checkpoint.initialHistory,
      },
    };
    await resetToCheckpoint(checkpoint);
    return run;
  }

  const checkpoint = await loadCheckpoint();
  for (let iteration = 0; iteration < warmups + samplesRequested; iteration += 1) {
    allRuns.push(await runScenario(iteration, checkpoint));
  }
  const measuredRuns = allRuns.slice(warmups);
  const firstRun = measuredRuns[0];
  for (const run of measuredRuns.slice(1)) {
    assert.deepEqual(run.historyTrace, firstRun.historyTrace,
      'every sample must start from the same cleared history checkpoint and retain the same native history state');
    assert.deepEqual(run.semanticTrace, firstRun.semanticTrace, 'every sample must perform the same semantic edits');
    assert.deepEqual(run.checkpoint.initialHistory, firstRun.checkpoint.initialHistory);
  }

  const checkpointFingerprint = sha256(JSON.stringify({
    fixture: projectHash,
    modelObjectCount: firstRun.checkpoint.modelObjectCount,
    filamentSlotCount: firstRun.checkpoint.filamentSlotCount,
    selectedPresetSha256: sha256(checkpoint.presetName),
    nativeNumericBefore: firstRun.semanticTrace.find((entry) => entry.stage === 'numeric-edit')?.before,
    initialNoteSha256: sha256(checkpoint.initialDraft.effective_values.filament_notes),
    initialModelOffset: checkpoint.model.offset,
    initialHistory: firstRun.checkpoint.initialHistory,
  }));
  const historyTrace = firstRun.historyTrace;
  const semanticTrace = firstRun.semanticTrace;
  const report = {
    schemaVersion: 1,
    benchmark: 'filament-vector-project',
    mode: options.mode,
    runtime: threadInfo,
    artifacts,
    fixture: { extension: '.3mf', sizeBytes: projectBytes.byteLength, sha256: projectHash },
    warmups,
    sampleCount: samplesRequested,
    projectLoadCount: 1,
    checkpointSetupMs: Number(checkpoint.checkpointSetupMs.toFixed(3)),
    measuredSamples: measuredRuns.map(({ iteration, operations }) => ({ iteration, operations })),
    noteInputs: noteSummary,
    checkpointFingerprint,
    semanticTrace,
    historyTrace,
    operationSummary: summarizeSamples(measuredRuns, warmups, samplesRequested),
    historyProjectionChecks: {
      statusHasNoEditorProjectionFields: true,
      allAcceptedDraftMutationsAddedOneNativeEntry: true,
      moveAndDraftUndoRedoWereIndependent: true,
      comparisonUsesExactHistoryBytesAndEntryLabels: true,
    },
    timingMethod: {
      elapsedMs: 'Module.ccall plus UTF8 response copy, response byte count, and JSON.parse',
      nativeCallMs: 'time inside the Module.ccall interval, including native bridge work and WASM response serialization',
      responseCopyMs: 'UTF8ToString plus response byte count after Module.ccall returns',
      jsonParseMs: 'JSON.parse after response copy',
      responseDecodeMs: 'responseCopyMs plus jsonParseMs',
      operationSummaryP95: 'nearest-rank',
    },
  };
  if (compareReport) report.comparison = compareReports(report, compareReport);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
