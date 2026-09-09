// ----------------------------------------------------------------
// ------------ extern "C" JSON-in/JSON-out bridge ----------------
// ----------------------------------------------------------------
// The only C++<->JS seam (design §Bridge API). Every function runs
// synchronously on the worker thread. JSON strings are returned as malloc'd
// C strings; the JS side reads them with UTF8ToString and _free()s. Binary
// buffers cross via the WASM heap (_malloc/_free + HEAPU8).
//
// Version-sensitive libslic3r APIs are the documented drift surface
// (AGENTS.md): if a signature below mismatches the pinned submodule, adjust
// here — never in the submodule.
#include <emscripten/emscripten.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "libslic3r/AppConfig.hpp"
#include "libslic3r/BuildVolume.hpp"
#include "libslic3r/Color.hpp"
#include "libslic3r/Exception.hpp"
#include "libslic3r/FlushVolCalc.hpp"
#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/miniz_extension.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/PresetBundle.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/TriangleMesh.hpp"
#include "libslic3r/Utils.hpp"

#include "bridge_buffers.hpp"
#include "bridge_filament_state.hpp"
#include "bridge_filament_commands.hpp"
#include "bridge_history_runtime.hpp"
#include "bridge_model_operations.hpp"
#include "bridge_plate_session.hpp"
#include "bridge_plate_commands.hpp"
#include "bridge_profiles.hpp"
#include "bridge_project_persistence.hpp"
#include "bridge_slicing_pipeline.hpp"
#include "bridge_state.hpp"
// Drift at the pinned SHA: GCodeProcessor.hpp lives under GCode/; the brief's
// PrintObject.hpp does not exist (class PrintObject is in Print.hpp, already
// included above).
#include "libslic3r/GCode/GCodeProcessor.hpp"

#include <boost/log/trivial.hpp>

#include "wasm_log.hpp"

#ifdef ORCA_WASM_THREADING
#include <tbb/global_control.h>
#include <tbb/task_arena.h>
#endif

#include "nlohmann/json.hpp"

using namespace Slic3r;
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

// Bridge business helpers keep the C ABI and command transactions in this
// translation unit; filament projections and field-level history state live
// in bridge_filament_state.cpp.
using Neo::Bridge::BridgeState;
using Neo::Bridge::state;
using Neo::Bridge::FilamentState::config_metadata_json;
using namespace Neo::Bridge::FilamentCommands;
using Neo::Bridge::FilamentState::history_state_json;
using Neo::Bridge::Profiles::preset_snapshot_json;
using namespace Neo::Bridge::ModelOperations;
using namespace Neo::Bridge::PlateSession;
using Neo::Bridge::PlateCommands::plate_configuration_mutation_snapshot;
using namespace Neo::Bridge::SlicingPipeline;
using Neo::Bridge::ProjectPersistence::empty_project_config_overlay;
using Neo::Bridge::ProjectPersistence::valid_project_config_overlay;

constexpr const char* kNeoPlateMetadataEntry = "Metadata/orca_neo_plate_session_v1.json";
constexpr const char* kNeoPlateMetadataSchema = "org.orcaslicerneo.plate-session";
constexpr const char* kNeoConfigOverlayEntry = "Metadata/orca_neo_config_overlay_v1.json";
constexpr const char* kNeoConfigOverlaySchema = "org.orcaslicerneo.config-overlay";
constexpr const char* kNeoFilamentStateEntry = "Metadata/orca_neo_filament_state_v1.json";
constexpr const char* kNeoFilamentStateSchema = "org.orcaslicerneo.filament-state";

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

std::string sanitized_model_basename(const char* filename, const char* ext) {
    std::string name = filename ? filename : "";
    const auto slash = name.find_last_of("\\/");
    if (slash != std::string::npos) name.erase(0, slash + 1);
    for (char& c : name) {
        const unsigned char uc = static_cast<unsigned char>(c);
        if (!(std::isalnum(uc) || c == '.' || c == '_' || c == '-')) c = '_';
    }
    std::string fallback_ext = ext && *ext ? ext : "stl";
    if (name.empty() || name == "." || name == "..") name = "uploaded_model." + fallback_ext;
    if (name.find_last_of('.') == std::string::npos) name += "." + fallback_ext;
    return name;
}

// SlicingErrors' what() is just the category "Errors" (Exception.hpp:44) —
// the real per-object messages live in its errors_ vector (GCode.cpp:
// collect_layers_to_print aggregates per-object SlicingErrors and rethrows).
// Returning e.what() alone made the renderer show only "Errors" with no
// way to see what actually failed; join the underlying messages instead.
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

// Step 1 filament-session projection.  This is deliberately a read-only
// native projection: slot numbering, maps, colours, assignments, and
// capability limits are all read from the active PresetBundle/Model session.
// The wire keys stay snake_case at the C ABI, just like the other bridge
// snapshots; client.ts owns the only normalization to application types.
std::vector<std::string> config_strings(const DynamicPrintConfig& config, const char* key)
{
    if (const auto* option = config.opt<ConfigOptionStrings>(key)) return option->values;
    return {};
}

// Keep the requested slot order from the imported project before
// load_config_model performs native preset selection/fallback.  The latter is
// the effective state; it is not provenance for the compatibility report.
std::vector<std::string> requested_filament_slots_from_import(
    const DynamicPrintConfig& config, const std::vector<std::string>& fallback)
{
    const auto requested = config_strings(config, "filament_settings_id");
    return requested.empty() ? fallback : requested;
}

// load_bbs_3mf may already normalize the DynamicPrintConfig before the
// candidate's load_config_model call.  BBS/Orca JSON is therefore retained as
// the provenance source for the compatibility report when it is available.
std::vector<std::string> requested_filament_slots_from_project_settings(
    const std::optional<std::string>& bytes, const std::vector<std::string>& fallback)
{
    if (bytes) {
        const json parsed = json::parse(*bytes, nullptr, false);
        if (parsed.is_object() && parsed.contains("filament_settings_id")) {
            const auto& value = parsed["filament_settings_id"];
            std::vector<std::string> result;
            if (value.is_array()) {
                for (const auto& item : value)
                    if (!item.is_string()) return fallback;
                    else result.push_back(item.get<std::string>());
            } else if (value.is_string()) {
                result.push_back(value.get<std::string>());
            } else {
                return fallback;
            }
            if (!result.empty()) return result;
        }
    }
    return fallback;
}
std::vector<int> config_ints(const DynamicPrintConfig& config, const char* key)
{
    if (const auto* option = config.opt<ConfigOptionInts>(key)) return option->values;
    return {};
}
std::vector<double> config_floats(const DynamicPrintConfig& config, const char* key)
{
    if (const auto* option = config.opt<ConfigOptionFloats>(key)) return option->values;
    return {};
}

json filament_session_error_json(const char* code, const char* message)
{
    return { {"ok", false}, {"version", 1}, {"error", message}, {"error_code", code},
             {"status", {{"state", "error"}, {"error", message}}} };
}

bool effective_filament_int_map(const DynamicPrintConfig& primary, const char* key,
                                const DynamicPrintConfig& fallback, size_t slot_count,
                                int default_value, std::vector<int>& out)
{
    out = config_ints(primary, key);
    if (out.empty()) out = config_ints(fallback, key);
    if (out.size() > slot_count) return false;
    out.resize(slot_count, default_value);
    return true;
}

json filament_session_snapshot_json()
{
    PresetBundle& bundle = state().presets;
    const DynamicPrintConfig& project = bundle.project_config;
    const DynamicPrintConfig& printer = bundle.printers.get_edited_preset().config;
    const DynamicPrintConfig& filament = bundle.filaments.get_edited_preset().config;

    std::vector<std::string> preset_names = bundle.filament_presets;
    std::vector<std::string> colours = config_strings(project, "filament_colour");
    if (colours.empty()) colours = config_strings(filament, "filament_colour");
    if (preset_names.empty())
        return filament_session_error_json("filament_slots_missing", "filament rack has no slots");
    const size_t slot_count = std::max<size_t>(1, std::max(preset_names.size(), colours.size()));
    if (preset_names.size() < slot_count) {
        return filament_session_error_json("filament_slots_mismatched", "filament rack slots and colours differ");
    }
    std::vector<std::string> preset_colours(slot_count);
    const auto native_default_colours = state().profile_config.get_filament_colors();
    // PresetBundle materializes this same native fallback when a selected
    // filament preset has no explicit filament_colour (the common Generic
    // PLA/default session). Keep the projection aligned with that native
    // effective colour rather than treating the materialized project value as
    // a user edit.
    constexpr const char* native_filament_colour_fallback = "#26A69A";
    for (size_t i = 0; i < slot_count; ++i) {
        if (const Preset* real_preset = bundle.filaments.find_preset(preset_names[i], false, true)) {
            const auto native_colours = config_strings(real_preset->config, "filament_colour");
            if (!native_colours.empty()) preset_colours[i] = native_colours.front();
            else {
                const auto default_colours = config_strings(real_preset->config, "default_filament_colour");
                if (!default_colours.empty()) preset_colours[i] = default_colours.front();
            }
        }
        if (preset_colours[i].empty() && i < native_default_colours.size())
            preset_colours[i] = native_default_colours[i];
        if (preset_colours[i].empty())
            preset_colours[i] = native_filament_colour_fallback;
    }
    if (colours.size() < slot_count) {
        const auto defaults = state().profile_config.get_filament_colors();
        for (size_t i = colours.size(); i < slot_count; ++i)
            colours.push_back(!preset_colours[i].empty() ? preset_colours[i] :
                              (i < defaults.size() ? defaults[i] : std::string("#000000")));
    }

    json slots = json::array();
    for (size_t i = 0; i < slot_count; ++i) {
        const std::string& name = preset_names[i];
        // project_config.filament_colour is materialized during init even for
        // pristine sessions. Provenance therefore uses effective equivalence
        // with the real selected preset colour. An explicit override equal to
        // that colour is intentionally reported as preset-equivalent because a
        // read-only native projection cannot recover edit history.
        const bool preset_equivalent = !preset_colours[i].empty() && colours[i] == preset_colours[i];
        slots.push_back({
            {"slot", i + 1},
            {"preset", {{"id", name}, {"name", name}}},
            {"colour", {{"effective", colours[i]}, {"provenance", preset_equivalent ? "preset" : "user"}}},
        });
    }

    std::vector<int> filament_map;
    std::vector<int> volume_map;
    std::vector<int> nozzle_map;
    std::vector<int> filament_map_2;
    if (!effective_filament_int_map(project, "filament_map", printer, slot_count, 1, filament_map))
        return filament_session_error_json("filament_map_too_long", "filament_map exceeds slot count");
    if (!effective_filament_int_map(project, "filament_volume_map", printer, slot_count, 0, volume_map))
        return filament_session_error_json("filament_volume_map_too_long", "filament_volume_map exceeds slot count");
    if (!effective_filament_int_map(project, "filament_nozzle_map", printer, slot_count, 1, nozzle_map))
        return filament_session_error_json("filament_nozzle_map_too_long", "filament_nozzle_map exceeds slot count");
    if (!effective_filament_int_map(project, "filament_map_2", printer, slot_count, 1, filament_map_2))
        return filament_session_error_json("filament_map_2_too_long", "filament_map_2 exceeds slot count");

    const int printer_nozzles = std::max(1, bundle.get_printer_extruder_count());
    std::vector<int> physical_map;
    if (!effective_filament_int_map(printer, "physical_extruder_map", printer,
                                    static_cast<size_t>(printer_nozzles), 0, physical_map))
        return filament_session_error_json("physical_extruder_map_too_long", "physical_extruder_map exceeds nozzle count");
    json mappings = {
        {"filament", filament_map}, {"volume", volume_map}, {"nozzle", nozzle_map},
        {"filament2", filament_map_2}, {"physical_extruder", physical_map},
    };

    auto matrix = config_floats(project, "flush_volumes_matrix");
    if (matrix.empty()) matrix = config_floats(printer, "flush_volumes_matrix");
    const bool matrix_is_native = !matrix.empty();
    size_t matrix_dimension = slot_count;
    size_t matrix_plane_count = 1;
    if (matrix.empty()) {
        matrix_plane_count = static_cast<size_t>(printer_nozzles);
        matrix.assign(matrix_dimension * matrix_dimension * matrix_plane_count, 0.0);
    } else {
        const size_t plane_size = matrix_dimension * matrix_dimension;
        if (plane_size == 0 || matrix.size() % plane_size != 0)
            return filament_session_error_json("flush_matrix_malformed", "flush_volumes_matrix is not a whole native plane");
        matrix_plane_count = matrix.size() / plane_size;
        // Native get_flush_volumes_matrix() treats the raw vector as one
        // complete slot matrix per physical nozzle. Preserve every plane;
        // reject a count that cannot be selected by that native API.
        if (matrix_plane_count == 0 || matrix_plane_count != static_cast<size_t>(printer_nozzles))
            return filament_session_error_json("flush_matrix_plane_count_mismatch", "flush_volumes_matrix plane count does not match nozzle count");
        if (std::any_of(matrix.begin(), matrix.end(), [](double value) { return !std::isfinite(value); }))
            return filament_session_error_json("flush_matrix_malformed", "flush_volumes_matrix contains invalid values");
    }
    auto flush_vector = config_floats(project, "flush_volumes_vector");
    if (flush_vector.empty()) flush_vector = config_floats(printer, "flush_volumes_vector");
    json flushing = {{"matrix", matrix}, {"vector", flush_vector},
                     {"matrix_dimension", matrix_dimension}, {"plane_count", matrix_plane_count},
                     {"source", matrix_is_native ? "native" : "default"}};

    const bool flexible_slots = printer.opt_bool("single_extruder_multi_material") || bundle.is_bbl_vendor();
    const int min_slots = flexible_slots ? 1 : printer_nozzles;
    json capabilities = {
        {"min_slots", min_slots}, {"max_slots", 64}, {"nozzle_count", printer_nozzles},
        {"flexible", flexible_slots},
        {"can_add", flexible_slots && slot_count < 64},
        {"can_delete", flexible_slots && slot_count > 1},
        {"can_merge", flexible_slots && slot_count > 1},
    };

    struct Assignment { std::string target; uint32_t id; uint32_t object_id; int explicit_slot; int effective_slot; bool inherited; };
    std::vector<Assignment> objects;
    std::vector<Assignment> parts;
    std::vector<Assignment> modifiers;
    auto explicit_extruder = [](const auto& config) {
        if (const auto* option = dynamic_cast<const ConfigOptionInt*>(config.option("extruder")))
            return std::max(0, option->value);
        return 0;
    };
    for (const ModelObject* object : state().model.objects) {
        if (object == nullptr) continue;
        const int object_explicit = std::max(1, explicit_extruder(object->config));
        const int object_effective = object_explicit;
        if (object_effective > static_cast<int>(slot_count))
            return filament_session_error_json("assignment_slot_out_of_range", "object assignment exceeds slot count");
        objects.push_back({"object", static_cast<uint32_t>(object->id().id), static_cast<uint32_t>(object->id().id), object_explicit, object_effective, false});
        for (const ModelVolume* volume : object->volumes) {
            if (volume == nullptr) continue;
            const auto type = volume->type();
            if (type != ModelVolumeType::MODEL_PART && type != ModelVolumeType::PARAMETER_MODIFIER) continue;
            const int explicit_slot = explicit_extruder(volume->config);
            // Restored history models are materialized from the archive and
            // intentionally do not rely on ModelVolume's parent back-pointer.
            // Resolve inheritance from the serialized configs directly.
            const int effective_slot = std::max(1, explicit_slot == 0 ? object_explicit : explicit_slot);
            const bool inherited = explicit_slot == 0;
            if (explicit_slot > static_cast<int>(slot_count) || effective_slot > static_cast<int>(slot_count) ||
                (!inherited && effective_slot != explicit_slot))
                return filament_session_error_json("assignment_slot_out_of_range", "volume assignment exceeds slot count");
            Assignment item{type == ModelVolumeType::MODEL_PART ? "model-part" : "parameter-modifier",
                            static_cast<uint32_t>(volume->id().id), static_cast<uint32_t>(object->id().id), explicit_slot, effective_slot, inherited};
            (type == ModelVolumeType::MODEL_PART ? parts : modifiers).push_back(item);
        }
    }
    auto assignment_json = [](const std::vector<Assignment>& values) {
        json out = json::array();
        for (const Assignment& item : values)
            out.push_back({{"target", item.target}, {"id", item.id}, {"object_id", item.object_id},
                           {"explicit_slot", item.explicit_slot}, {"effective_slot", item.effective_slot},
                           {"inherited", item.inherited}});
        return out;
    };
    std::sort(objects.begin(), objects.end(), [](const Assignment& a, const Assignment& b) { return a.id < b.id; });
    std::sort(parts.begin(), parts.end(), [](const Assignment& a, const Assignment& b) { return a.id < b.id; });
    std::sort(modifiers.begin(), modifiers.end(), [](const Assignment& a, const Assignment& b) { return a.id < b.id; });

    json revisions = {{"session", state().history_revision}, {"project", state().history_revision},
                      {"result", state().preview_result_id}, {"plates", plate_revisions_json()}};
    json routing = json::array();
    const std::array<std::pair<const char *, const char *>, 8> routing_keys = {{
        {"support-base", "support_filament"}, {"support-interface", "support_interface_filament"},
        {"outer-wall", "outer_wall_filament_id"}, {"inner-wall", "inner_wall_filament_id"},
        {"sparse-infill", "sparse_infill_filament_id"}, {"internal-solid-infill", "internal_solid_filament_id"},
        {"top-surface", "top_surface_filament_id"}, {"bottom-surface", "bottom_surface_filament_id"},
    }};
    auto option_value = [](const auto& config, const char* key) {
        if (const auto* option = dynamic_cast<const ConfigOptionInt*>(config.option(key))) return option->value;
        return 0;
    };
    auto routing_values = [&](const auto& config) {
        std::vector<int> values;
        values.reserve(routing_keys.size());
        for (const auto& [selector, key] : routing_keys) values.push_back(option_value(config, key));
        return values;
    };
    auto append_routing = [&](const char* target, std::size_t id, std::size_t object_id,
                              const auto& config, const std::vector<int>& parent_values,
                              int assignment_slot, const bool support_only, const bool feature_only) {
        const auto own_values = routing_values(config);
        for (std::size_t index = 0; index < routing_keys.size(); ++index) {
            const auto& [selector, key] = routing_keys[index];
            const bool feature = std::string(selector) != "support-base" && std::string(selector) != "support-interface";
            if ((support_only && feature) || (feature_only && !feature)) continue;
            const int own = own_values[index];
            const int parent = parent_values.empty() ? 0 : parent_values[index];
            const int effective = own > 0 ? own : (parent > 0 ? parent : (feature ? assignment_slot : 0));
            const bool inherited = own == 0 && !parent_values.empty();
            // `defaulted` describes an effective native zero, not the fact that
            // an object inherits.  An object inheriting an explicit project
            // support route is therefore inherited=true, defaulted=false.
            const bool defaulted = effective == 0;
            routing.push_back({{"target", target}, {"id", id}, {"object_id", object_id},
                               {"selector", selector}, {"explicit_slot", own},
                               {"effective_slot", effective}, {"inherited", inherited},
                               {"defaulted", defaulted}});
        }
    };
    append_routing("project", 0, 0, bundle.project_config, {}, 0, true, false);
    for (const ModelObject* object : state().model.objects) {
        if (object == nullptr) continue;
        const int object_slot = std::max(1, explicit_extruder(object->config));
        append_routing("object", object->id().id, object->id().id, object->config,
                       routing_values(bundle.project_config), object_slot, false, false);
        for (const ModelVolume* volume : object->volumes) {
            if (volume == nullptr || volume->type() != ModelVolumeType::MODEL_PART) continue;
            const int explicit_slot = explicit_extruder(volume->config);
            const int assignment_slot = std::max(1, explicit_slot == 0 ? object_slot : explicit_slot);
            append_routing("model-part", volume->id().id, object->id().id, volume->config,
                           routing_values(object->config), assignment_slot, false, true);
        }
    }
    return {{"ok", true}, {"version", 1}, {"slots", slots}, {"mappings", mappings},
            {"flushing", flushing}, {"capabilities", capabilities}, {"routing", routing},
            {"assignments", {{"objects", assignment_json(objects)}, {"parts", assignment_json(parts)},
                             {"modifiers", assignment_json(modifiers)}}},
            {"revisions", revisions}, {"status", {{"state", "ready"}, {"error", nullptr}}}};
}

// A plate-local process setting (currently the prime-tower X/Y position) must
// not invalidate the complete project.  Keep this transaction in the bridge,
// beside the shared variant, so the response carries the authoritative
// revision and affected plate set used by both hosts.
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

json project_config_overlay_metadata()
{
    return json{{"schema", kNeoConfigOverlaySchema}, {"version", 1},
                {"overlay", state().project_config_overlay}};
}

json project_config_overlay_result()
{
    return json{{"ok", true}, {"overlay", state().project_config_overlay}};
}

// The native ConfigOption parser is the authority for prime-tower input.  A
// successful mutation returns the value after that parser, allowing hosts to
// display native normalization/corrections without reimplementing a second
// settings parser.  Warnings/errors remain native command status values.
template <typename Config>
json native_configuration_status(const Config& config,
                                 const std::string& key,
                                 const std::string& requested)
{
    json corrections = json::array();
    const ConfigOption* option = config.option(key);
    if (option != nullptr) {
        const std::string effective = option->serialize();
        if (effective != requested)
            corrections.push_back({{"key", key}, {"requested", requested}, {"effective", effective}});
    }
    return json{{"state", "ready"}, {"corrections", std::move(corrections)},
                {"warnings", json::array()}, {"errors", json::array()}};
}

const char* native_configuration_error_json(const std::string& code,
                                            const std::string& message)
{
    return dup_json(json{{"ok", false}, {"error", message}, {"error_code", code},
                         {"status", {{"state", "error"}, {"error", message}}}}.dump());
}

void apply_plate_metadata_to_configs(std::vector<BridgeState::PlateSessionPlate>& plates)
{
    for (auto& plate : plates) {
        apply_overlay_to_config(plate.settings, plate.settings_metadata);
        plate.settings_metadata = config_metadata_json(plate.settings);
    }
}

void apply_plate_overlay_to_configs(std::vector<BridgeState::PlateSessionPlate>& plates,
                                    const json& overlay)
{
    if (!overlay.is_object() || !overlay.contains("plates") || !overlay["plates"].is_object()) return;
    for (std::size_t index = 0; index < plates.size(); ++index) {
        auto& plate = plates[index];
        const json* values = nullptr;
        if (const auto exact = overlay["plates"].find(plate.id); exact != overlay["plates"].end()) {
            values = &exact.value();
        } else {
            // Plate session ids are runtime identities and are intentionally
            // regenerated on restore.  Preserve the saved overlay by its
            // stable one-based plate suffix when the identity changed.
            const std::string suffix = "-plate-" + std::to_string(index + 1);
            for (auto it = overlay["plates"].begin(); it != overlay["plates"].end(); ++it) {
                if (it.key().size() >= suffix.size() &&
                    it.key().compare(it.key().size() - suffix.size(), suffix.size(), suffix) == 0) {
                    values = &it.value();
                    break;
                }
            }
        }
        if (values != nullptr) {
            apply_overlay_to_config(plate.settings, *values);
            plate.settings_metadata = config_metadata_json(plate.settings);
        }
    }
}

Neo::Bridge::FilamentCommands::Runtime filament_command_runtime()
{
    return {[] { return filament_session_snapshot_json(); }};
}

}  // namespace

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
    Neo::Bridge::FilamentCommands::validate_filament_candidate(
        bundle, model, plates, overlay, strict_slot_arrays, require_all_slot_arrays);
}

void apply_overlay_to_config(DynamicPrintConfig& config, const json& values)
{
    ::apply_overlay_to_config(config, values);
}

void apply_plate_metadata_to_configs(std::vector<BridgeState::PlateSessionPlate>& plates)
{
    ::apply_plate_metadata_to_configs(plates);
}

void apply_plate_overlay_to_configs(std::vector<BridgeState::PlateSessionPlate>& plates,
                                    const json& overlay)
{
    ::apply_plate_overlay_to_configs(plates, overlay);
}

json project_config_overlay_metadata()
{
    return ::project_config_overlay_metadata();
}

json project_config_overlay_result()
{
    return ::project_config_overlay_result();
}

} // namespace Slic3r::Neo::Bridge::ProjectPersistence

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_restore_filament_rack(const char* request_cstr)
{
    return restore_filament_rack_command(request_cstr, filament_command_runtime());
}

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

        const char* result = Neo::Bridge::Profiles::init_profiles();
        reset_plate_session_state();
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
        return error_json(e.what());
    } catch (...) {
        // Non-std throw: never let a C++ exception cross the extern "C" seam
        // (it would surface in JS as an uncatchable CppException crash).
        fprintf(stderr, "orc_init caught (...) via catch-all\n");
        return error_json("unknown C++ exception");
    }
}

// Headless plate-session commands. Every successful mutation returns one
// coherent snapshot and the complete set of world transforms changed by grid
// reflow. The frontend never derives membership, origins, or reflow deltas.
EMSCRIPTEN_KEEPALIVE const char* orc_get_plate_session_snapshot() {
    try {
        return dup_json(plate_session_snapshot_json().dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Harness-only fixture seam.  This is intentionally not declared by
// SlicerClient: it injects imported per-plate vectors/sequences and custom
// events so the native command boundary can prove rejection/remapping without
// manufacturing a desktop 3MF archive.  It does not create history entries.
EMSCRIPTEN_KEEPALIVE const char* orc_test_set_filament_reference_fixture(const char* request_cstr) {
    try {
        const json request = request_cstr && *request_cstr ? json::parse(request_cstr) : json::object();
        ensure_plate_session_state();
        if (request.contains("plate_settings")) {
            if (!request["plate_settings"].is_object()) return error_json("invalid test plate settings");
            for (auto& plate : state().plate_session_plates) {
                auto it = request["plate_settings"].find(plate.id);
                if (it == request["plate_settings"].end()) continue;
                if (!it.value().is_object()) return error_json("invalid test plate settings");
                apply_overlay_to_config(plate.settings, it.value());
                plate.settings_metadata = config_metadata_json(plate.settings);
            }
        }
        if (request.contains("custom_gcodes")) {
            if (!request["custom_gcodes"].is_array()) return error_json("invalid test custom gcodes");
            state().model.plates_custom_gcodes.clear();
            for (const auto& record : request["custom_gcodes"]) {
                if (!record.is_object() || !record.contains("plate") || !record["plate"].is_number_integer() ||
                    !record.contains("mode") || !record["mode"].is_string() ||
                    !record.contains("items") || !record["items"].is_array())
                    return error_json("invalid test custom gcode record");
                CustomGCode::Info info;
                const std::string mode = record["mode"].get<std::string>();
                info.mode = mode == "MultiExtruder" ? CustomGCode::MultiExtruder
                    : mode == "MultiAsSingle" ? CustomGCode::MultiAsSingle : CustomGCode::SingleExtruder;
                for (const auto& item : record["items"]) {
                    if (!item.is_object() || !item.contains("print_z") || !item["print_z"].is_number() ||
                        !item.contains("extruder") || !item["extruder"].is_number_integer())
                        return error_json("invalid test custom gcode item");
                    CustomGCode::Item event;
                    event.print_z = item["print_z"].get<double>();
                    event.type = CustomGCode::ToolChange;
                    event.extruder = item["extruder"].get<int>();
                    event.color = item.value("color", std::string{});
                    event.extra = item.value("extra", std::string{});
                    info.gcodes.push_back(std::move(event));
                }
                state().model.plates_custom_gcodes[record["plate"].get<int>()] = std::move(info);
            }
        }
        json custom = json::array();
        for (const auto& [plate, info] : state().model.plates_custom_gcodes) {
            for (const auto& item : info.gcodes)
                custom.push_back({{"plate", plate}, {"extruder", item.extruder}, {"print_z", item.print_z}});
        }
        return dup_json(json{{"ok", true}, {"plate_session", plate_session_snapshot_json()}, {"custom_gcodes", custom}}.dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown test fixture failure"); }
}

// Harness-only flush fixture.  It exercises the native per-nozzle minimum
// flush calculation with explicit cutter/retraction inputs; this seam is not
// part of SlicerClient and is intentionally absent from the public ABI types.
EMSCRIPTEN_KEEPALIVE const char* orc_test_set_filament_flush_fixture(const char* request_cstr) {
    try {
        const json request = request_cstr && *request_cstr ? json::parse(request_cstr) : json::object();
        if (!request.is_object()) return error_json("invalid test flush fixture");
        state().presets.update_multi_material_filament_presets();
        auto& printer = state().presets.printers.get_edited_preset().config;
        auto& project = state().presets.project_config;
        const auto filament_count = state().presets.filament_presets.size();
        auto* fixture_colours = project.option<ConfigOptionStrings>("filament_colour", true);
        fixture_colours->values.resize(filament_count, "#26A69A");
        for (std::size_t index = 0; index < filament_count; ++index)
            fixture_colours->values[index] = index % 2 == 0 ? "#FF0000" : "#00FF00";
        if (auto* multi = project.option<ConfigOptionStrings>("filament_multi_colour", true))
            multi->values = fixture_colours->values;
        for (const auto& name : state().presets.filament_presets) {
            if (auto* preset = state().presets.filaments.find_preset(name, true, true)) {
                auto* colours = preset->config.option<ConfigOptionStrings>("filament_colour", true);
                colours->values.resize(filament_count, "#26A69A");
                for (std::size_t index = 0; index < filament_count; ++index)
                    colours->values[index] = index % 2 == 0 ? "#FF0000" : "#00FF00";
                if (auto* multi = preset->config.option<ConfigOptionStrings>("filament_multi_colour", true))
                    multi->values = colours->values;
            }
        }
        const auto read_floats = [](const json& value, const char* name) {
            if (!value.is_array()) throw std::runtime_error(std::string("invalid test flush ") + name);
            std::vector<double> result;
            result.reserve(value.size());
            for (const auto& item : value) {
                if (item.is_null()) result.push_back(std::numeric_limits<double>::quiet_NaN());
                else if (item.is_number()) result.push_back(item.get<double>());
                else throw std::runtime_error(std::string("invalid test flush ") + name);
            }
            return result;
        };
        const auto read_bools = [](const json& value, const char* name) {
            if (!value.is_array() || !std::all_of(value.begin(), value.end(), [](const json& item) {
                    return item.is_boolean() || item.is_number_integer(); }))
                throw std::runtime_error(std::string("invalid test flush ") + name);
            std::vector<unsigned char> result;
            result.reserve(value.size());
            for (const auto& item : value) result.push_back(static_cast<unsigned char>(item.get<int>() != 0));
            return result;
        };
        DynamicPrintConfig synthetic_full = state().presets.full_config();
        if (request.contains("nozzle_volume"))
            synthetic_full.option<ConfigOptionFloatsNullable>("nozzle_volume", true)->values = read_floats(request["nozzle_volume"], "nozzle_volume");
        if (request.contains("enable_long_retraction_when_cut"))
            synthetic_full.option<ConfigOptionInt>("enable_long_retraction_when_cut", true)->value = request["enable_long_retraction_when_cut"].get<int>();
        if (request.contains("long_retractions_when_cut"))
            synthetic_full.option<ConfigOptionBools>("long_retractions_when_cut", true)->values = read_bools(request["long_retractions_when_cut"], "long_retractions_when_cut");
        if (request.contains("retraction_distances_when_cut"))
            synthetic_full.option<ConfigOptionFloats>("retraction_distances_when_cut", true)->values = read_floats(request["retraction_distances_when_cut"], "retraction_distances_when_cut");
        if (request.contains("filament_diameter"))
            synthetic_full.option<ConfigOptionFloats>("filament_diameter", true)->values = read_floats(request["filament_diameter"], "filament_diameter");
        if (request.contains("filament_long_retractions_when_cut"))
            synthetic_full.option<ConfigOptionBoolsNullable>("filament_long_retractions_when_cut", true)->values = read_bools(request["filament_long_retractions_when_cut"], "filament_long_retractions_when_cut");
        if (request.contains("filament_retraction_distances_when_cut"))
            synthetic_full.option<ConfigOptionFloatsNullable>("filament_retraction_distances_when_cut", true)->values = read_floats(request["filament_retraction_distances_when_cut"], "filament_retraction_distances_when_cut");
        const auto set_floats = [&](const char* key, const std::vector<double>& values) {
            printer.option<ConfigOptionFloats>(key, true)->values = values;
            project.option<ConfigOptionFloats>(key, true)->values = values;
        };
        const auto set_nullable_floats = [&](const char* key, const std::vector<double>& values) {
            printer.option<ConfigOptionFloatsNullable>(key, true)->values = values;
            project.option<ConfigOptionFloatsNullable>(key, true)->values = values;
        };
        const auto set_bools = [&](const char* key, const std::vector<unsigned char>& values) {
            printer.option<ConfigOptionBools>(key, true)->values = values;
            project.option<ConfigOptionBools>(key, true)->values = values;
        };
        const auto set_int = [&](const char* key, const int value) {
            printer.option<ConfigOptionInt>(key, true)->value = value;
            project.option<ConfigOptionInt>(key, true)->value = value;
        };
        const auto set_filament_floats = [&](const char* key, const std::vector<double>& values) {
            for (const auto& name : state().presets.filament_presets)
                if (auto* preset = state().presets.filaments.find_preset(name, true, true))
                    preset->config.option<ConfigOptionFloatsNullable>(key, true)->values = values;
        };
        const auto set_filament_bools = [&](const char* key, const std::vector<unsigned char>& values) {
            for (const auto& name : state().presets.filament_presets)
                if (auto* preset = state().presets.filaments.find_preset(name, true, true))
                    preset->config.option<ConfigOptionBoolsNullable>(key, true)->values = values;
        };
        if (request.contains("nozzle_volume"))
            set_nullable_floats("nozzle_volume", read_floats(request["nozzle_volume"], "nozzle_volume"));
        if (request.contains("enable_long_retraction_when_cut"))
            set_int("enable_long_retraction_when_cut", request["enable_long_retraction_when_cut"].get<int>());
        if (request.contains("long_retractions_when_cut"))
            set_bools("long_retractions_when_cut", read_bools(request["long_retractions_when_cut"], "long_retractions_when_cut"));
        if (request.contains("retraction_distances_when_cut"))
            set_floats("retraction_distances_when_cut", read_floats(request["retraction_distances_when_cut"], "retraction_distances_when_cut"));
        if (request.contains("nozzle_flush_dataset"))
            printer.option<ConfigOptionIntsNullable>("nozzle_flush_dataset", true)->values = request["nozzle_flush_dataset"].get<std::vector<int>>();
        if (request.contains("flush_multiplier"))
            set_floats("flush_multiplier", read_floats(request["flush_multiplier"], "flush_multiplier"));
        if (request.contains("filament_diameter"))
            set_floats("filament_diameter", read_floats(request["filament_diameter"], "filament_diameter"));
        if (request.contains("filament_long_retractions_when_cut"))
            set_filament_bools("filament_long_retractions_when_cut", read_bools(request["filament_long_retractions_when_cut"], "filament_long_retractions_when_cut"));
        if (request.contains("filament_retraction_distances_when_cut"))
            set_filament_floats("filament_retraction_distances_when_cut", read_floats(request["filament_retraction_distances_when_cut"], "filament_retraction_distances_when_cut"));
        recalculate_filament_flush(state().presets);
        // Test-only imported-project seam: install a complete native matrix
        // after the native calculation so the next read proves load-time
        // preservation.  The first real flushing mutation must replace it.
        if (request.contains("imported_matrix")) {
            const auto imported = read_floats(request["imported_matrix"], "imported_matrix");
            const std::size_t count = state().presets.filament_presets.size();
            const std::size_t planes = static_cast<std::size_t>(std::max(1, state().presets.get_printer_extruder_count()));
            if (imported.size() != count * count * planes)
                return error_json("invalid imported flush matrix size");
            state().presets.project_config.option<ConfigOptionFloats>("flush_volumes_matrix", true)->values = imported;
        }
        return dup_json(json{{"ok", true}, {"snapshot", filament_session_snapshot_json()},
            {"min_flush_volumes", min_flush_volumes_for_config(synthetic_full,
                state().presets.filament_presets.size(),
                std::max(1, state().presets.get_printer_extruder_count()))}}.dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown test flush fixture failure"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_filament_session_snapshot() {
    try {
        return dup_json(filament_session_snapshot_json().dump());
    } catch (const std::exception& e) {
        return dup_json(filament_session_error_json("native_exception", e.what()).dump());
    } catch (...) {
        return dup_json(filament_session_error_json("unknown_exception", "unknown C++ exception").dump());
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_select_filament_slot_preset(const char* request_json) {
    try { return dup_json(select_filament_slot_preset_command(
        request_json && *request_json ? json::parse(request_json) : json::object(), filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return dup_json(command_error("invalid_command", e.what()).dump()); }
    catch (...) { return dup_json(command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_filament_slot_colour(const char* request_json) {
    try { return dup_json(set_filament_slot_colour_command(
        request_json && *request_json ? json::parse(request_json) : json::object(), filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return dup_json(command_error("invalid_command", e.what()).dump()); }
    catch (...) { return dup_json(command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_add_filament_slot(const char* request_json) {
    try { return dup_json(add_filament_command(
        request_json && *request_json ? json::parse(request_json) : json::object(), filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return dup_json(command_error("invalid_command", e.what()).dump()); }
    catch (...) { return dup_json(command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_delete_filament_slot(const char* request_json) {
    try { return dup_json(delete_or_merge_filament_command(
        request_json && *request_json ? json::parse(request_json) : json::object(), false, filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return dup_json(command_error("invalid_command", e.what()).dump()); }
    catch (...) { return dup_json(command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_merge_filament_slots(const char* request_json) {
    try { return dup_json(delete_or_merge_filament_command(
        request_json && *request_json ? json::parse(request_json) : json::object(), true, filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return dup_json(command_error("invalid_command", e.what()).dump()); }
    catch (...) { return dup_json(command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_assign_filament(const char* request_json) {
    try { return dup_json(assign_filament_command(
        request_json && *request_json ? json::parse(request_json) : json::object(), filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return dup_json(command_error("invalid_command", e.what()).dump()); }
    catch (...) { return dup_json(command_error("invalid_command", "invalid filament assignment command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_filament_routing(const char* request_json) {
    try { return dup_json(set_filament_routing_command(
        request_json && *request_json ? json::parse(request_json) : json::object(), filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return dup_json(command_error("invalid_command", e.what()).dump()); }
    catch (...) { return dup_json(command_error("invalid_command", "invalid filament routing command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_project_config_overlay() {
    try {
        return dup_json(project_config_overlay_result().dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_project_config_override(const char* scope_cstr,
                                                                  const char* id_cstr,
                                                                  const char* option_key_cstr,
                                                                  const char* value_cstr) {
    try {
        ensure_plate_session_state();
        const std::string scope = scope_cstr ? scope_cstr : "";
        const std::string id = id_cstr ? id_cstr : "";
        const std::string key = option_key_cstr ? option_key_cstr : "";
        const std::string value = value_cstr ? value_cstr : "";
        const auto configuration_error = [](const std::string& code, const std::string& message) {
            return native_configuration_error_json(code, message);
        };
        if (scope != "project" && scope != "object" && scope != "part" && scope != "plate")
            return configuration_error("invalid_command", "invalid project configuration scope");
        if (key.empty()) return configuration_error("invalid_command", "option key is required");
        if (print_config_def.options.find(key) == print_config_def.options.end())
            return configuration_error("unsupported_reference", "unsupported project configuration option: " + key);
        if (scope != "project" && id.empty()) return configuration_error("invalid_command", "scope id is required");
        // The first-release prime-tower position is intentionally per plate;
        // exposing a plate override for any other option would make its
        // invalidation semantics ambiguous.  The shared enable/width values
        // stay project-scoped and use the existing shared mutation path.
        if (scope == "plate" && key != "wipe_tower_x" && key != "wipe_tower_y")
            return configuration_error("unsupported_reference", "only prime tower X/Y are supported at plate scope");
        ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
        DynamicPrintConfig project_candidate;
        std::optional<json> configuration_status;
        std::string effective_value;
        const auto effective_for = [&key](const auto& config) {
            const ConfigOption* option = config.option(key);
            if (option == nullptr) throw BadOptionValueException("native option is unavailable: " + key);
            return option->serialize();
        };
        if (scope == "project") {
            project_candidate = state().presets.project_config;
            apply_overlay_to_config(project_candidate, state().project_config_overlay["project"]);
            project_candidate.set_deserialize(key, value, substitutions);
            configuration_status = native_configuration_status(project_candidate, key, value);
            effective_value = effective_for(project_candidate);
        } else if (scope == "object") {
            auto* object = find_object_by_id(static_cast<std::size_t>(std::stoull(id)));
            if (!object) return configuration_error("unsupported_reference", "object not found");
            DynamicPrintConfig candidate = object->config.get();
            candidate.set_deserialize(key, value, substitutions);
            configuration_status = native_configuration_status(candidate, key, value);
            effective_value = effective_for(candidate);
            object->config.assign_config(candidate);
        } else if (scope == "part") {
            auto* volume = find_volume_by_id(static_cast<std::size_t>(std::stoull(id)));
            if (!volume) return configuration_error("unsupported_reference", "part not found");
            DynamicPrintConfig candidate = volume->config.get();
            candidate.set_deserialize(key, value, substitutions);
            configuration_status = native_configuration_status(candidate, key, value);
            effective_value = effective_for(candidate);
            volume->config.assign_config(candidate);
        } else if (scope == "plate") {
            auto* plate = const_cast<BridgeState::PlateSessionPlate*>(find_plate(id));
            if (!plate) return configuration_error("unsupported_reference", "plate not found");
            DynamicPrintConfig candidate = plate->settings;
            candidate.set_deserialize(key, value, substitutions);
            configuration_status = native_configuration_status(candidate, key, value);
            effective_value = effective_for(candidate);
            plate->settings = std::move(candidate);
            plate->settings_metadata = config_metadata_json(plate->settings);
        }
        json& bucket = scope == "project" ? state().project_config_overlay["project"]
            : scope == "object" ? state().project_config_overlay["objects"][id]
            : scope == "part" ? state().project_config_overlay["parts"][id]
            : state().project_config_overlay["plates"][id];
        bucket[key] = effective_value;
        const auto mutation = scope == "plate"
            ? plate_configuration_mutation_snapshot(id, "prime-tower-position")
            : shared_configuration_mutation_snapshot();
        json result = project_config_overlay_result();
        result["plate_session"] = mutation;
        if (configuration_status.has_value()) result["configuration_status"] = *configuration_status;
        return dup_json(result.dump());
    } catch (const BadOptionValueException& e) {
        return native_configuration_error_json("native_validation_failure", e.what());
    } catch (const std::exception& e) { return native_configuration_error_json("native_validation_failure", e.what()); }
    catch (...) { return native_configuration_error_json("native_validation_failure", "unknown C++ exception"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_revalidate_project_config_overlay() {
    try {
        // Revalidation is deliberately conservative: retain only keys known
        // by the current PrintConfig definition. Values are checked again at
        // slice time against the selected base preset and invalid values are
        // ignored without destroying the rest of the project overlay.
        for (const char* scope : {"project", "objects", "parts", "plates"}) {
            auto& values = state().project_config_overlay[scope];
            for (auto it = values.begin(); it != values.end();) {
                if (scope == std::string("project")) {
                    if (print_config_def.options.find(it.key()) == print_config_def.options.end()) it = values.erase(it);
                    else ++it;
                } else {
                    if (!it.value().is_object()) { it = values.erase(it); continue; }
                    for (auto option = it.value().begin(); option != it.value().end();) {
                        if (!option.value().is_string() || print_config_def.options.find(option.key()) == print_config_def.options.end()) option = it.value().erase(option);
                        else ++option;
                    }
                    ++it;
                }
            }
        }
        return dup_json(project_config_overlay_result().dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
}

// Progress transport is defined in bridge_slicing_pipeline.cpp. Its narrow
// interface is imported above for project operations that report stages.

}  // extern "C"
