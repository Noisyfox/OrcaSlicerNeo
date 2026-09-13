#include "bridge_state.hpp"

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

} // namespace Slic3r::Neo::Bridge
