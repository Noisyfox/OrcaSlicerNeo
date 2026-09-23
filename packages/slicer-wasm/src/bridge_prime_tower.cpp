#include "bridge_prime_tower.hpp"
#include "bridge_preset_drafts.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <iomanip>
#include <iterator>
#include <limits>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include <emscripten/emscripten.h>

#include "bridge_filament.hpp"
#include "bridge_history.hpp"
#include "bridge_performance.hpp"
#include "bridge_plate.hpp"
#include "bridge_scoped_config.hpp"
#include "bridge_state.hpp"
#include "bridge_slicing_pipeline.hpp"
#include "libslic3r/GCode/WipeTower.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/PrintConfig.hpp"

using namespace Slic3r;

namespace Slic3r::Neo::Bridge::PrimeTower {

CoordinateSettingsSnapshot snapshot_coordinate_settings(const DynamicPrintConfig& settings,
                                                         std::size_t plate_index)
{
    const auto snapshot_value = [plate_index](const DynamicPrintConfig& config, const char* key) {
        CoordinateValue result;
        const auto* option = config.opt<ConfigOptionFloats>(key);
        if (option == nullptr) return result;
        result.option_present = true;
        if (plate_index < option->values.size() && std::isfinite(option->values[plate_index]))
            result.value = ConfigOptionFloat(option->values[plate_index]).serialize();
        return result;
    };
    CoordinateSettingsSnapshot snapshot;
    snapshot.x = snapshot_value(settings, "wipe_tower_x");
    snapshot.y = snapshot_value(settings, "wipe_tower_y");
    return snapshot;
}

namespace {

void restore_coordinate_option(DynamicPrintConfig& settings, const char* key,
                               const CoordinateValue& snapshot,
                               std::size_t plate_index, double fallback)
{
    if (!snapshot.option_present) {
        settings.erase(key);
        return;
    }
    auto* option = settings.option<ConfigOptionFloats>(key, true);
    if (snapshot.value && plate_index < option->values.size()) {
        try { option->values[plate_index] = std::stod(*snapshot.value); } catch (...) { option->values[plate_index] = fallback; }
    }
}

} // namespace

double coordinate_value(const DynamicPrintConfig& settings, const char* key,
                        std::size_t plate_index, double fallback)
{
    const auto* option = settings.opt<ConfigOptionFloats>(key);
    if (option == nullptr || option->values.empty() || plate_index >= option->values.size() ||
        !std::isfinite(option->values[plate_index])) return fallback;
    return option->values[plate_index];
}

void set_coordinate_option_value(DynamicPrintConfig& settings, const char* key,
                                  std::size_t plate_index, double value, double fallback)
{
    auto* option = settings.option<ConfigOptionFloats>(key, true);
    if (option->values.size() <= plate_index)
        throw std::runtime_error(std::string("prime tower coordinate array invariant failed for ") + key);
    option->values[plate_index] = value;
}

void set_coordinate_settings(DynamicPrintConfig& settings, std::size_t plate_index,
                             double x, double y, double fallback_x, double fallback_y)
{
    set_coordinate_option_value(settings, "wipe_tower_x", plate_index, x, fallback_x);
    set_coordinate_option_value(settings, "wipe_tower_y", plate_index, y, fallback_y);
}

void normalize_coordinate_settings(DynamicPrintConfig& settings, std::size_t plate_count,
                                   double fallback_x, double fallback_y)
{
    const auto normalize = [plate_count](DynamicPrintConfig& config, const char* key, double fallback) {
        auto* option = config.option<ConfigOptionFloats>(key, true);
        if (option->values.empty()) option->values.assign(plate_count, fallback);
        else if (option->values.size() < plate_count) option->values.resize(plate_count, option->values.front());
        else if (option->values.size() > plate_count) option->values.resize(plate_count);
    };
    normalize(settings, "wipe_tower_x", fallback_x);
    normalize(settings, "wipe_tower_y", fallback_y);
}

void restore_coordinate_settings(DynamicPrintConfig& settings,
                                 const CoordinateSettingsSnapshot& snapshot,
                                 std::size_t plate_index, double fallback_x, double fallback_y)
{
    restore_coordinate_option(settings, "wipe_tower_x", snapshot.x, plate_index, fallback_x);
    restore_coordinate_option(settings, "wipe_tower_y", snapshot.y, plate_index, fallback_y);
}

const char* duplicate_json(const std::string& value)
{
    char* out = static_cast<char*>(std::malloc(value.size() + 1));
    if (out == nullptr) return nullptr;
    std::memcpy(out, value.data(), value.size());
    out[value.size()] = '\0';
    return out;
}

namespace {

using Neo::Bridge::state;
using Neo::Bridge::PlateSession::ensure_plate_session_state;
using Neo::Bridge::PlateSession::find_plate_mutable;
using Neo::Bridge::PlateSession::make_current_plate_model;
using Neo::Bridge::PlateSession::plate_session_snapshot_json;
using Neo::Bridge::PlateSession::selected_plate_bounds;
using Neo::Bridge::PlateSession::PlateBounds;

constexpr double kVisibleHeight = 0.1;
constexpr double kBandOpacity = 0.66;

struct ProjectionPlateTimings {
    double effective_config_construction_ms { 0. };
    double plate_local_model_construction_ms { 0. };
    double used_slot_summary_hit_ms { 0. };
    double used_slot_summary_delta_ms { 0. };
    double used_slot_full_scan_fallback_ms { 0. };
    double used_slot_scan_ms { 0. };
    double printable_height_bounds_scan_ms { 0. };
    double direct_wipe_tower_estimate_ms { 0. };
    double print_apply_wipe_tower_data_fallback_ms { 0. };
    double footprint_bands_projection_json_ms { 0. };
    double total_ms { 0. };
};

struct ProjectionTimings {
    double session_preparation_ms { 0. };
    double bounds_scan_ms { 0. };
    std::vector<ProjectionPlateTimings> per_plate;
};

class ScopedTiming {
public:
    explicit ScopedTiming(double& destination) : m_destination(destination), m_started_at(Neo::Bridge::Performance::now_ms()) {}
    ~ScopedTiming() { m_destination += Neo::Bridge::Performance::now_ms() - m_started_at; }

private:
    double& m_destination;
    double m_started_at;
};

bool read_colour(const std::string& value, unsigned& r, unsigned& g, unsigned& b)
{
    if (value.size() != 7 && value.size() != 9 || value.front() != '#') return false;
    unsigned parsed = 0;
    try {
        parsed = static_cast<unsigned>(std::stoul(value.substr(1, 6), nullptr, 16));
    } catch (...) {
        return false;
    }
    r = (parsed >> 16) & 0xff;
    g = (parsed >> 8) & 0xff;
    b = parsed & 0xff;
    return true;
}

std::string adjusted_colour(const std::string& value)
{
    unsigned r = 38, g = 166, b = 154;
    read_colour(value, r, g, b);
    // Match OrcaSlicer's native render adjustment: a black filament remains
    // visible on the Prepare canvas while retaining its filament identity.
    if (r < 51 && g < 51 && b < 51) r = g = b = 51;
    std::ostringstream out;
    out << '#' << std::uppercase << std::setfill('0') << std::setw(2) << std::hex << r
        << std::setw(2) << g << std::setw(2) << b;
    return out.str();
}

DynamicPrintConfig effective_config(const BridgeState::PlateSessionPlate& plate)
{
    DynamicPrintConfig config = PresetDrafts::effective_full_config();
    // Match Orca's BackgroundSlicingProcess::apply: a plate config is layered
    // over the global/project config, so plate-local values are effective for
    // this plate's Prepare projection and subsequent Slice.
    config.apply(plate.settings, true);
    config.normalize_fdm();
    return config;
}

struct UsedSlotContext {
    std::size_t slot_count = 0;
    int global_support_interface = 0;
    int global_support = 0;
    int global_outer_wall = 0;
    int global_inner_wall = 0;
    int global_sparse_infill = 0;
    int global_internal_solid = 0;
    int global_top_surface = 0;
    int global_bottom_surface = 0;
    bool global_support_enabled = false;

    explicit UsedSlotContext(const DynamicPrintConfig& config, std::size_t slots) : slot_count(slots)
    {
        const auto option_int = [&config](const char* key) {
            const ConfigOption* option = config.option(key);
            return option == nullptr ? 0 : option->getInt();
        };
        global_support_interface = option_int("support_interface_filament");
        global_support = option_int("support_filament");
        global_outer_wall = option_int("outer_wall_filament_id");
        global_inner_wall = option_int("inner_wall_filament_id");
        if (global_outer_wall == 0) global_outer_wall = global_inner_wall;
        if (global_inner_wall == 0) global_inner_wall = global_outer_wall;
        global_sparse_infill = option_int("sparse_infill_filament_id");
        global_internal_solid = option_int("internal_solid_filament_id");
        global_top_surface = option_int("top_surface_filament_id");
        global_bottom_surface = option_int("bottom_surface_filament_id");
        if (global_top_surface == 0) global_top_surface = global_internal_solid;
        if (global_bottom_surface == 0) global_bottom_surface = global_internal_solid;
        const ConfigOption* support = config.option("enable_support");
        global_support_enabled = (support != nullptr && support->getBool()) ||
            option_int("raft_layers") > 0;
    }

    void append(std::set<int>& slots, const int slot) const
    {
        if (slot > 0 && static_cast<std::size_t>(slot) <= slot_count) slots.insert(slot);
    }

    std::set<int> object_slots(const ModelObject& object) const
    {
        std::set<int> slots;
        for (const ModelVolume* volume : object.volumes) {
            if (volume == nullptr) continue;
            for (const int slot : volume->get_extruders()) append(slots, slot);
        }
        for (const auto& layer_range : object.layer_config_ranges) {
            if (layer_range.second.has("extruder"))
                append(slots, layer_range.second.option("extruder")->getInt());
        }

        bool support_enabled = false;
        const ConfigOption* object_support = object.config.option("enable_support");
        const ConfigOption* object_raft = object.config.option("raft_layers");
        if (object_support != nullptr || object_raft != nullptr) {
            support_enabled = (object_support != nullptr && object_support->getBool()) ||
                (object_raft != nullptr && object_raft->getInt() > 0);
        } else {
            support_enabled = global_support_enabled;
        }
        if (support_enabled) {
            const auto object_int = [&object](const char* key) {
                const ConfigOption* option = object.config.option(key);
                return option == nullptr ? 0 : option->getInt();
            };
            const int support_interface = object_int("support_interface_filament");
            const int support = object_int("support_filament");
            append(slots, support_interface != 0 ? support_interface : global_support_interface);
            append(slots, support != 0 ? support : global_support);
        }

        const auto object_int = [&object](const char* key) {
            const ConfigOption* option = object.config.option(key);
            return option == nullptr ? 0 : option->getInt();
        };
        int outer_wall = object_int("outer_wall_filament_id");
        if (outer_wall == 0) outer_wall = object_int("inner_wall_filament_id");
        append(slots, outer_wall != 0 ? outer_wall : global_outer_wall);
        int inner_wall = object_int("inner_wall_filament_id");
        if (inner_wall == 0) inner_wall = object_int("outer_wall_filament_id");
        append(slots, inner_wall != 0 ? inner_wall : global_inner_wall);
        const int sparse_infill = object_int("sparse_infill_filament_id");
        append(slots, sparse_infill != 0 ? sparse_infill : global_sparse_infill);
        const int internal_solid = object_int("internal_solid_filament_id");
        append(slots, internal_solid != 0 ? internal_solid : global_internal_solid);
        int top_surface = object_int("top_surface_filament_id");
        if (top_surface == 0) top_surface = internal_solid;
        append(slots, top_surface != 0 ? top_surface : global_top_surface);
        int bottom_surface = object_int("bottom_surface_filament_id");
        if (bottom_surface == 0) bottom_surface = internal_solid;
        append(slots, bottom_surface != 0 ? bottom_surface : global_bottom_surface);
        return slots;
    }
};

std::vector<int> used_slots(const Model& model, const DynamicPrintConfig& config,
                            std::size_t slot_count, int plate_index)
{
    std::set<int> slots;
    const UsedSlotContext context(config, slot_count);
    for (const ModelObject* object : model.objects) {
        if (object == nullptr) continue;
        if (!std::any_of(object->instances.begin(), object->instances.end(),
                         [](const ModelInstance* instance) {
                             return instance != nullptr && instance->is_printable();
                         })) continue;
        const auto object_slots = context.object_slots(*object);
        slots.insert(object_slots.begin(), object_slots.end());
    }
    if (plate_index >= 0) {
        const auto custom = state().model.plates_custom_gcodes.find(plate_index);
        const auto* colours = config.opt<ConfigOptionStrings>("filament_colour");
        const std::size_t colour_count = colours == nullptr ? slot_count : colours->values.size();
        if (custom != state().model.plates_custom_gcodes.end()) {
            for (const auto& item : custom->second.gcodes) {
                if (item.type == CustomGCode::Type::ToolChange && item.extruder > 0 &&
                    static_cast<std::size_t>(item.extruder) <= colour_count)
                    context.append(slots, item.extruder);
            }
        }
    }
    return {slots.begin(), slots.end()};
}

struct UsedSlotSummary {
    bool valid = false;
    std::string config_signature;
    std::set<std::size_t> object_ids;
    std::map<std::size_t, std::set<int>> object_slots;
    std::vector<int> slots;
};

enum class UsedSlotLookupKind { Hit, Delta, FullScan };

std::map<std::string, UsedSlotSummary> g_used_slot_summaries;

std::string used_slot_config_signature(const DynamicPrintConfig& config, int plate_index)
{
    std::ostringstream signature;
    // These are exactly the effective-config keys read by UsedSlotContext. A
    // narrow signature keeps the runtime summary safe if a caller changes a
    // plate override without relying solely on global invalidation.
    for (const char* key : {"support_interface_filament", "support_filament", "enable_support",
                            "raft_layers", "outer_wall_filament_id", "inner_wall_filament_id",
                            "sparse_infill_filament_id", "internal_solid_filament_id",
                            "top_surface_filament_id", "bottom_surface_filament_id",
                            "filament_colour"}) {
        signature << key << '=';
        if (config.has(key)) signature << config.opt_serialize(key);
        signature << ';';
    }
    signature << "custom=";
    const auto custom = state().model.plates_custom_gcodes.find(plate_index);
    if (custom != state().model.plates_custom_gcodes.end()) {
        for (const auto& item : custom->second.gcodes)
            if (item.type == CustomGCode::Type::ToolChange)
                signature << static_cast<int>(item.type) << ':' << item.extruder << ';';
    }
    return signature.str();
}

bool current_plate_object_ids(const BridgeState::PlateSessionPlate& plate,
                              std::set<std::size_t>& object_ids)
{
    object_ids.clear();
    const auto outside = state().plate_out_of_bounds_ids.find(plate.id);
    std::set<std::size_t> expected_instances;
    for (const auto& [instance_id, instance_plate_id] : state().instance_plate_ids) {
        if (instance_plate_id != plate.id ||
            state().parked_instance_ids.find(instance_id) != state().parked_instance_ids.end())
            continue;
        if (outside != state().plate_out_of_bounds_ids.end() && outside->second.count(instance_id) != 0)
            continue;
        expected_instances.insert(instance_id);
    }

    // Resolve against the current model on every lookup. History restore may
    // replace state().model while retaining a plate-local projection cache;
    // retaining ModelObject/ModelInstance pointers here would leave a stale
    // native pointer in threaded WASM. This scan visits only object/instance
    // identity and printable flags, never volume geometry or mesh data.
    std::set<std::size_t> seen_instances;
    for (const ModelObject* object : state().model.objects) {
        if (object == nullptr) continue;
        for (const ModelInstance* instance : object->instances) {
            if (instance == nullptr || expected_instances.find(instance->id().id) == expected_instances.end())
                continue;
            seen_instances.insert(instance->id().id);
            if (object->printable && instance->printable)
                object_ids.insert(object->id().id);
        }
    }
    return seen_instances == expected_instances;
}

void refresh_summary_slots(UsedSlotSummary& summary, const UsedSlotContext& context,
                           const DynamicPrintConfig& config, int plate_index)
{
    std::set<int> slots;
    for (const auto& [object_id, object_slots] : summary.object_slots)
        slots.insert(object_slots.begin(), object_slots.end());
    const auto colours = config.opt<ConfigOptionStrings>("filament_colour");
    const std::size_t colour_count = colours == nullptr ? context.slot_count : colours->values.size();
    const auto custom = state().model.plates_custom_gcodes.find(plate_index);
    if (custom != state().model.plates_custom_gcodes.end()) {
        for (const auto& item : custom->second.gcodes)
            if (item.type == CustomGCode::Type::ToolChange && item.extruder > 0 &&
                static_cast<std::size_t>(item.extruder) <= colour_count)
                context.append(slots, item.extruder);
    }
    summary.slots.assign(slots.begin(), slots.end());
}

std::vector<int> used_slots_incremental(const BridgeState::PlateSessionPlate& plate,
                                        const Model& model, const DynamicPrintConfig& config,
                                        std::size_t slot_count, int plate_index,
                                        UsedSlotLookupKind& kind)
{
    std::set<std::size_t> object_ids;
    const std::string signature = used_slot_config_signature(config, plate_index);
    auto& summary = g_used_slot_summaries[plate.id];
    const bool objects_known = current_plate_object_ids(plate, object_ids);
    const bool signature_matches = summary.valid && summary.config_signature == signature;
    if (!objects_known || !signature_matches) {
        kind = UsedSlotLookupKind::FullScan;
        summary = {};
        summary.config_signature = signature;
        summary.object_ids = object_ids;
        const UsedSlotContext context(config, slot_count);
        for (const ModelObject* object : model.objects) {
            if (object == nullptr || object_ids.find(object->id().id) == object_ids.end()) continue;
            summary.object_slots[object->id().id] = context.object_slots(*object);
        }
        summary.valid = true;
        refresh_summary_slots(summary, context, config, plate_index);
        return used_slots(model, config, slot_count, plate_index);
    }

    const UsedSlotContext context(config, slot_count);
    if (summary.object_ids == object_ids) {
        kind = UsedSlotLookupKind::Hit;
        return summary.slots;
    }

    kind = UsedSlotLookupKind::Delta;
    for (auto it = summary.object_slots.begin(); it != summary.object_slots.end();) {
        if (object_ids.find(it->first) == object_ids.end()) it = summary.object_slots.erase(it);
        else ++it;
    }
    for (const std::size_t object_id : object_ids) {
        if (summary.object_slots.find(object_id) != summary.object_slots.end()) continue;
        const auto object = std::find_if(model.objects.begin(), model.objects.end(),
                                         [object_id](const ModelObject* candidate) {
                                             return candidate != nullptr && candidate->id().id == object_id;
                                         });
        if (object == model.objects.end()) {
            // The model changed without a corresponding global invalidation;
            // preserve exactness by retrying through the full scan path.
            summary = {};
            summary.config_signature.clear();
            kind = UsedSlotLookupKind::FullScan;
            return used_slots_incremental(plate, model, config, slot_count, plate_index, kind);
        }
        summary.object_slots[object_id] = context.object_slots(**object);
    }
    summary.object_ids = std::move(object_ids);
    refresh_summary_slots(summary, context, config, plate_index);
    return summary.slots;
}

double model_height(const Model& model)
{
    double height = 0.;
    for (const ModelObject* object : model.objects) {
        if (object == nullptr) continue;
        if (!std::any_of(object->instances.begin(), object->instances.end(),
                         [](const ModelInstance* instance) {
                             return instance != nullptr && instance->is_printable();
                         })) continue;
        const auto& box = object->bounding_box_exact();
        if (box.defined) height = std::max(height, static_cast<double>(box.max.z() - box.min.z()));
    }
    return std::isfinite(height) && height > 0. ? height : 0.;
}

double indexed_float(const DynamicPrintConfig& config, const char* key,
                     std::size_t index, double fallback)
{
    const auto* values = config.opt<ConfigOptionFloats>(key);
    if (values == nullptr || values->values.empty()) return fallback;
    const std::size_t selected = std::min(index, values->values.size() - 1);
    return std::isfinite(values->values[selected]) ? values->values[selected] : fallback;
}

struct Placement {
    double width = 0.;
    double depth = 0.;
    double height = kVisibleHeight;
    double brim = 0.;
    double rotation = 0.;
    double min_offset_x = 0.;
    double max_offset_x = 0.;
    double min_offset_y = 0.;
    double max_offset_y = 0.;
};

// This is the same pre-slice estimate used by Orca's PartPlate/Print preview
// path.  It deliberately consumes only the already prepared effective config,
// used-slot count, and the current plate height.  In particular, it must not
// create a temporary Print: the latter applies every model object and is the
// dominant cost of a narrow projection read.
std::optional<double> direct_wipe_tower_depth(const DynamicPrintConfig& config,
                                               double height,
                                               std::size_t filament_count)
{
    if (filament_count == 0 || !std::isfinite(height) || height <= 0.) return 0.;

    const auto* layer_height_option = config.option("layer_height");
    const auto* spacing_option = config.option("prime_tower_infill_gap");
    const auto* width_option = config.option("prime_tower_width");
    const auto* prime_volume_option = config.option("prime_volume");
    const auto* nozzle_option = config.opt<ConfigOptionFloats>("nozzle_diameter");
    const auto* wall_option = config.opt<ConfigOptionEnum<WipeTowerWallType>>("wipe_tower_wall_type");
    const auto* timelapse_option = config.opt<ConfigOptionEnum<TimelapseType>>("timelapse_type");
    const auto* rib_width_option = config.option("wipe_tower_rib_width");
    const auto* rib_length_option = config.option("wipe_tower_extra_rib_length");
    if (nozzle_option == nullptr) return std::nullopt;
    const double layer_height = layer_height_option == nullptr ? 0.08 : layer_height_option->getFloat();
    const double extra_spacing = (spacing_option == nullptr ? 150. : spacing_option->getFloat()) / 100.;
    const double width = width_option == nullptr ? 60. : width_option->getFloat();
    const double prime_volume = prime_volume_option == nullptr ? 45. : prime_volume_option->getFloat();
    if (!std::isfinite(layer_height) || layer_height <= 0. || !std::isfinite(extra_spacing) ||
        extra_spacing < 0. || !std::isfinite(width) || width <= 0. || !std::isfinite(prime_volume) ||
        prime_volume < 0.) return std::nullopt;

    const bool rib = wall_option == nullptr || wall_option->getInt() == static_cast<int>(WipeTowerWallType::wtwRib);
    const bool smooth_timelapse = timelapse_option != nullptr &&
        timelapse_option->getInt() == static_cast<int>(TimelapseType::tlSmooth);
    const bool need_wipe_tower = smooth_timelapse || rib;
    double filament_change_volume = 0.;
    const auto* lengths = config.opt<ConfigOptionFloats>("filament_change_length");
    const double length = lengths == nullptr || lengths->values.empty() ? 0. :
        *std::max_element(lengths->values.begin(), lengths->values.end());
    const auto* diameters = config.opt<ConfigOptionFloats>("filament_diameter");
    const double diameter = diameters == nullptr || diameters->values.empty() ? 1.75 :
        *std::max_element(diameters->values.begin(), diameters->values.end());
    if (!std::isfinite(length) || length < 0. || !std::isfinite(diameter) || diameter <= 0.)
        return std::nullopt;
    filament_change_volume = length * M_PI * diameter * diameter / 4.;

    const bool dual_nozzle = nozzle_option->values.size() == 2;
    std::size_t depth_count = dual_nozzle ? filament_count : filament_count - 1;
    if (filament_count == 1 && smooth_timelapse) depth_count = 1;
    double volume = prime_volume * static_cast<double>(depth_count);
    if (dual_nozzle) volume += filament_change_volume * static_cast<double>(filament_count / 2);

    if (rib) {
        double depth = std::sqrt(std::max(0., volume / layer_height * extra_spacing));
        if (need_wipe_tower || filament_count > 1) {
            const double minimum = WipeTower::get_limit_depth_by_height(static_cast<float>(height));
            depth = std::max(minimum, depth);
            const double rib_width = std::min(rib_width_option == nullptr ? 8. : rib_width_option->getFloat(), depth / 2.);
            depth += rib_width / std::sqrt(2.) + (rib_length_option == nullptr ? 0. : rib_length_option->getFloat());
        }
        return std::isfinite(depth) && depth >= 0. ? std::optional<double>(depth) : std::nullopt;
    }

    // Match Print::wipe_tower_data's SEMM preview branch without constructing
    // PrintConfig/Print. The matrix is expected to be a square native plane;
    // malformed input uses the conservative fallback path below.
    const bool purge_in_tower = config.opt_bool("purge_in_prime_tower");
    const bool single_extruder_multi_material = config.opt_bool("single_extruder_multi_material");
    if (purge_in_tower && single_extruder_multi_material) {
        const auto* matrix = config.opt<ConfigOptionFloats>("flush_volumes_matrix");
        const auto* multiplier = config.opt<ConfigOptionFloats>("flush_multiplier");
        const auto* minimum_purge = config.opt<ConfigOptionFloats>("filament_minimal_purge_on_wipe_tower");
        if (matrix == nullptr || multiplier == nullptr || minimum_purge == nullptr ||
            multiplier->values.empty()) return std::nullopt;
        const double side = std::sqrt(static_cast<double>(matrix->values.size()));
        const std::size_t extruders = static_cast<std::size_t>(side + 1e-9);
        if (extruders == 0 || extruders * extruders != matrix->values.size()) return std::nullopt;
        const double scale = multiplier->values.front();
        if (!std::isfinite(scale)) return std::nullopt;
        double maximum = 0.;
        for (std::size_t row = 0; row < extruders; ++row) {
            double row_max = 0.;
            for (std::size_t column = 0; column < extruders; ++column) {
                const double matrix_value = matrix->values[row * extruders + column];
                const double minimum = column < minimum_purge->values.size()
                    ? minimum_purge->values[column] : 0.;
                if (!std::isfinite(matrix_value) || !std::isfinite(minimum)) return std::nullopt;
                row_max = std::max(row_max, std::max(matrix_value * scale, minimum));
            }
            maximum += row_max;
        }
        maximum = maximum * static_cast<double>(filament_count) /
                  static_cast<double>(extruders) * 0.6;
        const double depth = maximum / (layer_height * width);
        return std::isfinite(depth) && depth >= 0. ? std::optional<double>(depth) : std::nullopt;
    }

    double depth = volume / (layer_height * width) * extra_spacing;
    if (need_wipe_tower || depth > EPSILON)
        depth = std::max(static_cast<double>(WipeTower::get_limit_depth_by_height(static_cast<float>(height))), depth);
    return std::isfinite(depth) && depth >= 0. ? std::optional<double>(depth) : std::nullopt;
}

Placement placement_for(const DynamicPrintConfig& config, const Model* model,
                        std::size_t slot_count, int plate_index,
                        ProjectionPlateTimings* timings = nullptr)
{
    Placement placement;
    placement.width = std::max(2., config.opt_float("prime_tower_width"));
    if (model != nullptr) {
        if (timings != nullptr) {
            ScopedTiming timer(timings->printable_height_bounds_scan_ms);
            placement.height = model_height(*model);
        } else {
            placement.height = model_height(*model);
        }
    }
    placement.brim = config.opt_float("prime_tower_brim_width");
    if (model != nullptr) {
        const auto estimate = [&]() {
            const auto depth = direct_wipe_tower_depth(config, placement.height, slot_count);
            if (!depth) return false;
            placement.depth = *depth;
            if (slot_count == 0) {
                placement.brim = 0.;
            } else if (placement.brim < 0.) {
                placement.brim = WipeTower::get_auto_brim_by_height(static_cast<float>(placement.height));
            }
            if (config.opt_enum<WipeTowerWallType>("wipe_tower_wall_type") == WipeTowerWallType::wtwRib)
                placement.width = placement.depth;
            return true;
        };
        bool estimated = false;
        if (timings != nullptr) {
            ScopedTiming timer(timings->direct_wipe_tower_estimate_ms);
            estimated = estimate();
        } else {
            estimated = estimate();
        }
        if (!estimated) {
            const auto apply_print = [&]() {
                Print native_print;
                (void)native_print.apply(*model, config);
                const auto& data = native_print.wipe_tower_data(slot_count);
                placement.depth = data.depth;
                if (placement.brim < 0.)
                    placement.brim = WipeTower::get_auto_brim_by_height(static_cast<float>(placement.height));
                if (data.brim_width >= 0.) placement.brim = data.brim_width;
                if (config.opt_enum<WipeTowerWallType>("wipe_tower_wall_type") == WipeTowerWallType::wtwRib)
                    placement.width = placement.depth;
            };
            if (timings != nullptr) {
                ScopedTiming timer(timings->print_apply_wipe_tower_data_fallback_ms);
                apply_print();
            } else {
                apply_print();
            }
        }
    }
    placement.rotation = config.opt_float("wipe_tower_rotation_angle");
    const double radians = placement.rotation * M_PI / 180.;
    const std::array<Vec2d, 4> corners = {{{0., 0.}, {placement.width, 0.},
                                           {placement.width, placement.depth},
                                           {0., placement.depth}}};
    placement.min_offset_x = placement.min_offset_y = std::numeric_limits<double>::infinity();
    placement.max_offset_x = placement.max_offset_y = -std::numeric_limits<double>::infinity();
    for (const Vec2d& corner : corners) {
        const double rotated_x = std::cos(radians) * corner.x() - std::sin(radians) * corner.y();
        const double rotated_y = std::sin(radians) * corner.x() + std::cos(radians) * corner.y();
        placement.min_offset_x = std::min(placement.min_offset_x, rotated_x);
        placement.max_offset_x = std::max(placement.max_offset_x, rotated_x);
        placement.min_offset_y = std::min(placement.min_offset_y, rotated_y);
        placement.max_offset_y = std::max(placement.max_offset_y, rotated_y);
    }
    if (!std::isfinite(placement.depth) || placement.depth < 0.) placement.depth = 0.;
    if (!std::isfinite(placement.brim) || placement.brim < 0.) placement.brim = 0.;
    if (!std::isfinite(placement.height) || placement.height < kVisibleHeight)
        placement.height = kVisibleHeight;
    if (!std::isfinite(placement.rotation)) placement.rotation = 0.;
    return placement;
}

json placement_footprint(const Placement& placement, double x, double y)
{
    return {{"min_x", x + placement.min_offset_x - placement.brim},
            {"max_x", x + placement.max_offset_x + placement.brim},
            {"min_y", y + placement.min_offset_y - placement.brim},
            {"max_y", y + placement.max_offset_y + placement.brim}};
}

bool finite_coordinate(const json& value)
{
    return value.is_number() && std::isfinite(value.get<double>());
}

double clamp_axis(const double requested, const double min_offset, const double max_offset,
                  const double brim, const double bed_min, const double bed_max,
                  bool& too_large)
{
    const double lower = bed_min - min_offset + brim;
    const double upper = bed_max - max_offset - brim;
    if (lower <= upper) return std::clamp(requested, lower, upper);
    too_large = true;
    return (bed_min + bed_max - min_offset - max_offset) / 2.;
}

json projection_for_plate(const BridgeState::PlateSessionPlate& plate,
                          const PlateBounds& bounds, std::size_t index,
                          ProjectionPlateTimings* timings = nullptr)
{
    const double plate_started_at = Neo::Bridge::Performance::now_ms();
    DynamicPrintConfig config;
    if (timings != nullptr) {
        ScopedTiming timer(timings->effective_config_construction_ms);
        config = effective_config(plate);
    } else {
        config = effective_config(plate);
    }
    const auto colours = config.opt<ConfigOptionStrings>("filament_colour");
    const std::size_t slot_count = state().presets.filament_presets.size();
    std::string model_error;
    std::optional<Model> model;
    if (timings != nullptr) {
        ScopedTiming timer(timings->plate_local_model_construction_ms);
        model = make_current_plate_model(plate, model_error);
    } else {
        model = make_current_plate_model(plate, model_error);
    }
    const bool empty = !model.has_value();
    std::vector<int> slots;
    if (model) {
        UsedSlotLookupKind lookup_kind = UsedSlotLookupKind::FullScan;
        if (timings != nullptr) {
            ScopedTiming total_timer(timings->used_slot_scan_ms);
            slots = used_slots_incremental(plate, *model, config, slot_count,
                                           static_cast<int>(plate.display_index), lookup_kind);
        } else {
            slots = used_slots_incremental(plate, *model, config, slot_count,
                                           static_cast<int>(plate.display_index), lookup_kind);
        }
        if (timings != nullptr) {
            // Attribute the same lookup interval to exactly one semantic path.
            // This second measurement is intentionally around no work; the
            // actual per-path scope below is populated by the lookup kind.
            // The total stage remains the authoritative wall-clock value.
            if (lookup_kind == UsedSlotLookupKind::Hit)
                timings->used_slot_summary_hit_ms = timings->used_slot_scan_ms;
            else if (lookup_kind == UsedSlotLookupKind::Delta)
                timings->used_slot_summary_delta_ms = timings->used_slot_scan_ms;
            else
                timings->used_slot_full_scan_fallback_ms = timings->used_slot_scan_ms;
        }
    }
    const bool smooth = config.opt_enum<TimelapseType>("timelapse_type") == TimelapseType::tlSmooth;
    const auto* wrapping = config.opt<ConfigOptionBool>("enable_wrapping_detection");
    const auto* wrapping_area = config.opt<ConfigOptionPoints>("wrapping_exclude_area");
    const bool forced = smooth || (wrapping != nullptr && wrapping->value && wrapping_area != nullptr &&
                                   wrapping_area->values.size() > 2);
    const bool by_object = config.opt_enum<PrintSequence>("print_sequence") == PrintSequence::ByObject;
    const bool enabled = config.opt_bool("enable_prime_tower");
    std::size_t printable_instances = 0;
    if (timings != nullptr) {
        ScopedTiming timer(timings->printable_height_bounds_scan_ms);
        if (model) {
            for (const ModelObject* object : model->objects)
                if (object != nullptr)
                    printable_instances += static_cast<std::size_t>(std::count_if(object->instances.begin(), object->instances.end(),
                        [](const ModelInstance* instance) { return instance != nullptr && instance->is_printable(); }));
        }
    } else if (model) {
        for (const ModelObject* object : model->objects)
            if (object != nullptr)
                printable_instances += static_cast<std::size_t>(std::count_if(object->instances.begin(), object->instances.end(),
                    [](const ModelInstance* instance) { return instance != nullptr && instance->is_printable(); }));
    }
    const bool eligible = enabled && !empty && (slots.size() >= 2 || forced) &&
        (!by_object || printable_instances == 1);

    const Placement placement = placement_for(config, model ? &*model : nullptr,
                                              slots.size(), static_cast<int>(plate.display_index), timings);
    const double width = placement.width;
    const double depth = placement.depth;
    const double height = placement.height;
    const double brim = placement.brim;
    const double x = indexed_float(config, "wipe_tower_x", index, 15.);
    const double y = indexed_float(config, "wipe_tower_y", index, 220.);
    const double rotation = placement.rotation;
    std::optional<ScopedTiming> footprint_timer;
    if (timings != nullptr) footprint_timer.emplace(timings->footprint_bands_projection_json_ms);
    const json footprint = placement_footprint(placement, x, y);
    const bool outside_boundary = eligible &&
        (footprint["min_x"].get<double>() < bounds.min_x || footprint["max_x"].get<double>() > bounds.max_x ||
         footprint["min_y"].get<double>() < bounds.min_y || footprint["max_y"].get<double>() > bounds.max_y);
    json bands = json::array();
    const double band_depth = eligible && !slots.empty() ? depth / static_cast<double>(slots.size()) : 0.;
    for (std::size_t band = 0; eligible && band < slots.size(); ++band) {
        const int slot = slots[band];
        const std::string source = colours != nullptr && static_cast<std::size_t>(slot - 1) < colours->values.size()
            ? colours->values[slot - 1] : std::string{};
        bands.push_back({{"slot", slot}, {"start_depth", band * band_depth},
                         {"end_depth", (band + 1) * band_depth},
                         {"colour", adjusted_colour(source)}, {"opacity", kBandOpacity}});
    }
    const json result = {{"plate_id", plate.id}, {"display_index", plate.display_index},
            {"eligible", eligible}, {"empty", empty}, {"forced", forced},
            {"used_slots", slots}, {"width", eligible ? width : 0.},
            {"depth", eligible ? depth : 0.}, {"height", eligible ? height : 0.},
            {"position", {{"x", x}, {"y", y}}}, {"rotation", rotation},
            {"brim_margin", brim},
            {"outside_boundary_warning", outside_boundary},
            {"footprint", footprint},
            {"bands", std::move(bands)},
            {"build_area", {{"min_x", bounds.min_x}, {"max_x", bounds.max_x},
                             {"min_y", bounds.min_y}, {"max_y", bounds.max_y},
                             {"max_z", bounds.max_z}}}};
    if (footprint_timer) footprint_timer.reset();
    if (timings != nullptr) timings->total_ms = Neo::Bridge::Performance::now_ms() - plate_started_at;
    return result;
}

} // namespace

json projection_json(ProjectionTimings* timings)
{
    if (timings != nullptr) {
        ScopedTiming timer(timings->session_preparation_ms);
        ensure_plate_session_state();
    } else {
        ensure_plate_session_state();
    }
    PlateBounds bounds;
    if (timings != nullptr) {
        ScopedTiming timer(timings->bounds_scan_ms);
        bounds = selected_plate_bounds();
    } else {
        bounds = selected_plate_bounds();
    }
    json plates = json::array();
    if (timings != nullptr) timings->per_plate.resize(state().plate_session_plates.size());
    for (std::size_t index = 0; index < state().plate_session_plates.size(); ++index) {
        const auto& plate = state().plate_session_plates[index];
        const auto input_stamp = state().plate_input_revisions.at(plate.id);
        auto cached = state().prime_tower_projection_cache.find(plate.id);
        if (cached == state().prime_tower_projection_cache.end() ||
            cached->second.input_stamp != input_stamp ||
            cached->second.display_index != plate.display_index) {
            auto projected = projection_for_plate(plate, bounds, index,
                                                  timings != nullptr ? &timings->per_plate[index] : nullptr);
            cached = state().prime_tower_projection_cache.insert_or_assign(plate.id,
                BridgeState::PrimeTowerProjectionCacheEntry{input_stamp, plate.display_index,
                                                            std::move(projected)}).first;
        }
        auto projected = cached->second.projection;
        projected["build_area"] = {{"min_x", bounds.min_x}, {"max_x", bounds.max_x},
                                    {"min_y", bounds.min_y}, {"max_y", bounds.max_y},
                                    {"max_z", bounds.max_z}};
        plates.push_back(std::move(projected));
    }
    return {{"ok", true}, {"version", 1}, {"current_plate_id", state().current_plate_id},
            {"build_area", {{"min_x", bounds.min_x}, {"max_x", bounds.max_x},
                             {"min_y", bounds.min_y}, {"max_y", bounds.max_y},
                             {"max_z", bounds.max_z}}}, {"plates", std::move(plates)}};
}

json projection_json()
{
    return projection_json(nullptr);
}

void invalidate_projection_cache()
{
    state().prime_tower_projection_cache.clear();
    g_used_slot_summaries.clear();
}

void invalidate_projection_cache(const std::set<std::string>& plate_ids)
{
    for (const auto& plate_id : plate_ids)
        state().prime_tower_projection_cache.erase(plate_id);
}

void invalidate_projection_cache_and_usage_summaries(const std::set<std::string>& plate_ids)
{
    invalidate_projection_cache(plate_ids);
    for (const auto& plate_id : plate_ids)
        g_used_slot_summaries.erase(plate_id);
}

bool normalize_coordinate_positions()
{
    if (state().plate_session_plates.empty()) return false;
    normalize_coordinate_settings(state().presets.project_config,
                                  state().plate_session_plates.size(), 15., 220.);
    const PlateBounds bounds = selected_plate_bounds();
    bool changed = false;
    for (std::size_t index = 0; index < state().plate_session_plates.size(); ++index) {
        const auto& plate = state().plate_session_plates[index];
        const DynamicPrintConfig config = effective_config(plate);
        std::string model_error;
        const auto model = make_current_plate_model(plate, model_error);
        if (!model) continue;
        const auto slots = used_slots(*model, config, state().presets.filament_presets.size(),
                                      static_cast<int>(plate.display_index));
        const bool smooth = config.opt_enum<TimelapseType>("timelapse_type") == TimelapseType::tlSmooth;
        const auto* wrapping = config.opt<ConfigOptionBool>("enable_wrapping_detection");
        const auto* wrapping_area = config.opt<ConfigOptionPoints>("wrapping_exclude_area");
        const bool forced = smooth || (wrapping != nullptr && wrapping->value && wrapping_area != nullptr &&
                                       wrapping_area->values.size() > 2);
        const bool by_object = config.opt_enum<PrintSequence>("print_sequence") == PrintSequence::ByObject;
        std::size_t printable_instances = 0;
        for (const ModelObject* object : model->objects)
            if (object != nullptr)
                printable_instances += static_cast<std::size_t>(std::count_if(object->instances.begin(), object->instances.end(),
                    [](const ModelInstance* instance) { return instance != nullptr && instance->is_printable(); }));
        if (!config.opt_bool("enable_prime_tower") || slots.empty() || (slots.size() < 2 && !forced) ||
            (by_object && printable_instances != 1)) continue;

        const Placement placement = placement_for(config, &*model, slots.size(),
                                                  static_cast<int>(plate.display_index));
        const double old_x = indexed_float(config, "wipe_tower_x", index, 15.);
        const double old_y = indexed_float(config, "wipe_tower_y", index, 220.);
        bool too_large = false;
        const double x = clamp_axis(old_x, placement.min_offset_x, placement.max_offset_x,
                                    placement.brim, bounds.min_x, bounds.max_x, too_large);
        const double y = clamp_axis(old_y, placement.min_offset_y, placement.max_offset_y,
                                    placement.brim, bounds.min_y, bounds.max_y, too_large);
        if (std::abs(old_x - x) <= 1e-12 && std::abs(old_y - y) <= 1e-12) continue;
        set_coordinate_settings(state().presets.project_config, index, x, y, old_x, old_y);
        changed = true;
    }
    return changed;
}

json slice_warnings_for_plate(const std::string& plate_id)
{
    using namespace Neo::Bridge::PlateSession;
    ensure_plate_session_state();
    const auto* plate = find_plate(plate_id);
    if (plate == nullptr) return json::array();
    const auto index_it = std::find_if(state().plate_session_plates.begin(), state().plate_session_plates.end(),
        [&](const auto& candidate) { return candidate.id == plate_id; });
    if (index_it == state().plate_session_plates.end()) return json::array();
    const std::size_t index = static_cast<std::size_t>(std::distance(state().plate_session_plates.begin(), index_it));
    const DynamicPrintConfig config = effective_config(*plate);
    std::string model_error;
    const auto model = make_current_plate_model(*plate, model_error);
    if (!model) return json::array();
    const auto slots = used_slots(*model, config, state().presets.filament_presets.size(),
                                  static_cast<int>(plate->display_index));
    const bool smooth = config.opt_enum<TimelapseType>("timelapse_type") == TimelapseType::tlSmooth;
    const auto* wrapping = config.opt<ConfigOptionBool>("enable_wrapping_detection");
    const auto* wrapping_area = config.opt<ConfigOptionPoints>("wrapping_exclude_area");
    const bool forced = smooth || (wrapping != nullptr && wrapping->value && wrapping_area != nullptr &&
                                   wrapping_area->values.size() > 2);
    const bool by_object = config.opt_enum<PrintSequence>("print_sequence") == PrintSequence::ByObject;
    std::size_t printable_instances = 0;
    for (const ModelObject* object : model->objects)
        if (object != nullptr)
            printable_instances += static_cast<std::size_t>(std::count_if(object->instances.begin(), object->instances.end(),
                [](const ModelInstance* instance) { return instance != nullptr && instance->is_printable(); }));
    if (!config.opt_bool("enable_prime_tower") || slots.empty() || (slots.size() < 2 && !forced) ||
        (by_object && printable_instances != 1)) return json::array();

    const Placement placement = placement_for(config, &*model, slots.size(), static_cast<int>(plate->display_index));
    const double x = indexed_float(config, "wipe_tower_x", index, 15.);
    const double y = indexed_float(config, "wipe_tower_y", index, 220.);
    const json footprint = placement_footprint(placement, x, y);
    const double min_x = footprint["min_x"].get<double>();
    const double max_x = footprint["max_x"].get<double>();
    const double min_y = footprint["min_y"].get<double>();
    const double max_y = footprint["max_y"].get<double>();
    const auto intersects = [&](double other_min_x, double other_max_x,
                                double other_min_y, double other_max_y) {
        return max_x >= other_min_x && min_x <= other_max_x &&
               max_y >= other_min_y && min_y <= other_max_y;
    };
    json warnings = json::array();
    for (const ModelObject* object : model->objects) {
        if (object == nullptr) continue;
        const auto& box = object->bounding_box_exact();
        if (box.defined && intersects(box.min.x(), box.max.x(), box.min.y(), box.max.y())) {
            warnings.push_back("Prime Tower intersects a model.");
            break;
        }
    }
    const auto area_intersects = [&](const ConfigOptionPoints* area) {
        if (area == nullptr || area->values.size() < 3) return false;
        double area_min_x = std::numeric_limits<double>::infinity();
        double area_max_x = -std::numeric_limits<double>::infinity();
        double area_min_y = std::numeric_limits<double>::infinity();
        double area_max_y = -std::numeric_limits<double>::infinity();
        for (const Vec2d& point : area->values) {
            area_min_x = std::min(area_min_x, point.x()); area_max_x = std::max(area_max_x, point.x());
            area_min_y = std::min(area_min_y, point.y()); area_max_y = std::max(area_max_y, point.y());
        }
        return intersects(area_min_x, area_max_x, area_min_y, area_max_y);
    };
    if (area_intersects(config.opt<ConfigOptionPoints>("bed_exclude_area")))
        warnings.push_back("Prime Tower intersects an exclusion area.");
    if (area_intersects(config.opt<ConfigOptionPoints>("wrapping_exclude_area")))
        warnings.push_back("Prime Tower intersects a wrapping-detection area.");
    const PlateBounds bounds = selected_plate_bounds();
    if (min_x < bounds.min_x || max_x > bounds.max_x || min_y < bounds.min_y || max_y > bounds.max_y)
        warnings.push_back("Prime Tower is outside the printable area.");
    return warnings;
}

json move_error(const char* code, const std::string& message)
{
    return { {"ok", false}, {"version", 1}, {"error", message}, {"error_code", code},
             {"status", {{"state", "error"}, {"error", message}}} };
}

json move_position_json(const char* request_cstr)
{
    ensure_plate_session_state();
    if (state().active_history_transaction)
        return move_error("history_busy", "history transaction is already active");

    json request;
    try {
        request = json::parse(request_cstr == nullptr ? "" : request_cstr);
    } catch (...) {
        return move_error("invalid_command", "invalid prime tower move request");
    }
    if (!request.is_object() || request.value("version", 0) != 1)
        return move_error("invalid_command", "unsupported prime tower move version");
    if (!request.contains("plate_id") || !request["plate_id"].is_string() || request["plate_id"].get<std::string>().empty())
        return move_error("invalid_command", "plateId is required");
    if (!request.contains("revision") || !request["revision"].is_number_unsigned())
        return move_error("invalid_command", "plate revision is required");
    if (!request.contains("x") || !request.contains("y") ||
        !finite_coordinate(request["x"]) || !finite_coordinate(request["y"]))
        return move_error("invalid_command", "prime tower position must be finite");

    const std::string plate_id = request["plate_id"].get<std::string>();
    auto* plate = find_plate_mutable(plate_id);
    if (plate == nullptr) return move_error("unsupported_reference", "plate not found");
    const std::uint64_t revision = request["revision"].get<std::uint64_t>();
    const auto revision_it = state().plate_input_revisions.find(plate_id);
    const std::uint64_t current_revision = revision_it == state().plate_input_revisions.end() ? 0 : revision_it->second;
    if (revision != current_revision)
        return move_error("stale_revision", "prime tower plate revision is stale");
    if (!PlateSession::coordinate_arrays_match_plate_count(
            state().presets.project_config, state().plate_session_plates.size()))
        return move_error("native_validation_failure", "prime tower coordinate array invariant failed");
    if (request.value("inject_failure", false))
        return move_error("native_validation_failure", "prime tower move validation failed");

    const auto plate_index_it = std::find_if(state().plate_session_plates.begin(), state().plate_session_plates.end(),
        [&](const auto& candidate) { return candidate.id == plate_id; });
    if (plate_index_it == state().plate_session_plates.end()) return move_error("unsupported_reference", "plate not found");
    const std::size_t plate_index = static_cast<std::size_t>(
        std::distance(state().plate_session_plates.begin(), plate_index_it));
    const DynamicPrintConfig config = effective_config(*plate);
    std::string model_error;
    const auto model = make_current_plate_model(*plate, model_error);
    const auto slots = model ? used_slots(*model, config, state().presets.filament_presets.size(),
                                          static_cast<int>(plate->display_index)) : std::vector<int>{};
    const bool smooth = config.opt_enum<TimelapseType>("timelapse_type") == TimelapseType::tlSmooth;
    const auto* wrapping = config.opt<ConfigOptionBool>("enable_wrapping_detection");
    const auto* wrapping_area = config.opt<ConfigOptionPoints>("wrapping_exclude_area");
    const bool forced = smooth || (wrapping != nullptr && wrapping->value && wrapping_area != nullptr &&
                                   wrapping_area->values.size() > 2);
    const bool by_object = config.opt_enum<PrintSequence>("print_sequence") == PrintSequence::ByObject;
    std::size_t printable_instances = 0;
    if (model) {
        for (const ModelObject* object : model->objects)
            if (object != nullptr)
                printable_instances += static_cast<std::size_t>(std::count_if(object->instances.begin(), object->instances.end(),
                    [](const ModelInstance* instance) { return instance != nullptr && instance->is_printable(); }));
    }
    const bool eligible = config.opt_bool("enable_prime_tower") && model.has_value() && !slots.empty() &&
        (slots.size() >= 2 || forced) && (!by_object || printable_instances == 1);
    if (!eligible) return move_error("ineligible_target", "prime tower is not available on this plate");

    const Placement placement = placement_for(config, &*model, slots.size(), static_cast<int>(plate->display_index));
    const PlateBounds bounds = selected_plate_bounds();
    const double requested_x = request["x"].get<double>();
    const double requested_y = request["y"].get<double>();
    bool too_large = false;
    const double x = clamp_axis(requested_x, placement.min_offset_x, placement.max_offset_x,
                                placement.brim, bounds.min_x, bounds.max_x, too_large);
    const double y = clamp_axis(requested_y, placement.min_offset_y, placement.max_offset_y,
                                placement.brim, bounds.min_y, bounds.max_y, too_large);

    const double old_x = indexed_float(config, "wipe_tower_x", plate_index, 15.);
    const double old_y = indexed_float(config, "wipe_tower_y", plate_index, 220.);
    const std::uint64_t plate_revision_before = state().plate_input_revisions[plate_id];
    if (std::abs(old_x - x) <= 1e-12 && std::abs(old_y - y) <= 1e-12) {
        return { {"ok", true}, {"version", 1}, {"result", {
            {"history_status", HistoryMetadata::history_status_json(state())},
            {"mutation", {{"kind", "move"}, {"plate_id", plate_id}, {"history_entry_delta", 0},
                           {"revision_before", plate_revision_before},
                           {"revision_after", plate_revision_before}, {"dirty", false},
                           {"affected_plate_ids", json::array()}, {"position", {{"x", old_x}, {"y", old_y}}},
                           {"footprint", placement_footprint(placement, old_x, old_y)}}}
        }} };
    }

    const auto before_settings = snapshot_coordinate_settings(state().presets.project_config, plate_index);
    const std::uint64_t before_revision = plate_revision_before;
    const auto history_runtime = HistoryRuntime::runtime();
    const auto before_history_context = HistoryRuntime::default_history_context(history_runtime);
    if (!HistoryMetadata::begin_timestamped_operation(state(), "Move Prime Tower", before_history_context))
        return move_error("native_validation_failure", "could not capture prime tower history predecessor");
    bool history_started = true;
    json response;
    try {
        set_coordinate_settings(state().presets.project_config, plate_index, x, y, old_x, old_y);
        state().plate_input_revisions[plate_id] = allocate_plate_input_stamp(state());
        invalidate_projection_cache({plate_id});
        // ConfigOptionFloat canonically stores this value at float precision.
        // Read the post-write effective configuration: `config` is the
        // pre-move snapshot used for eligibility/geometry and still contains
        // the old coordinates. Publishing from it turns a successful native
        // mutation into a renderer-visible no-op until a later refresh.
        const DynamicPrintConfig stored_config = effective_config(*plate);
        const double stored_x = indexed_float(stored_config, "wipe_tower_x", plate_index, x);
        const double stored_y = indexed_float(stored_config, "wipe_tower_y", plate_index, y);
        const auto after_context = HistoryRuntime::default_history_context(history_runtime);
        response = { {"ok", true}, {"version", 1}, {"result", {
            {"mutation", {{"kind", "move"}, {"plate_id", plate_id},
                           {"history_entry_delta", 1}, {"revision_before", plate_revision_before},
                           {"revision_after", plate_revision_before + 1}, {"dirty", true},
                           {"affected_plate_ids", {plate_id}}, {"clamped", x != requested_x || y != requested_y},
                           {"outside_boundary_warning", too_large},
                           {"warning", too_large ? "Prime Tower is too large to fit within the printable area." : ""},
                           {"position", {{"x", stored_x}, {"y", stored_y}}},
                           {"footprint", placement_footprint(placement, stored_x, stored_y)}}}
        }} };
        if (request.value("inject_failure_stage", "") == "before-publish")
            throw std::runtime_error("injected prime tower post-validation failure");
        const bool committed = HistoryMetadata::commit_timestamped_operation(state(), after_context);
        if (!committed) throw std::runtime_error("could not commit prime tower move history");
        history_started = false;
    } catch (const std::exception& e) {
        if (history_started) HistoryMetadata::abort_timestamped_operation(state());
        restore_coordinate_settings(state().presets.project_config, before_settings, plate_index, old_x, old_y);
        state().plate_input_revisions[plate_id] = before_revision;
        return move_error("native_validation_failure", e.what());
    } catch (...) {
        if (history_started) HistoryMetadata::abort_timestamped_operation(state());
        restore_coordinate_settings(state().presets.project_config, before_settings, plate_index, old_x, old_y);
        state().plate_input_revisions[plate_id] = before_revision;
        return move_error("native_validation_failure", "prime tower move failed");
    }
    // Publication is now complete. These operations are scalar/clear-only and
    // intentionally live outside the rollback scope so a post-publish path
    // cannot report failure after history has advanced.
    if (state().current_plate_id == plate_id) {
        // This is the post-publication path. Keep it non-throwing so a native
        // cleanup failure cannot report an error after history has advanced.
        try { Neo::Bridge::SlicingPipeline::invalidate_preview_result_only(); } catch (...) {}
    }
    response["result"]["history_status"] = HistoryMetadata::history_status_json(state());
    return response;
}

} // namespace Slic3r::Neo::Bridge::PrimeTower

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_get_prime_tower_projection()
{
    try {
        const double started_at = Slic3r::Neo::Bridge::Performance::now_ms();
        Slic3r::Neo::Bridge::PrimeTower::ProjectionTimings timings;
        const auto result = Slic3r::Neo::Bridge::PrimeTower::projection_json(&timings);
        const double serialization_started_at = Slic3r::Neo::Bridge::Performance::now_ms();
        const std::string text = result.dump();
        const double copy_started_at = Slic3r::Neo::Bridge::Performance::now_ms();
        const char* response = Slic3r::Neo::Bridge::PrimeTower::duplicate_json(text);
        const double finished_at = Slic3r::Neo::Bridge::Performance::now_ms();
        double effective_config_ms = 0.;
        double plate_model_ms = 0.;
        double used_slot_summary_hit_ms = 0.;
        double used_slot_summary_delta_ms = 0.;
        double used_slot_full_scan_fallback_ms = 0.;
        double used_slots_ms = 0.;
        double printable_height_bounds_ms = 0.;
        double direct_estimate_ms = 0.;
        double print_apply_fallback_ms = 0.;
        double footprint_bands_ms = 0.;
        Slic3r::Neo::Bridge::Performance::Timings aggregate{
            {"session_preparation", timings.session_preparation_ms},
            {"bounds_scan", timings.bounds_scan_ms},
        };
        Slic3r::Neo::Bridge::Performance::PerPlateTimings per_plate;
        per_plate.reserve(timings.per_plate.size());
        for (const auto& plate : timings.per_plate) {
            effective_config_ms += plate.effective_config_construction_ms;
            plate_model_ms += plate.plate_local_model_construction_ms;
            used_slot_summary_hit_ms += plate.used_slot_summary_hit_ms;
            used_slot_summary_delta_ms += plate.used_slot_summary_delta_ms;
            used_slot_full_scan_fallback_ms += plate.used_slot_full_scan_fallback_ms;
            used_slots_ms += plate.used_slot_scan_ms;
            printable_height_bounds_ms += plate.printable_height_bounds_scan_ms;
            direct_estimate_ms += plate.direct_wipe_tower_estimate_ms;
            print_apply_fallback_ms += plate.print_apply_wipe_tower_data_fallback_ms;
            footprint_bands_ms += plate.footprint_bands_projection_json_ms;
            per_plate.push_back({
                {"effective_config_construction", plate.effective_config_construction_ms},
                {"plate_local_model_construction", plate.plate_local_model_construction_ms},
                {"used_slot_summary_hit", plate.used_slot_summary_hit_ms},
                {"used_slot_summary_delta", plate.used_slot_summary_delta_ms},
                {"used_slot_full_scan_fallback", plate.used_slot_full_scan_fallback_ms},
                {"used_slot_scan", plate.used_slot_scan_ms},
                {"printable_height_bounds_scan", plate.printable_height_bounds_scan_ms},
                {"direct_wipe_tower_estimate", plate.direct_wipe_tower_estimate_ms},
                {"print_apply_wipe_tower_data_fallback", plate.print_apply_wipe_tower_data_fallback_ms},
                {"footprint_bands_projection_json", plate.footprint_bands_projection_json_ms},
                {"total", plate.total_ms},
            });
        }
        aggregate.emplace_back("effective_config_construction", effective_config_ms);
        aggregate.emplace_back("plate_local_model_construction", plate_model_ms);
        aggregate.emplace_back("used_slot_summary_hit", used_slot_summary_hit_ms);
        aggregate.emplace_back("used_slot_summary_delta", used_slot_summary_delta_ms);
        aggregate.emplace_back("used_slot_full_scan_fallback", used_slot_full_scan_fallback_ms);
        aggregate.emplace_back("used_slot_scan", used_slots_ms);
        aggregate.emplace_back("printable_height_bounds_scan", printable_height_bounds_ms);
        aggregate.emplace_back("direct_wipe_tower_estimate", direct_estimate_ms);
        aggregate.emplace_back("print_apply_wipe_tower_data_fallback", print_apply_fallback_ms);
        aggregate.emplace_back("footprint_bands_projection_json", footprint_bands_ms);
        aggregate.emplace_back("final_json_serialization", copy_started_at - serialization_started_at);
        aggregate.emplace_back("final_json_copy", finished_at - copy_started_at);
        aggregate.emplace_back("total", finished_at - started_at);
        Slic3r::Neo::Bridge::Performance::record("prime_tower_projection", std::move(aggregate), std::move(per_plate));
        return response;
    } catch (const std::exception& e) {
        return Slic3r::Neo::Bridge::PrimeTower::duplicate_json(
            nlohmann::json{{"ok", false}, {"version", 1}, {"error", e.what()}}.dump());
    } catch (...) {
        return Slic3r::Neo::Bridge::PrimeTower::duplicate_json(
            nlohmann::json{{"ok", false}, {"version", 1}, {"error", "unknown C++ exception"}}.dump());
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_move_prime_tower(const char* request_cstr)
{
    try {
        return Slic3r::Neo::Bridge::PrimeTower::duplicate_json(
            Slic3r::Neo::Bridge::PrimeTower::move_position_json(request_cstr).dump());
    } catch (const std::exception& e) {
        return Slic3r::Neo::Bridge::PrimeTower::duplicate_json(
            nlohmann::json{{"ok", false}, {"version", 1}, {"error", e.what()},
                           {"error_code", "native_validation_failure"},
                           {"status", {{"state", "error"}, {"error", e.what()}}}}.dump());
    } catch (...) {
        return Slic3r::Neo::Bridge::PrimeTower::duplicate_json(
            nlohmann::json{{"ok", false}, {"version", 1}, {"error", "unknown C++ exception"},
                           {"error_code", "native_validation_failure"},
                           {"status", {{"state", "error"}, {"error", "unknown C++ exception"}}}}.dump());
    }
}

} // extern "C"
