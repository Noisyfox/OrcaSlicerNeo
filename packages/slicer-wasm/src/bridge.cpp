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

#include "bridge_buffers.hpp"
// Drift at the pinned SHA: GCodeProcessor.hpp lives under GCode/; the brief's
// PrintObject.hpp does not exist (class PrintObject is in Print.hpp, already
// included above).
#include "libslic3r/GCode/GCodeProcessor.hpp"

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
        // Fix round 2: additive success field — always present, empty when the
        // config is clean. M2 clients (config UI) rely on this to warn about
        // keys the pinned libslic3r dropped (handle_legacy's catch-all).
        json dropped = json::array();
        for (const std::string& k : substitutions.unrecogized_keys)
            dropped.push_back(k);
        return dup_json(json{{"ok", true}, {"unrecognized_keys", std::move(dropped)}}.dump());
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

// ---- new: model triangle mesh + instance offset ----

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
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_model_mesh() {
    try {
        auto& model = state().model;
        json arr = json::array();
        for (size_t oi = 0; oi < model.objects.size(); ++oi) {
            const auto& obj = model.objects[oi];
            const auto& its = obj->mesh().its;
            MallocBuffer vbuf;
            MallocBuffer ibuf;
            for (const auto& v : its.vertices) {
                vbuf.appendF32(v.x());
                vbuf.appendF32(v.y());
                vbuf.appendF32(v.z());
            }
            for (const auto& tri : its.indices) {
                ibuf.appendU32(static_cast<std::uint32_t>(tri[0]));
                ibuf.appendU32(static_cast<std::uint32_t>(tri[1]));
                ibuf.appendU32(static_cast<std::uint32_t>(tri[2]));
            }
            // Instance 0's offset (v1: one instance per object).
            Slic3r::Vec3d off(0, 0, 0);
            if (!obj->instances.empty()) off = obj->instances.front()->get_offset();
            // Heap pointers cross the bridge as uintptr_t — the build is
            // wasm64 (-sMEMORY64), so a uint32_t truncation is a compile
            // error. JS reads them as plain numbers (< 2^53; our buffers
            // stay well under 4 GiB).
            const std::uintptr_t vptr = reinterpret_cast<std::uintptr_t>(vbuf.data);
            const std::uintptr_t iptr = reinterpret_cast<std::uintptr_t>(ibuf.data);
            vbuf.release();
            ibuf.release();
            arr.push_back(json{
                {"object_idx", oi},
                {"vertex_ptr", vptr},
                {"vertex_count", its.vertices.size()},
                {"index_ptr", iptr},
                {"index_count", its.indices.size() * 3},
                {"offset", {off.x(), off.y(), off.z()}},
            });
        }
        return dup_json(json{{"ok", true}, {"objects", std::move(arr)}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
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
