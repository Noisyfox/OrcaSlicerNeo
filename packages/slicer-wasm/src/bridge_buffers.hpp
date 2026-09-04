// packages/slicer-wasm/src/bridge_buffers.hpp
// ----------------------------------------------------------------
// Binary buffer marshaling for the bridge: growable malloc'd buffers
// whose storage is handed to the JS side (which _free()s it). Kept
// separate from bridge.cpp so the layout is easy to audit against
// the client contract (doc/2026-08-13-m2-implementation-plan.md).
// ----------------------------------------------------------------
#pragma once

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <utility>
#include <vector>

// ExtrusionRole keys the feature palette; the layout structs below are
// consumed by bridge.cpp (tp.palette_used), so they live in this header,
// not only in bridge_buffers.cpp.
#include "libslic3r/ExtrusionEntity.hpp"

namespace Slic3r {
struct GCodeProcessorResult;
}

// A buffer that owns malloc'd memory. By default the storage lives
// until release() or destruction; the bridge transfers ownership to
// JS via release() (the caller records the pointer in the JSON).
struct MallocBuffer {
    std::uint8_t* data = nullptr;
    size_t        size = 0;

    ~MallocBuffer() { std::free(data); }
    MallocBuffer() = default;
    MallocBuffer(const MallocBuffer&) = delete;
    MallocBuffer& operator=(const MallocBuffer&) = delete;
    MallocBuffer(MallocBuffer&& other) noexcept : data(other.data), size(other.size) {
        other.data = nullptr;
        other.size = 0;
    }
    MallocBuffer& operator=(MallocBuffer&& other) noexcept {
        if (this != &other) {
            std::free(data);
            data = other.data;
            size = other.size;
            other.data = nullptr;
            other.size = 0;
        }
        return *this;
    }

    void reserve(size_t extra) {
        data = static_cast<std::uint8_t*>(std::realloc(data, size + extra));
        if (!data) std::abort();
    }
    void append(const void* src, size_t n) {
        reserve(n);
        std::memcpy(data + size, src, n);
        size += n;
    }
    void appendF32(float v)  { append(&v, sizeof(v)); }
    void appendU32(std::uint32_t v) { append(&v, sizeof(v)); }
    void appendU16(std::uint16_t v) { append(&v, sizeof(v)); }
    void appendU8(std::uint8_t v) { append(&v, sizeof(v)); }

    // Hand the storage to JS (bridge fills the pointer/size fields).
    void release() { data = nullptr; size = 0; }
};

// ---- bridge-facing layout + assembly API (defined in bridge_buffers.cpp) ----
namespace bridge {

// The header must be self-compiling: no using-directive from any TU is in
// effect when this header is parsed (bridge.cpp's `using namespace Slic3r;`
// and bridge_buffers.cpp's `using Slic3r::ExtrusionRole;` both come after
// the include), so import the palette key explicitly here.
using Slic3r::ExtrusionRole;

// Feature palette entry (id = ExtrusionRole value, name/color for the client).
struct FeatureInfo { std::string name; unsigned char color[3]; };

struct ToolpathBuffers {
    // One entry is one continuous segment: start[i] is the previous move
    // endpoint and end[i] is the current move endpoint.  Each parallel
    // buffer therefore has exactly segmentCount entries (or 3*segmentCount
    // values for coordinates).
    MallocBuffer starts;      // Float32 xyz per segment
    MallocBuffer ends;        // Float32 xyz per segment
    // Deprecated v1 aliases retained for consumers that have not migrated to
    // segments yet. They contain one endpoint and one feature id per segment.
    MallocBuffer positions;
    MallocBuffer features;
    MallocBuffer layers;      // Uint32 layer_id per segment
    MallocBuffer move_orders; // Uint32 order within layer
    MallocBuffer gcode_ids;   // Uint32 source G-code id
    MallocBuffer move_types;  // Uint8 EMoveType
    MallocBuffer extrusion_roles; // Uint16 ExtrusionRole
    MallocBuffer extruders;   // Uint8 extruder/tool id
    MallocBuffer color_prints; // Uint8 colour-print id
    MallocBuffer widths;       // Float32 extrusion width
    MallocBuffer heights;      // Float32 extrusion height
    // Optional metric arrays. A null data pointer means the source did not
    // provide that metric; the bridge omits its JSON descriptor in that case.
    MallocBuffer feedrates;
    MallocBuffer actual_feedrates;
    MallocBuffer volumetric_flows;
    MallocBuffer actual_volumetric_flows;
    MallocBuffer fan_speeds;
    MallocBuffer temperatures;
    MallocBuffer pressure_advances;
    MallocBuffer accelerations;
    MallocBuffer jerks;
    MallocBuffer times;
    MallocBuffer layer_durations;
    size_t segmentCount = 0;
    // Number of preview layers: max 0-based layer id in `layers` + 1
    // (0 when no vertices were produced). The gcode spans every printed
    // layer of the whole plate, so this is the total preview layer count
    // even when objects on the plate differ in height.
    size_t layerCount = 0;
    struct LayerRange {
        std::uint32_t id = 0;
        float z = 0.0f;
        std::uint32_t first = 0;
        std::uint32_t count = 0;
    };
    std::vector<LayerRange> layer_ranges;
    // Local palette: index into this vector == the id recorded in
    // `features`. Kept local (0..N-1) so the JSON feature list in
    // orc_get_slice_result lines up with the buffer values 1:1.
    std::vector<std::pair<ExtrusionRole, FeatureInfo>> palette_used;
};

struct PreviewFeatureStatistics {
    std::uint32_t feature_id = 0;
    ExtrusionRole role = ExtrusionRole::erNone;
    double time_seconds = 0.0;
    bool has_time = false;
    double filament_length_meters = 0.0;
    double filament_weight_grams = 0.0;
    bool has_filament = false;
};

struct PreviewAnalysis {
    double estimated_time_seconds = 0.0;
    bool has_estimated_time = false;
    double filament_length_meters = 0.0;
    bool has_filament_length = false;
    double filament_weight_grams = 0.0;
    bool has_filament_weight = false;
    double filament_cost = 0.0;
    bool has_filament_cost = false;
    std::vector<PreviewFeatureStatistics> feature_statistics;
};

const std::map<ExtrusionRole, FeatureInfo>& feature_palette();
ToolpathBuffers build_toolpath(const Slic3r::GCodeProcessorResult& result);
PreviewAnalysis build_preview_analysis(const Slic3r::GCodeProcessorResult& result, const ToolpathBuffers& toolpath);

}  // namespace bridge
