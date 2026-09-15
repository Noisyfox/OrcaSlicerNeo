// ----------------------------------------------------------------
// Runtime ownership for the FFF per-plate Print domain.
//
// Plate definitions are session state.  This registry deliberately keeps the
// native Print and G-code result outside the serialized plate definition and
// reconciles ownership by the session-stable plate id.
// ----------------------------------------------------------------
#pragma once

#include <cstddef>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "libslic3r/GCode/GCodeProcessor.hpp"
#include "libslic3r/Print.hpp"

namespace Slic3r::Neo::Bridge {

class PlateRuntimeRegistry {
public:
    struct Entry {
        std::string plate_id;
        std::unique_ptr<Print> print;
        std::unique_ptr<GCodeProcessorResult> gcode_result;
    };

    // Reconcile runtime ownership with the current ordered plate ids.  An
    // existing id retains the same Print and result pointers; a new id gets a
    // fresh pair and an absent id is released immediately.
    void reconcile(const std::vector<std::string>& plate_ids);
    void clear() noexcept;

    Entry* find(std::string_view plate_id) noexcept;
    const Entry* find(std::string_view plate_id) const noexcept;

    std::size_t size() const noexcept { return entries_.size(); }
    bool empty() const noexcept { return entries_.empty(); }

private:
    std::unordered_map<std::string, Entry> entries_;
};

} // namespace Slic3r::Neo::Bridge
