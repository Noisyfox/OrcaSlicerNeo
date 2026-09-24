// ----------------------------------------------------------------
// Native profile/config domain for the Neo bridge.
// ----------------------------------------------------------------
#include "bridge_profiles.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <cctype>
#include <set>
#include <string>
#include <vector>

#include <emscripten/emscripten.h>

#include "libslic3r/AppConfig.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/PresetBundle.hpp"
#include "libslic3r/Utils.hpp"

#include "bridge_filament.hpp"
#include "bridge_history.hpp"
#include "bridge_plate.hpp"
#include "bridge_prime_tower.hpp"
#include "bridge_preset_drafts.hpp"
#include "bridge_scoped_config.hpp"
#include "bridge_slicing_pipeline.hpp"

using namespace Slic3r;

namespace Slic3r::Neo::Bridge::Profiles {

namespace {

struct ProfileTransitionState {
    std::string printer;
    std::string print;
    std::string filament;
    std::vector<std::string> filament_presets;
    DynamicPrintConfig project_config;
    std::vector<std::vector<std::string>> ams_multi_colour_filment;
    Preset edited_printer;
    Preset edited_print;
    Preset edited_filament;
    std::uint64_t history_revision;
};

ProfileTransitionState capture_profile_transition_state()
{
    const auto& bundle = state().presets;
    return {bundle.printers.get_selected_preset_name(),
            bundle.prints.get_selected_preset_name(),
            bundle.filaments.get_selected_preset_name(),
            bundle.filament_presets,
            bundle.project_config,
            bundle.ams_multi_color_filment,
            bundle.printers.get_edited_preset(),
            bundle.prints.get_edited_preset(),
            bundle.filaments.get_edited_preset(),
            state().history_revision};
}

void restore_profile_transition_state(ProfileTransitionState&& before)
{
    auto& bundle = state().presets;
    if (!before.printer.empty()) bundle.printers.select_preset_by_name(before.printer, true);
    bundle.printers.get_edited_preset() = std::move(before.edited_printer);
    bundle.printers.update_dirty();
    bundle.update_compatible(PresetSelectCompatibleType::Always,
                             PresetSelectCompatibleType::Never);
    if (!before.print.empty()) bundle.prints.select_preset_by_name(before.print, true);
    bundle.prints.get_edited_preset() = std::move(before.edited_print);
    bundle.prints.update_dirty();
    bundle.update_compatible(PresetSelectCompatibleType::Never,
                             PresetSelectCompatibleType::Never);
    if (!before.filament.empty()) bundle.filaments.select_preset_by_name(before.filament, true);
    bundle.filament_presets = std::move(before.filament_presets);
    bundle.project_config = std::move(before.project_config);
    bundle.ams_multi_color_filment = std::move(before.ams_multi_colour_filment);
    bundle.filaments.get_edited_preset() = std::move(before.edited_filament);
    state().history_revision = before.history_revision;
}

void validate_profile_transition()
{
    auto& bundle = state().presets;
    if (bundle.filament_presets.empty())
        throw std::runtime_error("printer transition produced an empty filament rack");
    // Native compatibility may append a slot when a fixed multi-extruder
    // printer is selected, but that helper updates only the preset-name list.
    // Drive the canonical slot resizer at the final count so every project
    // slot array is aligned before flushing and session validation.
    bundle.set_num_filaments(static_cast<unsigned int>(bundle.filament_presets.size()));
    for (const auto& name : bundle.filament_presets)
        if (name.empty() || bundle.filaments.find_preset(name, false, true) == nullptr)
            throw std::runtime_error("printer transition produced an incompatible filament rack");
    Filament::Commands::recalculate_filament_flush(bundle);
    Filament::Commands::validate_filament_candidate(
        bundle, state().model, state().plate_session_plates,
        Neo::Bridge::ScopedConfig::native_scoped_config_snapshot(), true, true);
    // Printer changes are a silent lifecycle transition. Normalize the
    // project-owned arrays only after the native candidate is valid so the
    // returned projection and the next slice observe identical coordinates.
    PrimeTower::normalize_coordinate_positions();
    const auto snapshot = Filament::Session::filament_session_snapshot_json();
    if (!snapshot.value("ok", false))
        throw std::runtime_error(snapshot.value("error", "invalid filament rack after profile transition"));
}

bool valid_remembered_colour(const std::string& colour)
{
    if ((colour.size() != 7 && colour.size() != 9) || colour.front() != '#') return false;
    return std::all_of(colour.begin() + 1, colour.end(), [](const char value) {
        return std::isxdigit(static_cast<unsigned char>(value)) != 0;
    });
}

struct RememberedSlot {
    std::string preset;
    std::string colour;
    bool retain_colour = false;
};

class EffectivePrinterDraftGuard {
public:
    EffectivePrinterDraftGuard(PresetBundle& bundle, const std::string& canonical_name)
        : m_bundle(bundle), m_original(bundle.printers.get_edited_preset().config)
    {
        bundle.printers.get_edited_preset().config = PresetDrafts::effective_preset_config(
            bundle, state().preset_drafts, Preset::TYPE_PRINTER, canonical_name);
    }

    ~EffectivePrinterDraftGuard()
    {
        m_bundle.printers.get_edited_preset().config = std::move(m_original);
        m_bundle.printers.update_dirty();
    }

    EffectivePrinterDraftGuard(const EffectivePrinterDraftGuard&) = delete;
    EffectivePrinterDraftGuard& operator=(const EffectivePrinterDraftGuard&) = delete;

private:
    PresetBundle& m_bundle;
    DynamicPrintConfig m_original;
};

std::string effective_filament_default_colour(const PresetBundle& bundle,
                                              const std::string& canonical_name)
{
    const auto config = PresetDrafts::effective_preset_config(
        bundle, state().preset_drafts, Preset::TYPE_FILAMENT, canonical_name);
    if (const auto* colours = config.opt<ConfigOptionStrings>("default_filament_colour");
        colours != nullptr && !colours->values.empty() && !colours->values.front().empty())
        return colours->values.front();
    if (const auto* colours = config.opt<ConfigOptionStrings>("filament_colour");
        colours != nullptr && !colours->values.empty() && !colours->values.front().empty())
        return colours->values.front();
    return "#26A69A";
}

json transition_error(const std::string& code, const std::string& message)
{
    return json{{"ok", false}, {"version", 1}, {"error_code", code},
                {"error", message}, {"revision", state().history_revision}};
}

const char* dup_json(const std::string& value)
{
    char* out = static_cast<char*>(std::malloc(value.size() + 1));
    if (!out) std::abort();
    std::memcpy(out, value.data(), value.size());
    out[value.size()] = '\0';
    return out;
}

const char* make_error_json(const std::string& message)
{
    return dup_json(json{{"error", message}}.dump());
}

std::string option_type_name(const ConfigOptionDef& def)
{
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

json option_def_to_json(const ConfigOptionDef& def)
{
    json result;
    result["type"] = option_type_name(def);
    if (!def.label.empty()) result["label"] = def.label;
    if (!def.full_label.empty()) result["full_label"] = def.full_label;
    if (!def.tooltip.empty()) result["tooltip"] = def.tooltip;
    if (!def.category.empty()) result["category"] = def.category;
    result["mode"] = int(def.mode);
    if (!def.enum_values.empty()) result["enum_values"] = def.enum_values;
    if (!def.enum_labels.empty()) result["enum_labels"] = def.enum_labels;
    if (def.min != 0.0 || def.max != 0.0) {
        result["min"] = def.min;
        result["max"] = def.max;
    }
    if (def.default_value) result["default"] = def.default_value->serialize();
    return result;
}

// The profile config is populated through public AppConfig setters because
// AppConfig::load() requires a file-backed loading path. The renderer remains
// the owner of this JSON and persists it through the existing client contract.
void install_all_filaments()
{
    AppConfig& app_config = state().profile_config;
    for (const Preset& preset : state().presets.filaments)
        if (preset.is_system)
            app_config.set(AppConfig::SECTION_FILAMENTS, preset.name, "true");
}

void install_all_printers()
{
    AppConfig& app_config = state().profile_config;
    for (const Preset& preset : state().presets.printers) {
        if (preset.vendor == nullptr) continue;
        const std::string model = preset.config.opt_string("printer_model");
        const std::string variant = preset.config.opt_string("printer_variant");
        if (model.empty() || variant.empty()) continue;
        app_config.set_variant(preset.vendor->id, model, variant, true);
    }
    install_all_filaments();
    state().presets.load_selections(app_config);
}

void reselect_after_app_config()
{
    const std::string initial = state().profile_config.get("presets", PRESET_PRINTER_NAME);
    bool selected = !initial.empty() &&
                    state().presets.printers.select_preset_by_name(initial, true);
    if (!selected) {
        size_t selected_index = 0;
        for (auto it = state().presets.printers.lbegin();
             it != state().presets.printers.end(); ++it, ++selected_index) {
            if (it->is_default) continue;
            state().presets.printers.select_preset(selected_index);
            break;
        }
    }
    state().presets.update_compatible(PresetSelectCompatibleType::Always);
    state().presets.update_multi_material_filament_presets();
}

void reset_app_config()
{
    AppConfig& app_config = state().profile_config;
    app_config.set_vendors({});
    app_config.clear_section("presets");
    app_config.clear_section("filaments");
}

json preset_entry_json(const Preset& preset, const PresetCollection& collection,
                       bool include_selection = true)
{
    json entry{{"name", preset.name},
               {"is_visible", preset.is_visible},
               {"is_default", preset.is_default}};
    if (include_selection)
        entry["selected"] = preset.name == collection.get_selected_preset_name();
    entry["vendor_id"] = preset.vendor ? preset.vendor->id : "";
    entry["model"] = preset.config.opt_string("printer_model");
    entry["variant"] = preset.config.opt_string("printer_variant");
    return entry;
}

json preset_candidates_json(const PresetCollection& collection, bool require_compatible,
                            bool include_selection = true)
{
    json candidates = json::array();
    for (auto it = collection.begin(); it != collection.end(); ++it) {
        if (!it->is_visible || (require_compatible && !it->is_compatible)) continue;
        candidates.push_back(preset_entry_json(*it, collection, include_selection));
    }
    return candidates;
}

json preset_selection_json(const PresetCollection& collection)
{
    return json{{"name", collection.get_selected_preset_name()},
                {"idx", collection.get_selected_idx()}};
}

json selected_printer_printable_area_json()
{
    json points = json::array();
    const Preset& printer = state().presets.printers.get_selected_preset();
    const ConfigOptionPoints* area = printer.config.opt<ConfigOptionPoints>("printable_area");
    if (area == nullptr || area->values.size() < 3) return points;
    for (const Vec2d& point : area->values) {
        if (!std::isfinite(point.x()) || !std::isfinite(point.y())) return json::array();
        points.push_back({point.x(), point.y()});
    }
    return points;
}

} // namespace

const char* duplicate_json(const std::string& value)
{
    return dup_json(value);
}

const char* error_json(const std::string& message)
{
    return make_error_json(message);
}

const json& option_metadata_json()
{
    // PrintConfig definitions are immutable within one loaded module.
    static const json metadata = [] {
        const auto& defs = print_config_def.options;
        // Keep scope eligibility in the native PrintConfig class slices.  The
        // renderer derives its catalogue from this metadata; it must not guess
        // which arbitrary FFF keys happen to deserialize on a target.
        const PrintConfig project_config;
        const PrintObjectConfig object_config;
        const PrintRegionConfig region_config;
        json output = json::object();
        for (const auto& [key, def] : defs) {
            json entry = option_def_to_json(def);
            json scopes = json::array();
            const bool project = project_config.option(key) != nullptr;
            const bool object = object_config.option(key) != nullptr || region_config.option(key) != nullptr;
            const bool part = region_config.option(key) != nullptr;
            // Native filament-routing slots stay in project_config so standard
            // slicing/history can round-trip them, but their typed commands are
            // the only mutation authority; never advertise them as generic
            // Project/Scoped catalogue entries.
            const bool generic_scoped_key = !ScopedConfig::is_bridge_owned_project_routing_key(key);
            if (generic_scoped_key && project) scopes.push_back("project");
            if (generic_scoped_key && project && ScopedConfig::is_editable_plate_override_key(key))
                scopes.push_back("plate");
            if (generic_scoped_key && object) scopes.push_back("object");
            if (generic_scoped_key && part) scopes.push_back("part");
            entry["scopes"] = std::move(scopes);
            output[key] = std::move(entry);
        }
        return output;
    }();
    return metadata;
}

json preset_snapshot_json()
{
    return json{{"ok", true},
                {"printers", preset_candidates_json(state().presets.printers, false)},
                {"prints", preset_candidates_json(state().presets.prints, true)},
                {"filament_catalog", preset_candidates_json(state().presets.filaments, true, false)},
                {"printer", preset_selection_json(state().presets.printers)},
                {"print", preset_selection_json(state().presets.prints)},
                {"printable_area", selected_printer_printable_area_json()},
                // Embedded project settings and the selected Process preset
                // are both part of the native effective configuration.  Use
                // that slicing starts from so the UI cannot fall back to
                // metadata defaults that disagree with slicing.
                {"project_config", Filament::State::config_metadata_json(PresetDrafts::effective_full_config())}};
}

json select_printer_with_remembered_rack_json(const json& request)
{
    if (!request.is_object() || request.value("version", 0) != 1 ||
        !request.contains("printer") || !request["printer"].is_string() ||
        request["printer"].get<std::string>().empty())
        return transition_error("invalid_request", "Printer transition request is invalid");
    if (state().active_history_transaction)
        return transition_error("history_transaction_active", "Printer transition cannot run inside another history transaction");
    if (state().history_disabled)
        return transition_error("history_disabled", "project history is disabled");

    const std::string printer_name = request["printer"].get<std::string>();
    const Preset* target = state().presets.printers.find_preset(printer_name, false, true);
    if (target == nullptr) return transition_error("preset_not_found", "Printer preset not found: " + printer_name);
    if (!target->is_visible) return transition_error("preset_not_visible", "Printer preset is not visible: " + printer_name);
    if (target->name != printer_name)
        return transition_error("invalid_request", "Printer name must be canonical");

    std::optional<std::vector<RememberedSlot>> remembered_slots;
    if (request.contains("remembered_rack") && !request["remembered_rack"].is_null()) {
        const auto& rack = request["remembered_rack"];
        if (!rack.is_object() || rack.value("version", 0) != 1 ||
            !rack.contains("slots") || !rack["slots"].is_array() ||
            rack["slots"].empty() || rack["slots"].size() > 64)
            return transition_error("invalid_request", "remembered filament rack is invalid");
        std::vector<RememberedSlot> slots;
        slots.reserve(rack["slots"].size());
        for (const auto& slot : rack["slots"]) {
            if (!slot.is_object() || !slot.contains("preset") || !slot["preset"].is_string() ||
                slot["preset"].get<std::string>().empty() || !slot.contains("colour") ||
                !slot["colour"].is_string() || !valid_remembered_colour(slot["colour"].get<std::string>()))
                return transition_error("invalid_request", "remembered filament slot is invalid");
            const std::string name = slot["preset"].get<std::string>();
            if (Preset::remove_suffix_modified(name) != name)
                return transition_error("invalid_request", "remembered filament preset name must be canonical");
            slots.push_back({name, slot["colour"].get<std::string>(), true});
        }
        remembered_slots = std::move(slots);
    }

    auto& bridge = state();
    auto& bundle = bridge.presets;
    const std::uint64_t revision_before = bridge.history_revision;
    const auto before_profiles = capture_profile_transition_state();
    Model before_model = bridge.model;
    const auto before_plates = bridge.plate_session_plates;
    const auto before_plate_revisions = bridge.plate_input_revisions;
    const auto before_membership = bridge.instance_plate_ids;
    const auto before_out_of_bounds = bridge.plate_out_of_bounds_ids;
    const auto before_parked = bridge.parked_instance_ids;
    const auto before_pending = bridge.pending_membership_instance_ids;
    const auto before_current_plate = bridge.current_plate_id;
    const auto before_lifecycle = bridge.plate_runtime_registry.capture_lifecycle();
    const auto before_live_context = bridge.history_live_context;
    const auto before_history_context = HistoryMetadata::default_history_context(
        bridge, PlateSession::plate_session_snapshot_json(),
        Filament::State::history_state_json(bundle));

    bool history_started = false;
    bool mutated = false;
    bool history_committed = false;
    const auto rollback = [&]() {
        if (history_committed) return;
        if (history_started) {
            HistoryMetadata::abort_timestamped_operation(bridge);
            history_started = false;
        }
        if (!mutated) return;
        restore_profile_transition_state(ProfileTransitionState(before_profiles));
        bridge.model = std::move(before_model);
        bridge.mutable_object_capture_cache.clear();
        bridge.plate_session_plates = before_plates;
        bridge.plate_input_revisions = before_plate_revisions;
        bridge.instance_plate_ids = before_membership;
        bridge.plate_out_of_bounds_ids = before_out_of_bounds;
        bridge.parked_instance_ids = before_parked;
        bridge.pending_membership_instance_ids = before_pending;
        bridge.current_plate_id = before_current_plate;
        bridge.plate_runtime_registry.restore_lifecycle(before_lifecycle);
        bridge.history_live_context = before_live_context;
        PrimeTower::invalidate_projection_cache();
    };

    if (!HistoryMetadata::begin_timestamped_operation(bridge, "Select Printer", before_history_context))
        return transition_error("history_capture_failed", "could not capture Printer transition history predecessor");
    history_started = true;

    try {
        mutated = true;
        if (!bundle.printers.select_preset_by_name(printer_name, true))
            throw std::runtime_error("could not select Printer preset: " + printer_name);

        json filament_snapshot;
        json profile_snapshot;
        json plate_session;
        json after_context;
        {
            // Every profile lookup/compatibility calculation in this native
            // transaction sees the selected Printer's shared project draft.
            EffectivePrinterDraftGuard effective_printer(bundle, printer_name);
            bundle.update_compatible(PresetSelectCompatibleType::Always,
                                     PresetSelectCompatibleType::Never);

            if (bundle.printers.get_edited_preset().printer_technology() == ptFFF) {
                const auto* current_colours = bundle.project_config.opt<ConfigOptionStrings>("filament_colour");
                std::vector<RememberedSlot> slots;
                if (remembered_slots.has_value()) {
                    slots = *remembered_slots;
                } else {
                    slots.reserve(bundle.filament_presets.size());
                    for (std::size_t index = 0; index < bundle.filament_presets.size(); ++index) {
                        const std::string colour = current_colours != nullptr && index < current_colours->values.size()
                            ? current_colours->values[index]
                            : effective_filament_default_colour(bundle, bundle.filament_presets[index]);
                        slots.push_back({bundle.filament_presets[index], colour, true});
                    }
                }
                if (slots.empty()) throw std::runtime_error("Printer transition has no filament slots");

                const auto* nozzles = bundle.printers.get_edited_preset().config.opt<ConfigOptionFloats>("nozzle_diameter");
                const std::size_t nozzle_count = nozzles == nullptr ? 1 : std::max<std::size_t>(1, nozzles->values.size());
                const std::size_t final_count = std::max(slots.size(), nozzle_count);
                if (final_count > 64) throw std::runtime_error("Printer transition exceeds the filament slot limit");

                // Resize while the old rack still contains valid catalog
                // names; set_num_filaments invokes Orca's native rack sizing.
                bundle.set_num_filaments(static_cast<unsigned int>(final_count));
                while (slots.size() < final_count) {
                    const std::size_t index = slots.size();
                    const std::string name = index < bundle.filament_presets.size()
                        ? bundle.filament_presets[index]
                        : bundle.filament_presets.back();
                    slots.push_back({name, {}, false});
                }
                for (std::size_t index = 0; index < slots.size(); ++index)
                    bundle.filament_presets[index] = slots[index].preset;

                if (!slots.front().preset.empty() &&
                    bundle.filaments.find_preset(slots.front().preset, false, true) != nullptr)
                    bundle.filaments.select_preset_by_name(slots.front().preset, true);
                bundle.update_compatible(PresetSelectCompatibleType::Never,
                                         PresetSelectCompatibleType::Always);
                bundle.update_multi_material_filament_presets();

                auto* colours = bundle.project_config.option<ConfigOptionStrings>("filament_colour", true);
                auto* multi_colours = bundle.project_config.option<ConfigOptionStrings>("filament_multi_colour", true);
                colours->values.resize(bundle.filament_presets.size(), "#26A69A");
                multi_colours->values.resize(bundle.filament_presets.size(), "#26A69A");
                for (std::size_t index = 0; index < bundle.filament_presets.size(); ++index) {
                    const bool same_source = index < slots.size() &&
                        slots[index].preset == bundle.filament_presets[index];
                    const std::string colour = same_source && slots[index].retain_colour
                        ? slots[index].colour
                        : effective_filament_default_colour(bundle, bundle.filament_presets[index]);
                    colours->values[index] = colour;
                    multi_colours->values[index] = colour;
                }
            }

            validate_profile_transition();
            plate_session = PlateSession::shared_configuration_mutation_snapshot();
            profile_snapshot = preset_snapshot_json();
            filament_snapshot = Filament::Session::filament_session_snapshot_json();
            if (!filament_snapshot.value("ok", false))
                throw std::runtime_error(filament_snapshot.value("error", "invalid filament rack after Printer transition"));
            after_context = HistoryMetadata::default_history_context(
                bridge, plate_session, Filament::State::history_state_json(bundle));
        }

        if (!HistoryMetadata::commit_timestamped_operation(bridge, after_context)) {
            rollback();
            return transition_error("history_commit_failed", "history rejected Printer transition");
        }
        history_committed = true;
        history_started = false;
        SlicingPipeline::invalidate_preview_source();

        filament_snapshot["revisions"]["session"] = bridge.history_revision;
        const auto native_scoped_config = ScopedConfig::native_scoped_config_full_transport(bridge.history_revision);
        const auto history_status = HistoryMetadata::history_status_json(bridge);
        const json receipt{{"kind", "select-printer-with-remembered-rack"},
                           {"history_entry_delta", 1},
                           {"revision_before", revision_before},
                           {"revision_after", bridge.history_revision},
                           {"dirty", history_status.value("dirty", false)},
                           {"all_plate_results_invalidated", true},
                           {"affected_plate_ids", plate_session.value("affected_plate_ids", json::array())}};
        return json{{"ok", true}, {"version", 1},
                    {"profile_snapshot", std::move(profile_snapshot)},
                    {"filament_session", std::move(filament_snapshot)},
                    {"plate_session", std::move(plate_session)},
                    {"history_status", history_status},
                    {"native_scoped_config", native_scoped_config},
                    {"mutation", receipt}};
    } catch (const std::exception& error) {
        rollback();
        return transition_error("native_validation_failure", error.what());
    } catch (...) {
        rollback();
        return transition_error("native_validation_failure", "unknown Printer transition failure");
    }
}

const char* init_profiles()
{
    reset_app_config();
    set_data_dir("/");
    set_resources_dir("/");
    state().presets.setup_directories();
    state().presets.load_presets(state().profile_config, ForwardCompatibilitySubstitutionRule::Enable);
    install_all_printers();
    reselect_after_app_config();
    return dup_json(json{{"ok", true},
                         {"prints", state().presets.prints.size()},
                         {"filaments", state().presets.filaments.size()},
                         {"printers", state().presets.printers.size()}}.dump());
}

} // namespace Slic3r::Neo::Bridge::Profiles

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_get_preset_snapshot()
{
    try {
        return Slic3r::Neo::Bridge::Profiles::duplicate_json(
            Slic3r::Neo::Bridge::Profiles::preset_snapshot_json().dump());
    } catch (const std::exception& e) {
        return Slic3r::Neo::Bridge::Profiles::error_json(e.what());
    } catch (...) {
        return Slic3r::Neo::Bridge::Profiles::error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_select_preset(const char* kind_cstr, const char* name_cstr)
{
    using namespace Slic3r::Neo::Bridge;
    try {
        const std::string kind = kind_cstr ? kind_cstr : "";
        const std::string name = name_cstr ? name_cstr : "";
        if (name.empty()) return Profiles::error_json("preset name required");
        PresetCollection* collection = nullptr;
        if (kind == "print") collection = &state().presets.prints;
        else if (kind == "printer") collection = &state().presets.printers;
        else return Profiles::error_json("kind must be print|printer");
        Preset* requested = collection->find_preset(name);
        if (requested == nullptr) return Profiles::error_json("preset not found: " + name);
        if (!requested->is_visible) return Profiles::error_json("preset is not visible: " + name);
        if (kind != "printer" && !requested->is_compatible)
            return Profiles::error_json("preset is incompatible: " + name);
        auto before = Profiles::capture_profile_transition_state();
        try {
            if (!collection->select_preset_by_name(name, true))
                throw std::runtime_error("could not select preset: " + name);
            if (kind == "printer") {
                state().presets.update_compatible(PresetSelectCompatibleType::Always);
                state().presets.update_multi_material_filament_presets();
            } else if (kind == "print") {
                state().presets.update_compatible(PresetSelectCompatibleType::Never,
                                                   PresetSelectCompatibleType::Always);
                state().presets.update_multi_material_filament_presets();
            }
            Profiles::validate_profile_transition();
            const auto response = Profiles::preset_snapshot_json().dump();
            HistoryMetadata::advance_history_epoch(state());
            return Profiles::duplicate_json(response);
        } catch (...) {
            Profiles::restore_profile_transition_state(std::move(before));
            throw;
        }
    } catch (const std::exception& e) {
        return Profiles::error_json(e.what());
    } catch (...) {
        return Profiles::error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_select_printer_with_remembered_rack(const char* request_cstr)
{
    try {
        const auto request = request_cstr && *request_cstr
            ? Slic3r::Neo::Bridge::Profiles::json::parse(request_cstr)
            : Slic3r::Neo::Bridge::Profiles::json::object();
        return Slic3r::Neo::Bridge::Profiles::duplicate_json(
            Slic3r::Neo::Bridge::Profiles::select_printer_with_remembered_rack_json(request).dump());
    } catch (const std::exception& error) {
        return Slic3r::Neo::Bridge::Profiles::error_json(error.what());
    } catch (...) {
        return Slic3r::Neo::Bridge::Profiles::error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_option_metadata()
{
    try {
        return Slic3r::Neo::Bridge::Profiles::duplicate_json(
            Slic3r::Neo::Bridge::Profiles::option_metadata_json().dump());
    } catch (const std::exception& e) {
        return Slic3r::Neo::Bridge::Profiles::error_json(e.what());
    } catch (...) {
        return Slic3r::Neo::Bridge::Profiles::error_json("unknown C++ exception");
    }
}

} // extern "C"
