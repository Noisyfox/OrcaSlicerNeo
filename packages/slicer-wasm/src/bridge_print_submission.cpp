#include "bridge_print_submission.hpp"
#include "bridge_state.hpp"
#include "libslic3r/Format/bbs_3mf.hpp"
#include "slic3r/Utils/ASCIIFolding.hpp"
#include <tbb/task_arena.h>
#include <cstdio>
#include <set>
#include <stdexcept>

namespace Slic3r::Neo::Bridge::PrintSubmission {
using nlohmann::json;

namespace {
std::string text(const DynamicPrintConfig& config, const char* key, std::size_t index = 0)
{
    if (const auto* strings = config.option<ConfigOptionStrings>(key))
        return strings->values.empty() ? "" : strings->get_at(index);
    if (const auto* string = config.option<ConfigOptionString>(key)) return string->value;
    if (const auto* value = config.option(key)) return value->serialize();
    return "";
}

std::string model_id(const DynamicPrintConfig& config)
{
    const auto model = text(config, "printer_model");
    // Immutable installed vendor catalogue, not the currently selected preset.
    for (const auto& vendor : state().presets.vendors)
        for (const auto& candidate : vendor.second.models)
            if (candidate.name == model) return candidate.model_id;
    return "";
}

void populate(PlateData& plate, PlateRuntimeRegistry::Entry& entry)
{
    auto& print = *entry.print;
    const auto& result = *entry.gcode_result;
    const auto& config = print.full_print_config();
    // A submitted archive contains one plate regardless of the workspace index.
    plate.plate_index = 0;
    plate.gcode_file = entry.gcode_path;
    plate.is_sliced_valid = true;
    plate.config = config;
    plate.printer_model_id = model_id(config);
    if (const auto* opt = config.option("nozzle_diameter")) plate.nozzle_diameters = opt->serialize();
    if (const auto* opt = config.option("nozzle_volume_type")) plate.nozzle_volume_types = opt->serialize();
    plate.gcode_prediction = std::to_string(static_cast<int>(result.print_statistics.modes[0].time));
    plate.gcode_weight = std::to_string(print.print_statistics().total_weight);
    plate.first_layer_time = std::to_string(result.initial_layer_time);
    plate.toolpath_outside = result.toolpath_outside;
    plate.timelapse_warning_code = result.timelapse_warning_code;
    plate.is_label_object_enabled = result.label_object_enabled;
    plate.is_support_used = print.is_support_used();
    plate.filament_maps = print.get_filament_maps();
    plate.limit_filament_maps = result.limit_filament_maps;
    plate.layer_filaments = result.layer_filaments;
    plate.filament_change_sequence = result.filament_change_sequence;
    plate.nozzle_change_sequence = result.nozzle_change_sequence;
    plate.optimal_assignment = result.optimal_assignment;
    plate.warnings = result.warnings;
    plate.parse_filament_info(entry.gcode_result.get());
    for (auto& material : plate.slice_filaments_info) {
        std::string display_type;
        material.type = plate.config.get_filament_type(display_type, material.id);
        material.color = text(config, "filament_colour", material.id);
        material.filament_id = text(config, "filament_ids", material.id);
    }
}
}

json describe(PlateRuntimeRegistry::Entry& entry)
{
    const auto& print = *entry.print;
    const auto& config = print.full_print_config();
    PlateData plate;
    populate(plate, entry);
    json materials = json::array(), nozzle_flows = json::array();
    const auto& diameters = print.config().nozzle_diameter.values;
    const auto& group = entry.gcode_result->nozzle_group_result;
    for (std::size_t i = 0; i < diameters.size(); ++i)
        nozzle_flows.push_back(get_nozzle_volume_type_string(static_cast<NozzleVolumeType>(print.config().nozzle_volume_type.get_at(i))));
    for (const auto& material : plate.slice_filaments_info) {
        const auto tool = print.get_extruder_id(material.id);
        if (tool >= diameters.size()) throw std::runtime_error("Invalid slice material tool assignment");
        materials.push_back({{"key", "filament-" + std::to_string(material.id)},
            {"index", material.id}, {"type", material.type}, {"color", material.color},
            {"presetId", material.filament_id}, {"presetName", text(config, "filament_settings_id", material.id)}, {"brand", text(config, "filament_vendor", material.id)},
            {"toolIndex", tool}, {"nozzleDiameter", diameters[tool]},
            {"nozzleFlowType", get_nozzle_volume_type_string(static_cast<NozzleVolumeType>(print.config().nozzle_volume_type.get_at(tool)))},
            {"requiredNozzleHardness", print.config().required_nozzle_HRC.get_at(material.id)},
            {"usedGrams", material.used_g}, {"usedMeters", material.used_m}});
    }
    std::size_t layer_count = 0;
    for (const auto* object : print.objects()) layer_count = std::max(layer_count, object->layer_count());
    json warnings = json::array();
    for (const auto& warning : entry.gcode_result->warnings)
        warnings.push_back({{"message", warning.msg}, {"code", warning.error_code}});
    return {{"plateId", entry.plate_id}, {"printerModel", text(config, "printer_model")},
        {"printerModelId", plate.printer_model_id}, {"materials", materials},
        {"nozzleDiameters", diameters}, {"nozzleFlowTypes", nozzle_flows}, {"filamentMap", plate.filament_maps},
        {"requiresDynamicMapping", group && group->is_support_dynamic_nozzle_map()},
        {"bedType", text(config, "curr_bed_type")},
        {"durationSeconds", entry.gcode_result->print_statistics.modes[0].time}, {"layerCount", layer_count},
        {"weightGrams", print.print_statistics().total_weight},
        {"timelapseWarningCode", plate.timelapse_warning_code},
        {"toolpathOutside", plate.toolpath_outside}, {"warnings", warnings}};
}

json export_package(PlateRuntimeRegistry::Entry& entry, const std::string& filename_base, const json& material_ids)
{
    const auto manifest = describe(entry);
    PlateData plate;
    populate(plate, entry);
    if (!material_ids.is_array()) throw std::runtime_error("Invalid material catalog mapping");
    std::set<std::string> overridden;
    for (const auto& item : material_ids) {
        const auto key = item.at("materialKey").get<std::string>();
        const auto id = item.at("catalogId").get<std::string>();
        if (id.size() > 128 || id.find('\0') != std::string::npos || !overridden.insert(key).second)
            throw std::runtime_error("Invalid material catalog mapping");
        auto material = std::find_if(plate.slice_filaments_info.begin(), plate.slice_filaments_info.end(),
            [&](const auto& m) { return key == "filament-" + std::to_string(m.id); });
        if (material == plate.slice_filaments_info.end()) throw std::runtime_error("Unknown slice material");
        material->filament_id = id;
    }
    DynamicPrintConfig config = entry.print->full_print_config();
    // SkipModel is Orca's normal dispatch contract. The writer still reads
    // model metadata; provide the retained native snapshot, not the live scene.
    Model model(entry.print->model());
    const std::string print_path = entry.gcode_path + ".print.3mf";
    const std::string config_path = entry.gcode_path + ".config.3mf";
    try {
        StoreParams params;
        params.model = &model;
        params.config = &config;
        params.plate_data_list = {&plate};
        params.export_plate_idx = 0;
        tbb::task_arena arena(1);
        for (const bool with_gcode : {true, false}) {
            params.path = with_gcode ? print_path : config_path;
            params.strategy = SaveStrategy::Silence | SaveStrategy::SkipModel |
                SaveStrategy::SkipAuxiliary | SaveStrategy::Zip64 |
                (with_gcode ? SaveStrategy::WithGcode : SaveStrategy::WithSliceInfo);
            bool stored = false;
            arena.execute([&] { stored = store_bbs_3mf(params); });
            if (!stored) throw std::runtime_error("Print 3MF export failed");
        }
        std::string name = fold_utf8_to_ascii(entry.print->output_filename(filename_base), false);
        const auto extension = name.find_last_of('.');
        if (extension != std::string::npos) name.erase(extension);
        return {{"manifest", manifest}, {"file_name", name + ".gcode.3mf"},
            {"path", print_path}, {"config_path", config_path},
            {"plate_index", 1}, {"gcode_path", "Metadata/plate_1.gcode"}};
    } catch (...) {
        std::remove(print_path.c_str());
        std::remove(config_path.c_str());
        throw;
    }
}
}
