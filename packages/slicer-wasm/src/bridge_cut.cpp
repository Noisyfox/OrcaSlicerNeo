#include "bridge_model_operations.hpp"
#include "bridge_plate.hpp"
#include "bridge_prime_tower.hpp"
#include "bridge_profiles.hpp"
#include "cut/PlanarCut.hpp"
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

PlanarCutOptions read_options(const json& request)
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
    options.upper = side_action(request.at("upper").get<std::string>());
    options.lower = side_action(request.at("lower").get<std::string>());
    options.as_parts = request.at("asParts").get<bool>();
    options.keep_paint = request.at("keepPainting").get<bool>();
    return options;
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
        Model staged = stage_planar_cut(*source, ObjectID(integer(request.at("instanceId"))), options);
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
