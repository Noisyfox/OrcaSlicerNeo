#include "bridge_prime_tower.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <iomanip>
#include <limits>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include <emscripten/emscripten.h>

#include "bridge_filament.hpp"
#include "bridge_plate.hpp"
#include "bridge_project_overlay.hpp"
#include "bridge_state.hpp"
#include "libslic3r/GCode/WipeTower.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/PrintConfig.hpp"

using namespace Slic3r;

namespace Slic3r::Neo::Bridge::PrimeTower {

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
using Neo::Bridge::PlateSession::make_current_plate_model;
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
    const auto it = state().project_config_overlay["plates"].find(plate.id);
    if (it != state().project_config_overlay["plates"].end())
        Neo::Bridge::ProjectOverlay::apply_overlay_to_config(config, it.value());
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

    double width = std::max(2., config.opt_float("prime_tower_width"));
    double depth = 0.;
    double height = model ? model_height(*model) : 0.;
    double brim = config.opt_float("prime_tower_brim_width");
    if (eligible && model) {
        // Print::wipe_tower_data is the native pre-slice estimator. apply()
        // builds only Print's configuration/object sidecars; process() is not
        // called, so displaying this read never triggers slicing.
        Print native_print;
        (void)native_print.apply(*model, config);
        const auto& data = native_print.wipe_tower_data(slots.size());
        depth = data.depth;
        if (brim < 0.) brim = WipeTower::get_auto_brim_by_height(static_cast<float>(height));
        if (data.brim_width >= 0.) brim = data.brim_width;
        if (config.opt_enum<WipeTowerWallType>("wipe_tower_wall_type") == WipeTowerWallType::wtwRib)
            width = depth;
    }
    if (!std::isfinite(depth) || depth < 0.) depth = 0.;
    if (!std::isfinite(brim) || brim < 0.) brim = 0.;
    if (!std::isfinite(height) || height < kVisibleHeight) height = kVisibleHeight;
    const double x = indexed_float(config, "wipe_tower_x", index, 15.);
    const double y = indexed_float(config, "wipe_tower_y", index, 220.);
    const double rotation = config.opt_float("wipe_tower_rotation_angle");
    const double radians = rotation * M_PI / 180.;
    // Native WipeTower applies Rotation(angle) to local geometry at the
    // origin, then translates it by wipe_tower_x/y. Keep that anchor (rather
    // than rotating around the rectangle centre) so placement and boundary
    // calculations agree with the pre-slice path.
    const std::array<Vec2d, 4> corners = {{{0., 0.}, {width, 0.},
                                           {width, depth}, {0., depth}}};
    double min_x = std::numeric_limits<double>::infinity();
    double max_x = -std::numeric_limits<double>::infinity();
    double min_y = std::numeric_limits<double>::infinity();
    double max_y = -std::numeric_limits<double>::infinity();
    for (const Vec2d& corner : corners) {
        const double rotated_x = x + std::cos(radians) * corner.x() - std::sin(radians) * corner.y();
        const double rotated_y = y + std::sin(radians) * corner.x() + std::cos(radians) * corner.y();
        min_x = std::min(min_x, rotated_x);
        max_x = std::max(max_x, rotated_x);
        min_y = std::min(min_y, rotated_y);
        max_y = std::max(max_y, rotated_y);
    }
    min_x -= brim; max_x += brim; min_y -= brim; max_y += brim;
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
            {"footprint", {{"min_x", min_x}, {"max_x", max_x},
                            {"min_y", min_y}, {"max_y", max_y}}},
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

} // extern "C"
