// ----------------------------------------------------------------
// Worker-owned profile/config projections for the Neo bridge.
//
// Native profile visibility, compatibility, selection, and option metadata
// remain in this module so bridge.cpp only coordinates unrelated operations.
// The exported C functions below keep the existing ABI and JSON contract.
// ----------------------------------------------------------------
#pragma once

#include "bridge_state.hpp"
#include "nlohmann/json.hpp"

#include <string>

namespace Slic3r::Neo::Bridge::Profiles {

using json = nlohmann::json;

const char* duplicate_json(const std::string& value);
const char* error_json(const std::string& message);
json preset_snapshot_json();
// Shared native authority for projection and subsequent bed-type mutations.
struct BedTypeChoice {
    BedType type;
    std::string value;
    std::string label;
};
struct BedTypeCapabilities {
    bool supports_selection;
    BedType default_type;
    std::vector<BedTypeChoice> choices;
};
BedTypeCapabilities selected_printer_bed_type_capabilities();
bool bed_type_allowed(const BedTypeCapabilities& capabilities, BedType type, bool local);
BedType supported_default_bed_type(const BedTypeCapabilities& capabilities);
// Called only inside an existing profile/draft transaction. Returns local
// roots removed because the new printer no longer supports their bed type.
std::set<std::string> normalize_bed_types(bool reset_global);
json select_printer_with_remembered_rack_json(const json& request);
const json& option_metadata_json();
const char* init_profiles(const json& activation);

} // namespace Slic3r::Neo::Bridge::Profiles
