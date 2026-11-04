// Read-only sliced-3MF inspection. No BridgeState, preset activation, or project
// session is touched. The host runs this entrypoint in a disposable Worker.
#include <emscripten/emscripten.h>
#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/ProjectTask.hpp"
#include "nlohmann/json.hpp"
#include <cstdlib>
#include <cstring>
#include <sstream>
#include <stdexcept>

namespace {
using nlohmann::json;
json configuration(const Slic3r::DynamicPrintConfig& config)
{
    json result = json::object();
    for (const char* key : {"printer_model", "nozzle_diameter", "nozzle_volume_type", "curr_bed_type",
            "filament_type", "filament_colour", "filament_ids", "filament_settings_id", "filament_vendor",
            "chamber_temperature", "temperature_vitrification", "required_nozzle_HRC",
            "filament_map", "filament_map_mode", "enable_filament_dynamic_map", "has_filament_switcher"})
        if (const auto* option = config.option(key)) {
            if (const auto* strings = dynamic_cast<const Slic3r::ConfigOptionStrings*>(option)) result[key] = strings->values;
            else if (const auto* floats = dynamic_cast<const Slic3r::ConfigOptionFloats*>(option)) result[key] = floats->values;
            else if (const auto* ints = dynamic_cast<const Slic3r::ConfigOptionInts*>(option)) result[key] = ints->values;
            else if (const auto* flag = dynamic_cast<const Slic3r::ConfigOptionBool*>(option)) result[key] = flag->value;
            else result[key] = option->serialize();
        }
    return result;
}

json inspect(const void* bytes, size_t length)
{
    std::istringstream input(std::string(static_cast<const char*>(bytes), length));
    Slic3r::Model model;
    Slic3r::DynamicPrintConfig config;
    Slic3r::PlateDataPtrs plates;
    struct Release { Slic3r::PlateDataPtrs& plates; ~Release() { for (auto* p : plates) delete p; } } release{plates};
    Slic3r::Semver version;
    if (!Slic3r::load_gcode_3mf_from_stream(input, &config, &model, &plates, &version))
        throw std::runtime_error("Cannot parse sliced-3MF metadata");
    json targets = json::array();
    for (const auto* plate : plates) {
        json materials = json::array(), warnings = json::array();
        for (const auto& m : plate->slice_filaments_info)
            materials.push_back({{"index", m.id}, {"type", m.type}, {"color", m.color},
                {"presetId", m.filament_id}, {"brand", m.brand}, {"usedGrams", m.used_g},
                {"usedMeters", m.used_m}, {"nozzleDiameter", m.nozzle_diameter},
                {"nozzleFlowType", m.nozzle_volume_type}});
        for (const auto& w : plate->warnings) warnings.push_back({{"message", w.msg}, {"code", w.error_code}});
        targets.push_back({{"plateIndex", plate->plate_index}, {"gcodePath", plate->gcode_file},
            {"thumbnailPath", plate->thumbnail_file}, {"printerModelId", plate->printer_model_id},
            {"nozzleDiameters", plate->nozzle_diameters}, {"nozzleFlowTypes", plate->nozzle_volume_types},
            {"filamentMap", plate->filament_maps}, {"duration", plate->gcode_prediction},
            {"weight", plate->gcode_weight}, {"toolpathOutside", plate->toolpath_outside},
            {"materials", materials}, {"warnings", warnings}, {"configuration", configuration(plate->config)}});
    }
    return {{"ok", true}, {"configuration", configuration(config)}, {"targets", targets}};
}

const char* copy_json(const json& value)
{
    const auto text = value.dump();
    auto* out = static_cast<char*>(std::malloc(text.size() + 1));
    if (out) std::memcpy(out, text.c_str(), text.size() + 1);
    return out;
}
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_inspect_remote_print(const char* request_json)
{
    try {
        const auto request = json::parse(request_json);
        const auto address = request.at("pointer").get<uintptr_t>();
        const auto length = request.at("length").get<size_t>();
        if (!address) throw std::runtime_error("Missing inspection bytes");
        return copy_json(inspect(reinterpret_cast<const void*>(address), length));
    } catch (const std::exception& error) {
        return copy_json({{"ok", false}, {"error", error.what()}});
    } catch (...) {
        return copy_json({{"ok", false}, {"error", "Sliced-3MF inspection failed"}});
    }
}
