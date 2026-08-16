# Move Gizmo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the M2 drag-move with the full move tool: drei `TransformControls` gizmo on selection, drei `DragControls` body-drag, and a sidebar Move panel (numeric X/Y/Z, Drop to bed, Reset).

**Architecture:** The DragControls group is the single world-transform owner for each object; both drag systems write `group.position`; a shared `commitPosition` helper round-trips the bridge (`setInstanceOffset`) and keeps a per-object `positions` map in the settings store as the single source of truth. The gizmo and body drag are mutually excluded by a synchronous `gestureRef` + React `kind` state pair.

**Tech Stack:** React 19, react-three-fiber 9, drei 10.7.8 (`TransformControls`, `DragControls`), three 0.185, zustand 5, vitest 4 (node env, no component-test framework), Playwright Electron e2e.

**Spec:** `doc/2026-08-16-move-gizmo-design.md` — the design this plan implements; read it before starting. The plan argues from the spec.

## Global Constraints

- **Z-up slicer convention** — bed plane is world Z=0; `camera.up = [0,0,1]` is already set in `Viewport.tsx`. All gizmo/drag math is world space.
- **Demand render** — `<Canvas frameloop="demand">` (doc/2026-08-16-demand-render-viewport.md): any imperative THREE mutation must be followed by `useThree((s) => s.invalidate)()`. drei `DragControls` invalidates internally; drei `TransformControls` does NOT.
- **drei 10.7.8 quirks (source-verified)** — `DragControls` sets `matrixAutoUpdate: false` on its group (fix: `autoTransform={false}` + write `group.position` in `onDrag` + a mount effect sets `matrixAutoUpdate = true`); it auto-disables the makeDefault OrbitControls on drag start and re-enables on drag end. `dragConfig` (use-gesture) supports dynamic `enabled`.
- **The bridge is the only seam** — renderer code never imports the WASM module; it uses `slicerClient` from `../../slicer/slicerClient`.
- **Aliases** — `@/` → `src/renderer/src`; `@slicer/client` → the client package (vitest + electron-vite configs both alias them).
- **Tests** — unit: `pnpm --filter desktop test` (vitest run, node env, include `src/renderer/src/**/*.test.{ts,tsx}`). Typecheck: `pnpm --filter desktop typecheck`. e2e: `pnpm --filter desktop test:e2e` (Playwright, mock module, ~1-2 min). Existing e2e specs must stay green.
- **No React component-test framework** (@testing-library absent) — component interactions are e2e-tested; unit tests cover stores and pure functions.
- **Commit policy** — one commit per task, conventional message, ending with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- **Store precedent** — zustand stores are plain `create<State>((set) => ...)`; tests read `useSettingsStore.getState()` directly.

---

### Task 1: Store shape — tool field + per-object transform maps

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/vec3.ts`
- Modify: `apps/desktop/src/renderer/src/stores/useSettingsStore.ts`
- Test: `apps/desktop/src/renderer/src/stores/useSettingsStore.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `lib/vec3.ts` — `export type Vec3 = [number, number, number];`
  - `useSettingsStore`: `tool: string` (default `'move'`, no setter — reserved for rotate/scale); `positions: Record<number, Vec3>`; `initialPositions: Record<number, Vec3>`; `objectMinZ: Record<number, number>` (all default `{}`); `setObjectOffsets(positions: Record<number, Vec3>, initialPositions: Record<number, Vec3>, objectMinZ: Record<number, number>): void` (replace-all seed); `setObjectOffset(objectIdx: number, pos: Vec3): void` (single-object live update, leaves `initialPositions` untouched). The old `instanceOffset: [n,n,n]` + `setInstanceOffset` are REMOVED (no readers; verified in the design).

- [ ] **Step 1: Write the failing test**

Rewrite `apps/desktop/src/renderer/src/stores/useSettingsStore.test.ts`:

```ts
// apps/desktop/src/renderer/src/stores/useSettingsStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from './useSettingsStore';

describe('useSettingsStore', () => {
  beforeEach(() => {
    useSettingsStore.setState({ positions: {}, initialPositions: {}, objectMinZ: {} });
  });

  it('setValue merges into values', () => {
    const s = useSettingsStore.getState();
    s.setValues({ layer_height: '0.2' });
    s.setValue('wall_loops', '3');
    expect(useSettingsStore.getState().values).toEqual({ layer_height: '0.2', wall_loops: '3' });
  });

  it('defaults tool to move and starts with empty transform maps', () => {
    const s = useSettingsStore.getState();
    expect(s.tool).toBe('move');
    expect(s.positions).toEqual({});
    expect(s.initialPositions).toEqual({});
    expect(s.objectMinZ).toEqual({});
  });

  it('setObjectOffsets seeds all three maps', () => {
    useSettingsStore.getState().setObjectOffsets(
      { 0: [1, 2, 3] },
      { 0: [0, 0, 0] },
      { 0: 0 },
    );
    const s = useSettingsStore.getState();
    expect(s.positions).toEqual({ 0: [1, 2, 3] });
    expect(s.initialPositions).toEqual({ 0: [0, 0, 0] });
    expect(s.objectMinZ).toEqual({ 0: 0 });
  });

  it('setObjectOffset updates one object without touching initialPositions', () => {
    useSettingsStore.getState().setObjectOffsets(
      { 0: [0, 0, 0], 1: [5, 5, 5] },
      { 0: [0, 0, 0], 1: [5, 5, 5] },
      {},
    );
    useSettingsStore.getState().setObjectOffset(0, [10, 20, 30]);
    const s = useSettingsStore.getState();
    expect(s.positions).toEqual({ 0: [10, 20, 30], 1: [5, 5, 5] });
    // initialPositions stays the load-time snapshot — Reset needs it.
    expect(s.initialPositions).toEqual({ 0: [0, 0, 0], 1: [5, 5, 5] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter desktop test`
Expected: FAIL — `instanceOffset` still exists, `positions`/`tool` undefined.

- [ ] **Step 3: Implement the store**

Create `apps/desktop/src/renderer/src/lib/vec3.ts`:

```ts
// apps/desktop/src/renderer/src/lib/vec3.ts
/** World-space position tuple used by the viewport transform state. */
export type Vec3 = [number, number, number];
```

Edit `apps/desktop/src/renderer/src/stores/useSettingsStore.ts`:

```ts
import { create } from 'zustand';
import type { OptionMetadata, PresetInfo } from '@slicer/client';
import type { Vec3 } from '../lib/vec3';

interface SettingsState {
  metadata: OptionMetadata | null;
  printers: PresetInfo[];
  prints: PresetInfo[];
  filaments: PresetInfo[];
  selectedPrinter: string;
  selectedPrint: string;
  selectedFilament: string;
  values: Record<string, string>;
  modelLoaded: boolean;
  selectedObject: number | null;
  /** Active viewport tool. Only 'move' exists today; rotate/scale milestones
   *  extend this field — the gizmo family renders from it. */
  tool: string;
  /** Per-object current world offsets — the client-side truth for the move
   *  panel and drag commits (seeded at load, updated live during drags and
   *  on commit). */
  positions: Record<number, Vec3>;
  /** Load-time offset snapshot — Reset target. */
  initialPositions: Record<number, Vec3>;
  /** Object-local bounding-box min Z (from geometry) — Drop-to-bed input. */
  objectMinZ: Record<number, number>;
  setMetadata: (m: OptionMetadata) => void;
  setPresets: (printers: PresetInfo[], prints: PresetInfo[], filaments: PresetInfo[]) => void;
  setSelections: (printer: string, print: string, filament: string) => void;
  setValue: (key: string, value: string) => void;
  setValues: (values: Record<string, string>) => void;
  setModelLoaded: (v: boolean) => void;
  setSelectedObject: (v: number | null) => void;
  setObjectOffsets: (
    positions: Record<number, Vec3>,
    initialPositions: Record<number, Vec3>,
    objectMinZ: Record<number, number>,
  ) => void;
  setObjectOffset: (objectIdx: number, pos: Vec3) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  metadata: null,
  printers: [],
  prints: [],
  filaments: [],
  selectedPrinter: '',
  selectedPrint: '',
  selectedFilament: '',
  values: {},
  modelLoaded: false,
  selectedObject: null,
  tool: 'move',
  positions: {},
  initialPositions: {},
  objectMinZ: {},
  setMetadata: (metadata) => set({ metadata }),
  setPresets: (printers, prints, filaments) => set({
    printers, prints, filaments,
    selectedPrinter: printers.find((p) => p.selected)?.name ?? '',
    selectedPrint: prints.find((p) => p.selected)?.name ?? '',
    selectedFilament: filaments.find((p) => p.selected)?.name ?? '',
  }),
  setSelections: (selectedPrinter, selectedPrint, selectedFilament) =>
    set({ selectedPrinter, selectedPrint, selectedFilament }),
  setValue: (key, value) => set((s) => ({ values: { ...s.values, [key]: value } })),
  setValues: (values) => set({ values }),
  setModelLoaded: (modelLoaded) => set({ modelLoaded }),
  setSelectedObject: (selectedObject) => set({ selectedObject }),
  setObjectOffsets: (positions, initialPositions, objectMinZ) =>
    set({ positions, initialPositions, objectMinZ }),
  setObjectOffset: (objectIdx, pos) =>
    set((s) => ({ positions: { ...s.positions, [objectIdx]: pos } })),
}));
```

Keep the existing comments on fields you preserve. Delete `instanceOffset` and `setInstanceOffset` entirely.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter desktop test`
Expected: PASS (5 assertions green). Also run `pnpm --filter desktop typecheck` — the old `instanceOffset` references are gone; if another file still references it, delete/update that reference (grep `instanceOffset` in `apps/desktop/src/renderer` first — only `ModelMesh.tsx` used it, which Task 5 rewrites; if it still compiles against the removed field, fix it in Task 5 — but typecheck MUST pass now, so if `ModelMesh.tsx` fails, comment the typecheck run as expected-to-fail and note it — better: proceed to Task 5 immediately after this task if typecheck is red, and confirm green at the end of Task 5).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/vec3.ts apps/desktop/src/renderer/src/stores/useSettingsStore.ts apps/desktop/src/renderer/src/stores/useSettingsStore.test.ts
git commit -m "feat(viewport): per-object transform state in settings store

tool field reserved for the gizmo family; positions/initialPositions/
objectMinZ maps replace the single instanceOffset tuple. Vec3 type
shared via lib/vec3.ts.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: transformMath pure helpers

**Files:**
- Create: `apps/desktop/src/renderer/src/components/viewport/transformMath.ts`
- Test: `apps/desktop/src/renderer/src/components/viewport/transformMath.test.ts`

**Interfaces:**
- Consumes: `Vec3` from `../../../lib/vec3`; `THREE` (runtime dep).
- Produces:
  - `computeObjectMinZ(geometry: THREE.BufferGeometry): number` — ensures `geometry.computeBoundingBox()` has run, returns `boundingBox.min.z`.
  - `buildTransformSeeds(objects: Array<{ objectIdx: number; offset: Vec3; minZ: number }>): { positions: Record<number, Vec3>; initialPositions: Record<number, Vec3>; objectMinZ: Record<number, number> }` — assembles the three store maps (positions and initialPositions both start at the load-time offset).
  - `computeDropZ(minZ: number): number` — `-minZ` (z that puts the object's local min Z on the bed).
  - `parseNumberInput(text: string): number | null` — finite-number parse; `null` for `''`, `NaN`, non-numeric, or non-finite.
  - `formatPosition(v: number): string` — 3-decimal formatting (`v.toFixed(3)`).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/components/viewport/transformMath.test.ts`:

```ts
// apps/desktop/src/renderer/src/components/viewport/transformMath.test.ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  computeObjectMinZ,
  buildTransformSeeds,
  computeDropZ,
  parseNumberInput,
  formatPosition,
} from './transformMath';
import type { Vec3 } from '../../lib/vec3';

describe('computeObjectMinZ', () => {
  it('returns the local bounding-box min Z', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([0, 0, 0, 10, 0, 0, 0, 0, -5, 5, 5, 20]),
      3,
    ));
    expect(computeObjectMinZ(g)).toBe(-5);
  });
});

describe('buildTransformSeeds', () => {
  it('seeds positions and initialPositions from the load-time offsets', () => {
    const seeds = buildTransformSeeds([
      { objectIdx: 0, offset: [1, 2, 3] as Vec3, minZ: 0 },
      { objectIdx: 1, offset: [4, 5, 6] as Vec3, minZ: -2 },
    ]);
    expect(seeds.positions).toEqual({ 0: [1, 2, 3], 1: [4, 5, 6] });
    expect(seeds.initialPositions).toEqual({ 0: [1, 2, 3], 1: [4, 5, 6] });
    expect(seeds.objectMinZ).toEqual({ 0: 0, 1: -2 });
  });
});

describe('computeDropZ', () => {
  it('returns the z that rests the object on the bed', () => {
    expect(computeDropZ(-2)).toBe(2);
    expect(computeDropZ(0)).toBe(0);
    expect(computeDropZ(5)).toBe(-5);
  });
});

describe('parseNumberInput', () => {
  it('parses finite decimals and rejects garbage', () => {
    expect(parseNumberInput('12.5')).toBe(12.5);
    expect(parseNumberInput('-3')).toBe(-3);
    expect(parseNumberInput('')).toBeNull();
    expect(parseNumberInput('abc')).toBeNull();
    expect(parseNumberInput('1.2.3')).toBeNull();
    expect(parseNumberInput('Infinity')).toBeNull();
  });
});

describe('formatPosition', () => {
  it('formats to 3 decimals', () => {
    expect(formatPosition(12.3456)).toBe('12.346');
    expect(formatPosition(0)).toBe('0.000');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter desktop test -- transformMath`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/renderer/src/components/viewport/transformMath.ts`:

```ts
// apps/desktop/src/renderer/src/components/viewport/transformMath.ts
// Pure helpers for the move gizmo / move panel — unit-tested without React.
import * as THREE from 'three';
import type { Vec3 } from '../../lib/vec3';

/** Object-local bounding-box min Z (bed contact plane for Drop to bed). */
export function computeObjectMinZ(geometry: THREE.BufferGeometry): number {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  return geometry.boundingBox!.min.z;
}

/** Assemble the store's three transform maps from the loaded objects. */
export function buildTransformSeeds(objects: Array<{
  objectIdx: number;
  offset: Vec3;
  minZ: number;
}>): {
  positions: Record<number, Vec3>;
  initialPositions: Record<number, Vec3>;
  objectMinZ: Record<number, number>;
} {
  const positions: Record<number, Vec3> = {};
  const initialPositions: Record<number, Vec3> = {};
  const objectMinZ: Record<number, number> = {};
  for (const o of objects) {
    positions[o.objectIdx] = o.offset;
    initialPositions[o.objectIdx] = o.offset;
    objectMinZ[o.objectIdx] = o.minZ;
  }
  return { positions, initialPositions, objectMinZ };
}

/** Z offset at which the object's local min Z rests on the bed (Z=0). */
export function computeDropZ(minZ: number): number {
  return -minZ;
}

/** Parse a numeric input; null for anything non-finite. */
export function parseNumberInput(text: string): number | null {
  if (text.trim() === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** Position input display format (mm, 3 decimals — slicer convention). */
export function formatPosition(v: number): string {
  return v.toFixed(3);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter desktop test -- transformMath`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/viewport/transformMath.ts apps/desktop/src/renderer/src/components/viewport/transformMath.test.ts
git commit -m "feat(viewport): pure transform helpers for the move tool

bbox min-Z, seed-map assembly, drop-to-bed z, input parse/format.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: useModelLoader seeds the transform maps

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/viewport/useModelLoader.ts`

**Interfaces:**
- Consumes: `computeObjectMinZ`, `buildTransformSeeds` from `./transformMath`; `useSettingsStore.setObjectOffsets`.
- Produces: nothing new — on load, `positions`/`initialPositions`/`objectMinZ` seeded from `ModelObjectBuffer.offset` + geometry bbox; cleared when `modelLoaded` goes false.

- [ ] **Step 1: Edit the effect**

In `useModelLoader.ts`, after the `loaded` array is built (inside the async load, where `disposed` is checked), seed the store; clear on unload. The load branch becomes:

```ts
const loaded: LoadedObject[] = res.objects.map((buf) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(buf.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(buf.indices, 1));
  geometry.computeVertexNormals();
  return { buffer: buf, geometry };
});
if (disposed) {
  loaded.forEach((o) => o.geometry.dispose());
} else {
  // Seed the move state: current offsets, the reset snapshot, and the
  // per-object bed-contact min Z (Drop to bed).
  const seeds = buildTransformSeeds(
    loaded.map((o) => ({
      objectIdx: o.buffer.objectIdx,
      offset: o.buffer.offset as [number, number, number],
      minZ: computeObjectMinZ(o.geometry),
    })),
  );
  useSettingsStore.getState().setObjectOffsets(seeds.positions, seeds.initialPositions, seeds.objectMinZ);
  setObjects(loaded);
}
```

And in the cleanup (the `if (!modelLoaded)` early branch) clear the maps:

```ts
if (!modelLoaded) {
  useSettingsStore.getState().setObjectOffsets({}, {}, {});
  setObjects([]);
  return;
}
```

Imports to add: `import { computeObjectMinZ, buildTransformSeeds } from './transformMath';` and `useSettingsStore` (check it isn't already imported — it isn't in the current file).

- [ ] **Step 2: Verify**

Run: `pnpm --filter desktop typecheck`
Expected: PASS. (If Task 1 left `ModelMesh.tsx` red on `setInstanceOffset`, this task's typecheck will still be red on that file — resolve it now by proceeding to Task 4/5 in order; the plan's Task 5 fixes it. Typecheck for files OTHER than `ModelMesh.tsx` must be clean here.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/viewport/useModelLoader.ts
git commit -m "feat(viewport): seed move-transform state on model load

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: commitPosition bridge helper

**Files:**
- Create: `apps/desktop/src/renderer/src/components/viewport/gizmo/commitPosition.ts`
- Test: `apps/desktop/src/renderer/src/components/viewport/gizmo/commitPosition.test.ts`

**Interfaces:**
- Consumes: `Vec3` from `../../../lib/vec3`; `useSettingsStore.setObjectOffset`.
- Produces:
  - `export interface OffsetClient { setInstanceOffset(objIdx: number, instIdx: number, x: number, y: number, z: number): Promise<{ ok: boolean; error?: string }>; }`
  - `export async function commitPosition(client: OffsetClient, objectIdx: number, pos: Vec3, revertPos: Vec3, onError: (msg: string) => void): Promise<boolean>` — calls `setInstanceOffset(objectIdx, 0, ...)`; on ok updates the store to `pos` and returns true; on failure updates the store to `revertPos` (live drag updates have overwritten the pre-drag value), calls `onError(res.error)`, returns false. The caller (MoveGizmo) additionally reverts its group position when false.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/components/viewport/gizmo/commitPosition.test.ts`:

```ts
// apps/desktop/src/renderer/src/components/viewport/gizmo/commitPosition.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commitPosition, type OffsetClient } from './commitPosition';
import { useSettingsStore } from '../../../stores/useSettingsStore';

function makeClient(ok: boolean, error?: string): OffsetClient {
  return {
    setInstanceOffset: vi.fn(async () => (ok ? { ok: true } : { ok: false, error })),
  } as unknown as OffsetClient;
}

describe('commitPosition', () => {
  beforeEach(() => {
    useSettingsStore.setState({ positions: {}, initialPositions: {}, objectMinZ: {} });
  });

  it('calls the bridge with instance 0 and updates the store on success', async () => {
    useSettingsStore.getState().setObjectOffsets({ 0: [0, 0, 0] }, { 0: [0, 0, 0] }, {});
    const client = makeClient(true);
    const onError = vi.fn();
    const ok = await commitPosition(client, 0, [10, 20, 30], [0, 0, 0], onError);
    expect(ok).toBe(true);
    expect(client.setInstanceOffset).toHaveBeenCalledWith(0, 0, 10, 20, 30);
    expect(useSettingsStore.getState().positions[0]).toEqual([10, 20, 30]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reverts the store to revertPos and reports the error on failure', async () => {
    useSettingsStore.getState().setObjectOffsets({ 0: [5, 5, 5] }, { 0: [5, 5, 5] }, {});
    const client = makeClient(false, 'boom');
    const onError = vi.fn();
    const ok = await commitPosition(client, 0, [10, 20, 30], [5, 5, 5], onError);
    expect(ok).toBe(false);
    expect(useSettingsStore.getState().positions[0]).toEqual([5, 5, 5]);
    expect(onError).toHaveBeenCalledWith('boom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter desktop test -- commitPosition`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/renderer/src/components/viewport/gizmo/commitPosition.ts`:

```ts
// apps/desktop/src/renderer/src/components/viewport/gizmo/commitPosition.ts
import type { Vec3 } from '../../../lib/vec3';
import { useSettingsStore } from '../../../stores/useSettingsStore';

/** The bridge client surface commitPosition needs (slicerClient satisfies it). */
export interface OffsetClient {
  setInstanceOffset(
    objIdx: number,
    instIdx: number,
    x: number,
    y: number,
    z: number,
  ): Promise<{ ok: boolean; error?: string }>;
}

/** Commit a world offset for `objectIdx` (instance 0) through the bridge.
 *  Store updates are live during drags, so on failure the store is reset to
 *  `revertPos` (the drag-start position) before the error is reported.
 *  Returns success; on false the gizmo caller must also revert its group
 *  position. */
export async function commitPosition(
  client: OffsetClient,
  objectIdx: number,
  pos: Vec3,
  revertPos: Vec3,
  onError: (msg: string) => void,
): Promise<boolean> {
  const res = await client.setInstanceOffset(objectIdx, 0, pos[0], pos[1], pos[2]);
  if (res.ok) {
    useSettingsStore.getState().setObjectOffset(objectIdx, pos);
    return true;
  }
  useSettingsStore.getState().setObjectOffset(objectIdx, revertPos);
  onError(res.error ?? 'setInstanceOffset failed');
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter desktop test -- commitPosition`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/viewport/gizmo/commitPosition.ts apps/desktop/src/renderer/src/components/viewport/gizmo/commitPosition.test.ts
git commit -m "feat(viewport): shared bridge commit helper for the move tool

Single commit path for gizmo drags, body drags and the move panel;
store revert + error reporting on bridge failure.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: ModelMesh — DragControls body drag + MoveGizmo (TransformControls)

**Files:**
- Create: `apps/desktop/src/renderer/src/components/viewport/gizmo/MoveGizmo.tsx`
- Modify: `apps/desktop/src/renderer/src/components/viewport/ModelMesh.tsx` (full rewrite of the pointer-drag logic)

**Interfaces:**
- Consumes: `commitPosition` (Task 4), `useSettingsStore` transform state (Task 1), `useSlicerStore.setError`, `slicerClient`.
- Produces:
  - `MoveGizmo.tsx`:
    - `export interface GestureState { kind: 'none' | 'body' | 'gizmo'; dragStart: Vec3; }`
    - `export function MoveGizmo({ target, objectIdx, kind, setKind, gestureRef }: { target: THREE.Object3D; objectIdx: number; kind: 'none' | 'body' | 'gizmo'; setKind: (k: 'none' | 'body' | 'gizmo') => void; gestureRef: React.MutableRefObject<GestureState>; })` — renders the drei `TransformControls` and owns the gizmo gesture lifecycle (start/end, orbit disable/enable, commit). The `object` prop is the DragControls group — see the matrixAutoUpdate quirk below.
- Behavior contract:
  - Gizmo start (`onMouseDown`): `gestureRef.current = { kind: 'gizmo', dragStart: target.position.toArray() }`; `setKind('gizmo')`; disable OrbitControls.
  - Gizmo move (`onObjectChange`): copy `target.position` to the store (`setObjectOffset`) + `invalidate()` (TC does not invalidate in demand mode).
  - Gizmo end (`onDraggingChanged` with `e.value === false`): `setKind('none')`, re-enable OrbitControls, commit via `commitPosition`; on false, revert `target.position` to `gestureRef.current.dragStart` + `invalidate()`.

- [ ] **Step 1: Verify the risk (spike-lite, in-app)**

The design's step-1 risk: drei `TransformControls` with `object` + Z-up camera; drei `DragControls` `dragConfig.enabled` dynamic toggle; mutual exclusion on a handle press. These are verified end-to-end by the Task 7 e2e (axis-drag projection, panel assertions) plus a manual check:

Run: `pnpm --filter desktop dev` (real wasm, boot takes a while — be patient; `--soft` staging avoids re-staging).
Manually: Open `packages/slicer-wasm/fixtures/cube.stl`, click the cube → gizmo appears (X red arrow toward world +X, Y green toward +Y, Z blue up); drag the Z arrow — the cube lifts; drag the XY plane handle — moves on the plate; drag the cube body — moves on the plate; click another spot — gizmo follows the selection; orbit still works after each drag. If anything is misoriented (arrows not along world axes), stop and reassess before proceeding (the fix would be a custom `camera.up` handling or handle orientation — note it in the implementation-notes doc as a deviation and return to this task's design discussion).

Record what you verified in `doc/2026-08-16-move-gizmo-implementation-notes.md` (create it with a heading `## Spike-lite verification (Task 5)`).

- [ ] **Step 2: Create MoveGizmo**

```tsx
// apps/desktop/src/renderer/src/components/viewport/gizmo/MoveGizmo.tsx
// The move gizmo: drei TransformControls in translate mode, attached to the
// selected object's DragControls group. Owns the gizmo gesture lifecycle —
// mutual exclusion with the body drag (kind/gestureRef), orbit disable,
// demand-render invalidation, and the bridge commit on release.
import { useRef } from 'react';
import * as THREE from 'three';
import { TransformControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { slicerClient } from '../../../slicer/slicerClient';
import { commitPosition } from './commitPosition';
import type { Vec3 } from '../../../lib/vec3';

/** Shared gesture state between the body drag (ModelMesh) and the gizmo.
 *  `kind` mirrors into React state (re-render) and this ref (synchronous
 *  reads inside drag callbacks); `dragStart` feeds the commit-failure
 *  revert. */
export interface GestureState {
  kind: 'none' | 'body' | 'gizmo';
  dragStart: Vec3;
}

type GestureKind = GestureState['kind'];

export function MoveGizmo({ target, objectIdx, kind, setKind, gestureRef }: {
  target: THREE.Object3D;
  objectIdx: number;
  kind: GestureKind;
  setKind: (k: GestureKind) => void;
  gestureRef: React.MutableRefObject<GestureState>;
}) {
  // makeDefault OrbitControls (drei sets state.controls); narrow to what we use.
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null;
  const invalidate = useThree((s) => s.invalidate);
  const setObjectOffset = useSettingsStore((s) => s.setObjectOffset);
  const setError = useSlicerStore((s) => s.setError);
  // Whether TransformControls is mid-drag: a handle press WITHOUT movement
  // never fires dragging-changed(false), so onMouseUp needs to distinguish
  // "drag just ended" (already reset) from "press never became a drag".
  const draggingRef = useRef(false);

  function startDrag() {
    const p = target.position;
    gestureRef.current = { kind: 'gizmo', dragStart: [p.x, p.y, p.z] };
    setKind('gizmo');
    draggingRef.current = false;
    // TransformControls does not touch OrbitControls — mirror the body-drag
    // pattern and disable orbit while the gizmo is active.
    if (controls) controls.enabled = false;
  }

  function onObjectChange() {
    const p = target.position;
    setObjectOffset(objectIdx, [p.x, p.y, p.z]);
    invalidate(); // demand mode: TC mutations never invalidate on their own
  }

  function resetGesture() {
    gestureRef.current.kind = 'none';
    setKind('none');
    if (controls) controls.enabled = true;
  }

  async function endDrag() {
    const p = target.position;
    const ok = await commitPosition(
      slicerClient,
      objectIdx,
      [p.x, p.y, p.z],
      gestureRef.current.dragStart,
      (msg) => setError(`move: ${msg}`),
    );
    // The store was live during the drag; on bridge failure it is already
    // reverted by commitPosition — mirror that on the group.
    if (!ok) target.position.set(...gestureRef.current.dragStart);
    invalidate();
  }

  return (
    <TransformControls
      object={target}
      mode="translate"
      space="world"
      enabled={kind !== 'body'}
      onMouseDown={startDrag}
      onObjectChange={onObjectChange}
      onDraggingChanged={(e) => {
        draggingRef.current = e.value;
        if (e.value) return; // start handled in onMouseDown
        resetGesture();
        void endDrag();
      }}
      onMouseUp={() => {
        // Press without movement never dragged — close the gesture so the
        // body drag does not stay locked out (dragConfig enabled: false).
        if (!draggingRef.current && gestureRef.current.kind === 'gizmo') resetGesture();
      }}
    />
  );
}
```

- [ ] **Step 3: Rewrite ModelMesh**

```tsx
// apps/desktop/src/renderer/src/components/viewport/ModelMesh.tsx
// One loaded object: body drag via drei DragControls (world-XY at the
// object's current height — axisLock="z") and, when selected, the move
// gizmo. The DragControls group is the single world-transform owner; both
// drag systems write group.position and commit through the bridge on
// release (see gizmo/commitPosition.ts).
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { DragControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { slicerClient } from '../../slicer/slicerClient';
import type { LoadedObject } from './useModelLoader';
import { MoveGizmo, type GestureState } from './gizmo/MoveGizmo';
import { commitPosition } from './gizmo/commitPosition';

const BED_Z = 0;

export function ModelMesh({ data }: { data: LoadedObject }) {
  // DragControls forwards its ref to the group it renders — the group whose
  // position is the object's world offset.
  const groupRef = useRef<THREE.Group>(null);
  const invalidate = useThree((s) => s.invalidate);
  const selected = useSettingsStore((s) => s.selectedObject === data.buffer.objectIdx);
  const setSelected = useSettingsStore((s) => s.setSelectedObject);
  const setObjectOffset = useSettingsStore((s) => s.setObjectOffset);
  const setError = useSlicerStore((s) => s.setError);
  // React state drives re-renders (dragConfig.enabled / TC enabled props);
  // the ref gives drag callbacks synchronous reads.
  const [kind, setKind] = useState<GestureState['kind']>('none');
  const gestureRef = useRef<GestureState>({ kind: 'none', dragStart: [0, 0, 0] });
  // Reused scratch vector — avoid per-event allocation at pointer rate.
  const scratch = useMemo(() => new THREE.Vector3(), []);

  // drei's DragControls group has matrixAutoUpdate: false — position writes
  // (gizmo AND body drag) would never reach the rendered matrix. Seed the
  // offset and let matrixAutoUpdate compose matrix from position.
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.position.set(...data.buffer.offset);
    g.matrixAutoUpdate = true;
    invalidate();
  }, [data.buffer.offset, invalidate]);

  async function commit() {
    const g = groupRef.current;
    if (!g) return;
    const p = g.position;
    const ok = await commitPosition(
      slicerClient,
      data.buffer.objectIdx,
      [p.x, p.y, p.z],
      gestureRef.current.dragStart,
      (msg) => setError(`move: ${msg}`),
    );
    if (!ok) g.position.set(...gestureRef.current.dragStart);
    invalidate();
  }

  return (
    <>
      <DragControls
        ref={groupRef}
        autoTransform={false}
        axisLock="z"
        dragConfig={{ enabled: kind !== 'gizmo' }}
        onDragStart={() => {
          const g = groupRef.current!;
          gestureRef.current = { kind: 'body', dragStart: [g.position.x, g.position.y, g.position.z] };
          setKind('body');
        }}
        onDrag={(localMatrix) => {
          // Mutual exclusion guard: a gizmo-handle press also dispatches
          // pointer events to the mesh behind it; TC's onMouseDown sets kind
          // synchronously via the ref, but this callback can fire before the
          // re-render lands. Only the body gesture writes positions.
          if (gestureRef.current.kind !== 'body') return;
          const g = groupRef.current;
          if (!g) return;
          // drei computed the intended world position for us (autoTransform
          // is off) — apply it through position so matrixAutoUpdate picks it
          // up, and mirror to the store for the move panel.
          scratch.setFromMatrixPosition(localMatrix);
          g.position.copy(scratch);
          setObjectOffset(data.buffer.objectIdx, [scratch.x, scratch.y, scratch.z]);
          invalidate();
        }}
        onDragEnd={() => {
          gestureRef.current.kind = 'none';
          setKind('none');
          void commit();
        }}
      >
        <mesh
          geometry={data.geometry}
          onClick={(e) => {
            e.stopPropagation();
            setSelected(data.buffer.objectIdx);
          }}
        >
          <meshStandardMaterial
            color={selected ? '#3b82f6' : '#cbd5e1'}
            roughness={0.6}
            metalness={0.1}
          />
        </mesh>
      </DragControls>
      {selected && groupRef.current && (
        <MoveGizmo
          target={groupRef.current}
          objectIdx={data.buffer.objectIdx}
          kind={kind}
          setKind={setKind}
          gestureRef={gestureRef}
        />
      )}
    </>
  );
}
```

Notes:
- `BED_Z` is no longer used — delete it (the bed-plane constraint is now `axisLock="z"`, which preserves the object's current height instead of forcing Z=0; see the design §Interaction).
- The old `onPointerDown`/`onPointerMove`/`endDrag`/`select`/`controls` machinery is deleted — drei `DragControls` handles pointer capture, orbit disable/enable (it toggles the makeDefault controls itself), and `invalidate()`.
- `DragControls`' `ref` type is `ForwardRefComponent<DragControlsProps, THREE.Group>` — `useRef<THREE.Group>(null)` matches.

- [ ] **Step 4: Verify**

1. Run: `pnpm --filter desktop typecheck` — MUST pass now (this resolves the Task 1 leftover if any).
2. Run: `pnpm --filter desktop test` — all unit tests green.
3. Run: `pnpm --filter desktop test:e2e` — the EXISTING full-v1-flow test must still pass. Note: its click-at-center + drag now lands on the gizmo (center free-move box) instead of the body — that is fine; the assertions (mid-drag pixels change) hold either way.

Expected: typecheck clean, unit green, e2e green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/viewport/ModelMesh.tsx apps/desktop/src/renderer/src/components/viewport/gizmo/MoveGizmo.tsx
git commit -m "feat(viewport): move gizmo + DragControls body drag

Replace the hand-rolled pointer-drag with drei DragControls (axisLock z,
world-XY at current height) and add the TransformControls move gizmo on
selection. Both write the DragControls group position; a synchronous
gesture ref + React kind state mutually exclude the two gestures; the
bridge commit is shared via commitPosition.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: MovePanel + SettingsPanel wiring

**Files:**
- Create: `apps/desktop/src/renderer/src/components/settings/MovePanel.tsx`
- Modify: `apps/desktop/src/renderer/src/components/settings/SettingsPanel.tsx`

**Interfaces:**
- Consumes: `commitPosition`, `computeDropZ`, `formatPosition`, `parseNumberInput` (Task 2/4), store `positions`/`initialPositions`/`objectMinZ`/`selectedObject`, `slicerClient`.
- Produces: `<MovePanel />` — renders nothing when no object is selected (or its transform maps are unseeded). `data-testid` attributes: `move-panel`, `move-x`, `move-y`, `move-z`, `move-drop-bed`, `move-reset`.

- [ ] **Step 1: Create MovePanel**

```tsx
// apps/desktop/src/renderer/src/components/settings/MovePanel.tsx
// Gizmo options panel (sidebar) for the move tool: numeric X/Y/Z position
// inputs (commit on blur/Enter), Drop to bed, Reset. Reads and writes the
// store's per-object transform maps through the shared bridge commit.
import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { slicerClient } from '../../slicer/slicerClient';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { commitPosition } from '../viewport/gizmo/commitPosition';
import { computeDropZ, formatPosition, parseNumberInput } from '../viewport/transformMath';
import type { Vec3 } from '../../lib/vec3';

const AXES = ['x', 'y', 'z'] as const;

export function MovePanel() {
  const objectIdx = useSettingsStore((s) => s.selectedObject);
  const positions = useSettingsStore((s) => s.positions);
  const initialPositions = useSettingsStore((s) => s.initialPositions);
  const objectMinZ = useSettingsStore((s) => s.objectMinZ);
  const setError = useSlicerStore((s) => s.setError);
  const current = objectIdx != null ? positions[objectIdx] : undefined;
  // Local edit drafts; reset whenever the committed position changes
  // (viewport drags, commits, selection change).
  const [draft, setDraft] = useState<[string, string, string] | null>(null);

  const currentKey = current?.join(',') ?? '';
  useEffect(() => { setDraft(null); }, [objectIdx, currentKey]);

  if (objectIdx == null || !current || objectMinZ[objectIdx] === undefined) return null;

  async function commitTo(pos: Vec3) {
    await commitPosition(slicerClient, objectIdx, pos, current, (msg) => setError(`move: ${msg}`));
    // commitPosition updates the store (pos on success, current on failure);
    // the draft resyncs through the currentKey effect either way.
  }

  function submitAxis(axis: number, text: string) {
    const parsed = parseNumberInput(text);
    if (parsed === null) {
      setDraft(null); // invalid input → show the committed value again
      return;
    }
    const next = [...current] as Vec3;
    next[axis] = parsed;
    void commitTo(next);
  }

  return (
    <section data-testid="move-panel">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Move</h2>
      <div className="space-y-1">
        {AXES.map((axis, i) => (
          <div key={axis} className="flex items-center gap-2 py-1">
            <Label className="w-10 shrink-0 text-xs text-muted-foreground">{axis.toUpperCase()}</Label>
            <Input
              data-testid={`move-${axis}`}
              className="flex-1"
              value={draft?.[i] ?? formatPosition(current[i])}
              onChange={(e) => {
                const d = [...(draft ?? current.map(formatPosition))] as [string, string, string];
                d[i] = e.target.value;
                setDraft(d);
              }}
              onBlur={(e) => submitAxis(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          variant="secondary"
          data-testid="move-drop-bed"
          onClick={() => void commitTo([current[0], current[1], computeDropZ(objectMinZ[objectIdx])])}
        >
          Drop to bed
        </Button>
        <Button
          size="sm"
          variant="secondary"
          data-testid="move-reset"
          onClick={() => void commitTo(initialPositions[objectIdx])}
        >
          Reset
        </Button>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Wire into SettingsPanel**

In `SettingsPanel.tsx`, add the import and render `<MovePanel />` as the first child of the root `div`:

```tsx
import { MovePanel } from './MovePanel';
// ...
return (
  <div className="space-y-4 p-3">
    <MovePanel />
    <section>…</section>
    …
```

- [ ] **Step 3: Verify**

1. Run: `pnpm --filter desktop typecheck` — PASS.
2. Run: `pnpm --filter desktop test` — PASS.
3. Manual (dev app): select the cube — "Move" section appears with `0.000`/`0.000`/`0.000`; type `50` into X and blur → the cube moves +50 mm and the input shows `50.000`; type garbage into Y and blur → reverts to the committed value; "Drop to bed" after lifting Z returns it to `0.000`; "Reset" after moving returns all to `0.000`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/settings/MovePanel.tsx apps/desktop/src/renderer/src/components/settings/SettingsPanel.tsx
git commit -m "feat(settings): move panel with numeric inputs, drop to bed, reset

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: e2e — gizmo coverage

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/viewport/Scene.tsx` (test projection hook)
- Modify: `apps/desktop/e2e/app.e2e.ts` (new test + comment touch-up)

**Interfaces:**
- Consumes: the full move-tool stack from Tasks 1-6.
- Produces: `window.__orcaE2e.projectWorldToScreen(p: [number, number, number]): { x: number; y: number } | null` in mock/e2e builds only — lets the test press exactly on the X arrow's shaft.

- [ ] **Step 1: Add the e2e projection hook to Scene**

In `Scene.tsx` (inside the Canvas — has access to `useThree`):

```tsx
// apps/desktop/src/renderer/src/components/viewport/Scene.tsx
import { useEffect } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useModelLoader } from './useModelLoader';
import { BedPlate } from './BedPlate';
import { ModelMesh } from './ModelMesh';
import { useSliceResult } from './useSliceResult';
import { ToolpathLines } from './ToolpathLines';
import { SlicedMesh } from './SlicedMesh';

export function Scene() {
  const objects = useModelLoader();
  const { toolpath, mesh } = useSliceResult();
  // Test-only projection hook (mock/e2e builds): Playwright needs exact
  // canvas coordinates to start an axis-arrow drag on the gizmo's shaft.
  // No-op in production builds (VITE_USE_MOCK is unset).
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  useEffect(() => {
    if (!(import.meta.env as { VITE_USE_MOCK?: string }).VITE_USE_MOCK) return;
    const w = window as unknown as {
      __orcaE2e?: { projectWorldToScreen(p: [number, number, number]): { x: number; y: number } | null };
    };
    w.__orcaE2e = {
      projectWorldToScreen(p) {
        const v = new THREE.Vector3(p[0], p[1], p[2]).project(camera);
        return { x: (v.x + 1) * 0.5 * size.width, y: (1 - v.y) * 0.5 * size.height };
      },
    };
    return () => { delete w.__orcaE2e; };
  }, [camera, size]);

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[100, 150, 200]} intensity={1.2} />
      <BedPlate />
      {objects.map((o) => (
        <ModelMesh key={o.buffer.objectIdx} data={o} />
      ))}
      {mesh && <SlicedMesh data={mesh} />}
      {toolpath && <ToolpathLines data={toolpath} />}
    </>
  );
}
```

- [ ] **Step 2: Add the gizmo e2e test**

In `apps/desktop/e2e/app.e2e.ts`, after the existing `test(...)` block, add:

```ts
// The move gizmo + body drag + move panel, end to end. Projection comes
// from the __orcaE2e hook (mock/e2e builds only) so drags start exactly on
// the X arrow's shaft; commits are asserted through the move panel's
// numeric inputs, which mirror the store's live position.
test('move gizmo: select, axis drag, numeric input, drop to bed, reset', async () => {
  const { app } = await launchApp();
  try {
    const page = await app.firstWindow();
    const diag = attachRendererDiagnostics(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    try {
      await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('btn-open').click();
      await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });

      const canvas = page.getByTestId('viewport').locator('canvas');
      const box = await canvas.boundingBox();
      if (!box) throw new Error('viewport canvas has no bounding box');
      const glRegion = { x: box.x, y: box.y, width: box.width, height: Math.max(0, box.height - 130) };
      const shot = () => page.screenshot({ clip: glRegion });
      const project = (p: [number, number, number]) =>
        page
          .evaluate(
            (pt) =>
              (window as unknown as {
                __orcaE2e?: { projectWorldToScreen(q: [number, number, number]): { x: number; y: number } | null };
              }).__orcaE2e?.projectWorldToScreen(pt),
            p,
          )
          .then((s) => (s ? { x: box.x + s.x, y: box.y + s.y } : null));

      // Select the cube (mock model sits at the origin → canvas center) —
      // the move panel appears.
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(page.getByTestId('move-panel')).toBeVisible();
      await expect(page.getByTestId('move-x')).toHaveValue('0.000');

      // Gizmo renders once selected: pixels near the object change.
      const selectedShot = await shot();

      // X-axis arrow drag: press on the shaft 10 mm out, drag along it to
      // +45 mm (shaft extends ~30 mm at this camera distance; 10 mm is
      // mid-shaft, past the plane handles).
      const xStart = await project([10, 0, 0]);
      const xEnd = await project([45, 0, 0]);
      if (!xStart || !xEnd) throw new Error('X-arrow projection unavailable');
      await page.mouse.move(xStart.x, xStart.y);
      await page.mouse.down();
      await page.mouse.move(xEnd.x, xEnd.y, { steps: 5 });
      // Mid-drag: the mesh follows (gizmo objectChange invalidates the
      // demand-mode frame).
      await expect
        .poll(async () => (await shot()).equals(selectedShot), { timeout: 10_000 })
        .toBe(false);
      await page.mouse.up();
      // Commit round-trips the bridge: the panel reflects the new X.
      await expect(page.getByTestId('move-x')).toHaveValue('45.000', { timeout: 10_000 });

      // Numeric input commits on Enter.
      await page.getByTestId('move-x').fill('35');
      await page.getByTestId('move-x').press('Enter');
      await expect(page.getByTestId('move-x')).toHaveValue('35.000');

      // Garbage input is rejected — the input reverts to the committed value.
      await page.getByTestId('move-y').fill('nope');
      await page.getByTestId('move-y').press('Enter');
      await expect(page.getByTestId('move-y')).toHaveValue('0.000');

      // Lift with the Z input, then Drop to bed returns it to 0.
      await page.getByTestId('move-z').fill('10');
      await page.getByTestId('move-z').press('Enter');
      await expect(page.getByTestId('move-z')).toHaveValue('10.000');
      await page.getByTestId('move-drop-bed').click();
      await expect(page.getByTestId('move-z')).toHaveValue('0.000');

      // Reset restores the load-time position (all zeros).
      await page.getByTestId('move-x').fill('99');
      await page.getByTestId('move-x').press('Enter');
      await expect(page.getByTestId('move-x')).toHaveValue('99.000');
      await page.getByTestId('move-reset').click();
      await expect(page.getByTestId('move-x')).toHaveValue('0.000');
      await expect(page.getByTestId('move-y')).toHaveValue('0.000');
      await expect(page.getByTestId('move-z')).toHaveValue('0.000');
    } catch (err) {
      await diag.dump();
      throw err;
    }
  } finally {
    await app.close();
  }
});
```

Also update the stale comment in the EXISTING drag test: it says the mid-drag invalidate comes from `ModelMesh`'s `onPointerMove` — the click at the canvas center may now start a gizmo free-move drag instead of a body drag, and the invalidate comes from the gizmo's `onObjectChange`. Replace that comment block with:

```ts
// Drag must invalidate the demand-mode frame while the pointer is held:
// with the gizmo mounted, the click at the object's center lands on the
// gizmo's free-move box (or the body — both invalidate mid-drag). The
// assertion is pixels changed before release; the commit happens on
// mouse.up (covered in detail by the move-gizmo test below).
```

- [ ] **Step 3: Run and iterate**

Run: `pnpm --filter desktop test:e2e`
Expected: both tests pass. If the axis-drag assertion fails (no pixel change mid-drag / wrong committed value):
- Wrong committed X: the drag didn't hit the X arrow (started on another handle or nothing). Adjust `xStart` (e.g. `[12, 0, 0]`), or check the projection hook math against the screenshot (dump a `page.screenshot({ path })` in a temp step and Read the image to confirm where the arrows render).
- Panel not visible after click: the click missed the cube — check the screenshot.
- If `__orcaE2e` is undefined in the page: the mock build doesn't set `VITE_USE_MOCK` in the renderer env — verify the `--mode e2e` wiring in `electron.vite.config.ts` (the playwright config comment says `VITE_USE_MOCK=1` is set for `test:e2e`); if the variable name differs, align the hook's check.

Iterate on the screenshot + diagnostics until green.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/viewport/Scene.tsx apps/desktop/e2e/app.e2e.ts
git commit -m "test(e2e): move gizmo axis drag, panel inputs, drop to bed, reset

__orcaE2e world→screen projection hook (mock/e2e builds only) so drags
start exactly on the X arrow shaft.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Docs + plan updates

**Files:**
- Create: `doc/2026-08-16-move-gizmo-implementation-notes.md`
- Modify: `doc/high_level_dev_plan.md`
- Modify: `spec/Grand Plan.md`

- [ ] **Step 1: Write implementation notes**

Create `doc/2026-08-16-move-gizmo-implementation-notes.md` following the repo's established pattern (see `doc/2026-08-15-m4-preset-management-implementation-notes.md`). Sections:
- **Status**: delivered 2026-08-16.
- **What shipped**: move gizmo (drei TransformControls, translate/world), body drag (drei DragControls, axisLock z), move panel (X/Y/Z inputs, Drop to bed, Reset), store transform maps, shared commit path.
- **Spike-lite verification (Task 5)**: what the manual dev-app check confirmed (gizmo orientation in Z-up, arrow drags, exclusion, orbit restore) — or any deviation found.
- **Key mechanics discovered**: `DragControls` matrixAutoUpdate quirk + the `autoTransform={false}` fix; mutual exclusion via `gestureRef` + `kind` state (r3f dispatches handle presses to the mesh behind); drei auto-disables the makeDefault OrbitControls for body drags; TC `onDraggingChanged`/`onMouseDown` semantics.
- **Verification**: unit counts, typecheck, e2e results (both specs), any e2e iteration notes (e.g. adjusted X-arrow start point).

- [ ] **Step 2: Update the dev plan**

In `doc/high_level_dev_plan.md`, add after Milestone 4:

```markdown
### Milestone 5 — Move Gizmo

> **Status: delivered 2026-08-16.** Full move tool in the 3D viewport:
> drei TransformControls gizmo (translate, world space) on selection — axis
> arrows + plane handles, Z lift; body drag via drei DragControls
> (axisLock z — world-XY at the object's current height) replacing the M2
> hand-rolled pointer drag; sidebar move panel (numeric X/Y/Z, Drop to bed,
> Reset); per-object transform state in the settings store with a shared
> bridge commit path (commitPosition) that reverts on failure. Flip
> buttons, snap, multi-select and multi-instance remain deferred.
> See `doc/2026-08-16-move-gizmo-{design,implementation-notes}.md`.
```

- [ ] **Step 3: Update the Grand Plan**

In `spec/Grand Plan.md`, add after Milestone 4:

```markdown
## Milestone 5: Move Gizmo

> [!info] Target: **2026-08-16** (delivered)
>
> Design: `doc/2026-08-16-move-gizmo-design.md`; implementation notes:
> `doc/2026-08-16-move-gizmo-implementation-notes.md`. The first of the
> gizmo family (design phase E's "basic move-on-plate" is replaced by the
> full move tool).

- [x] TransformControls move gizmo on selection (axis arrows + plane
      handles, Z-up verified, world space)
- [x] Body drag via drei DragControls replacing the M2 hand-rolled pointer
      drag (axisLock z — world-XY at current height)
- [x] Mutual exclusion between gizmo and body drags (gesture ref + state)
- [x] Move panel: numeric X/Y/Z inputs, Drop to bed, Reset (bridge commit
      via commitPosition with store/group revert on failure)
- [x] Per-object transform state (positions / initialPositions / objectMinZ)
- [x] e2e: gizmo axis drag, panel inputs, drop to bed, reset; existing
      v1-flow e2e still green
```

And amend the M5+ line to credit the move gizmo:

```markdown
- [ ] Gizmos: rotate/scale/cut/measure/arrange/orient (move delivered in
      Milestone 5)
```

- [ ] **Step 4: Final verification sweep**

Run all three gates one last time: `pnpm --filter desktop test`, `pnpm --filter desktop typecheck`, `pnpm --filter desktop test:e2e`. All green.

- [ ] **Step 5: Commit**

```bash
git add doc/2026-08-16-move-gizmo-implementation-notes.md doc/high_level_dev_plan.md spec/Grand\ Plan.md
git commit -m "docs: move gizmo milestone delivered — notes + plan updates

Co-Authored-By: Claude <noreply@anthropic.com>"
```
