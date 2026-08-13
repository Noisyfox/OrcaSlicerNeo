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

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <utility>

#include "libslic3r/AppConfig.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/PresetBundle.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/Utils.hpp"

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

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_init() {
    try {
        // Embedded curated profiles land at /system (build.sh --embed-file);
        // /user is a writable MEMFS dir setup_directories() creates.
        set_data_dir("/");
        state().presets.setup_directories();
        state().presets.load_presets(state().app_config, ForwardCompatibilitySubstitutionRule::Enable);
        return dup_json(json{{"ok", true},
                             {"prints",   state().presets.prints.size()},
                             {"filaments", state().presets.filaments.size()},
                             {"printers",  state().presets.printers.size()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
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
        for (auto it = coll->begin(); it != coll->end(); ++it)
            arr.push_back({{"name", it->name}});
        return dup_json(json{{"presets", arr}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
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
    }
}

// Model bytes arrive in the WASM heap (JS: _malloc + HEAPU8 + _free).
// Stage them to a MEMFS file so the format loaders can open a real path.
EMSCRIPTEN_KEEPALIVE const char* orc_load_model(const char* data, int len, const char* ext) {
    try {
        if (!data || len <= 0) return error_json("no model bytes");
        const std::string path =
            "/tmp/uploaded_model." + std::string(ext && *ext ? ext : "stl");
        std::FILE* f = std::fopen(path.c_str(), "wb");
        if (!f) return error_json("cannot open /tmp for model upload");
        std::fwrite(data, 1, size_t(len), f);
        std::fclose(f);

        DynamicPrintConfig dummy;
        state().model = Model::read_from_file(path, &dummy, nullptr,
                                              LoadStrategy::AddDefaultInstances);
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
    }
}

using progress_fn = void (*)(int, const char*);
progress_fn g_progress = nullptr;

EMSCRIPTEN_KEEPALIVE void orc_set_progress_callback(progress_fn cb) { g_progress = cb; }

EMSCRIPTEN_KEEPALIVE const char* orc_slice(const char* config_json) {
    try {
        // Start from the FULL default config (same discipline as slice_main:
        // libslic3r expects the option map to contain every key — optptr()
        // returns nullptr for missing ones and Print::apply's normalize paths
        // dereference that, crashing on a null object). The JSON keys are
        // applied on top, then normalized exactly like slice_main.cpp:30.
        DynamicPrintConfig config = DynamicPrintConfig::full_print_config();
        const json cfg = json::parse(config_json ? config_json : "");
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
            // Drift at the pinned SHA: no 3-arg set_deserialize(key, value,
            // rule); set_deserialize_strict(key, value) (Config.hpp:2771)
            // applies exactly the Disable rule the brief's call used.
            config.set_deserialize_strict(key, value);
        }
        config.normalize_fdm();

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
        state().print.process();
        state().print.set_status_default();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
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

// JSON stats for v1; the binary toolpath + sliced-mesh buffers land in
// Milestone 2 (Epic 2.4) where the JS client drives their layout.
EMSCRIPTEN_KEEPALIVE const char* orc_get_slice_result() {
    try {
        // Drift at the pinned SHA: Print::objects is the accessor
        // objects() (Print.hpp:968), not a data member — call it.
        json out{{"ok", true}, {"objects", state().print.objects().size()}};
        if (!state().print.objects().empty())
            out["layers"] = state().print.objects().front()->layers().size();
        return dup_json(out.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_export_gcode() {
    try {
        const std::string path = "/out.gcode";
        state().print.export_gcode(path, nullptr, nullptr);
        return dup_json(json{{"ok", true}, {"path", path}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
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
    }
}

}  // extern "C"
