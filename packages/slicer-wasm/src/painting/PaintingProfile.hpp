#pragma once

#ifdef NEO_PAINTING_PROFILE
#include <chrono>
#include <cstdint>

namespace Slic3r::Neo::Painting::Profile {
struct Counter { std::uint64_t microseconds = 0; std::uint64_t calls = 0; };
inline thread_local Counter hit, selector, geometry;
struct Scope {
    Counter& counter;
    std::chrono::steady_clock::time_point start = std::chrono::steady_clock::now();
    explicit Scope(Counter& value) : counter(value) {}
    ~Scope() {
        counter.microseconds += std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now() - start).count();
        ++counter.calls;
    }
};
}
#endif
