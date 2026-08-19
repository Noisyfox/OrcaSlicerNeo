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
    MallocBuffer positions;   // Float32 xyz per vertex
    MallocBuffer layers;      // Uint32 layer_id per vertex
    MallocBuffer features;    // Uint32 palette index per vertex
    // Local palette: index into this vector == the id recorded in
    // `features`. Kept local (0..N-1) so the JSON feature list in
    // orc_get_slice_result lines up with the buffer values 1:1.
    std::vector<std::pair<ExtrusionRole, FeatureInfo>> palette_used;
};

const std::map<ExtrusionRole, FeatureInfo>& feature_palette();
ToolpathBuffers build_toolpath(const Slic3r::GCodeProcessorResult& result);

}  // namespace bridge
