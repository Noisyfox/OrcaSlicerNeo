#include "bridge_config_elements.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
#include <sstream>
namespace Slic3r::Neo::Bridge::ConfigElements {
static json command_error(const std::string& code, const std::string& message) {
    return {{"ok", false}, {"error_code", code}, {"error", message}};
}
std::string editor_gui_type_name(const ConfigOptionDef::GUIType gui_type)
{
    using GUIType = ConfigOptionDef::GUIType;
    switch (gui_type) {
        case GUIType::undefined: return "undefined";
        case GUIType::i_enum_open: return "i_enum_open";
        case GUIType::f_enum_open: return "f_enum_open";
        case GUIType::color: return "color";
        case GUIType::select_open: return "select_open";
        case GUIType::slider: return "slider";
        case GUIType::legend: return "legend";
        case GUIType::one_string: return "one_string";
        case GUIType::plugin_picker: return "plugin_picker";
        case GUIType::plugin_config: return "plugin_config";
        case GUIType::printer_agent_select: return "printer_agent_select";
    }
    return "undefined";
}

bool has_gui_flag(const std::string& flags, const std::string& expected)
{
    std::istringstream input(flags);
    std::string flag;
    while (input >> flag)
        if (flag == expected) return true;
    return false;
}

std::optional<std::string> editor_element_type(const std::string& key,
                                              const ConfigOptionDef& def)
{
    static const std::set<std::string> structured_or_identity_fields = {
        "compatible_machine_expression_group", "compatible_process_expression_group",
        "different_settings_to_system", "filament_colour_type", "filament_extruder_compatibility",
        "filament_ids", "filament_multi_colour", "filament_ramming_parameters",
        "filament_settings_id", "print_compatible_printers", "upward_compatible_machine",
        "volumetric_speed_coefficients",
    };
    if (def.is_scalar() || key == "compatible_printers" || key == "compatible_prints" ||
        structured_or_identity_fields.find(key) != structured_or_identity_fields.end() ||
        def.gui_type == ConfigOptionDef::GUIType::one_string ||
        def.gui_type == ConfigOptionDef::GUIType::plugin_picker ||
        def.gui_type == ConfigOptionDef::GUIType::plugin_config ||
        def.gui_type == ConfigOptionDef::GUIType::select_open ||
        def.gui_type == ConfigOptionDef::GUIType::printer_agent_select ||
        has_gui_flag(def.gui_flags, "serialized"))
        return std::nullopt;

    switch (def.type) {
        case coFloats: return "float";
        case coInts: return "int";
        case coBools: return "bool";
        case coStrings: return "string";
        case coPercents: return "percent";
        case coFloatsOrPercents: return "float_or_percent";
        case coEnums: return def.enum_keys_map == nullptr ? std::nullopt :
                                                           std::optional<std::string>("enum");
        default: return std::nullopt;
    }
}

std::optional<std::string> editor_vector_type(const std::string& key, const ConfigOptionDef& def)
{
    if (key == "extruder_offset" && def.type == coPoints) return "point";
    if (key == "extruder_printable_area" && def.type == coPointsGroups) return "points";
    return editor_element_type(key, def);
}

bool printer_extruder_key(const std::string& key)
{
    const auto& keys = print_config_def.extruder_option_keys();
    return key == "extruder_printable_area" || std::find(keys.begin(), keys.end(), key) != keys.end();
}

void resize_editor_vector(ConfigOptionVectorBase& option, const ConfigOptionDef& def, size_t count)
{
    // The native point-group default is itself empty; generic resize would
    // dereference its first element. An empty group is a valid default region.
    if (def.type == coPointsGroups && option.empty())
        dynamic_cast<ConfigOptionPointsGroups&>(option).values.resize(count);
    else option.resize(count, def.default_value.get());
}

json editor_element_value(const ConfigOption& option, const ConfigOptionDef& def,
                          const size_t index)
{
    const auto* vector = dynamic_cast<const ConfigOptionVectorBase*>(&option);
    if (vector == nullptr || index >= vector->size())
        throw std::runtime_error("preset editor vector element is unavailable");
    if (def.nullable && vector->is_nil(index)) return nullptr;

    switch (def.type) {
        case coFloats:
        case coPercents: {
            const double value = dynamic_cast<const ConfigOptionVector<double>&>(option).get_at(index);
            if (!std::isfinite(value))
                throw std::runtime_error("preset editor numeric element is not finite");
            return value;
        }
        case coInts:
        case coEnums:
            return dynamic_cast<const ConfigOptionVector<int>&>(option).get_at(index);
        case coBools:
            return dynamic_cast<const ConfigOptionVector<unsigned char>&>(option).get_at(index) != 0;
        case coStrings:
            return dynamic_cast<const ConfigOptionVector<std::string>&>(option).get_at(index);
        case coFloatsOrPercents: {
            const auto& value = dynamic_cast<const ConfigOptionVector<FloatOrPercent>&>(option).get_at(index);
            if (!std::isfinite(value.value))
                throw std::runtime_error("preset editor float-or-percent element is not finite");
            return json{{"value", value.value}, {"percent", value.percent}};
        }
        case coPoints: {
            const auto& point = dynamic_cast<const ConfigOptionPoints&>(option).get_at(index);
            return {{"x", point.x()}, {"y", point.y()}};
        }
        case coPointsGroups: {
            json points = json::array();
            for (const auto& point : dynamic_cast<const ConfigOptionPointsGroups&>(option).get_at(index))
                points.push_back({{"x", point.x()}, {"y", point.y()}});
            return points;
        }
        default:
            throw std::runtime_error("unsupported preset editor vector element type");
    }
}

json editor_enum_options(const ConfigOptionDef& def)
{
    json values = json::array();
    if (def.enum_keys_map == nullptr) return values;

    for (size_t index = 0; index < def.enum_values.size(); ++index) {
        const std::string& name = def.enum_values[index];
        const auto found = def.enum_keys_map->find(name);
        if (found == def.enum_keys_map->end()) continue;
        values.push_back({{"value", found->second}, {"name", name},
                          {"label", index < def.enum_labels.size() ? def.enum_labels[index] : name}});
    }
    return values;
}

json set_element(DynamicPrintConfig& config, const std::string& key,
                 const std::string& scalar_type, const uint64_t index,
                 const json& value, const size_t count)
{
    const auto* def = print_config_def.get(key);
    ConfigOption* edited_option = config.option(key);
    if (!def || !edited_option)
        return command_error("unsupported_option", "option is not available: " + key);
    const auto expected_type = editor_vector_type(key, *def);
    if (!expected_type)
        return command_error("unsupported_option", "option does not expose editable vector elements: " + key);
    if (scalar_type != *expected_type)
        return command_error("invalid_element_type", "element type does not match native option: " + key);
    auto* edited_vector = dynamic_cast<ConfigOptionVectorBase*>(edited_option);
    if (!edited_vector || index >= count)
        return command_error("invalid_index", "vector element index is out of range: " + key);
    if (index >= edited_vector->size()) resize_editor_vector(*edited_vector, *def, count);
    if (value.is_null()) {
        if (!def->nullable || !edited_vector->nullable())
            return command_error("invalid_value", "null is not valid for this preset editor element: " + key);
        edited_vector->set_at_to_nil(static_cast<size_t>(index));
    } else {
        if (value.is_number() && def->type != coEnums &&
            (value.get<double>() < def->min || value.get<double>() > def->max))
            return command_error("invalid_value", "preset editor element is outside its native range: " + key);
        switch (def->type) {
            case coPoints:
            case coPointsGroups: {
                const auto parse_point = [](const json& input) -> Vec2d {
                    if (!input.is_object() || input.size() != 2 || !input.contains("x") || !input.contains("y") ||
                        !input["x"].is_number() || !input["y"].is_number())
                        throw std::runtime_error("coordinate requires finite x and y");
                    const double x = input["x"].get<double>(), y = input["y"].get<double>();
                    if (!std::isfinite(x) || !std::isfinite(y)) throw std::runtime_error("coordinate is not finite");
                    return Vec2d(x, y);
                };
                try {
                    if (def->type == coPoints)
                        dynamic_cast<ConfigOptionPoints&>(*edited_option).values[index] = parse_point(value);
                    else {
                        if (!value.is_array() || (!value.empty() && value.size() < 3))
                            return command_error("invalid_value", "printable area requires an empty group or at least three coordinates");
                        Vec2ds points;
                        for (const auto& point : value) points.push_back(parse_point(point));
                        dynamic_cast<ConfigOptionPointsGroups&>(*edited_option).values[index] = std::move(points);
                    }
                } catch (const std::exception& error) { return command_error("invalid_value", error.what()); }
                break;
            }
            case coFloats:
            case coPercents: {
                if (!value.is_number())
                    return command_error("invalid_value", "preset editor element requires a finite number: " + key);
                const double number = value.get<double>();
                if (!std::isfinite(number))
                    return command_error("invalid_value", "preset editor element requires a finite number: " + key);
                if (def->type == coFloats) {
                    const ConfigOptionFloat scalar(number);
                    edited_vector->set_at(&scalar, static_cast<size_t>(index), 0);
                } else {
                    const ConfigOptionPercent scalar(number);
                    edited_vector->set_at(&scalar, static_cast<size_t>(index), 0);
                }
                break;
            }
            case coInts: {
                if (!value.is_number_integer())
                    return command_error("invalid_value", "preset editor element requires an integer: " + key);
                int64_t number = 0;
                if (value.is_number_unsigned()) {
                    const uint64_t unsigned_number = value.get<uint64_t>();
                    if (unsigned_number > static_cast<uint64_t>(std::numeric_limits<int>::max()))
                        return command_error("invalid_value", "preset editor integer is out of range: " + key);
                    number = static_cast<int64_t>(unsigned_number);
                } else {
                    number = value.get<int64_t>();
                }
                if (number < std::numeric_limits<int>::min() || number > std::numeric_limits<int>::max())
                    return command_error("invalid_value", "preset editor integer is out of range: " + key);
                const ConfigOptionInt scalar(static_cast<int>(number));
                edited_vector->set_at(&scalar, static_cast<size_t>(index), 0);
                break;
            }
            case coBools: {
                if (!value.is_boolean())
                    return command_error("invalid_value", "preset editor element requires a boolean: " + key);
                const ConfigOptionBool scalar(value.get<bool>());
                edited_vector->set_at(&scalar, static_cast<size_t>(index), 0);
                break;
            }
            case coStrings: {
                if (!value.is_string())
                    return command_error("invalid_value", "preset editor element requires text: " + key);
                const ConfigOptionString scalar(value.get<std::string>());
                edited_vector->set_at(&scalar, static_cast<size_t>(index), 0);
                break;
            }
            case coFloatsOrPercents: {
                if (!value.is_object() || value.size() != 2 || !value.contains("value") ||
                    !value["value"].is_number() || !value.contains("percent") ||
                    !value["percent"].is_boolean())
                    return command_error("invalid_value", "preset editor element requires {value, percent}: " + key);
                const double number = value["value"].get<double>();
                if (!std::isfinite(number) || number < def->min || number > def->max)
                    return command_error("invalid_value", "preset editor element is outside its native range: " + key);
                const ConfigOptionFloatOrPercent scalar(number, value["percent"].get<bool>());
                edited_vector->set_at(&scalar, static_cast<size_t>(index), 0);
                break;
            }
            case coEnums: {
                if (!value.is_number_integer())
                    return command_error("invalid_value", "preset editor enum element requires an integer: " + key);
                int64_t number = 0;
                if (value.is_number_unsigned()) {
                    const uint64_t unsigned_number = value.get<uint64_t>();
                    if (unsigned_number > static_cast<uint64_t>(std::numeric_limits<int>::max()))
                        return command_error("invalid_value", "preset editor enum value is out of range: " + key);
                    number = static_cast<int64_t>(unsigned_number);
                } else {
                    number = value.get<int64_t>();
                }
                if (number < std::numeric_limits<int>::min() || number > std::numeric_limits<int>::max())
                    return command_error("invalid_value", "preset editor enum value is out of range: " + key);
                const bool accepted = def->enum_keys_map != nullptr &&
                    std::any_of(def->enum_keys_map->begin(), def->enum_keys_map->end(),
                        [number](const auto& entry) { return entry.second == number; });
                if (!accepted)
                    return command_error("invalid_value", "preset editor enum value is not defined natively: " + key);
                const ConfigOptionEnumGeneric scalar(def->enum_keys_map, static_cast<int>(number));
                edited_vector->set_at(&scalar, static_cast<size_t>(index), 0);
                break;
            }
            default:
                return command_error("unsupported_option", "option does not expose editable vector elements: " + key);
        }
    }

    try {
        edited_option->serialize();
    } catch (const std::exception& error) {
        return command_error("native_validation_failure", error.what());
    }
    return nullptr;
}

size_t element_count(const DynamicPrintConfig& config, const Preset::Type type, const std::string& key)
{
    const auto* vector = dynamic_cast<const ConfigOptionVectorBase*>(config.option(key));
    if (!vector) return 0;
    const auto count = [&config](const std::string& name) -> size_t {
        const auto* option = dynamic_cast<const ConfigOptionVectorBase*>(config.option(name));
        return option ? option->size() : 0;
    };
    if (type == Preset::TYPE_PRINTER) {
        if (printer_options_with_variant_1.count(key) || printer_options_with_variant_2.count(key)) {
            const auto variants = count("printer_extruder_variant");
            return (variants ? variants : count("nozzle_diameter")) * (printer_options_with_variant_2.count(key) ? 2 : 1);
        }
        if (printer_extruder_key(key)) return count("nozzle_diameter");
    }
    if (type == Preset::TYPE_FILAMENT && filament_options_with_variant.count(key))
        return count("filament_extruder_variant");
    if (type == Preset::TYPE_PRINT && print_options_with_variant.count(key))
        return count("print_extruder_variant");
    return vector->size();
}

json reset_element(DynamicPrintConfig& config, const DynamicPrintConfig& source,
                   const std::string& key, const uint64_t index, const size_t count)
{
    const auto* def = print_config_def.get(key);
    const auto* source_option = source.option(key);
    auto* edited = dynamic_cast<ConfigOptionVectorBase*>(config.option(key));
    const auto* original = dynamic_cast<const ConfigOptionVectorBase*>(source_option);
    if (!def || !original || !edited || !editor_vector_type(key, *def))
        return command_error("unsupported_option", "option does not support indexed reset: " + key);
    if (index >= count) return command_error("invalid_index", "reset index is out of range: " + key);
    if (index >= edited->size()) resize_editor_vector(*edited, *def, count);
    std::unique_ptr<ConfigOption> defaults(original->clone());
    auto* values = dynamic_cast<ConfigOptionVectorBase*>(defaults.get());
    if (values->empty()) resize_editor_vector(*values, *def, count);
    edited->set_at(values, index, index < values->size() ? index : 0);
    return nullptr;
}

bool equal_elements(const ConfigOption& left, const ConfigOption& right, const ConfigOptionDef& def)
{
    const auto& a = dynamic_cast<const ConfigOptionVectorBase&>(left);
    const auto& b = dynamic_cast<const ConfigOptionVectorBase&>(right);
    if (a.empty() || b.empty()) {
        if (a.empty() && b.empty()) return true;
        if (def.type != coPointsGroups) return false;
        const auto& values = dynamic_cast<const ConfigOptionPointsGroups&>(a.empty() ? right : left).values;
        return std::all_of(values.begin(), values.end(), [](const auto& group) { return group.empty(); });
    }
    for (size_t i = 0; i < std::max(a.size(), b.size()); ++i)
        if (editor_element_value(left, def, i < a.size() ? i : 0) !=
            editor_element_value(right, def, i < b.size() ? i : 0)) return false;
    return true;
}

json vectors_json(const DynamicPrintConfig& source, const DynamicPrintConfig& effective, const Preset::Type type)
{
    json vectors = json::object();
    for (const auto& key : source.keys()) {
        const auto* def = print_config_def.get(key);
        const auto* original = source.option(key);
        const auto* edited = effective.option(key);
        if (!def || !original || !edited) continue;
        const auto scalar_type = editor_vector_type(key, *def);
        const auto* a = dynamic_cast<const ConfigOptionVectorBase*>(original);
        const auto* b = dynamic_cast<const ConfigOptionVectorBase*>(edited);
        if (!scalar_type || !a || !b) continue;
        json source_values = json::array(), effective_values = json::array();
        for (size_t i = 0; i < a->size(); ++i) source_values.push_back(editor_element_value(*original, *def, i));
        for (size_t i = 0; i < b->size(); ++i) effective_values.push_back(editor_element_value(*edited, *def, i));
        json vector{{"scalar_type", *scalar_type}, {"source_values", std::move(source_values)},
            {"effective_values", std::move(effective_values)}, {"index_count", element_count(effective, type, key)},
            {"nullable", def->nullable}, {"gui_type", editor_gui_type_name(def->gui_type)},
            {"gui_flags", def->gui_flags}, {"multiline", def->multiline}, {"is_code", def->is_code}, {"readonly", def->readonly}};
        if (*scalar_type == "enum") vector["enum_options"] = editor_enum_options(*def);
        vectors[key] = std::move(vector);
    }
    return vectors;
}

}
