// ----------------------------------------------------------------
// Worker-owned history transaction and restore runtime for the Neo bridge.
// ----------------------------------------------------------------
#pragma once

#include <functional>

#include "bridge_state.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::HistoryRuntime {

using json = nlohmann::json;

struct Runtime {
    std::function<json()> filament_history_state;
    std::function<void()> invalidate_preview;
};

// The bridge facade supplies the two narrow callbacks that cannot be linked
// directly without making this module depend on its private projections.
Runtime runtime();

json default_history_context(const Runtime& runtime);
json canonical_history_context(const Runtime& runtime, json context);
void record_active_plate_context(const Runtime& runtime);

} // namespace Slic3r::Neo::Bridge::HistoryRuntime
