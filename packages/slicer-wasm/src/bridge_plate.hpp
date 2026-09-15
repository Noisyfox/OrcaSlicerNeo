// ----------------------------------------------------------------
// Plate-domain ownership for the Neo bridge.
//
// This module owns the complete runtime multi-plate domain: identity,
// membership, snapshots, geometry, lifecycle commands, and the plate ABI.
// ----------------------------------------------------------------
#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "bridge_state.hpp"
#include "libslic3r/Model.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::PlateSession {

using json = nlohmann::json;

struct PlateBounds {
    double min_x = 0.0;
    double max_x = 200.0;
    double min_y = 0.0;
    double max_y = 200.0;
    double max_z = 300.0;
};

struct PlateInstanceRef {
    std::size_t object_index = 0;
    std::size_t instance_index = 0;
    std::size_t instance_id = 0;
    ModelObject* object = nullptr;
    ModelInstance* instance = nullptr;
};

std::uint64_t next_plate_session_sequence();
std::uint64_t next_plate_id_sequence();
std::uint64_t current_plate_session_sequence();

json session_transform_json(const Slic3r::Geometry::Transformation& transform);
PlateBounds selected_plate_bounds();
Vec3d plate_origin_for_index(int index, int count, const PlateBounds& bounds);
Vec3d parked_origin_for_count(int count, const PlateBounds& bounds);

void reset_plate_session_state();
void ensure_plate_session_state();
void normalize_coordinate_arrays(DynamicPrintConfig& project_config, std::size_t plate_count);
bool coordinate_arrays_match_plate_count(const DynamicPrintConfig& project_config,
                                         std::size_t plate_count);
const BridgeState::PlateSessionPlate* find_plate(const std::string& id);
BridgeState::PlateSessionPlate* find_plate_mutable(const std::string& id);

json instance_membership_json();
json plate_session_snapshot_json(const json& instance_transforms = json::array(),
                                 bool include_membership = true);
std::vector<PlateInstanceRef> plate_instance_refs();
std::optional<Model> make_current_plate_model(const BridgeState::PlateSessionPlate& plate,
                                              std::string& error);
bool validate_plate_operation_target(const std::string& plate_id,
                                     std::uint64_t revision,
                                     std::string& error);

BoundingBoxf3 instance_hull_box(const PlateInstanceRef& ref);
bool box_intersects_plate(const BoundingBoxf3& box,
                          const BridgeState::PlateSessionPlate& plate,
                          const PlateBounds& bounds);
std::vector<Vec2d> selected_printable_area(const PlateBounds& bounds,
                                           const BridgeState::PlateSessionPlate& plate);
bool box_fully_inside_plate(const PlateInstanceRef& ref, const BoundingBoxf3& box,
                            const BridgeState::PlateSessionPlate& plate,
                            const PlateBounds& bounds);
json instance_transform_record(const PlateInstanceRef& ref);
void set_instance_transform(const PlateInstanceRef& ref, const json& transform);
void translate_instance(const PlateInstanceRef& ref, const Vec3d& delta);
void rebuild_plate_membership(bool clear_parked,
                              const std::set<std::size_t>* affected_instances = nullptr);
json reflow_instance_transforms(const std::map<std::size_t, Vec3d>& changed);
std::set<std::string> member_plate_ids();
std::set<std::string> all_plate_ids();
std::set<std::string> member_plate_ids_for_instances(
    const std::set<std::size_t>& instance_ids);
json plate_id_array(const std::set<std::string>& ids);
json plate_revisions_json();
json plate_mutation_snapshot(
    const std::set<std::string>& before,
    const std::vector<std::string>& dirty_reasons,
    const json& instance_transforms = json::array(),
    const std::set<std::size_t>* affected_instances = nullptr,
    const std::map<std::string, std::set<std::size_t>>* before_out_of_bounds = nullptr);
std::map<std::size_t, Vec3d> reflow_plate_origins_for_bounds(const PlateBounds& bounds);
void refresh_existing_plate_validity(const PlateBounds& bounds);
json shared_configuration_mutation_snapshot();
json attach_plate_mutation(json result, const json& mutation);

} // namespace Slic3r::Neo::Bridge::PlateSession
