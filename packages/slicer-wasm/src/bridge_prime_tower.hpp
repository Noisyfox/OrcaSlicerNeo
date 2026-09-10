// ----------------------------------------------------------------
// Native Prime Tower projection for the Neo bridge.
//
// This is deliberately a read-only feature module.  It computes the
// prepare-scene estimate from Worker-owned native model/configuration state;
// no renderer payload participates in eligibility or geometry.
// ----------------------------------------------------------------
#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <string>

#include "history/ProjectHistory.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::PrimeTower {

using json = nlohmann::json;

struct NarrowHistoryFrame {
    // Deliberately excludes all preview/G-code/Print state. A target preview
    // is invalidated by the move and remains invalid through Undo/Redo.
    std::string plate_id;
    struct CoordinateValue {
        bool option_present { false };
        std::optional<std::string> value;
    };
    CoordinateValue before_x;
    CoordinateValue before_y;
    CoordinateValue after_x;
    CoordinateValue after_y;
    std::uint64_t before_revision { 0 };
    std::uint64_t after_revision { 0 };
    bool after_state { false };
};

struct CoordinateSettingsSnapshot {
    NarrowHistoryFrame::CoordinateValue x;
    NarrowHistoryFrame::CoordinateValue y;
};

CoordinateSettingsSnapshot snapshot_coordinate_settings(const DynamicPrintConfig& settings,
                                                         std::size_t plate_index);
void set_coordinate_settings(DynamicPrintConfig& settings, std::size_t plate_index,
                             double x, double y, double fallback_x, double fallback_y);
void normalize_coordinate_settings(DynamicPrintConfig& settings, std::size_t plate_count,
                                   double fallback_x, double fallback_y);
double coordinate_value(const DynamicPrintConfig& settings, const char* key,
                        std::size_t plate_index, double fallback);
void set_coordinate_option_value(DynamicPrintConfig& settings, const char* key,
                                  std::size_t plate_index, double value, double fallback);
void restore_coordinate_settings(DynamicPrintConfig& settings,
                                 const CoordinateSettingsSnapshot& snapshot,
                                 std::size_t plate_index, double fallback_x, double fallback_y);

std::size_t narrow_history_frame_bytes(const NarrowHistoryFrame& frame);
std::optional<History::RestoreState::DirectFrame>
make_narrow_history_frame(const NarrowHistoryFrame& frame);

json projection_json();

json move_position_json(const char* request_cstr);

} // namespace Slic3r::Neo::Bridge::PrimeTower
