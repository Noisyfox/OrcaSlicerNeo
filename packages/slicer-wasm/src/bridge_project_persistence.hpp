// ----------------------------------------------------------------
// Project archive persistence for the Neo WASM bridge.
//
// This module owns 3MF staging, native project interoperability, Neo sidecar
// round-trip, preflight tokens, atomic replacement, geometry-only import, and
// project export.  History transactions never call this module's full-bundle
// staging boundary.
// ----------------------------------------------------------------
#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "bridge_state.hpp"
#include "bridge_project_overlay.hpp"
#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/PresetBundle.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::ProjectPersistence {

using json = nlohmann::json;

struct ImportedPlateRecord {
    int source_index = 0;
    bool invalid_index = false;
    std::string name;
    bool locked = false;
    json settings = json::object();
    json opaque_metadata = json::array();
    json future_metadata = json::object();
    std::vector<std::pair<int, int>> instances;
};

// This narrow adapter is implemented by the bridge's existing filament
// validation code. It keeps the project module from owning command
// transactions or duplicating native validation rules.
void validate_filament_candidate(PresetBundle& bundle, Model& model,
                                 const std::vector<BridgeState::PlateSessionPlate>& plates,
                                 const json& overlay, bool strict_slot_arrays = true,
                                 bool require_all_slot_arrays = false);
} // namespace Slic3r::Neo::Bridge::ProjectPersistence
