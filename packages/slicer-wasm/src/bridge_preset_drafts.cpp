// ----------------------------------------------------------------
// Printer / Filament preset drafts and effective configuration assembly.
// ----------------------------------------------------------------
#include "bridge_preset_drafts.hpp"
#include "bridge_config_elements.hpp"

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
#include "bridge_user_presets.hpp"
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

    // Identity/cardinality options must be applied before their sparse vectors.
    for (const bool vectors : {false, true})
        for (const auto& [key, value] : *overrides)
            if (value.is_array() == vectors) ConfigElements::apply_override(preset.config, preset.type, key, value);
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
                              const json& value)
{
    if (canonical_name.empty() || key.empty())
        throw std::invalid_argument("preset draft name and option key are required");
    m_entries[{type, canonical_name}][key] = value;
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
        for (auto it = entry["overrides"].begin(); it != entry["overrides"].end(); ++it)
            result.set(type, canonical_name, it.key(), it.value());
        Preset candidate = *source;
        apply_draft(candidate, result);
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
    if (printer.printer_technology() != ptFFF)
        throw std::runtime_error("only FFF printers are supported");

    // The native static assembler is the standard FFF configuration path. It
    // receives temporary Printer and Filament values plus the existing Print
    // edited preset and project config; no collection edited-preset slot is
    // swapped, even temporarily.
    Preset print = bundle.prints.get_edited_preset();
    const DynamicPrintConfig& filament_defaults = bundle.filaments.default_preset().config;
    const auto filament_keys = filament_defaults.keys();
    std::vector<Preset> filaments;
    filaments.reserve(bundle.filament_presets.size());
    for (const std::string& canonical_name : bundle.filament_presets) {
        const Preset* source = find_preset_source(bundle, Preset::TYPE_FILAMENT, canonical_name);
        if (source == nullptr)
            throw std::runtime_error("selected filament preset not found: " + canonical_name);
        filaments.emplace_back(*source);
        apply_draft(filaments.back(), drafts);
        // Project-embedded presets may carry the expanded project config.
        // Orca's ordinary assembler iterates the default Filament keys;
        // its static assembler instead iterates the first input's keys.
        // Supply only Filament-owned options, with native defaults for
        // missing keys, so other slots never supply a null vector option.
        DynamicPrintConfig owned_config = filament_defaults;
        owned_config.apply_only(filaments.back().config, filament_keys, true);
        filaments.back().config = std::move(owned_config);
    }
    if (filaments.empty())
        throw std::runtime_error("selected filament rack has no presets");
    return PresetBundle::construct_full_config(
        printer, print, bundle.project_config, filaments, apply_extruder,
        std::move(filament_maps), std::move(filament_volume_maps));
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

// Editing candidates are independent of project selection. Compatibility is
// against the project's effective Printer, never the Printer being browsed.
json editor_candidates_json(const Preset::Type type, const std::string& canonical_name)
{
    const auto& bundle = state().presets;
    const auto& collection = type == Preset::TYPE_PRINTER ? bundle.printers : bundle.filaments;
    Preset printer = bundle.printers.get_selected_preset();
    apply_draft(printer, state().preset_drafts);
    const auto printer_profile = bundle.printers.get_preset_with_vendor_profile(printer);
    json candidates = json::array();
    for (const Preset& preset : collection.get_presets()) {
        if (!UserPresets::picker_visible(preset) && preset.name != canonical_name) continue;
        if ((!preset.is_visible || preset.is_default) && preset.name != canonical_name) continue;
        if (type == Preset::TYPE_PRINTER && preset.printer_technology() != ptFFF) continue;
        const auto* overrides = state().preset_drafts.find(type, preset.name);
        const bool compatible = type == Preset::TYPE_PRINTER || is_compatible_with_printer(
            collection.get_preset_with_vendor_profile(preset), printer_profile);
        candidates.push_back(json{{"canonical_name", preset.name},
            {"is_user", UserPresets::picker_is_user(preset)},
            {"is_project_embedded", UserPresets::picker_is_project_embedded(preset)},
            {"label", UserPresets::is_snapshot(type, preset.name) ? Profiles::preset_display_label(preset) : preset.name},
            {"compatible", compatible}, {"modified", (overrides || UserPresets::is_snapshot(type, preset.name)) && UserPresets::modified(type, preset.name,
                effective_preset_config(bundle, state().preset_drafts, type, preset.name))}});
    }
    std::stable_sort(candidates.begin(), candidates.end(), [](const json& a, const json& b) {
        if (a.at("compatible") != b.at("compatible")) return a.at("compatible").get<bool>();
        return a.at("modified").get<bool>() && !b.at("modified").get<bool>();
    });
    return candidates;
}

// Values can be projected without traversing the installed candidate collection.
json draft_values_json(const Preset::Type type, const std::string& canonical_name)
{
    const auto visible_name = UserPresets::view_name(type, canonical_name);
    if (visible_name != canonical_name) return draft_values_json(type, visible_name);
    const Preset* source = find_preset_source(state().presets, type, canonical_name);
    if (source == nullptr)
        return json{{"ok", false}, {"error_code", "preset_not_found"},
                    {"error", "preset not found: " + canonical_name}};

    Preset effective = *source;
    apply_draft(effective, state().preset_drafts);
    const auto* overrides = state().preset_drafts.find(type, canonical_name);
    json override_values = overrides == nullptr ? json::object() : json(*overrides);
    const json& all_metadata = Profiles::option_metadata_json();
    json source_metadata = json::object();
    const auto& collection = type == Preset::TYPE_PRINTER ? state().presets.printers : state().presets.filaments;
    const Preset* parent = collection.get_preset_parent(*source);
    json editor_vectors = json::object();
    for (const std::string& key : source->config.keys())
        if (all_metadata.contains(key)) {
            source_metadata[key] = all_metadata[key];
            if (parent != nullptr)
                if (const ConfigOption* option = parent->config.option(key))
                    source_metadata[key]["tooltip_default"] = option->serialize();
        }
    const auto* baseline = UserPresets::baseline(type, canonical_name);
    const auto& baseline_config = baseline ? baseline->config : source->config;
    if (UserPresets::is_snapshot(type, canonical_name) ||
        (!source->is_system && !source->is_default && !source->is_external)) {
        override_values = json::object();
        for (const auto& key : effective.config.diff(baseline_config)) {
            if (key == "inherits" || key == "printer_settings_id" || key == "filament_settings_id") continue;
            auto values = ConfigElements::explicit_values(effective.config, type, key);
            if (values.is_array()) {
                const auto saved = ConfigElements::explicit_values(baseline_config, type, key, values.size());
                for (size_t i = 0; i < values.size(); ++i)
                    if (values[i] == saved[i]) values[i] = nullptr;
                if (!ConfigElements::has_override(values)) continue;
            }
            override_values[key] = std::move(values);
        }
    }
    editor_vectors = ConfigElements::vectors_json(baseline_config, effective.config, type, override_values);
    return json{{"ok", true}, {"kind", kind_name(type)},
                {"canonical_name", source->name},
                {"draft_exists", overrides != nullptr || UserPresets::is_snapshot(type, canonical_name)},
                {"modified", UserPresets::modified(type, canonical_name, effective.config)},
                {"overrides", override_values},
                {"source_values", config_values_json(baseline_config)},
                {"effective_values", config_values_json(effective.config)},
                {"option_metadata", std::move(source_metadata)},
                {"editor_vectors", std::move(editor_vectors)},
                {"revision", state().history_revision}};
}

json get_draft_json(const Preset::Type type, const std::string& canonical_name)
{
    auto result = draft_values_json(type, canonical_name);
    if (result.value("ok", false))
        result["editor_candidates"] = editor_candidates_json(type, result.at("canonical_name"));
    return result;
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

// These Filament values cannot change collection identity/compatibility or
// project/model slot references. Flushing and every other small projection are
// still rebuilt. Unknown keys deliberately retain the full receipt.
bool ordinary_filament_edit_key(const std::string& key)
{
    static const std::set<std::string> keys{
        "filament_notes", "nozzle_temperature", "nozzle_temperature_initial_layer",
        "filament_flow_ratio", "filament_max_volumetric_speed", "filament_change_length",
        "fan_min_speed", "fan_max_speed", "additional_cooling_fan_speed", "overhang_fan_speed",
        "overhang_fan_threshold", "close_fan_the_first_x_layers", "full_fan_speed_layer",
        "fan_cooling_layer_time", "slowdown_below_layer_time", "slowdown_min_speed",
        "slowdown_for_layer_cooling"
    };
    return keys.count(key) != 0;
}

json mutate_draft_json(const json& request)
{
    if (!request.is_object())
        return command_error("invalid_request", "invalid preset draft request");
    const auto editing_context = HistoryMetadata::parse_history_context(
        request.at("history_context").dump().c_str());
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
    const auto* saved_baseline = UserPresets::baseline(type, canonical_name);
    const auto& baseline_config = saved_baseline ? saved_baseline->config : source->config;

    std::string key;
    json override_value;
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
            override_value = ConfigElements::explicit_values(candidate.config, type, key,
                ConfigElements::element_count(source->config, type, key));
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
        auto effective = effective_preset_config(state().presets, state().preset_drafts, type, canonical_name);
        const auto* overrides = state().preset_drafts.find(type, canonical_name);
        const json current = overrides && overrides->count(key) ? overrides->at(key) : json(nullptr);
        override_value = ConfigElements::set_override(effective, type, key, current,
            request["scalar_type"].get<std::string>(), index, request["value"]);
        if (override_value.is_object()) return override_value;
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

    std::map<std::string, json> indexed_resets;
    if ((action == "reset-field" || action == "reset-category") && request.contains("index")) {
        if (!request["index"].is_number_unsigned())
            return command_error("invalid_index", "indexed reset requires an unsigned element index");
        const auto index = request["index"].get<uint64_t>();
        auto effective = effective_preset_config(state().presets, state().preset_drafts, type, canonical_name);
        for (const auto& reset_key : keys) {
            const auto* overrides = state().preset_drafts.find(type, canonical_name);
            const json current = overrides && overrides->count(reset_key) ? overrides->at(reset_key) : json(nullptr);
            const auto result = ConfigElements::reset_override(effective, baseline_config, type, reset_key, current, index);
            if (result.is_object()) return result;
            // Snapshot overrides are stored relative to the frozen source,
            // while Reset reads the latest saved head. Preserve the other
            // elements instead of turning a cleared override into a full reset.
            indexed_resets[reset_key] = UserPresets::is_snapshot(type, canonical_name)
                ? ConfigElements::explicit_values(effective, type, reset_key) : result;
        }
    }

    // Ordinary writes only change this source's overlay. Candidate membership,
    // labels, classification and compatibility read collection sources, not
    // that overlay; only its modified flag can change the candidate ordering.
    // Identity/topology writes and redo-branch collection stay on the full path.
    const bool had_redo = state().history.can_redo();
    const bool ordinary_set = (action == "set" || action == "set-element") &&
        key != "inherits" && key != "printer_settings_id" && key != "filament_settings_id" &&
        key != "print_settings_id" && key != "printer_technology" &&
        key != "printer_model" && key != "printer_variant" && key != "nozzle_diameter";
    const bool stable_target = UserPresets::view_name(type, canonical_name) == canonical_name;
    const bool modified_before = ordinary_set && stable_target && !had_redo &&
        UserPresets::modified(type, canonical_name,
            effective_preset_config(state().presets, state().preset_drafts, type, canonical_name));
    const auto before_drafts = state().preset_drafts;
    const auto before_printer_name = state().presets.printers.get_selected_preset_name();
    const auto before_filament_names = state().presets.filament_presets;
    const auto before_filament_name = state().presets.filaments.get_selected_preset_name();
    std::string result_name = canonical_name;
    const auto before_bed_capabilities = type == Preset::TYPE_PRINTER &&
        canonical_name == state().presets.printers.get_selected_preset_name()
        ? std::optional<Profiles::BedTypeCapabilities>{Profiles::selected_printer_bed_type_capabilities()}
        : std::nullopt;
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
    const auto before_context = HistoryMetadata::canonical_history_context(
        state(), editing_context, PlateSession::plate_session_snapshot_json(),
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
        state().presets.printers.select_preset_by_name(before_printer_name, true);
        state().presets.filaments.select_preset_by_name(before_filament_name, true);
        state().presets.filament_presets = before_filament_names;
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
            state().preset_drafts.set(type, canonical_name, key, override_value);
        else if (action == "reset-field" || action == "reset-category")
            state().preset_drafts.ensure_entry(type, canonical_name);
        if (action == "reset-field" || action == "reset-category")
            for (const auto& reset_key : keys) {
                const auto found = indexed_resets.find(reset_key);
                if (found != indexed_resets.end() && !found->second.is_null())
                    state().preset_drafts.set(type, canonical_name, reset_key, found->second);
                else if (UserPresets::is_snapshot(type, canonical_name))
                    state().preset_drafts.set(type, canonical_name, reset_key,
                        ConfigElements::explicit_values(baseline_config, type, reset_key));
                else state().preset_drafts.erase_field(type, canonical_name, reset_key);
            }
        else if (action == "reset-preset") {
            state().preset_drafts.erase_preset(type, canonical_name);
            if (UserPresets::is_snapshot(type, canonical_name) && saved_baseline) {
                if (!UserPresets::deleted(type, canonical_name) && saved_baseline->name != canonical_name &&
                    find_preset_source(state().presets, type, saved_baseline->name) == saved_baseline) {
                    result_name = saved_baseline->name;
                    UserPresets::adopt(type, canonical_name, result_name);
                    state().preset_drafts.erase_preset(type, result_name);
                } else for (const auto& key : baseline_config.diff(source->config))
                    if (key != "inherits" && key != "printer_settings_id" && key != "filament_settings_id")
                        state().preset_drafts.set(type, canonical_name, key,
                            ConfigElements::explicit_values(baseline_config, type, key));
            }
        }

        // Material drafts feed the native minimum-flush calculation. Rebuild
        // the project-owned matrix before the common all-plate mutation path.
        const bool refresh_geometry = result_name != canonical_name || geometry_inputs_changed(
            before_drafts.find(type, canonical_name), state().preset_drafts.find(type, canonical_name));
        auto& bundle = state().presets;
        if (refresh_geometry && (type == Preset::TYPE_FILAMENT || type == Preset::TYPE_PRINTER) &&
            bundle.printers.get_selected_preset().printer_technology() == ptFFF)
            Filament::Commands::auto_recalculate_filament_flush(bundle, -1, false);

        if (before_bed_capabilities) {
            const auto current = Profiles::selected_printer_bed_type_capabilities();
            const auto& previous = *before_bed_capabilities;
            const bool same_choices = current.choices.size() == previous.choices.size() &&
                std::equal(current.choices.begin(), current.choices.end(), previous.choices.begin(),
                    [](const auto& first, const auto& second) { return first.type == second.type; });
            if (previous.supports_selection != current.supports_selection ||
                previous.default_type != current.default_type || !same_choices)
                Profiles::normalize_bed_types(true);
        }

        const json plate_session = refresh_geometry
            ? PlateSession::shared_configuration_mutation_snapshot()
            : PlateSession::configuration_mutation_snapshot(
                PlateSession::all_plate_ids(), {"shared-configuration"}, json::array());
        ++state().preset_draft_revision;
        json after_context = HistoryMetadata::canonical_history_context(
            state(), editing_context, plate_session,
            Filament::State::history_state_json(state().presets));
        after_context["presetDraftRegistry"] = state().preset_drafts.snapshot_json();
        after_context["presetDraftRevision"] = state().preset_draft_revision;

        // Stage every snapshot that can fail before the history commit. The
        // reply then publishes the exact committed revision without leaving a
        // mutation behind if snapshot construction rejects native state.
        json result = draft_values_json(type, result_name);
        if (!result.value("ok", false))
            throw std::runtime_error("committed preset draft could not be read back");
        const bool candidates_unchanged = ordinary_set && stable_target && !had_redo &&
            result.at("canonical_name") == canonical_name &&
            result.at("modified").get<bool>() == modified_before;
        result["editor_candidates"] = candidates_unchanged
            ? json{{"kind", "unchanged"}}
            : json{{"kind", "replace"}, {"items", editor_candidates_json(type, result.at("canonical_name"))}};
        const json native_config = ScopedConfig::native_scoped_config_full_transport(revision_before + 1);
        const bool ordinary_edit = type == Preset::TYPE_FILAMENT && candidates_unchanged &&
            ordinary_filament_edit_key(key) &&
            before_printer_name == state().presets.printers.get_selected_preset_name() &&
            before_filament_name == state().presets.filaments.get_selected_preset_name() &&
            before_filament_names == state().presets.filament_presets;
        result["projection_kind"] = ordinary_edit ? "ordinary-edit" : "full";
        const json profile_snapshot = Profiles::preset_snapshot_json(!ordinary_edit);
        json filament_session = Filament::Session::filament_session_snapshot_json(!ordinary_edit);
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
        result["profile_snapshot"] = profile_snapshot;
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
        const auto editing_context = HistoryMetadata::parse_history_context(
            request.at("history_context").dump().c_str());
        // Reuse the toolhead transaction for editor diameter changes. Its
        // internal draft write calls mutate_draft_json directly, avoiding recursion.
        if (request.value("kind", "") == "printer" && request.value("action", "") == "set-element" &&
            request.value("key", "") == "nozzle_diameter" &&
            request.value("canonical_name", "") == state().presets.printers.get_selected_preset_name() &&
            request.value("scalar_type", "") == "float" && request.contains("index") && request.contains("value")) {
            const auto config = PresetDrafts::effective_printer_config();
            const auto* nozzles = config.opt<ConfigOptionFloats>("nozzle_diameter");
            if (nozzles && nozzles->size() > 1) {
                auto transition = Profiles::set_toolhead_diameter_json({{"index", request["index"]},
                    {"diameter", request["value"]}, {"expected_revision", request.value("expected_revision", json())},
                    {"history_context", editing_context}});
                if (!transition.value("ok", false) || transition.contains("canonical_name"))
                    return duplicate_json(transition.dump());
                auto result = PresetDrafts::get_draft_json(Preset::TYPE_PRINTER,
                    state().presets.printers.get_selected_preset_name());
                result["editor_candidates"] = json{{"kind", "replace"}, {"items", std::move(result["editor_candidates"])}};
                result["projection_kind"] = "full";
                for (const auto* key : {"profile_snapshot", "filament_session", "plate_session", "history_status", "native_scoped_config"})
                    result[key] = transition.at(key);
                // Preset-draft receipts publish both Filament revisions at
                // their committed project-history revision, as direct edits do.
                result["filament_session"]["revisions"]["project"] = state().history_revision;
                for (const auto* key : {"history_entry_delta", "revision_before", "revision_after", "dirty", "affected_plate_ids", "all_plate_results_invalidated"})
                    result[key] = transition.at("mutation").at(key);
                return duplicate_json(result.dump());
            }
        }
        return duplicate_json(PresetDrafts::mutate_draft_json(request).dump());
    } catch (const std::exception& error) {
        return duplicate_json(error_json(error.what()).dump());
    } catch (...) {
        return duplicate_json(error_json("unknown C++ exception").dump());
    }
}

} // extern "C"
