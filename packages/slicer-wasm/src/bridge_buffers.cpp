// packages/slicer-wasm/src/bridge_buffers.cpp
// ----------------------------------------------------------------
// Assembles the binary slice-result buffers from libslic3r data.
// Toolpath: GCodeProcessorResult moves (post-processed gcode).
// The layout is the M2 bridge contract (Task 1 mock mirror).
// ----------------------------------------------------------------
#include "bridge_buffers.hpp"

// Drift at the pinned SHA: GCodeProcessor.hpp lives under GCode/.
#include "libslic3r/GCode/GCodeProcessor.hpp"

#include <algorithm>
#include <map>
#include <string>
#include <sstream>

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
    std::uint32_t max_layer_id = 0;
    if (result.moves.size() < 2) return out;

    std::uint32_t move_order = 0;
    std::uint32_t previous_layer = static_cast<std::uint32_t>(result.moves.front().layer_id);
    for (size_t i = 1; i < result.moves.size(); ++i) {
        const auto& previous = result.moves[i - 1];
        const auto& mv = result.moves[i];
        // MoveVertex::position is an endpoint. Pairing adjacent endpoints is
        // the explicit continuous-segment representation required by v2;
        // travel, wipe and control moves remain present and are filtered by
        // the renderer using move_types rather than being lost here.
        const std::uint32_t layer_id = static_cast<std::uint32_t>(mv.layer_id);
        if (layer_id != previous_layer) move_order = 0;
        previous_layer = layer_id;

        out.starts.appendF32(static_cast<float>(previous.position.x()));
        out.starts.appendF32(static_cast<float>(previous.position.y()));
        out.starts.appendF32(static_cast<float>(previous.position.z()));
        out.ends.appendF32(static_cast<float>(mv.position.x()));
        out.ends.appendF32(static_cast<float>(mv.position.y()));
        out.ends.appendF32(static_cast<float>(mv.position.z()));
        out.positions.appendF32(static_cast<float>(mv.position.x()));
        out.positions.appendF32(static_cast<float>(mv.position.y()));
        out.positions.appendF32(static_cast<float>(mv.position.z()));
        out.layers.appendU32(layer_id);
        out.move_orders.appendU32(move_order++);
        out.gcode_ids.appendU32(static_cast<std::uint32_t>(mv.gcode_id));
        out.move_types.appendU8(static_cast<std::uint8_t>(mv.type));
        out.extrusion_roles.appendU16(static_cast<std::uint16_t>(mv.extrusion_role));
        out.extruders.appendU8(static_cast<std::uint8_t>(mv.extruder_id));
        out.color_prints.appendU8(static_cast<std::uint8_t>(mv.cp_color_id));
        out.widths.appendF32(mv.width);
        out.heights.appendF32(mv.height);

        out.feedrates.appendF32(mv.feedrate);
        out.actual_feedrates.appendF32(mv.actual_feedrate);
        out.volumetric_flows.appendF32(mv.volumetric_rate());
        out.actual_volumetric_flows.appendF32(mv.actual_volumetric_rate());
        out.fan_speeds.appendF32(mv.fan_speed);
        out.temperatures.appendF32(mv.temperature);
        out.pressure_advances.appendF32(mv.pressure_advance);
        out.accelerations.appendF32(mv.acceleration);
        out.jerks.appendF32(mv.jerk);
        out.times.appendF32(mv.time[0]);
        out.layer_durations.appendF32(mv.layer_duration);

        // The role palette is categorical data independent of whether this
        // segment is travel. Preserve unknown roles with a stable fallback so
        // every segment has a valid feature id and no move is silently lost.
        auto it = palette.find(mv.extrusion_role);
        FeatureInfo fallback;
        if (it == palette.end()) {
            std::ostringstream name;
            name << "Role " << static_cast<unsigned>(mv.extrusion_role);
            fallback = {name.str(), {160, 160, 160}};
        }
        auto fid = feature_ids.find(mv.extrusion_role);
        if (fid == feature_ids.end()) {
            const auto id = static_cast<std::uint32_t>(out.palette_used.size());
            fid = feature_ids.emplace(mv.extrusion_role, id).first;
            out.palette_used.emplace_back(mv.extrusion_role, it == palette.end() ? fallback : it->second);
        }
        out.features.appendU32(fid->second);

        max_layer_id = std::max(max_layer_id, layer_id);
        ++out.segmentCount;
    }
    out.layerCount = out.segmentCount > 0 ? static_cast<size_t>(max_layer_id) + 1 : 0;
    out.layer_ranges.resize(out.layerCount);
    for (size_t i = 0; i < out.segmentCount; ++i) {
        const auto* layer_data = reinterpret_cast<const std::uint32_t*>(out.layers.data);
        const auto layer_id = layer_data[i];
        auto& range = out.layer_ranges[layer_id];
        if (range.count == 0) {
            range.id = layer_id;
            range.first = static_cast<std::uint32_t>(i);
            range.z = reinterpret_cast<const float*>(out.ends.data)[i * 3 + 2];
        }
        ++range.count;
    }
    return out;
}

}  // namespace bridge
