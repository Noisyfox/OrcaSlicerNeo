// packages/slicer-wasm/src/bridge_buffers.cpp
// ----------------------------------------------------------------
// Assembles the binary slice-result buffers from libslic3r data.
// Toolpath: GCodeProcessorResult moves (post-processed gcode).
// The layout is the M2 bridge contract (Task 1 mock mirror).
// ----------------------------------------------------------------
#include "bridge_buffers.hpp"

// Drift at the pinned SHA: GCodeProcessor.hpp lives under GCode/.
#include "libslic3r/GCode/GCodeProcessor.hpp"

#include <map>
#include <string>

namespace bridge {

using Slic3r::ExtrusionRole;
using Slic3r::GCodeProcessorResult;

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
        // MoveVertex::layer_id is unsigned at the pinned SHA — no < 0 case.
        out.layers.appendU32(static_cast<std::uint32_t>(mv.layer_id));
        auto fid = feature_ids.find(mv.extrusion_role);
        if (fid == feature_ids.end()) {
            fid = feature_ids.emplace(mv.extrusion_role, static_cast<std::uint32_t>(out.palette_used.size())).first;
            out.palette_used.emplace_back(mv.extrusion_role, it->second);
        }
        out.features.appendU32(fid->second);
    }
    return out;
}

}  // namespace bridge
