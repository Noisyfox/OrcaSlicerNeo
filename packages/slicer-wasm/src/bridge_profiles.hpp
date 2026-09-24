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
json select_printer_with_remembered_rack_json(const json& request);
const json& option_metadata_json();
const char* init_profiles();

} // namespace Slic3r::Neo::Bridge::Profiles
