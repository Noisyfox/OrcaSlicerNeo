// ----------------------------------------------------------------
// Native Prime Tower projection for the Neo bridge.
//
// This is deliberately a read-only feature module.  It computes the
// prepare-scene estimate from Worker-owned native model/configuration state;
// no renderer payload participates in eligibility or geometry.
// ----------------------------------------------------------------
#pragma once

#include <cstdint>
#include <optional>
#include <set>
#include <string>

#include "libslic3r/Model.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::PrimeTower {

using json = nlohmann::json;

struct CoordinateValue {
    bool option_present { false };
    std::optional<std::string> value;
};

struct CoordinateSettingsSnapshot {
    CoordinateValue x;
    CoordinateValue y;
};

CoordinateSettingsSnapshot snapshot_coordinate_settings(const DynamicPrintConfig& settings,
                                                         std::size_t plate_index);
void set_coordinate_settings(DynamicPrintConfig& settings, std::size_t plate_index,
                             double x, double y, double fallback_x, double fallback_y);
void normalize_coordinate_settings(DynamicPrintConfig& settings, std::size_t plate_count,
                                   double fallback_x, double fallback_y);
// Clamp the authoritative project-level coordinates to the current native
// footprint. This is intentionally Worker-owned: callers choose whether the
// surrounding operation is a silent lifecycle transition or a history
// transaction, while this helper only mutates the native arrays and their
// projection metadata.
bool normalize_coordinate_positions();

// Slice-time validation is native and advisory. The renderer never parses
// geometry or native validation text; it receives these stable warning strings
// alongside the normal successful slice status.
json slice_warnings_for_plate(const std::string& plate_id);
double coordinate_value(const DynamicPrintConfig& settings, const char* key,
                        std::size_t plate_index, double fallback);
void set_coordinate_option_value(DynamicPrintConfig& settings, const char* key,
                                  std::size_t plate_index, double value, double fallback);
void restore_coordinate_settings(DynamicPrintConfig& settings,
                                 const CoordinateSettingsSnapshot& snapshot,
                                 std::size_t plate_index, double fallback_x, double fallback_y);

json projection_json();

void invalidate_projection_cache();
void invalidate_projection_cache(const std::set<std::string>& plate_ids);

json move_position_json(const char* request_cstr);

} // namespace Slic3r::Neo::Bridge::PrimeTower
