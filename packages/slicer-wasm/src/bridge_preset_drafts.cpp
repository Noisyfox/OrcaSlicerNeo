// ----------------------------------------------------------------
// Printer / Filament preset drafts and effective configuration assembly.
// ----------------------------------------------------------------
#include "bridge_preset_drafts.hpp"

#include <cstdlib>
#include <cstring>
#include <stdexcept>

#include <emscripten/emscripten.h>

#include "bridge_state.hpp"
#include "bridge_filament.hpp"
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
    return json{{"ok", false}, {"version", 1},
                {"error_code", "native_validation_failure"}, {"error", message}};
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

namespace PresetDrafts {

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

DynamicPrintConfig effective_full_config_secure(
    std::optional<std::vector<int>> filament_maps)
{
    return effective_full_config_secure(state().presets, state().preset_drafts,
                                        std::move(filament_maps));
}

json get_draft_json(const Preset::Type type, const std::string& canonical_name)
{
    const Preset* source = find_preset_source(state().presets, type, canonical_name);
    if (source == nullptr)
        return json{{"ok", false}, {"version", 1}, {"error_code", "preset_not_found"},
                    {"error", "preset not found: " + canonical_name}};

    Preset effective = *source;
    apply_draft(effective, state().preset_drafts);
    const auto* overrides = state().preset_drafts.find(type, canonical_name);
    const json override_values = overrides == nullptr ? json::object() : json(*overrides);
    return json{{"ok", true}, {"version", 1}, {"kind", kind_name(type)},
                {"canonical_name", source->name},
                {"draft_exists", overrides != nullptr},
                {"modified", overrides != nullptr && !overrides->empty()},
                {"overrides", override_values},
                {"source_values", config_values_json(source->config)},
                {"effective_values", config_values_json(effective.config)}};
}

json set_draft_option_json(const json& request)
{
    if (!request.is_object() || request.value("version", 0) != 1)
        return error_json("invalid preset draft request");
    const Preset::Type type = parse_kind(request.value("kind", std::string{}));
    const std::string canonical_name = request.value("canonical_name", std::string{});
    const std::string key = request.value("key", std::string{});
    if (canonical_name.empty() || key.empty() || !request.contains("value") ||
        !request["value"].is_string())
        return error_json("canonical_name, key, and serialized value are required");

    const Preset* source = find_preset_source(state().presets, type, canonical_name);
    if (source == nullptr)
        return json{{"ok", false}, {"version", 1}, {"error_code", "preset_not_found"},
                    {"error", "preset not found: " + canonical_name}};
    if (print_config_def.get(key) == nullptr)
        return json{{"ok", false}, {"version", 1}, {"error_code", "unsupported_option"},
                    {"error", "unknown preset option: " + key}};

    // Deserialize into a temporary source copy first. Invalid values never
    // create a draft entry and never reach a PresetCollection instance.
    Preset candidate = *source;
    ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
    candidate.config.set_deserialize(key, request["value"].get<std::string>(), substitutions);
    const ConfigOption* accepted = candidate.config.option(key);
    if (accepted == nullptr)
        return json{{"ok", false}, {"version", 1}, {"error_code", "unsupported_option"},
                    {"error", "option is not available on this preset: " + key}};

    const bool had_draft = state().preset_drafts.contains(type, canonical_name);
    std::optional<std::string> previous_value;
    if (const auto* previous = state().preset_drafts.find(type, canonical_name)) {
        const auto previous_field = previous->find(key);
        if (previous_field != previous->end()) previous_value = previous_field->second;
    }

    auto& bundle = state().presets;
    auto* flush_matrix = bundle.project_config.opt<ConfigOptionFloats>("flush_volumes_matrix");
    const std::vector<double> previous_flush_matrix =
        flush_matrix == nullptr ? std::vector<double>{} : flush_matrix->values;
    state().preset_drafts.set(type, canonical_name, key, accepted->serialize());
    try {
        // Material drafts feed the native minimum-flush calculation. Rebuild
        // the project-owned matrix immediately so the next Slice/Prepare read
        // cannot combine edited material values with a stale matrix.
        if (type == Preset::TYPE_FILAMENT &&
            bundle.printers.get_selected_preset().printer_technology() == ptFFF)
            Filament::Commands::recalculate_filament_flush(bundle);
    } catch (...) {
        if (previous_value.has_value()) {
            state().preset_drafts.set(type, canonical_name, key, *previous_value);
        } else {
            state().preset_drafts.erase_field(type, canonical_name, key);
            if (!had_draft) state().preset_drafts.erase_preset(type, canonical_name);
        }
        if (flush_matrix != nullptr) flush_matrix->values = previous_flush_matrix;
        throw;
    }
    SlicingPipeline::invalidate_preview_result_only();
    return get_draft_json(type, canonical_name);
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
            return duplicate_json(json{{"ok", false}, {"version", 1},
                                       {"error_code", "invalid_request"},
                                       {"error", "kind must be printer|filament"}}.dump());
        const std::string canonical_name = canonical_name_cstr ? canonical_name_cstr : "";
        if (canonical_name.empty())
            return duplicate_json(json{{"ok", false}, {"version", 1},
                                       {"error_code", "invalid_request"},
                                       {"error", "canonical preset name required"}}.dump());
        return duplicate_json(PresetDrafts::get_draft_json(type, canonical_name).dump());
    } catch (const std::exception& error) {
        return duplicate_json(error_json(error.what()).dump());
    } catch (...) {
        return duplicate_json(error_json("unknown C++ exception").dump());
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_preset_draft_option(const char* request_cstr)
{
    using namespace Slic3r::Neo::Bridge;
    try {
        const json request = request_cstr && *request_cstr ? json::parse(request_cstr) : json::object();
        return duplicate_json(PresetDrafts::set_draft_option_json(request).dump());
    } catch (const std::exception& error) {
        return duplicate_json(error_json(error.what()).dump());
    } catch (...) {
        return duplicate_json(error_json("unknown C++ exception").dump());
    }
}

} // extern "C"
