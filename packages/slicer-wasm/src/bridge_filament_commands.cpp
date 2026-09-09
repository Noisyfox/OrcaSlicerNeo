#include <emscripten/emscripten.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <sstream>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "bridge_filament_commands.hpp"
#include "bridge_filament_state.hpp"
#include "bridge_history_codec.hpp"
#include "bridge_history_metadata.hpp"
#include "bridge_plate_session.hpp"
#include "bridge_project_overlay.hpp"
#include "bridge_slicing_pipeline.hpp"
#include "libslic3r/FlushVolCalc.hpp"
#include "libslic3r/PrintConfig.hpp"

using namespace Slic3r;

namespace Slic3r::Neo::Bridge::FilamentCommands {

using Neo::Bridge::BridgeState;
using Neo::Bridge::state;
using Neo::Bridge::FilamentState::config_metadata_json;
using Neo::Bridge::FilamentState::current_direct_frame_model;
using Neo::Bridge::FilamentState::history_state_json;
using Neo::Bridge::FilamentState::make_direct_frame;
using Neo::Bridge::HistoryMetadata::default_history_context;
using Neo::Bridge::PlateSession::all_plate_ids;
using Neo::Bridge::PlateSession::ensure_plate_session_state;
using Neo::Bridge::PlateSession::member_plate_ids_for_instances;
using Neo::Bridge::PlateSession::plate_id_array;
using Neo::Bridge::PlateSession::plate_revisions_json;
using Neo::Bridge::PlateSession::plate_session_snapshot_json;
using Neo::Bridge::ProjectOverlay::valid_project_config_overlay;
using Neo::Bridge::SlicingPipeline::invalidate_preview_source;
using Neo::History::Codec::capture_model_state;

namespace {
thread_local const Runtime* active_runtime = nullptr;
struct RuntimeScope {
    const Runtime* previous;
    explicit RuntimeScope(const Runtime& runtime) : previous(active_runtime) { active_runtime = &runtime; }
    ~RuntimeScope() { active_runtime = previous; }
};
json filament_snapshot_json()
{
    if (active_runtime == nullptr || !active_runtime->filament_snapshot)
        throw std::runtime_error("filament command runtime is unavailable");
    return active_runtime->filament_snapshot();
}
const char* duplicate_json(const std::string& value)
{
    char* out = static_cast<char*>(std::malloc(value.size() + 1));
    std::memcpy(out, value.data(), value.size());
    out[value.size()] = '\0';
    return out;
}
json default_command_history_context()
{
    return Neo::Bridge::HistoryMetadata::default_history_context(
        state(), plate_session_snapshot_json(), history_state_json(state().presets));
}
std::vector<double> config_floats(const DynamicPrintConfig& config, const char* key)
{
    if (const auto* option = config.opt<ConfigOptionFloats>(key)) return option->values;
    return {};
}
}
json command_error(const char* code, const std::string& message)
{
    return { {"ok", false}, {"version", 1}, {"error", message}, {"error_code", code},
             {"status", {{"state", "error"}, {"error", message}}} };
}

struct FilamentCommandFailure : std::runtime_error {
    const char* code;
    FilamentCommandFailure(const char* failure_code, const std::string& message)
        : std::runtime_error(message), code(failure_code) {}
};

std::optional<std::size_t> filament_command_slot(const json& request, const char* key,
                                                  std::size_t count, std::string& error)
{
    if (!request.contains(key) || !request[key].is_number_integer()) {
        error = std::string(key) + " is required";
        return std::nullopt;
    }
    const auto one_based = request[key].get<std::int64_t>();
    if (one_based < 1 || static_cast<std::uint64_t>(one_based) > count) {
        error = std::string(key) + " is outside the ordered filament slots";
        return std::nullopt;
    }
    return static_cast<std::size_t>(one_based - 1);
}

bool valid_filament_colour(const std::string& colour)
{
    if (colour.size() != 7 && colour.size() != 9 || colour.front() != '#') return false;
    return std::all_of(colour.begin() + 1, colour.end(), [](const char value) {
        return std::isxdigit(static_cast<unsigned char>(value)) != 0;
    });
}

std::string filament_preset_colour(const PresetBundle& bundle, const std::size_t slot)
{
    if (slot >= bundle.filament_presets.size()) return "#26A69A";
    const Preset* preset = bundle.filaments.find_preset(bundle.filament_presets[slot], false);
    if (preset != nullptr) {
        if (const auto* colours = preset->config.opt<ConfigOptionStrings>("filament_colour");
            colours != nullptr && !colours->values.empty()) return colours->values.front();
        if (const auto* colours = preset->config.opt<ConfigOptionStrings>("default_filament_colour");
            colours != nullptr && !colours->values.empty()) return colours->values.front();
    }
    return "#26A69A";
}

std::optional<std::string> user_filament_colour_override(const PresetBundle& bundle, const std::size_t slot)
{
    const auto* colours = bundle.project_config.option<ConfigOptionStrings>("filament_colour");
    if (colours == nullptr || slot >= colours->values.size() || !valid_filament_colour(colours->values[slot]))
        return std::nullopt;
    const std::string native = filament_preset_colour(bundle, slot);
    return colours->values[slot] == native ? std::nullopt : std::optional<std::string>(colours->values[slot]);
}

int remap_filament_reference(const int value, const std::size_t removed,
                             const std::optional<std::size_t>& replacement)
{
    if (value <= 0) return value;
    const std::size_t current = static_cast<std::size_t>(value - 1);
    if (current == removed)
        return replacement.has_value() ? static_cast<int>(*replacement + 1) : 1;
    return static_cast<int>((current > removed ? current - 1 : current) + 1);
}

bool is_filament_slot_reference_key(const std::string& key)
{
    // Audited one-based slot references.  Do not infer references from a
    // substring: filament temperatures, purge settings, shrinkage, and other
    // numeric material properties must survive slot deletion unchanged.
    static const std::set<std::string> keys = {
        "extruder", "support_filament", "support_interface_filament", "wipe_tower_filament",
        "outer_wall_filament_id", "inner_wall_filament_id", "sparse_infill_filament_id",
        "internal_solid_filament_id", "top_surface_filament_id", "bottom_surface_filament_id",
    };
    return keys.find(key) != keys.end();
}

int remap_filament_config_reference(const std::string& key, const int value,
                                    const std::size_t removed,
                                    const std::optional<std::size_t>& replacement)
{
    // Support/raft and feature routing use native zero as Default.  A plain
    // slot Delete therefore clears a deleted explicit route to Default, while
    // ordinary object/part assignments retain Orca's slot-1 fallback.
    if (!replacement.has_value() && value == static_cast<int>(removed + 1) &&
        (key == "support_filament" || key == "support_interface_filament" ||
         key == "outer_wall_filament_id" || key == "inner_wall_filament_id" ||
         key == "sparse_infill_filament_id" || key == "internal_solid_filament_id" ||
         key == "top_surface_filament_id" || key == "bottom_surface_filament_id"))
        return 0;
    return remap_filament_reference(value, removed, replacement);
}

template <typename Config>
void remap_config_filament_references(Config& config, const std::size_t removed,
                                      const std::optional<std::size_t>& replacement)
{
    const auto keys = config.keys();
    for (const std::string& key : keys) {
        if (!is_filament_slot_reference_key(key)) continue;
        const auto* option = dynamic_cast<const ConfigOptionInt*>(config.option(key));
        if (option == nullptr) continue;
        config.set_key_value(key, new ConfigOptionInt(remap_filament_config_reference(key, option->value, removed, replacement)));
    }
}

void remap_overlay_filament_references(json& overlay, const std::size_t removed,
                                       const std::optional<std::size_t>& replacement)
{
    if (!valid_project_config_overlay(overlay))
        throw FilamentCommandFailure("unsupported_reference", "invalid project configuration overlay");
    auto remap_values = [&](json& values) {
        if (!values.is_object()) return;
        for (auto option = values.begin(); option != values.end(); ++option) {
            if (!is_filament_slot_reference_key(option.key()) || !option.value().is_string()) continue;
            try {
                const int old_value = std::stoi(option.value().get<std::string>());
                option.value() = std::to_string(remap_filament_config_reference(option.key(), old_value, removed, replacement));
            } catch (...) {
                throw FilamentCommandFailure("unsupported_reference", "invalid filament reference in project overlay");
            }
        }
    };
    remap_values(overlay["project"]);
    for (const char* scope : {"objects", "parts", "plates"})
        for (auto it = overlay[scope].begin(); it != overlay[scope].end(); ++it)
            remap_values(it.value());
}

void remap_plate_filament_references(std::vector<BridgeState::PlateSessionPlate>& plates,
                                     const std::size_t removed,
                                     const std::optional<std::size_t>& replacement,
                                     const std::size_t old_count)
{
    for (auto& plate : plates) {
        remap_config_filament_references(plate.settings, removed, replacement);

        // PartPlate stores these arrays as per-filament values.  They are not
        // slot references: deletion removes the selected element, while a
        // merge first redirects the selected element's sequence users to the
        // (post-delete) destination.  Keep this equivalent to
        // PartPlate::on_filament_deleted instead of treating every integer
        // containing "filament" as a reference.
        for (const char* key : {"filament_map", "filament_nozzle_map", "filament_volume_map"}) {
            if (auto* values = plate.settings.option<ConfigOptionInts>(key)) {
                if (values->values.size() != old_count)
                    throw FilamentCommandFailure("unsupported_reference", "malformed per-plate filament map");
                values->values.erase(values->values.begin() + static_cast<std::ptrdiff_t>(removed));
            }
        }

        if (auto* first = plate.settings.option<ConfigOptionInts>("first_layer_print_sequence")) {
            if (!first->values.empty() && first->values.front() != 0) {
                for (const int value : first->values)
                    if (value < 1 || value > static_cast<int>(old_count))
                        throw FilamentCommandFailure("unsupported_reference", "malformed first-layer filament sequence");
                first->values.erase(std::remove(first->values.begin(), first->values.end(),
                                                static_cast<int>(removed + 1)), first->values.end());
                for (int& value : first->values)
                    if (value > static_cast<int>(removed + 1)) --value;
            }
        }

        auto* other = plate.settings.option<ConfigOptionInts>("other_layers_print_sequence");
        auto* other_count = plate.settings.option<ConfigOptionInt>("other_layers_print_sequence_nums");
        if ((other == nullptr) != (other_count == nullptr))
            throw FilamentCommandFailure("unsupported_reference", "incomplete per-plate layer sequence");
        if (other != nullptr) {
            if (other_count->value <= 0 || other->values.empty() ||
                other->values.size() % static_cast<std::size_t>(other_count->value) != 0)
                throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
            const std::size_t width = other->values.size() / static_cast<std::size_t>(other_count->value);
            if (width < 3) throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
            for (std::size_t sequence = 0; sequence < static_cast<std::size_t>(other_count->value); ++sequence) {
                for (std::size_t offset = 2; offset < width; ++offset) {
                    int& value = other->values[sequence * width + offset];
                    if (value < 1 || value > static_cast<int>(old_count))
                        throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
                    if (value == static_cast<int>(removed + 1)) {
                        value = replacement ? static_cast<int>(*replacement + 1) : 1;
                    } else if (value > static_cast<int>(removed + 1)) {
                        --value;
                    }
                }
            }
        }
        plate.settings_metadata = config_metadata_json(plate.settings);
    }
}

void validate_plate_filament_state(const BridgeState::PlateSessionPlate& plate,
                                   const std::size_t count,
                                   const int nozzle_count)
{
    for (const char* key : {"filament_map", "filament_nozzle_map", "filament_volume_map"}) {
        if (const auto* values = plate.settings.opt<ConfigOptionInts>(key)) {
            if (values->values.size() != count)
                throw FilamentCommandFailure("unsupported_reference", "malformed per-plate filament map");
            for (const int value : values->values)
                if (value < 0 || value > nozzle_count)
                    throw FilamentCommandFailure("unsupported_reference", "per-plate filament map is out of range");
        }
    }
    if (const auto* first = plate.settings.opt<ConfigOptionInts>("first_layer_print_sequence")) {
        if (!first->values.empty() && first->values.front() != 0)
            for (const int value : first->values)
                if (value < 1 || value > static_cast<int>(count))
                    throw FilamentCommandFailure("unsupported_reference", "malformed first-layer filament sequence");
    }
    const auto* other = plate.settings.opt<ConfigOptionInts>("other_layers_print_sequence");
    const auto* other_count = plate.settings.opt<ConfigOptionInt>("other_layers_print_sequence_nums");
    if ((other == nullptr) != (other_count == nullptr))
        throw FilamentCommandFailure("unsupported_reference", "incomplete per-plate layer sequence");
    if (other != nullptr) {
        if (other_count->value <= 0 || other->values.empty() ||
            other->values.size() % static_cast<std::size_t>(other_count->value) != 0)
            throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
        const std::size_t width = other->values.size() / static_cast<std::size_t>(other_count->value);
        if (width < 3) throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
        for (std::size_t sequence = 0; sequence < static_cast<std::size_t>(other_count->value); ++sequence)
            for (std::size_t offset = 2; offset < width; ++offset) {
                const int value = other->values[sequence * width + offset];
                if (value < 1 || value > static_cast<int>(count))
                    throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
            }
    }
}

void add_plate_filament_references(std::vector<BridgeState::PlateSessionPlate>& plates,
                                   const PresetBundle& bundle,
                                   const std::size_t old_count)
{
    int volume_type = 0;
    if (const auto* volumes = bundle.project_config.opt<ConfigOptionEnumsGeneric>("nozzle_volume_type");
        volumes != nullptr && !volumes->values.empty())
        volume_type = volumes->values.front() == 2 ? 0 : volumes->values.front(); // Hybrid is stored as Standard.
    for (auto& plate : plates) {
        if (auto* values = plate.settings.option<ConfigOptionInts>("filament_map")) {
            if (values->values.size() != old_count)
                throw FilamentCommandFailure("unsupported_reference", "malformed per-plate filament map");
            values->values.push_back(1);
        }
        if (auto* values = plate.settings.option<ConfigOptionInts>("filament_nozzle_map")) {
            if (values->values.size() != old_count)
                throw FilamentCommandFailure("unsupported_reference", "malformed per-plate filament map");
            values->values.push_back(0);
        }
        if (auto* values = plate.settings.option<ConfigOptionInts>("filament_volume_map")) {
            if (values->values.size() != old_count)
                throw FilamentCommandFailure("unsupported_reference", "malformed per-plate filament map");
            values->values.push_back(volume_type);
        }

        // Native Plater::on_filament_count_change calls
        // PartPlate::update_first_layer_print_sequence after on_filament_added.
        if (auto* first = plate.settings.option<ConfigOptionInts>("first_layer_print_sequence")) {
            if (!first->values.empty() && first->values.front() != 0) {
                for (const int value : first->values)
                    if (value < 1 || value > static_cast<int>(old_count))
                        throw FilamentCommandFailure("unsupported_reference", "malformed first-layer filament sequence");
                for (std::size_t slot = first->values.size(); slot < old_count + 1; ++slot)
                    first->values.push_back(static_cast<int>(slot + 1));
            }
        }
        auto* other = plate.settings.option<ConfigOptionInts>("other_layers_print_sequence");
        auto* other_count = plate.settings.option<ConfigOptionInt>("other_layers_print_sequence_nums");
        if ((other == nullptr) != (other_count == nullptr))
            throw FilamentCommandFailure("unsupported_reference", "incomplete per-plate layer sequence");
        if (other != nullptr) {
            if (other_count->value <= 0 || other->values.empty() ||
                other->values.size() % static_cast<std::size_t>(other_count->value) != 0)
                throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
            const std::size_t width = other->values.size() / static_cast<std::size_t>(other_count->value);
            if (width < 3) throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
            std::vector<int> rebuilt;
            rebuilt.reserve(other->values.size() + static_cast<std::size_t>(other_count->value));
            for (std::size_t sequence = 0; sequence < static_cast<std::size_t>(other_count->value); ++sequence) {
                const auto begin = other->values.begin() + static_cast<std::ptrdiff_t>(sequence * width);
                rebuilt.insert(rebuilt.end(), begin, begin + 2);
                for (std::size_t offset = 2; offset < width; ++offset) {
                    const int value = *(begin + static_cast<std::ptrdiff_t>(offset));
                    if (value < 1 || value > static_cast<int>(old_count))
                        throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
                    rebuilt.push_back(value);
                }
                const std::size_t orders = width - 2;
                for (std::size_t slot = orders; slot < old_count + 1; ++slot)
                    rebuilt.push_back(static_cast<int>(slot + 1));
            }
            other->values = std::move(rebuilt);
        }
        plate.settings_metadata = config_metadata_json(plate.settings);
    }
}

void remap_model_filament_references(Model& model, const std::size_t removed,
                                     const std::optional<std::size_t>& replacement,
                                     const std::size_t new_count)
{
    for (ModelObject* object : model.objects) {
        remap_config_filament_references(object->config, removed, replacement);
        for (ModelVolume* volume : object->volumes) {
            remap_config_filament_references(volume->config, removed, replacement);
            // The native MM painting selector stores 1-based enforcer IDs and
            // has its own deletion/remap operation.  Keep it in the staged
            // model so imported painting cannot retain a dangling reference.
            volume->update_extruder_count_when_delete_filament(
                new_count, removed + 1,
                replacement.has_value() ? static_cast<int>(*replacement + 1) : 0);
        }
    }
    for (auto& [plate, info] : model.plates_custom_gcodes) {
        (void)plate;
        auto& gcodes = info.gcodes;
        for (auto it = gcodes.begin(); it != gcodes.end();) {
            if (it->extruder <= 0) { ++it; continue; }
            if (static_cast<std::size_t>(it->extruder - 1) == removed && !replacement.has_value()) {
                it = gcodes.erase(it);
                continue;
            }
            it->extruder = remap_filament_reference(it->extruder, removed, replacement);
            ++it;
        }
    }
}

struct FlushColour { unsigned char a = 255, r = 0, g = 0, b = 0; };

std::optional<FlushColour> parse_flush_colour(const std::string& value)
{
    if (!valid_filament_colour(value)) return std::nullopt;
    auto hex = [](const char c) -> unsigned char {
        if (c >= '0' && c <= '9') return static_cast<unsigned char>(c - '0');
        if (c >= 'a' && c <= 'f') return static_cast<unsigned char>(c - 'a' + 10);
        return static_cast<unsigned char>(c - 'A' + 10);
    };
    auto byte = [&](const std::size_t offset) -> unsigned char {
        return static_cast<unsigned char>((hex(value[offset]) << 4) | hex(value[offset + 1]));
    };
    FlushColour colour;
    if (value.size() == 9) {
        colour.a = byte(1); colour.r = byte(3); colour.g = byte(5); colour.b = byte(7);
    } else {
        colour.r = byte(1); colour.g = byte(3); colour.b = byte(5);
    }
    return colour;
}

std::vector<FlushColour> flush_colours_for_slot(const std::string& base,
                                                const std::string& multi)
{
    std::vector<FlushColour> result;
    std::istringstream stream(multi.empty() ? base : multi);
    std::string item;
    while (stream >> item)
        if (const auto colour = parse_flush_colour(item)) result.push_back(*colour);
    if (result.empty())
        if (const auto colour = parse_flush_colour(base)) result.push_back(*colour);
    if (result.empty()) result.push_back({});
    return result;
}

std::vector<std::vector<int>> min_flush_volumes_for_config(const DynamicPrintConfig& full,
                                                           const std::size_t filament_count,
                                                           const std::size_t nozzle_count)
{
    std::vector<std::vector<int>> result(nozzle_count, std::vector<int>(filament_count, 0));
    const auto* nozzle_volume = full.opt<ConfigOptionFloatsNullable>("nozzle_volume");
    const auto* machine_level = full.opt<ConfigOptionInt>("enable_long_retraction_when_cut");
    const auto* machine_active = full.opt<ConfigOptionBools>("long_retractions_when_cut");
    const auto* filament_diameter = full.opt<ConfigOptionFloats>("filament_diameter");
    const auto* filament_retraction = full.opt<ConfigOptionFloats>("filament_retraction_distances_when_cut");
    const auto* filament_retraction_nullable = full.opt<ConfigOptionFloatsNullable>("filament_retraction_distances_when_cut");
    const auto* printer_retraction = full.opt<ConfigOptionFloats>("retraction_distances_when_cut");
    const auto* filament_active = full.opt<ConfigOptionBools>("filament_long_retractions_when_cut");
    const auto* filament_active_nullable = full.opt<ConfigOptionBoolsNullable>("filament_long_retractions_when_cut");
    const auto at_or = [](const auto* option, const std::size_t index, const auto fallback) {
        return option != nullptr && index < option->values.size() ? option->values[index] : fallback;
    };
    const auto filament_retraction_at = [&](const std::size_t index, const double fallback) {
        if (filament_retraction != nullptr && index < filament_retraction->values.size())
            return filament_retraction->values[index];
        return filament_retraction_nullable != nullptr && index < filament_retraction_nullable->values.size()
            ? filament_retraction_nullable->values[index] : fallback;
    };
    const auto filament_active_at = [&](const std::size_t index, const unsigned char fallback) {
        if (filament_active != nullptr && index < filament_active->values.size())
            return filament_active->values[index];
        return filament_active_nullable != nullptr && index < filament_active_nullable->values.size()
            ? filament_active_nullable->values[index] : fallback;
    };
    constexpr double default_retraction = 18.0;
    constexpr double filament_area = M_PI * 1.75 * 1.75 / 4.0;
    for (std::size_t nozzle = 0; nozzle < nozzle_count; ++nozzle) {
        const double nozzle_value = nozzle_volume != nullptr && nozzle < nozzle_volume->values.size()
            ? nozzle_volume->values[nozzle] : 0.0;
        const int nozzle_volume_value = std::isfinite(nozzle_value) ? static_cast<int>(nozzle_value) : 0;
        const int machine_enabled_level = machine_level == nullptr ? 0 : machine_level->value;
        const bool machine_activated = machine_active != nullptr && nozzle < machine_active->values.size() &&
            machine_active->values[nozzle];
        const double printer_distance = at_or(printer_retraction, nozzle, default_retraction);
        for (std::size_t filament = 0; filament < filament_count; ++filament) {
            int retract_length = machine_enabled_level && machine_activated
                ? static_cast<int>(printer_distance) : 0;
            const unsigned char filament_enabled = filament_active_at(filament, static_cast<unsigned char>(0));
            const double filament_distance = filament_retraction_at(filament, default_retraction);
            if (filament_enabled == 0) {
                retract_length = 0;
            } else if (filament_enabled == 1 && machine_enabled_level == LongRectrationLevel::EnableFilament) {
                retract_length = std::isnan(filament_distance)
                    ? static_cast<int>(printer_distance) : static_cast<int>(filament_distance);
            }
            result[nozzle][filament] = static_cast<int>(
                static_cast<double>(nozzle_volume_value) - filament_area * retract_length);
        }
    }
    return result;
}

std::vector<std::vector<int>> min_flush_volumes_for_bundle(const PresetBundle& bundle,
                                                           const std::size_t filament_count,
                                                           const std::size_t nozzle_count)
{
    return min_flush_volumes_for_config(bundle.full_config(), filament_count, nozzle_count);
}

void recalculate_filament_flush(PresetBundle& bundle)
{
    auto* matrix = bundle.project_config.option<ConfigOptionFloats>("flush_volumes_matrix", true);
    if (matrix == nullptr) throw FilamentCommandFailure("native_validation_failure", "native flush matrix is unavailable");
    const std::size_t count = bundle.filament_presets.size();
    const std::size_t nozzles = std::max(1, bundle.get_printer_extruder_count());
    const auto* colours = bundle.project_config.opt<ConfigOptionStrings>("filament_colour");
    if (colours == nullptr || colours->values.size() != count)
        throw FilamentCommandFailure("native_validation_failure", "native filament colours are unavailable");
    const auto* multi = bundle.project_config.opt<ConfigOptionStrings>("filament_multi_colour");
    const auto* support = bundle.project_config.opt<ConfigOptionBools>("filament_is_support");
    const auto* datasets = bundle.project_config.opt<ConfigOptionIntsNullable>("nozzle_flush_dataset");
    const auto min_flush = min_flush_volumes_for_bundle(bundle, count, nozzles);
    const auto colour_sets = [&]() {
        std::vector<std::vector<FlushColour>> sets;
        sets.reserve(count);
        for (std::size_t index = 0; index < count; ++index) {
            const std::string multi_value = multi != nullptr && index < multi->values.size()
                ? multi->values[index] : std::string{};
            sets.push_back(flush_colours_for_slot(colours->values[index], multi_value));
        }
        return sets;
    }();

    matrix->values.assign(count * count * nozzles, 0.0);
    for (std::size_t nozzle = 0; nozzle < nozzles; ++nozzle) {
        const int dataset = datasets != nullptr && !datasets->values.empty()
            ? datasets->get_at(nozzle) : 0;
        const bool has_support = support != nullptr && support->values.size() == count;
        for (std::size_t from = 0; from < count; ++from) {
            for (std::size_t to = 0; to < count; ++to) {
                if (from == to) continue;
                int flushing = 0;
                const bool from_support = has_support && support->get_at(from);
                const bool to_support = has_support && support->get_at(to);
                if (to_support) {
                    flushing = Slic3r::g_flush_volume_to_support;
                } else {
                    FlushVolCalculator calculator(min_flush[nozzle][from], Slic3r::g_max_flush_volume, dataset);
                    for (const auto& source : colour_sets[from])
                        for (const auto& destination : colour_sets[to])
                            flushing = std::max(flushing, calculator.calc_flush_vol(
                                source.a, source.r, source.g, source.b,
                                destination.a, destination.r, destination.g, destination.b));
                    if (from_support)
                        flushing = std::max(flushing, Slic3r::g_min_flush_volume_from_support);
                }
                matrix->values[nozzle * count * count + from * count + to] = flushing;
            }
        }
    }
}

void validate_filament_candidate_components(const std::vector<std::string>& filament_presets,
                                            const DynamicPrintConfig& project,
                                            const DynamicPrintConfig& printer,
                                            const int nozzle_count,
                                            const bool flexible_slots,
                                            Model& model,
                                            const std::vector<BridgeState::PlateSessionPlate>& plates,
                                            const json& overlay,
                                            const bool strict_slot_arrays,
                                            const bool require_all_slot_arrays)
{
    if (filament_presets.empty() || filament_presets.size() > 64)
        throw std::runtime_error("native filament slot count is invalid");
    for (const char* key : {"filament_colour", "filament_multi_colour", "filament_colour_type",
                            "filament_map", "filament_volume_map", "filament_nozzle_map",
                            "filament_map_2", "filament_self_index", "filament_extruder_variant"}) {
        if (strict_slot_arrays || require_all_slot_arrays) if (const auto* option = project.option(key)) {
            const auto* vector_option = dynamic_cast<const ConfigOptionVectorBase*>(option);
            if (vector_option == nullptr) continue;
            const auto size = vector_option->size();
            const bool invalid_size = require_all_slot_arrays
                ? size != filament_presets.size()
                : (flexible_slots && size != 0 && size != filament_presets.size());
            if (invalid_size)
                throw std::runtime_error(std::string("native filament array has invalid length: ") + key);
        }
    }
    if (require_all_slot_arrays) {
        const auto validate_matrix = [&](const DynamicPrintConfig& config) {
            const auto* option = config.option("flush_volumes_matrix");
            if (option == nullptr) return;
            const auto values = config_floats(config, "flush_volumes_matrix");
            const std::size_t plane_size = filament_presets.size() * filament_presets.size();
            if (plane_size == 0 || values.empty() || values.size() % plane_size != 0 ||
                values.size() / plane_size != static_cast<std::size_t>(nozzle_count))
                throw std::runtime_error("native flush matrix has invalid slot dimensions");
            if (std::any_of(values.begin(), values.end(), [](double value) { return !std::isfinite(value); }))
                throw std::runtime_error("native flush matrix contains invalid values");
        };
        validate_matrix(project);
        if (project.option("flush_volumes_matrix") == nullptr)
            validate_matrix(printer);
    }
    const auto validate_config_references = [&](const auto& config) {
        for (const auto& key : config.keys()) {
            if (!is_filament_slot_reference_key(key)) continue;
            const auto* option = dynamic_cast<const ConfigOptionInt*>(config.option(key));
            if (option != nullptr && (option->value < 0 || option->value > static_cast<int>(filament_presets.size())))
                throw FilamentCommandFailure("unsupported_reference", "model filament reference exceeds slots");
        }
    };
    for (const ModelObject* object : model.objects) {
        validate_config_references(object->config);
        for (const ModelVolume* volume : object->volumes) {
            validate_config_references(volume->config);
            const ConfigOption* extruder = volume->config.option("extruder");
            if (extruder == nullptr || extruder->getInt() == 0)
                extruder = object->config.option("extruder");
            const int effective_extruder = extruder == nullptr ? 1 : extruder->getInt();
            if (effective_extruder > static_cast<int>(filament_presets.size()))
                throw FilamentCommandFailure("unsupported_reference", "model effective filament reference exceeds slots");
        }
    }
    if (!valid_project_config_overlay(overlay))
        throw FilamentCommandFailure("unsupported_reference", "invalid staged project configuration overlay");
    const auto validate_overlay_values = [&](const json& values) {
        if (!values.is_object()) return;
        for (const auto& [key, value] : values.items()) {
            if (!is_filament_slot_reference_key(key)) continue;
            if (!value.is_string())
                throw FilamentCommandFailure("unsupported_reference", "invalid filament reference in project overlay");
            try {
                const int reference = std::stoi(value.get<std::string>());
                if (reference < 0 || reference > static_cast<int>(filament_presets.size()))
                    throw FilamentCommandFailure("unsupported_reference", "project overlay reference exceeds slots");
            } catch (const FilamentCommandFailure&) { throw; }
            catch (...) {
                throw FilamentCommandFailure("unsupported_reference", "invalid filament reference in project overlay");
            }
        }
    };
    validate_overlay_values(overlay["project"]);
    for (const char* scope : {"objects", "parts", "plates"})
        for (const auto& [id, values] : overlay[scope].items()) validate_overlay_values(values);
    for (const auto& plate : plates) {
        validate_plate_filament_state(plate, filament_presets.size(), nozzle_count);
        for (const auto& key : plate.settings.keys()) {
            if (!is_filament_slot_reference_key(key)) continue;
            const auto* option = dynamic_cast<const ConfigOptionInt*>(plate.settings.option(key));
            if (option != nullptr && (option->value < 0 || option->value > static_cast<int>(filament_presets.size())))
                throw FilamentCommandFailure("unsupported_reference", "staged plate reference exceeds filament slots");
        }
    }
    (void)nozzle_count;
}

void validate_filament_candidate(PresetBundle& bundle, Model& model,
                                 const std::vector<BridgeState::PlateSessionPlate>& plates,
                                 const json& overlay,
                                 const bool strict_slot_arrays,
                                 const bool require_all_slot_arrays)
{
    const auto& printer = bundle.printers.get_edited_preset().config;
    validate_filament_candidate_components(bundle.filament_presets, bundle.project_config, printer,
        std::max(1, bundle.get_printer_extruder_count()),
        printer.opt_bool("single_extruder_multi_material") || bundle.is_bbl_vendor(),
        model, plates, overlay, strict_slot_arrays, require_all_slot_arrays);
}

json filament_mutation_result(const json& mutation)
{
    return { {"ok", true}, {"version", 1},
             {"result", {{"snapshot", filament_snapshot_json()}, {"mutation", mutation}}} };
}

template <typename Mutator>
json run_filament_mutation(const json& request, const char* label, Mutator mutator)
{
    const auto before_next_filament_colour_index = state().next_filament_colour_index;
    try {
        if (!request.is_object() || !request.contains("version") ||
            !request["version"].is_number_unsigned() || request["version"].get<unsigned>() != 1)
            return command_error("invalid_command", "unsupported filament command version");
        if (state().active_history_transaction)
            return command_error("history_transaction_active", "filament command cannot run inside another history transaction");
        const auto before_snapshot = filament_snapshot_json();
        if (!before_snapshot.value("ok", false)) return before_snapshot;
        const auto before_context = default_command_history_context();
        // The retained current entry is the authoritative pre-command model.
        // Reusing its immutable history representation avoids serializing the
        // entire native model again for every small filament edit; the post-
        // command frame below is still serialized before it is committed.
        const auto before_history_model = state().history.entries().empty()
            ? Neo::History::Codec::capture_model_state(state().model) : state().history.current().model;
        const bool needs_predecessor_direct = state().history.entries().empty() ||
            !state().history.current().direct_frame.has_value();
        std::shared_ptr<const Model> direct_before_model = current_direct_frame_model(state());
        if (!direct_before_model) direct_before_model = std::make_shared<Model>(state().model);
        const auto predecessor_direct = needs_predecessor_direct
            ? make_direct_frame(state(), direct_before_model, before_history_model)
            : std::optional<Neo::History::RestoreState::DirectFrame>{};
        if (!request.contains("revision") || !request["revision"].is_number_unsigned())
            return command_error("stale_revision", "filament session revision is required");
        const auto expected = request["revision"].get<std::uint64_t>();
        if (expected != before_snapshot["revisions"]["session"].get<std::uint64_t>())
            return command_error("stale_revision", "filament session revision is stale");

        // The preset catalogue is immutable during a project session.  Never
        // copy PresetBundle in a history-producing mutation: retain only the
        // exact mutable filament fields which may need atomic rollback.
        const auto before_filament_presets = state().presets.filament_presets;
        const auto before_project_config = state().presets.project_config;
        const auto before_ams_colours = state().presets.ams_multi_color_filment;
        const auto before_edited_filament = state().presets.filaments.get_edited_preset();
        Model before_model = state().model;
        const auto before_plates = state().plate_session_plates;
        const auto before_overlay = state().project_config_overlay;
        const auto before_plate_revisions = state().plate_input_revisions;
        const auto before_membership = state().instance_plate_ids;
        const auto before_out_of_bounds = state().plate_out_of_bounds_ids;
        const auto before_parked = state().parked_instance_ids;
        const auto before_pending = state().pending_membership_instance_ids;
        const auto before_current_plate = state().current_plate_id;
        const auto old_count = state().presets.filament_presets.size();
        bool mutated = false;
        bool history_committed = false;
        const auto rollback_published = [&]() {
            if (!mutated || history_committed) return;
            state().presets.filament_presets = before_filament_presets;
            state().presets.project_config = before_project_config;
            state().presets.ams_multi_color_filment = before_ams_colours;
            state().presets.filaments.get_edited_preset() = before_edited_filament;
            state().model = before_model;
            state().plate_session_plates = before_plates;
            state().project_config_overlay = before_overlay;
            state().plate_input_revisions = before_plate_revisions;
            state().instance_plate_ids = before_membership;
            state().plate_out_of_bounds_ids = before_out_of_bounds;
            state().parked_instance_ids = before_parked;
            state().pending_membership_instance_ids = before_pending;
            state().current_plate_id = before_current_plate;
            state().next_filament_colour_index = before_next_filament_colour_index;
        };
        json mutation;
        try {
            mutated = true;
            mutation = mutator(state().presets, state().model, state().plate_session_plates,
                               state().project_config_overlay, old_count);
            if (request.value("inject_failure", false)) {
                rollback_published();
                return command_error("native_validation_failure", "injected native validation failure");
            }
            validate_filament_candidate(state().presets, state().model, state().plate_session_plates,
                                        state().project_config_overlay);
            // Commit the fieldwise staged native session as one Worker
            // operation. The projection is the final validation, so malformed
            // native arrays can never be published to the client.
            // Filament configuration is shared by every plate.  Invalidate all
            // plate results in the authoritative Worker state before publishing
            // the post-command snapshot; the renderer must not infer this from
            // whichever plate happens to be selected.
            ensure_plate_session_state();
            for (const auto& plate_id : all_plate_ids()) ++state().plate_input_revisions[plate_id];
            const auto final_snapshot = filament_snapshot_json();
            if (!final_snapshot.value("ok", false)) {
                rollback_published();
                return final_snapshot;
            }
            auto context = default_command_history_context();
            // The model may be unchanged for a pure slot edit.  Include the
            // authoritative filament revision in the history context so ProjectHistory
            // records exactly one semantic project mutation instead of coalescing
            // the command away as an identical model/context snapshot.
            context["filamentSessionRevision"] = state().history_revision + 1;
            const auto encoded = context.dump();
            const Neo::History::Bytes bytes(encoded.begin(), encoded.end());
            const auto failure_stage = request.value("inject_failure_stage", "");
            if (failure_stage == "before-history") {
                rollback_published();
                return command_error("native_validation_failure", "injected late native validation failure");
            }
            if (failure_stage == "during-history")
                throw std::runtime_error("injected history commit failure");
            const auto after_history_model = Neo::History::Codec::capture_model_state(state().model);
            const auto direct_frame = make_direct_frame(
                state(), std::make_shared<Model>(state().model), after_history_model);
            const bool committed = [&]() {
                if (!state().history.entries().empty())
                    return state().history.commit(label, Neo::History::Category::Project,
                                                  after_history_model, bytes, direct_frame,
                                                  predecessor_direct);
                const auto baseline_encoded = before_context.dump();
                const Neo::History::Bytes baseline_bytes(baseline_encoded.begin(), baseline_encoded.end());
                return state().history.commit_with_baseline(
                    label, Neo::History::Category::Project,
                    before_history_model, baseline_bytes, after_history_model, bytes,
                    predecessor_direct, direct_frame);
            }();
            if (!committed) {
                rollback_published();
                return command_error("native_validation_failure", "history commit rejected filament mutation");
            }
            history_committed = true;
        } catch (...) {
            if (!history_committed) rollback_published();
            throw;
        }
        state().history_revision++;
        state().print.clear();
        invalidate_preview_source();
        mutation["history_entry_delta"] = 1;
        mutation["revision_before"] = expected;
        mutation["revision_after"] = state().history_revision;
        mutation["dirty"] = state().history.project_modified();
        mutation["all_plate_results_invalidated"] = true;
        return filament_mutation_result(mutation);
    } catch (const FilamentCommandFailure& e) {
        state().next_filament_colour_index = before_next_filament_colour_index;
        return command_error(e.code, e.what());
    } catch (const std::exception& e) {
        state().next_filament_colour_index = before_next_filament_colour_index;
        return command_error("native_validation_failure", e.what());
    } catch (...) {
        state().next_filament_colour_index = before_next_filament_colour_index;
        return command_error("native_validation_failure", "unknown native validation failure");
    }
}

// Add/delete only touch a small, well-defined part of PresetBundle.  The
// generic transaction above intentionally stages the complete installed
// preset graph, which is the right safety boundary for arbitrary commands but
// makes a single slot edit pay for several deep copies.  Keep the same
// validation, snapshot, history, and rollback protocol while applying these
// two mutations in place and retaining only the fields they can change.
template <typename Mutator>
json run_filament_slot_mutation(const json& request, const char* label, const bool model_changes, Mutator mutator)
{
    const auto before_next_filament_colour_index = state().next_filament_colour_index;
    try {
        if (!request.is_object() || !request.contains("version") ||
            !request["version"].is_number_unsigned() || request["version"].get<unsigned>() != 1)
            return command_error("invalid_command", "unsupported filament command version");
        if (state().active_history_transaction)
            return command_error("history_transaction_active", "filament command cannot run inside another history transaction");
        const auto before_snapshot = filament_snapshot_json();
        if (!before_snapshot.value("ok", false)) return before_snapshot;
        const auto before_context = default_command_history_context();
        const auto before_history_model = state().history.entries().empty()
            ? Neo::History::Codec::capture_model_state(state().model) : state().history.current().model;
        if (!request.contains("revision") || !request["revision"].is_number_unsigned())
            return command_error("stale_revision", "filament session revision is required");
        const auto expected = request["revision"].get<std::uint64_t>();
        if (expected != before_snapshot["revisions"]["session"].get<std::uint64_t>())
            return command_error("stale_revision", "filament session revision is stale");

        const auto before_filament_presets = state().presets.filament_presets;
        const auto before_project_config = state().presets.project_config;
        const auto before_ams_colours = state().presets.ams_multi_color_filment;
        const auto before_edited_filament = state().presets.filaments.get_edited_preset();
        std::shared_ptr<const Model> before_model;
        if (model_changes) before_model = std::make_shared<Model>(state().model);
        const auto before_plates = state().plate_session_plates;
        const auto before_overlay = state().project_config_overlay;
        const auto before_plate_revisions = state().plate_input_revisions;
        const auto before_membership = state().instance_plate_ids;
        const auto before_out_of_bounds = state().plate_out_of_bounds_ids;
        const auto before_parked = state().parked_instance_ids;
        const auto before_pending = state().pending_membership_instance_ids;
        const auto before_current_plate = state().current_plate_id;
        const auto& current_history = state().history.current();
        const bool needs_predecessor_direct = state().history.entries().empty() ||
            !current_history.direct_frame.has_value();
        std::shared_ptr<const Model> direct_before_model = current_direct_frame_model(state());
        if (!direct_before_model)
            direct_before_model = before_model ? before_model : std::make_shared<Model>(state().model);
        const auto predecessor_direct = needs_predecessor_direct
            ? make_direct_frame(state(), direct_before_model, before_history_model)
            : std::optional<Neo::History::RestoreState::DirectFrame>{};

        bool mutated = false;
        bool history_committed = false;
        const auto rollback = [&]() {
            if (!mutated || history_committed) return;
            state().presets.filament_presets = before_filament_presets;
            state().presets.project_config = before_project_config;
            state().presets.ams_multi_color_filment = before_ams_colours;
            state().presets.filaments.get_edited_preset() = before_edited_filament;
            if (before_model) state().model = *before_model;
            state().plate_session_plates = before_plates;
            state().project_config_overlay = before_overlay;
            state().plate_input_revisions = before_plate_revisions;
            state().instance_plate_ids = before_membership;
            state().plate_out_of_bounds_ids = before_out_of_bounds;
            state().parked_instance_ids = before_parked;
            state().pending_membership_instance_ids = before_pending;
            state().current_plate_id = before_current_plate;
            state().next_filament_colour_index = before_next_filament_colour_index;
        };

        try {
            mutated = true;
            const auto old_count = state().presets.filament_presets.size();
            json mutation = mutator(state().presets, state().model, state().plate_session_plates,
                                     state().project_config_overlay, old_count);
            if (request.value("inject_failure", false)) {
                rollback();
                return command_error("native_validation_failure", "injected native validation failure");
            }
            validate_filament_candidate(state().presets, state().model, state().plate_session_plates,
                                        state().project_config_overlay);
            ensure_plate_session_state();
            for (const auto& plate_id : all_plate_ids()) ++state().plate_input_revisions[plate_id];
            const auto final_snapshot = filament_snapshot_json();
            if (!final_snapshot.value("ok", false)) {
                rollback();
                return final_snapshot;
            }
            auto context = default_command_history_context();
            context["filamentSessionRevision"] = state().history_revision + 1;
            const auto encoded = context.dump();
            const Neo::History::Bytes bytes(encoded.begin(), encoded.end());
            const auto failure_stage = request.value("inject_failure_stage", "");
            if (failure_stage == "before-history") {
                rollback();
                return command_error("native_validation_failure", "injected late native validation failure");
            }
            if (failure_stage == "during-history")
                throw std::runtime_error("injected history commit failure");
            const auto after_history_model = Neo::History::Codec::capture_model_state(state().model);
            const auto direct_after_model = model_changes
                ? std::make_shared<Model>(state().model) : direct_before_model;
            const auto direct_frame = make_direct_frame(state(), direct_after_model,
                                                        after_history_model);
            const bool committed = [&]() {
                if (!state().history.entries().empty())
                    return state().history.commit(label, Neo::History::Category::Project,
                                                  after_history_model, bytes, direct_frame,
                                                  predecessor_direct);
                const auto baseline_encoded = before_context.dump();
                const Neo::History::Bytes baseline_bytes(baseline_encoded.begin(), baseline_encoded.end());
                return state().history.commit_with_baseline(
                    label, Neo::History::Category::Project,
                    before_history_model, baseline_bytes, after_history_model, bytes,
                    predecessor_direct, direct_frame);
            }();
            if (!committed) {
                rollback();
                return command_error("native_validation_failure", "history commit rejected filament mutation");
            }
            history_committed = true;
            state().history_revision++;
            state().print.clear();
            invalidate_preview_source();
            mutation["history_entry_delta"] = 1;
            mutation["revision_before"] = expected;
            mutation["revision_after"] = state().history_revision;
            mutation["dirty"] = state().history.project_modified();
            mutation["all_plate_results_invalidated"] = true;
            return filament_mutation_result(mutation);
        } catch (...) {
            rollback();
            throw;
        }
    } catch (const FilamentCommandFailure& e) {
        state().next_filament_colour_index = before_next_filament_colour_index;
        return command_error(e.code, e.what());
    } catch (const std::exception& e) {
        state().next_filament_colour_index = before_next_filament_colour_index;
        return command_error("native_validation_failure", e.what());
    } catch (...) {
        state().next_filament_colour_index = before_next_filament_colour_index;
        return command_error("native_validation_failure", "unknown native validation failure");
    }
}

const char* restore_filament_rack_command(const char* request_cstr, const Runtime& runtime)
{
    RuntimeScope scope(runtime);
    try {
        const json request = request_cstr && *request_cstr ? json::parse(request_cstr) : json::object();
        if (!request.is_object() || request.value("version", 0) != 1 || !request.contains("revision") ||
            !request["revision"].is_number_unsigned() || !request.contains("slots") ||
            !request["slots"].is_array() || request["slots"].empty() || request["slots"].size() > 64)
            return duplicate_json(command_error("invalid_command", "invalid remembered filament rack").dump());
        return duplicate_json(run_filament_mutation(request, "Restore remembered filament rack",
            [&](PresetBundle& bundle, Model&, std::vector<BridgeState::PlateSessionPlate>&,
                json&, std::size_t) -> json {
                std::vector<std::string> colours;
                colours.reserve(request["slots"].size());
                bundle.set_num_filaments(static_cast<unsigned int>(request["slots"].size()));
                for (std::size_t index = 0; index < request["slots"].size(); ++index) {
                    const auto& slot = request["slots"][index];
                    if (!slot.is_object() || !slot.contains("preset") || !slot["preset"].is_string() ||
                        slot["preset"].get<std::string>().empty() || !slot.contains("colour") || !slot["colour"].is_string())
                        throw FilamentCommandFailure("invalid_command", "invalid remembered filament slot");
                    const std::string preset = slot["preset"].get<std::string>();
                    if (bundle.filaments.find_preset(preset, false, true) == nullptr)
                        throw FilamentCommandFailure("incompatible_preset", "remembered filament preset is unavailable: " + preset);
                    bundle.set_filament_preset(index, preset);
                    colours.push_back(slot["colour"].get<std::string>());
                }
                bundle.project_config.set_key_value("filament_colour", new ConfigOptionStrings(colours));
                return json{{"restored_slots", colours.size()}, {"atomic", true}};
            }).dump());
    } catch (const std::exception& e) {
        return duplicate_json(command_error("invalid_command", e.what()).dump());
    } catch (...) {
        return duplicate_json(command_error("invalid_command", "invalid remembered filament rack").dump());
    }
}

struct FilamentAssignmentTarget {
    std::string kind;
    std::size_t id = 0;
};

static std::vector<FilamentAssignmentTarget> parse_assignment_targets(const json& request)
{
    const json* values = request.contains("targets") ? &request["targets"] : &request["target"];
    if (values == nullptr || (!values->is_array() && !values->is_object()))
        throw FilamentCommandFailure("invalid_command", "assignment targets are required");
    json array = values->is_array() ? *values : json::array({*values});
    std::vector<FilamentAssignmentTarget> result;
    std::set<std::pair<std::string, std::size_t>> seen;
    for (const auto& value : array) {
        if (!value.is_object() || !value.contains("kind") || !value["kind"].is_string() ||
            !value.contains("id") || !value["id"].is_number_unsigned() ||
            value["id"].get<std::uint64_t>() == 0 ||
            value["id"].get<std::uint64_t>() > std::numeric_limits<std::size_t>::max())
            throw FilamentCommandFailure("invalid_command", "invalid assignment target");
        const std::string kind = value["kind"].get<std::string>();
        const std::size_t id = value["id"].get<std::size_t>();
        if (!seen.emplace(kind, id).second) continue;
        result.push_back({kind, id});
    }
    if (result.empty()) throw FilamentCommandFailure("invalid_command", "assignment targets are empty");
    return result;
}

static ModelObject* find_object_by_id_in(Model& model, const std::size_t id)
{
    for (auto& object : model.objects) if (object->id().id == id) return object;
    return nullptr;
}

static ModelVolume* find_volume_by_id_in(Model& model, const std::size_t id)
{
    for (auto& object : model.objects)
        for (auto& volume : object->volumes)
            if (volume->id().id == id) return volume;
    return nullptr;
}

static ModelObject* owner_of_volume_in(Model& model, const std::size_t id)
{
    for (auto& object : model.objects)
        for (auto& volume : object->volumes)
            if (volume->id().id == id) return object;
    return nullptr;
}

static ModelObject* owner_of_instance_in(Model& model, const std::size_t id)
{
    for (auto& object : model.objects)
        for (auto& instance : object->instances)
            if (instance->id().id == id) return object;
    return nullptr;
}

static void collect_object_instance_ids(const Model& model, const std::set<std::size_t>& object_ids,
                                        std::set<std::size_t>& instance_ids)
{
    for (const auto* object : model.objects) {
        if (object_ids.find(object->id().id) == object_ids.end()) continue;
        for (const auto* instance : object->instances) instance_ids.insert(instance->id().id);
    }
}

template <typename Mutator>
json run_filament_assignment_mutation(const json& request, const char* label, Mutator mutator,
                                      const bool model_only = false)
{
    try {
        if (!request.is_object() || request.value("version", 0) != 1)
            return command_error("invalid_command", "unsupported filament assignment command version");
        if (state().active_history_transaction)
            return command_error("history_transaction_active", "filament assignment cannot run inside another history transaction");
        const auto before_snapshot = filament_snapshot_json();
        if (!before_snapshot.value("ok", false)) return before_snapshot;
        if (!request.contains("revision") || !request["revision"].is_number_unsigned() ||
            request["revision"].get<std::uint64_t>() != before_snapshot["revisions"]["session"].get<std::uint64_t>())
            return command_error("stale_revision", "filament session revision is stale");
        const auto before_context = default_command_history_context();
        const auto before_history_model = state().history.entries().empty()
            ? Neo::History::Codec::capture_model_state(state().model) : state().history.current().model;
        // Assignment and routing must use the live immutable profile
        // catalogue.  Support routing changes only project_config; preserve
        // that narrow mutable surface rather than cloning PresetBundle.
        const auto before_filament_presets = state().presets.filament_presets;
        const auto before_project_config = state().presets.project_config;
        const auto before_ams_colours = state().presets.ams_multi_color_filment;
        const auto before_edited_filament = state().presets.filaments.get_edited_preset();
        const auto restore_mutable_bundle = [&]() {
            state().presets.filament_presets = before_filament_presets;
            state().presets.project_config = before_project_config;
            state().presets.ams_multi_color_filment = before_ams_colours;
            state().presets.filaments.get_edited_preset() = before_edited_filament;
        };
        Model staged_model = state().model;
        auto staged_plates = state().plate_session_plates;
        auto staged_overlay = state().project_config_overlay;
        std::set<std::size_t> affected_objects;
        json mutation;
        try {
            mutation = mutator(state().presets, staged_model, staged_plates, staged_overlay, affected_objects);
            if (request.value("inject_failure", false) || request.value("inject_failure_stage", "") == "before-history") {
                restore_mutable_bundle();
                return command_error("native_validation_failure", "injected native validation failure");
            }
            validate_filament_candidate(state().presets, staged_model, staged_plates, staged_overlay);
        } catch (...) {
            restore_mutable_bundle();
            throw;
        }

        std::set<std::size_t> affected_instances;
        collect_object_instance_ids(state().model, affected_objects, affected_instances);
        const bool invalidate_all = mutation.value("invalidate_all_plates", false);
        const auto affected_plates = invalidate_all ? all_plate_ids() : member_plate_ids_for_instances(affected_instances);
        Model before_model = state().model;
        const auto before_plates = state().plate_session_plates;
        const auto before_overlay = state().project_config_overlay;
        const auto before_plate_revisions = state().plate_input_revisions;
        const auto before_membership = state().instance_plate_ids;
        const auto before_out_of_bounds = state().plate_out_of_bounds_ids;
        const auto before_parked = state().parked_instance_ids;
        const auto before_pending = state().pending_membership_instance_ids;
        const auto before_current_plate = state().current_plate_id;
        bool history_committed = false;
        const auto rollback = [&]() {
            if (history_committed) return;
            restore_mutable_bundle();
            state().model = before_model;
            state().plate_session_plates = before_plates;
            state().project_config_overlay = before_overlay;
            state().plate_input_revisions = before_plate_revisions;
            state().instance_plate_ids = before_membership;
            state().plate_out_of_bounds_ids = before_out_of_bounds;
            state().parked_instance_ids = before_parked;
            state().pending_membership_instance_ids = before_pending;
            state().current_plate_id = before_current_plate;
        };
        const bool needs_predecessor_direct = state().history.entries().empty() ||
            !state().history.current().direct_frame.has_value();
        std::shared_ptr<const Model> direct_before_model = current_direct_frame_model(state());
        if (!direct_before_model) direct_before_model = std::make_shared<Model>(state().model);
        const auto predecessor_direct = needs_predecessor_direct
            ? make_direct_frame(state(), direct_before_model, before_history_model)
            : std::optional<Neo::History::RestoreState::DirectFrame>{};
        try {
            state().model = std::move(staged_model);
            state().plate_session_plates = std::move(staged_plates);
            state().project_config_overlay = std::move(staged_overlay);
            ensure_plate_session_state();
            for (const auto& plate_id : affected_plates) ++state().plate_input_revisions[plate_id];
            auto context = default_command_history_context();
            context["filamentSessionRevision"] = state().history_revision + 1;
            const auto encoded = context.dump();
            const Neo::History::Bytes bytes(encoded.begin(), encoded.end());
            if (request.value("inject_failure_stage", "") == "during-history")
                throw std::runtime_error("injected history commit failure");
            const auto after_history_model = Neo::History::Codec::capture_model_state(state().model);
            const auto direct_frame = make_direct_frame(
                state(), std::make_shared<Model>(state().model), after_history_model);
            const bool committed = [&]() {
                if (!state().history.entries().empty())
                    return state().history.commit(label, Neo::History::Category::Project,
                                                  after_history_model, bytes, direct_frame,
                                                  predecessor_direct);
                const auto baseline_encoded = before_context.dump();
                const Neo::History::Bytes baseline_bytes(baseline_encoded.begin(), baseline_encoded.end());
                return state().history.commit_with_baseline(label, Neo::History::Category::Project,
                    before_history_model, baseline_bytes, after_history_model, bytes,
                    predecessor_direct, direct_frame);
            }();
            if (!committed) throw std::runtime_error("history commit rejected filament assignment");
            history_committed = true;
        } catch (...) {
            if (!history_committed) rollback();
            throw;
        }
        state().history_revision++;
        if (affected_plates.find(state().current_plate_id) != affected_plates.end()) {
            state().print.clear();
            invalidate_preview_source();
        }
        mutation["history_entry_delta"] = 1;
        mutation["revision_before"] = request["revision"];
        mutation["revision_after"] = state().history_revision;
        mutation["dirty"] = state().history.project_modified();
        mutation["affected_plate_ids"] = affected_plates;
        mutation["all_plate_results_invalidated"] = invalidate_all;
        mutation.erase("invalidate_all_plates");
        return filament_mutation_result(mutation);
    } catch (const FilamentCommandFailure& e) {
        return command_error(e.code, e.what());
    } catch (const std::exception& e) {
        return command_error("native_validation_failure", e.what());
    } catch (...) {
        return command_error("native_validation_failure", "unknown filament assignment failure");
    }
}

static int requested_assignment_slot(const json& request, const std::size_t slot_count, const bool allow_inherit)
{
    if (!request.contains("slot") || !request["slot"].is_number_integer())
        throw FilamentCommandFailure("invalid_command", "slot is required");
    const int slot = request["slot"].get<int>();
    if (slot == 0 && allow_inherit) return 0;
    if (slot < 1 || slot > static_cast<int>(slot_count))
        throw FilamentCommandFailure("unsupported_reference", "assignment slot is outside the ordered filament slots");
    return slot;
}

json assign_filament_command(const json& request, const Runtime& runtime)
{
    RuntimeScope scope(runtime);
    return run_filament_assignment_mutation(request, "Assign Filament", [&request](PresetBundle& bundle, Model& model,
        auto&, auto&, std::set<std::size_t>& affected_objects) {
        const auto targets = parse_assignment_targets(request);
        const int slot = requested_assignment_slot(request, bundle.filament_presets.size(), true);
        std::vector<FilamentAssignmentTarget> normalized;
        std::set<std::pair<std::string, std::size_t>> seen;
        for (const auto& target : targets) {
            ModelObject* object = nullptr;
            if (target.kind == "object") object = find_object_by_id_in(model, target.id);
            else if (target.kind == "instance" || target.kind == "instance-as-object") object = owner_of_instance_in(model, target.id);
            else if (target.kind == "model-part" || target.kind == "model_part" ||
                     target.kind == "parameter-modifier" || target.kind == "parameter_modifier") {
                const bool model_part_target = target.kind == "model-part" || target.kind == "model_part";
                auto* volume = find_volume_by_id_in(model, target.id);
                if (volume == nullptr || (model_part_target && volume->type() != ModelVolumeType::MODEL_PART) ||
                    (!model_part_target && volume->type() != ModelVolumeType::PARAMETER_MODIFIER))
                    throw FilamentCommandFailure("ineligible_target", "target volume is not eligible for filament assignment");
                object = owner_of_volume_in(model, target.id);
            } else {
                throw FilamentCommandFailure("ineligible_target", "target kind is not eligible for filament assignment");
            }
            if (object == nullptr) throw FilamentCommandFailure("ineligible_target", "assignment target was not found");
            if ((target.kind == "object" || target.kind == "instance" || target.kind == "instance-as-object") && slot == 0)
                throw FilamentCommandFailure("invalid_command", "object assignment cannot inherit");
            const std::string normalized_kind = (target.kind == "instance" || target.kind == "instance-as-object") ? "object" :
                (target.kind == "model_part" ? "model-part" : target.kind == "parameter_modifier" ? "parameter-modifier" : target.kind);
            const std::size_t normalized_id = normalized_kind == "object" ? object->id().id : target.id;
            if (seen.emplace(normalized_kind, normalized_id).second) {
                normalized.push_back({normalized_kind, normalized_id});
                affected_objects.insert(object->id().id);
            }
        }
        // Normalize ownership before mutating.  An owning object (including an
        // instance normalized to that object) dominates all descendant model
        // parts regardless of request order; parameter modifiers remain
        // independent and are preserved unless explicitly targeted.
        std::set<std::size_t> owning_objects;
        for (const auto& target : normalized)
            if (target.kind == "object") owning_objects.insert(target.id);
        std::vector<FilamentAssignmentTarget> effective_targets;
        for (const auto& target : normalized) {
            if (target.kind == "model-part") {
                const auto* owner = owner_of_volume_in(model, target.id);
                if (owner != nullptr && owning_objects.find(owner->id().id) != owning_objects.end()) continue;
            }
            effective_targets.push_back(target);
        }
        std::stable_sort(effective_targets.begin(), effective_targets.end(), [](const auto& left, const auto& right) {
            const auto rank = [](const std::string& kind) { return kind == "object" ? 0 : kind == "model-part" ? 1 : 2; };
            return rank(left.kind) < rank(right.kind);
        });
        json accepted = json::array();
        for (const auto& target : effective_targets) {
            const auto* owner = target.kind == "object" ? find_object_by_id_in(model, target.id) : owner_of_volume_in(model, target.id);
            accepted.push_back({{"kind", target.kind}, {"id", target.id}, {"object_id", owner->id().id}});
            if (target.kind == "object") {
                auto* object = find_object_by_id_in(model, target.id);
                object->config.set_key_value("extruder", new ConfigOptionInt(slot));
                for (auto* volume : object->volumes)
                    if (volume->type() == ModelVolumeType::MODEL_PART) volume->config.erase("extruder");
            } else {
                auto* volume = find_volume_by_id_in(model, target.id);
                if (slot == 0) volume->config.erase("extruder");
                else volume->config.set_key_value("extruder", new ConfigOptionInt(slot));
            }
        }
        return json{{"kind", "assign"}, {"accepted_targets", accepted}, {"slot", slot}};
    });
}

static const char* routing_key_for_selector(const std::string& selector)
{
    static const std::map<std::string, const char*> keys = {
        {"support-base", "support_filament"}, {"support-interface", "support_interface_filament"},
        {"outer-wall", "outer_wall_filament_id"}, {"inner-wall", "inner_wall_filament_id"},
        {"sparse-infill", "sparse_infill_filament_id"}, {"internal-solid-infill", "internal_solid_filament_id"},
        {"top-surface", "top_surface_filament_id"}, {"bottom-surface", "bottom_surface_filament_id"},
    };
    const auto it = keys.find(selector);
    return it == keys.end() ? nullptr : it->second;
}

json set_filament_routing_command(const json& request, const Runtime& runtime)
{
    RuntimeScope scope(runtime);
    const std::string requested_selector = request.value("selector", "");
    const bool model_only = requested_selector != "support-base" && requested_selector != "support-interface";
    return run_filament_assignment_mutation(request, "Set Filament Routing", [&request](PresetBundle& bundle, Model& model,
        auto&, auto&, std::set<std::size_t>& affected_objects) {
        if (!request.contains("selector") || !request["selector"].is_string())
            throw FilamentCommandFailure("invalid_command", "routing selector is required");
        const std::string selector = request["selector"].get<std::string>();
        const char* key = routing_key_for_selector(selector);
        if (key == nullptr) throw FilamentCommandFailure("invalid_command", "unsupported filament routing selector");
        const bool feature_selector = selector != "support-base" && selector != "support-interface";
        const int slot = request.contains("slot") && request["slot"].is_number_integer() ? request["slot"].get<int>() : -1;
        if (slot < 0 || slot > static_cast<int>(bundle.filament_presets.size()))
            throw FilamentCommandFailure("unsupported_reference", "routing slot is outside the ordered filament slots");
        const auto targets = request.contains("targets") ? request["targets"] : request.value("target", json::object());
        const json array = targets.is_array() ? targets : json::array({targets});
        if (array.empty()) throw FilamentCommandFailure("invalid_command", "routing targets are required");
        json accepted = json::array();
        std::set<std::pair<std::string, std::size_t>> seen;
        bool invalidate_all = false;
        for (const auto& target : array) {
            if (!target.is_object() || !target.contains("kind") || !target["kind"].is_string())
                throw FilamentCommandFailure("invalid_command", "invalid routing target");
            const std::string kind = target["kind"].get<std::string>();
            const bool project_kind = kind == "project";
            if (project_kind) {
                if (target.contains("id") &&
                    (!target["id"].is_number_unsigned() || target["id"].get<std::uint64_t>() != 0))
                    throw FilamentCommandFailure("invalid_command", "project routing target id must be zero");
            } else if (!target.contains("id") || !target["id"].is_number_unsigned() ||
                       target["id"].get<std::uint64_t>() == 0 ||
                       target["id"].get<std::uint64_t>() > std::numeric_limits<std::size_t>::max()) {
                throw FilamentCommandFailure("invalid_command", "routing target id is invalid");
            }
            const std::size_t id = project_kind ? 0 : target["id"].get<std::size_t>();
            bool project_target = false;
            ModelVolume* volume = nullptr;
            ModelObject* owner = nullptr;
            const std::string normalized_kind = kind == "model_part" ? "model-part" : kind;
            if (normalized_kind == "project") {
                if (feature_selector) throw FilamentCommandFailure("ineligible_target", "feature routing does not support project scope");
                project_target = true;
            } else if (normalized_kind == "object") {
                owner = find_object_by_id_in(model, id);
            } else if (normalized_kind == "model-part") {
                if (!feature_selector) throw FilamentCommandFailure("ineligible_target", "support routing does not support model-part scope");
                volume = find_volume_by_id_in(model, id); owner = owner_of_volume_in(model, id);
            } else {
                throw FilamentCommandFailure("ineligible_target", "routing target is not eligible");
            }
            if (!project_target && normalized_kind == "object" && owner == nullptr) throw FilamentCommandFailure("ineligible_target", "routing target was not found");
            if (!project_target && normalized_kind == "model-part" && (owner == nullptr || volume == nullptr || volume->type() != ModelVolumeType::MODEL_PART))
                throw FilamentCommandFailure("ineligible_target", "routing target was not found");
            if (normalized_kind == "object" || normalized_kind == "model-part") affected_objects.insert(owner ? owner->id().id : id);
            if (seen.emplace(normalized_kind, id).second) {
                if (project_target) bundle.project_config.set_key_value(key, new ConfigOptionInt(slot));
                else if (normalized_kind == "object") owner->config.set_key_value(key, new ConfigOptionInt(slot));
                else volume->config.set_key_value(key, new ConfigOptionInt(slot));
                accepted.push_back({{"kind", normalized_kind}, {"id", id}, {"object_id", owner ? owner->id().id : 0}});
                invalidate_all = invalidate_all || project_target;
            }
        }
        // Native support/raft filament selection changes the flushing input.
        // Recalculate only after every target has been accepted into the
        // staged bundle; the assignment transaction then publishes the full
        // matrix atomically with the routing mutation.  Feature-path routing
        // does not affect flushing volumes.
        if (!feature_selector) recalculate_filament_flush(bundle);
        return json{{"kind", "routing"}, {"selector", selector}, {"slot", slot},
                    {"accepted_targets", accepted}, {"invalidate_all_plates", invalidate_all}};
    }, model_only);
}

json select_filament_slot_preset_command(const json& request, const Runtime& runtime)
{
    RuntimeScope scope(runtime);
    return run_filament_mutation(request, "Select Filament Preset", [&request](PresetBundle& bundle, Model&, auto&, auto&, std::size_t count) {
        std::string error;
        const auto slot = filament_command_slot(request, "slot", count, error);
        if (!slot) throw FilamentCommandFailure("unsupported_reference", error);
        if (!request.contains("preset") || !request["preset"].is_string()) throw FilamentCommandFailure("invalid_command", "preset is required");
        const std::string name = request["preset"].get<std::string>();
        const Preset* preset = bundle.filaments.find_preset(name, false, true);
        if (preset == nullptr || !preset->is_visible || !preset->is_compatible)
            throw FilamentCommandFailure("unsupported_reference", "unsupported filament preset reference");
        const auto user_override = user_filament_colour_override(bundle, *slot);
        bundle.set_filament_preset(*slot, name);
        auto* colours = bundle.project_config.option<ConfigOptionStrings>("filament_colour", true);
        colours->values.resize(count, "#26A69A");
        colours->values[*slot] = user_override.value_or(filament_preset_colour(bundle, *slot));
        if (auto* multi = bundle.project_config.option<ConfigOptionStrings>("filament_multi_colour", true)) {
            multi->values.resize(count, "#26A69A");
            multi->values[*slot] = colours->values[*slot];
        }
        recalculate_filament_flush(bundle);
        return json{{"kind", "select-preset"}, {"slot", *slot + 1}, {"preset", name}};
    });
}

json set_filament_slot_colour_command(const json& request, const Runtime& runtime)
{
    RuntimeScope scope(runtime);
    return run_filament_mutation(request, "Edit Filament Colour", [&request](PresetBundle& bundle, Model&, auto&, auto&, std::size_t count) {
        std::string error;
        const auto slot = filament_command_slot(request, "slot", count, error);
        if (!slot) throw FilamentCommandFailure("unsupported_reference", error);
        if (!request.contains("colour") || !request["colour"].is_string() ||
            !valid_filament_colour(request["colour"].get<std::string>()))
            throw FilamentCommandFailure("native_validation_failure", "native filament colour validation failed");
        auto* colours = bundle.project_config.option<ConfigOptionStrings>("filament_colour", true);
        colours->values.resize(count, "#26A69A");
        colours->values[*slot] = request["colour"].get<std::string>();
        if (auto* multi = bundle.project_config.option<ConfigOptionStrings>("filament_multi_colour", true)) {
            multi->values.resize(count, "#26A69A");
            multi->values[*slot] = colours->values[*slot];
        }
        recalculate_filament_flush(bundle);
        return json{{"kind", "set-colour"}, {"slot", *slot + 1}, {"colour", colours->values[*slot]}};
    });
}

static constexpr std::array<const char*, 16> kNativeFilamentColours = {
    "#00C1AE", "#F4E2C1", "#ED1C24", "#00FF7F",
    "#F26722", "#FFEB31", "#7841CE", "#115877",
    "#ED1E79", "#2EBDEF", "#345B2F", "#800080",
    "#FA8173", "#800000", "#F7B763", "#A4C41E",
};

json add_filament_command(const json& request, const Runtime& runtime)
{
    RuntimeScope scope(runtime);
    return run_filament_slot_mutation(request, "Add Filament Slot", false,
        [](PresetBundle& bundle, Model&, auto& plates, auto&, std::size_t count) {
        const bool flexible = bundle.printers.get_edited_preset().config.opt_bool("single_extruder_multi_material") || bundle.is_bbl_vendor();
        if (!flexible || count >= 64) throw FilamentCommandFailure("capability_rejected", "filament slot capacity or capability rejected");
        const std::string colour = kNativeFilamentColours[state().next_filament_colour_index++ % kNativeFilamentColours.size()];
        bundle.set_num_filaments(static_cast<unsigned int>(count + 1), colour);
        auto* colours = bundle.project_config.option<ConfigOptionStrings>("filament_colour", true);
        colours->values.resize(count + 1, "#26A69A");
        colours->values[count] = colour;
        if (auto* multi = bundle.project_config.option<ConfigOptionStrings>("filament_multi_colour", true)) {
            multi->values.resize(count + 1, "#26A69A");
            multi->values[count] = colour;
        }
        add_plate_filament_references(plates, bundle, count);
        recalculate_filament_flush(bundle);
        return json{{"kind", "add"}, {"slot", count + 1}};
        });
}

json delete_or_merge_filament_command(const json& request, const bool merge, const Runtime& runtime)
{
    RuntimeScope scope(runtime);
    if (!merge)
        return run_filament_slot_mutation(request, "Delete Filament Slot", true,
            [request](PresetBundle& bundle, Model& model, auto& plates, auto& overlay, std::size_t count) {
            const bool flexible = bundle.printers.get_edited_preset().config.opt_bool("single_extruder_multi_material") || bundle.is_bbl_vendor();
            if (!flexible || count <= 1) throw FilamentCommandFailure("capability_rejected", "filament slot capability rejected");
            std::string error;
            const auto source = filament_command_slot(request, "slot", count, error);
            if (!source) throw FilamentCommandFailure("unsupported_reference", error);
            bundle.update_num_filaments(*source);
            remap_config_filament_references(bundle.project_config, *source, std::nullopt);
            remap_model_filament_references(model, *source, std::nullopt, count - 1);
            remap_plate_filament_references(plates, *source, std::nullopt, count);
            remap_overlay_filament_references(overlay, *source, std::nullopt);
            recalculate_filament_flush(bundle);
            return json{{"kind", "delete"}, {"source", *source + 1},
                        {"destination", nullptr}, {"slot_count", count - 1}};
        });
    return run_filament_mutation(request, merge ? "Merge Filament Slots" : "Delete Filament Slot",
        [request, merge](PresetBundle& bundle, Model& model, auto& plates, auto& overlay, std::size_t count) {
        const bool flexible = bundle.printers.get_edited_preset().config.opt_bool("single_extruder_multi_material") || bundle.is_bbl_vendor();
        if (!flexible || count <= 1) throw FilamentCommandFailure("capability_rejected", "filament slot capability rejected");
        std::string error;
        const auto source = filament_command_slot(request, merge ? "source" : "slot", count, error);
        if (!source) throw FilamentCommandFailure("unsupported_reference", error);
        std::optional<std::size_t> replacement;
        if (merge) {
            const auto destination = filament_command_slot(request, "destination", count, error);
            if (!destination || *destination == *source) throw FilamentCommandFailure("unsupported_reference", "unsupported filament reference");
            replacement = *destination > *source ? *destination - 1 : *destination;
        }
        bundle.update_num_filaments(*source);
        // Project-scoped support/feature routing lives in the native project
        // config rather than the renderer overlay.  Remap it before the
        // projection is rebuilt so Delete yields Default for zero-backed
        // routing and Merge points at the selected survivor.
        remap_config_filament_references(bundle.project_config, *source, replacement);
        remap_model_filament_references(model, *source, replacement, count - 1);
        remap_plate_filament_references(plates, *source, replacement, count);
        remap_overlay_filament_references(overlay, *source, replacement);
        recalculate_filament_flush(bundle);
        return json{{"kind", merge ? "merge" : "delete"}, {"source", *source + 1},
                    {"destination", replacement ? json(*replacement + 1) : json(nullptr)},
                    {"slot_count", count - 1}};
    });
}

} // namespace Slic3r::Neo::Bridge::FilamentCommands
