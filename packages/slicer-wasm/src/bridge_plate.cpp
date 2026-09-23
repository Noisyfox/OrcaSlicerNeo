// ----------------------------------------------------------------
// Runtime multi-plate/session implementation for the Neo bridge.
// ----------------------------------------------------------------
#include "bridge_plate.hpp"
#include "bridge_history.hpp"
#include "bridge_performance.hpp"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <emscripten/emscripten.h>
#include <limits>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "libslic3r/BuildVolume.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "bridge_prime_tower.hpp"
#include "bridge_filament.hpp"
#include "bridge_scoped_config.hpp"

using namespace Slic3r;
using nlohmann::json;

namespace Slic3r::Neo::Bridge::PlateSession {

using namespace Slic3r;
using nlohmann::json;
using Neo::Bridge::BridgeState;
using Neo::Bridge::state;

std::atomic<std::uint64_t> g_plate_session_sequence{0};
std::atomic<std::uint64_t> g_plate_id_sequence{0};

std::uint64_t next_plate_session_sequence()
{
    return g_plate_session_sequence.fetch_add(1, std::memory_order_relaxed) + 1;
}

std::uint64_t next_plate_id_sequence()
{
    return g_plate_id_sequence.fetch_add(1, std::memory_order_relaxed) + 1;
}

std::uint64_t current_plate_session_sequence()
{
    return g_plate_session_sequence.load(std::memory_order_relaxed);
}

static constexpr int kMaxPlateCount = 36;
static constexpr double kPlateGap = 1. / 5.;

void normalize_coordinate_arrays(DynamicPrintConfig& project_config, const std::size_t plate_count)
{
    PrimeTower::normalize_coordinate_settings(project_config, plate_count, 15., 220.);
}

bool coordinate_arrays_match_plate_count(const DynamicPrintConfig& project_config,
                                         const std::size_t plate_count)
{
    const auto matches = [plate_count](const ConfigOptionFloats* option) {
        return option != nullptr && option->values.size() == plate_count &&
            std::all_of(option->values.begin(), option->values.end(),
                        [](double value) { return std::isfinite(value); });
    };
    return matches(project_config.opt<ConfigOptionFloats>("wipe_tower_x")) &&
        matches(project_config.opt<ConfigOptionFloats>("wipe_tower_y"));
}

static void adjust_plate_coordinate_arrays(const std::size_t index, const bool erase)
{
    auto& project_config = state().presets.project_config;
    if (erase) {
        for (const char* key : {"wipe_tower_x", "wipe_tower_y"}) {
            if (auto* option = project_config.opt<ConfigOptionFloats>(key);
                option != nullptr && index < option->values.size())
                option->values.erase(option->values.begin() + static_cast<std::ptrdiff_t>(index));
        }
    }
    normalize_coordinate_arrays(project_config, state().plate_session_plates.size());
}

json session_transform_json(const Slic3r::Geometry::Transformation& t)
{
    const auto offset = t.get_offset();
    const auto rotation = t.get_rotation();
    const auto scale = t.get_scaling_factor();
    const auto mirror = t.get_mirror();
    const Slic3r::Matrix4d m = t.get_matrix().matrix();
    json j = {{"offset", {offset.x(), offset.y(), offset.z()}},
              {"rotation", {rotation.x(), rotation.y(), rotation.z()}},
              {"scale", {scale.x(), scale.y(), scale.z()}},
              {"mirror", {mirror.x(), mirror.y(), mirror.z()}}};
    j["matrix"] = {m(0,0), m(1,0), m(2,0), m(3,0),
                    m(0,1), m(1,1), m(2,1), m(3,1),
                    m(0,2), m(1,2), m(2,2), m(3,2),
                    m(0,3), m(1,3), m(2,3), m(3,3)};
    return j;
}

PlateBounds selected_plate_bounds()
{
    PlateBounds bounds;
    try {
        const Preset& printer = state().presets.printers.get_selected_preset();
        if (const auto* area = printer.config.opt<ConfigOptionPoints>("printable_area");
            area != nullptr && area->values.size() >= 3) {
            bounds.min_x = bounds.max_x = area->values.front().x();
            bounds.min_y = bounds.max_y = area->values.front().y();
            for (const Vec2d& point : area->values) {
                bounds.min_x = std::min(bounds.min_x, point.x());
                bounds.max_x = std::max(bounds.max_x, point.x());
                bounds.min_y = std::min(bounds.min_y, point.y());
                bounds.max_y = std::max(bounds.max_y, point.y());
            }
        }
        if (const auto* height = printer.config.opt<ConfigOptionFloat>("printable_height");
            height != nullptr && std::isfinite(height->value) && height->value > 0.)
            bounds.max_z = height->value;
    } catch (...) {
        // A bridge snapshot must remain usable even before profile setup. The
        // deterministic runtime default is a 200 mm square bed.
    }
    return bounds;
}

int plate_column_count(const int count)
{
    if (count <= 1) return 1;
    const double root = std::sqrt(static_cast<double>(count));
    const int rounded = static_cast<int>(std::round(root));
    return root > static_cast<double>(rounded) ? rounded + 1 : rounded;
}

Vec3d plate_origin_for_index(const int index, const int count, const PlateBounds& bounds)
{
    const int cols = plate_column_count(count);
    const int row = index / cols;
    const int col = index % cols;
    const double stride_x = (bounds.max_x - bounds.min_x) * (1. + kPlateGap);
    const double stride_y = (bounds.max_y - bounds.min_y) * (1. + kPlateGap);
    return Vec3d(col * stride_x, -row * stride_y, 0.);
}

Vec3d parked_origin_for_count(const int count, const PlateBounds& bounds)
{
    const int cols = plate_column_count(count);
    const int max_count = cols * cols;
    const int index = count == max_count ? max_count + cols - 1 : count;
    const int parked_cols = count == max_count ? cols + 1 : cols;
    const int row = index / parked_cols;
    const int col = index % parked_cols;
    const double stride_x = (bounds.max_x - bounds.min_x) * (1. + kPlateGap);
    const double stride_y = (bounds.max_y - bounds.min_y) * (1. + kPlateGap);
    return Vec3d(col * stride_x, -row * stride_y, 0.);
}


void reset_plate_session_state()
{
    auto& s = state();
    PrimeTower::invalidate_projection_cache();
    const auto sequence = next_plate_session_sequence();
    s.plate_session_plates.clear();
    s.instance_plate_ids.clear();
    s.plate_out_of_bounds_ids.clear();
    s.parked_instance_ids.clear();
    s.pending_membership_instance_ids.clear();
    s.plate_input_revisions.clear();
    const auto plate_id = "plate-session-" + std::to_string(sequence) + "-plate-1";
    s.plate_session_plates.push_back({plate_id, "Plate 1", 0, Vec3d::Zero()});
    s.plate_input_revisions[plate_id] = 0;
    s.current_plate_id = plate_id;
    normalize_coordinate_arrays(s.presets.project_config, s.plate_session_plates.size());
    reconcile_plate_runtime_registry();
}

void ensure_plate_session_state()
{
    if (state().plate_session_plates.empty() || state().current_plate_id.empty()) reset_plate_session_state();
    else reconcile_plate_runtime_registry();
}

PlateRuntimeRegistry::Retirements reconcile_plate_runtime_registry()
{
    std::vector<std::string> plate_ids;
    plate_ids.reserve(state().plate_session_plates.size());
    for (const auto& plate : state().plate_session_plates)
        plate_ids.push_back(plate.id);
    return state().plate_runtime_registry.reconcile(plate_ids);
}

const BridgeState::PlateSessionPlate* find_plate(const std::string& id)
{
    ensure_plate_session_state();
    const auto& plates = state().plate_session_plates;
    const auto it = std::find_if(plates.begin(), plates.end(), [&](const auto& plate) { return plate.id == id; });
    return it == plates.end() ? nullptr : &*it;
}

BridgeState::PlateSessionPlate* find_plate_mutable(const std::string& id)
{
    ensure_plate_session_state();
    auto& plates = state().plate_session_plates;
    const auto it = std::find_if(plates.begin(), plates.end(), [&](const auto& plate) { return plate.id == id; });
    return it == plates.end() ? nullptr : &*it;
}

json instance_membership_json()
{
    json instances = json::array();
    for (size_t object_index = 0; object_index < state().model.objects.size(); ++object_index) {
        const ModelObject* object = state().model.objects[object_index];
        for (size_t instance_index = 0; instance_index < object->instances.size(); ++instance_index) {
            const ModelInstance* instance = object->instances[instance_index];
            const std::size_t id = instance->id().id;
            const auto membership = state().instance_plate_ids.find(id);
            const std::string plate_id = membership == state().instance_plate_ids.end() ? "" : membership->second;
            const bool parked = state().parked_instance_ids.find(id) != state().parked_instance_ids.end();
            const bool out_of_bounds = !plate_id.empty() &&
                state().plate_out_of_bounds_ids[plate_id].find(id) != state().plate_out_of_bounds_ids[plate_id].end();
            instances.push_back({
                {"instance_id", id}, {"object_id", object->id().id},
                {"object_index", object_index}, {"instance_index", instance_index},
                {"plate_id", plate_id}, {"member", !plate_id.empty()},
                {"parked", parked}, {"unprintable", parked || plate_id.empty()},
                {"out_of_bounds", out_of_bounds},
            });
        }
    }
    return instances;
}

json plate_revisions_json();

json plate_session_snapshot_json(const json& instance_transforms, bool include_membership)
{
    ensure_plate_session_state();
    json plates = json::array();
    for (const auto& plate : state().plate_session_plates) {
        json out_of_bounds = json::array();
        json members = json::array();
        for (const auto& [instance_id, plate_id] : state().instance_plate_ids) {
            if (plate_id == plate.id) members.push_back(instance_id);
        }
        const auto out_it = state().plate_out_of_bounds_ids.find(plate.id);
        if (out_it != state().plate_out_of_bounds_ids.end())
            for (const auto instance_id : out_it->second) out_of_bounds.push_back(instance_id);
        const bool plate_valid = out_of_bounds.empty();
        plates.push_back(json{
            {"plate_id", plate.id}, {"display_index", plate.display_index},
            {"origin", {plate.origin.x(), plate.origin.y(), plate.origin.z()}},
            {"name", plate.name}, {"instance_ids", std::move(members)},
            {"out_of_bounds_instance_ids", std::move(out_of_bounds)},
            {"valid", plate_valid}, {"locked", plate.locked},
            {"settings", plate.settings_metadata},
            {"opaque_metadata", plate.opaque_metadata},
        });
    }
    json result{
        {"ok", true},
        {"version", 1},
        {"current_plate_id", state().current_plate_id},
        {"plates", std::move(plates)},
        {"instance_transforms", instance_transforms},
        {"input_revisions", plate_revisions_json()},
    };
    if (include_membership) result["instances"] = instance_membership_json();
    return result;
}

std::vector<PlateInstanceRef> plate_instance_refs()
{
    std::vector<PlateInstanceRef> refs;
    for (size_t oi = 0; oi < state().model.objects.size(); ++oi) {
        ModelObject* object = state().model.objects[oi];
        for (size_t ii = 0; ii < object->instances.size(); ++ii) {
            ModelInstance* instance = object->instances[ii];
            refs.push_back({oi, ii, instance->id().id, object, instance});
        }
    }
    return refs;
}

namespace {

using PlateInstanceRefIndex = std::map<std::size_t, const PlateInstanceRef*>;

PlateInstanceRefIndex index_plate_instance_refs(const std::vector<PlateInstanceRef>& refs)
{
    PlateInstanceRefIndex index;
    for (const auto& ref : refs)
        index.emplace(ref.instance_id, &ref);
    return index;
}

} // namespace

// Build the print input for one plate without touching the authoritative
// editing model.  Orca's PartPlate passes a complete world-space Model to
// Print after updating its print-volume state with the selected plate's
// translated BuildVolume.  Print::apply then retains only printable instances
// for that plate, while GCode::set_gcode_offset subtracts the selected origin
// only when emitting printer-local coordinates.  Keeping this filtering in the
// native Model state is important: copying just membership rows would bypass
// the same BuildVolume/printable-instance semantics used by Orca.
std::optional<Model> make_current_plate_model(const BridgeState::PlateSessionPlate& plate,
                                              std::string& error)
{
    Model plate_model = state().model;
    plate_model.curr_plate_index = plate.display_index;
    const PlateBounds bounds = selected_plate_bounds();
    const auto printable_area = selected_printable_area(bounds, plate);
    BuildVolume build_volume(printable_area, bounds.max_z, {}, {});
    if (plate_model.update_print_volume_state(build_volume) == 0) {
        error = "current plate is empty";
        return std::nullopt;
    }
    return plate_model;
}

bool validate_plate_operation_target(const std::string& plate_id,
                                     const std::uint64_t revision,
                                     std::string& error)
{
    ensure_plate_session_state();
    if (plate_id.empty() || plate_id != state().current_plate_id) {
        error = "plate operation target is not the current plate";
        return false;
    }
    const auto* plate = find_plate(plate_id);
    if (plate == nullptr) {
        error = "plate operation target was not found";
        return false;
    }
    const auto current_revision = state().plate_input_revisions[plate_id];
    if (revision != current_revision) {
        error = "plate operation target is stale";
        return false;
    }
    const auto out_of_bounds = state().plate_out_of_bounds_ids.find(plate_id);
    if (out_of_bounds != state().plate_out_of_bounds_ids.end() && !out_of_bounds->second.empty()) {
        error = "current plate contains an out-of-bounds instance";
        return false;
    }
    bool has_member = false;
    for (const auto& [instance_id, member_plate_id] : state().instance_plate_ids) {
        (void)instance_id;
        if (member_plate_id == plate_id) { has_member = true; break; }
    }
    if (!has_member) {
        error = "current plate is empty";
        return false;
    }
    return true;
}

BoundingBoxf3 instance_hull_box(const PlateInstanceRef& ref)
{
    for (ModelVolume* volume : ref.object->volumes) {
        if (volume->is_model_part() && !volume->get_convex_hull_shared_ptr())
            volume->calculate_convex_hull();
    }
    return ref.object->instance_convex_hull_bounding_box(ref.instance);
}

bool box_intersects_plate(const BoundingBoxf3& box, const BridgeState::PlateSessionPlate& plate,
                          const PlateBounds& bounds)
{
    if (!box.defined) return false;
    const double min_x = plate.origin.x() + bounds.min_x;
    const double max_x = plate.origin.x() + bounds.max_x;
    const double min_y = plate.origin.y() + bounds.min_y;
    const double max_y = plate.origin.y() + bounds.max_y;
    return box.max.x() >= min_x && box.min.x() <= max_x &&
           box.max.y() >= min_y && box.min.y() <= max_y &&
           box.max.z() >= 0. && box.min.z() <= bounds.max_z;
}

std::vector<Vec2d> selected_printable_area(const PlateBounds& bounds,
                                           const BridgeState::PlateSessionPlate& plate)
{
    std::vector<Vec2d> area;
    try {
        const Preset& printer = state().presets.printers.get_selected_preset();
        if (const auto* configured = printer.config.opt<ConfigOptionPoints>("printable_area");
            configured != nullptr && configured->values.size() >= 3) {
            area.reserve(configured->values.size());
            for (const Vec2d& point : configured->values)
                area.emplace_back(point.x() + plate.origin.x(), point.y() + plate.origin.y());
        }
    } catch (...) {
        // Keep the deterministic runtime default in sync with selected_plate_bounds().
    }
    if (area.size() < 3) {
        area = {{plate.origin.x() + bounds.min_x, plate.origin.y() + bounds.min_y},
                {plate.origin.x() + bounds.max_x, plate.origin.y() + bounds.min_y},
                {plate.origin.x() + bounds.max_x, plate.origin.y() + bounds.max_y},
                {plate.origin.x() + bounds.min_x, plate.origin.y() + bounds.max_y}};
    }
    return area;
}

// Match Orca's PartPlate::check_outside semantics.  In particular, Orca
// treats a model that is slightly sunk into the bed specially: it evaluates
// the convex hull with BuildVolume instead of requiring bbox.min.z() >= 0.
// Support-bearing projects commonly contain this legitimate small negative Z
// offset, and the old bridge-side AABB check incorrectly marked those plates
// out of bounds.
bool box_fully_inside_plate(const PlateInstanceRef& ref, const BoundingBoxf3& box,
                            const BridgeState::PlateSessionPlate& plate, const PlateBounds& bounds)
{
    if (!box.defined) return false;
    const double eps = BuildVolume::SceneEpsilon;
    BoundingBoxf3 plate_box(
        Vec3d(plate.origin.x() + bounds.min_x - eps,
              plate.origin.y() + bounds.min_y - eps,
              plate.origin.z() - eps),
        Vec3d(plate.origin.x() + bounds.max_x + eps,
              plate.origin.y() + bounds.max_y + eps,
              plate.origin.z() + bounds.max_z + eps));

    // This is the same lower-Z adjustment used by PartPlate::check_outside:
    // a model that rests below the mathematical bed plane is not rejected
    // merely because of its sinking offset.
    if (box.max.z() > plate_box.min.z())
        plate_box.min.z() += box.min.z();

    if (box.min.z() < SINKING_Z_THRESHOLD) {
        if (!plate_box.intersects(box)) return false;
        const BuildVolume build_volume(selected_printable_area(bounds, plate), bounds.max_z, {}, {});
        return ref.instance->calc_print_volume_state(build_volume) != ModelInstancePVS_Partly_Outside;
    }

    return plate_box.contains(box);
}

json instance_transform_record(const PlateInstanceRef& ref)
{
    return json{{"instance_id", ref.instance_id}, {"object_id", ref.object->id().id},
                {"object_index", ref.object_index}, {"instance_index", ref.instance_index},
                {"world_transform", session_transform_json(ref.instance->get_transformation())}};
}

namespace {

Vec3d transform_vec3(const json& transform, const char* key)
{
    const auto& value = transform.at(key);
    if (!value.is_array() || value.size() != 3)
        throw std::runtime_error(std::string("transform.") + key + " must be a 3-vector");
    return Vec3d(value[0].get<double>(), value[1].get<double>(), value[2].get<double>());
}

void assign_transform(Geometry::Transformation& target, const json& transform)
{
    if (!transform.is_object()) throw std::runtime_error("instance transform must be an object");
    if (transform.contains("matrix") && transform["matrix"].is_array()) {
        const auto& values = transform["matrix"];
        if (values.size() != 16) throw std::runtime_error("transform.matrix must be 16 numbers");
        Matrix4d matrix;
        for (int column = 0; column < 4; ++column)
            for (int row = 0; row < 4; ++row)
                matrix(row, column) = values[column * 4 + row].get<double>();
        target.set_matrix(Transform3d(matrix));
        return;
    }
    target.set_offset(transform_vec3(transform, "offset"));
    target.set_rotation(transform_vec3(transform, "rotation"));
    target.set_scaling_factor(transform_vec3(transform, "scale"));
    target.set_mirror(transform_vec3(transform, "mirror"));
}

} // namespace

void set_instance_transform(const PlateInstanceRef& ref, const json& transform)
{
    if (ref.instance == nullptr || ref.object == nullptr)
        throw std::runtime_error("instance transform target is unavailable");
    auto next = ref.instance->get_transformation();
    assign_transform(next, transform);
    if (next != ref.instance->get_transformation()) {
        ref.instance->set_transformation(next);
        ref.object->config.touch();
        ref.object->invalidate_bounding_box();
    }
}

void translate_instance(const PlateInstanceRef& ref, const Vec3d& delta)
{
    if (delta == Vec3d::Zero()) return;
    auto transform = ref.instance->get_transformation();
    transform.set_offset(transform.get_offset() + delta);
    ref.instance->set_transformation(transform);
    ref.object->config.touch();
    ref.object->invalidate_bounding_box();
}

void rebuild_plate_membership(bool clear_parked, const std::set<std::size_t>* affected_instances)
{
    ensure_plate_session_state();
    const PlateBounds bounds = selected_plate_bounds();
    if (affected_instances == nullptr) {
        if (clear_parked) state().parked_instance_ids.clear();
        state().instance_plate_ids.clear();
        state().plate_out_of_bounds_ids.clear();
    } else {
        if (clear_parked) {
            for (const auto instance_id : *affected_instances)
                state().parked_instance_ids.erase(instance_id);
        }
        for (const auto instance_id : *affected_instances)
            state().instance_plate_ids.erase(instance_id);
        for (auto it = state().plate_out_of_bounds_ids.begin(); it != state().plate_out_of_bounds_ids.end();) {
            for (const auto instance_id : *affected_instances)
                it->second.erase(instance_id);
            if (it->second.empty()) it = state().plate_out_of_bounds_ids.erase(it);
            else ++it;
        }
    }
    for (const auto& ref : plate_instance_refs()) {
        if (affected_instances != nullptr && affected_instances->find(ref.instance_id) == affected_instances->end())
            continue;
        if (!clear_parked && state().parked_instance_ids.find(ref.instance_id) != state().parked_instance_ids.end())
            continue;
        const BoundingBoxf3 box = instance_hull_box(ref);
        for (const auto& plate : state().plate_session_plates) {
            if (!box_intersects_plate(box, plate, bounds)) continue;
            state().instance_plate_ids[ref.instance_id] = plate.id;
            if (!box_fully_inside_plate(ref, box, plate, bounds))
                state().plate_out_of_bounds_ids[plate.id].insert(ref.instance_id);
            break; // lowest display-index plate wins ties, matching Orca.
        }
    }
}

json reflow_instance_transforms(const std::map<std::size_t, Vec3d>& changed)
{
    json transforms = json::array();
    for (const auto& ref : plate_instance_refs()) {
        if (changed.find(ref.instance_id) != changed.end())
            transforms.push_back(instance_transform_record(ref));
    }
    return transforms;
}

std::set<std::string> member_plate_ids()
{
    std::set<std::string> ids;
    for (const auto& [instance_id, plate_id] : state().instance_plate_ids) {
        (void)instance_id;
        if (!plate_id.empty()) ids.insert(plate_id);
    }
    return ids;
}

std::set<std::string> all_plate_ids()
{
    std::set<std::string> ids;
    for (const auto& plate : state().plate_session_plates) ids.insert(plate.id);
    return ids;
}

std::set<std::string> member_plate_ids_for_instances(const std::set<std::size_t>& instance_ids)
{
    std::set<std::string> ids;
    for (const auto instance_id : instance_ids) {
        const auto it = state().instance_plate_ids.find(instance_id);
        if (it != state().instance_plate_ids.end() && !it->second.empty()) ids.insert(it->second);
    }
    return ids;
}

json plate_id_array(const std::set<std::string>& ids)
{
    json out = json::array();
    for (const auto& id : ids) out.push_back(id);
    return out;
}

json plate_revisions_json()
{
    json out = json::object();
    for (const auto& plate : state().plate_session_plates) {
        const auto it = state().plate_input_revisions.find(plate.id);
        out[plate.id] = it == state().plate_input_revisions.end() ? 0 : it->second;
    }
    return out;
}

// Finish a committed model mutation.  The membership snapshot is captured
// before callers mutate the Model, then rebuilt exactly once after all selected
// transforms/deletes/imports have been applied.  This gives the renderer one
// atomic response and makes cross-plate edits a single invalidation event.
json plate_mutation_snapshot(const std::set<std::string>& before,
                             const std::vector<std::string>& dirty_reasons,
                             const json& instance_transforms,
                             const std::set<std::size_t>* affected_instances)
{
    const auto after = affected_instances == nullptr ? member_plate_ids()
                                                       : member_plate_ids_for_instances(*affected_instances);
    std::set<std::string> affected = before;
    affected.insert(after.begin(), after.end());
    // Projection entries are derived from one plate's membership and input
    // stamp.  A model add/delete/transform therefore withdraws only the
    // before/after plates; their used-slot summaries remain available for a
    // delta update, while unrelated plates stay cache hits.
    PrimeTower::invalidate_projection_cache(affected);
    // Allocate all new stamps before publishing any of them.  If the session
    // allocator is exhausted, the mutation must fail without leaving a
    // partially advanced set of live plate revisions or presentation state.
    std::map<std::string, std::uint64_t> next_revisions;
    std::set<std::string> live_affected;
    for (const auto& id : affected)
        if (find_plate(id) != nullptr) {
            next_revisions.emplace(id, allocate_plate_input_stamp(state()));
            live_affected.insert(id);
        }
    for (const auto& [id, revision] : next_revisions)
        state().plate_input_revisions[id] = revision;
    // Presentation validity is a per-plate concern.  Keep every affected
    // Print/GCode allocation resident while withdrawing only the React/export
    // projection for plates containing the moved instance before or after the
    // transaction.
    state().plate_runtime_registry.invalidate_presentations(live_affected);
    json result = plate_session_snapshot_json(instance_transforms);
    result["input_revisions"] = plate_revisions_json();
    result["affected_plate_ids_before"] = plate_id_array(before);
    result["affected_plate_ids_after"] = plate_id_array(after);
    result["affected_plate_ids"] = plate_id_array(affected);
    result["dirty_reasons"] = dirty_reasons;
    result["native_scoped_config"] = Neo::Bridge::ScopedConfig::native_scoped_config_full_transport(
        state().history_revision);
    // A completed transaction consumes any deferred transform markers. This
    // is important when a structural command (for example Add plate) follows
    // a transform write before the normal recompute call.
    state().pending_membership_instance_ids.clear();
    return result;
}

json add_plate_mutation_snapshot(const std::set<std::string>& changed_origin_plates,
                                 const json& instance_transforms)
{
    // A same-column-count insertion has no old-plate input mutation. When the
    // grid grows, invalidate only plates whose physical origin moved; the new
    // plate already owns a fresh empty registry entry and revision zero.
    if (!changed_origin_plates.empty()) {
        PrimeTower::invalidate_projection_cache(changed_origin_plates);
        state().plate_runtime_registry.invalidate_presentations(changed_origin_plates);
        for (const auto& plate_id : changed_origin_plates)
            if (find_plate(plate_id) != nullptr)
                state().plate_input_revisions[plate_id] = allocate_plate_input_stamp(state());
    }
    json result = plate_session_snapshot_json(instance_transforms);
    result["input_revisions"] = plate_revisions_json();
    result["affected_plate_ids_before"] = plate_id_array(changed_origin_plates);
    result["affected_plate_ids_after"] = plate_id_array(changed_origin_plates);
    result["affected_plate_ids"] = plate_id_array(changed_origin_plates);
    result["dirty_reasons"] = {"plate-structure"};
    // Plate insertion normalizes the per-plate wipe-tower coordinate arrays.
    // Publish that same authoritative native snapshot with the structural receipt so
    // the renderer cannot retain a pre-insertion snapshot and unnecessarily
    // reject a later adjacent Move restore receipt.
    result["native_scoped_config"] = Neo::Bridge::ScopedConfig::native_scoped_config_full_transport(
        state().history_revision);
    state().pending_membership_instance_ids.clear();
    return result;
}

json delete_plate_mutation_snapshot(const std::set<std::string>& changed_origin_plates,
                                    const json& instance_transforms)
{
    if (!changed_origin_plates.empty()) {
        PrimeTower::invalidate_projection_cache(changed_origin_plates);
        state().plate_runtime_registry.invalidate_presentations(changed_origin_plates);
        for (const auto& plate_id : changed_origin_plates)
            if (find_plate(plate_id) != nullptr)
                state().plate_input_revisions[plate_id] = allocate_plate_input_stamp(state());
    }
    json result = plate_session_snapshot_json(instance_transforms);
    result["input_revisions"] = plate_revisions_json();
    result["affected_plate_ids_before"] = plate_id_array(changed_origin_plates);
    result["affected_plate_ids_after"] = plate_id_array(changed_origin_plates);
    result["affected_plate_ids"] = plate_id_array(changed_origin_plates);
    result["dirty_reasons"] = {"plate-structure"};
    result["native_scoped_config"] = Neo::Bridge::ScopedConfig::native_scoped_config_full_transport(
        state().history_revision);
    state().pending_membership_instance_ids.clear();
    return result;
}

json configuration_mutation_snapshot(
    const std::set<std::string>& affected_plate_ids,
    const std::vector<std::string>& dirty_reasons,
    const json& instance_transforms)
{
    // Allocate every stamp before publishing any of them. Configuration
    // rejection must not leave only a prefix of the affected plate set dirty.
    std::map<std::string, std::uint64_t> next_revisions;
    std::set<std::string> live_affected;
    for (const auto& plate_id : affected_plate_ids) {
        if (find_plate(plate_id) == nullptr) continue;
        next_revisions.emplace(plate_id, allocate_plate_input_stamp(state()));
        live_affected.insert(plate_id);
    }
    for (const auto& [plate_id, revision] : next_revisions)
        state().plate_input_revisions[plate_id] = revision;

    // A configuration edit withdraws only the transferable presentation.
    // Registry-owned Print and GCodeProcessorResult allocations deliberately
    // remain resident for native incremental invalidation on the next Slice.
    PrimeTower::invalidate_projection_cache_and_usage_summaries(live_affected);
    state().plate_runtime_registry.invalidate_presentations(live_affected);

    json result = plate_session_snapshot_json(instance_transforms);
    result["input_revisions"] = plate_revisions_json();
    result["affected_plate_ids_before"] = plate_id_array(live_affected);
    result["affected_plate_ids_after"] = plate_id_array(live_affected);
    result["affected_plate_ids"] = plate_id_array(live_affected);
    result["dirty_reasons"] = dirty_reasons;
    state().pending_membership_instance_ids.clear();
    return result;
}

// Reflow the display grid after a shared configuration change (most notably a
// printer preset changing printable_area).  Plate membership is deliberately
// not recomputed here: every member keeps the same plate-local coordinates,
// while parked/unassigned instances remain untouched.  The returned IDs are
// resolved into authoritative world transforms after all origins have moved.
std::map<std::size_t, Vec3d> reflow_plate_origins_for_bounds(const PlateBounds& bounds)
{
    ensure_plate_session_state();
    const auto old_plates = state().plate_session_plates;
    std::map<std::size_t, Vec3d> changed;
    const auto refs = plate_instance_refs();
    const auto refs_by_id = index_plate_instance_refs(refs);
    const int count = static_cast<int>(old_plates.size());
    for (size_t index = 0; index < old_plates.size(); ++index) {
        const Vec3d new_origin = plate_origin_for_index(static_cast<int>(index), count, bounds);
        const Vec3d delta = new_origin - old_plates[index].origin;
        if (delta != Vec3d::Zero()) {
            for (const auto& [instance_id, plate_id] : state().instance_plate_ids) {
                if (plate_id != old_plates[index].id) continue;
                const auto ref = refs_by_id.find(instance_id);
                if (ref == refs_by_id.end()) continue;
                translate_instance(*ref->second, delta);
                changed[instance_id] = delta;
            }
        }
        state().plate_session_plates[index].origin = new_origin;
    }
    return changed;
}

// A printer change must not move an instance to a different plate, but it can
// change whether that existing member fits its newly sized bed. Refresh only
// the validity map against the new origins/bounds; parked and unassigned
// instances remain outside the map and are never reconsidered here.
void refresh_existing_plate_validity(const PlateBounds& bounds)
{
    state().plate_out_of_bounds_ids.clear();
    const auto refs = plate_instance_refs();
    const auto refs_by_id = index_plate_instance_refs(refs);
    for (const auto& membership : state().instance_plate_ids) {
        const auto instance_id = membership.first;
        const auto& plate_id = membership.second;
        if (plate_id.empty() || state().parked_instance_ids.find(instance_id) != state().parked_instance_ids.end())
            continue;
        const auto* plate = find_plate(plate_id);
        if (plate == nullptr) continue;
        const auto ref = refs_by_id.find(instance_id);
        if (ref == refs_by_id.end()) continue;
        if (!box_fully_inside_plate(*ref->second, instance_hull_box(*ref->second), *plate, bounds))
            state().plate_out_of_bounds_ids[plate_id].insert(instance_id);
    }
}

// Shared printer/process/filament configuration affects every existing plate,
// including empty plates. Keep this transaction in the bridge so the complete
// plate set and its revisions remain authoritative rather than relying on a
// renderer-side list that may be stale.
json shared_configuration_mutation_snapshot()
{
    const auto bounds = selected_plate_bounds();
    const auto changed = reflow_plate_origins_for_bounds(bounds);
    refresh_existing_plate_validity(bounds);
    // Printer/process/settings transitions use the same native coordinates
    // for both projection and slicing. The caller decides whether this
    // mutation is history-backed; this lifecycle step merely publishes the
    // normalized arrays in the current Worker state.
    PrimeTower::normalize_coordinate_positions();
    const auto affected = all_plate_ids();
    return configuration_mutation_snapshot(
        affected, {"shared-configuration"}, reflow_instance_transforms(changed));
}

json attach_plate_mutation(json result, const json& mutation)
{
    result["plate_session"] = mutation;
    return result;
}



} // namespace Slic3r::Neo::Bridge::PlateSession

namespace {

using Neo::Bridge::state;
using namespace Neo::Bridge::PlateSession;

constexpr int kMaxPlateCommandCount = 36;

const char* dup_json(const std::string& text)
{
    char* result = static_cast<char*>(std::malloc(text.size() + 1));
    if (result == nullptr) return nullptr;
    std::memcpy(result, text.data(), text.size());
    result[text.size()] = '\0';
    return result;
}

const char* error_json(const std::string& message)
{
    return dup_json(json{{"error", message}}.dump());
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_get_plate_session_snapshot()
{
    try {
        return dup_json(plate_session_snapshot_json().dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_reset_plate_session()
{
    try {
        reset_plate_session_state();
        return dup_json(plate_session_snapshot_json().dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_select_plate(const char* plate_id_cstr)
{
    try {
        ensure_plate_session_state();
        const std::string requested = plate_id_cstr ? plate_id_cstr : "";
        if (requested.empty()) return error_json("plateId is required");
        if (find_plate(requested) == nullptr)
            return error_json("plate not found");
        state().current_plate_id = requested;
        return dup_json(json{{"ok", true}, {"version", 1},
                             {"current_plate_id", state().current_plate_id}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_add_plate()
{
    std::optional<Neo::Bridge::PlateRuntimeRegistry::LifecycleSnapshots> before_lifecycle;
    try {
        const double profile_started_at = Neo::Bridge::Performance::now_ms();
        ensure_plate_session_state();
        before_lifecycle = state().plate_runtime_registry.capture_lifecycle();
        if (state().plate_session_plates.size() >= static_cast<std::size_t>(kMaxPlateCommandCount))
            return error_json("maximum of 36 plates");
        const PlateBounds bounds = selected_plate_bounds();
        const auto old_plates = state().plate_session_plates;
        const std::size_t old_count = old_plates.size();
        const int new_count = static_cast<int>(old_plates.size()) + 1;
        const bool column_count_changed = plate_column_count(static_cast<int>(old_count)) !=
            plate_column_count(new_count);
        const double membership_started_at = Neo::Bridge::Performance::now_ms();
        if (column_count_changed) rebuild_plate_membership(false);
        const double membership_finished_at = Neo::Bridge::Performance::now_ms();
        const double reflow_started_at = Neo::Bridge::Performance::now_ms();
        std::map<std::size_t, Vec3d> changed;
        std::set<std::string> changed_origin_plates;
        if (column_count_changed) {
            const auto refs = plate_instance_refs();
            const auto refs_by_id = index_plate_instance_refs(refs);
            for (size_t index = 0; index < old_plates.size(); ++index) {
                const Vec3d delta = plate_origin_for_index(static_cast<int>(index), new_count, bounds) - old_plates[index].origin;
                if (delta == Vec3d::Zero()) continue;
                changed_origin_plates.insert(old_plates[index].id);
                for (const auto& [instance_id, plate_id] : state().instance_plate_ids) {
                    if (plate_id != old_plates[index].id) continue;
                    const auto ref = refs_by_id.find(instance_id);
                    if (ref == refs_by_id.end()) continue;
                    translate_instance(*ref->second, delta);
                    changed[instance_id] = delta;
                }
            }
        }
        const auto sequence = next_plate_id_sequence();
        const std::string id = "plate-session-plate-" + std::to_string(sequence);
        state().plate_session_plates.push_back({id, "Plate " + std::to_string(new_count), new_count - 1,
                                                plate_origin_for_index(new_count - 1, new_count, bounds)});
        state().plate_input_revisions[id] = 0;
        adjust_plate_coordinate_arrays(0, false);
        for (size_t index = 0; index < state().plate_session_plates.size(); ++index) {
            auto& plate = state().plate_session_plates[index];
            plate.display_index = static_cast<int>(index);
            plate.origin = plate_origin_for_index(static_cast<int>(index), new_count, bounds);
        }
        reconcile_plate_runtime_registry();
        if (column_count_changed)
            Neo::Bridge::PrimeTower::normalize_coordinate_positions();
        state().current_plate_id = id;
        const double reflow_finished_at = Neo::Bridge::Performance::now_ms();
        const double snapshot_started_at = Neo::Bridge::Performance::now_ms();
        const auto after_transforms = reflow_instance_transforms(changed);
        const auto mutation = add_plate_mutation_snapshot(changed_origin_plates, after_transforms);
        const std::string response = mutation.dump();
        const double snapshot_finished_at = Neo::Bridge::Performance::now_ms();
        Neo::Bridge::Performance::record("add_plate", {
            {"rebuild_plate_membership", membership_finished_at - membership_started_at},
            {"plate_reflow", reflow_finished_at - reflow_started_at},
            {"mutation_snapshot_and_json", snapshot_finished_at - snapshot_started_at},
            {"total", Neo::Bridge::Performance::now_ms() - profile_started_at},
        });
        return dup_json(response);
    } catch (const std::exception& e) {
        if (before_lifecycle) state().plate_runtime_registry.restore_lifecycle(*before_lifecycle);
        return error_json(e.what());
    } catch (...) {
        if (before_lifecycle) state().plate_runtime_registry.restore_lifecycle(*before_lifecycle);
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_reorder_plates(const char* plate_ids_json)
{
    try {
        ensure_plate_session_state();
        const json requested_json = json::parse(plate_ids_json ? plate_ids_json : "");
        if (!requested_json.is_array() || requested_json.size() != state().plate_session_plates.size())
            return error_json("plate order must contain every plate exactly once");

        std::vector<std::string> requested;
        std::set<std::string> unique;
        requested.reserve(requested_json.size());
        for (const auto& value : requested_json) {
            if (!value.is_string()) return error_json("plate order must contain only plate IDs");
            const auto id = value.get<std::string>();
            if (find_plate(id) == nullptr || !unique.insert(id).second)
                return error_json("plate order must contain every plate exactly once");
            requested.push_back(id);
        }

        const auto old_plates = state().plate_session_plates;
        std::map<std::string, BridgeState::PlateSessionPlate> old_by_id;
        std::map<std::string, std::pair<double, double>> tower_by_id;
        for (std::size_t index = 0; index < old_plates.size(); ++index) {
            old_by_id.emplace(old_plates[index].id, old_plates[index]);
            tower_by_id.emplace(old_plates[index].id, std::pair{
                Neo::Bridge::PrimeTower::coordinate_value(state().presets.project_config, "wipe_tower_x", index, 15.),
                Neo::Bridge::PrimeTower::coordinate_value(state().presets.project_config, "wipe_tower_y", index, 220.)});
        }

        const PlateBounds bounds = selected_plate_bounds();
        const auto refs = plate_instance_refs();
        const auto refs_by_id = index_plate_instance_refs(refs);
        std::map<std::size_t, Vec3d> changed_instances;
        std::set<std::string> changed_origin_plates;
        std::map<std::string, std::uint64_t> next_revisions;
        std::vector<BridgeState::PlateSessionPlate> reordered;
        reordered.reserve(requested.size());
        for (std::size_t index = 0; index < requested.size(); ++index) {
            auto plate = old_by_id.at(requested[index]);
            const Vec3d new_origin = plate_origin_for_index(
                static_cast<int>(index), static_cast<int>(requested.size()), bounds);
            const Vec3d delta = new_origin - plate.origin;
            if (delta != Vec3d::Zero()) {
                changed_origin_plates.insert(plate.id);
                next_revisions.emplace(plate.id, allocate_plate_input_stamp(state()));
                for (const auto& [instance_id, plate_id] : state().instance_plate_ids) {
                    if (plate_id != plate.id) continue;
                    const auto ref = refs_by_id.find(instance_id);
                    if (ref == refs_by_id.end()) continue;
                    translate_instance(*ref->second, delta);
                    changed_instances[instance_id] = delta;
                }
            }
            plate.display_index = static_cast<int>(index);
            plate.origin = new_origin;
            reordered.push_back(std::move(plate));
        }

        state().plate_session_plates = std::move(reordered);
        for (std::size_t index = 0; index < requested.size(); ++index) {
            const auto [x, y] = tower_by_id.at(requested[index]);
            Neo::Bridge::PrimeTower::set_coordinate_settings(state().presets.project_config, index, x, y, 15., 220.);
        }
        for (const auto& [plate_id, revision] : next_revisions)
            state().plate_input_revisions[plate_id] = revision;
        Neo::Bridge::PrimeTower::invalidate_projection_cache(changed_origin_plates);
        state().plate_runtime_registry.invalidate_presentations(changed_origin_plates);

        json result = plate_session_snapshot_json(reflow_instance_transforms(changed_instances));
        result["input_revisions"] = plate_revisions_json();
        result["affected_plate_ids_before"] = plate_id_array(changed_origin_plates);
        result["affected_plate_ids_after"] = plate_id_array(changed_origin_plates);
        result["affected_plate_ids"] = plate_id_array(changed_origin_plates);
        result["dirty_reasons"] = {"plate-structure"};
        result["native_scoped_config"] = Neo::Bridge::ScopedConfig::native_scoped_config_full_transport(
            state().history_revision);
        return dup_json(result.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_delete_plate(const char* plate_id_cstr)
{
    std::optional<Neo::Bridge::PlateRuntimeRegistry::LifecycleSnapshots> before_lifecycle;
    try {
        ensure_plate_session_state();
        before_lifecycle = state().plate_runtime_registry.capture_lifecycle();
        const std::string requested = plate_id_cstr ? plate_id_cstr : "";
        if (requested.empty()) return error_json("plateId is required");
        const auto it = std::find_if(state().plate_session_plates.begin(), state().plate_session_plates.end(),
                                     [&](const auto& plate) { return plate.id == requested; });
        if (it == state().plate_session_plates.end()) return error_json("plate not found");
        if (state().plate_session_plates.size() <= 1) return error_json("at least one plate must remain");
#ifndef ORCA_WASM_THREADING
        // A serial module cannot service this command until synchronous
        // Print::process() returns. Keep the native admission fence explicit
        // as well so a direct or queued bypass cannot create model/history
        // state before reporting the established busy terminal.
        if (state().plate_runtime_registry.has_active_job(requested))
            return error_json("slice_busy");
#endif
        rebuild_plate_membership(false);
        const PlateBounds bounds = selected_plate_bounds();
        const size_t deleted_index = static_cast<size_t>(std::distance(state().plate_session_plates.begin(), it));
        const auto old_plates = state().plate_session_plates;
        const auto refs = plate_instance_refs();
        const auto refs_by_id = index_plate_instance_refs(refs);
        const bool deleting_current = state().current_plate_id == requested;
        const int new_count = static_cast<int>(old_plates.size()) - 1;
        std::set<std::string> changed_origin_plates;
        for (size_t index = 0; index < old_plates.size(); ++index) {
            if (index == deleted_index) continue;
            const size_t new_index = index < deleted_index ? index : index - 1;
            if (plate_origin_for_index(static_cast<int>(new_index), new_count, bounds) != old_plates[index].origin)
                changed_origin_plates.insert(old_plates[index].id);
        }
        std::map<std::size_t, Vec3d> changed;
        const Vec3d parking_origin = parked_origin_for_count(new_count, bounds);
        const Vec3d deleted_delta = parking_origin - old_plates[deleted_index].origin;
        std::vector<std::size_t> deleted_instances;
        for (const auto& [instance_id, plate_id] : state().instance_plate_ids)
            if (plate_id == requested) deleted_instances.push_back(instance_id);
        for (const std::size_t instance_id : deleted_instances) {
            const auto ref = refs_by_id.find(instance_id);
            if (ref == refs_by_id.end()) continue;
            translate_instance(*ref->second, deleted_delta);
            changed[instance_id] = deleted_delta;
            state().instance_plate_ids.erase(instance_id);
            state().parked_instance_ids.insert(instance_id);
        }
        state().plate_session_plates.erase(state().plate_session_plates.begin() + static_cast<std::ptrdiff_t>(deleted_index));
        state().plate_input_revisions.erase(requested);
        adjust_plate_coordinate_arrays(deleted_index, true);
        for (size_t index = 0; index < state().plate_session_plates.size(); ++index) {
            auto& plate = state().plate_session_plates[index];
            const Vec3d new_origin = plate_origin_for_index(static_cast<int>(index), new_count, bounds);
            const Vec3d delta = new_origin - old_plates[index < deleted_index ? index : index + 1].origin;
            if (delta != Vec3d::Zero()) {
                for (const auto& [instance_id, plate_id] : state().instance_plate_ids) {
                    if (plate_id != plate.id) continue;
                    const auto ref = refs_by_id.find(instance_id);
                    if (ref == refs_by_id.end()) continue;
                    translate_instance(*ref->second, delta);
                    changed[instance_id] = delta;
                }
            }
            plate.display_index = static_cast<int>(index);
            plate.origin = new_origin;
        }
        [[maybe_unused]] const auto retirements = reconcile_plate_runtime_registry();
#ifdef ORCA_WASM_THREADING
        // Persistent deletion, model parking, and survivor reflow are already
        // committed. Cancellation is only an atomic request on the retired
        // incarnation; it never waits for the job lease to drain.
        for (const auto& retirement : retirements)
            state().plate_runtime_registry.request_retired_job_cancellation(
                retirement.incarnation_id);
#endif
        if (deleting_current) {
            const size_t selected_index = std::min(deleted_index, state().plate_session_plates.size() - 1);
            state().current_plate_id = state().plate_session_plates[selected_index].id;
        }
        Neo::Bridge::PrimeTower::normalize_coordinate_positions();
        const auto mutation = delete_plate_mutation_snapshot(changed_origin_plates,
                                                             reflow_instance_transforms(changed));
        return dup_json(mutation.dump());
    } catch (const std::exception& e) {
        if (before_lifecycle) state().plate_runtime_registry.restore_lifecycle(*before_lifecycle);
        return error_json(e.what());
    } catch (...) {
        if (before_lifecycle) state().plate_runtime_registry.restore_lifecycle(*before_lifecycle);
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_recompute_plate_membership()
{
    try {
        const auto affected_instances = state().pending_membership_instance_ids;
        const auto affected_before = affected_instances.empty()
            ? std::set<std::string>{}
            : member_plate_ids_for_instances(affected_instances);
        rebuild_plate_membership(true);
        const auto mutation = plate_mutation_snapshot(affected_before, {"model-transform"},
                                                       json::array(), &affected_instances);
        state().pending_membership_instance_ids.clear();
        return dup_json(mutation.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_mark_shared_configuration_mutation()
{
    std::optional<std::vector<std::pair<ModelObject*, ModelConfig>>> before_object_configs;
    std::optional<std::vector<std::pair<ModelInstance*, Geometry::Transformation>>> before_instance_transforms;
    std::optional<DynamicPrintConfig> before_project_config;
    std::optional<std::vector<BridgeState::PlateSessionPlate>> before_plates;
    std::optional<std::map<std::string, std::uint64_t>> before_revisions;
    std::optional<std::map<std::string, std::set<std::size_t>>> before_out_of_bounds;
    std::optional<std::set<std::size_t>> before_pending;
    std::optional<Slic3r::Neo::Bridge::PlateRuntimeRegistry::LifecycleSnapshots> before_lifecycle;
    const auto rollback = [&]() noexcept {
        if (!before_object_configs || !before_instance_transforms || !before_project_config || !before_plates || !before_revisions ||
            !before_out_of_bounds || !before_pending || !before_lifecycle) return;
        try {
            for (auto& [object, config] : *before_object_configs) {
                object->config.assign_config(std::move(config));
                object->invalidate_bounding_box();
            }
            for (auto& [instance, transform] : *before_instance_transforms)
                instance->set_transformation(transform);
            state().mutable_object_capture_cache.clear();
            state().presets.project_config = std::move(*before_project_config);
            state().plate_session_plates = std::move(*before_plates);
            state().plate_input_revisions = std::move(*before_revisions);
            state().plate_out_of_bounds_ids = std::move(*before_out_of_bounds);
            state().pending_membership_instance_ids = std::move(*before_pending);
            state().plate_runtime_registry.restore_lifecycle(*before_lifecycle);
            Slic3r::Neo::Bridge::PrimeTower::invalidate_projection_cache();
        } catch (...) {}
    };
    try {
        ensure_plate_session_state();
        before_object_configs.emplace();
        before_instance_transforms.emplace();
        before_object_configs->reserve(state().model.objects.size());
        for (auto* object : state().model.objects) {
            before_object_configs->emplace_back(
                object, static_cast<const ModelConfig&>(object->config));
            before_instance_transforms->reserve(
                before_instance_transforms->size() + object->instances.size());
            for (auto* instance : object->instances)
                before_instance_transforms->emplace_back(instance, instance->get_transformation());
        }
        before_project_config.emplace(state().presets.project_config);
        before_plates.emplace(state().plate_session_plates);
        before_revisions.emplace(state().plate_input_revisions);
        before_out_of_bounds.emplace(state().plate_out_of_bounds_ids);
        before_pending.emplace(state().pending_membership_instance_ids);
        before_lifecycle.emplace(state().plate_runtime_registry.capture_lifecycle());
        const auto* response = dup_json(shared_configuration_mutation_snapshot().dump());
        return response;
    } catch (const std::exception& e) {
        rollback();
        return error_json(e.what());
    } catch (...) {
        rollback();
        return error_json("unknown C++ exception");
    }
}

} // extern "C"
