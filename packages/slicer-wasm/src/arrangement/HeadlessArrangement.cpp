#include "HeadlessArrangement.hpp"
#include "libslic3r/ModelArrange.hpp"
#include "libslic3r/GCode/WipeTowerEstimate.hpp"
#include "libslic3r/Flow.hpp"
#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <stdexcept>

namespace Slic3r::Neo::Arrangement {
using namespace arrangement;
namespace {
constexpr std::size_t plate_limit = 36;
bool by_object(const DynamicPrintConfig& config) {
    return config.opt_enum<PrintSequence>("print_sequence") == PrintSequence::ByObject;
}
// The same arithmetic as Print::object_skirt_offset, without applying a Print
// or reading one being processed by a concurrent slicing job.
double object_skirt_offset(const SceneInput& scene, const DynamicPrintConfig& config) {
    if (config.opt_int("skirt_loops") == 0 || config.opt_enum<SkirtType>("skirt_type") != stPerObject) return 0;
    ModelObject* first = nullptr;
    bool all_short = true;
    for (const auto& input : scene.instances) {
        if (input.plate != scene.current_plate || !input.instance || !input.instance->printable || !input.instance->get_object()->printable) continue;
        auto* object = input.instance->get_object();
        if (!first) first = object;
        all_short &= object->instance_convex_hull_bounding_box(input.instance).size().z() < config.opt_float("nozzle_height");
    }
    if (!first) return 0;
    const auto* diameters = config.option<ConfigOptionFloats>("nozzle_diameter");
    const auto* max_layers = config.option<ConfigOptionFloats>("max_layer_height");
    auto width = *config.option<ConfigOptionFloatOrPercent>("initial_layer_line_width");
    const double line_width = width.get_abs_value(*std::max_element(diameters->values.begin(), diameters->values.end()));
    if (width.value <= 0) width = *first->get_config_value<ConfigOptionFloatOrPercent>(config, "line_width");
    const auto flow = Flow::new_from_config_width(frPerimeter, width,
        diameters->get_at(first->get_config_value<ConfigOptionInt>(config, "support_filament")->value - 1),
        config.opt_float("initial_layer_print_height"));
    const double skirt_width = flow.width() + (config.opt_int("skirt_loops") - 1) * flow.spacing();
    const double distance = config.opt_float("skirt_distance");
    if (all_short) return distance + skirt_width;
    if (config.opt_enum<DraftShield>("draft_shield") == dsEnabled ||
        config.opt_int("skirt_height") * *std::max_element(max_layers->values.begin(), max_layers->values.end()) > config.opt_float("nozzle_height"))
        return distance + line_width;
    return std::max(0., distance + skirt_width - config.opt_float("extruder_clearance_radius") / 2);
}
ArrangePolygon rectangle(double x0, double y0, double x1, double y1) {
    ArrangePolygon p;
    p.poly.contour.points = {{scaled(x0), scaled(y0)}, {scaled(x1), scaled(y0)},
                            {scaled(x1), scaled(y1)}, {scaled(x0), scaled(y1)}};
    p.is_virt_object = true;
    p.bed_idx = 0;
    p.height = 1;
    return p;
}
bool intersects(const BoundingBoxf3& box, const PlateInput& plate,
                const BoundingBox& bed, double height) {
    return box.defined && box.max.x() >= plate.origin.x() + unscaled(bed.min.x()) &&
        box.min.x() <= plate.origin.x() + unscaled(bed.max.x()) &&
        box.max.y() >= plate.origin.y() + unscaled(bed.min.y()) &&
        box.min.y() <= plate.origin.y() + unscaled(bed.max.y()) &&
        box.max.z() >= 0 && box.min.z() <= height;
}
void exclusions(Prepared& out) {
    const auto* areas = out.config.option<ConfigOptionPoints>("bed_exclude_area");
    if (areas) for (std::size_t i = 0; i + 3 < areas->values.size(); i += 4) {
        BoundingBoxf box;
        for (std::size_t j = i; j < i + 4; ++j) box.merge(areas->values[j]);
        auto p = rectangle(box.min.x(), box.min.y(), box.max.x(), box.max.y());
        p.inflation = scaled(1.);
        out.params.excluded_regions.push_back(std::move(p));
    }
    if (out.config.opt_bool("enable_wrapping_detection")) {
        const auto* area = out.config.option<ConfigOptionPoints>("wrapping_exclude_area");
        if (area && area->values.size() >= 3) {
            ArrangePolygon p;
            for (const auto& pt : area->values) p.poly.contour.points.emplace_back(scaled(pt.x()), scaled(pt.y()));
            p.bed_idx = 0; p.is_virt_object = true; p.height = 1; p.inflation = scaled(1.);
            out.params.excluded_regions.push_back(std::move(p));
        }
    }
}
ArrangePolygon estimated_tower(const SceneInput& scene, const DynamicPrintConfig& config,
                               std::size_t index, std::size_t filament_count, const BoundingBox& bed,
                               Vec2d& position) {
    const auto source_plate = std::min(index, scene.plates.size() - 1);
    std::set<int> extruders;
    double height = 0, layer = std::numeric_limits<double>::max();
    for (const auto& input : scene.instances) {
        if (input.plate != source_plate || !input.fully_inside_plate) continue;
        auto* object = input.instance->get_object();
        const auto p = get_instance_arrange_poly(input.instance, config);
        extruders.insert(p.extrude_ids.begin(), p.extrude_ids.end());
        height = std::max(height, p.height);
        layer = std::min(layer, object->get_config_value<ConfigOptionFloat>(config, "layer_height")->value);
    }
    for (int id = 1; extruders.size() < filament_count; ++id) extruders.insert(id);
    const int dedicated = config.opt_int("wipe_tower_filament");
    if (extruders.size() > 1 && dedicated > 0) extruders.insert(dedicated);
    std::vector<unsigned> ids;
    for (int id : extruders) if (id > 0) ids.push_back(unsigned(id - 1));
    if (layer == std::numeric_limits<double>::max()) layer = config.opt_float("layer_height");
    const auto type = resolve_wipe_tower_type(config);
    const auto footprint = estimate_wipe_tower_footprint(config, type, ids, layer, height);
    const auto outline = get_extents(estimate_wipe_tower_first_layer_outline(config, type,
        footprint.width, footprint.depth, footprint.height));
    const double brim = footprint.brim_width + std::max({0., unscaled(outline.max.x()) - footprint.width,
        unscaled(outline.max.y()) - footprint.depth, -unscaled(outline.min.x()), -unscaled(outline.min.y())});
    auto clamp = [brim](double pos, double length, double extent) {
        const double low = WIPE_TOWER_MARGIN + brim, high = std::max(low, length - extent - low);
        double comfort_low = WIPE_TOWER_AUTO_MARGIN + brim, comfort_high = length - extent - comfort_low;
        if (comfort_low > comfort_high) { comfort_low = low; comfort_high = high; }
        return pos < low - 5 || pos > high + 5 ? std::clamp(pos, comfort_low, comfort_high) : std::clamp(pos, low, high);
    };
    const double x = clamp(config.option<ConfigOptionFloats>("wipe_tower_x")->get_at(index), unscaled(bed.size().x()), footprint.width);
    const double y = clamp(config.option<ConfigOptionFloats>("wipe_tower_y")->get_at(index), unscaled(bed.size().y()), footprint.depth);
    position = Vec2d(x, y);
    auto p = rectangle(x - brim, y - brim, x + footprint.width + brim, y + footprint.depth + brim);
    p.is_wipe_tower = true; p.name = "Prime tower";
    return p;
}
}

Prepared prepare(const SceneInput& scene, const Settings& settings) {
    if (scene.plates.empty() || scene.plates.size() > plate_limit || scene.current_plate >= scene.plates.size())
        throw std::invalid_argument("Invalid plate session for arrangement");
    if (!std::isfinite(settings.distance) || settings.distance < 0 || settings.distance > unscaled(std::numeric_limits<coord_t>::max() / 4))
        throw std::invalid_argument("Arrangement spacing must be a finite non-negative distance");
    Prepared out;
    out.scope = settings.scope;
    out.config = scene.config;
    std::vector<bool> excluded(scene.plates.size());
    for (std::size_t i = 0; i < scene.plates.size(); ++i) {
        auto effective = scene.config;
        effective.apply(scene.plates[i].settings);
        excluded[i] = scene.plates[i].locked || (settings.scope == Scope::All && by_object(effective) != by_object(scene.config));
        if (!excluded[i] && (settings.scope == Scope::All || i == scene.current_plate)) out.destination_plates.push_back(i);
    }
    if (settings.scope == Scope::CurrentPlate) {
        if (scene.plates[scene.current_plate].locked) throw std::invalid_argument("The current plate is locked");
        out.config.apply(scene.plates[scene.current_plate].settings);
    } else for (std::size_t i = scene.plates.size(); i < plate_limit; ++i) out.destination_plates.push_back(i);
    auto& p = out.params;
    p.is_seq_print = by_object(out.config);
    p.min_obj_distance = scaled(settings.scope == Scope::CurrentPlate && p.is_seq_print != by_object(scene.config) ? 0. : settings.distance);
    p.allow_rotations = settings.rotate;
    p.align_to_y_axis = settings.align_y && !settings.rotate;
    p.allow_multi_materials_on_same_plate = settings.multiple_materials;
    p.avoid_extrusion_cali_region = settings.avoid_calibration;
    p.clearance_height_to_rod = out.config.opt_float("extruder_clearance_height_to_rod");
    p.clearance_height_to_lid = out.config.opt_float("extruder_clearance_height_to_lid");
    p.object_skirt_offset = object_skirt_offset(scene, out.config);
    p.clearance_radius = out.config.opt_float("extruder_clearance_radius") + p.object_skirt_offset * 2;
    p.printable_height = out.config.opt_float("printable_height");
    p.nozzle_height = out.config.opt_float("nozzle_height");
    p.align_center = out.config.option<ConfigOptionPoint>("best_object_pos")->value;
    if (p.is_seq_print) p.bed_shrink_x = p.bed_shrink_y = BED_SHRINK_SEQ_PRINT;
#ifndef ORCA_WASM_THREADING
    p.parallel = false;
#endif
    const auto bed_points = get_bed_shape(out.config);
    if (bed_points.size() < 3) throw std::invalid_argument("Printer has no usable printable area");
    const BoundingBox bed(bed_points);
    for (const auto& input : scene.instances) {
        if (!input.instance || (input.plate && *input.plate >= scene.plates.size())) throw std::invalid_argument("Invalid arrangement instance");
        if (input.plate && excluded[*input.plate]) continue;
        auto* instance = input.instance;
        auto* object = instance->get_object();
        for (auto* volume : object->volumes) if (volume->is_model_part() && !volume->get_convex_hull_shared_ptr()) volume->calculate_convex_hull();
        if (settings.scope == Scope::CurrentPlate && input.plate != scene.current_plate &&
            (input.plate || !intersects(object->instance_convex_hull_bounding_box(instance), scene.plates[scene.current_plate], bed, p.printable_height))) continue;
        Placement record;
        record.instance_id = instance->id().id;
        record.position = instance->get_offset().head<2>();
        record.rotation = instance->get_rotation(Z);
        if (!instance->printable || !object->printable) {
            record.parking = ParkingReason::NonPrintable; out.parked.push_back(record); continue;
        }
        auto poly = get_instance_arrange_poly(instance, out.config);
        poly.setter = nullptr;
        if (poly.poly.contour.points.size() < 3 || std::abs(poly.poly.area()) < .001) record.parking = ParkingReason::Degenerate;
        else if (poly.height > p.printable_height) record.parking = ParkingReason::TooTall;
        if (record.parking != ParkingReason::None) { out.parked.push_back(record); continue; }
        if (input.plate) poly.translation -= scaled(scene.plates[*input.plate].origin.head<2>().eval());
        poly.bed_idx = 0;
        poly.itemid = int(out.instances.size());
        out.instances.push_back(record);
        out.movable.push_back(std::move(poly));
    }
    if (scene.bambu && settings.avoid_calibration && out.config.opt_bool("scan_first_layer")) {
        for (std::size_t i = 0; i < out.destination_plates.size(); ++i) {
            auto region = rectangle(18, 0, 240, 15);
            region.is_extrusion_cali_object = true; region.bed_idx = int(i);
            out.fixed.push_back(std::move(region));
        }
    }
    bool need_tower = out.config.opt_enum<TimelapseType>("timelapse_type") == TimelapseType::tlSmooth;
    std::map<int, std::set<int>> temperature_extruders;
    std::set<int> all_extruders;
    for (const auto& item : out.movable) {
        std::set<int> ids(item.extrude_ids.begin(), item.extrude_ids.end());
        if (ids.size() > 1) need_tower = true;
        temperature_extruders[item.bed_temp].insert(ids.begin(), ids.end());
    }
    // Orca uses the union of real plates' fully contained objects, excluding
    // parked and out-of-bounds instances from this estimation floor.
    for (const auto& input : scene.instances) {
        if (!input.plate || !input.fully_inside_plate) continue;
        auto poly = get_instance_arrange_poly(input.instance, out.config);
        all_extruders.insert(poly.extrude_ids.begin(), poly.extrude_ids.end());
    }
    if (settings.multiple_materials) for (const auto& entry : temperature_extruders) if (entry.second.size() > 1) need_tower = true;
    for (std::size_t i = 0; i < out.destination_plates.size(); ++i) {
        const auto index = out.destination_plates[i];
        std::optional<ArrangePolygon> tower;
        if (index < scene.plates.size()) tower = scene.plates[index].tower;
        if (settings.scope == Scope::All) {
            if (!out.config.opt_bool("enable_prime_tower") || p.is_seq_print) continue;
            if (!tower && need_tower) {
                Vec2d position;
                tower = estimated_tower(scene, out.config, index, all_extruders.size(), bed, position);
                out.estimated_tower_positions.emplace_back(index, position);
            }
        }
        if (tower) { tower->setter = nullptr; tower->bed_idx = int(i); out.fixed.push_back(std::move(*tower)); }
    }
    update_arrange_params(p, &out.config, out.movable);
    update_selected_items_inflation(out.movable, &out.config, p);
    update_unselected_items_inflation(out.fixed, &out.config, p);
    update_selected_items_axis_align(out.movable, &out.config, p);
    out.bed = get_shrink_bedpts(&out.config, p);
    exclusions(out);
    return out;
}

Result solve(Prepared prepared, std::function<bool()> canceled, std::function<void(unsigned, std::string)> progress) {
    Result result;
    auto stopped = [&] { return canceled && canceled(); };
    if (stopped()) { result.canceled = true; return result; }
    prepared.params.stopcondition = stopped;
    prepared.params.progressind = [progress, count = prepared.movable.size()](unsigned done, std::string name) {
        if (progress) progress(count ? std::min(99u, unsigned(done * 100 / count)) : 99u, std::move(name));
    };
    if (!prepared.movable.empty() && !prepared.destination_plates.empty())
        arrange(prepared.movable, prepared.fixed, prepared.bed, prepared.params);
    if (stopped()) { result.canceled = true; return result; }
    result.placements = std::move(prepared.parked);
    for (const auto& poly : prepared.movable) {
        if (poly.itemid < 0 || std::size_t(poly.itemid) >= prepared.instances.size() || !std::isfinite(poly.rotation))
            throw std::runtime_error("Invalid native arrangement result");
        auto item = prepared.instances[poly.itemid];
        if (prepared.destination_plates.empty() || (poly.bed_idx >= 0 && std::size_t(poly.bed_idx) >= prepared.destination_plates.size())) {
            item.parking = prepared.scope == Scope::All ? ParkingReason::PlateLimit : ParkingReason::CurrentPlateOverflow;
            result.plate_limit_reached |= prepared.scope == Scope::All;
        } else if (poly.bed_idx < 0) item.parking = ParkingReason::Unfit;
        else {
            item.plate = prepared.destination_plates[poly.bed_idx];
            item.position = unscale(poly.translation);
            item.rotation = poly.rotation;
        }
        result.placements.push_back(std::move(item));
    }
    return result;
}
} // namespace Slic3r::Neo::Arrangement
