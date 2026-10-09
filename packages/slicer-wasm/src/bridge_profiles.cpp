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
#include <optional>
#include <memory>
#include <tuple>
#include <boost/filesystem.hpp>
#include <map>
#include <sstream>
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
    std::vector<std::string> filament_slot_ids;
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
            state().filament_slot_ids,
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
    state().filament_slot_ids = std::move(before.filament_slot_ids);
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
    Filament::State::resize_slots_preserving_colours(
        bundle, static_cast<unsigned int>(bundle.filament_presets.size()));
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
    std::optional<std::string> multi_colour;
    std::optional<std::string> colour_type;
};

void retain_matching_native_colour(RememberedSlot& slot, const ProfileTransitionState& previous,
                                   std::size_t index)
{
    if (index >= previous.filament_presets.size() ||
        slot.preset != previous.filament_presets[index]) return;
    const auto* representatives = previous.project_config.opt<ConfigOptionStrings>("filament_colour");
    if (representatives == nullptr || index >= representatives->values.size() ||
        slot.colour != representatives->values[index]) return;
    if (const auto* multi = previous.project_config.opt<ConfigOptionStrings>("filament_multi_colour");
        multi != nullptr && index < multi->values.size())
        slot.multi_colour = multi->values[index];
    if (const auto* types = previous.project_config.opt<ConfigOptionStrings>("filament_colour_type");
        types != nullptr && index < types->values.size())
        slot.colour_type = types->values[index];
}

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
    return json{{"ok", false}, {"error_code", code},
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
        case coFloatsOrPercents: return "floats_or_percents";
        case coEnums:            return "enums";
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
    if (!def.sidetext.empty()) result["sidetext"] = def.sidetext;
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

// Activation is global availability; source identities remain in AppConfig even
// when the installed vendor set does not contain them.
void configure_activation(AppConfig& config, const json& activation)
{
    if (activation.is_null()) return;
    if (!activation.is_object() || activation.size() != 2 ||
        !activation.contains("models") || !activation.at("models").is_array() ||
        !activation.contains("filaments") || !activation.at("filaments").is_array())
        throw std::runtime_error("invalid profile activation");
    auto name = [](const json& value) {
        return value.is_string() && value.get<std::string>().find_first_not_of(" \t\r\n\f\v") != std::string::npos;
    };
    for (const auto& model : activation.at("models")) {
        if (!model.is_object() || model.size() != 3 || !model.contains("vendor") ||
            !name(model.at("vendor")) || !model.contains("model") || !name(model.at("model")) ||
            !model.contains("nozzle_diameter") || !model.at("nozzle_diameter").is_array() ||
            model.at("nozzle_diameter").empty()) throw std::runtime_error("invalid model activation");
        const auto vendor = model.at("vendor").get<std::string>();
        if (vendor == "." || vendor == ".." || std::any_of(vendor.begin(), vendor.end(),
            [](unsigned char ch) { return ch == '/' || ch == '\\' || ch == ':' || ch < 32 || ch == 127; }))
            throw std::runtime_error("unsafe activation vendor");
        for (const auto& nozzle : model.at("nozzle_diameter"))
            if (!name(nozzle)) throw std::runtime_error("invalid nozzle activation");
    }
    for (const auto& filament : activation.at("filaments"))
        if (!name(filament)) throw std::runtime_error("invalid filament activation");
    for (const auto& model : activation.at("models"))
        for (const auto& nozzle : model.at("nozzle_diameter"))
            config.set_variant(model.at("vendor").get<std::string>(),
                model.at("model").get<std::string>(), nozzle.get<std::string>(), true);
    for (const auto& filament : activation.at("filaments"))
        config.set(AppConfig::SECTION_FILAMENTS, filament.get<std::string>(), "true");
}

void reselect_after_app_config(PresetBundle& bundle, AppConfig& config)
{
    const std::string initial = config.get("presets", PRESET_PRINTER_NAME);
    bool selected = !initial.empty() &&
                    bundle.printers.select_preset_by_name(initial, true);
    if (!selected) {
        size_t selected_index = 0;
        for (auto it = bundle.printers.lbegin();
             it != bundle.printers.end(); ++it, ++selected_index) {
            if (it->is_default || !it->is_visible) continue;
            bundle.printers.select_preset(selected_index);
            break;
        }
    }
    bundle.update_compatible(PresetSelectCompatibleType::Always);
    bundle.update_multi_material_filament_presets();
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
               {"label", preset.label(false)},
               {"vendor", preset.type == Preset::TYPE_FILAMENT ? preset.config.opt_string("filament_vendor", 0) : ""},
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
    if (collection.type() == Preset::TYPE_FILAMENT) {
        static const std::vector<std::string> vendors{"", "Generic"};
        static const std::vector<std::string> types{"PLA", "PETG", "ABS", "TPU"};
        auto rank = [](const auto& values, const std::string& value) {
            return std::distance(values.begin(), std::find(values.begin(), values.end(), value));
        };
        std::sort(candidates.begin(), candidates.end(), [&](const json& a, const json& b) {
            const auto vendor_a = rank(vendors, a["vendor"]), vendor_b = rank(vendors, b["vendor"]);
            if (vendor_a != vendor_b) return vendor_a < vendor_b;
            const Preset* preset_a = collection.find_preset(a["name"].get<std::string>(), false);
            const Preset* preset_b = collection.find_preset(b["name"].get<std::string>(), false);
            const auto type_a = rank(types, preset_a->config.opt_string("filament_type", 0));
            const auto type_b = rank(types, preset_b->config.opt_string("filament_type", 0));
            if (type_a != type_b) return type_a < type_b;
            return a["name"].get<std::string>() < b["name"].get<std::string>();
        });
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

struct PrinterBedResources {
    std::string model;
    std::string texture;
};

PrinterBedResources selected_printer_bed_resources()
{
    auto& bundle = state().presets;
    const Preset& printer = bundle.printers.get_selected_preset();
    PrinterBedResources resources;
    if (printer.is_system) {
        resources.model = PresetUtils::system_printer_bed_model(printer);
        resources.texture = PresetUtils::system_printer_bed_texture(printer);
    } else if (const auto* model = printer.config.opt<ConfigOptionString>("printer_model");
               model != nullptr && !model->value.empty()) {
        resources.model = bundle.get_stl_model_for_printer_model(model->value);
        resources.texture = bundle.get_texture_for_printer_model(model->value);
    }
    // Native lookup already preserves installed /vendor priority. Its bundled
    // fallback assumes resources/profiles; Neo mounts that tree at /system.
    auto adapt_bundled_path = [](std::string& path) {
        const auto bundled = path.find("/profiles/");
        if (bundled != std::string::npos)
            path = "/system/" + path.substr(bundled + std::strlen("/profiles/"));
    };
    adapt_bundled_path(resources.model);
    adapt_bundled_path(resources.texture);
    return resources;
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
        // Project eligibility follows the native mutation ownership boundary:
        // the edited Print preset includes global object/region defaults too.
        // Object/part eligibility still follows the native class slices.
        const PrintObjectConfig object_config;
        const PrintRegionConfig region_config;
        json output = json::object();
        for (const auto& [key, def] : defs) {
            json entry = option_def_to_json(def);
            json scopes = json::array();
            const bool project = ScopedConfig::is_native_project_config_key(key) ||
                ScopedConfig::is_project_print_override_key(key);
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

BedTypeCapabilities selected_printer_bed_type_capabilities()
{
    auto& bundle = state().presets;
    // Copy the source so defaults/model identity use the effective draft
    // without temporarily mutating the collection or its dirty state.
    Preset printer = bundle.printers.get_selected_preset();
    printer.config = PresetDrafts::effective_preset_config(
        bundle, state().preset_drafts, Preset::TYPE_PRINTER, printer.name);
    const auto* multi = printer.config.opt<ConfigOptionBool>("support_multi_bed_types");
    BedTypeCapabilities capabilities{
        bundle.is_bbl_vendor() || (multi != nullptr && multi->value),
        printer.get_default_bed_type(&bundle), {}};
    const auto* model = PresetUtils::system_printer_model(printer);
    if (model == nullptr) {
        if (const auto* parent = bundle.printers.get_selected_preset_parent())
            model = PresetUtils::system_printer_model(*parent);
    }
    const auto* definition = print_config_def.get("curr_bed_type");
    if (definition == nullptr || definition->enum_keys_map == nullptr)
        throw std::runtime_error("native bed type definition is unavailable");
    for (size_t index = 0; index < definition->enum_values.size(); ++index) {
        const auto& value = definition->enum_values[index];
        const auto& label = definition->enum_labels.at(index);
        if (model != nullptr && std::find(model->not_support_bed_types.begin(),
                model->not_support_bed_types.end(), label) != model->not_support_bed_types.end())
            continue;
        capabilities.choices.push_back({
            BedType(definition->enum_keys_map->at(value)), value, label});
    }
    return capabilities;
}

bool bed_type_allowed(const BedTypeCapabilities& capabilities, BedType type, bool local)
{
    if (!capabilities.supports_selection)
        return !local && type == capabilities.default_type;
    return std::any_of(capabilities.choices.begin(), capabilities.choices.end(),
        [type](const BedTypeChoice& choice) { return choice.type == type; });
}

BedType supported_default_bed_type(const BedTypeCapabilities& capabilities)
{
    if (!capabilities.supports_selection || bed_type_allowed(capabilities, capabilities.default_type, false))
        return capabilities.default_type;
    if (capabilities.choices.empty()) throw std::runtime_error("printer supports no selectable bed type");
    return capabilities.choices.front().type;
}

std::set<std::string> normalize_bed_types(bool reset_global)
{
    const auto capabilities = selected_printer_bed_type_capabilities();
    auto& project = state().presets.project_config;
    const auto* global = project.option("curr_bed_type");
    if (reset_global || global == nullptr || !bed_type_allowed(capabilities, BedType(global->getInt()), false)) {
        project.set_key_value("curr_bed_type", new ConfigOptionEnum<BedType>(supported_default_bed_type(capabilities)));
    }
    std::set<std::string> removed;
    for (auto& plate : state().plate_session_plates) {
        const auto* local = plate.settings.option("curr_bed_type");
        // Dynamic configs deserialize into ConfigOptionEnumGeneric whereas
        // native typed defaults use ConfigOptionEnum<BedType>. getInt handles
        // both, as PartPlate::get_bed_type does through opt_enum.
        if (local == nullptr || bed_type_allowed(capabilities, BedType(local->getInt()), true)) continue;
        plate.settings.erase("curr_bed_type");
        plate.settings_metadata = Filament::State::config_metadata_json(plate.settings);
        removed.insert(plate.id);
    }
    return removed;
}

// Presentation identities are separate from canonical profile names. Restrict
// Orca's resolver to the admitted vendor/model candidates; its global fallback
// may otherwise return an invisible profile or a same-name model from a vendor.
json printer_picker_json(const DynamicPrintConfig& effective)
{
    auto& bundle = state().presets;
    const auto& selected = bundle.printers.get_selected_preset();
    struct Group {
        std::string id;
        std::string label;
        bool model_group;
        std::vector<const Preset*> presets;
    };
    std::vector<Group> groups;
    std::map<std::string, size_t> indices;
    std::string selected_id;
    for (const auto& preset : bundle.printers) {
        if (!preset.is_visible) continue;
        const std::string model = preset.config.opt_string("printer_model");
        const bool grouped = preset.is_system && !preset.is_project_embedded && !model.empty();
        const std::string id = grouped
            ? json::array({"model", preset.vendor ? preset.vendor->id : "", model}).dump()
            : json::array({"preset", preset.name}).dump();
        auto [it, inserted] = indices.emplace(id, groups.size());
        if (inserted) groups.push_back({id, grouped ? model : preset.name, grouped, {}});
        groups[it->second].presets.push_back(&preset);
        if (preset.name == selected.name) selected_id = id;
    }
    auto resolve = [&](const Group& group, const std::string& variant) -> const Preset* {
        const Preset* native = bundle.get_similar_printer_preset(
            group.presets.front()->config.opt_string("printer_model"), variant);
        if (native && std::find(group.presets.begin(), group.presets.end(), native) != group.presets.end() &&
            (variant.empty() || native->config.opt_string("printer_variant") == variant))
            return native;
        auto ordered = group.presets;
        std::sort(ordered.begin(), ordered.end(), [](const Preset* a, const Preset* b) { return a->name < b->name; });
        const std::string wanted = variant.empty() ? selected.config.opt_string("printer_variant") : variant;
        for (const Preset* preset : ordered)
            if (preset->config.opt_string("printer_variant") == wanted) return preset;
        return variant.empty() ? ordered.front() : nullptr;
    };
    json items = json::array();
    json variants = json::array();
    std::string current_variant = effective.opt_string("printer_variant");
    const auto* nozzles = effective.opt<ConfigOptionFloats>("nozzle_diameter");
    const auto* original_nozzles = selected.config.opt<ConfigOptionFloats>("nozzle_diameter");
    if (nozzles && !nozzles->values.empty() &&
        (current_variant.empty() || (original_nozzles && nozzles->values != original_nozzles->values))) {
        std::ostringstream label;
        std::set<double> seen;
        for (double value : nozzles->values)
            if (seen.insert(value).second) {
                if (seen.size() > 1) label << "+";
                label << value;
            }
        current_variant = label.str();
    }
    for (const auto& group : groups) {
        const Preset* target = group.id == selected_id ? &selected :
            group.model_group ? resolve(group, {}) : group.presets.front();
        items.push_back({{"id", group.id}, {"label", group.label}, {"preset", target->name}});
        if (group.id != selected_id) continue;
        std::set<std::string> values;
        // Reuse Orca's variant enumeration/order, then apply Neo's admission
        // boundary: the native method includes hidden and cross-vendor presets.
        // A draft can edit printer_model; the picker retains its source identity.
        if (bundle.printers.get_edited_preset().config.opt_string("printer_model") ==
            selected.config.opt_string("printer_model")) {
            for (const auto& value : bundle.printers.diameters_of_selected_printer())
                if (!value.empty() && std::any_of(group.presets.begin(), group.presets.end(),
                    [&](const Preset* preset) { return preset->config.opt_string("printer_variant") == value; }))
                    values.insert(value);
        } else {
            for (const Preset* preset : group.presets) {
                const std::string value = preset->config.opt_string("printer_variant");
                if (!value.empty()) values.insert(value);
            }
        }
        if (!current_variant.empty()) values.insert(current_variant);
        for (const auto& value : values) {
            const Preset* variant_target = resolve(group, value);
            // Reactivating the current source retains its runtime draft. Do
            // not advertise its original variant as a way to reset that draft.
            if (variant_target && variant_target->name == selected.name && value != current_variant)
                variant_target = nullptr;
            variants.push_back({{"value", value},
                                {"preset", variant_target ? json(variant_target->name) : json(nullptr)}});
        }
    }
    return {{"items", std::move(items)}, {"selected_id", selected_id},
            {"variants", std::move(variants)}, {"selected_variant", current_variant}};
}

json preset_snapshot_json()
{
    const auto effective = PresetDrafts::effective_full_config();
    const auto bed_resources = selected_printer_bed_resources();
    json tooltip_defaults = json::object();
    if (const Preset* parent = state().presets.prints.get_selected_preset_parent())
        for (const std::string& key : parent->config.keys())
            if (const ConfigOption* option = parent->config.option(key))
                tooltip_defaults[key] = option->serialize();
    const auto capabilities = selected_printer_bed_type_capabilities();
    json choices = json::array();
    for (const auto& choice : capabilities.choices)
        choices.push_back({{"value", choice.value}, {"label", choice.label}});
    return json{{"ok", true},
                {"printer_picker", printer_picker_json(effective)},
                {"tooltip_defaults", std::move(tooltip_defaults)},
                {"printers", preset_candidates_json(state().presets.printers, false)},
                {"prints", preset_candidates_json(state().presets.prints, true)},
                {"filament_catalog", preset_candidates_json(state().presets.filaments, true, false)},
                {"printer", preset_selection_json(state().presets.printers)},
                {"print", preset_selection_json(state().presets.prints)},
                {"printable_area", selected_printer_printable_area_json()},
                {"bed_model", bed_resources.model},
                {"bed_texture", bed_resources.texture},
                {"bed_type", {{"supports_selection", capabilities.supports_selection},
                              {"default_value", ConfigOptionEnum<BedType>(capabilities.default_type).serialize()},
                              {"choices", std::move(choices)}}},
                // Embedded project settings and the selected Process preset
                // are both part of the native effective configuration.  Use
                // that slicing starts from so the UI cannot fall back to
                // metadata defaults that disagree with slicing.
                {"project_config", Filament::State::config_metadata_json(effective)}};
}

std::optional<std::vector<RememberedSlot>> parse_remembered_slots(const json& rack)
{
    if (!rack.is_null()) {
        if (!rack.is_object() || rack.value("version", 0) != 1 ||
            !rack.contains("slots") || !rack["slots"].is_array() ||
            rack["slots"].empty() || rack["slots"].size() > 64)
            throw std::runtime_error("remembered filament rack is invalid");
        std::vector<RememberedSlot> slots;
        slots.reserve(rack["slots"].size());
        for (const auto& slot : rack["slots"]) {
            if (!slot.is_object() || !slot.contains("preset") || !slot["preset"].is_string() ||
                slot["preset"].get<std::string>().empty() || !slot.contains("colour") ||
                !slot["colour"].is_string() || !valid_remembered_colour(slot["colour"].get<std::string>()))
                throw std::runtime_error("remembered filament slot is invalid");
            const std::string name = slot["preset"].get<std::string>();
            if (Preset::remove_suffix_modified(name) != name)
                throw std::runtime_error("remembered filament preset name must be canonical");
            if (!slot.contains("native") || !slot["native"].is_object())
                throw std::runtime_error("remembered filament native colours are required");
            const auto& native = slot["native"];
            for (const char* key : {"representative", "multi_colour", "type"})
                if (!native.contains(key) || (!native[key].is_null() && !native[key].is_string()))
                    throw std::runtime_error("remembered filament native colour is invalid");
            const std::string representative = native["representative"].is_string()
                ? native["representative"].get<std::string>() : slot["colour"].get<std::string>();
            RememberedSlot remembered{name, representative, true};
            if (native["multi_colour"].is_string())
                remembered.multi_colour = native["multi_colour"].get<std::string>();
            if (native["type"].is_string())
                remembered.colour_type = native["type"].get<std::string>();
            slots.push_back(std::move(remembered));
        }
        return slots;
    }

    return std::nullopt;
}

// Shared mutation primitive. Callers own history publication and full rollback.
void apply_printer_transition_state(const ProfileTransitionState& before_profiles,
    const std::optional<std::vector<RememberedSlot>>& remembered_slots,
    const json& remembered_bed, const bool printer_changed)
{
    auto& bridge = state();
    auto& bundle = bridge.presets;
    const auto printer_name = bundle.printers.get_selected_preset_name();
    // Every profile lookup/compatibility calculation in this native
    // transaction sees the selected Printer's shared project draft.
    EffectivePrinterDraftGuard effective_printer(bundle, printer_name);
    bundle.update_compatible(PresetSelectCompatibleType::Always,
                             PresetSelectCompatibleType::Never);

    if (bundle.printers.get_edited_preset().printer_technology() == ptFFF) {
        const auto* current_colours = before_profiles.project_config.opt<ConfigOptionStrings>("filament_colour");
        std::vector<RememberedSlot> slots;
        if (remembered_slots.has_value()) {
            slots = *remembered_slots;
        } else {
            slots.reserve(bundle.filament_presets.size());
            for (std::size_t index = 0; index < bundle.filament_presets.size(); ++index) {
                const bool same_previous_source = index < before_profiles.filament_presets.size() &&
                    bundle.filament_presets[index] == before_profiles.filament_presets[index];
                const std::string colour = same_previous_source && current_colours != nullptr && index < current_colours->values.size()
                    ? current_colours->values[index]
                    : effective_filament_default_colour(bundle, bundle.filament_presets[index]);
                slots.push_back({bundle.filament_presets[index], colour, true});
                if (same_previous_source)
                    retain_matching_native_colour(slots.back(), before_profiles, index);
            }
        }
        if (slots.empty()) throw std::runtime_error("Printer transition has no filament slots");

        const auto* nozzles = bundle.printers.get_edited_preset().config.opt<ConfigOptionFloats>("nozzle_diameter");
        const std::size_t nozzle_count = nozzles == nullptr ? 1 : std::max<std::size_t>(1, nozzles->values.size());
        const std::size_t final_count = std::max(slots.size(), nozzle_count);
        if (final_count > 64) throw std::runtime_error("Printer transition exceeds the filament slot limit");

        // Resize while the old rack still contains valid catalog
        // names; set_num_filaments invokes Orca's native rack sizing.
        Filament::State::resize_slots_preserving_colours(bundle, static_cast<unsigned int>(final_count));
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
        auto* colour_types = bundle.project_config.option<ConfigOptionStrings>("filament_colour_type", true);
        colours->values.resize(bundle.filament_presets.size(), "#26A69A");
        multi_colours->values.resize(bundle.filament_presets.size(), "#26A69A");
        colour_types->values.resize(bundle.filament_presets.size(), "1");
        for (std::size_t index = 0; index < bundle.filament_presets.size(); ++index) {
            const bool same_source = index < slots.size() &&
                slots[index].preset == bundle.filament_presets[index];
            const std::string colour = same_source && slots[index].retain_colour
                ? slots[index].colour
                : effective_filament_default_colour(bundle, bundle.filament_presets[index]);
            colours->values[index] = colour;
            multi_colours->values[index] = same_source && slots[index].retain_colour && slots[index].multi_colour
                ? *slots[index].multi_colour : colour;
            colour_types->values[index] = same_source && slots[index].retain_colour && slots[index].colour_type
                ? *slots[index].colour_type : "1";
        }
    }

    Filament::Commands::normalize_references_after_rack_restore(
        bundle, bridge.model, bridge.plate_session_plates,
        before_profiles.filament_presets.size());
    bridge.mutable_object_capture_cache.clear();
    normalize_bed_types(printer_changed);
    // Memory is validated by the final effective Printer's native
    // capabilities inside this same history transaction.
    if (printer_changed && remembered_bed.is_string()) {
        const auto capabilities = selected_printer_bed_type_capabilities();
        const auto remembered = remembered_bed.get<std::string>();
        if (capabilities.supports_selection) {
            for (const auto& choice : capabilities.choices) {
                if (choice.value == remembered) {
                    bundle.project_config.set_key_value("curr_bed_type", new ConfigOptionEnum<BedType>(choice.type));
                    break;
                }
            }
        }
    }
    validate_profile_transition();
}

json select_printer_with_remembered_rack_json(const json& request)
{
    if (!request.is_object() ||
        !request.contains("printer") || !request["printer"].is_string() ||
        request["printer"].get<std::string>().empty())
        return transition_error("invalid_request", "Printer transition request is invalid");
    if (state().active_history_transaction)
        return transition_error("history_transaction_active", "Printer transition cannot run inside another history transaction");
    if (state().history_disabled)
        return transition_error("history_disabled", "project history is disabled");

    if (!request.contains("remembered_bed_type") || (!request["remembered_bed_type"].is_null() && !request["remembered_bed_type"].is_string()))
        return transition_error("invalid_request", "remembered bed type is invalid");
    if (!request.contains("remembered_rack"))
        return transition_error("invalid_request", "remembered rack is required (null when absent)");
    const std::string printer_name = request["printer"].get<std::string>();
    const Preset* target = state().presets.printers.find_preset(printer_name, false, true);
    if (target == nullptr) return transition_error("preset_not_found", "Printer preset not found: " + printer_name);
    if (!target->is_visible) return transition_error("preset_not_visible", "Printer preset is not visible: " + printer_name);
    if (target->name != printer_name)
        return transition_error("invalid_request", "Printer name must be canonical");

    std::optional<std::vector<RememberedSlot>> remembered_slots;
    try { remembered_slots = parse_remembered_slots(request["remembered_rack"]); }
    catch (const std::exception& error) { return transition_error("invalid_request", error.what()); }

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
            apply_printer_transition_state(before_profiles, remembered_slots,
                request["remembered_bed_type"], true);
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
        return json{{"ok", true},
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

const char* init_profiles(const json& activation)
{
    reset_app_config();
    configure_activation(state().profile_config, activation);
    set_data_dir("/");
    set_resources_dir("/");
    state().presets.setup_directories();
    state().presets.load_presets(state().profile_config, ForwardCompatibilitySubstitutionRule::Enable);
    reselect_after_app_config(state().presets, state().profile_config);
    const bool usable_printer = std::any_of(state().presets.printers.begin(), state().presets.printers.end(),
        [](const Preset& preset) { return !preset.is_default && preset.is_visible; });
    return dup_json(json{{"ok", true}, {"setupRequired", activation.is_null() || !usable_printer},
                         {"prints", state().presets.prints.size()},
                         {"filaments", state().presets.filaments.size()},
                         {"printers", state().presets.printers.size()}}.dump());
}

// Owned only by the open wizard; every open destroys the previous projection
// before parsing raw resources again. Never installs into the live system view.
namespace {
std::unique_ptr<PresetBundle> wizard_bundle;
json wizard_catalogue;
std::unique_ptr<PresetBundle> prepared_bundle;
std::unique_ptr<AppConfig> prepared_config;
json prepared_activation;
json prepared_memory;
bool prepared_preferred_printer = false;
bool inject_activation_failure = false;

std::string wizard_short_name(const std::string& name)
{
    std::string value = name.substr(0, name.find('@'));
    const auto first = value.find_first_not_of(" \t\n\r\f\v");
    if (first == std::string::npos) return {};
    return value.substr(first, value.find_last_not_of(" \t\n\r\f\v") - first + 1);
}
}

void discard_prepared_activation()
{
    prepared_bundle.reset(); prepared_config.reset(); prepared_activation = json(); prepared_memory = json(); prepared_preferred_printer = false;
}

json close_wizard_catalogue()
{
    discard_prepared_activation();
    wizard_bundle.reset();
    wizard_catalogue = json();
    return {{"ok", true}};
}

json open_wizard_catalogue()
{
    close_wizard_catalogue();
    auto bundle = std::make_unique<PresetBundle>();
    std::map<std::string, boost::filesystem::path> sources;
    const boost::filesystem::path root("/profiles");
    if (boost::filesystem::exists(root)) {
        for (const auto& entry : boost::filesystem::directory_iterator(root))
            if (boost::filesystem::is_regular_file(entry.path()) && entry.path().extension() == ".json")
                sources.emplace(entry.path().stem().string(), root);
    }
    std::vector<PresetBundle::VendorSource> ordered;
    const std::string library(PresetBundle::ORCA_FILAMENT_LIBRARY);
    if (auto found = sources.find(library); found != sources.end())
        ordered.push_back({found->first, found->second});
    for (const auto& [name, directory] : sources)
        if (name != library) ordered.push_back({name, directory});
    const auto loaded = bundle->load_vendors(ordered,
        ForwardCompatibilitySubstitutionRule::EnableSilent, /*allow_cache=*/false);
    if (!loaded.second.empty()) BOOST_LOG_TRIVIAL(warning) << "Setup catalogue: " << loaded.second;

    json catalogue = {{"models", json::array()}, {"filaments", json::array()}};
    for (const auto& [vendor_id, vendor] : bundle->vendors) {
        for (const auto& model : vendor.models) {
            json nozzles = json::array();
            for (const auto& variant : model.variants) nozzles.push_back(variant.name);
            const auto cover = root / vendor.id / (model.id + "_cover.png");
            catalogue["models"].push_back({{"vendor", vendor.id}, {"model", model.id},
                {"name", model.name}, {"image", boost::filesystem::exists(cover) ? cover.string() : ""},
                {"nozzle_diameter", std::move(nozzles)}, {"default_materials", model.default_materials}});
        }
    }
    // Orca's wizard explicitly maps printer names, without evaluating the live
    // workspace compatibility expressions or filtering printer visibility.
    struct Machine { std::string vendor; std::string model; std::string nozzle; };
    std::map<std::string, Machine> machines;
    for (const Preset& preset : bundle->printers()) {
        if (!preset.is_system || !preset.vendor) continue;
        const auto* model = preset.config.option<ConfigOptionString>("printer_model");
        const auto* variant = preset.config.option<ConfigOptionString>("printer_variant");
        if (model && !model->value.empty() && variant)
            machines.emplace(preset.name, Machine{preset.vendor->id, model->value, variant->value});
    }
    using Group = std::tuple<std::string, std::string, std::string>;
    std::map<Group, json> groups;
    for (const Preset& preset : bundle->filaments()) {
        if (!preset.is_system || !preset.vendor) continue;
        const auto* manufacturer = preset.config.option<ConfigOptionStrings>("filament_vendor");
        const auto* material = preset.config.option<ConfigOptionStrings>("filament_type");
        const auto* compatible = preset.config.option<ConfigOptionStrings>("compatible_printers");
        const std::string vendor = manufacturer && !manufacturer->values.empty() ? manufacturer->values.front() : "";
        const std::string type = material && !material->values.empty() ? material->values.front() : "";
        const std::string name = wizard_short_name(preset.name);
        std::map<std::pair<std::string, std::string>, std::set<std::string>> mapping;
        if (compatible) for (const auto& printer : compatible->values) {
            const auto found = machines.find(printer);
            if (found != machines.end()) mapping[{found->second.vendor, found->second.model}].insert(found->second.nozzle);
        }
        json models = json::array();
        for (const auto& [identity, nozzles] : mapping)
            models.push_back({{"vendor", identity.first}, {"model", identity.second}, {"nozzle_diameter", nozzles}});
        auto [group, inserted] = groups.try_emplace(Group{vendor, type, name}, json{
            {"vendor", vendor}, {"type", type}, {"name", name}, {"presets", json::array()}});
        group->second["presets"].push_back({{"name", preset.name}, {"resource_vendor", preset.vendor->id},
            {"compatible_models", std::move(models)}});
    }
    for (auto& [identity, group] : groups) catalogue["filaments"].push_back(std::move(group));
    wizard_bundle = std::move(bundle);
    wizard_catalogue = std::move(catalogue);
    return {{"ok", true}, {"catalogue", wizard_catalogue}};
}


json activation_from_config(const AppConfig& config)
{
    json activation = {{"models", json::array()}, {"filaments", json::array()}};
    for (const auto& [vendor, models] : config.vendors())
        for (const auto& [model, nozzles] : models)
            activation["models"].push_back({{"vendor", vendor}, {"model", model}, {"nozzle_diameter", nozzles}});
    if (config.has_section(AppConfig::SECTION_FILAMENTS))
        for (const auto& [name, enabled] : config.get_section(AppConfig::SECTION_FILAMENTS))
            if (enabled == "true") activation["filaments"].push_back(name);
    return activation;
}

// WebGuideDialog: custom vendor first, then sorted vendor/model identities;
// retain manifest variant order for a new multi-variant model, sorted newly
// added variants for a changed model. Stale identities do not supply a target.
PresetBundle::PresetPreferences preferred_activation_printer(const PresetBundle& bundle, const AppConfig& config)
{
    PresetBundle::PresetPreferences result;
    const auto& old = state().profile_config.vendors();
    const auto pick = [&](const std::string& vendor) {
        const auto enabled = config.vendors().find(vendor);
        const auto profile = bundle.vendors.find(vendor);
        if (enabled == config.vendors().end() || profile == bundle.vendors.end()) return false;
        for (const auto& [model, variants] : enabled->second) {
            if (variants.empty()) continue;
            const auto source = std::find_if(profile->second.models.begin(), profile->second.models.end(),
                [id = model](const auto& entry) { return entry.id == id; });
            if (source == profile->second.models.end()) continue;
            std::string variant = *variants.begin();
            if (variants.size() > 1) {
                for (const auto& entry : source->variants)
                    if (variants.count(entry.name)) { variant = entry.name; break; }
            }
            const auto previous_vendor = old.find(vendor);
            bool added = previous_vendor == old.end();
            if (!added) {
                const auto previous_model = previous_vendor->second.find(model);
                added = previous_model == previous_vendor->second.end();
                if (!added && previous_model->second != variants)
                    for (const auto& entry : variants)
                        if (!previous_model->second.count(entry)) { variant = entry; added = true; break; }
            }
            if (!added) continue;
            const Preset* printer = bundle.printers.find_system_preset_by_model_and_variant(model, variant);
            if (!printer || !printer->vendor || printer->vendor->id != vendor) continue;
            result.printer_model_id = model; result.printer_variant = variant; return true;
        }
        return false;
    };
    if (!pick(PresetBundle::ORCA_DEFAULT_BUNDLE))
        for (const auto& [vendor, models] : config.vendors())
            if (vendor != PresetBundle::ORCA_DEFAULT_BUNDLE && pick(vendor)) break;
    return result;
}

json prepare_activation(const json& request)
{
    discard_prepared_activation();
    if (!wizard_bundle) throw std::runtime_error("setup catalogue is not open");
    if (!request.is_object() || request.size() != 3 || !request.contains("activation") ||
        !request.contains("remembered_filament_racks") || !request.at("remembered_filament_racks").is_object() ||
        !request.contains("remembered_bed_types") || !request.at("remembered_bed_types").is_object())
        throw std::runtime_error("explicit activation and transition memory are required");
    const auto& activation = request.at("activation");
    if (activation.is_null()) throw std::runtime_error("activation record required");
    for (const auto& rack : request.at("remembered_filament_racks")) {
        if (!rack.is_object()) throw std::runtime_error("invalid remembered filament rack");
        (void)parse_remembered_slots(rack);
    }
    for (const auto& bed : request.at("remembered_bed_types"))
        if (!bed.is_string() || bed.get<std::string>().empty()) throw std::runtime_error("invalid remembered bed type");
    auto config = std::make_unique<AppConfig>();
    configure_activation(*config, activation);
    std::set<std::string> vendors;
    for (const auto& [vendor, models] : config->vendors()) vendors.insert(vendor);
    std::vector<PresetBundle::VendorSource> sources;
    const boost::filesystem::path root("/profiles");
    const std::string library(PresetBundle::ORCA_FILAMENT_LIBRARY);
    if (boost::filesystem::exists(root / (library + ".json"))) sources.push_back({library, root});
    for (const auto& vendor : vendors)
        if (vendor != library && boost::filesystem::exists(root / (vendor + ".json"))) sources.push_back({vendor, root});
    auto bundle = std::make_unique<PresetBundle>();
    const auto loaded = bundle->load_vendors(sources, ForwardCompatibilitySubstitutionRule::EnableSilent, false);
    if (!loaded.second.empty()) BOOST_LOG_TRIVIAL(warning) << "Prepare activation: " << loaded.second;
    bundle->normalize_compatible_presets();
    const auto preferred = preferred_activation_printer(*bundle, *config);
    config->set("presets", PRESET_PRINTER_NAME, state().presets.printers.get_selected_preset_name());
    bundle->load_selections(*config, preferred);
    if (!preferred.printer_model_id.empty())
        config->set("presets", PRESET_PRINTER_NAME, bundle->printers.get_selected_preset_name());
    reselect_after_app_config(*bundle, *config);
    const bool usable = std::any_of(bundle->printers.begin(), bundle->printers.end(),
        [](const Preset& preset) { return !preset.is_default && preset.is_visible; });
    if (!usable) throw std::runtime_error("activation has no usable enabled printer");
    prepared_activation = activation_from_config(*config);
    prepared_preferred_printer = !preferred.printer_model_id.empty();
    prepared_memory = request;
    prepared_bundle = std::move(bundle); prepared_config = std::move(config);
    return {{"ok", true}, {"activation", prepared_activation}};
}

// Core PresetBundle copies rebind collection entries but omit the edited
// Preset vendor pointer and AMS metadata. Bind mutable owners to this copy.
void rebind_activation_bundle(PresetBundle& bundle)
{
    for (PresetCollection* collection : std::initializer_list<PresetCollection*>{&bundle.printers, &bundle.prints, &bundle.filaments})
        collection->get_edited_preset().vendor = collection->get_selected_preset().vendor;
}

std::pair<PresetDraftRegistry, PresetDraftRegistry> activation_drafts(const PresetBundle& bundle)
{
    std::map<std::pair<std::string, std::string>, json> entries;
    for (const auto* registry : {&state().dormant_preset_drafts, &state().preset_drafts}) {
        const auto snapshot = registry->snapshot_json();
        for (const auto& entry : snapshot.at("entries"))
            entries[{entry.at("kind").get<std::string>(), entry.at("canonical_name").get<std::string>()}] = entry;
    }
    json active = {{"entries", json::array()}};
    PresetDraftRegistry dormant;
    for (const auto& [identity, entry] : entries) {
        const auto type = identity.first == "printer" ? Preset::TYPE_PRINTER : Preset::TYPE_FILAMENT;
        const auto& collection = type == Preset::TYPE_PRINTER ? bundle.printers : bundle.filaments;
        if (collection.find_preset(identity.second, false) != nullptr) active["entries"].push_back(entry);
        else {
            dormant.ensure_entry(type, identity.second);
            for (auto option = entry.at("overrides").begin(); option != entry.at("overrides").end(); ++option)
                dormant.set(type, identity.second, option.key(), option.value().get<std::string>());
        }
    }
    return {PresetDraftRegistry::from_snapshot_json(active, bundle), std::move(dormant)};
}

const char* apply_activation()
{
    if (!prepared_bundle || !prepared_config) throw std::runtime_error("activation is not prepared");
    auto& bridge = state();
    if (bridge.active_history_transaction || !bridge.nested_history_transactions.empty() ||
        bridge.history.editing_session_status()) throw std::runtime_error("finish the current editing operation before applying activation");
    const auto before_profiles = capture_profile_transition_state();
    const auto before_effective = PresetDrafts::effective_full_config();
    const bool before_dirty = bridge.history.project_modified();
    PresetBundle candidate(*prepared_bundle);
    AppConfig config(*prepared_config);
    // Archive-save projection returns sparse differed presets, and the core
    // archive importer requires parents. Transfer the actual full project-owned
    // entries instead: embedded sources remain independent of global availability.
    for (const PresetCollection* previous : std::initializer_list<const PresetCollection*>{
            &bridge.presets.printers, &bridge.presets.prints, &bridge.presets.filaments}) {
        for (const Preset& source : *previous) {
            if (!source.is_project_embedded) continue;
            auto& collection = source.type == Preset::TYPE_PRINTER ? candidate.printers :
                source.type == Preset::TYPE_FILAMENT ? candidate.filaments : candidate.prints;
            Preset& imported = collection.load_preset(source.file, source.name, source.config, false, source.version);
            imported = source;
            const auto vendor = source.vendor ? candidate.vendors.find(source.vendor->id) : candidate.vendors.end();
            imported.vendor = vendor == candidate.vendors.end() ? nullptr : &vendor->second;
        }
    }
    auto retain = [](PresetCollection& target, const PresetCollection& previous) {
        const auto& source = previous.get_selected_preset();
        Preset* available = target.find_preset(source.name, false, true);
        if (available && (available->is_visible || available->is_project_embedded)) {
            target.select_preset_by_name(source.name, true);
            target.get_edited_preset() = previous.get_edited_preset();
            target.update_dirty();
        }
    };
    if (!prepared_preferred_printer) retain(candidate.printers, bridge.presets.printers);
    candidate.update_compatible(PresetSelectCompatibleType::Always);
    retain(candidate.prints, bridge.presets.prints);
    retain(candidate.filaments, bridge.presets.filaments);
    const std::string fallback = candidate.filaments.get_selected_preset_name();
    candidate.filament_presets = bridge.presets.filament_presets;
    for (auto& name : candidate.filament_presets) {
        const Preset* available = candidate.filaments.find_preset(name, false, true);
        if (!available || (!available->is_visible && !available->is_project_embedded)) name = fallback;
    }
    candidate.project_config = bridge.presets.project_config;
    candidate.ams_multi_color_filment = bridge.presets.ams_multi_color_filment;
    candidate.update_multi_material_filament_presets();
    Filament::State::resize_slots_preserving_colours(candidate, static_cast<unsigned int>(candidate.filament_presets.size()));
    Filament::Commands::recalculate_filament_flush(candidate);
    rebind_activation_bundle(candidate);
    auto staged_drafts = activation_drafts(candidate);
    const auto target_printer = candidate.printers.get_selected_preset_name();
    const bool printer_changed = target_printer != before_profiles.printer;
    const auto& racks = prepared_memory.at("remembered_filament_racks");
    auto remembered_slots = printer_changed && racks.contains(target_printer)
        ? parse_remembered_slots(racks.at(target_printer)) : std::nullopt;
    if (!remembered_slots) {
        std::vector<RememberedSlot> slots;
        const auto* colours = before_profiles.project_config.opt<ConfigOptionStrings>("filament_colour");
        for (std::size_t index = 0; index < before_profiles.filament_presets.size(); ++index) {
            const auto& name = before_profiles.filament_presets[index];
            slots.push_back({name, colours && index < colours->values.size() ? colours->values[index] : "#26A69A", true});
            retain_matching_native_colour(slots.back(), before_profiles, index);
        }
        remembered_slots = std::move(slots);
    }
    // Candidate loading may already have normalized its initial rack. Restore
    // previous/remembered identities explicitly; never resurrect a hidden source.
    for (auto& slot : *remembered_slots) {
        const auto* source = candidate.filaments.find_preset(slot.preset, false, true);
        if (!source || (!source->is_visible && !source->is_project_embedded)) {
            slot.preset = fallback; slot.retain_colour = false;
            slot.multi_colour.reset(); slot.colour_type.reset();
        }
    }
    const auto& beds = prepared_memory.at("remembered_bed_types");
    const json remembered_bed = printer_changed && beds.contains(target_printer) ? beds.at(target_printer) : json();

    const auto before_lifecycle = bridge.plate_runtime_registry.capture_lifecycle();
    Model before_model = bridge.model;
    const auto before_plates = bridge.plate_session_plates;
    const auto before_membership = bridge.instance_plate_ids;
    const auto before_out_of_bounds = bridge.plate_out_of_bounds_ids;
    const auto before_parked = bridge.parked_instance_ids;
    const auto before_current_plate = bridge.current_plate_id;
    const auto before_stamp = bridge.next_plate_input_stamp;
    const auto before_next_slot = bridge.next_filament_slot_id;
    const auto before_next_colour = bridge.next_filament_colour_index;
    auto before_tower_cache = bridge.prime_tower_projection_cache;
    auto before_revisions = bridge.plate_input_revisions;
    auto before_pending = bridge.pending_membership_instance_ids;
    const auto before_context = bridge.history_live_context;
    const auto before_slots = bridge.filament_slot_ids;
    auto before_drafts = bridge.preset_drafts;
    auto before_dormant = bridge.dormant_preset_drafts;
    auto before_mesh_cache = bridge.mesh_capture_cache;
    auto before_mutable_cache = bridge.mutable_object_capture_cache;
    auto before_presets = std::move(bridge.presets);
    auto before_config = std::move(bridge.profile_config);
    before_presets.ams_multi_color_filment = bridge.presets.ams_multi_color_filment;
    rebind_activation_bundle(before_presets);
    try {
        bridge.presets = candidate; bridge.profile_config = std::move(config);
        bridge.presets.ams_multi_color_filment = candidate.ams_multi_color_filment;
        rebind_activation_bundle(bridge.presets);
        bridge.preset_drafts = std::move(staged_drafts.first);
        bridge.dormant_preset_drafts = std::move(staged_drafts.second);
        apply_printer_transition_state(before_profiles, remembered_slots, remembered_bed, printer_changed);
        // Embedded Print remains the project's configuration authority across
        // global activation; native compatibility must not displace its edits.
        if (before_presets.prints.get_selected_preset().is_project_embedded)
            retain(bridge.presets.prints, before_presets.prints);
        const auto after_effective = PresetDrafts::effective_full_config();
        const bool changed = !before_effective.diff(after_effective).empty();
        History::TimestampedHistory baseline(bridge.history.byte_budget());
        if (!before_dirty && !changed) baseline.mark_current_as_saved();
        const json plates = changed ? PlateSession::shared_configuration_mutation_snapshot()
            : PlateSession::plate_session_snapshot_json();
        json context = HistoryMetadata::default_history_context(bridge, plates,
            Filament::State::history_state_json(bridge.presets));
        (void) HistoryMetadata::capture_history_roots(bridge, context);
        const auto revision = bridge.history_revision + 1;
        json filaments = Filament::Session::filament_session_snapshot_json();
        if (!filaments.value("ok", false)) throw std::runtime_error("activation produced invalid filament session");
        filaments["revisions"]["session"] = revision;
        const json response = {{"ok", true}, {"profile_snapshot", preset_snapshot_json()},
            {"filament_session", std::move(filaments)}, {"plate_session", plates},
            {"native_scoped_config", ScopedConfig::native_scoped_config_full_transport(revision)},
            {"history_status", HistoryMetadata::history_status_json(bridge, baseline, revision)},
            {"configuration_changed", changed}};
        if (inject_activation_failure) {
            inject_activation_failure = false;
            throw std::runtime_error("injected activation publication failure");
        }
        const char* encoded = duplicate_json(response.dump());
        // Everything requiring allocation/validation is complete before the
        // irreversible history replacement. Failed publication keeps old history.
        bridge.history = std::move(baseline);
        bridge.history_live_context = std::move(context);
        HistoryMetadata::advance_history_epoch(bridge);
        bridge.mutable_object_capture_cache.clear();
        if (changed) SlicingPipeline::invalidate_preview_source();
        return encoded;
    } catch (...) {
        bridge.presets = before_presets; bridge.profile_config = std::move(before_config);
        bridge.presets.ams_multi_color_filment = before_presets.ams_multi_color_filment;
        rebind_activation_bundle(bridge.presets);
        bridge.preset_drafts = std::move(before_drafts);
        bridge.dormant_preset_drafts = std::move(before_dormant);
        bridge.mesh_capture_cache = std::move(before_mesh_cache);
        bridge.mutable_object_capture_cache = std::move(before_mutable_cache);
        bridge.model = std::move(before_model);
        bridge.plate_session_plates = before_plates;
        bridge.instance_plate_ids = before_membership;
        bridge.plate_out_of_bounds_ids = before_out_of_bounds;
        bridge.parked_instance_ids = before_parked;
        bridge.current_plate_id = before_current_plate;
        bridge.next_plate_input_stamp = before_stamp;
        bridge.next_filament_slot_id = before_next_slot;
        bridge.next_filament_colour_index = before_next_colour;
        bridge.prime_tower_projection_cache = std::move(before_tower_cache);
        bridge.plate_runtime_registry.restore_lifecycle(before_lifecycle);
        bridge.plate_input_revisions = std::move(before_revisions);
        bridge.pending_membership_instance_ids = std::move(before_pending);
        bridge.history_live_context = before_context; bridge.filament_slot_ids = before_slots;
        throw;
    }
}

} // namespace Slic3r::Neo::Bridge::Profiles

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_open_setup_wizard_catalogue()
{
    using namespace Slic3r::Neo::Bridge::Profiles;
    try { return duplicate_json(open_wizard_catalogue().dump()); }
    catch (const std::exception& error) {
        close_wizard_catalogue();
        return duplicate_json(json{{"ok", false}, {"error", error.what()}}.dump());
    }
    catch (...) {
        close_wizard_catalogue();
        return duplicate_json(json{{"ok", false}, {"error", "unknown catalogue exception"}}.dump());
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_close_setup_wizard_catalogue()
{
    using namespace Slic3r::Neo::Bridge::Profiles;
    return duplicate_json(close_wizard_catalogue().dump());
}

EMSCRIPTEN_KEEPALIVE const char* orc_prepare_profile_activation(const char* request)
{
    using namespace Slic3r::Neo::Bridge::Profiles;
    try { return duplicate_json(prepare_activation(json::parse(request ? request : "")).dump()); }
    catch (const std::exception& error) { discard_prepared_activation(); return duplicate_json(json{{"ok", false}, {"error", error.what()}}.dump()); }
    catch (...) { discard_prepared_activation(); return duplicate_json(json{{"ok", false}, {"error", "unknown preparation exception"}}.dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_apply_profile_activation()
{
    using namespace Slic3r::Neo::Bridge::Profiles;
    try { return apply_activation(); }
    catch (const std::exception& error) { return duplicate_json(json{{"ok", false}, {"error", error.what()}}.dump()); }
    catch (...) { return duplicate_json(json{{"ok", false}, {"error", "unknown application exception"}}.dump()); }
}

// Harness-only, one-shot fault at the last reversible publication boundary.
// No application/client surface.
EMSCRIPTEN_KEEPALIVE const char* orc_test_inject_profile_activation_failure()
{
    using namespace Slic3r::Neo::Bridge::Profiles;
    inject_activation_failure = true;
    return duplicate_json(json{{"ok", true}}.dump());
}

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
        const auto before_plates = state().plate_session_plates;
        try {
            if (!collection->select_preset_by_name(name, true))
                throw std::runtime_error("could not select preset: " + name);
            if (kind == "printer") {
                state().presets.update_compatible(PresetSelectCompatibleType::Always);
                state().presets.update_multi_material_filament_presets();
                Profiles::normalize_bed_types(true);
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
            state().plate_session_plates = before_plates;
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
