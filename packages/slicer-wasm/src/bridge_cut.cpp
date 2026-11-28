#include "bridge_model_operations.hpp"
#include "bridge_plate.hpp"
#include "bridge_prime_tower.hpp"
#include "bridge_profiles.hpp"
#include "cut/PlanarCut.hpp"
#include "cut/CutSection.hpp"
#include "cut/CutPieces.hpp"
#include "cut/CutConnectors.hpp"
#include "bridge_buffers.hpp"
#include <algorithm>
#include <emscripten/emscripten.h>
#include <stdexcept>

using namespace Slic3r;
using namespace Slic3r::Neo::Bridge;
using namespace Slic3r::Neo::Bridge::ModelOperations;
using namespace Slic3r::Neo::Bridge::PlateSession;
using namespace Slic3r::Neo::Cutting;
using nlohmann::json;

namespace {
SideAction side_action(const std::string& value)
{
    if (value == "discard") return SideAction::Discard;
    if (value == "keep") return SideAction::Keep;
    if (value == "place") return SideAction::PlaceOnCut;
    if (value == "flip") return SideAction::Flip;
    throw std::invalid_argument("Invalid Cut side orientation");
}

size_t integer(const json& value)
{
    if (!value.is_number_unsigned() || value.get<uint64_t>() > 9007199254740991ULL)
        throw std::invalid_argument("Invalid Cut identifier or revision");
    return value.get<size_t>();
}

PlanarCutOptions read_pose(const json& request)
{
    const auto& center = request.at("center");
    const auto& rotation = request.at("rotation");
    if (!center.is_array() || center.size() != 3 || !rotation.is_array() || rotation.size() != 9)
        throw std::invalid_argument("Invalid Cut plane dimensions");
    PlanarCutOptions options;
    for (int i = 0; i < 3; ++i)
        options.center[i] = center[i].get<double>();
    for (int i = 0; i < 9; ++i)
        options.rotation(i % 3, i / 3) = rotation[i].get<double>();
    if (!options.center.allFinite() || !options.rotation.allFinite() ||
        !options.rotation.isUnitary(1e-8) || options.rotation.determinant() < 0.)
        throw std::invalid_argument("Invalid Cut plane");
    return options;
}
CutConnectors read_connectors(const json& request)
{
    CutConnectors result;
    if (!request.contains("connectors")) return result;
    const auto& list = request.at("connectors");
    if (!list.is_array()) throw std::invalid_argument("Invalid Cut connector list");
    for (const auto& row : list) {
        const auto type = row.at("type").get<std::string>(), style = row.at("style").get<std::string>();
        const auto shape = row.at("shape").get<std::string>();
        CutConnector c;
        c.attribs.type = type == "plug" ? CutConnectorType::Plug : type == "dowel" ? CutConnectorType::Dowel :
            type == "snap" ? CutConnectorType::Snap : CutConnectorType::Undef;
        c.attribs.style = style == "prism" ? CutConnectorStyle::Prism : style == "frustum" ? CutConnectorStyle::Frustum : CutConnectorStyle::Undef;
        c.attribs.shape = shape == "circle" ? CutConnectorShape::Circle : shape == "square" ? CutConnectorShape::Square :
            shape == "hexagon" ? CutConnectorShape::Hexagon : shape == "triangle" ? CutConnectorShape::Triangle : CutConnectorShape::Undef;
        if (c.attribs.type == CutConnectorType::Undef || c.attribs.shape == CutConnectorShape::Undef || c.attribs.style == CutConnectorStyle::Undef ||
            (type == "snap" && (shape != "circle" || style != "prism"))) throw std::invalid_argument("Invalid Cut connector shape");
        const auto& pos = row.at("position");
        if (!pos.is_array() || pos.size() != 3) throw std::invalid_argument("Invalid Cut connector position");
        c.pos = Vec3d(pos[0].get<double>(), pos[1].get<double>(), pos[2].get<double>());
        c.radius = row.at("diameter").get<float>() * 0.5f;
        c.height = row.at("depth").get<float>();
        c.radius_tolerance = row.at("diameterTolerance").get<float>() * 0.5f;
        c.height_tolerance = row.at("depthTolerance").get<float>();
        c.z_angle = row.at("angle").get<float>() * float(PI/180.);
        if (!std::isfinite(c.z_angle)) throw std::invalid_argument("Invalid Cut connector angle");
        result.push_back(c);
    }
    return result;
}

PlanarCutOptions read_options(const json& request)
{
    auto options = read_pose(request);
    options.connectors = read_connectors(request);
    options.upper = side_action(request.at("upper").get<std::string>());
    options.lower = side_action(request.at("lower").get<std::string>());
    options.as_parts = request.at("asParts").get<bool>();
    options.keep_paint = request.at("keepPainting").get<bool>();
    if (request.contains("grouping")) {
        const auto& group = request.at("grouping");
        const auto pose = read_pose(group);
        auto& grouping = options.grouping.emplace();
        grouping.plane.linear() = pose.rotation;
        grouping.plane.translation() = pose.center;
        for (const auto& id : group.at("toggled")) grouping.toggled.push_back(integer(id));
    }
    return options;
}

struct PieceReview {
    size_t revision, object_id, instance_id;
    Transform3d plane;
    CutPieces pieces;
};
std::optional<PieceReview> review;

const CutPieces& reviewed_pieces(const ModelObject& source, size_t instance_id, const Transform3d& plane)
{
    if (!review || review->revision != state().history_revision || review->object_id != source.id().id ||
        review->instance_id != instance_id || !review->plane.matrix().isApprox(plane.matrix(), 1e-12)) {
        const auto found = std::find_if(source.instances.begin(), source.instances.end(),
            [instance_id](const auto* instance) { return instance->id().id == instance_id; });
        if (found == source.instances.end()) throw std::invalid_argument("Invalid Cut piece reference");
        auto prepared = prepare_cut_pieces(source, int(found-source.instances.begin()), plane);
        review.emplace(PieceReview{state().history_revision, source.id().id, instance_id, plane, std::move(prepared)});
    }
    return review->pieces;
}

const char* publish(ModelObject& source, Model& prepared)
{
    auto& live = state();
    auto& objects = live.model.objects;
    std::set<size_t> affected;
    for (const auto* instance : source.instances)
        affected.insert(instance->id().id);
    const auto before = member_plate_ids_for_instances(affected);
    const auto index = std::find(objects.begin(), objects.end(), &source) - objects.begin();
    const auto original_size = objects.size();
    auto original = objects;
    auto membership = live.instance_plate_ids;
    auto parked = live.parked_instance_ids;
    auto outside = live.plate_out_of_bounds_ids;
    auto revisions = live.plate_input_revisions;
    auto pending = live.pending_membership_instance_ids;
    const auto lifecycle = live.plate_runtime_registry.capture_lifecycle();
    ModelObjectPtrs added;
    added.reserve(prepared.objects.size());
    objects.reserve(original_size + prepared.objects.size());
    Model retired;
    retired.objects.reserve(1 + prepared.objects.size());
    try {
        json ids = json::array();
        for (const auto* staged : prepared.objects) {
            auto* object = live.model.add_object(*staged);
            added.push_back(object);
            ids.push_back(object->id().id);
            for (size_t i = 0; i < source.instances.size(); ++i) {
                const auto id = object->instances.at(i)->id().id;
                affected.insert(id);
                if (parked.count(source.instances[i]->id().id))
                    live.parked_instance_ids.insert(id);
            }
        }
        objects.erase(objects.begin() + index);
        std::rotate(objects.begin() + index, objects.end() - added.size(), objects.end());
        for (const auto* instance : source.instances)
            live.parked_instance_ids.erase(instance->id().id);
        rebuild_plate_membership(false, &affected);
        const auto receipt = plate_mutation_snapshot(before, {"model-structure"}, json::array(), &affected, false);
        auto invalidated = member_plate_ids_for_instances(affected);
        invalidated.insert(before.begin(), before.end());
        const auto serialized = attach_plate_mutation({{"ok", true}, {"changed", true}, {"newObjectIds", ids},
                                                       {"objects", model_structure_json()}}, receipt).dump();
        live.plate_runtime_registry.invalidate_presentations(invalidated);
        const char* response = Profiles::duplicate_json(serialized);
        if (!response) throw std::bad_alloc();
        const auto& group = added.front()->cut_id;
        if (source.is_cut())
            for (auto* object : objects)
                if (object->cut_id == group) object->cut_id.copy(group);
        retired.objects.push_back(&source);
        return response;
    } catch (...) {
        objects.swap(original);
        retired.objects.swap(added);
        live.instance_plate_ids.swap(membership);
        live.parked_instance_ids.swap(parked);
        live.plate_out_of_bounds_ids.swap(outside);
        live.plate_input_revisions.swap(revisions);
        live.pending_membership_instance_ids.swap(pending);
        live.plate_runtime_registry.restore_lifecycle(lifecycle);
        live.mutable_object_capture_cache.clear();
        PrimeTower::invalidate_projection_cache();
        throw;
    }
}
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_apply_cut(const char* data)
{
    try {
        const auto request = json::parse(data ? data : "");
        const auto& tx = state().active_history_transaction;
        if (!tx || integer(request.at("revision")) != tx->base_history_revision ||
            state().history_revision != tx->base_history_revision)
            throw std::invalid_argument("Cut requires a transaction at the draft revision");
        auto* source = find_object_by_id(integer(request.at("objectId")));
        if (!source) throw std::invalid_argument("Cut source object no longer exists");
        const auto action = request.at("openEdges").get<std::string>();
        if (action != "ask" && action != "repair" && action != "apply")
            throw std::invalid_argument("Invalid Cut repair choice");
        const auto options = read_options(request);
        const auto instance_id = integer(request.at("instanceId"));
        const auto* pieces = options.grouping ? &reviewed_pieces(*source, instance_id, options.grouping->plane) : nullptr;
        Model staged = stage_planar_cut(*source, ObjectID(instance_id), options, pieces);
        for (auto* object : staged.objects) {
            for (auto* volume : object->volumes) {
                if (!its_num_open_edges(volume->mesh().its)) continue;
                if (action == "ask")
                    return Profiles::duplicate_json(json{{"ok", true}, {"changed", false}, {"warning", "open_edges"}}.dump());
                if (action == "repair") {
                    std::string error;
                    if (!volume->repair(options.keep_paint, nullptr, &error))
                        throw std::runtime_error("Cut mesh repair failed: " + error);
                    object->invalidate_bounding_box();
                }
            }
            if (action == "repair") object->ensure_on_bed();
        }
        return publish(*source, staged);
    } catch (const std::exception& error) {
        return Profiles::error_json(error.what());
    }
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_get_cut_section(const char* data)
{
    try {
        const auto request = json::parse(data ? data : "");
        if (state().active_history_transaction || integer(request.at("revision")) != state().history_revision)
            throw std::invalid_argument("Cut section target is stale");
        const auto* source = find_object_by_id(integer(request.at("objectId")));
        const auto* instance = find_instance_by_id(integer(request.at("instanceId")));
        if (!source || !instance || instance->get_object() != source)
            throw std::invalid_argument("Cut section instance no longer belongs to the object");
        const auto pose = read_pose(request);
        Transform3d plane = Transform3d::Identity();
        plane.linear() = pose.rotation;
        plane.translation() = pose.center;
        ExPolygons computed;
        const ExPolygons* contours;
        const CutPieces* grouped = nullptr;
        std::set<size_t> toggled;
        Transform3d to_display = Transform3d::Identity();
        if (request.contains("grouping")) {
            const auto& g = request.at("grouping");
            const auto base = read_pose(g);
            Transform3d original = Transform3d::Identity();
            original.linear() = base.rotation;
            original.translation() = base.center;
            grouped = &reviewed_pieces(*source, instance->id().id, original);
            contours = &grouped->sections;
            for (const auto& id : g.at("toggled")) toggled.insert(integer(id));
            to_display = plane.inverse() * original;
        } else {
            computed = cut_section(*source, *instance, plane);
            contours = &computed;
        }
        std::vector<float> xy;
        json loops = json::array();
        auto append_loop = [&](const Polygon& loop, bool hole) {
            loops.push_back({{"count", loop.size()}, {"hole", hole}});
            for (const auto& p : loop.points) {
                const Vec3d point = to_display * Vec3d(unscale<double>(p.x()), unscale<double>(p.y()), 0.);
                xy.push_back(float(point.x()));
                xy.push_back(float(point.y()));
            }
        };
        for (size_t i = 0; i < contours->size(); ++i) {
            if (grouped && !grouped->section_active(i, toggled)) continue;
            const auto& polygon = contours->at(i);
            append_loop(polygon.contour, false);
            for (const auto& hole : polygon.holes) append_loop(hole, true);
        }
        const auto connectors = read_connectors(request);
        const int index = int(std::find(source->instances.begin(), source->instances.end(), instance)-source->instances.begin());
        auto invalid = invalid_cut_connectors(*source, index, plane, connectors);
        if (grouped) {
            const Transform3d to_original = (plane * to_display).inverse();
            for (size_t i = 0; i < connectors.size(); ++i)
                if (!grouped->accepts_connector(to_original * connectors[i].pos, toggled) &&
                    std::find(invalid.begin(), invalid.end(), i) == invalid.end()) invalid.push_back(i);
        }
        MallocBuffer buffer;
        if (!xy.empty()) buffer.append(xy.data(), xy.size() * sizeof(float));
        const auto* result = Profiles::duplicate_json(json{{"ok", true}, {"loops", loops}, {"invalidConnectors", invalid},
            {"ptr", reinterpret_cast<uintptr_t>(buffer.data)}, {"floats", xy.size()}}.dump());
        if (result) buffer.release();
        return result;
    } catch (const std::exception& e) { return Profiles::error_json(e.what()); }
}


extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_get_cut_pieces(const char* data)
{
    try {
        const auto request = json::parse(data ? data : "");
        if (state().active_history_transaction || integer(request.at("revision")) != state().history_revision)
            throw std::invalid_argument("Cut piece target is stale");
        const auto* source = find_object_by_id(integer(request.at("objectId")));
        const auto* instance = find_instance_by_id(integer(request.at("instanceId")));
        if (!source || !instance || instance->get_object() != source)
            throw std::invalid_argument("Invalid Cut piece reference");
        const int index = int(std::find(source->instances.begin(), source->instances.end(), instance) - source->instances.begin());
        const auto pose = read_pose(request);
        Transform3d plane = Transform3d::Identity();
        plane.linear() = pose.rotation;
        plane.translation() = pose.center;
        const auto& pieces = reviewed_pieces(*source, instance->id().id, plane);
        const auto* object = pieces.model.objects.front();
        json descriptors = json::array();
        std::vector<float> positions;
        for (size_t i = 0; i < pieces.parts.size(); ++i) {
            if (pieces.parts[i].is_modifier) continue;
            const auto* volume = object->volumes[i];
            const Transform3d world = object->instances[index]->get_matrix() * volume->get_matrix();
            const auto& mesh = volume->mesh().its;
            descriptors.push_back({{"id", i}, {"upper", pieces.parts[i].selected}, {"triangles", mesh.indices.size()}});
            for (const auto& face : mesh.indices) for (const int vertex : face) {
                const Vec3f p = (world * mesh.vertices[vertex].cast<double>()).cast<float>();
                positions.insert(positions.end(), p.data(), p.data()+3);
            }
        }
        MallocBuffer buffer;
        if (!positions.empty()) buffer.append(positions.data(), positions.size()*sizeof(float));
        const auto* result = Profiles::duplicate_json(json{{"ok", true}, {"pieces", descriptors},
            {"ptr", reinterpret_cast<uintptr_t>(buffer.data)}, {"floats", positions.size()}}.dump());
        if (result) buffer.release();
        return result;
    } catch (const std::exception& error) { return Profiles::error_json(error.what()); }
}

extern "C" EMSCRIPTEN_KEEPALIVE void orc_release_cut_pieces() { review.reset(); }
