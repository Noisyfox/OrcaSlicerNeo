// ----------------------------------------------------------------
// Plate lifecycle commands for the Neo WASM bridge.
//
// This module owns the plate-session command ABI and its plate-local mutation
// response helper. Runtime identity, membership, and geometry remain in
// bridge_plate_session.cpp; project configuration overlay commands remain in
// bridge.cpp.
// ----------------------------------------------------------------
#pragma once

#include <string>

#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::PlateCommands {

using json = nlohmann::json;

json plate_configuration_mutation_snapshot(const std::string& plate_id,
                                            const char* reason);

} // namespace Slic3r::Neo::Bridge::PlateCommands
