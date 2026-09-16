// ----------------------------------------------------------------
// Slicing, progress, preview, G-code, and threading bridge pipeline.
//
// The C ABI and JSON/buffer ownership remain unchanged; this translation unit
// only owns the slice/result pipeline and its progress transport.
// ----------------------------------------------------------------
#include <emscripten/emscripten.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "bridge_buffers.hpp"
#include "bridge_filament.hpp"
#include "bridge_plate.hpp"
#include "bridge_prime_tower.hpp"
#include "bridge_slicing_pipeline.hpp"
#include "bridge_state.hpp"
#include "libslic3r/BuildVolume.hpp"
#include "libslic3r/Exception.hpp"
#include "libslic3r/GCode/GCodeProcessor.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/Print.hpp"

#include <nlohmann/json.hpp>

using namespace Slic3r;
using nlohmann::json;

namespace Slic3r::Neo::Bridge::SlicingPipeline {

namespace {
using Neo::Bridge::BridgeState;
using Neo::Bridge::state;
using namespace Neo::Bridge::PlateSession;

// Copy a string into a malloc'd C string the JS side can read then _free().
const char* dup_json(const std::string& s) {
    char* out = static_cast<char*>(std::malloc(s.size() + 1));
    std::memcpy(out, s.data(), s.size());
    out[s.size()] = '\0';
    return out;
}

const char* error_json(const std::string& msg) {
    return dup_json(json{{"error", msg}}.dump());
}

const char* error_json_from_exception(const std::exception& e) {
    if (const auto* se = dynamic_cast<const SlicingErrors*>(&e); se != nullptr) {
        std::string joined;
        for (const auto& err : se->errors_) {
            if (!joined.empty()) joined += "\n";
            joined += err.what();
        }
        if (!joined.empty()) return error_json(joined);
    }
    return error_json(e.what());
}

template <class Config>
void apply_overlay_to_config(Config& config, const json& values)
{
    if (!values.is_object()) return;
    ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
    for (auto it = values.begin(); it != values.end(); ++it) {
        if (!it.value().is_string()) continue;
        try { config.set_deserialize(it.key(), it.value().get<std::string>(), substitutions); }
        catch (...) { /* invalid retained values are ignored at slice time */ }
    }
}
} // namespace

void invalidate_preview_result_only()
{
    auto& bridge_state = state();
    bridge_state.preview_result_id = 0;
    bridge_state.preview_gcode_path.clear();
    bridge_state.preview_gcode_size = 0;
    bridge_state.preview_gcode_line_ends.clear();
    bridge_state.preview_text_available = false;
    bridge_state.preview_plate_id.clear();
    bridge_state.preview_plate_revision = 0;
}

// Print::apply() reads ModelInstance::is_printable() while it builds its
// native snapshot.  Keep that existing PartPlate context on the authoritative
// model for the duration of the synchronous apply, then restore the bridge
// model before any later slice stage can observe it.  This carries only the
// derived print-volume states and plate index; it never clones or filters a
// Model just for Slice.
class ScopedPlateModelContext {
    struct InstanceState {
        ModelInstance* instance;
        ModelInstanceEPrintVolumeState print_volume_state;
    };

    Model& model_;
    const int previous_plate_index_;
    std::vector<InstanceState> previous_instance_states_;

public:
    ScopedPlateModelContext(Model& model, const BridgeState::PlateSessionPlate& plate)
        : model_(model), previous_plate_index_(model.curr_plate_index)
    {
        for (ModelObject* object : model_.objects)
            for (ModelInstance* instance : object->instances)
                previous_instance_states_.push_back({instance, instance->print_volume_state});

        try {
            const PlateBounds bounds = selected_plate_bounds();
            const BuildVolume build_volume(selected_printable_area(bounds, plate), bounds.max_z, {}, {});
            model_.curr_plate_index = plate.display_index;
            model_.update_print_volume_state(build_volume);
        } catch (...) {
            restore();
            throw;
        }
    }

    ~ScopedPlateModelContext()
    {
        restore();
    }

private:
    void restore()
    {
        model_.curr_plate_index = previous_plate_index_;
        for (const InstanceState& previous : previous_instance_states_)
            previous.instance->print_volume_state = previous.print_volume_state;
    }
};

void invalidate_preview_source()
{
    PrimeTower::invalidate_projection_cache();
    invalidate_preview_result_only();
}

extern "C" {
using progress_fn = void (*)(int, const char*);
progress_fn g_progress = nullptr;

// Threaded status transport -------------------------------------------------
//
// oneTBB can call Print's status callback from any pthread. Do not call a
// JS function-table entry from there: dynamically-grown tables are not shared
// reliably by Chromium's per-pthread Wasm instances. Instead publish the
// latest status in this fixed shared-memory mailbox. The renderer reads it
// directly while the module worker is blocked in orc_slice(). See
// doc/2026-08-18-threaded-progress-mailbox-design.md.
constexpr std::size_t k_progress_text_capacity = 512;
struct alignas(4) ProgressMailbox {
    std::atomic<std::uint32_t> sequence{0}; // odd while a writer owns it
    std::atomic<std::uint32_t> percent{0};
    std::atomic<std::uint32_t> text_length{0};
    std::uint32_t reserved{0};
    std::array<char, k_progress_text_capacity> text{};
};
static_assert(sizeof(std::atomic<std::uint32_t>) == sizeof(std::uint32_t));
static_assert(offsetof(ProgressMailbox, sequence) == 0);
static_assert(offsetof(ProgressMailbox, percent) == 4);
static_assert(offsetof(ProgressMailbox, text_length) == 8);
static_assert(offsetof(ProgressMailbox, text) == 16);

ProgressMailbox g_progress_mailbox;
std::mutex g_progress_mailbox_mutex;
bool g_progress_open = false;

void publish_progress_locked(int percent, std::string_view text)
{
    // The sequence brackets all non-atomic text writes. Readers retry if it
    // changes or is odd, so they never render a partially copied UTF-8 value.
    const std::uint32_t odd =
        g_progress_mailbox.sequence.fetch_add(1, std::memory_order_acq_rel) + 1;
    const auto clamped = static_cast<std::uint32_t>(std::clamp(percent, 0, 100));
    std::size_t len = std::min(text.size(), k_progress_text_capacity - 1);
    // If the next omitted byte is a continuation, remove the partial code
    // point that began before the truncation boundary.
    while (len > 0 && len < text.size() &&
           (static_cast<unsigned char>(text[len]) & 0xc0u) == 0x80u)
        --len;
    std::memcpy(g_progress_mailbox.text.data(), text.data(), len);
    g_progress_mailbox.text[len] = '\0';
    g_progress_mailbox.percent.store(clamped, std::memory_order_relaxed);
    g_progress_mailbox.text_length.store(static_cast<std::uint32_t>(len), std::memory_order_relaxed);
    g_progress_mailbox.sequence.store(odd + 1, std::memory_order_release);
}

void notify_progress(int percent, std::string_view text)
{
#ifndef ORCA_WASM_THREADING
    if (g_progress) {
        const std::string owned_text(text);
        g_progress(percent, owned_text.c_str());
    }
#else
    (void)percent;
    (void)text;
#endif
}

void begin_progress(std::string_view text)
{
    {
        std::lock_guard<std::mutex> lock(g_progress_mailbox_mutex);
        g_progress_open = true;
    }
    publish_slicer_progress(0, text);
}

void publish_slicer_progress(int percent, std::string_view text)
{
    bool active = false;
    {
        std::lock_guard<std::mutex> lock(g_progress_mailbox_mutex);
        active = g_progress_open;
        if (active)
            publish_progress_locked(percent, text);
    }
    if (active)
        notify_progress(percent, text);
}

void finish_progress(std::string_view text)
{
    {
        std::lock_guard<std::mutex> lock(g_progress_mailbox_mutex);
        // Close before the terminal write. A status callback that reaches us
        // later must acquire this same mutex and therefore cannot overwrite
        // 100%.
        g_progress_open = false;
        publish_progress_locked(100, text);
    }
    notify_progress(100, text);
}

void stop_progress()
{
    std::lock_guard<std::mutex> lock(g_progress_mailbox_mutex);
    g_progress_open = false;
}

PlateRuntimeRegistry::Entry* runtime_entry_for_plate(const std::string& plate_id,
                                                      std::string& error)
{
    auto* entry = state().plate_runtime_registry.find(plate_id);
    if (entry == nullptr || entry->print == nullptr || entry->gcode_result == nullptr) {
        error = "plate operation target was not found";
        return nullptr;
    }
    return entry;
}

std::uint64_t current_input_revision_for_plate(const std::string& plate_id)
{
    const auto it = state().plate_input_revisions.find(plate_id);
    return it == state().plate_input_revisions.end() ? 0 : it->second;
}

const char* result_unavailable_error()
{
    return error_json("plate slice result is stale or unavailable");
}

json projection_receipt(const PlateRuntimeRegistry::Entry& entry)
{
    return json{{"plate_id", entry.plate_id},
                {"input_stamp", entry.completed_input_revision.value_or(0)},
                {"slice_task_id", std::to_string(entry.completed_slice_task_id.value_or(0))}};
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_progress_mailbox()
{
    return dup_json(json{{"ok", true},
                         {"byte_offset", reinterpret_cast<std::uintptr_t>(&g_progress_mailbox)},
                         {"text_capacity", k_progress_text_capacity}}.dump());
}

EMSCRIPTEN_KEEPALIVE void orc_set_progress_callback(progress_fn cb) {
#ifdef ORCA_WASM_THREADING
    // Deliberately ignore raw callbacks in a pthread module. The mailbox above
    // is the only safe threaded transport, including for direct bridge users.
    (void)cb;
#else
    g_progress = cb;
#endif
}

const char* slice_for_plate(const char* config_json, const std::string& plate_id,
                            const std::uint64_t revision) {
    std::optional<PlateRuntimeRegistry::JobLease> job_lease;
    try {
        // Refresh membership before the operation gate.  This is read-only
        // with respect to the editing model and makes direct bridge callers
        // obey the same empty/out-of-bounds rules as the UI path.
        rebuild_plate_membership(false);
        std::string target_error;
        if (!validate_plate_operation_target(plate_id, revision, target_error))
            return error_json(target_error);
        auto* runtime_entry = runtime_entry_for_plate(plate_id, target_error);
        if (runtime_entry == nullptr)
            return error_json(target_error);
        const std::uint64_t slice_task_id = state().next_slice_task_id++;
        job_lease.emplace(state().plate_runtime_registry.begin_slice(
            plate_id, slice_task_id, revision));
        runtime_entry = &job_lease->entry();
        auto& print = *runtime_entry->print;

        // A new slice invalidates both the old toolpath and its source text
        // before any work begins. The client must fetch a fresh result id.
        invalidate_preview_source();
        // libslic3r's internal phase reporting does not promise a final 100%
        // notification (the current FDM path often ends at 75%). Establish
        // stable operation boundaries for the UI around those detailed phases.
        begin_progress();
        // Start from the GUI's own baseline: real OrcaSlicer never slices on
        // bare full_print_config() defaults — it assembles the config from
        // the selected print/filament/printer presets (PresetBundle::
        // full_config, the mechanism slice_main.cpp's comment references).
        // Bare defaults are NOT validatable: default Marlin flavor with
        // use_relative_e_distances=1 requires "G92 E0" in the layer-change
        // gcode (Print.cpp:1746), which only printer presets supply — the
        // app's minimal config {} therefore failed validate() with exactly
        // that message. full_config() yields the complete option map the
        // same discipline expects (optptr() returns nullptr for missing keys
        // and Print::apply's normalize paths dereference that). The JSON
        // keys are applied on top, then normalized like slice_main.cpp:30.
        DynamicPrintConfig config = state().presets.full_config();
        const json cfg = json::parse(config_json ? config_json : "");
        // Fix round 2: thread ONE substitution context through every key so
        // keys that are unknown at the pinned SHA are surfaced instead of
        // silently dropped. ConfigBase::set_deserialize_nothrow (Config.cpp:
        // 580-593) calls handle_legacy(), which CLEARS keys it does not know
        // and records the source key in ConfigSubstitutionContext::
        // unrecogized_keys (Config.hpp:266 — the pinned source's spelling)
        // before returning true; the old set_deserialize_strict threw the
        // context away, so the smoke's pre-rename keys (temperature,
        // perimeters, bed_shape, ...) vanished without a trace and the slice
        // ran on defaults while reporting {"ok":true}. Disable keeps the
        // strict no-substitution semantics of the previous code.
        ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
        for (auto it = cfg.begin(); it != cfg.end(); ++it) {
            const std::string& key = it.key();
            std::string value;
            if (it.value().is_array()) {
                for (const auto& v : it.value()) {
                    if (!value.empty()) value += ",";
                    value += v.is_string() ? v.get<std::string>() : v.dump();
                }
            } else if (it.value().is_string()) {
                // JSON strings use "\\n" escapes; restore real newlines for
                // multi-line values (start_gcode etc.).
                value = it.value().get<std::string>();
                std::string unescaped;
                unescaped.reserve(value.size());
                for (size_t i = 0; i < value.size(); ++i) {
                    if (value[i] == '\\' && i + 1 < value.size() && value[i + 1] == 'n') {
                        unescaped.push_back('\n');
                        ++i;
                    } else {
                        unescaped.push_back(value[i]);
                    }
                }
                value = std::move(unescaped);
            } else if (it.value().is_boolean()) {
                value = it.value().get<bool>() ? "1" : "0";
            } else {
                value = it.value().dump();
            }
            // Fix round 2: per-key set_deserialize with the shared context.
            // This is the same strict-no-substitution behavior the old
            // set_deserialize_strict had (Config.hpp:2771 builds an internal
            // {Disable} context), but it does NOT throw the context away —
            // handle_legacy (Config.cpp:586-590) records every dropped key in
            // substitutions.unrecogized_keys, which we surface below.
            config.set_deserialize(key, value, substitutions);
        }
        const DynamicPrintConfig native_full_config = state().presets.full_config(false);
        // Project overrides and imported plate settings are canonical Worker state and win over
        // any renderer payload supplied for this slice request.  PlateData
        // carries native per-plate filament/tool mappings (for example a
        // H2D plate can map logical slots 1 and 2 to physical tools 2 and 1)
        // which are not part of the global PresetBundle config.  Apply that
        // native plate config before the small Neo overlay so imported
        // painted projects keep their plate-local tool mapping when sliced.
        if (const auto* plate = find_plate(plate_id))
            config.apply(plate->settings, true);
        apply_overlay_to_config(config, state().project_config_overlay["project"]);
        // Plater's full_config() is assembled from every active filament
        // preset. The renderer settings projection uses scalars for compact
        // values, so restore native multi-slot vectors once after every
        // overlay has been composed. Explicit JSON arrays remain authoritative.
        for (const std::string& key : native_full_config.keys()) {
            const auto* native_option = native_full_config.option(key);
            const auto* requested_option = config.option(key, false);
            if (native_option == nullptr || requested_option == nullptr ||
                !native_option->is_vector() || native_option->is_nil())
                continue;
            const auto* native_vector = static_cast<const ConfigOptionVectorBase*>(native_option);
            if (native_vector->size() > 1 && cfg.contains(key) && !cfg[key].is_array())
                config.set_key_value(key, native_option->clone());
        }
        config.normalize_fdm();
        // Fix round 3: validate() invariant guarantee. A Marlin flavor with
        // use_relative_e_distances=1 requires "G92 E0" in the layer-change
        // gcode (Print.cpp:1746); real OrcaSlicer machine presets carry it in
        // before_layer_change_gcode, but the WASM's un-curated default
        // selection may leave the baseline without it (see orc_init).
        // Inject the standard reset so ANY selection validates — the bridge
        // contract is "a slice request must slice", and this only fires for
        // configs that otherwise fail validate() outright. Explicit client
        // values that satisfy the invariant (klipper, rel-e=0, or their own
        // G92 E0) are untouched.
        {
            const auto* flavor = config.option<ConfigOptionEnum<GCodeFlavor>>("gcode_flavor");
            const bool marlin = flavor &&
                (flavor->value == gcfMarlinFirmware || flavor->value == gcfMarlinLegacy);
            if (marlin && config.opt_bool("use_relative_e_distances")) {
                const auto* before_opt = config.option<ConfigOptionString>("before_layer_change_gcode");
                const auto* layer_opt  = config.option<ConfigOptionString>("layer_change_gcode");
                const std::string before = before_opt ? before_opt->value : std::string();
                const std::string layer  = layer_opt ? layer_opt->value : std::string();
                if (before.find("G92 E0") == std::string::npos &&
                    layer.find("G92 E0") == std::string::npos)
                    config.set("before_layer_change_gcode", ";BEFORE_LAYER_CHANGE\n;[layer_z]\nG92 E0\n");
            }
        }

        // The native GUI sets this on BackgroundSlicingProcess before both
        // validation and processing.  The bridge bypasses that GUI layer, so
        // carry the active preset bundle's vendor identity across explicitly.
        // Without it Bambu G-code takes the non-Bambu nozzle/context path and
        // a successful P1P slice can later yield an empty preview.
        print.is_BBL_printer() = state().presets.is_bbl_vendor();
        const auto* target_plate = find_plate(plate_id);
        if (target_plate == nullptr || target_plate->display_index < 0)
            return error_json("plate operation target was not found");
        // PartPlate binds the reusable Print before applying the complete
        // world-space Model.  The binding supplies both per-plate config
        // selection and the target BuildVolume context used by apply/process.
        print.set_plate_index(target_plate->display_index);
        print.set_plate_origin(target_plate->origin);
        // Apply and process the authoritative world-space model directly.
        // Membership is maintained incrementally on the model's instances;
        // the scoped native context supplies the selected plate's printable
        // instances while PartPlate's plate index/origin supplies its local
        // coordinate context.  Print::apply() owns the native processing
        // snapshot, while the bridge must not clone/filter a Model just for
        // this slice.
        {
            ScopedPlateModelContext model_context(state().model, *target_plate);
            print.apply(state().model, config);
        }
        // Native validation also checks whether the generated prime tower
        // footprint overlaps a configured exclusion/wrapping area.  Those
        // three tower collision classes are slice-time advisories in Neo;
        // compute the typed warning projection before validation so only the
        // corresponding native tower diagnostics can be downgraded.  All
        // unrelated native validation failures remain blocking.
        json tower_warnings = json::array();
        try { tower_warnings = Neo::Bridge::PrimeTower::slice_warnings_for_plate(plate_id); }
        catch (...) { /* warning computation cannot affect native validation */ }
        // Drift at the pinned SHA: validate() returns StringObjectException
        // (PrintBase.hpp:30); use its .string member (same adaptation as
        // slice_main.cpp:55).
        const StringObjectException validation_error = print.validate();
        if (!validation_error.string.empty()) {
            const auto has_tower_warning = [&tower_warnings](const char* warning) {
                return std::find(tower_warnings.begin(), tower_warnings.end(), warning) != tower_warnings.end();
            };
            const auto is_exact_diagnostic = [&validation_error](const char* diagnostic) {
                std::string actual = validation_error.string;
                while (!actual.empty() && (actual.back() == '\r' || actual.back() == '\n')) actual.pop_back();
                return actual == diagnostic;
            };
            const bool exclusion_advisory =
                has_tower_warning("Prime Tower intersects an exclusion area.") &&
                is_exact_diagnostic("Prime Tower is too close to an exclusion area, and collisions will be caused.");
            const bool wrapping_advisory =
                has_tower_warning("Prime Tower intersects a wrapping-detection area.") &&
                is_exact_diagnostic("Prime Tower is too close to clumping detection area, and collisions will be caused.");
            if (!exclusion_advisory && !wrapping_advisory) return error_json(validation_error.string);
        }

        // Drift at the pinned SHA: SlicingStatus is nested as
        // PrintBase::SlicingStatus (PrintBase.hpp:440), not a Slic3r-top-level
        // type — qualify it (status_callback_type is PrintBase's typedef too).
        print.set_status_callback([&](const PrintBase::SlicingStatus& st) {
            publish_slicer_progress(st.percent, st.text);
        });
#ifdef ORCA_WASM_THREADING
        // Keep every libslic3r parallel_for inside the same fixed-size arena.
        // This mirrors the known-good oneTBB probe and prevents oneTBB from
        // trying to use more workers than Emscripten pre-created.
        state().tbb_arena.execute([&] { print.process(); });
#else
        print.process();
#endif
        print.set_status_default();
        const std::uint64_t current_revision = current_input_revision_for_plate(plate_id);
        const bool live_completion = state().plate_runtime_registry.mark_process_completed(
            *job_lease, revision, current_revision);
        finish_progress();
        if (!live_completion ||
            !state().plate_runtime_registry.can_publish_completed_job(
                *job_lease, current_revision))
            return result_unavailable_error();
        // Fix round 2: additive success field — always present, empty when the
        // config is clean. M2 clients (config UI) rely on this to warn about
        // keys the pinned libslic3r dropped (handle_legacy's catch-all).
        json dropped = json::array();
        for (const std::string& k : substitutions.unrecogized_keys)
            dropped.push_back(k);
        state().preview_plate_id = plate_id;
        state().preview_plate_revision = revision;
        json warnings = std::move(tower_warnings);
        try { warnings = Neo::Bridge::PrimeTower::slice_warnings_for_plate(plate_id); }
        catch (...) { /* advisory warnings must never turn a successful slice into a hard error */ }
        return dup_json(json{{"ok", true}, {"unrecognized_keys", std::move(dropped)},
                             {"warnings", std::move(warnings)},
                             {"receipt", projection_receipt(*runtime_entry)}}.dump());
    } catch (const std::exception& e) {
        if (job_lease)
            state().plate_runtime_registry.mark_process_failed(*job_lease);
        stop_progress();
        // process() is where libslic3r throws SlicingErrors (GCode.cpp:2250);
        // the helper surfaces the per-object messages instead of the bare
        // category. This is the only bridge call that can throw it, so the
        // other catches keep plain e.what().
        return error_json_from_exception(e);
    } catch (...) {
        if (job_lease)
            state().plate_runtime_registry.mark_process_failed(*job_lease);
        stop_progress();
        // Fix round 1: a canceled print (orc_cancel → PrintBase::cancel sets
        // CANCELED_BY_USER; only restart() clears it) makes the NEXT process()
        // abort — but the thrown type escaped the std::exception catch and
        // surfaced as an uncatchable CppException, killing the module (same
        // defect class as the stale progress callback). Emscripten -fexceptions
        // surfaces some C++ throws (and JS exceptions from imports) through a
        // non-std::exception path; a catch-all here keeps the API contract
        // "a call either returns JSON or the module stays alive".
        std::string msg = "unknown exception";
        try { throw; }
        catch (const std::string& s) { msg = s; }
        catch (const char* s) { msg = s ? s : "null"; }
        catch (...) {}
        return error_json(msg);
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_slice(const char* config_json) {
    ensure_plate_session_state();
    const auto revision = state().plate_input_revisions[state().current_plate_id];
    return slice_for_plate(config_json, state().current_plate_id, revision);
}

EMSCRIPTEN_KEEPALIVE const char* orc_slice_plate(const char* config_json,
                                                  const char* plate_id,
                                                  double revision_number) {
    try {
        if (!plate_id || !std::isfinite(revision_number) || revision_number < 0.0 ||
            std::floor(revision_number) != revision_number ||
            revision_number > static_cast<double>(std::numeric_limits<std::uint64_t>::max()))
            return error_json("invalid plate operation target");
        return slice_for_plate(config_json, plate_id,
                               static_cast<std::uint64_t>(revision_number));
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Binary preview result. v2 publishes explicit continuous segments as
// structure-of-arrays buffers. The returned pointers are transferred exactly
// once to the Worker client; that client copies each array and frees the
// corresponding heap allocation immediately (the JSON itself is freed by the
// normal callJson path).
EMSCRIPTEN_KEEPALIVE const char* orc_get_slice_result() {
    PlateRuntimeRegistry::Entry* runtime_entry = nullptr;
    try {
        ensure_plate_session_state();
        std::string target_error;
        runtime_entry = runtime_entry_for_plate(state().current_plate_id, target_error);
        if (runtime_entry == nullptr)
            return error_json(target_error);
        auto& print = *runtime_entry->print;
        const auto current_revision = current_input_revision_for_plate(state().current_plate_id);
        if (!PlateRuntimeRegistry::can_materialize_result(*runtime_entry, current_revision)) {
            PlateRuntimeRegistry::mark_presentation_invalid(*runtime_entry);
            return result_unavailable_error();
        }
        if (print.objects().empty()) {
            invalidate_preview_source();
            json empty_toolpath{{"segment_count", 0},
                                {"starts_ptr", 0}, {"ends_ptr", 0},
                                {"layer_id_ptr", 0}, {"move_order_ptr", 0},
                                {"gcode_id_ptr", 0}, {"move_type_ptr", 0},
                                {"extrusion_role_ptr", 0}, {"extruder_id_ptr", 0},
                                {"color_print_id_ptr", 0}, {"width_ptr", 0}, {"height_ptr", 0},
                                {"metrics", json::object()}};
            PlateRuntimeRegistry::mark_presentation_valid(*runtime_entry, current_revision);
            return dup_json(json{{"ok", true}, {"preview_version", 2},
                                 {"receipt", projection_receipt(*runtime_entry)},
                                 {"objects", 0}, {"layers", 0},
                                 {"metadata", json{{"result_id", 0}, {"layer_ranges", json::array()},
                                                    {"feature_palette", json::array()},
                                                    {"source_text", json{{"available", false}, {"byte_length", 0}}}}},
                                 {"toolpath", std::move(empty_toolpath)}}.dump());
        }

        // Orca's Print::export_gcode configures GCode with the selected plate
        // origin before emission. Passing a result sink keeps the native
        // GCodeProcessorResult while /out.gcode remains printer-local for
        // export/send. GCodeProcessor's MoveVertex already adds that same
        // origin to its rendering positions; the bridge therefore publishes
        // those positions unchanged as world-space preview coordinates.
        print.export_gcode("/out.gcode", runtime_entry->gcode_result.get(), nullptr);
        auto& gcode_result = *runtime_entry->gcode_result;
        {
            auto& bridge_state = state();
            bridge_state.preview_result_id = gcode_result.id;
            bridge_state.preview_gcode_path = "/out.gcode";
            std::ifstream source(bridge_state.preview_gcode_path, std::ios::binary | std::ios::ate);
            bridge_state.preview_text_available = source.good();
            bridge_state.preview_gcode_size = source.good()
                ? static_cast<std::size_t>(source.tellg())
                : 0;
            bridge_state.preview_gcode_line_ends.assign(gcode_result.lines_ends.begin(), gcode_result.lines_ends.end());
        }
        auto tp = bridge::build_toolpath(gcode_result);
        const auto analysis = bridge::build_preview_analysis(gcode_result, tp);
        // Layer count = max layer id present in the toolpath + 1. The gcode
        // spans the whole plate, so this covers every object's height — the
        // previous objects().front() cap hid taller objects' extra layers.
        const size_t layers = tp.layerCount;

        // Feature palette (local id → role/name/color). build_toolpath assigns
        // ids 0..N-1 in order of first use; the client derives the local id
        // for each segment from this table and extrusion_roles.
        json feature_palette = json::array();
        for (const auto& [role, info] : tp.palette_used) {
            const auto id = static_cast<int>(feature_palette.size());
            feature_palette.push_back({{"id", id}, {"role", static_cast<unsigned>(role)},
                                       {"name", info.name},
                                       {"color", {info.color[0], info.color[1], info.color[2]}}});
        }

        json layer_ranges = json::array();
        for (const auto& range : tp.layer_ranges)
            if (range.count > 0)
                layer_ranges.push_back({{"id", range.id}, {"z", range.z},
                                         {"first_segment", range.first},
                                         {"segment_count", range.count}});

        // Match Orca's Plater::get_extruder_colors_from_plater_config() path:
        // a sliced project uses PresetBundle::project_config's filament_colour
        // palette, indexed by logical filament slot. GCodeProcessorResult owns
        // the equivalent palette for standalone G-code viewer input, but its
        // default entries are not authoritative for a sliced project.
        // Plate-local geometry remains in the active Print; palette ownership
        // deliberately follows Orca's project-level configuration path.
        // Read the live PresetBundle project config directly.  DynamicPrintConfig's
        // copy path is intentionally a normalized print-config carrier and can
        // omit project-only vector options such as filament_colour; Orca's
        // Plater path reads PresetBundle::project_config in place as well.
        const json filament_session = Filament::Session::filament_session_snapshot_json();
        const json* active_slots = filament_session.value("ok", false) &&
                filament_session.contains("slots") && filament_session["slots"].is_array()
            ? &filament_session["slots"] : nullptr;
        json extruder_palette = json::array();
        const size_t active_color_count = active_slots ? active_slots->size() : 0;
        const size_t palette_count = active_color_count > 0
            ? active_color_count : gcode_result.extruder_colors.size();
        for (size_t tool = 0; tool < palette_count; ++tool) {
            ColorRGB color;
            std::string source_color;
            if (active_slots && tool < active_color_count &&
                (*active_slots)[tool].is_object() &&
                (*active_slots)[tool]["colour"].is_object())
                source_color = (*active_slots)[tool]["colour"].value("effective", "");
            else if (tool < gcode_result.extruder_colors.size())
                source_color = gcode_result.extruder_colors[tool];
            if (source_color.empty() || !decode_color(source_color, color)) continue;
            const std::string name = tool < gcode_result.settings_ids.filament.size() &&
                    !gcode_result.settings_ids.filament[tool].empty()
                ? gcode_result.settings_ids.filament[tool]
                : "Tool " + std::to_string(tool + 1);
            extruder_palette.push_back({
                {"id", tool}, {"tool", tool}, {"name", name},
                {"color", {color.r_uchar(), color.g_uchar(), color.b_uchar()}},
            });
        }

        auto ptr = [](const MallocBuffer& buffer) -> std::uintptr_t {
            return reinterpret_cast<std::uintptr_t>(buffer.data);
        };
        json metrics = {
            {"feedrate", { {"ptr", ptr(tp.feedrates)}, {"count", tp.segmentCount} }},
            {"actual_feedrate", { {"ptr", ptr(tp.actual_feedrates)}, {"count", tp.segmentCount} }},
            {"volumetric_flow", { {"ptr", ptr(tp.volumetric_flows)}, {"count", tp.segmentCount} }},
            {"actual_volumetric_flow", { {"ptr", ptr(tp.actual_volumetric_flows)}, {"count", tp.segmentCount} }},
            {"fan_speed", { {"ptr", ptr(tp.fan_speeds)}, {"count", tp.segmentCount} }},
            {"temperature", { {"ptr", ptr(tp.temperatures)}, {"count", tp.segmentCount} }},
            {"pressure_advance", { {"ptr", ptr(tp.pressure_advances)}, {"count", tp.segmentCount} }},
            {"acceleration", { {"ptr", ptr(tp.accelerations)}, {"count", tp.segmentCount} }},
            {"jerk", { {"ptr", ptr(tp.jerks)}, {"count", tp.segmentCount} }},
            {"time", { {"ptr", ptr(tp.times)}, {"count", tp.segmentCount} }},
            {"layer_duration", { {"ptr", ptr(tp.layer_durations)}, {"count", tp.segmentCount} }},
        };

        // wasm64: heap pointers as uintptr_t (see orc_get_model_mesh).
        const std::uintptr_t ts = ptr(tp.starts);
        const std::uintptr_t te = ptr(tp.ends);

        json out{{"ok", true}, {"preview_version", 2},
                 {"receipt", projection_receipt(*runtime_entry)},
                 {"objects", print.objects().size()}, {"layers", layers}};
        out["metadata"] = {
            {"result_id", gcode_result.id}, {"source_filename", gcode_result.filename},
            {"layer_ranges", std::move(layer_ranges)},
            {"feature_palette", std::move(feature_palette)},
            // Full G-code text is intentionally not copied. gcode_ids are
            // source-line identifiers; lines_ends records that source mapping
            // is available for a future chunked text API.
            {"source_line_mapping", json{{"available", !gcode_result.lines_ends.empty()},
                                           {"line_count", gcode_result.lines_ends.size()}}},
            {"source_text", json{{"available", state().preview_text_available},
                                  {"byte_length", state().preview_gcode_size}}},
        };
        if (!extruder_palette.empty()) out["metadata"]["extruder_palette"] = std::move(extruder_palette);
        json summary = json::object();
        if (analysis.has_estimated_time) summary["estimated_time_seconds"] = analysis.estimated_time_seconds;
        if (analysis.has_filament_length) summary["filament_length_meters"] = analysis.filament_length_meters;
        if (analysis.has_filament_weight) summary["filament_weight_grams"] = analysis.filament_weight_grams;
        if (analysis.has_filament_cost) summary["filament_cost"] = analysis.filament_cost;
        json feature_statistics = json::array();
        for (const auto& stats : analysis.feature_statistics) {
            json entry{{"feature_id", stats.feature_id}};
            if (stats.has_time) entry["time_seconds"] = stats.time_seconds;
            if (stats.has_filament) {
                entry["filament_length_meters"] = stats.filament_length_meters;
                entry["filament_weight_grams"] = stats.filament_weight_grams;
            }
            feature_statistics.push_back(std::move(entry));
        }
        out["metadata"]["analysis"] = {
            {"summary", std::move(summary)},
            {"feature_statistics", std::move(feature_statistics)},
        };
        out["toolpath"] = {
            {"segment_count", tp.segmentCount},
            {"starts_ptr", ts}, {"ends_ptr", te},
            {"layer_id_ptr", ptr(tp.layers)}, {"move_order_ptr", ptr(tp.move_orders)},
            {"gcode_id_ptr", ptr(tp.gcode_ids)}, {"move_type_ptr", ptr(tp.move_types)},
            {"extrusion_role_ptr", ptr(tp.extrusion_roles)},
            {"extruder_id_ptr", ptr(tp.extruders)},
            {"color_print_id_ptr", ptr(tp.color_prints)},
            {"width_ptr", ptr(tp.widths)}, {"height_ptr", ptr(tp.heights)},
            {"metrics", std::move(metrics)},
        };
        // Every pointer above is released after it has been recorded. JS now
        // owns the corresponding bytes and must _free() each exactly once.
        tp.starts.release(); tp.ends.release();
        tp.layers.release(); tp.move_orders.release(); tp.gcode_ids.release();
        tp.move_types.release(); tp.extrusion_roles.release(); tp.extruders.release();
        tp.color_prints.release(); tp.widths.release(); tp.heights.release();
        tp.feedrates.release(); tp.actual_feedrates.release();
        tp.volumetric_flows.release(); tp.actual_volumetric_flows.release();
        tp.fan_speeds.release(); tp.temperatures.release(); tp.pressure_advances.release();
        tp.accelerations.release(); tp.jerks.release(); tp.times.release();
        tp.layer_durations.release();
        PlateRuntimeRegistry::mark_presentation_valid(
            *runtime_entry, current_input_revision_for_plate(state().current_plate_id));
        return dup_json(out.dump());
    } catch (const std::exception& e) {
        // Projection construction is presentation-only work. A failed copy or
        // allocation may be retried from the retained native core result and
        // must not revoke Export eligibility or mutate registry ownership.
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

// Read a bounded byte range from the current completed result's exported
// G-code. The source is kept in MEMFS and opened only for this request; the
// initial preview payload contains metadata and line identifiers, never the
// complete text. `offset` and `length` are doubles at the Emscripten ABI so
// wasm32/wasm64 callers share one signature; both are validated as exact,
// non-negative integers before conversion.
EMSCRIPTEN_KEEPALIVE const char* orc_read_gcode_chunk(double result_id_number,
                                                      double offset_number,
                                                      double length_number) {
    try {
        constexpr std::size_t max_chunk_bytes = 64 * 1024;
        constexpr std::size_t max_alignment_overrun_bytes = 3;
        constexpr std::size_t max_response_bytes = max_chunk_bytes + max_alignment_overrun_bytes * 2;
        auto& bridge_state = state();
        const auto valid_integer = [](double value) {
            return std::isfinite(value) && value >= 0.0 &&
                   std::floor(value) == value &&
                   value <= static_cast<double>(std::numeric_limits<std::size_t>::max());
        };
        if (!valid_integer(result_id_number) || !valid_integer(offset_number) ||
            !valid_integer(length_number))
            return dup_json(json{{"ok", false}, {"error", "invalid chunk range"}}.dump());

        if (result_id_number > static_cast<double>(std::numeric_limits<std::uint32_t>::max()))
            return dup_json(json{{"ok", false}, {"error", "invalid result id"}}.dump());
        const auto result_id = static_cast<std::uint32_t>(result_id_number);
        const auto requested_offset = static_cast<std::size_t>(offset_number);
        const auto requested_length = static_cast<std::size_t>(length_number);
        if (result_id == 0 || result_id != bridge_state.preview_result_id ||
            !bridge_state.preview_text_available)
            return dup_json(json{{"ok", false}, {"error", "preview text is unavailable"}}.dump());
        if (requested_length > max_chunk_bytes || requested_offset > bridge_state.preview_gcode_size)
            return dup_json(json{{"ok", false}, {"error", "chunk range is outside the preview text"}}.dump());

        // Align the returned bytes to UTF-8 code-point boundaries. A caller
        // may request arbitrary byte offsets (for example after estimating a
        // virtualized line viewport), so include up to three preceding bytes
        // and up to three continuation bytes after the requested range.
        std::size_t actual_offset = requested_offset;
        std::size_t actual_end = std::min(bridge_state.preview_gcode_size,
                                          requested_offset + requested_length);
        std::ifstream source(bridge_state.preview_gcode_path, std::ios::binary);
        if (!source.good())
            return dup_json(json{{"ok", false}, {"error", "preview text could not be opened"}}.dump());
        auto read_byte = [&](std::size_t position, unsigned char& value) {
            source.clear();
            source.seekg(static_cast<std::streamoff>(position), std::ios::beg);
            char byte = 0;
            if (!source.get(byte)) return false;
            value = static_cast<unsigned char>(byte);
            return true;
        };
        if (requested_length > 0 && actual_offset > 0) {
            unsigned char byte = 0;
            std::size_t continuation_bytes = 0;
            while (actual_offset > 0 && continuation_bytes < max_alignment_overrun_bytes && read_byte(actual_offset, byte) &&
                   (byte & 0xc0u) == 0x80u)
                --actual_offset, ++continuation_bytes;
        }
        if (requested_length > 0 && actual_end < bridge_state.preview_gcode_size) {
            unsigned char byte = 0;
            while (actual_end < bridge_state.preview_gcode_size &&
                   actual_end < requested_offset + requested_length + max_alignment_overrun_bytes &&
                   read_byte(actual_end, byte) && (byte & 0xc0u) == 0x80u)
                ++actual_end;
        }
        const auto byte_count = actual_end - actual_offset;
        if (byte_count > max_response_bytes)
            return dup_json(json{{"ok", false}, {"error", "aligned chunk exceeds bounded response"}}.dump());
        auto* bytes = static_cast<std::uint8_t*>(std::malloc(byte_count == 0 ? 1 : byte_count));
        if (byte_count > 0) {
            source.clear();
            source.seekg(static_cast<std::streamoff>(actual_offset), std::ios::beg);
            source.read(reinterpret_cast<char*>(bytes), static_cast<std::streamsize>(byte_count));
            if (source.gcount() != static_cast<std::streamsize>(byte_count)) {
                std::free(bytes);
                return dup_json(json{{"ok", false}, {"error", "preview text read failed"}}.dump());
            }
        }
        return dup_json(json{{"ok", true}, {"result_id", bridge_state.preview_result_id},
                             {"offset", actual_offset}, {"length", byte_count},
                             {"eof", actual_end >= bridge_state.preview_gcode_size},
                             {"bytes_ptr", reinterpret_cast<std::uintptr_t>(bytes)},
                             {"bytes_length", byte_count}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Read a seekable bounded page of complete source lines. The line-end table
// stays in the bridge's current result; only the requested bytes cross the
// seam, so late-line inspection never walks or copies the preceding file.
EMSCRIPTEN_KEEPALIVE const char* orc_read_gcode_lines(double result_id_number,
                                                      double start_line_number,
                                                      double line_count_number) {
    try {
        constexpr std::size_t max_line_count = 128;
        constexpr std::size_t max_page_bytes = 64 * 1024;
        auto& bridge_state = state();
        const auto valid_integer = [](double value) {
            return std::isfinite(value) && value >= 0.0 &&
                   std::floor(value) == value &&
                   value <= static_cast<double>(std::numeric_limits<std::size_t>::max());
        };
        if (!valid_integer(result_id_number) || !valid_integer(start_line_number) ||
            !valid_integer(line_count_number) ||
            result_id_number > static_cast<double>(std::numeric_limits<std::uint32_t>::max()))
            return dup_json(json{{"ok", false}, {"error", "invalid source line page"}}.dump());
        const auto result_id = static_cast<std::uint32_t>(result_id_number);
        const auto start_line = static_cast<std::size_t>(start_line_number);
        const auto line_count = static_cast<std::size_t>(line_count_number);
        if (result_id == 0 || result_id != bridge_state.preview_result_id ||
            !bridge_state.preview_text_available)
            return dup_json(json{{"ok", false}, {"error", "preview text is unavailable"}}.dump());
        if (line_count == 0 || line_count > max_line_count ||
            start_line == 0 || start_line > bridge_state.preview_gcode_line_ends.size())
            return dup_json(json{{"ok", false}, {"error", "source line page is outside the preview"}}.dump());
        const auto end_line = std::min(bridge_state.preview_gcode_line_ends.size(),
                                      start_line + line_count - 1);
        const auto start_byte = start_line == 1 ? 0 : bridge_state.preview_gcode_line_ends[start_line - 2];
        const auto end_byte = bridge_state.preview_gcode_line_ends[end_line - 1];
        if (start_byte > end_byte || end_byte > bridge_state.preview_gcode_size ||
            end_byte - start_byte > max_page_bytes)
            return dup_json(json{{"ok", false}, {"error", "source line page exceeds byte bound"}}.dump());
        std::ifstream source(bridge_state.preview_gcode_path, std::ios::binary);
        if (!source.good())
            return dup_json(json{{"ok", false}, {"error", "preview text could not be opened"}}.dump());
        const auto byte_count = end_byte - start_byte;
        auto* bytes = static_cast<std::uint8_t*>(std::malloc(byte_count == 0 ? 1 : byte_count));
        source.seekg(static_cast<std::streamoff>(start_byte), std::ios::beg);
        if (byte_count > 0) {
            source.read(reinterpret_cast<char*>(bytes), static_cast<std::streamsize>(byte_count));
            if (source.gcount() != static_cast<std::streamsize>(byte_count)) {
                std::free(bytes);
                return dup_json(json{{"ok", false}, {"error", "preview text read failed"}}.dump());
            }
        }
        return dup_json(json{{"ok", true}, {"result_id", bridge_state.preview_result_id},
                             {"start_line", start_line}, {"line_count", end_line - start_line + 1},
                             {"eof", end_line == bridge_state.preview_gcode_line_ends.size()},
                             {"bytes_ptr", reinterpret_cast<std::uintptr_t>(bytes)},
                             {"bytes_length", byte_count}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

const char* export_gcode_for_target(const std::string& plate_id,
                                    const std::uint64_t revision) {
    PlateRuntimeRegistry::Entry* runtime_entry = nullptr;
    try {
        std::string target_error;
        if (!validate_plate_operation_target(plate_id, revision, target_error))
            return error_json(target_error);
        runtime_entry = runtime_entry_for_plate(plate_id, target_error);
        if (runtime_entry == nullptr)
            return error_json(target_error);
        const auto current_revision = current_input_revision_for_plate(plate_id);
        if (!PlateRuntimeRegistry::can_materialize_result(
                *runtime_entry, current_revision))
            return result_unavailable_error();
        if (!runtime_entry->completed_input_revision.has_value() ||
            *runtime_entry->completed_input_revision != revision)
            return result_unavailable_error();
        const std::string path = "/out.gcode";
        runtime_entry->print->export_gcode(path, nullptr, nullptr);
        PlateRuntimeRegistry::mark_presentation_valid(*runtime_entry, current_revision);
        return dup_json(json{{"ok", true}, {"path", path}}.dump());
    } catch (const std::exception& e) {
        if (runtime_entry != nullptr)
            PlateRuntimeRegistry::mark_presentation_invalid(*runtime_entry);
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        if (runtime_entry != nullptr)
            PlateRuntimeRegistry::mark_presentation_invalid(*runtime_entry);
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_export_gcode() {
    PlateRuntimeRegistry::Entry* runtime_entry = nullptr;
    try {
        ensure_plate_session_state();
        std::string target_error;
        runtime_entry = runtime_entry_for_plate(state().current_plate_id, target_error);
        if (runtime_entry == nullptr)
            return error_json(target_error);
        const auto current_revision = current_input_revision_for_plate(state().current_plate_id);
        if (!PlateRuntimeRegistry::can_materialize_result(*runtime_entry, current_revision))
            return result_unavailable_error();
        const std::string path = "/out.gcode";
        runtime_entry->print->export_gcode(path, nullptr, nullptr);
        PlateRuntimeRegistry::mark_presentation_valid(*runtime_entry, current_revision);
        return dup_json(json{{"ok", true}, {"path", path}}.dump());
    } catch (const std::exception& e) {
        if (runtime_entry != nullptr)
            PlateRuntimeRegistry::mark_presentation_invalid(*runtime_entry);
        return error_json(e.what());
    } catch (...) {
        if (runtime_entry != nullptr)
            PlateRuntimeRegistry::mark_presentation_invalid(*runtime_entry);
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_export_gcode_plate(const char* plate_id,
                                                         double revision_number) {
    try {
        if (!plate_id || !std::isfinite(revision_number) || revision_number < 0.0 ||
            std::floor(revision_number) != revision_number ||
            revision_number > static_cast<double>(std::numeric_limits<std::uint64_t>::max()))
            return error_json("invalid plate operation target");
        return export_gcode_for_target(plate_id,
                                       static_cast<std::uint64_t>(revision_number));
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_cancel() {
    try {
        ensure_plate_session_state();
        std::string target_error;
        auto* runtime_entry = runtime_entry_for_plate(state().current_plate_id, target_error);
        if (runtime_entry == nullptr)
            return error_json(target_error);
        PlateRuntimeRegistry::mark_presentation_invalid(*runtime_entry);
        invalidate_preview_source();
        runtime_entry->print->cancel();
        // Fix round 1: the bridge is strictly synchronous — JS cannot reenter
        // wasm while orc_slice is running, so a cancel can never interrupt an
        // in-flight slice. A surviving CANCELED_BY_USER flag (only restart()
        // clears it, PrintBase.hpp) makes the NEXT orc_slice's process()
        // throw CanceledException, which on Emscripten's -fexceptions runtime
        // surfaces as an uncatchable CppException that kills the module
        // (observed deterministically; the throw is caught and rethrown by
        // libslic3r internals, and the rethrow carries poisoned EH state).
        // Cancel is therefore a state reset: it must never poison the module.
        runtime_entry->print->restart();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

// Lightweight build/runtime diagnostic for the worker client and smoke tests.
// It does not initialize presets or mutate the model, so it is safe to query
// before normal bridge setup.
EMSCRIPTEN_KEEPALIVE const char* orc_get_threading_info() {
#ifdef ORCA_WASM_THREADING
    return dup_json(json{{"ok", true}, {"threaded", true},
                         {"max_concurrency", state().tbb_max_concurrency},
                         {"arena_concurrency", state().tbb_arena.max_concurrency()}}.dump());
#else
    return dup_json(json{{"ok", true}, {"threaded", false},
                         {"max_concurrency", 1}, {"arena_concurrency", 1}}.dump());
#endif
}

}

} // namespace Slic3r::Neo::Bridge::SlicingPipeline
