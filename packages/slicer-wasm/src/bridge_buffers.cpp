// packages/slicer-wasm/src/bridge_buffers.cpp
// ----------------------------------------------------------------
// Assembles the binary slice-result buffers from libslic3r data.
// Toolpath: GCodeProcessorResult moves (post-processed gcode).
// Sliced mesh: per-layer slice triangulation over PrintObject layers.
// The layout is the M2 bridge contract (Task 1 mock mirror).
// ----------------------------------------------------------------
#include "bridge_buffers.hpp"

// Drift at the pinned SHA: GCodeProcessor.hpp lives under GCode/; the
// brief's SlicesToTriangleMeshParams/SlicesToTriangleMesh (TriangleMesh
// Slicer.hpp) and ExPolygon::triangulate_self()/triangles do NOT exist
// here — the per-layer triangulator is triangulate_expolygons_3d
// (Tesselate.hpp), the same cap tesselation the missing Prusa API used.
// PrintObject is defined in Print.hpp (no PrintObject.hpp at this SHA).
#include "libslic3r/GCode/GCodeProcessor.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/Tesselate.hpp"
// Layer::slices (SurfaceCollection) / Layer::print_z — the brief's
// per-layer loop uses the complete Layer type (Layer.hpp -> Surface
// Collection.hpp -> Surface.hpp -> ExPolygon.hpp).
#include "libslic3r/Layer.hpp"

#include <map>
#include <string>

namespace bridge {

using Slic3r::ExtrusionRole;
using Slic3r::GCodeProcessorResult;
using Slic3r::Print;

// Feature palette (id = ExtrusionRole value, name/color for the client).
struct FeatureInfo { std::string name; unsigned char color[3]; };

const std::map<ExtrusionRole, FeatureInfo>& feature_palette() {
    static const std::map<ExtrusionRole, FeatureInfo> palette = {
        {ExtrusionRole::erPerimeter,             {"ExternalPerimeter", {255, 140, 0}}},
        {ExtrusionRole::erExternalPerimeter,     {"ExternalPerimeter", {255, 140, 0}}},
        {ExtrusionRole::erOverhangPerimeter,     {"OverhangPerimeter", {255, 0, 0}}},
        {ExtrusionRole::erInternalInfill,        {"InternalInfill",    {0, 160, 255}}},
        {ExtrusionRole::erSolidInfill,           {"SolidInfill",       {255, 255, 0}}},
        {ExtrusionRole::erTopSolidInfill,        {"TopSolidInfill",    {255, 0, 255}}},
        {ExtrusionRole::erIroning,               {"Ironing",           {128, 128, 128}}},
        // Drift at the pinned SHA: no erBridges enumerator — the Orca
        // bridge-role is erBridgeInfill (Bridge color entry as briefed).
        {ExtrusionRole::erBridgeInfill,          {"Bridge",            {0, 255, 255}}},
        {ExtrusionRole::erSkirt,                 {"Skirt",             {0, 255, 128}}},
        {ExtrusionRole::erSupportMaterial,       {"Support",           {255, 128, 0}}},
        {ExtrusionRole::erSupportMaterialInterface, {"SupportInterface", {200, 100, 50}}},
    };
    return palette;
}

struct ToolpathBuffers {
    MallocBuffer positions;   // Float32 xyz per vertex
    MallocBuffer layers;      // Uint32 layer_id per vertex
    MallocBuffer features;    // Uint32 palette index per vertex
    // Local palette: index into this vector == the id recorded in
    // `features`. Kept local (0..N-1) so the JSON feature list in
    // orc_get_slice_result lines up with the buffer values 1:1.
    std::vector<std::pair<ExtrusionRole, FeatureInfo>> palette_used;
};

ToolpathBuffers build_toolpath(const GCodeProcessorResult& result) {
    ToolpathBuffers out;
    const auto& palette = feature_palette();
    std::map<ExtrusionRole, std::uint32_t> feature_ids;
    for (const auto& mv : result.moves) {
        // Drift at the pinned SHA: MoveVertex::extrusion_role is the
        // extrusion-role field (MoveVertex::type is the EMoveType move
        // classification); the palette is keyed by ExtrusionRole.
        const auto it = palette.find(mv.extrusion_role);
        if (it == palette.end()) continue; // travel/unmapped: not drawn in v1
        out.positions.appendF32(static_cast<float>(mv.position.x()));
        out.positions.appendF32(static_cast<float>(mv.position.y()));
        out.positions.appendF32(static_cast<float>(mv.position.z()));
        out.layers.appendU32(static_cast<std::uint32_t>(mv.layer_id < 0 ? 0 : mv.layer_id));
        auto fid = feature_ids.find(mv.extrusion_role);
        if (fid == feature_ids.end()) {
            fid = feature_ids.emplace(mv.extrusion_role, static_cast<std::uint32_t>(out.palette_used.size())).first;
            out.palette_used.emplace_back(mv.extrusion_role, it->second);
        }
        out.features.appendU32(fid->second);
    }
    return out;
}

struct MeshBuffers {
    MallocBuffer positions;   // Float32 xyz per vertex
    MallocBuffer indices;     // Uint32 index triples
    MallocBuffer layer_ids;   // Uint32 per TRIANGLE
};

MeshBuffers build_sliced_mesh(const Print& print) {
    MeshBuffers out;
    // v1: first object only (multi-object preview is M4).
    if (print.objects().empty()) return out;
    const auto& print_object = print.objects().front();
    const auto& layers = print_object->layers();
    if (layers.empty()) return out;

    std::uint32_t vertex_base = 0;
    for (size_t li = 0; li < layers.size(); ++li) {
        const auto& slices = layers[li]->slices;
        const double z = layers[li]->print_z;

        // Per-layer triangulation, exactly like the GUI's preview: tesselate
        // each layer's slice polygons (contour + holes) flat at z. Drift at
        // the pinned SHA: SlicesToTriangleMeshParams does not exist (only
        // slices_to_mesh, a full-stack wall+cap builder with no per-triangle
        // layer info) and ExPolygon has no triangulate_self()/triangles —
        // triangulate_expolygons_3d is the per-layer cap tesselation the
        // missing Prusa API itself used, and its Vec3d triangle soup (3
        // vertices per triangle) feeds the emit loop below 1:1 (the brief's
        // documented raw-soup fallback).
        Slic3r::ExPolygons expolys;
        expolys.reserve(slices.size());
        for (const auto& surf : slices)
            expolys.push_back(surf.expolygon);
        const std::vector<Slic3r::Vec3d> soup =
            Slic3r::triangulate_expolygons_3d(expolys, z, Slic3r::NORMALS_UP);

        // Emit per-triangle vertices, global indices, and layer ids.
        const size_t tris = soup.size() / 3;
        if (tris == 0) continue;
        for (size_t t = 0; t < tris; ++t) {
            for (int v = 0; v < 3; ++v) {
                const auto& p = soup[t * 3 + v];
                out.positions.appendF32(static_cast<float>(p.x()));
                out.positions.appendF32(static_cast<float>(p.y()));
                out.positions.appendF32(static_cast<float>(p.z()));
            }
            out.indices.appendU32(vertex_base + static_cast<std::uint32_t>(t * 3 + 0));
            out.indices.appendU32(vertex_base + static_cast<std::uint32_t>(t * 3 + 1));
            out.indices.appendU32(vertex_base + static_cast<std::uint32_t>(t * 3 + 2));
            out.layer_ids.appendU32(static_cast<std::uint32_t>(li));
        }
        vertex_base += static_cast<std::uint32_t>(tris * 3);
    }
    return out;
}

}  // namespace bridge
