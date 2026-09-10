#include "bridge_prime_tower.hpp"

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
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include <emscripten/emscripten.h>

#include "bridge_filament.hpp"
#include "bridge_history.hpp"
#include "bridge_plate.hpp"
#include "bridge_project_overlay.hpp"
#include "bridge_state.hpp"
#include "bridge_slicing_pipeline.hpp"
#include "libslic3r/GCode/WipeTower.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/PrintConfig.hpp"

using namespace Slic3r;

namespace Slic3r::Neo::Bridge::PrimeTower {

std::size_t narrow_history_frame_bytes(const NarrowHistoryFrame& frame)
{
    const auto value_bytes = [](const NarrowHistoryFrame::CoordinateValue& value) {
        return value.value ? value.value->capacity() : 0;
    };
    return sizeof(NarrowHistoryFrame) + frame.plate_id.capacity() +
        value_bytes(frame.before_x) + value_bytes(frame.before_y) +
        value_bytes(frame.after_x) + value_bytes(frame.after_y);
}

std::optional<History::RestoreState::DirectFrame>
make_narrow_history_frame(const NarrowHistoryFrame& frame)
{
    auto payload = std::make_shared<NarrowHistoryFrame>(frame);
    return History::RestoreState::DirectFrame{
        History::RestoreState::DirectFrame::Kind::PrimeTower,
        std::static_pointer_cast<const void>(std::move(payload)), narrow_history_frame_bytes(frame)};
}

CoordinateSettingsSnapshot snapshot_coordinate_settings(const DynamicPrintConfig& settings,
                                                         std::size_t plate_index)
{
    const auto snapshot_value = [plate_index](const DynamicPrintConfig& config, const char* key) {
        NarrowHistoryFrame::CoordinateValue result;
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
                               const NarrowHistoryFrame::CoordinateValue& snapshot,
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
    DynamicPrintConfig config = state().presets.full_config();
    config.apply(plate.settings, true);
    Neo::Bridge::ProjectOverlay::apply_overlay_to_config(
        config, state().project_config_overlay["project"]);
    config.normalize_fdm();
    return config;
}

std::vector<int> used_slots(const Model& model, const DynamicPrintConfig& config,
                            std::size_t slot_count, int plate_index)
{
    std::set<int> slots;
    const auto option_int = [](const auto& source, const char* key) {
        const ConfigOption* option = source.option(key);
        return option == nullptr ? 0 : option->getInt();
    };
    const auto option_bool = [](const auto& source, const char* key) {
        const ConfigOption* option = source.option(key);
        return option != nullptr && option->getBool();
    };
    const int global_support_interface = option_int(config, "support_interface_filament");
    const int global_support = option_int(config, "support_filament");
    int global_outer_wall = option_int(config, "outer_wall_filament_id");
    int global_inner_wall = option_int(config, "inner_wall_filament_id");
    if (global_outer_wall == 0) global_outer_wall = global_inner_wall;
    if (global_inner_wall == 0) global_inner_wall = global_outer_wall;
    const int global_sparse_infill = option_int(config, "sparse_infill_filament_id");
    const int global_internal_solid = option_int(config, "internal_solid_filament_id");
    int global_top_surface = option_int(config, "top_surface_filament_id");
    int global_bottom_surface = option_int(config, "bottom_surface_filament_id");
    if (global_top_surface == 0) global_top_surface = global_internal_solid;
    if (global_bottom_surface == 0) global_bottom_surface = global_internal_solid;
    const bool global_support_enabled = option_bool(config, "enable_support") ||
        option_int(config, "raft_layers") > 0;
    const auto append = [&slots, slot_count](const int slot) {
        if (slot > 0 && static_cast<std::size_t>(slot) <= slot_count) slots.insert(slot);
    };
    for (const ModelObject* object : model.objects) {
        if (object == nullptr) continue;
        if (!std::any_of(object->instances.begin(), object->instances.end(),
                         [](const ModelInstance* instance) {
                             return instance != nullptr && instance->is_printable();
                         })) continue;
        for (const ModelVolume* volume : object->volumes) {
            if (volume == nullptr) continue;
            for (const int slot : volume->get_extruders())
                append(slot);
        }

        for (const auto& layer_range : object->layer_config_ranges) {
            if (layer_range.second.has("extruder"))
                append(layer_range.second.option("extruder")->getInt());
        }

        bool support_enabled = false;
        const ConfigOption* object_support = object->config.option("enable_support");
        const ConfigOption* object_raft = object->config.option("raft_layers");
        if (object_support != nullptr || object_raft != nullptr) {
            support_enabled = (object_support != nullptr && object_support->getBool()) ||
                (object_raft != nullptr && object_raft->getInt() > 0);
        } else {
            support_enabled = global_support_enabled;
        }
        if (support_enabled) {
            const int support_interface = option_int(object->config, "support_interface_filament");
            const int support = option_int(object->config, "support_filament");
            append(support_interface != 0 ? support_interface : global_support_interface);
            append(support != 0 ? support : global_support);
        }

        int outer_wall = option_int(object->config, "outer_wall_filament_id");
        if (outer_wall == 0) outer_wall = option_int(object->config, "inner_wall_filament_id");
        append(outer_wall != 0 ? outer_wall : global_outer_wall);
        int inner_wall = option_int(object->config, "inner_wall_filament_id");
        if (inner_wall == 0) inner_wall = option_int(object->config, "outer_wall_filament_id");
        append(inner_wall != 0 ? inner_wall : global_inner_wall);

        const int sparse_infill = option_int(object->config, "sparse_infill_filament_id");
        append(sparse_infill != 0 ? sparse_infill : global_sparse_infill);
        const int internal_solid = option_int(object->config, "internal_solid_filament_id");
        append(internal_solid != 0 ? internal_solid : global_internal_solid);
        int top_surface = option_int(object->config, "top_surface_filament_id");
        if (top_surface == 0) top_surface = internal_solid;
        append(top_surface != 0 ? top_surface : global_top_surface);
        int bottom_surface = option_int(object->config, "bottom_surface_filament_id");
        if (bottom_surface == 0) bottom_surface = internal_solid;
        append(bottom_surface != 0 ? bottom_surface : global_bottom_surface);
    }
    if (plate_index >= 0) {
        const auto custom = state().model.plates_custom_gcodes.find(plate_index);
        const auto* colours = config.opt<ConfigOptionStrings>("filament_colour");
        const std::size_t colour_count = colours == nullptr ? slot_count : colours->values.size();
        if (custom != state().model.plates_custom_gcodes.end()) {
            for (const auto& item : custom->second.gcodes) {
                if (item.type == CustomGCode::Type::ToolChange && item.extruder > 0 &&
                    static_cast<std::size_t>(item.extruder) <= colour_count)
                    append(item.extruder);
            }
        }
    }
    return {slots.begin(), slots.end()};
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

Placement placement_for(const DynamicPrintConfig& config, const Model* model,
                        std::size_t slot_count, int plate_index)
{
    Placement placement;
    placement.width = std::max(2., config.opt_float("prime_tower_width"));
    placement.height = model == nullptr ? kVisibleHeight : model_height(*model);
    placement.brim = config.opt_float("prime_tower_brim_width");
    if (model != nullptr) {
        Print native_print;
        (void)native_print.apply(*model, config);
        const auto& data = native_print.wipe_tower_data(slot_count);
        placement.depth = data.depth;
        if (placement.brim < 0.)
            placement.brim = WipeTower::get_auto_brim_by_height(static_cast<float>(placement.height));
        if (data.brim_width >= 0.) placement.brim = data.brim_width;
        if (config.opt_enum<WipeTowerWallType>("wipe_tower_wall_type") == WipeTowerWallType::wtwRib)
            placement.width = placement.depth;
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
                          const PlateBounds& bounds, std::size_t index)
{
    const DynamicPrintConfig config = effective_config(plate);
    const auto colours = config.opt<ConfigOptionStrings>("filament_colour");
    const std::size_t slot_count = state().presets.filament_presets.size();
    std::string model_error;
    const auto model = make_current_plate_model(plate, model_error);
    const bool empty = !model.has_value();
    const auto slots = model ? used_slots(*model, config, slot_count, static_cast<int>(plate.display_index)) : std::vector<int>{};
    const bool smooth = config.opt_enum<TimelapseType>("timelapse_type") == TimelapseType::tlSmooth;
    const auto* wrapping = config.opt<ConfigOptionBool>("enable_wrapping_detection");
    const auto* wrapping_area = config.opt<ConfigOptionPoints>("wrapping_exclude_area");
    const bool forced = smooth || (wrapping != nullptr && wrapping->value && wrapping_area != nullptr &&
                                   wrapping_area->values.size() > 2);
    const bool by_object = config.opt_enum<PrintSequence>("print_sequence") == PrintSequence::ByObject;
    const bool enabled = config.opt_bool("enable_prime_tower");
    std::size_t printable_instances = 0;
    if (model) {
        for (const ModelObject* object : model->objects)
            if (object != nullptr)
                printable_instances += static_cast<std::size_t>(std::count_if(object->instances.begin(), object->instances.end(),
                    [](const ModelInstance* instance) { return instance != nullptr && instance->is_printable(); }));
    }
    const bool eligible = enabled && !empty && (slots.size() >= 2 || forced) &&
        (!by_object || printable_instances == 1);

    const Placement placement = placement_for(config, model ? &*model : nullptr,
                                              slots.size(), static_cast<int>(plate.display_index));
    const double width = placement.width;
    const double depth = placement.depth;
    const double height = placement.height;
    const double brim = placement.brim;
    const double x = indexed_float(config, "wipe_tower_x", index, 15.);
    const double y = indexed_float(config, "wipe_tower_y", index, 220.);
    const double rotation = placement.rotation;
    const json footprint = placement_footprint(placement, x, y);
    const bool outside_boundary = eligible &&
        (footprint["min_x"].get<double>() < bounds.min_x || footprint["max_x"].get<double>() > bounds.max_x ||
         footprint["min_y"].get<double>() < bounds.min_y || footprint["max_y"].get<double>() > bounds.max_y);
    json bands = json::array();
    const double band_depth = slots.empty() ? 0. : depth / static_cast<double>(slots.size());
    for (std::size_t band = 0; band < slots.size(); ++band) {
        const int slot = slots[band];
        const std::string source = colours != nullptr && static_cast<std::size_t>(slot - 1) < colours->values.size()
            ? colours->values[slot - 1] : std::string{};
        bands.push_back({{"slot", slot}, {"start_depth", band * band_depth},
                         {"end_depth", (band + 1) * band_depth},
                         {"colour", adjusted_colour(source)}, {"opacity", kBandOpacity}});
    }
    return {{"plate_id", plate.id}, {"display_index", plate.display_index},
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
}

} // namespace

json projection_json()
{
    ensure_plate_session_state();
    const auto bounds = selected_plate_bounds();
    json plates = json::array();
    for (std::size_t index = 0; index < state().plate_session_plates.size(); ++index)
        plates.push_back(projection_for_plate(state().plate_session_plates[index], bounds, index));
    return {{"ok", true}, {"version", 1}, {"current_plate_id", state().current_plate_id},
            {"build_area", {{"min_x", bounds.min_x}, {"max_x", bounds.max_x},
                             {"min_y", bounds.min_y}, {"max_y", bounds.max_y},
                             {"max_z", bounds.max_z}}}, {"plates", std::move(plates)}};
}

json move_error(const char* code, const std::string& message)
{
    return { {"ok", false}, {"version", 1}, {"error", message}, {"error_code", code},
             {"status", {{"state", "error"}, {"error", message}}} };
}

json narrow_frame_json(const NarrowHistoryFrame& frame)
{
    const auto coordinate = [](const NarrowHistoryFrame::CoordinateValue& value) -> json {
        return {{"present", value.option_present},
                {"value", value.value ? json(*value.value) : json(nullptr)}};
    };
    return { {"version", 1}, {"kind", "primeTower"}, {"state", frame.after_state ? "after" : "before"}, {"plate_id", frame.plate_id},
             {"before", {{"x", coordinate(frame.before_x)}, {"y", coordinate(frame.before_y)}, {"revision", frame.before_revision}}},
             {"after", {{"x", coordinate(frame.after_x)}, {"y", coordinate(frame.after_y)}, {"revision", frame.after_revision}}} };
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
        json projection = projection_json();
        return { {"ok", true}, {"version", 1}, {"result", {
            {"projection", std::move(projection)},
            {"plate_session", plate_session_snapshot_json()},
            {"mutation", {{"kind", "move"}, {"plate_id", plate_id}, {"history_entry_delta", 0},
                           {"revision_before", plate_revision_before},
                           {"revision_after", plate_revision_before}, {"dirty", false},
                           {"affected_plate_ids", json::array()}}}
        }} };
    }

    const auto before_settings = snapshot_coordinate_settings(state().presets.project_config, plate_index);
    const auto before_project_x = state().project_config_overlay["project"].contains("wipe_tower_x")
        ? std::optional<std::string>(state().project_config_overlay["project"]["wipe_tower_x"].get<std::string>())
        : std::nullopt;
    const auto before_project_y = state().project_config_overlay["project"].contains("wipe_tower_y")
        ? std::optional<std::string>(state().project_config_overlay["project"]["wipe_tower_y"].get<std::string>())
        : std::nullopt;
    const std::uint64_t before_revision = plate_revision_before;
    NarrowHistoryFrame frame;
    frame.plate_id = plate_id;
    frame.before_x = before_settings.x;
    frame.before_y = before_settings.y;
    frame.after_x = before_settings.x;
    frame.after_y = before_settings.y;
    frame.after_x.value = ConfigOptionFloat(x).serialize();
    frame.after_y.value = ConfigOptionFloat(y).serialize();
    frame.after_x.option_present = true;
    frame.after_y.option_present = true;
    frame.before_revision = plate_revision_before;
    frame.after_revision = plate_revision_before + 1;
    const auto before_frame = frame;

    json response;
    try {
        set_coordinate_settings(state().presets.project_config, plate_index, x, y, old_x, old_y);
        state().project_config_overlay["project"]["wipe_tower_x"] =
            state().presets.project_config.option("wipe_tower_x")->serialize();
        state().project_config_overlay["project"]["wipe_tower_y"] =
            state().presets.project_config.option("wipe_tower_y")->serialize();
        ++state().plate_input_revisions[plate_id];
        const auto after_settings = snapshot_coordinate_settings(state().presets.project_config, plate_index);
        frame.after_x = after_settings.x;
        frame.after_y = after_settings.y;
        NarrowHistoryFrame after_frame = frame;
        after_frame.after_state = true;
        const auto before_direct = make_narrow_history_frame(before_frame);
        const auto after_direct = make_narrow_history_frame(after_frame);
        const auto before_context = narrow_frame_json(before_frame).dump();
        const auto after_context = narrow_frame_json(after_frame).dump();
        const auto before_bytes = Neo::History::Bytes(before_context.begin(), before_context.end());
        const auto after_bytes = Neo::History::Bytes(after_context.begin(), after_context.end());
        const bool first_history_entry = state().history.entries().empty();
        const auto response_projection = projection_json();
        const auto moved = std::find_if(response_projection["plates"].begin(), response_projection["plates"].end(),
            [&](const auto& value) { return value.value("plate_id", "") == plate_id; });
        if (moved == response_projection["plates"].end()) throw std::runtime_error("prime tower plate disappeared during move");
        response = { {"ok", true}, {"version", 1}, {"result", {
            {"projection", response_projection},
            {"plate_session", plate_session_snapshot_json()},
            {"mutation", {{"kind", "move"}, {"plate_id", plate_id},
                           {"history_entry_delta", 1}, {"revision_before", plate_revision_before},
                           {"revision_after", plate_revision_before + 1}, {"dirty", true},
                           {"affected_plate_ids", {plate_id}}, {"clamped", x != requested_x || y != requested_y},
                           {"outside_boundary_warning", too_large},
                           {"warning", too_large ? "Prime Tower is too large to fit within the printable area." : ""},
                           {"position", {{"x", x}, {"y", y}}},
                           {"footprint", (*moved)["footprint"]}}}
        }} };
        if (request.value("inject_failure_stage", "") == "before-publish")
            throw std::runtime_error("injected prime tower post-validation failure");
        bool committed = false;
        if (first_history_entry) {
            const auto model_state = Neo::History::Codec::capture_model_state(state().model);
            committed = state().history.commit_with_baseline("Move Prime Tower", Neo::History::Category::Project,
                model_state, before_bytes, model_state, after_bytes, before_direct, after_direct);
        } else {
            committed = state().history.commit_reusing_current_model("Move Prime Tower", Neo::History::Category::Project,
                                                                       Neo::History::Bytes(after_bytes.begin(), after_bytes.end()),
                                                                       after_direct, before_direct);
        }
        if (!committed) throw std::runtime_error("could not commit prime tower move history");
    } catch (const std::exception& e) {
        restore_coordinate_settings(state().presets.project_config, before_settings, plate_index, old_x, old_y);
        if (before_project_x) state().project_config_overlay["project"]["wipe_tower_x"] = *before_project_x;
        else state().project_config_overlay["project"].erase("wipe_tower_x");
        if (before_project_y) state().project_config_overlay["project"]["wipe_tower_y"] = *before_project_y;
        else state().project_config_overlay["project"].erase("wipe_tower_y");
        state().plate_input_revisions[plate_id] = before_revision;
        return move_error("native_validation_failure", e.what());
    } catch (...) {
        restore_coordinate_settings(state().presets.project_config, before_settings, plate_index, old_x, old_y);
        if (before_project_x) state().project_config_overlay["project"]["wipe_tower_x"] = *before_project_x;
        else state().project_config_overlay["project"].erase("wipe_tower_x");
        if (before_project_y) state().project_config_overlay["project"]["wipe_tower_y"] = *before_project_y;
        else state().project_config_overlay["project"].erase("wipe_tower_y");
        state().plate_input_revisions[plate_id] = before_revision;
        return move_error("native_validation_failure", "prime tower move failed");
    }
    // Publication is now complete. These operations are scalar/clear-only and
    // intentionally live outside the rollback scope so a post-publish path
    // cannot report failure after history has advanced.
    ++state().history_revision;
    if (state().preview_plate_id == plate_id) {
        // This is the post-publication path. Keep it non-throwing so a native
        // cleanup failure cannot report an error after history has advanced.
        try { state().print.clear(); } catch (...) {}
        try { SlicingPipeline::invalidate_preview_source(); } catch (...) {}
    }
    return response;
}

} // namespace Slic3r::Neo::Bridge::PrimeTower

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_get_prime_tower_projection()
{
    try {
        return Slic3r::Neo::Bridge::PrimeTower::duplicate_json(
            Slic3r::Neo::Bridge::PrimeTower::projection_json().dump());
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
