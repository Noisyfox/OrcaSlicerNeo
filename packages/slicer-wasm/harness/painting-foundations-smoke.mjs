import { fixtureProfileOptions } from './profile-installer.mjs';
// Step16 real bridge: independent native selection and preview-only resources.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadModuleFactory } from "./run-slice.mjs";
import {
  createNodeProfileSource,
  installProfilePackages,
} from "./profile-installer.mjs";
import { buildPaintingChannelProject } from "./painted-facet-fixture-builder.mjs";
import { readZipEntries, writeStoredZip } from "./native-3mf-parser.mjs";
const Module = await (
  await loadModuleFactory(process.argv[2])
)({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(
  Module,
  createNodeProfileSource(
    resolve(import.meta.dirname, "../../profile-resources/dist"),
  ),
);
function call(name, types = [], args = []) {
  const ptr = Number(Module.ccall(name, "number", types, args));
  try {
    return JSON.parse(Module.UTF8ToString(ptr));
  } finally {
    Module._free(ptr);
  }
}
const cmd = (name, value) => call(name, ["string"], [JSON.stringify(value)]);
const ok = (x) => {
  assert.equal(x.ok, true, JSON.stringify(x));
  return x;
};
const reject = (x) => assert.equal(typeof x.error, "string", JSON.stringify(x));
const source = await buildPaintingChannelProject();
const original = readZipEntries(source);
function fixture(gap = false) {
  return writeStoredZip(
    original.map((entry) => {
      if (entry.name !== "3D/3dmodel.model") return entry;
      let index = 0;
      let xml = new TextDecoder()
        .decode(entry.content)
        .replace(/<triangle\b[^>]*\/>/g, (tr) => {
          let out = tr.replace(
            / paint_(color|supports|fuzzy_skin)="[^"]*"/g,
            "",
          );
          const attrs = gap
            ? index === 0
              ? ' paint_supports="8"'
              : ""
            : ` paint_supports="${index % 2 ? "8" : "4"}" paint_color="${index % 2 ? "8" : "4"}" paint_fuzzy_skin="${index % 2 ? "" : "4"}"`;
          index++;
          return out.replace("/>", `${attrs}/>`);
        });
      if (gap)
        xml = xml.replace(/<vertex\b[^>]*>/g, (tr) =>
          tr.replace(/="(-?)10"/g, (_, sign) => `="${sign}1"`),
        );
      return { ...entry, content: new TextEncoder().encode(xml) };
    }),
  );
}
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function event() {
  const projection = [...identity];
  projection[0] = 0.025;
  projection[5] = 0.025;
  projection[10] = -0.005;
  const view = [...identity];
  view[12] = -100;
  view[13] = -100;
  view[14] = -100;
  return { pointer: [95, 92.5], viewport: [0, 0, 200, 200], projection, view };
}
const context = {
  selection: { mode: "object", objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null,
  gizmo: null,
  nativeScopedConfig: {},
};
let session, history;
function load(bytes) {
  const ptr = Number(Module._malloc(bytes.length));
  Module.HEAPU8.set(bytes, ptr);
  try {
    ok(
      call(
        "orc_load_project",
        ["pointer", "number", "number", "string"],
        [ptr, bytes.length, 0, "foundations.3mf"],
      ),
    );
  } finally {
    Module._free(ptr);
  }
  cmd("orc_history_reset", context);
}
function open(channel) {
  history = ok(cmd("orc_history_session_open", {})).sessionId;
  const object = ok(call("orc_get_model_structure")).objects[0];
  session = ok(
    cmd("orc_painting_session_open", {
      version: 1,
      channel,
      historySessionId: history,
      objectId: object.id,
      instanceId: object.instances[0].id,
    }),
  ).session;
}
const handle = () => ({
  version: 1,
  channel: session.channel,
  sessionId: session.id,
  revision: session.revision,
});
function update(name, req = {}) {
  const reply = ok(cmd(name, { ...handle(), ...req }));
  session = { ...session, revision: reply.revision, strokeId: reply.strokeId };
  return reply;
}
const read = () => ok(cmd("orc_painting_session_read", handle())).session;
const preview = (tool, settings, pointer) =>
  update("orc_painting_preview", {
    tool,
    settings,
    ...(pointer ? { event: pointer } : {}),
  });
const cancel = () =>
  update("orc_painting_stroke_cancel", { strokeId: session.strokeId });
function savedFields() {
  const result = ok(call("orc_export_project"));
  try {
    const entries = readZipEntries(
      Module.HEAPU8.slice(
        result.bytes_ptr,
        result.bytes_ptr + result.bytes_length,
      ),
    );
    const xml = new TextDecoder().decode(
      entries.find((e) => e.name === "3D/3dmodel.model").content,
    );
    return [...xml.matchAll(/<triangle\b[^>]*\/>/g)].map(([tr]) =>
      Object.fromEntries(
        ["paint_color", "paint_supports", "paint_seam", "paint_fuzzy_skin"].map(
          (attr) => [
            attr,
            tr.match(new RegExp(`${attr}="([^"]*)"`))?.[1] ?? "",
          ],
        ),
      ),
    );
  } finally {
    Module._free(result.bytes_ptr);
  }
}
const observe = () => ({
  history: call("orc_history_status"),
  plates: call("orc_get_plate_session_snapshot"),
  fields: savedFields(),
});
function geometry(knownResourceIds = []) {
  const result = ok(
    cmd("orc_painting_geometry", { ...handle(), knownResourceIds }),
  );
  try {
    return {
      parts: result.parts,
      candidates: result.candidates,
      resources: result.resources.map((r) => ({
        ...r,
        vertices: [
          ...new Float32Array(
            Module.HEAPU8.slice(r.vertex_ptr, r.vertex_ptr + r.vertexCount * 24)
              .buffer,
          ),
        ],
      })),
    };
  } finally {
    Module.ccall(
      "orc_painting_geometry_release",
      "void",
      ["string"],
      [JSON.stringify({ version: 1, leaseId: result.leaseId })],
    );
  }
}
ok(cmd("orc_init", JSON.parse(fixtureProfileOptions(Module))));
for (const channel of ["mmu", "support", "fuzzy"]) {
  load(fixture());
  open(channel);
  const before = observe();
  const tool = channel === "mmu" ? "region" : "smartFill";
  preview(tool, { state: 0, angle: 0 }, event());
  const candidate = read().candidate;
  assert.equal(
    candidate.selectedFacetCount,
    channel === "mmu" ? 1 : 2,
    "geometry ignores adjacent states only for SmartFill",
  );
  assert.deepEqual(
    observe(),
    before,
    "preview leaves all four streams, dirty/history and plate revisions unchanged",
  );
  reject(
    cmd("orc_painting_stroke_begin", {
      ...handle(),
      tool,
      settings: { state: 0, angle: 1 },
      event: event(),
      candidateRevision: session.revision,
    }),
  );
  reject(
    cmd("orc_painting_stroke_begin", {
      ...handle(),
      tool,
      settings: { state: 0, angle: 0 },
      event: event(),
      candidateRevision: session.revision - 1,
    }),
  );
  update("orc_painting_stroke_begin", {
    tool,
    settings: { state: 0, angle: 0 },
    event: event(),
    candidateRevision: session.revision,
  });
  assert.deepEqual(
    read().parts.map((p) => p.facetCounts),
    candidate.parts.map((p) => p.facetCounts),
  );
  cancel();
  assert.deepEqual(observe(), before);
  if (channel === "support") {
    const highlight = preview("overhang", { overhangAngle: 45 });
    assert.equal(highlight.candidateRevision, null);
    const g = geometry();
    const highlights = g.candidates.filter((c) => c.kind === "overhang");
    assert.equal(highlights.length, session.parts.length);
    assert.equal(g.resources.find((r) => r.kind === "overhang").vertexCount, 6);
    const keys = highlights.map((r) => r.resourceId);
    preview("smartFill", { state: 1, angle: 30 }, event());
    const together = geometry(
      [...g.parts, ...highlights].map((r) => r.resourceId),
    );
    assert.deepEqual(
      together.candidates
        .filter((c) => c.kind === "overhang")
        .map((r) => r.resourceId),
      keys,
    );
    assert.equal(
      together.resources.filter((r) => r.kind === "overhang").length,
      0,
      "unchanged hover does not allocate highlights again",
    );
    for (const tool of ["circle", "sphere", "smartFill"]) {
      update("orc_painting_stroke_begin", {
        tool,
        settings: {
          state: 0,
          radius: 50,
          angle: 30,
          overhangAngle: 45,
          restrictToOverhangs: true,
        },
        event: event(),
      });
      assert.deepEqual(
        read().parts.map((p) => p.facetCounts),
        session.parts.map((p) => p.facetCounts),
        "upward hit cannot be painted",
      );
      assert.ok(
        geometry().candidates.some((r) => r.kind === "overhang"),
        "highlight survives drawing",
      );
      cancel();
    }
    assert.deepEqual(observe(), before);
    preview("overhang", { overhangAngle: null });
    assert.equal(
      geometry().candidates.filter((r) => r.kind === "overhang").length,
      0,
    );
    assert.deepEqual(observe(), before, "clearing highlights is non-mutating");
    preview("overhang", { overhangAngle: 45 });
    assert.ok(geometry().candidates.some((r) => r.kind === "overhang"));
    assert.deepEqual(
      observe(),
      before,
      "re-enabling highlights is non-mutating",
    );
    reject(
      cmd("orc_painting_stroke_begin", {
        ...handle(),
        tool: "overhang",
        settings: { overhangAngle: 45 },
      }),
    );
    update("orc_painting_stroke_begin", {
      tool: "smartFill",
      settings: { state: 0, angle: 0 },
      event: event(),
    });
    update("orc_painting_stroke_commit", { strokeId: session.strokeId });
    assert.ok(geometry().candidates.some((r) => r.kind === "overhang"));
    const after = savedFields();
    assert.deepEqual(
      after.map(({ paint_supports, ...rest }) => rest),
      before.fields.map(({ paint_supports, ...rest }) => rest),
      "other three trees byte-independent after commit",
    );
  }
  if (channel === "fuzzy") {
    update("orc_painting_stroke_begin", {
      tool: "smartFill",
      settings: { state: 0, angle: 0 },
      event: event(),
    });
    update("orc_painting_stroke_commit", { strokeId: session.strokeId });
    const after = savedFields();
    assert.deepEqual(
      after.map(({ paint_fuzzy_skin, ...rest }) => rest),
      before.fields.map(({ paint_fuzzy_skin, ...rest }) => rest),
      "Fuzzy SmartFill preserves other three streams",
    );
    assert.notDeepEqual(
      after,
      before.fields,
      "Fuzzy SmartFill commits native annotations",
    );
  }
  ok(cmd("orc_history_session_close", { sessionId: history }));
}
load(fixture(true));
open("support");
const before = observe();
preview("gap", { gapArea: 3 });
const candidate = read().candidate;
assert.equal(candidate.gapRegionCount, 1);
const gap = geometry().resources.filter((r) => r.kind === "gap");
assert.equal(gap.length, 1);
assert.equal(gap[0].groups[0][0], 0);
assert.deepEqual(observe(), before);
update("orc_painting_stroke_begin", {
  tool: "gap",
  settings: { gapArea: 3 },
  candidateRevision: session.revision,
});
assert.deepEqual(
  read().parts.map((p) => p.facetCounts),
  candidate.parts.map((p) => p.facetCounts),
);
update("orc_painting_stroke_commit", { strokeId: session.strokeId });
assert.equal(read().parts[0].facetCounts[2], 0);
const after = savedFields();
assert.deepEqual(
  after.map(({ paint_supports, ...rest }) => rest),
  before.fields.map(({ paint_supports, ...rest }) => rest),
);
ok(cmd("orc_history_session_close", { sessionId: history }));
console.log(
  "Step16 native SmartFill vs Region, candidate parity/staleness, nonmutation, independent stable overhang resources/restricted strokes, Support Gap/state0 and four-field independence PASS",
);
