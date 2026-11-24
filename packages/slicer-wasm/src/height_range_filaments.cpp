#include "height_range_filaments.hpp"
#include "libslic3r/Print.hpp"

namespace Slic3r {
// Native region resolution used by PrintApply.cpp. The pinned core exposes
// this function at link time but declares it only in that translation unit.
PrintRegionConfig region_config_from_model_volume(const PrintRegionConfig&, const DynamicPrintConfig*,
                                                  const ModelVolume&, size_t, std::vector<int>&);

void Neo::collect_height_range_filaments(const ModelInstance& instance, const DynamicPrintConfig& config,
                                         std::size_t slot_count, std::set<int>& slots)
{
    const auto& object = *instance.get_object();
    if (object.layer_config_ranges.empty() || !slot_count) return;

    const auto transform = instance.get_transformation().get_matrix_no_offset();
    std::vector<std::pair<const ModelVolume*, BoundingBoxf3>> parts;
    BoundingBoxf3 bounds;
    for (const auto* part : object.volumes) {
        if (!part->is_model_part()) continue;
        const auto& mesh = part->get_convex_hull_shared_ptr() ? part->get_convex_hull() : part->mesh();
        auto box = mesh.transformed_bounding_box(transform * part->get_matrix());
        if (!box.defined) continue;
        parts.emplace_back(part, box);
        bounds.merge(box);
    }
    if (!bounds.defined) return;

    PrintRegionConfig defaults;
    defaults.apply(config, true);
    PrintConfig print;
    print.filament_diameter.values.resize(slot_count, 1.75);
    const auto& brim_type = object.config.has("brim_type") ? object.config.get() : config;
    const auto& brim_width = object.config.has("brim_width") ? object.config.get() : config;
    const bool brim = brim_type.opt_enum<BrimType>("brim_type") != btNoBrim && brim_width.opt_float("brim_width") > 0;
    std::vector<int> variants;
    std::vector<unsigned> active;
    double last_z = 0;
    for (const auto& [range, settings] : object.layer_config_ranges) {
        // Match PrintApply's LayerRanges::assign priority and tolerance.
        if (range.second <= last_z) continue;
        if (range.first > last_z + EPSILON) last_z = range.first;
        if (last_z >= bounds.size().z()) break;
        if (range.second <= last_z + EPSILON) continue;
        for (const auto& [part, box] : parts) {
            if (box.max.z() - bounds.min.z() <= last_z || box.min.z() - bounds.min.z() >= range.second) continue;
            auto region = region_config_from_model_volume(defaults, &settings.get(), *part, slot_count, variants);
            PrintRegion::collect_object_printing_extruders(print, region, brim, active);
        }
        last_z = range.second;
    }
    for (unsigned id : active) slots.insert(static_cast<int>(id) + 1);
}
}
