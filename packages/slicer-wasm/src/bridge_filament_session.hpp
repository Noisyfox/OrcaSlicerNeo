// ----------------------------------------------------------------
// Multi-filament session projection and ABI facade for the Neo WASM bridge.
//
// This module owns the read-only rack/session projection and the thin C ABI
// adapters for multi-filament commands and test fixtures.  Mutation logic is
// implemented by bridge_filament_commands.cpp; field storage and history
// state remain in bridge_filament_state.cpp.
// ----------------------------------------------------------------
#pragma once

#include "bridge_filament_commands.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::FilamentSession {

using json = nlohmann::json;

json filament_session_snapshot_json();
FilamentCommands::Runtime filament_command_runtime();

} // namespace Slic3r::Neo::Bridge::FilamentSession
