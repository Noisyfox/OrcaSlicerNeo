#include "bridge_arrangement.hpp"
#include "bridge_state.hpp"
#include "bridge_plate.hpp"
#include "bridge_prime_tower.hpp"
#include "bridge_preset_drafts.hpp"
#include "bridge_history.hpp"
#include "libslic3r/Geometry/ConvexHull.hpp"
#include <emscripten/emscripten.h>
#include <cstdlib>
#include <cstring>
#include <map>
#include <set>
#include <stdexcept>

namespace Slic3r::Neo::Bridge::Arrangement {
using namespace PlateSession;
namespace A = Neo::Arrangement;
namespace {
json predecessor() {
    json transforms = json::array();
    for (const auto& ref : plate_instance_refs()) transforms.push_back(instance_transform_record(ref));
    return plate_session_snapshot_json(transforms);
}
const char* encode(const json& value) {
    const auto text = value.dump();
    auto* data = static_cast<char*>(std::malloc(text.size() + 1));
    if (!data) throw std::bad_alloc();
    std::memcpy(data, text.c_str(), text.size() + 1);
    return data;
}
const char* parking_name(A::ParkingReason reason) {
    switch (reason) {
    case A::ParkingReason::NonPrintable: return "non-printable";
    case A::ParkingReason::Degenerate: return "degenerate";
    case A::ParkingReason::TooTall: return "too-tall";
    case A::ParkingReason::Unfit: return "unfit";
    case A::ParkingReason::PlateLimit: return "plate-limit";
    case A::ParkingReason::CurrentPlateOverflow: return "current-plate-overflow";
    default: return "none";
    }
}
}
Operation prepare_operation(const json& request) {
    auto& s = state();
    ensure_plate_session_state();
    if (!request.is_object()) throw std::invalid_argument("Arrangement request must be an object");
    if (s.history_disabled || s.active_history_transaction || s.history.operation_active() || s.painting.current())
        throw std::runtime_error("Finish the current editing operation before arranging");
    const auto scope = request.value("scope", "all");
    if (scope != "all" && scope != "current") throw std::invalid_argument("Unknown arrangement scope");
    A::Settings settings;
    settings.scope = scope == "all" ? A::Scope::All : A::Scope::CurrentPlate;
    settings.distance = request.value("distance", 0.);
    settings.rotate = request.value("rotate", false);
    settings.align_y = request.value("align_y", false);
    settings.multiple_materials = request.value("multiple_materials", true);
    settings.avoid_calibration = request.value("avoid_calibration", true);
    A::SceneInput scene;
    scene.config = PresetDrafts::effective_full_config();
    scene.bambu = s.presets.is_bbl_vendor();
    std::map<std::string, std::size_t> indices;
    for (const auto& plate : s.plate_session_plates) {
        indices[plate.id] = scene.plates.size();
        if (plate.id == s.current_plate_id) scene.current_plate = scene.plates.size();
        scene.plates.push_back({plate.id, plate.origin, plate.locked, plate.settings});
    }
    for (const auto& ref : plate_instance_refs()) {
        (void)instance_hull_box(ref);
        const auto member = s.instance_plate_ids.find(ref.instance_id);
        scene.instances.push_back({ref.instance, member == s.instance_plate_ids.end() ? std::nullopt :
            std::optional<std::size_t>(indices.at(member->second))});
    }
    // Neo's prepared Prime Tower is a fixed reservation. The projection uses
    // the same native configuration and includes the rotated body's brim.
    const auto towers = PrimeTower::projection_json();
    for (const auto& tower : towers.at("plates")) {
        if (!tower.value("eligible", false)) continue;
        const auto& box = tower.at("footprint");
        arrangement::ArrangePolygon polygon;
        polygon.poly.contour.points = {{scaled(box.at("min_x").get<double>()), scaled(box.at("min_y").get<double>())},
            {scaled(box.at("max_x").get<double>()), scaled(box.at("min_y").get<double>())},
            {scaled(box.at("max_x").get<double>()), scaled(box.at("max_y").get<double>())},
            {scaled(box.at("min_x").get<double>()), scaled(box.at("max_y").get<double>())}};
        polygon.is_virt_object = polygon.is_wipe_tower = true;
        polygon.name = "Prime tower";
        scene.plates.at(indices.at(tower.at("plate_id").get<std::string>())).tower = std::move(polygon);
    }
    Operation op;
    op.prepared = A::prepare(scene, settings);
    const auto runtime = HistoryRuntime::runtime();
    op.context = request.contains("context") ? HistoryRuntime::canonical_history_context(runtime, request.at("context")) :
        HistoryRuntime::default_history_context(runtime);
    op.predecessor = predecessor();
    op.revision = s.history_revision;
    op.inject_failure = request.value("inject_failure_stage", "") == "before-publish";
    return op;
}

json apply_result(const Operation& operation, const A::Result& result) {
    auto& s = state();
    if (result.canceled) return {{"ok", true}, {"cancelled", true}, {"changed", false}};
    if (s.history_revision != operation.revision || predecessor() != operation.predecessor)
        throw std::runtime_error("Arrangement input changed before result application");
    if (s.history_revision == std::numeric_limits<std::uint64_t>::max()) throw std::overflow_error("History revision exhausted");
    std::map<std::size_t, PlateInstanceRef> refs;
    std::map<std::size_t, Geometry::Transformation> transforms;
    for (const auto& ref : plate_instance_refs()) { refs.emplace(ref.instance_id, ref); transforms.emplace(ref.instance_id, ref.instance->get_transformation()); }
    std::set<std::size_t> expected;
    for (const auto& item : operation.prepared.instances) expected.insert(item.instance_id);
    for (const auto& item : operation.prepared.parked) expected.insert(item.instance_id);
    auto next_plates = s.plate_session_plates;
    auto next_members = s.instance_plate_ids;
    auto next_parked = s.parked_instance_ids;
    auto next_transforms = transforms;
    std::size_t count = next_plates.size();
    for (const auto& item : result.placements) {
        if (expected.erase(item.instance_id) != 1 || !refs.count(item.instance_id) ||
            !item.position.allFinite() || !std::isfinite(item.rotation)) throw std::runtime_error("Invalid arrangement instance result");
        if (item.plate) {
            if (std::find(operation.prepared.destination_plates.begin(), operation.prepared.destination_plates.end(), *item.plate) == operation.prepared.destination_plates.end())
                throw std::runtime_error("Arrangement result uses a prohibited plate");
            count = std::max(count, *item.plate + 1);
        }
    }
    if (!expected.empty() || count > 36) throw std::runtime_error("Incomplete arrangement result");
    const auto bounds = selected_plate_bounds();
    while (next_plates.size() < count) {
        const auto index = next_plates.size();
        const auto id = "plate-session-plate-" + std::to_string(next_plate_id_sequence());
        next_plates.push_back({id, "Plate " + std::to_string(index + 1), int(index)});
    }
    std::set<std::string> affected;
    for (std::size_t i = 0; i < next_plates.size(); ++i) {
        const auto origin = plate_origin_for_index(int(i), int(count), bounds);
        const Vec3d delta = origin - next_plates[i].origin;
        if (i < s.plate_session_plates.size() && delta != Vec3d::Zero()) {
            affected.insert(next_plates[i].id);
            for (const auto& [id, member] : next_members) if (member == next_plates[i].id)
                next_transforms.at(id).set_offset(next_transforms.at(id).get_offset() + delta);
        }
        next_plates[i].origin = origin;
        next_plates[i].display_index = int(i);
    }
    const Vec3d parking = parked_origin_for_count(int(count), bounds);
    double parking_x = parking.x();
    json diagnostics = json::array();
    std::size_t placed = 0;
    for (const auto& item : result.placements) {
        auto& transform = next_transforms.at(item.instance_id);
        if (item.plate) {
            Vec3d offset = transform.get_offset();
            offset.head<2>() = item.position + next_plates[*item.plate].origin.head<2>();
            transform.set_offset(offset);
            auto rotation = transform.get_rotation(); rotation.z() = item.rotation; transform.set_rotation(rotation);
            next_members[item.instance_id] = next_plates[*item.plate].id;
            next_parked.erase(item.instance_id);
            ++placed;
        } else {
            const auto box = instance_hull_box(refs.at(item.instance_id));
            Vec3d offset = transforms.at(item.instance_id).get_offset();
            const bool valid_box = box.defined && box.min.allFinite() && box.max.allFinite();
            offset.x() = valid_box ? offset.x() + parking_x - box.min.x() : parking_x;
            offset.y() = valid_box ? offset.y() + parking.y() - box.min.y() : parking.y();
            if (!offset.allFinite()) throw std::runtime_error("Invalid outside-plate parking position");
            transform.set_offset(offset);
            parking_x += (valid_box ? std::max(10., box.size().x()) : 10.) + 10.;
            next_members.erase(item.instance_id); next_parked.insert(item.instance_id);
            diagnostics.push_back({{"instance_id", item.instance_id}, {"reason", parking_name(item.parking)}});
        }
    }
    std::set<std::size_t> changed_ids;
    for (const auto& [id, transform] : next_transforms) {
        const auto old_member = s.instance_plate_ids.find(id), new_member = next_members.find(id);
        const bool membership_changed = (old_member == s.instance_plate_ids.end()) != (new_member == next_members.end()) ||
            (old_member != s.instance_plate_ids.end() && new_member != next_members.end() && old_member->second != new_member->second);
        if (!transform.get_matrix().matrix().isApprox(transforms.at(id).get_matrix().matrix(), 1e-12) || membership_changed || s.parked_instance_ids.count(id) != next_parked.count(id)) {
            changed_ids.insert(id);
            if (old_member != s.instance_plate_ids.end()) affected.insert(old_member->second);
            if (new_member != next_members.end()) affected.insert(new_member->second);
        }
    }
    json response{{"ok", true}, {"cancelled", false}, {"changed", !changed_ids.empty() || count != s.plate_session_plates.size()},
                  {"placed", placed}, {"unplaced", diagnostics}, {"plate_limit_reached", result.plate_limit_reached}};
    if (!response["changed"].get<bool>()) return response;
    auto old_plates = s.plate_session_plates;
    auto old_members = s.instance_plate_ids;
    auto old_parked = s.parked_instance_ids;
    auto old_outside = s.plate_out_of_bounds_ids;
    auto old_revisions = s.plate_input_revisions;
    auto old_config = s.presets.project_config;
    auto old_context = s.history_live_context;
    auto old_pending = s.pending_membership_instance_ids;
    if (!HistoryMetadata::begin_timestamped_operation(s, operation.prepared.scope == A::Scope::All ? "Arrange all" : "Arrange current plate", operation.context))
        throw std::runtime_error("Unable to begin arrangement history");
    try {
        s.plate_session_plates = std::move(next_plates);
        s.instance_plate_ids = std::move(next_members);
        s.parked_instance_ids = std::move(next_parked);
        for (const auto id : changed_ids) {
            refs.at(id).instance->set_transformation(next_transforms.at(id));
            refs.at(id).object->config.touch();
            refs.at(id).object->invalidate_bounding_box();
        }
        normalize_coordinate_arrays(s.presets.project_config, count);
        refresh_existing_plate_validity(bounds);
        reconcile_plate_runtime_registry();
        for (const auto& plate : s.plate_session_plates) s.plate_input_revisions.try_emplace(plate.id, 0);
        json transform_records = json::array();
        for (const auto id : changed_ids) transform_records.push_back(instance_transform_record(refs.at(id)));
        response["plate_session"] = plate_mutation_snapshot(affected, {"arrange"}, transform_records, &changed_ids, false);
        response["plate_session"]["native_scoped_config"]["revision"] = s.history_revision + 1;
        if (operation.inject_failure) throw std::runtime_error("Injected arrangement apply failure");
        if (!HistoryMetadata::commit_timestamped_operation(s, operation.context)) throw std::runtime_error("Unable to commit arrangement history");
    } catch (...) {
        HistoryMetadata::abort_timestamped_operation(s);
        s.plate_session_plates = std::move(old_plates); s.instance_plate_ids = std::move(old_members);
        s.parked_instance_ids = std::move(old_parked); s.plate_out_of_bounds_ids = std::move(old_outside);
        s.plate_input_revisions = std::move(old_revisions); s.presets.project_config = std::move(old_config);
        s.history_live_context = std::move(old_context);
        s.pending_membership_instance_ids = std::move(old_pending);
        for (const auto id : changed_ids) { refs.at(id).instance->set_transformation(transforms.at(id)); refs.at(id).object->config.touch(); refs.at(id).object->invalidate_bounding_box(); }
        reconcile_plate_runtime_registry(); PrimeTower::invalidate_projection_cache();
        throw;
    }
    // Only successful publication cancels slicing, and only on affected plates.
    s.plate_runtime_registry.invalidate_presentations(affected);
    return response;
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_arrange(const char* request) {
    try {
        auto operation = prepare_operation(json::parse(request ? request : "{}"));
        const auto result = A::solve(operation.prepared);
        return encode(apply_result(operation, result));
    } catch (const std::exception& e) { return encode(json{{"ok", false}, {"error", e.what()}}); }
    catch (...) { return encode(json{{"ok", false}, {"error", "Arrangement failed"}}); }
}
}
