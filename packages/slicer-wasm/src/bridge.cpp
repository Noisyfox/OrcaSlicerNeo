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
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <utility>

#include "libslic3r/AppConfig.hpp"
#include "libslic3r/Exception.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/PresetBundle.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/Utils.hpp"

#include "bridge_buffers.hpp"
// Drift at the pinned SHA: GCodeProcessor.hpp lives under GCode/; the brief's
// PrintObject.hpp does not exist (class PrintObject is in Print.hpp, already
// included above).
#include "libslic3r/GCode/GCodeProcessor.hpp"

#ifdef ORCA_WASM_THREADING
#include <tbb/global_control.h>
#include <tbb/task_arena.h>
#endif

#include "nlohmann/json.hpp"

using namespace Slic3r;
using nlohmann::json;

namespace {

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
    // Match the pre-created Emscripten pthread pool. Letting oneTBB request
    // additional workers would reintroduce nested-worker startup stalls.
    tbb::global_control tbb_concurrency{
        tbb::global_control::max_allowed_parallelism,
        ORCA_WASM_TBB_MAX_CONCURRENCY};
    tbb::task_arena tbb_arena{ORCA_WASM_TBB_MAX_CONCURRENCY};
#endif
    AppConfig   app_config;
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

// --- M4: AppConfig fidelity -------------------------------------------
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
    AppConfig& cfg = state().app_config;
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

// Fresh-config default: install every printer the bundle ships. The
// vendor/model/variant triple only exists in the preset configs, so this
// runs after load_presets (chicken-and-egg with set_visible_from_appconfig
// otherwise). Visibility is then recomputed via load_installed_printers —
// the real mechanism (Preset.cpp:855), not a scan hack.
void install_all_printers() {
    AppConfig& cfg = state().app_config;
    for (const Preset& p : state().presets.printers) {  // begin()/end(): skips generated defaults
        if (p.vendor == nullptr) continue;
        const std::string model   = p.config.opt_string("printer_model");
        const std::string variant = p.config.opt_string("printer_variant");
        if (model.empty() || variant.empty()) continue;
        cfg.set_variant(p.vendor->id, model, variant, true);
    }
    // load_selections is the public entry that also runs the (private)
    // load_installed_filaments — the real mechanism that records each
    // visible printer's default filaments into the config's "filaments"
    // section. It must run AFTER the variants above are set: during
    // load_presets (earlier in init) no variant exists yet, so nothing is
    // visible and no filament gets recorded — a fresh install would then
    // persist an empty "filaments" section. (M4 probe section 3 regression
    // after the REPLACE-semantics reset fix; pre-clear it was populated by
    // a stale vendors map leaking across inits, which the reset removed.)
    // With an empty fresh config the selection steps inside are no-ops;
    // reselect_after_app_config establishes the baseline selection next.
    state().presets.load_selections(cfg);
}

// Re-apply the selection after installed-state changed: presets.machine
// wins; on a fresh config (no name yet) keep the round-5 baseline — first
// non-default preset — but now over an all-visible collection. The
// load_selections tail (update_compatible + multi-material) then fixes
// print/filament for the active machine.
void reselect_after_app_config() {
    const std::string initial = state().app_config.get("presets", PRESET_PRINTER_NAME);
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
    const AppConfig& cfg = state().app_config;
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

// Shared init body for orc_init / orc_set_app_config. The incoming JSON is
// the renderer's whole config — REPLACE the previous state, never merge:
// a stale presets.machine from an earlier init could point at a printer that
// is invisible under the new models section, and install_all_printers'
// accumulated models would defeat a later partial install. (M4 probe:
// section 4 crashed on this — the second init inherited section 3's
// selection + the fresh-default's full vendor map.)
void reset_app_config() {
    AppConfig& cfg = state().app_config;
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
    state().presets.load_presets(state().app_config, ForwardCompatibilitySubstitutionRule::Enable);
    if (!has_models) {
        install_all_printers();
        reselect_after_app_config();
    }
    return dup_json(json{{"ok", true},
                         {"prints",    state().presets.prints.size()},
                         {"filaments", state().presets.filaments.size()},
                         {"printers",  state().presets.printers.size()}}.dump());
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_init(const char* app_config_json) {
    try {
        // M4: the app config (install-state + selections) comes from the
        // renderer as JSON; see init_with_app_config. No argument = fresh
        // config = install everything + round-5 baseline selection (the
        // pre-M4 behavior, now via the real visibility mechanism).
        json j = json::object();
        if (app_config_json && *app_config_json) {
            try {
                j = json::parse(app_config_json);
            } catch (const json::parse_error&) {
                return error_json("invalid app config JSON");
            }
        }
        return init_with_app_config(j);
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

// Re-init with a new app config (the future install/uninstall path: the
// renderer edits the "models" section and re-inits). Same body as orc_init.
EMSCRIPTEN_KEEPALIVE const char* orc_set_app_config(const char* app_config_json) {
    try {
        if (!app_config_json || !*app_config_json)
            return error_json("app config JSON required");
        json j;
        try {
            j = json::parse(app_config_json);
        } catch (const json::parse_error&) {
            return error_json("invalid app config JSON");
        }
        return init_with_app_config(j);
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw: never let a C++ exception cross the extern "C" seam
        // (it would surface in JS as an uncatchable CppException crash).
        return error_json("unknown C++ exception");
    }
}

// The live app config in the persisted JSON schema (models/presets/
// filaments) — the renderer's persistence contract.
EMSCRIPTEN_KEEPALIVE const char* orc_get_app_config() {
    try {
        json j = serialize_app_config();
        j["ok"] = true;
        return dup_json(j.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw: never let a C++ exception cross the extern "C" seam
        // (it would surface in JS as an uncatchable CppException crash).
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_presets(const char* kind_cstr) {
    try {
        const std::string kind = kind_cstr ? kind_cstr : "";
        const PresetCollection* coll = nullptr;
        if (kind == "print")            coll = &state().presets.prints;
        else if (kind == "filament")    coll = &state().presets.filaments;
        else if (kind == "printer")     coll = &state().presets.printers;
        else return error_json("kind must be print|filament|printer");
        json arr = json::array();
        // Drift at the pinned SHA: PresetCollection::m_presets is private
        // (Preset.hpp:848+); iterate the public begin()/end() range instead,
        // which skips the generated "- default -" presets (Preset.hpp:510-515).
        // M4: entries carry the installed/selection data the picker needs —
        // is_visible is the REAL set_visible_from_appconfig result (driven
        // by the app config's models section), never computed client-side.
        for (auto it = coll->begin(); it != coll->end(); ++it) {
            json entry{{"name", it->name},
                       {"is_visible", it->is_visible},
                       {"is_default", it->is_default},
                       // The picker's value source: the collection's current
                       // selection (get_selected_preset_name — Preset.hpp:640).
                       {"selected", it->name == coll->get_selected_preset_name()}};
            entry["vendor_id"] = it->vendor ? it->vendor->id : "";
            entry["model"]     = it->config.opt_string("printer_model");
            entry["variant"]   = it->config.opt_string("printer_variant");
            arr.push_back(std::move(entry));
        }
        return dup_json(json{{"presets", arr}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

// The real selection path (replaces the app-side use of the diagnostic
// orc_select_printer): select by name, re-run load_selections' tail so
// print/filament follow the new machine, write the selection back into
// the app config (keeps the config authoritative), and report all three
// selections so the renderer can sync.
EMSCRIPTEN_KEEPALIVE const char* orc_select_preset(const char* kind_cstr, const char* name_cstr) {
    try {
        const std::string kind = kind_cstr ? kind_cstr : "";
        const std::string name = name_cstr ? name_cstr : "";
        if (name.empty()) return error_json("preset name required");
        PresetCollection* coll = nullptr;
        const char* config_key = nullptr;
        if (kind == "print")        { coll = &state().presets.prints;      config_key = PRESET_PRINT_NAME; }
        else if (kind == "filament"){ coll = &state().presets.filaments;   config_key = PRESET_FILAMENT_NAME; }
        else if (kind == "printer") { coll = &state().presets.printers;    config_key = PRESET_PRINTER_NAME; }
        else return error_json("kind must be print|filament|printer");
        if (coll->find_preset(name) == nullptr)
            return error_json("preset not found: " + name);
        if (!coll->select_preset_by_name(name, true))
            return error_json("could not select preset: " + name);
        if (kind == "printer") {
            // The load_selections tail: keep print/filament compatible with
            // the active machine without a full bundle reload.
            state().presets.update_compatible(PresetSelectCompatibleType::Always);
            state().presets.update_multi_material_filament_presets();
        }
        state().app_config.set("presets", PRESET_PRINTER_NAME,  state().presets.printers.get_selected_preset_name());
        state().app_config.set("presets", PRESET_PRINT_NAME,    state().presets.prints.get_selected_preset_name());
        state().app_config.set("presets", PRESET_FILAMENT_NAME, state().presets.filaments.get_selected_preset_name());
        auto sel = [](const PresetCollection& c) {
            return json{{"name", c.get_selected_preset_name()},
                        {"idx",  c.get_selected_idx()}};
        };
        return dup_json(json{{"ok", true},
                             {"printer", sel(state().presets.printers)},
                             {"print",   sel(state().presets.prints)},
                             {"filament", sel(state().presets.filaments)}}.dump());
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
EMSCRIPTEN_KEEPALIVE const char* orc_add_model(const char* data, int len, const char* ext) {
    try {
        if (!data || len <= 0) return error_json("no model bytes");
        const std::string path =
            "/tmp/uploaded_model." + std::string(ext && *ext ? ext : "stl");
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

using progress_fn = void (*)(int, const char*);
progress_fn g_progress = nullptr;

EMSCRIPTEN_KEEPALIVE void orc_set_progress_callback(progress_fn cb) { g_progress = cb; }

EMSCRIPTEN_KEEPALIVE const char* orc_slice(const char* config_json) {
    try {
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
            if (g_progress) g_progress(st.percent, st.text.c_str());
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
        // Fix round 2: additive success field — always present, empty when the
        // config is clean. M2 clients (config UI) rely on this to warn about
        // keys the pinned libslic3r dropped (handle_legacy's catch-all).
        json dropped = json::array();
        for (const std::string& k : substitutions.unrecogized_keys)
            dropped.push_back(k);
        return dup_json(json{{"ok", true}, {"unrecognized_keys", std::move(dropped)}}.dump());
    } catch (const std::exception& e) {
        // process() is where libslic3r throws SlicingErrors (GCode.cpp:2250);
        // the helper surfaces the per-object messages instead of the bare
        // category. This is the only bridge call that can throw it, so the
        // other catches keep plain e.what().
        return error_json_from_exception(e);
    } catch (...) {
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
    return {{"offset", {offset.x(), offset.y(), offset.z()}},
            {"rotation", {rotation.x(), rotation.y(), rotation.z()}},
            {"scale", {scale.x(), scale.y(), scale.z()}},
            {"mirror", {mirror.x(), mirror.y(), mirror.z()}}};
}

static Slic3r::Vec3d transform_vec3(const json& transform, const char* key) {
    const auto& v = transform.at(key);
    if (!v.is_array() || v.size() != 3)
        throw std::runtime_error(std::string("transform.") + key + " must be a 3-vector");
    return Slic3r::Vec3d(v[0].get<double>(), v[1].get<double>(), v[2].get<double>());
}

static void set_transform(Slic3r::Geometry::Transformation& target, const json& transform) {
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

// Binary toolpath + sliced mesh + stats. Contract mirrors the Task 1
// mock; JS reads the heap buffers and _free()s the pointers.
EMSCRIPTEN_KEEPALIVE const char* orc_get_slice_result() {
    try {
        auto& print = state().print;
        if (print.objects().empty())
            return dup_json(json{{"ok", true}, {"objects", 0}, {"layers", 0},
                                 {"toolpath", json{{"vertex_ptr", 0}, {"vertex_count", 0},
                                                   {"layer_ptr", 0}, {"layer_count", 0},
                                                   {"feature_ptr", 0}, {"feature_count", 0},
                                                   {"features", json::array()}}},
                                 {"mesh", json{{"vertex_ptr", 0}, {"vertex_count", 0},
                                               {"index_ptr", 0}, {"index_count", 0},
                                               {"layer_ptr", 0}, {"layer_count", 0}}}}.dump());

        // The toolpath comes from post-processing the exported gcode
        // (GCodeProcessor::process_file — the GUI's own mechanism). Export
        // happens here so getSliceResult is self-contained; the client's
        // exportGcode() later reads the same /out.gcode via FS. Drift
        // surface: process_file/get_result signatures (Step 1).
        print.export_gcode("/out.gcode", nullptr, nullptr);

        const size_t layers = print.objects().front()->layers().size();
        Slic3r::GCodeProcessorResult gcode_result;
        {
            Slic3r::GCodeProcessor processor;
            processor.process_file("/out.gcode");
            gcode_result = processor.get_result();
        }
        auto tp = bridge::build_toolpath(gcode_result);
        auto mesh = bridge::build_sliced_mesh(print);

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
        const std::uintptr_t mvptr = reinterpret_cast<std::uintptr_t>(mesh.positions.data);
        const std::uintptr_t miptr = reinterpret_cast<std::uintptr_t>(mesh.indices.data);
        const std::uintptr_t mlptr = reinterpret_cast<std::uintptr_t>(mesh.layer_ids.data);
        const size_t n_verts = tp.positions.size / 12;
        const size_t m_verts = mesh.positions.size / 12;
        const size_t m_tris  = mesh.indices.size / 12;
        tp.positions.release(); tp.layers.release(); tp.features.release();
        mesh.positions.release(); mesh.indices.release(); mesh.layer_ids.release();

        json out{{"ok", true}, {"objects", print.objects().size()}, {"layers", layers}};
        out["toolpath"] = {
            {"vertex_ptr", tvptr}, {"vertex_count", n_verts},
            {"layer_ptr", tlptr}, {"layer_count", n_verts},
            {"feature_ptr", tfptr}, {"feature_count", n_verts},
            {"features", std::move(features)},
        };
        out["mesh"] = {
            {"vertex_ptr", mvptr}, {"vertex_count", m_verts},
            {"index_ptr", miptr}, {"index_count", m_tris * 3},
            {"layer_ptr", mlptr}, {"layer_count", m_tris},
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
                         {"max_concurrency", ORCA_WASM_TBB_MAX_CONCURRENCY},
                         {"arena_concurrency", state().tbb_arena.max_concurrency()}}.dump());
#else
    return dup_json(json{{"ok", true}, {"threaded", false},
                         {"max_concurrency", 1}, {"arena_concurrency", 1}}.dump());
#endif
}

// Diagnostic: what preset (if any) is selected in each collection, and what
// the orc_slice baseline full_config() resolves to. M3 troubleshooting — the
// validation fix rounds turned on the question "does the selection land?";
// this turns it into data. Not part of the client API contract; JS may call
// it via the module directly.
EMSCRIPTEN_KEEPALIVE const char* orc_dump_state() {
    try {
        auto& presets = state().presets;
        auto sel = [](const PresetCollection& coll) {
            // Drift at the pinned SHA: the const get_selected_preset()
            // (Preset.hpp:637) does NOT bounds-guard like the non-const
            // overload — check the index before dereferencing.
            json j = json::object();
            const size_t idx = coll.get_selected_idx();
            j["idx"] = idx;
            if (idx < coll.size()) {
                const Preset& p = coll.get_selected_preset();
                j["name"] = p.name;
                j["is_default"] = p.is_default;
            } else {
                j["name"] = nullptr;
                j["is_default"] = true;
            }
            return j;
        };
        json j{{"ok", true},
               {"prints",    sel(presets.prints)},
               {"filaments", sel(presets.filaments)},
               {"printers",  sel(presets.printers)}};
        // M4: the app config's selection keys (what load_selections applies)
        // + the selected printer's vendor triple.
        j["app_config"] = {{"machine",  state().app_config.get("presets", PRESET_PRINTER_NAME)},
                           {"process",  state().app_config.get("presets", PRESET_PRINT_NAME)},
                           {"filament", state().app_config.get("presets", PRESET_FILAMENT_NAME)}};
        {
            const size_t pidx = presets.printers.get_selected_idx();
            if (pidx < presets.printers.size()) {
                const Preset& p = presets.printers.get_selected_preset();
                j["printers"]["vendor_id"] = p.vendor ? p.vendor->id : "";
                j["printers"]["model"]   = p.config.opt_string("printer_model");
                j["printers"]["variant"] = p.config.opt_string("printer_variant");
            }
        }
        // Round 5: what the orc_init scan saw — the leading-generated-default
        // count (observing the private m_num_default_presets via increment
        // iteration), collection size, num_visible (count_if via increment
        // iteration), and would_pick: the selection scan's decision, with
        // the first non-default preset's is_default/is_visible read through
        // the iterator. If would_pick.is_visible reads false for a real
        // preset, that is the round-4 gate that silently skipped everything.
        {
            size_t n_defaults = 0;
            for (auto it = presets.printers.lbegin();
                 it != presets.printers.end() && it->is_default; ++it)
                ++n_defaults;
            json pick = json::object();
            size_t pick_idx = 0;
            for (auto it = presets.printers.lbegin();
                 it != presets.printers.end(); ++it, ++pick_idx) {
                if (it->is_default)
                    continue;
                pick = {{"idx", pick_idx}, {"name", it->name},
                        {"is_default", it->is_default},
                        {"is_visible", it->is_visible}};
                break;
            }
            j["scan"] = {{"leading_defaults", n_defaults},
                         {"printers_size", presets.printers.size()},
                         {"num_visible", presets.printers.num_visible()},
                         {"would_pick", pick}};
        }
        // The exact baseline orc_slice slices with.
        const DynamicPrintConfig& cfg = presets.full_config();
        json full = json::object();
        for (const char* key : {"gcode_flavor", "use_relative_e_distances",
                                "before_layer_change_gcode", "layer_change_gcode",
                                "bed_shape", "printer_model", "machine_start_gcode",
                                "filament_density"})
            if (const ConfigOption* opt = cfg.optptr(key)) full[key] = opt->serialize();
        j["full_config"] = std::move(full);
        return dup_json(j.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

// Round-5 diagnostic: call select_preset(idx) directly and report what
// sticks — isolates the scan's gates (would_pick) from select_preset's
// internals (m_idx_selected / m_edited_preset) in the binary.
EMSCRIPTEN_KEEPALIVE const char* orc_select_printer(double idx) {
    try {
        auto& coll = state().presets.printers;
        if (idx < 0 || idx >= double(coll.size()))
            return error_json("idx out of range");
        coll.select_preset(size_t(idx));
        return dup_json(json{{"ok", true},
                             {"idx", coll.get_selected_idx()},
                             {"name", coll.get_selected_preset().name}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

}  // extern "C"
