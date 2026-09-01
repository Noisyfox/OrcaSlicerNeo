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
#include <emscripten/threading.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "libslic3r/AppConfig.hpp"
#include "libslic3r/Exception.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/PresetBundle.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/TriangleMesh.hpp"
#include "libslic3r/Utils.hpp"

#include "bridge_buffers.hpp"
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

namespace {

#ifdef ORCA_WASM_THREADING
// Match the pre-created Emscripten pool. This API returns the runtime's
// navigator.hardwareConcurrency value; keep a nonzero fallback for unusual
// hosts.
int wasm_tbb_concurrency()
{
    return std::max(1, emscripten_num_logical_cores());
}
#endif

// Module-global state. orc_init() (re)creates the preset bundle.
//
// Drift at the pinned SHA (build-system level): bridge.cpp.o is linked before
// the libslic3r archive, so module-scope globals here construct BEFORE
// PrintConfig.cpp's `print_config_def` global — and PresetBundle's constructor
// chain (PresetCollection -> FullPrintConfig::defaults() -> print_config_def)
// reads it. Native OrcaSlicer never keeps a module-scope PresetBundle. Keep
// the state in a lazily-constructed holder instead: it is created on the
// first orc_* call (after all TUs' statics, including print_config_def, have
// run) — observed as "memory access out of bounds" at instantiation when
// constructed eagerly.
struct BridgeState {
#ifdef ORCA_WASM_THREADING
    // Match the pre-created Emscripten pthread pool at runtime. This avoids a
    // fixed compile-time cap while ensuring oneTBB never asks for more worker
    // threads than the loader supplied.
    const int tbb_max_concurrency = wasm_tbb_concurrency();
    tbb::global_control tbb_concurrency{
        tbb::global_control::max_allowed_parallelism,
        static_cast<std::size_t>(tbb_max_concurrency)};
    tbb::task_arena tbb_arena{tbb_max_concurrency};
#endif
    AppConfig profile_config;
    PresetBundle presets;
    Model       model;
    Print       print;
};
BridgeState& state() { static BridgeState s; return s; }

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

std::string option_type_name(const ConfigOptionDef& def) {
    switch (def.type) {
        case coFloat:            return "float";
        case coInt:              return "int";
        case coString:           return "string";
        case coBool:             return "bool";
        case coPercent:          return "percent";
        case coFloats:           return "floats";
        case coInts:             return "ints";
        case coStrings:          return "strings";
        case coBools:            return "bools";
        case coEnum:             return "enum";
        case coFloatOrPercent:   return "float_or_percent";
        case coPercents:         return "percents";
        case coPoint:            return "point";
        case coPoints:           return "points";
        case coPoint3:           return "point3";
        // Drift at the pinned SHA: ConfigOptionType has no coVec3d (the enum
        // ends at coPointsGroups/coIntsGroups, Config.hpp:166-203), so the
        // planned coVec3d case is dropped; such types hit default: "unknown".
        default:                 return "unknown";
    }
}

json option_def_to_json(const ConfigOptionDef& def) {
    json j;
    j["type"] = option_type_name(def);
    if (!def.label.empty()) j["label"] = def.label;
    if (!def.full_label.empty()) j["full_label"] = def.full_label;
    if (!def.tooltip.empty()) j["tooltip"] = def.tooltip;
    if (!def.category.empty()) j["category"] = def.category;
    j["mode"] = int(def.mode);
    if (!def.enum_values.empty()) j["enum_values"] = def.enum_values;
    if (!def.enum_labels.empty()) j["enum_labels"] = def.enum_labels;
    if (def.min != 0.0 || def.max != 0.0) {
        j["min"] = def.min;
        j["max"] = def.max;
    }
    if (def.default_value) j["default"] = def.default_value->serialize();
    return j;
}

// Internal profile visibility bootstrap; preferences remain host-owned.
// The app config JSON (the fork's USE_JSON_CONFIG schema) is the single
// source of truth for installed printers + selections; the renderer owns
// it and persists it (see doc/2026-08-15-m4-preset-management-design.md).
// AppConfig::load() is file-based (loading_path()), so the bridge
// populates the live instance through the public setters instead —
// set_variant (models), set/set_section (presets/filaments). The loader's
// JSON keys: "models" (vendor/model/nozzle_diameter objects),
// "presets" (machine/process/filament + multi-material filament_*),
// "filaments" (array of installed filament names).

// Returns true when the JSON carried a "models" section (installed-state
// is authoritative); false means "fresh config" → install everything.
bool apply_app_config(const json& j) {
    AppConfig& cfg = state().profile_config;
    bool has_models = false;
    for (auto it = j.begin(); it != j.end(); ++it) {
        if (it.key() == "models" && it.value().is_array()) {
            has_models = true;
            for (const auto& j_model : it.value()) {
                if (!j_model.is_object()) continue;
                std::string vendor, model;
                if (j_model.contains("vendor") && j_model["vendor"].is_string())
                    vendor = j_model["vendor"].get<std::string>();
                if (j_model.contains("model") && j_model["model"].is_string())
                    model = j_model["model"].get<std::string>();
                std::vector<std::string> variants;
                if (vendor.empty() || model.empty() ||
                    !j_model.contains("nozzle_diameter"))
                    continue;
                // The fork's on-disk form is an escaped string
                // (escape_strings_cstyle, see serialize_app_config); accept
                // a plain array too (hand-written configs, probe fixtures).
                if (j_model["nozzle_diameter"].is_array()) {
                    for (const auto& v : j_model["nozzle_diameter"])
                        if (v.is_string())
                            variants.push_back(v.get<std::string>());
                } else if (j_model["nozzle_diameter"].is_string()) {
                    if (!unescape_strings_cstyle(
                            j_model["nozzle_diameter"].get<std::string>(), variants))
                        continue;
                } else {
                    continue;
                }
                if (variants.empty()) continue;
                for (const auto& v : variants)
                    cfg.set_variant(vendor, model, v, true);
            }
        } else if (it.key() == "presets" && it.value().is_object()) {
            for (auto pk = it.value().begin(); pk != it.value().end(); ++pk)
                if (pk.value().is_string())
                    cfg.set("presets", pk.key(), pk.value().get<std::string>());
        } else if (it.key() == "filaments" && it.value().is_array()) {
            std::map<std::string, std::string> installed;
            for (const auto& el : it.value())
                if (el.is_string()) installed[el.get<std::string>()] = "true";
            cfg.set_section("filaments", installed);
        }
    }
    return has_models;
}

// The shared application installs every shipped profile package before calling
// orc_init(). Preserve that delivery decision in the native visibility gate:
// the legacy AppConfig fields are an implementation detail here, not a second
// record of which profiles the user installed.
void install_all_filaments() {
    AppConfig& cfg = state().profile_config;
    for (const Preset& p : state().presets.filaments) {
        if (p.is_system)
            cfg.set(AppConfig::SECTION_FILAMENTS, p.name, "true");
    }
}

// Fresh-config default: install every printer and filament the bundle ships.
// The vendor/model/variant triple only exists in the preset configs, so this
// runs after load_presets (chicken-and-egg with set_visible_from_appconfig
// otherwise). Visibility is then recomputed through the native AppConfig
// path; compatibility, including OrcaFilamentLibrary generic supersession,
// remains wholly owned by PresetBundle.
void install_all_printers() {
    AppConfig& cfg = state().profile_config;
    for (const Preset& p : state().presets.printers) {  // begin()/end(): skips generated defaults
        if (p.vendor == nullptr) continue;
        const std::string model   = p.config.opt_string("printer_model");
        const std::string variant = p.config.opt_string("printer_variant");
        if (model.empty() || variant.empty()) continue;
        cfg.set_variant(p.vendor->id, model, variant, true);
    }
    install_all_filaments();
    // load_selections is the public entry that recomputes visibility and
    // compatibility from the now-complete package-derived installed state.
    // With no saved selection, reselect_after_app_config establishes the
    // baseline selection next.
    state().presets.load_selections(cfg);
}

// Re-apply the selection after installed-state changed: presets.machine
// wins; on a fresh config (no name yet) keep the round-5 baseline — first
// non-default preset — but now over an all-visible collection. The
// load_selections tail (update_compatible + multi-material) then fixes
// print/filament for the active machine.
void reselect_after_app_config() {
    const std::string initial = state().profile_config.get("presets", PRESET_PRINTER_NAME);
    bool selected = !initial.empty() &&
                    state().presets.printers.select_preset_by_name(initial, true);
    if (!selected) {
        size_t sel_idx = 0;
        for (auto it = state().presets.printers.lbegin();
             it != state().presets.printers.end(); ++it, ++sel_idx) {
            if (it->is_default) continue;
            state().presets.printers.select_preset(sel_idx);
            break;
        }
    }
    state().presets.update_compatible(PresetSelectCompatibleType::Always);
    state().presets.update_multi_material_filament_presets();
}

// Rebuild the app config JSON the renderer persists — same schema and code
// paths as AppConfig::save() (models from the public vendors() map,
// filaments as an array, presets key/values).
json serialize_app_config() {
    const AppConfig& cfg = state().profile_config;
    json j = json::object();
    if (cfg.has_section("presets"))
        for (const auto& kvp : cfg.get_section("presets"))
            j["presets"][kvp.first] = kvp.second;
    if (cfg.has_section("filaments")) {
        json arr = json::array();
        for (const auto& kvp : cfg.get_section("filaments"))
            arr.push_back(kvp.first);
        j["filaments"] = std::move(arr);
    }
    for (const auto& vendor : cfg.vendors()) {
        for (const auto& model : vendor.second) {
            if (model.second.empty()) continue;
            const std::vector<std::string> variants(model.second.begin(), model.second.end());
            j["models"].push_back(json{
                {"vendor", vendor.first},
                {"model", model.first},
                {"nozzle_diameter", escape_strings_cstyle(variants)},
            });
        }
    }
    return j;
}

// Build the one coherent preset view consumed by the picker UI.  The
// compatibility state belongs to PresetBundle: the bridge deliberately does
// not interpret compatible_printers / compatible_prints itself because that
// would duplicate the upstream condition, inheritance, library-exclusion and
// parent-preset rules.
json preset_entry_json(const Preset& preset, const PresetCollection& collection) {
    json entry{{"name", preset.name},
               {"is_visible", preset.is_visible},
               {"is_default", preset.is_default},
               {"selected", preset.name == collection.get_selected_preset_name()}};
    entry["vendor_id"] = preset.vendor ? preset.vendor->id : "";
    entry["model"]     = preset.config.opt_string("printer_model");
    entry["variant"]   = preset.config.opt_string("printer_variant");
    return entry;
}

json preset_candidates_json(const PresetCollection& collection, bool require_compatible) {
    json candidates = json::array();
    // begin()/end() intentionally omit generated "- default -" presets.
    // Keep the collection order: it is the engine's candidate ordering and
    // must not be re-sorted by an application-layer policy.
    for (auto it = collection.begin(); it != collection.end(); ++it) {
        if (!it->is_visible || (require_compatible && !it->is_compatible))
            continue;
        candidates.push_back(preset_entry_json(*it, collection));
    }
    return candidates;
}

json preset_selection_json(const PresetCollection& collection) {
    return json{{"name", collection.get_selected_preset_name()},
                {"idx", collection.get_selected_idx()}};
}

// This is emitted only after the caller has completed any native compatibility
// recalculation and fallback. It is intentionally the only picker-state read:
// callers must not compose a UI state from separate collection reads.
json preset_snapshot_json() {
    return json{{"ok", true},
                {"printers", preset_candidates_json(state().presets.printers, false)},
                {"prints", preset_candidates_json(state().presets.prints, true)},
                {"filaments", preset_candidates_json(state().presets.filaments, true)},
                {"printer", preset_selection_json(state().presets.printers)},
                {"print", preset_selection_json(state().presets.prints)},
                {"filament", preset_selection_json(state().presets.filaments)}};
}

// Shared initialization body. The incoming JSON is ignored legacy input.
// the renderer's whole config — REPLACE the previous state, never merge:
// a stale presets.machine from an earlier init could point at a printer that
// is invisible under the new models section, and install_all_printers'
// accumulated models would defeat a later partial install. (M4 probe:
// section 4 crashed on this — the second init inherited section 3's
// selection + the fresh-default's full vendor map.)
void reset_app_config() {
    AppConfig& cfg = state().profile_config;
    cfg.set_vendors({});            // installed-state (m_vendors)
    cfg.clear_section("presets");   // selections
    cfg.clear_section("filaments"); // installed filaments
}
const char* init_with_app_config(const json& j) {
    reset_app_config();
    const bool has_models = apply_app_config(j);
    set_data_dir("/");
    // resources_dir() is never set by the bridge; pointing it at "/" makes
    // the bundled /info/nozzle_info.json mountable and stops
    // get_hrc_by_nozzle_type's benign parse-error path (M3 carry-forward).
    set_resources_dir("/");
    state().presets.setup_directories();
    state().presets.load_presets(state().profile_config, ForwardCompatibilitySubstitutionRule::Enable);
    if (!has_models) {
        install_all_printers();
        reselect_after_app_config();
    }
    return dup_json(json{{"ok", true},
                         {"prints",    state().presets.prints.size()},
                         {"filaments", state().presets.filaments.size()},
                         {"printers",  state().presets.printers.size()}}.dump());
}

// ObjectID crosses the boundary as a JSON number. Wasm64 sizes are 64-bit, so
// the client passes a JS Number (double); validate it is a positive integer
// before narrowing to size_t. A valid ObjectID is strictly positive (ObjectID.hpp).
static std::optional<std::size_t> to_object_id(const double v) {
    if (!std::isfinite(v) || v < 1.0 || std::floor(v) != v)
        return std::nullopt;
    return static_cast<std::size_t>(v);
}

// Parse a JSON array of positive integral ObjectIDs. Deduplicates preserving
// input order (clone preserves the requested order; delete ignores order).
// Returns nullopt for any malformed entry or an empty array.
static std::optional<std::vector<std::size_t>> parse_positive_id_array(const json& j) {
    if (!j.is_array() || j.empty()) return std::nullopt;
    std::vector<std::size_t> out;
    out.reserve(j.size());
    for (const auto& item : j) {
        if (!item.is_number()) return std::nullopt;
        const double v = item.get<double>();
        if (!std::isfinite(v) || v < 1.0 || std::floor(v) != v) return std::nullopt;
        const std::size_t id = static_cast<std::size_t>(v);
        if (std::find(out.begin(), out.end(), id) == out.end())
            out.push_back(id);
    }
    return out;
}

// Stable-ID resolution against the live Model. IDs are globally unique across
// objects/volumes/instances (ObjectBase::generate_new_id), so each helper scans
// the whole model rather than assuming a particular ObjectID space ordering.
static ModelObject* find_object_by_id(const std::size_t id) {
    auto& model = state().model;
    for (auto& obj : model.objects)
        if (obj->id().id == id) return obj;
    return nullptr;
}

static ModelVolume* find_volume_by_id(const std::size_t id) {
    auto& model = state().model;
    for (auto& obj : model.objects)
        for (auto& vol : obj->volumes)
            if (vol->id().id == id) return vol;
    return nullptr;
}

static ModelInstance* find_instance_by_id(const std::size_t id) {
    auto& model = state().model;
    for (auto& obj : model.objects)
        for (auto& inst : obj->instances)
            if (inst->id().id == id) return inst;
    return nullptr;
}

// Volume types cross the boundary with the spec's stable snake_case strings
// (spec/ObjectList-and-Parts.md §9.1). ModelVolume::type_to_string uses the
// upstream BBS names ("normal_part"/"negative_part"/"modifier_part"), which
// differ from the bridge contract, so map explicitly here.
static const char* volume_type_string(const ModelVolumeType t) {
    switch (t) {
        case ModelVolumeType::MODEL_PART:         return "model_part";
        case ModelVolumeType::NEGATIVE_VOLUME:    return "negative_volume";
        case ModelVolumeType::PARAMETER_MODIFIER: return "parameter_modifier";
        case ModelVolumeType::SUPPORT_BLOCKER:    return "support_blocker";
        case ModelVolumeType::SUPPORT_ENFORCER:   return "support_enforcer";
        default:                                  return "model_part";
    }
}

// Reverse of volume_type_string: spec snake_case string -> ModelVolumeType.
// Returns nullopt for an unknown string so orc_set_volume_type can reject it.
static std::optional<ModelVolumeType> volume_type_from_string(const std::string& s) {
    if (s == "model_part")         return ModelVolumeType::MODEL_PART;
    if (s == "negative_volume")    return ModelVolumeType::NEGATIVE_VOLUME;
    if (s == "parameter_modifier") return ModelVolumeType::PARAMETER_MODIFIER;
    if (s == "support_blocker")    return ModelVolumeType::SUPPORT_BLOCKER;
    if (s == "support_enforcer")   return ModelVolumeType::SUPPORT_ENFORCER;
    return std::nullopt;
}

// Serialize the complete object/part/instance tree. Shared by
// orc_get_model_structure (read-only) and the reorder operations, which return
// the current structure after moving entities. Returns the "objects" array so
// callers wrap it with their own ok/error envelope.
static json model_structure_json() {
    auto& model = state().model;
    json objects = json::array();
    for (size_t oi = 0; oi < model.objects.size(); ++oi) {
        const auto& obj = model.objects[oi];
        json volumes = json::array();
        for (size_t vi = 0; vi < obj->volumes.size(); ++vi) {
            const auto& vol = obj->volumes[vi];
            volumes.push_back(json{
                {"id",            vol->id().id},
                {"index",         vi},
                {"name",          vol->name},
                {"type",          volume_type_string(vol->type())},
                {"isSplittable",  vol->is_splittable()},
            });
        }
        json instances = json::array();
        for (size_t ii = 0; ii < obj->instances.size(); ++ii) {
            const auto& inst = obj->instances[ii];
            instances.push_back(json{
                {"id",        inst->id().id},
                {"index",     ii},
                {"printable", inst->printable},
            });
        }
        objects.push_back(json{
            {"id",            obj->id().id},
            {"index",         oi},
            {"name",          obj->name},
            {"printable",     obj->printable},
            {"instanceCount", obj->instances.size()},
            {"volumes",       std::move(volumes)},
            {"instances",     std::move(instances)},
        });
    }
    return objects;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_init(const char* options_json) {
    try {
        // The JSON is the options payload; only "log_level" is consumed today
        // (the rest is the legacy preferences slot, still ignored — the
        // renderer owns preferences and passes them through MEMFS profiles).
        // The client forwards globalThis.ORCA_LOG_LEVEL here so the boost::log
        // severity filter is controllable from JS (doc/2026-08-21-wasm-boost-log.md).
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

        const char* result = init_with_app_config(json::object());
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

// Read one atomic, picker-ready compatibility state. It contains only
// candidates the current strict-hide UI may render: visible printers, then
// visible-and-compatible FFF print and filament presets. Callers must replace
// all three lists and selections from this single response.
EMSCRIPTEN_KEEPALIVE const char* orc_get_preset_snapshot() {
    try {
        return dup_json(preset_snapshot_json().dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// The selection guard deliberately lives here as well as in the UI: stale UI
// state or another caller must not construct an invalid compatibility tuple.
EMSCRIPTEN_KEEPALIVE const char* orc_select_preset(const char* kind_cstr, const char* name_cstr) {
    try {
        const std::string kind = kind_cstr ? kind_cstr : "";
        const std::string name = name_cstr ? name_cstr : "";
        if (name.empty()) return error_json("preset name required");
        PresetCollection* coll = nullptr;
        if (kind == "print")        coll = &state().presets.prints;
        else if (kind == "filament")coll = &state().presets.filaments;
        else if (kind == "printer") coll = &state().presets.printers;
        else return error_json("kind must be print|filament|printer");
        Preset* requested = coll->find_preset(name);
        if (requested == nullptr)
            return error_json("preset not found: " + name);
        if (!requested->is_visible)
            return error_json("preset is not visible: " + name);
        // A printer has no compatibility context.  Print and filament names
        // must already be candidates for the current engine-resolved printer
        // (and, for filament, current process) before they may be selected.
        if (kind != "printer" && !requested->is_compatible)
            return error_json("preset is incompatible: " + name);
        if (!coll->select_preset_by_name(name, true))
            return error_json("could not select preset: " + name);
        if (kind == "printer") {
            // OrcaSlicer's normal compatibility/fallback path.  Process is
            // resolved first, then filament against that final process.
            state().presets.update_compatible(PresetSelectCompatibleType::Always);
            state().presets.update_multi_material_filament_presets();
        } else if (kind == "print") {
            // The request was just validated as a compatible print preset, so
            // retain it while re-evaluating dependent filament compatibility.
            // The second argument selects OrcaSlicer's native filament
            // fallback when the newly active print makes it incompatible.
            state().presets.update_compatible(PresetSelectCompatibleType::Never,
                                               PresetSelectCompatibleType::Always);
            state().presets.update_multi_material_filament_presets();
        }
        return dup_json(preset_snapshot_json().dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_option_metadata() {
    try {
        // Drift at the pinned SHA: PrintConfigDef::defs() does not exist; the
        // shared definition instance is the global const PrintConfigDef
        // (PrintConfig.hpp:719), whose ConfigDef::options (Config.hpp:2589)
        // is the option map.
        const auto& defs = print_config_def.options;
        json out = json::object();
        for (const auto& [key, def] : defs)
            out[key] = option_def_to_json(def);
        return dup_json(out.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

// Model bytes arrive in the WASM heap (JS: _malloc + HEAPU8 + _free).
// Stage them to a MEMFS file so the format loaders can open a real path.
EMSCRIPTEN_KEEPALIVE const char* orc_add_model(const char* data, int len, const char* ext, const char* filename) {
    try {
        if (!data || len <= 0) return error_json("no model bytes");
        const std::string path = "/tmp/" + sanitized_model_basename(filename, ext);
        std::FILE* f = std::fopen(path.c_str(), "wb");
        if (!f) return error_json("cannot open /tmp for model upload");
        std::fwrite(data, 1, size_t(len), f);
        std::fclose(f);

        DynamicPrintConfig dummy;
        Model imported = Model::read_from_file(path, &dummy, nullptr,
                                               LoadStrategy::AddDefaultInstances);
        // The wxWidgets GUI is not compiled into the WASM build, so replicate
        // the Plater's post-load steps for non-project files (Plater.cpp
        // _load_files: per object center_around_origin(false) + ensure_on_bed
        // before the objects enter the plate): center each object's mesh
        // around the origin and rest it on the bed (min Z = 0). Without this
        // a model keeps its raw STL coordinates and its bbox center lands
        // wherever the file's own origin is — off the viewport origin. Like
        // the GUI, project files (3MF/AMF) keep their stored positions and
        // are NOT re-centered. center_around_origin shifts the volumes;
        // ensure_on_bed carries the Z drop in the instance offset
        // (auto_drop), which orc_get_model_mesh reports and the renderer
        // applies as the group position.
        {
            std::string lower_ext = ext ? ext : "";
            std::transform(lower_ext.begin(), lower_ext.end(), lower_ext.begin(),
                           [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            const bool is_project_file = lower_ext == "3mf" || lower_ext == "amf";
            if (!is_project_file) {
                for (ModelObject* o : imported.objects) {
                    o->center_around_origin(false);
                    o->ensure_on_bed(false);
                }
            }
        }
        // Preserve the current scene: only after parsing and preparing the
        // complete incoming file succeeds do we copy its objects into the
        // live Model. Model::add_object clones the object and rebinds it to
        // the destination model, so the temporary can be destroyed safely.
        for (const ModelObject* o : imported.objects)
            state().model.add_object(*o);
        // A model mutation makes any existing Print/G-code result stale.
        state().print.clear();
        // Drift at the pinned SHA: Model has no instance accessor — instances
        // live per-object (ModelObject::instances, Model.hpp:385; Model itself
        // only has the objects list, Model.hpp:1553-1560). Sum per object.
        size_t instance_count = 0;
        for (const ModelObject* o : state().model.objects)
            instance_count += o->instances.size();
        return dup_json(json{{"ok", true},
                             {"objects",   state().model.objects.size()},
                             {"instances", instance_count}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

// OrcaSlicer primitives are created in the engine and added to the model
// directly (ObjectList::load_shape_object → create_mesh → load_mesh_object),
// never through a file: no staging, no basename-derived names, no extension.
// Mirror that here: the mesh is built with the same libslic3r builders and
// the same step angles as Orca's create_mesh (GUI_ObjectList.cpp), and the
// object and its single part are named after the primitive label — the six
// shapes the scene menu's "Add Primitive" submenu offers. The GUI canvas
// helpers (nearest-empty-cell placement, cooling orientation, snapshot) are
// not compiled into the WASM build, so the shape lands at the current scene
// origin, resting on the bed — the same result the staged STL import used
// to produce.
EMSCRIPTEN_KEEPALIVE const char* orc_add_shape(const char* type, const char* name) {
    try {
        const std::string type_str = type ? type : "";
        const std::string object_name = (name && *name) ? name : type_str;
        // App-sized primitive: OrcaSlicer sizes shapes at 10% of the max bed
        // size (get_size_proportional_to_max_bed_size); keep the app's
        // established 20 mm so primitives render like the well-tested cube
        // path. Orca's create_mesh proportions from `side` are preserved.
        const double side = 20.0;
        TriangleMesh mesh;
        if (type_str == "Cube")
            mesh = TriangleMesh(its_make_cube(side, side, side));
        else if (type_str == "Cylinder")
            mesh = TriangleMesh(its_make_cylinder(0.5 * side, side));
        else if (type_str == "Sphere")
            mesh = TriangleMesh(its_make_sphere(0.5 * side, PI / 90));
        else if (type_str == "Cone")
            mesh = TriangleMesh(its_make_cone(0.5 * side, side));
        else if (type_str == "Disc")
            mesh = TriangleMesh(its_make_cylinder(0.5 * side, 0.2f));
        else if (type_str == "Torus")
            mesh = TriangleMesh(its_make_torus(0.5 * side, 0.125 * side, PI / 60));
        else
            return error_json("unsupported primitive type: " + type_str);
        const BoundingBoxf3 bb = mesh.bounding_box();

        ModelObject* new_object = state().model.add_object();
        new_object->name = object_name;
        new_object->add_instance(); // each object should have at least one instance
        ModelVolume* new_volume = new_object->add_volume(mesh);
        new_object->sort_volumes(true);
        new_volume->name = object_name;
        // The primitive has no per-object settings: default the extruder so
        // slicing assigns it without a provider (load_mesh_object does this
        // for the same reason).
        new_object->config.set_key_value("extruder", new ConfigOptionInt(1));
        new_object->invalidate_bounding_box();
        // load_mesh_object centers the freshly built 0..side mesh (its
        // add_volume already centered the volume mesh and re-offset the
        // volume; the object translate cancels that offset), then rests the
        // object on the bed. The empty-cell step is a canvas helper
        // (get_nearest_empty_cell at the build-volume center) — the shared
        // renderer's scene origin plays the same role here.
        new_object->translate(-bb.center());
        new_object->instances[0]->set_offset(Slic3r::Vec3d(0.0, 0.0, -new_object->origin_translation.z()));
        new_object->ensure_on_bed();
        // A model mutation makes any existing Print/G-code result stale.
        state().print.clear();
        size_t instance_count = 0;
        for (const ModelObject* o : state().model.objects)
            instance_count += o->instances.size();
        return dup_json(json{{"ok", true},
                             {"objects",   state().model.objects.size()},
                             {"instances", instance_count}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

// Explicit scene reset for the renderer's Clear Scene action. Resetting the
// model rather than merely hiding meshes guarantees that the next slice and
// export operate on an empty plate.
EMSCRIPTEN_KEEPALIVE const char* orc_clear_model() {
    try {
        state().print.clear();
        state().model = Model{};
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Delete whole objects by their stable ObjectIDs (spec §9.2). The renderer
// selection and object list use IDs, not positional indices — a structural
// mutation elsewhere cannot silently shift the target. All IDs are validated
// before any mutation so a bad request leaves the scene intact.
EMSCRIPTEN_KEEPALIVE const char* orc_delete_objects(const char* object_ids_json) {
    try {
        const json j = json::parse(object_ids_json ? object_ids_json : "");
        const auto ids = parse_positive_id_array(j);
        if (!ids) return error_json("no object ids");
        // Validate every ID resolves, so a malformed request does not partially delete.
        for (const std::size_t id : *ids)
            if (find_object_by_id(id) == nullptr)
                return error_json("object not found");
        for (const std::size_t id : *ids)
            state().model.delete_object(ObjectID(id));
        state().print.clear();
        return dup_json(json{{"ok", true},
                             {"objects", state().model.objects.size()},
                             {"deleted", ids->size()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

// Delete specific parts (volumes) by their stable ObjectIDs. Enforces the
// upstream last-solid-part guard: a volume that is the only MODEL_PART of its
// object cannot be deleted. All IDs are resolved and guarded before any
// mutation, so a bad request leaves the scene intact.
EMSCRIPTEN_KEEPALIVE const char* orc_delete_volumes(const char* volume_ids_json) {
    try {
        const json j = json::parse(volume_ids_json ? volume_ids_json : "");
        const auto ids = parse_positive_id_array(j);
        if (!ids) return error_json("no volume ids");
        std::vector<std::pair<ModelObject*, ModelVolume*>> targets;
        for (const std::size_t id : *ids) {
            ModelVolume* vol = find_volume_by_id(id);
            if (vol == nullptr) return error_json("volume not found");
            if (vol->is_the_only_one_part())
                return error_json("deleting the last solid part is not allowed");
            targets.emplace_back(vol->get_object(), vol);
        }
        // delete_volume(idx) shifts the object's own volume indices, so group
        // by object and remove in descending index order within each object.
        std::map<ModelObject*, std::vector<std::size_t>> by_object;
        for (const auto& [obj, vol] : targets) {
            for (std::size_t vi = 0; vi < obj->volumes.size(); ++vi)
                if (obj->volumes[vi] == vol) { by_object[obj].push_back(vi); break; }
        }
        for (auto& [obj, indexes] : by_object) {
            std::sort(indexes.rbegin(), indexes.rend());
            for (const std::size_t idx : indexes)
                obj->delete_volume(idx);
        }
        state().print.clear();
        return dup_json(json{{"ok", true},
                             {"objects", state().model.objects.size()},
                             {"deleted", ids->size()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Clone whole objects by stable ObjectIDs. libslic3r's add_object(const
// ModelObject&) performs ModelObject::new_clone, assigning fresh recursive IDs
// to the clone. The new stable IDs are returned so the renderer can restore
// selection to the cloned objects (spec §9.2).
EMSCRIPTEN_KEEPALIVE const char* orc_clone_objects(const char* object_ids_json) {
    try {
        const json j = json::parse(object_ids_json ? object_ids_json : "");
        const auto ids = parse_positive_id_array(j);
        if (!ids) return error_json("no object ids");
        std::vector<std::size_t> new_object_ids;
        for (const std::size_t id : *ids) {
            ModelObject* obj = find_object_by_id(id);
            if (obj == nullptr) return error_json("object not found");
            ModelObject* clone = state().model.add_object(*obj);
            new_object_ids.push_back(clone->id().id);
        }
        state().print.clear();
        return dup_json(json{{"ok", true},
                             {"newObjectIds", new_object_ids},
                             {"objects", state().model.objects.size()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Reorder the plate/list by a stable ObjectID and a DESTINATION INDEX. The
// object with `from_obj_id` is moved so it sits at `to_index` (0-based) in the
// final list; `to_index == object_count` (or anything >= count) appends it at
// the end. Returns the current structure for a single refresh round-trip.
EMSCRIPTEN_KEEPALIVE const char* orc_reorder_objects(double from_obj_id, double to_index) {
    try {
        const auto from_id = to_object_id(from_obj_id);
        if (!from_id) return error_json("object id must be a positive integer");
        if (to_index < 0) return error_json("target index must be >= 0");
        auto& objs = state().model.objects;
        const std::size_t count = objs.size();
        std::size_t from_idx = count;
        for (std::size_t i = 0; i < count; ++i)
            if (objs[i]->id().id == *from_id) { from_idx = i; break; }
        if (from_idx == count) return error_json("object not found");
        const std::size_t dest = static_cast<std::size_t>(to_index);
        // Destination final index; to_index == count (or beyond) appends last.
        const std::size_t target = dest >= count ? count - 1 : dest;
        if (from_idx != target) {
            ModelObject* from_obj = objs[from_idx];
            objs.erase(objs.begin() + static_cast<std::ptrdiff_t>(from_idx));
            objs.insert(objs.begin() + static_cast<std::ptrdiff_t>(target), from_obj);
        }
        state().print.clear();
        return dup_json(json{{"ok", true}, {"objects", model_structure_json()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Reorder parts within an object by a stable volume ID and a DESTINATION INDEX.
// `to_index == volume_count` (or beyond) appends the part at the end; otherwise
// it is moved so it sits at `to_index` in the final list.
EMSCRIPTEN_KEEPALIVE const char* orc_reorder_volumes(double object_id, double from_volume_id, double to_index) {
    try {
        const auto obj_id = to_object_id(object_id);
        const auto from_id = to_object_id(from_volume_id);
        if (!obj_id || !from_id) return error_json("id must be a positive integer");
        if (to_index < 0) return error_json("target index must be >= 0");
        ModelObject* obj = find_object_by_id(*obj_id);
        if (obj == nullptr) return error_json("object not found");
        auto& vols = obj->volumes;
        const std::size_t count = vols.size();
        std::size_t from_idx = count;
        for (std::size_t i = 0; i < count; ++i)
            if (vols[i]->id().id == *from_id) { from_idx = i; break; }
        if (from_idx == count) return error_json("volume not found");
        const std::size_t dest = static_cast<std::size_t>(to_index);
        const std::size_t target = dest >= count ? count - 1 : dest;
        if (from_idx != target) {
            ModelVolume* from_vol = vols[from_idx];
            vols.erase(vols.begin() + static_cast<std::ptrdiff_t>(from_idx));
            vols.insert(vols.begin() + static_cast<std::ptrdiff_t>(target), from_vol);
        }
        obj->invalidate_bounding_box();
        state().print.clear();
        return dup_json(json{{"ok", true}, {"objects", model_structure_json()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Split a volume into its disconnected parts (upstream ModelVolume::split).
// libslic3r assigns a NEW unique ID to the original volume and creates new
// volume(s) for the remaining shells, so the caller's volumeId is now stale.
// Return the freshly generated volume IDs plus the current structure so the
// renderer can clear stale selection and re-read (spec §8 mutation flow).
EMSCRIPTEN_KEEPALIVE const char* orc_split_volume_to_parts(double volume_id, double max_extruders, double remap_paint) {
    try {
        const auto id = to_object_id(volume_id);
        if (!id) return error_json("volume id must be a positive integer");
        ModelVolume* vol = find_volume_by_id(*id);
        if (vol == nullptr) return error_json("volume not found");
        if (!vol->is_splittable()) return error_json("volume is not splittable");

        ModelObject* obj = vol->get_object();
        // Capture the object's current volume IDs so the generated part IDs can
        // be computed after the split (the original is re-IDed, so it is "new").
        std::vector<std::size_t> before_ids;
        for (const ModelVolume* v : obj->volumes)
            before_ids.push_back(v->id().id);

        const unsigned int max_ext = max_extruders > 0.0
            ? static_cast<unsigned int>(max_extruders) : 1u;
        const std::size_t parts = vol->split(max_ext, remap_paint != 0.0);

        std::vector<std::size_t> new_volume_ids;
        for (const ModelVolume* v : obj->volumes)
            if (std::find(before_ids.begin(), before_ids.end(), v->id().id) == before_ids.end())
                new_volume_ids.push_back(v->id().id);

        state().print.clear();
        return dup_json(json{{"ok", true},
                             {"parts", parts},
                             {"newVolumeIds", new_volume_ids},
                             {"objects", model_structure_json()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Split an object into one object per disconnected shell (upstream
// ObjectList::split_to_objects). ModelObject::split adds the new objects to the
// live model and fills new_objects; the bridge then removes the source object.
// Returns the freshly generated object IDs plus the current structure so the
// renderer can restore selection to the new objects. autoDrop is accepted for
// signature parity (the spec exposes it) but the auto_drop bed-drop has no
// first-version UI and is left to the host callers.
EMSCRIPTEN_KEEPALIVE const char* orc_split_object_to_objects(double object_id, double auto_drop) {
    try {
        const auto id = to_object_id(object_id);
        if (!id) return error_json("object id must be a positive integer");
        ModelObject* obj = find_object_by_id(*id);
        if (obj == nullptr) return error_json("object not found");
        const bool splittable = obj->volumes.size() > 1
            || (obj->volumes.size() == 1 && obj->volumes[0]->is_splittable());
        if (!splittable) return error_json("object is not splittable");

        ModelObjectPtrs new_objects;
        obj->split(&new_objects, /*remap_paint=*/false);
        // Remove the source; the split objects now own the geometry.
        state().model.delete_object(ObjectID(*id));

        std::vector<std::size_t> new_object_ids;
        for (const ModelObject* o : new_objects)
            new_object_ids.push_back(o->id().id);

        if (auto_drop != 0.0)
            state().model.adjust_min_z();

        state().print.clear();
        return dup_json(json{{"ok", true},
                             {"newObjectIds", new_object_ids},
                             {"objects", state().model.objects.size()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Assemble objects into a single multipart object (upstream ObjectList::merge
// "Assemble"). Each source object's volumes are copied into a new object, with
// the source's first-instance transform composed into each volume transform; the
// new object carries one instance. Returns the new object's stable ID.
EMSCRIPTEN_KEEPALIVE const char* orc_merge_objects_to_multipart(const char* object_ids_json, const char* name_cstr) {
    try {
        const json j = json::parse(object_ids_json ? object_ids_json : "");
        const auto ids = parse_positive_id_array(j);
        if (!ids) return error_json("no object ids");
        std::vector<ModelObject*> sources;
        for (const std::size_t id : *ids) {
            ModelObject* obj = find_object_by_id(id);
            if (obj == nullptr) return error_json("object not found");
            sources.push_back(obj);
        }

        auto& model = state().model;
        ModelObject* new_obj = model.add_object();
        new_obj->name = (name_cstr && *name_cstr) ? name_cstr : "Assembly";

        bool first_instance = true;
        for (ModelObject* src : sources) {
            if (first_instance) {
                // A single instance whose (identity) transform is combined into
                // each volume's matrix below.
                new_obj->add_instance();
                first_instance = false;
            }
            const Transform3d src_matrix =
                src->instances.empty() ? Transform3d::Identity()
                                       : src->instances[0]->get_transformation().get_matrix();
            for (const ModelVolume* vol : src->volumes) {
                ModelVolume* new_vol = new_obj->add_volume(*vol);
                new_vol->set_transformation(src_matrix * new_vol->get_matrix());
            }
        }
        if (first_instance) {
            // No source volume/instance path executed (all sources had no volumes);
            // give the assembly a single default instance so it is renderable.
            new_obj->add_instance();
        }
        new_obj->sort_volumes(true);

        // Remove the source objects from the live model.
        std::sort(sources.begin(), sources.end());
        sources.erase(std::unique(sources.begin(), sources.end()), sources.end());
        for (ModelObject* src : sources)
            model.delete_object(src);

        state().print.clear();
        return dup_json(json{{"ok", true},
                             {"objectId", new_obj->id().id},
                             {"objects", model.objects.size()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Separate selected instances into individual objects (upstream
// ObjectList::instances_to_separated_objects for the selected instances). Each
// selected instance becomes a new object carrying a copy of the source volumes
// and a single copied instance (preserving the instance transform). The selected
// instances are then removed from the source object.
EMSCRIPTEN_KEEPALIVE const char* orc_instances_to_separate_objects(double object_id, const char* instance_ids_json) {
    try {
        const auto id = to_object_id(object_id);
        if (!id) return error_json("object id must be a positive integer");
        ModelObject* obj = find_object_by_id(*id);
        if (obj == nullptr) return error_json("object not found");
        const auto ids = parse_positive_id_array(json::parse(instance_ids_json ? instance_ids_json : ""));
        if (!ids || ids->empty()) return error_json("no instance ids");

        // Validate every instance ID resolves before mutating.
        std::vector<std::size_t> to_remove;
        to_remove.reserve(ids->size());
        for (const std::size_t iid : *ids) {
            bool found = false;
            for (std::size_t i = 0; i < obj->instances.size(); ++i)
                if (obj->instances[i]->id().id == iid) { to_remove.push_back(i); found = true; break; }
            if (!found) return error_json("instance not found");
        }

        std::vector<std::size_t> new_object_ids;
        for (const std::size_t iid : *ids) {
            ModelInstance* src_inst = nullptr;
            for (ModelInstance* inst : obj->instances)
                if (inst->id().id == iid) { src_inst = inst; break; }
            ModelObject* clone = state().model.add_object();
            clone->name = obj->name;
            for (const ModelVolume* vol : obj->volumes)
                clone->add_volume(*vol);
            clone->add_instance(*src_inst);
            new_object_ids.push_back(clone->id().id);
        }

        // Remove the selected instances from the source (descending index).
        std::sort(to_remove.rbegin(), to_remove.rend());
        for (const std::size_t i : to_remove)
            obj->delete_instance(i);

        state().print.clear();
        return dup_json(json{{"ok", true},
                             {"newObjectIds", new_object_ids},
                             {"objects", state().model.objects.size()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Add a new instance to an object. libslic3r's add_instance() (no args) stacks
// it at the object origin (identity), overlapping instance 0 — which reads as
// "nothing happened". Place it visibly to the right of the existing instances
// (object width + a gap, along X) so the copy is immediately visible and can be
// moved. Returns the new stable instance ID.
EMSCRIPTEN_KEEPALIVE const char* orc_add_instance(double object_id) {
    try {
        const auto id = to_object_id(object_id);
        if (!id) return error_json("object id must be a positive integer");
        ModelObject* obj = find_object_by_id(*id);
        if (obj == nullptr) return error_json("object not found");
        const BoundingBoxf3& bbox = obj->bounding_box_exact();
        const double width = static_cast<double>(bbox.size().x());
        const double step = width > 0.0 ? width + 30.0 : 30.0;
        const Slic3r::Vec3d base = obj->instances.empty()
            ? Slic3r::Vec3d(0, 0, 0)
            : obj->instances.back()->get_offset();
        ModelInstance* inst = obj->add_instance();
        inst->set_offset(Slic3r::Vec3d(base.x() + step, base.y(), base.z()));
        state().print.clear();
        return dup_json(json{{"ok", true},
                             {"objectId", obj->id().id},
                             {"instanceId", inst->id().id}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Remove a specific instance from an object by stable ID. The last remaining
// instance cannot be removed (an object must keep at least one instance).
EMSCRIPTEN_KEEPALIVE const char* orc_remove_instance(double object_id, double instance_id) {
    try {
        const auto id = to_object_id(object_id);
        const auto iid = to_object_id(instance_id);
        if (!id || !iid) return error_json("id must be a positive integer");
        ModelObject* obj = find_object_by_id(*id);
        if (obj == nullptr) return error_json("object not found");
        if (obj->instances.size() <= 1) return error_json("cannot remove the last instance");
        for (std::size_t i = 0; i < obj->instances.size(); ++i) {
            if (obj->instances[i]->id().id == *iid) {
                obj->delete_instance(i);
                state().print.clear();
                return dup_json(json{{"ok", true}}.dump());
            }
        }
        return error_json("instance not found");
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

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

void begin_progress()
{
    std::lock_guard<std::mutex> lock(g_progress_mailbox_mutex);
    g_progress_open = true;
    publish_progress_locked(0, "Preparing slice");
}

void publish_slicer_progress(int percent, std::string_view text)
{
    std::lock_guard<std::mutex> lock(g_progress_mailbox_mutex);
    if (g_progress_open)
        publish_progress_locked(percent, text);
}

void finish_progress()
{
    std::lock_guard<std::mutex> lock(g_progress_mailbox_mutex);
    // Close before the terminal write. A status callback that reaches us
    // later must acquire this same mutex and therefore cannot overwrite 100%.
    g_progress_open = false;
    publish_progress_locked(100, "Slice complete");
}

void stop_progress()
{
    std::lock_guard<std::mutex> lock(g_progress_mailbox_mutex);
    g_progress_open = false;
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

EMSCRIPTEN_KEEPALIVE const char* orc_slice(const char* config_json) {
    try {
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
        state().print.is_BBL_printer() = state().presets.is_bbl_vendor();
        state().print.apply(state().model, config);
        // Drift at the pinned SHA: validate() returns StringObjectException
        // (PrintBase.hpp:30); use its .string member (same adaptation as
        // slice_main.cpp:55).
        const StringObjectException validation_error = state().print.validate();
        if (!validation_error.string.empty()) return error_json(validation_error.string);

        // Drift at the pinned SHA: SlicingStatus is nested as
        // PrintBase::SlicingStatus (PrintBase.hpp:440), not a Slic3r-top-level
        // type — qualify it (status_callback_type is PrintBase's typedef too).
        state().print.set_status_callback([&](const PrintBase::SlicingStatus& st) {
            publish_slicer_progress(st.percent, st.text);
#ifndef ORCA_WASM_THREADING
            if (g_progress) g_progress(st.percent, st.text.c_str());
#endif
        });
#ifdef ORCA_WASM_THREADING
        // Keep every libslic3r parallel_for inside the same fixed-size arena.
        // This mirrors the known-good oneTBB probe and prevents oneTBB from
        // trying to use more workers than Emscripten pre-created.
        state().tbb_arena.execute([&] { state().print.process(); });
#else
        state().print.process();
#endif
        state().print.set_status_default();
        finish_progress();
        // Fix round 2: additive success field — always present, empty when the
        // config is clean. M2 clients (config UI) rely on this to warn about
        // keys the pinned libslic3r dropped (handle_legacy's catch-all).
        json dropped = json::array();
        for (const std::string& k : substitutions.unrecogized_keys)
            dropped.push_back(k);
        return dup_json(json{{"ok", true}, {"unrecognized_keys", std::move(dropped)}}.dump());
    } catch (const std::exception& e) {
        stop_progress();
        // process() is where libslic3r throws SlicingErrors (GCode.cpp:2250);
        // the helper surfaces the per-object messages instead of the bare
        // category. This is the only bridge call that can throw it, so the
        // other catches keep plain e.what().
        return error_json_from_exception(e);
    } catch (...) {
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

// ---- model triangle meshes + GUI transform synchronization ----

static json transform_json(const Slic3r::Geometry::Transformation& t) {
    const auto offset = t.get_offset();
    const auto rotation = t.get_rotation();
    const auto scale = t.get_scaling_factor();
    const auto mirror = t.get_mirror();
    const Slic3r::Matrix4d m = t.get_matrix().matrix();
    json j = {{"offset", {offset.x(), offset.y(), offset.z()}},
            {"rotation", {rotation.x(), rotation.y(), rotation.z()}},
            {"scale", {scale.x(), scale.y(), scale.z()}},
            {"mirror", {mirror.x(), mirror.y(), mirror.z()}}};
    // Emit the full affine matrix (column-major, three.js layout) so a
    // sheared transform survives a JS-side load/reload round-trip. The TRS
    // fields remain for clean transforms and the gizmo/panel display.
    j["matrix"] = {m(0,0), m(1,0), m(2,0), m(3,0),
                   m(0,1), m(1,1), m(2,1), m(3,1),
                   m(0,2), m(1,2), m(2,2), m(3,2),
                   m(0,3), m(1,3), m(2,3), m(3,3)};
    return j;
}

static Slic3r::Vec3d transform_vec3(const json& transform, const char* key) {
    const auto& v = transform.at(key);
    if (!v.is_array() || v.size() != 3)
        throw std::runtime_error(std::string("transform.") + key + " must be a 3-vector");
    return Slic3r::Vec3d(v[0].get<double>(), v[1].get<double>(), v[2].get<double>());
}

static void set_transform(Slic3r::Geometry::Transformation& target, const json& transform) {
    // A full matrix is authoritative — it can carry shear that T·R·S cannot.
    // set_matrix stores the matrix verbatim; get_rotation/get_scaling_factor
    // below decompose it for display, and the slicer consumes get_matrix().
    if (transform.contains("matrix") && transform["matrix"].is_array()) {
        const auto& a = transform["matrix"];
        if (a.size() != 16)
            throw std::runtime_error("transform.matrix must be 16 numbers");
        Slic3r::Matrix4d m;
        for (int col = 0; col < 4; ++col)
            for (int row = 0; row < 4; ++row)
                m(row, col) = a[col * 4 + row].get<double>();
        target.set_matrix(Slic3r::Transform3d(m));
        return;
    }
    target.set_offset(transform_vec3(transform, "offset"));
    target.set_rotation(transform_vec3(transform, "rotation"));
    target.set_scaling_factor(transform_vec3(transform, "scale"));
    target.set_mirror(transform_vec3(transform, "mirror"));
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_instance_offset(int object_idx, int instance_idx, double x, double y, double z) {
    try {
        auto& model = state().model;
        if (object_idx < 0 || object_idx >= static_cast<int>(model.objects.size()))
            return error_json("object index out of range");
        auto& obj = model.objects[static_cast<size_t>(object_idx)];
        if (instance_idx < 0 || instance_idx >= static_cast<int>(obj->instances.size()))
            return error_json("instance index out of range");
        // Drift surface: ModelInstance::set_offset(Vec3d) — confirm at SHA.
        obj->instances[static_cast<size_t>(instance_idx)]->set_offset(Slic3r::Vec3d(x, y, z));
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_model_transform(
    int object_idx, int volume_idx, int instance_idx,
    const char* instance_transform_json, const char* volume_transform_json) {
    try {
        auto& model = state().model;
        if (object_idx < 0 || object_idx >= static_cast<int>(model.objects.size()))
            return error_json("object index out of range");
        auto& object = model.objects[static_cast<size_t>(object_idx)];
        if (volume_idx < 0 || volume_idx >= static_cast<int>(object->volumes.size()))
            return error_json("volume index out of range");
        if (instance_idx < 0 || instance_idx >= static_cast<int>(object->instances.size()))
            return error_json("instance index out of range");
        auto instance_transform = json::parse(instance_transform_json ? instance_transform_json : "");
        auto volume_transform = json::parse(volume_transform_json ? volume_transform_json : "");
        auto instance = object->instances[static_cast<size_t>(instance_idx)]->get_transformation();
        auto volume = object->volumes[static_cast<size_t>(volume_idx)]->get_transformation();
        set_transform(instance, instance_transform);
        set_transform(volume, volume_transform);
        object->instances[static_cast<size_t>(instance_idx)]->set_transformation(instance);
        object->volumes[static_cast<size_t>(volume_idx)]->set_transformation(volume);
        object->invalidate_bounding_box();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Read-only model structure: objects, their parts (volumes), and instances.
// Returns stable ObjectIDs (for React keys and selection restoration) plus
// current positional indices (for operation dispatch and display). Read-only,
// so it does not invalidate the current Print.
EMSCRIPTEN_KEEPALIVE const char* orc_get_model_structure() {
    try {
        return dup_json(json{{"ok", true}, {"objects", model_structure_json()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// -------------------------------------------------------------------------
// Step 2: non-destructive model metadata operations (stable ObjectID input).
// Every successful mutation invalidates the current Print/G-code result so
// the renderer cannot continue to display a stale slice. Resolving by stable
// IDs (rather than positional indices) means a structural mutation elsewhere
// cannot silently target the wrong entity — see spec/ObjectList-and-Parts.md §7.
// -------------------------------------------------------------------------

EMSCRIPTEN_KEEPALIVE const char* orc_rename_object(double object_id, const char* name_cstr) {
    try {
        const auto id = to_object_id(object_id);
        if (!id) return error_json("object id must be a positive integer");
        if (name_cstr == nullptr) return error_json("name is required");
        ModelObject* obj = find_object_by_id(*id);
        if (obj == nullptr) return error_json("object not found");
        obj->name = name_cstr;
        // A rename does not change geometry, but it does change the object's
        // reported name; the existing Print/G-code is still considered stale.
        state().print.clear();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_rename_volume(double volume_id, const char* name_cstr) {
    try {
        const auto id = to_object_id(volume_id);
        if (!id) return error_json("volume id must be a positive integer");
        if (name_cstr == nullptr) return error_json("name is required");
        ModelVolume* vol = find_volume_by_id(*id);
        if (vol == nullptr) return error_json("volume not found");
        vol->name = name_cstr;
        state().print.clear();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_volume_type(double volume_id, const char* type_cstr) {
    try {
        const auto id = to_object_id(volume_id);
        if (!id) return error_json("volume id must be a positive integer");
        if (type_cstr == nullptr) return error_json("type is required");
        const auto new_type = volume_type_from_string(type_cstr);
        if (!new_type) return error_json("invalid volume type");
        ModelVolume* vol = find_volume_by_id(*id);
        if (vol == nullptr) return error_json("volume not found");
        // Upstream last-solid-part guard (GUI_ObjectList): refuse to turn the
        // only MODEL_PART into a non-print volume.
        if (*new_type != ModelVolumeType::MODEL_PART && vol->is_the_only_one_part())
            return error_json("changing the last solid part is not allowed");
        vol->set_type(*new_type);
        // The type changes which volumes compose the print mesh; drop the cached
        // object bounds so a later getModelMesh / slice recomputes them.
        vol->get_object()->invalidate_bounding_box();
        state().print.clear();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_object_printable(double object_id, double printable) {
    try {
        const auto id = to_object_id(object_id);
        if (!id) return error_json("object id must be a positive integer");
        ModelObject* obj = find_object_by_id(*id);
        if (obj == nullptr) return error_json("object not found");
        // Object row toggles are an aggregate: set the object-level gate AND
        // every instance so the per-instance rows and ModelInstance::is_printable()
        // stay consistent (model_object->printable is an extra gate that would
        // otherwise disagree with the per-instance flags).
        const bool value = printable != 0.0;
        obj->printable = value;
        for (auto& inst : obj->instances)
            inst->printable = value;
        state().print.clear();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_instance_printable(double instance_id, double printable) {
    try {
        const auto id = to_object_id(instance_id);
        if (!id) return error_json("instance id must be a positive integer");
        ModelInstance* inst = find_instance_by_id(*id);
        if (inst == nullptr) return error_json("instance not found");
        inst->printable = printable != 0.0;
        state().print.clear();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_model_mesh() {
    try {
        auto& model = state().model;
        json arr = json::array();
        for (size_t oi = 0; oi < model.objects.size(); ++oi) {
            const auto& obj = model.objects[oi];
            // LOCAL (volume-transformed, instance-untouched) vertices: the
            // instance offset is reported separately below and the renderer
            // applies it as the group position. Baking instance transforms
            // here (ModelObject::mesh()) double-offsets the model after any
            // committed move + reload — a zero offset hid it at load time
            // (see the mock-module contract comment).
            for (size_t vi = 0; vi < obj->volumes.size(); ++vi) {
                const auto& its = obj->volumes[vi]->mesh().its;
                for (size_t ii = 0; ii < obj->instances.size(); ++ii) {
                    MallocBuffer vbuf;
                    MallocBuffer ibuf;
                    for (const auto& v : its.vertices) {
                        vbuf.appendF32(v.x()); vbuf.appendF32(v.y()); vbuf.appendF32(v.z());
                    }
                    for (const auto& tri : its.indices) {
                        ibuf.appendU32(static_cast<std::uint32_t>(tri[0]));
                        ibuf.appendU32(static_cast<std::uint32_t>(tri[1]));
                        ibuf.appendU32(static_cast<std::uint32_t>(tri[2]));
                    }
                    const std::uintptr_t vptr = reinterpret_cast<std::uintptr_t>(vbuf.data);
                    const std::uintptr_t iptr = reinterpret_cast<std::uintptr_t>(ibuf.data);
                    vbuf.release(); ibuf.release();
                    const auto& instance = obj->instances[ii]->get_transformation();
                    const auto& volume = obj->volumes[vi]->get_transformation();
                    arr.push_back(json{{"object_idx", oi}, {"volume_idx", vi}, {"instance_idx", ii},
                        {"vertex_ptr", vptr}, {"vertex_count", its.vertices.size()},
                        {"index_ptr", iptr}, {"index_count", its.indices.size() * 3},
                        {"offset", {instance.get_offset().x(), instance.get_offset().y(), instance.get_offset().z()}},
                        {"instance_transform", transform_json(instance)},
                        {"volume_transform", transform_json(volume)}});
                }
            }
        }
        return dup_json(json{{"ok", true}, {"objects", std::move(arr)}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

// Binary toolpath + stats. Contract mirrors the Task 1 mock; JS reads the
// heap buffers and _free()s the pointers.
EMSCRIPTEN_KEEPALIVE const char* orc_get_slice_result() {
    try {
        auto& print = state().print;
        if (print.objects().empty())
            return dup_json(json{{"ok", true}, {"objects", 0}, {"layers", 0},
                                 {"toolpath", json{{"vertex_ptr", 0}, {"vertex_count", 0},
                                                   {"layer_ptr", 0}, {"layer_count", 0},
                                                   {"feature_ptr", 0}, {"feature_count", 0},
                                                   {"features", json::array()}}}}.dump());

        // The toolpath comes from post-processing the exported gcode
        // (GCodeProcessor::process_file — the GUI's own mechanism). Export
        // happens here so getSliceResult is self-contained; the client's
        // exportGcode() later reads the same /out.gcode via FS. Drift
        // surface: process_file/get_result signatures (Step 1).
        print.export_gcode("/out.gcode", nullptr, nullptr);

        Slic3r::GCodeProcessorResult gcode_result;
        {
            Slic3r::GCodeProcessor processor;
            processor.process_file("/out.gcode");
            gcode_result = processor.get_result();
        }
        auto tp = bridge::build_toolpath(gcode_result);
        // Layer count = max layer id present in the toolpath + 1. The gcode
        // spans the whole plate, so this covers every object's height — the
        // previous objects().front() cap hid taller objects' extra layers.
        const size_t layers = tp.layerCount;

        // Feature palette (local id → name/color). build_toolpath assigns
        // ids 0..N-1 in order of first use; the features buffer holds those
        // ids, so this list lines up 1:1.
        json features = json::array();
        for (const auto& [role, info] : tp.palette_used) {
            (void)role;
            features.push_back({{"id", static_cast<int>(features.size())},
                                {"name", info.name},
                                {"color", {info.color[0], info.color[1], info.color[2]}}});
        }

        // wasm64: heap pointers as uintptr_t (see orc_get_model_mesh).
        const std::uintptr_t tvptr = reinterpret_cast<std::uintptr_t>(tp.positions.data);
        const std::uintptr_t tlptr = reinterpret_cast<std::uintptr_t>(tp.layers.data);
        const std::uintptr_t tfptr = reinterpret_cast<std::uintptr_t>(tp.features.data);
        const size_t n_verts = tp.positions.size / 12;
        tp.positions.release(); tp.layers.release(); tp.features.release();

        json out{{"ok", true}, {"objects", print.objects().size()}, {"layers", layers}};
        out["toolpath"] = {
            {"vertex_ptr", tvptr}, {"vertex_count", n_verts},
            {"layer_ptr", tlptr}, {"layer_count", n_verts},
            {"feature_ptr", tfptr}, {"feature_count", n_verts},
            {"features", std::move(features)},
        };
        return dup_json(out.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_export_gcode() {
    try {
        const std::string path = "/out.gcode";
        state().print.export_gcode(path, nullptr, nullptr);
        return dup_json(json{{"ok", true}, {"path", path}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_cancel() {
    try {
        state().print.cancel();
        // Fix round 1: the bridge is strictly synchronous — JS cannot reenter
        // wasm while orc_slice is running, so a cancel can never interrupt an
        // in-flight slice. A surviving CANCELED_BY_USER flag (only restart()
        // clears it, PrintBase.hpp) makes the NEXT orc_slice's process()
        // throw CanceledException, which on Emscripten's -fexceptions runtime
        // surfaces as an uncatchable CppException that kills the module
        // (observed deterministically; the throw is caught and rethrown by
        // libslic3r internals, and the rethrow carries poisoned EH state).
        // So for v1, cancel is a state reset: it must never poison the module.
        state().print.restart();
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

}  // extern "C"
