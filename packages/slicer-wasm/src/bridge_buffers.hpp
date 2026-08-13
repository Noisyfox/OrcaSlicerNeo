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
#include <vector>

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
