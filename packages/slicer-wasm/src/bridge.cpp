// ----------------------------------------------------------------
// ------------ extern "C" JSON-in/JSON-out bridge ----------------
// ----------------------------------------------------------------
// The only C++<->JS seam (design §Bridge API). Every function runs
// synchronously on the worker thread. JSON strings are returned as malloc'd
// C strings; the JS side reads them with UTF8ToString and _free()s. Binary
// buffers cross via the WASM heap (_malloc/_free + HEAPU8).
//
// This translation unit deliberately contains only bridge composition and the
// narrow runtime adapters required by the feature modules below.
#include <emscripten/emscripten.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <exception>
#include <string>
#include <vector>

#include "libslic3r/Model.hpp"
#include "libslic3r/PresetBundle.hpp"

#include "bridge_filament.hpp"
#include "bridge_history.hpp"
#include "bridge_plate.hpp"
#include "bridge_profiles.hpp"
#include "bridge_project_overlay.hpp"
#include "bridge_project_persistence.hpp"
#include "bridge_slicing_pipeline.hpp"
#include "bridge_state.hpp"

#include <boost/log/trivial.hpp>

#include "wasm_log.hpp"

#include "nlohmann/json.hpp"

using nlohmann::json;

// ColorSpaceConvert.cpp belongs to the desktop-only slic3r utility source
// list and is intentionally not linked into the headless WASM target.  The
// native FlushVolCalculator object nevertheless uses this tiny primitive;
// keep the exact upstream symbol at the bridge boundary rather than editing
// the pinned submodule/build source list.
void RGB2HSV(float r, float g, float b, float* h, float* s, float* v)
{
    const float cmax = std::max(std::max(r, g), b);
    const float cmin = std::min(std::min(r, g), b);
    const float delta = cmax - cmin;
    if (std::abs(delta) < 0.001f) *h = 0.f;
    else if (cmax == r) *h = 60.f * std::fmod((g - b) / delta, 6.f);
    else if (cmax == g) *h = 60.f * ((b - r) / delta + 2.f);
    else *h = 60.f * ((r - g) / delta + 4.f);
    *s = std::abs(cmax) < 0.001f ? 0.f : delta / cmax;
    *v = cmax;
}

namespace {

// The facade owns only composition and the two runtime adapters below;
// feature-specific state and command implementations live in bridge modules.
using Slic3r::Neo::Bridge::BridgeState;
using Slic3r::Neo::Bridge::state;
using Slic3r::Neo::Bridge::Filament::State::history_state_json;
using Slic3r::Neo::Bridge::ProjectOverlay::empty_project_config_overlay;

} // namespace

namespace Slic3r::Neo::Bridge::HistoryRuntime {

Runtime runtime()
{
    return {[] { return history_state_json(state().presets); },
            [] { Slic3r::Neo::Bridge::SlicingPipeline::invalidate_preview_source(); }};
}

} // namespace Slic3r::Neo::Bridge::HistoryRuntime

namespace Slic3r::Neo::Bridge::ProjectPersistence {

void validate_filament_candidate(PresetBundle& bundle, Model& model,
                                 const std::vector<BridgeState::PlateSessionPlate>& plates,
                                 const json& overlay, bool strict_slot_arrays,
                                 bool require_all_slot_arrays)
{
    Neo::Bridge::Filament::Commands::validate_filament_candidate(
        bundle, model, plates, overlay, strict_slot_arrays, require_all_slot_arrays);
}

} // namespace Slic3r::Neo::Bridge::ProjectPersistence
extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_init(const char* options_json) {
    try {
        // The options object currently controls only the bridge log severity.
        json opts = json::object();
        if (options_json && *options_json) {
            try { opts = json::parse(options_json); }
            catch (...) { /* malformed options: keep defaults */ }
        }
        std::string log_level;
        if (opts.is_object() && opts.contains("log_level") &&
            opts["log_level"].is_string())
            log_level = opts["log_level"].get<std::string>();
        wasm_log::init_with_level(log_level);

        const char* result = Slic3r::Neo::Bridge::Profiles::init_profiles();
        Slic3r::Neo::Bridge::PlateSession::reset_plate_session_state();
        state().project_config_overlay = empty_project_config_overlay();
        state().history.clear();
        state().active_history_transaction.reset();
        state().nested_history_transactions.clear();
        state().history_disabled = false;
        state().next_filament_colour_index = 0;
        state().history_revision++;
        // First bridge log record — proves the sink pipeline end-to-end
        // (console + /tmp/orca.log).
        BOOST_LOG_TRIVIAL(info) << "orc_init: bridge ready, log level "
            << (log_level.empty() ? "info (default)" : log_level);
        return result;
    } catch (const std::exception& e) {
        // Error-path diagnostics only: these catch blocks are compiled in
        // (target_compile_options -fexceptions on orca_slice; emcc's default
        // -fignore-exceptions would compile them out entirely) and fire only
        // when init genuinely failed — never on the happy path.
        fprintf(stderr, "orc_init caught std::exception: %s\n", e.what());
        return Slic3r::Neo::Bridge::Profiles::error_json(e.what());
    } catch (...) {
        // Non-std throw: never let a C++ exception cross the extern "C" seam
        // (it would surface in JS as an uncatchable CppException crash).
        fprintf(stderr, "orc_init caught (...) via catch-all\n");
        return Slic3r::Neo::Bridge::Profiles::error_json("unknown C++ exception");
    }
}

}  // extern "C"
