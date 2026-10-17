#include "bridge_state.hpp"
#include <utility>

#ifdef ORCA_WASM_THREADING
#include <algorithm>
#include <emscripten/threading.h>
#endif

namespace Slic3r::Neo::Bridge {

BridgeState::BridgeState()
#ifdef ORCA_WASM_THREADING
    : tbb_max_concurrency(std::max(1, emscripten_num_logical_cores()))
    , tbb_concurrency(tbb::global_control::max_allowed_parallelism,
                      static_cast<std::size_t>(tbb_max_concurrency))
    , tbb_arena(tbb_max_concurrency)
#endif
{
}

BridgeState& state()
{
    // Keep construction lazy: PresetBundle reads print_config_def during its
    // constructor, and that native global must already have been initialized.
    static BridgeState s;
    return s;
}

void replace_model_preserving_project(Model& current, Model&& replacement)
{
    replacement.load_from(current);
    current = std::move(replacement);
    replacement.set_backup_path("detach");
}

} // namespace Slic3r::Neo::Bridge
