// ----------------------------------------------------------------
// Printer / Filament preset drafts and effective configuration assembly.
// ----------------------------------------------------------------
#include "bridge_preset_drafts.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <optional>
#include <sstream>
#include <set>
#include <stdexcept>

#include <emscripten/emscripten.h>

#include "bridge_state.hpp"
#include "bridge_filament.hpp"
#include "bridge_history.hpp"
#include "bridge_plate.hpp"
#include "bridge_prime_tower.hpp"
#include "bridge_profiles.hpp"
#include "bridge_scoped_config.hpp"
#include "bridge_slicing_pipeline.hpp"
#include "libslic3r/PrintConfig.hpp"

using namespace Slic3r;
using nlohmann::json;

namespace Slic3r::Neo::Bridge {

namespace {

const Preset* find_canonical_preset(const PresetCollection& collection,
                                    const std::string& canonical_name)
{
    for (const Preset& preset : collection.get_presets())
        if (preset.name == canonical_name)
            return &preset;
    return nullptr;
}

const Preset* find_preset_source(const PresetBundle& bundle, const Preset::Type type,
                                 const std::string& canonical_name)
{
    if (type == Preset::TYPE_PRINTER)
        return find_canonical_preset(bundle.printers, canonical_name);
    if (type == Preset::TYPE_FILAMENT)
        return find_canonical_preset(bundle.filaments, canonical_name);
    return nullptr;
}

Preset::Type parse_kind(const std::string& kind)
{
    if (kind == "printer") return Preset::TYPE_PRINTER;
    if (kind == "filament") return Preset::TYPE_FILAMENT;
    throw std::runtime_error("kind must be printer|filament");
}

std::string kind_name(const Preset::Type type)
{
    if (type == Preset::TYPE_PRINTER) return "printer";
    if (type == Preset::TYPE_FILAMENT) return "filament";
    throw std::runtime_error("preset draft type must be printer|filament");
}

void apply_draft(Preset& preset, const PresetDraftRegistry& drafts)
{
    const auto* overrides = drafts.find(preset.type, preset.name);
    if (overrides == nullptr) return;

    ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
    for (const auto& [key, value] : *overrides)
        preset.config.set_deserialize(key, value, substitutions);
}

json config_values_json(const DynamicPrintConfig& config)
{
    json values = json::object();
    for (const std::string& key : config.keys()) {
        const ConfigOption* option = config.option(key);
        if (option == nullptr) continue;
        try { values[key] = option->serialize(); }
        catch (...) { /* retain only values the native config can serialize */ }
    }
    return values;
}

void erase_secure_options(DynamicPrintConfig& config)
{
    // Keep this in sync with PresetBundle::full_config_secure().
    config.erase("print_host");
    config.erase("print_host_webui");
    config.erase("printhost_apikey");
    config.erase("printhost_cafile");
    config.erase("printhost_user");
    config.erase("printhost_password");
    config.erase("printhost_port");
}

char* duplicate_json(const std::string& value)
{
    auto* output = static_cast<char*>(std::malloc(value.size() + 1));
    if (output == nullptr) std::abort();
    std::memcpy(output, value.data(), value.size());
    output[value.size()] = '\0';
    return output;
}

json error_json(const std::string& message)
{
    return json{{"ok", false},
                {"error_code", "native_validation_failure"}, {"error", message}};
}

json command_error(const std::string& code, const std::string& message)
{
    return json{{"ok", false}, {"error_code", code},
                {"error", message}, {"revision", state().history_revision}};
}

} // namespace

const PresetDraftRegistry::Overrides* PresetDraftRegistry::find(
    const Preset::Type type, const std::string& canonical_name) const
{
    const auto entry = m_entries.find({type, canonical_name});
    return entry == m_entries.end() ? nullptr : &entry->second;
}

PresetDraftRegistry::Overrides* PresetDraftRegistry::find(
    const Preset::Type type, const std::string& canonical_name)
{
    const auto entry = m_entries.find({type, canonical_name});
    return entry == m_entries.end() ? nullptr : &entry->second;
}

bool PresetDraftRegistry::contains(const Preset::Type type,
                                   const std::string& canonical_name) const
{
    return m_entries.find({type, canonical_name}) != m_entries.end();
}

void PresetDraftRegistry::ensure_entry(const Preset::Type type,
                                       const std::string& canonical_name)
{
    if (canonical_name.empty()) throw std::invalid_argument("preset draft name is required");
    m_entries.try_emplace({type, canonical_name});
}

void PresetDraftRegistry::set(const Preset::Type type,
                              const std::string& canonical_name,
                              const std::string& key,
                              const std::string& serialized_value)
{
    if (canonical_name.empty() || key.empty())
        throw std::invalid_argument("preset draft name and option key are required");
    m_entries[{type, canonical_name}][key] = serialized_value;
}

void PresetDraftRegistry::erase_field(const Preset::Type type,
                                      const std::string& canonical_name,
                                      const std::string& key)
{
    if (auto* overrides = find(type, canonical_name)) overrides->erase(key);
}

void PresetDraftRegistry::erase_preset(const Preset::Type type,
                                       const std::string& canonical_name)
{
    m_entries.erase({type, canonical_name});
}

void PresetDraftRegistry::clear()
{
    m_entries.clear();
}

json PresetDraftRegistry::snapshot_json() const
{
    json entries = json::array();
    for (const auto& [identity, overrides] : m_entries) {
        entries.push_back(json{{"kind", kind_name(identity.first)}, {"canonical_name", identity.second},
                               {"overrides", overrides}});
    }
    return json{{"entries", std::move(entries)}};
}

PresetDraftRegistry PresetDraftRegistry::from_snapshot_json(const json& value,
                                                             const PresetBundle& bundle)
{
    if (!value.is_object() || !value.contains("entries") || !value["entries"].is_array())
        throw std::runtime_error("invalid preset draft registry history root");

    PresetDraftRegistry result;
    for (const auto& entry : value["entries"]) {
        if (!entry.is_object() || !entry.contains("kind") || !entry["kind"].is_string() ||
            !entry.contains("canonical_name") || !entry["canonical_name"].is_string() ||
            !entry.contains("overrides") || !entry["overrides"].is_object())
            throw std::runtime_error("invalid preset draft history entry");
        const Preset::Type type = parse_kind(entry["kind"].get<std::string>());
        const std::string canonical_name = entry["canonical_name"].get<std::string>();
        if (canonical_name.empty() || result.contains(type, canonical_name))
            throw std::runtime_error("invalid or duplicate preset draft identity");
        const Preset* source = find_preset_source(bundle, type, canonical_name);
        if (source == nullptr || source->name != canonical_name)
            throw std::runtime_error("history preset draft source is unavailable: " + canonical_name);
        for (auto it = entry["overrides"].begin(); it != entry["overrides"].end(); ++it) {
            if (!it.value().is_string() || source->config.option(it.key()) == nullptr)
                throw std::runtime_error("invalid preset draft history override: " + it.key());
            Preset candidate = *source;
            ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
            candidate.config.set_deserialize(it.key(), it.value().get<std::string>(), substitutions);
            const ConfigOption* accepted = candidate.config.option(it.key());
            if (accepted == nullptr)
                throw std::runtime_error("preset draft history option is unavailable: " + it.key());
            result.set(type, canonical_name, it.key(), accepted->serialize());
        }
        // Preserve an empty overlay: field/category resets intentionally keep
        // the child until the explicit Reset preset command removes it.
        if (entry["overrides"].empty()) result.m_entries[{type, canonical_name}] = {};
    }
    return result;
}

namespace PresetDrafts {

DynamicPrintConfig effective_preset_config(
    const PresetBundle& bundle, const PresetDraftRegistry& drafts,
    const Preset::Type type, const std::string& canonical_name)
{
    const Preset* source = find_preset_source(bundle, type, canonical_name);
    if (source == nullptr)
        throw std::runtime_error("preset source not found: " + canonical_name);
    Preset effective = *source;
    apply_draft(effective, drafts);
    return std::move(effective.config);
}

DynamicPrintConfig effective_full_config(
    const PresetBundle& bundle, const PresetDraftRegistry& drafts,
    const bool apply_extruder,
    std::optional<std::vector<int>> filament_maps,
    std::optional<std::vector<int>> filament_volume_maps)
{
    Preset printer = bundle.printers.get_selected_preset();
    apply_draft(printer, drafts);

    // The native static assembler is the standard FFF configuration path. It
    // receives temporary Printer and Filament values plus the existing Print
    // edited preset and project config; no collection edited-preset slot is
    // swapped, even temporarily.
    if (printer.printer_technology() == ptFFF) {
        Preset print = bundle.prints.get_edited_preset();
        std::vector<Preset> filaments;
        filaments.reserve(bundle.filament_presets.size());
        for (const std::string& canonical_name : bundle.filament_presets) {
            const Preset* source = find_preset_source(bundle, Preset::TYPE_FILAMENT, canonical_name);
            if (source == nullptr)
                throw std::runtime_error("selected filament preset not found: " + canonical_name);
            filaments.emplace_back(*source);
            apply_draft(filaments.back(), drafts);
        }
        if (filaments.empty())
            throw std::runtime_error("selected filament rack has no presets");
        return PresetBundle::construct_full_config(
            printer, print, bundle.project_config, filaments, apply_extruder,
            std::move(filament_maps), std::move(filament_volume_maps));
    }

    // SLA has no filament rack and no corresponding static assembler. Keep
    // Orca's existing SLA composition, then apply the selected Printer's
    // sparse draft values to the returned temporary config.
    DynamicPrintConfig config = bundle.full_config(apply_extruder,
                                                   std::move(filament_maps),
                                                   std::move(filament_volume_maps));
    const auto* overrides = drafts.find(Preset::TYPE_PRINTER, printer.name);
    if (overrides != nullptr) {
        ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
        for (const auto& [key, value] : *overrides)
            config.set_deserialize(key, value, substitutions);
    }
    return config;
}

DynamicPrintConfig effective_full_config(
    const bool apply_extruder,
    std::optional<std::vector<int>> filament_maps,
    std::optional<std::vector<int>> filament_volume_maps)
{
    return effective_full_config(state().presets, state().preset_drafts, apply_extruder,
                                 std::move(filament_maps), std::move(filament_volume_maps));
}

DynamicPrintConfig effective_full_config_secure(
    const PresetBundle& bundle, const PresetDraftRegistry& drafts,
    std::optional<std::vector<int>> filament_maps)
{
    DynamicPrintConfig config = effective_full_config(
        bundle, drafts, false, std::move(filament_maps));
    erase_secure_options(config);
    return config;
}

DynamicPrintConfig effective_printer_config()
{
    return effective_preset_config(state().presets, state().preset_drafts,
                                   Preset::TYPE_PRINTER,
                                   state().presets.printers.get_selected_preset_name());
}

DynamicPrintConfig effective_full_config_secure(
    std::optional<std::vector<int>> filament_maps)
{
    return effective_full_config_secure(state().presets, state().preset_drafts,
                                        std::move(filament_maps));
}

namespace {

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

json editor_binding_json(const std::string& key, const ConfigOptionDef& def,
                         const ConfigOption& source, const ConfigOption& effective)
{
    const auto scalar_type = editor_element_type(key, def);
    if (!scalar_type) return nullptr;
    const auto* source_vector = dynamic_cast<const ConfigOptionVectorBase*>(&source);
    const auto* effective_vector = dynamic_cast<const ConfigOptionVectorBase*>(&effective);
    if (source_vector == nullptr || effective_vector == nullptr || source_vector->size() == 0 ||
        effective_vector->size() == 0)
        return nullptr;

    json binding{{"scalar_type", *scalar_type}, {"index", 0},
                 {"element_count", effective_vector->size()}, {"nullable", def.nullable},
                 {"gui_type", editor_gui_type_name(def.gui_type)},
                 {"gui_flags", def.gui_flags}, {"multiline", def.multiline},
                 {"is_code", def.is_code}, {"readonly", def.readonly},
                 {"source_value", editor_element_value(source, def, 0)},
                 {"effective_value", editor_element_value(effective, def, 0)}};
    if (*scalar_type == "enum") binding["enum_options"] = editor_enum_options(def);
    return binding;
}

json set_editor_element_value(const Preset& source, const std::string& key,
                              const std::string& scalar_type, const uint64_t index,
                              const json& value, std::string& serialized_value)
{
    const ConfigOptionDef* def = print_config_def.get(key);
    const ConfigOption* source_option = source.config.option(key);
    if (def == nullptr || source_option == nullptr)
        return command_error("unsupported_option", "option is not available on this preset: " + key);
    const auto expected_type = editor_element_type(key, *def);
    if (!expected_type)
        return command_error("unsupported_option", "option does not expose editable vector elements: " + key);
    if (scalar_type != *expected_type)
        return command_error("invalid_element_type", "preset editor element type does not match native option: " + key);

    DynamicPrintConfig edited_config;
    edited_config.set_key_value(key, source_option->clone());
    if (const auto* overrides = state().preset_drafts.find(source.type, source.name)) {
        const auto override = overrides->find(key);
        if (override != overrides->end()) {
            ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
            try {
                edited_config.set_deserialize(key, override->second, substitutions);
            } catch (const std::exception& error) {
                return command_error("native_validation_failure", error.what());
            }
        }
    }

    ConfigOption* edited_option = edited_config.option(key);
    auto* edited_vector = edited_option == nullptr ? nullptr :
        dynamic_cast<ConfigOptionVectorBase*>(edited_option);
    if (edited_vector == nullptr || index >= edited_vector->size() ||
        index > static_cast<uint64_t>(std::numeric_limits<size_t>::max()))
        return command_error("invalid_index", "preset editor vector index is out of range: " + key);

    if (value.is_null()) {
        if (!def->nullable || !edited_vector->nullable())
            return command_error("invalid_value", "null is not valid for this preset editor element: " + key);
        edited_vector->set_at_to_nil(static_cast<size_t>(index));
    } else {
        switch (def->type) {
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
                if (!std::isfinite(number))
                    return command_error("invalid_value", "preset editor element requires a finite number: " + key);
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
        serialized_value = edited_option->serialize();
    } catch (const std::exception& error) {
        return command_error("native_validation_failure", error.what());
    }
    return nullptr;
}

} // namespace

json get_draft_json(const Preset::Type type, const std::string& canonical_name)
{
    const Preset* source = find_preset_source(state().presets, type, canonical_name);
    if (source == nullptr)
        return json{{"ok", false}, {"error_code", "preset_not_found"},
                    {"error", "preset not found: " + canonical_name}};

    Preset effective = *source;
    apply_draft(effective, state().preset_drafts);
    const auto* overrides = state().preset_drafts.find(type, canonical_name);
    const json override_values = overrides == nullptr ? json::object() : json(*overrides);
    const json& all_metadata = Profiles::option_metadata_json();
    json source_metadata = json::object();
    json editor_bindings = json::object();
    for (const std::string& key : source->config.keys())
        if (all_metadata.contains(key)) source_metadata[key] = all_metadata[key];
    for (const std::string& key : source->config.keys()) {
        const ConfigOptionDef* def = print_config_def.get(key);
        const ConfigOption* source_option = source->config.option(key);
        const ConfigOption* effective_option = effective.config.option(key);
        if (def == nullptr || source_option == nullptr || effective_option == nullptr) continue;
        json binding = editor_binding_json(key, *def, *source_option, *effective_option);
        if (!binding.is_null()) editor_bindings[key] = std::move(binding);
    }
    return json{{"ok", true}, {"kind", kind_name(type)},
                {"canonical_name", source->name},
                {"draft_exists", overrides != nullptr},
                {"modified", overrides != nullptr && !overrides->empty()},
                {"overrides", override_values},
                {"source_values", config_values_json(source->config)},
                {"effective_values", config_values_json(effective.config)},
                {"option_metadata", std::move(source_metadata)},
                {"editor_bindings", std::move(editor_bindings)},
                {"revision", state().history_revision}};
}

// Only notes are excluded: all other keys conservatively retain native
// geometry/placement refresh. Compare actual overlays so resets use the same
// policy as sets, including a Reset preset that removes structural overrides.
bool geometry_inputs_changed(const PresetDraftRegistry::Overrides* before,
                             const PresetDraftRegistry::Overrides* after)
{
    const PresetDraftRegistry::Overrides empty;
    const auto& old_values = before == nullptr ? empty : *before;
    const auto& new_values = after == nullptr ? empty : *after;
    const auto has_change = [](const auto& left, const auto& right) {
        for (const auto& [key, value] : left) {
            if (key == "printer_notes" || key == "filament_notes") continue;
            const auto other = right.find(key);
            if (other == right.end() || other->second != value) return true;
        }
        return false;
    };
    return has_change(old_values, new_values) || has_change(new_values, old_values);
}

json mutate_draft_json(const json& request)
{
    if (!request.is_object())
        return command_error("invalid_request", "invalid preset draft request");
    if (state().active_history_transaction)
        return command_error("history_transaction_active", "preset draft command cannot run inside another history transaction");
    if (state().history_disabled)
        return command_error("history_disabled", "project history is disabled");
    if (!request.contains("expected_revision") || !request["expected_revision"].is_number_unsigned())
        return command_error("stale_revision", "preset draft revision is required");
    const std::uint64_t expected_revision = request["expected_revision"].get<std::uint64_t>();
    if (expected_revision != state().history_revision)
        return command_error("stale_revision", "preset draft revision is stale");

    const Preset::Type type = parse_kind(request.value("kind", std::string{}));
    const std::string canonical_name = request.value("canonical_name", std::string{});
    const std::string action = request.value("action", std::string{});
    if (canonical_name.empty())
        return command_error("invalid_request", "canonical preset name is required");
    if (action != "set" && action != "set-element" && action != "reset-field" &&
        action != "reset-category" && action != "reset-preset")
        return command_error("invalid_request", "action must be set|set-element|reset-field|reset-category|reset-preset");

    const Preset* source = find_preset_source(state().presets, type, canonical_name);
    if (source == nullptr)
        return command_error("preset_not_found", "preset not found: " + canonical_name);

    std::string key;
    std::string serialized_value;
    std::vector<std::string> keys;
    if (action == "set") {
        if (!request.contains("key") || !request["key"].is_string() ||
            request["key"].get<std::string>().empty() || !request.contains("value") ||
            !request["value"].is_string())
            return command_error("invalid_request", "set requires key and serialized value");
        key = request["key"].get<std::string>();
        if (source->config.option(key) == nullptr || print_config_def.get(key) == nullptr)
            return command_error("unsupported_option", "option is not available on this preset: " + key);
        try {
            Preset candidate = *source;
            ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
            candidate.config.set_deserialize(key, request["value"].get<std::string>(), substitutions);
            const ConfigOption* accepted = candidate.config.option(key);
            if (accepted == nullptr)
                return command_error("unsupported_option", "option is not available on this preset: " + key);
            serialized_value = accepted->serialize();
        } catch (const std::exception& error) {
            return command_error("native_validation_failure", error.what());
        }
    } else if (action == "set-element") {
        if (!request.contains("key") || !request["key"].is_string() ||
            request["key"].get<std::string>().empty() ||
            !request.contains("scalar_type") || !request["scalar_type"].is_string() ||
            !request.contains("index") || !request["index"].is_number_unsigned() ||
            !request.contains("value"))
            return command_error("invalid_request", "set-element requires key, scalar_type, index, and typed value");
        key = request["key"].get<std::string>();
        const std::uint64_t index = request["index"].get<std::uint64_t>();
        const json error = set_editor_element_value(
            *source, key, request["scalar_type"].get<std::string>(), index,
            request["value"], serialized_value);
        if (!error.is_null()) return error;
    } else if (action == "reset-field") {
        if (!request.contains("key") || !request["key"].is_string() ||
            request["key"].get<std::string>().empty())
            return command_error("invalid_request", "reset-field requires an option key");
        key = request["key"].get<std::string>();
        if (source->config.option(key) == nullptr)
            return command_error("unsupported_option", "option is not available on this preset: " + key);
        keys.push_back(key);
    } else if (action == "reset-category") {
        if (!request.contains("keys") || !request["keys"].is_array() || request["keys"].empty())
            return command_error("invalid_request", "reset-category requires a non-empty explicit option key set");
        std::set<std::string> unique;
        for (const auto& value : request["keys"]) {
            if (!value.is_string() || value.get<std::string>().empty() ||
                !unique.insert(value.get<std::string>()).second)
                return command_error("invalid_request", "reset-category option keys must be unique non-empty strings");
            const std::string category_key = value.get<std::string>();
            if (source->config.option(category_key) == nullptr)
                return command_error("unsupported_option", "option is not available on this preset: " + category_key);
            keys.push_back(category_key);
        }
    }

    const auto before_drafts = state().preset_drafts;
    const auto before_draft_revision = state().preset_draft_revision;
    const auto before_project_config = state().presets.project_config;
    const Model before_model = state().model;
    const auto before_plates = state().plate_session_plates;
    const auto before_plate_revisions = state().plate_input_revisions;
    const auto before_membership = state().instance_plate_ids;
    const auto before_out_of_bounds = state().plate_out_of_bounds_ids;
    const auto before_parked = state().parked_instance_ids;
    const auto before_pending = state().pending_membership_instance_ids;
    const auto before_current_plate = state().current_plate_id;
    const auto before_lifecycle = state().plate_runtime_registry.capture_lifecycle();
    const auto before_live_context = state().history_live_context;
    const std::uint64_t revision_before = state().history_revision;
    const auto before_context = HistoryMetadata::default_history_context(
        state(), PlateSession::plate_session_snapshot_json(),
        Filament::State::history_state_json(state().presets));
    if (!HistoryMetadata::begin_timestamped_operation(state(), "Edit " + canonical_name, before_context))
        return command_error("native_validation_failure", "could not capture preset draft history predecessor");
    bool history_started = true;
    bool mutated = false;
    bool history_committed = false;
    const auto rollback = [&]() {
        if (history_committed) return;
        if (history_started) {
            HistoryMetadata::abort_timestamped_operation(state());
            history_started = false;
        }
        if (!mutated) return;
        state().preset_drafts = before_drafts;
        state().preset_draft_revision = before_draft_revision;
        state().presets.project_config = before_project_config;
        state().model = before_model;
        state().mutable_object_capture_cache.clear();
        state().plate_session_plates = before_plates;
        PlateSession::reconcile_plate_runtime_registry();
        state().plate_input_revisions = before_plate_revisions;
        state().instance_plate_ids = before_membership;
        state().plate_out_of_bounds_ids = before_out_of_bounds;
        state().parked_instance_ids = before_parked;
        state().pending_membership_instance_ids = before_pending;
        state().current_plate_id = before_current_plate;
        state().plate_runtime_registry.restore_lifecycle(before_lifecycle);
        state().history_live_context = before_live_context;
        PrimeTower::invalidate_projection_cache();
    };

    try {
        mutated = true;
        if (action == "set" || action == "set-element")
            state().preset_drafts.set(type, canonical_name, key, serialized_value);
        else if (action == "reset-field" || action == "reset-category")
            state().preset_drafts.ensure_entry(type, canonical_name);
        if (action == "reset-field" || action == "reset-category")
            for (const auto& reset_key : keys)
                state().preset_drafts.erase_field(type, canonical_name, reset_key);
        else if (action == "reset-preset")
            state().preset_drafts.erase_preset(type, canonical_name);

        // Material drafts feed the native minimum-flush calculation. Rebuild
        // the project-owned matrix before the common all-plate mutation path.
        const bool refresh_geometry = geometry_inputs_changed(
            before_drafts.find(type, canonical_name), state().preset_drafts.find(type, canonical_name));
        auto& bundle = state().presets;
        if (refresh_geometry && type == Preset::TYPE_FILAMENT &&
            bundle.printers.get_selected_preset().printer_technology() == ptFFF)
            Filament::Commands::recalculate_filament_flush(bundle);

        const json plate_session = refresh_geometry
            ? PlateSession::shared_configuration_mutation_snapshot()
            : PlateSession::configuration_mutation_snapshot(
                PlateSession::all_plate_ids(), {"shared-configuration"}, json::array());
        ++state().preset_draft_revision;
        json after_context = HistoryMetadata::default_history_context(
            state(), plate_session, Filament::State::history_state_json(state().presets));
        after_context["presetDraftRegistry"] = state().preset_drafts.snapshot_json();
        after_context["presetDraftRevision"] = state().preset_draft_revision;

        // Stage every snapshot that can fail before the history commit. The
        // reply then publishes the exact committed revision without leaving a
        // mutation behind if snapshot construction rejects native state.
        json result = get_draft_json(type, canonical_name);
        if (!result.value("ok", false))
            throw std::runtime_error("committed preset draft could not be read back");
        const json native_config = ScopedConfig::native_scoped_config_full_transport(revision_before + 1);
        json filament_session = Filament::Session::filament_session_snapshot_json();
        if (!filament_session.value("ok", false))
            throw std::runtime_error("preset draft filament snapshot could not be constructed");
        filament_session["revisions"]["session"] = revision_before + 1;
        filament_session["revisions"]["project"] = revision_before + 1;

        if (!HistoryMetadata::commit_timestamped_operation(state(), after_context)) {
            rollback();
            return command_error("native_validation_failure", "history commit rejected preset draft mutation");
        }
        history_committed = true;
        history_started = false;
        SlicingPipeline::invalidate_preview_source();

        result["history_entry_delta"] = 1;
        result["revision_before"] = revision_before;
        result["revision_after"] = revision_before + 1;
        result["revision"] = revision_before + 1;
        result["dirty"] = state().history.project_modified();
        result["affected_plate_ids"] = plate_session.value("affected_plate_ids", json::array());
        result["all_plate_results_invalidated"] = true;
        result["plate_session"] = plate_session;
        result["filament_session"] = std::move(filament_session);
        result["history_status"] = HistoryMetadata::history_status_json(state());
        result["native_scoped_config"] = native_config;
        return result;
    } catch (...) {
        rollback();
        throw;
    }
}

} // namespace PresetDrafts
} // namespace Slic3r::Neo::Bridge

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_get_preset_draft(const char* kind_cstr,
                                                       const char* canonical_name_cstr)
{
    using namespace Slic3r::Neo::Bridge;
    try {
        const std::string kind = kind_cstr ? kind_cstr : "";
        const Preset::Type type = kind == "printer" ? Preset::TYPE_PRINTER :
            (kind == "filament" ? Preset::TYPE_FILAMENT : Preset::TYPE_INVALID);
        if (type == Preset::TYPE_INVALID)
            return duplicate_json(json{{"ok", false},
                                       {"error_code", "invalid_request"},
                                       {"error", "kind must be printer|filament"}}.dump());
        const std::string canonical_name = canonical_name_cstr ? canonical_name_cstr : "";
        if (canonical_name.empty())
            return duplicate_json(json{{"ok", false},
                                       {"error_code", "invalid_request"},
                                       {"error", "canonical preset name required"}}.dump());
        return duplicate_json(PresetDrafts::get_draft_json(type, canonical_name).dump());
    } catch (const std::exception& error) {
        return duplicate_json(error_json(error.what()).dump());
    } catch (...) {
        return duplicate_json(error_json("unknown C++ exception").dump());
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_mutate_preset_draft(const char* request_cstr)
{
    using namespace Slic3r::Neo::Bridge;
    try {
        const json request = request_cstr && *request_cstr ? json::parse(request_cstr) : json::object();
        return duplicate_json(PresetDrafts::mutate_draft_json(request).dump());
    } catch (const std::exception& error) {
        return duplicate_json(error_json(error.what()).dump());
    } catch (...) {
        return duplicate_json(error_json("unknown C++ exception").dump());
    }
}

} // extern "C"
