// Object-local Mesh Boolean preparation and atomic Part publication.
// Geometry and painting stay in the pinned Orca implementations.
#include "bridge_model_operations.hpp"
#include "bridge_plate.hpp"
#include "bridge_prime_tower.hpp"
#include "libslic3r/CSGMesh/ModelToCSGMesh.hpp"
#include "libslic3r/CSGMesh/PerformCSGMeshBooleans.hpp"
#include "libslic3r/MeshBoolean.hpp"
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <emscripten/emscripten.h>
#include <limits>
#include <memory>
#include <set>
#include <stdexcept>

using namespace Slic3r;
using namespace Slic3r::Neo::Bridge;
using namespace Slic3r::Neo::Bridge::ModelOperations;
using namespace Slic3r::Neo::Bridge::PlateSession;
using nlohmann::json;

namespace {
char *response(const json &value) {
    const std::string text = value.dump();
    auto *bytes = static_cast<char *>(std::malloc(text.size() + 1));
    if (!bytes)
        throw std::bad_alloc();
    std::memcpy(bytes, text.c_str(), text.size() + 1);
    return bytes;
}

std::size_t id(const json &request, const char *key) {
    const auto &field = request.at(key);
    if (!field.is_number())
        throw std::invalid_argument(std::string("Invalid ") + key);
    const double value = field.get<double>();
    if (!std::isfinite(value) || value < 1 || std::floor(value) != value ||
        value > 9007199254740991.0 || value > double(std::numeric_limits<std::size_t>::max()))
        throw std::invalid_argument(std::string("Invalid ") + key);
    return static_cast<std::size_t>(value);
}

bool flag(const json &request, const char *key) {
    const auto &value = request.at(key);
    if (!value.is_boolean())
        throw std::invalid_argument(std::string("Invalid ") + key);
    return value.get<bool>();
}

void validate_counts(const ModelVolume &volume) {
    // These are the existing signed mesh-index and MCUT uint32 API bounds,
    // not a feature-specific model-size policy. Never truncate a count.
    if (volume.mesh().its.vertices.size() > std::size_t(std::numeric_limits<std::int32_t>::max()) ||
        volume.mesh().its.indices.size() > std::size_t(std::numeric_limits<std::uint32_t>::max()))
        throw std::invalid_argument("Mesh exceeds the native index representation");
}

void remap_painting(const ModelVolume &source, ModelVolume &result) {
    auto saved = source.save_painting();
    if (!saved)
        return;
    const Transform3d transform = source.get_matrix();
    if (transform.linear().determinant() < 0) {
        // Fixing reflected mesh winding swaps face corners. A subdivision
        // bitstream still refers to the original corners, so carrying it onto
        // that swapped root moves partial paint to the wrong half of a face.
        // Extract native painted leaves first; each is then a uniform face
        // whose state is invariant under the winding correction. Keep native
        // cursor projection/remapping for every channel and existing paint.
        auto channel = [&](const TriangleSelector::TriangleSplittingData &data,
                           FacetsAnnotation &target) {
            if (data.bitstream.empty())
                return;
            TriangleSelector selector(saved->mesh);
            selector.deserialize(data, false);
            for (const auto state : TriangleSelector::extract_used_facet_states(data)) {
                if (state == EnforcerBlockerType::NONE)
                    continue;
                auto leaves = selector.get_facets(state);
                if (leaves.indices.empty())
                    continue;
                TriangleMesh reference(std::move(leaves));
                reference.transform(transform, true);
                TriangleSelector flat(reference);
                for (std::size_t i = 0; i < reference.its.indices.size(); ++i)
                    flat.set_facet(static_cast<int>(i), state);
                const auto existing = std::optional<std::reference_wrapper<const TriangleSelector::TriangleSplittingData>>{
                    std::cref(target.get_data())};
                auto mapped = TriangleSelector::remap_painting(reference.its, flat.serialize(), result.mesh().its,
                    Geometry::translation_transform(result.mesh().get_init_shift()), existing);
                if (!mapped.bitstream.empty())
                    target.set_data(std::move(mapped));
            }
        };
        channel(saved->supported, result.supported_facets);
        channel(saved->seam, result.seam_facets);
        channel(saved->mmu, result.mmu_segmentation_facets);
        channel(saved->fuzzy, result.fuzzy_skin_facets);
        return;
    }
    saved->mesh.transform(transform, true);
    result.restore_painting(saved, true);
}

// Own the replacement volume in a temporary Model until its complete geometry,
// configuration and all four painting channels have been prepared. No source
// volume or instance is modified during that work.
char *publish(ModelObject &object, ModelObject &holder, ModelVolume &result,
              const std::set<std::size_t> &consumed, std::size_t replacement_id,
              const json &warning, bool inject_failure) {
    auto &live = state();
    std::set<std::size_t> instances;
    for (const auto *instance : object.instances)
        instances.insert(instance->id().id);
    const auto affected_before = member_plate_ids_for_instances(instances);
    ModelVolumePtrs next, removed;
    next.reserve(object.volumes.size());
    removed.reserve(consumed.size());
    bool inserted = false;
    for (auto *volume : object.volumes) {
        if (consumed.count(volume->id().id)) {
            removed.push_back(volume);
            if (volume->id().id == replacement_id) {
                next.push_back(&result);
                inserted = true;
            }
        } else
            next.push_back(volume);
    }
    if (!inserted)
        throw std::runtime_error("Mesh Boolean target disappeared");

    // The only compensation state is the touched object's pointer collection
    // and small plate metadata. Immutable meshes are never copied for rollback.
    auto old_config = static_cast<const ModelConfig &>(object.config);
    auto old_members = live.instance_plate_ids;
    auto old_outside = live.plate_out_of_bounds_ids;
    auto old_revisions = live.plate_input_revisions;
    auto old_pending = live.pending_membership_instance_ids;
    const auto lifecycle = live.plate_runtime_registry.capture_lifecycle();
    const auto old_size = object.volumes.size();
    object.volumes.reserve(old_size + 1);
    holder.volumes.reserve(1 + std::max<std::size_t>(removed.size(), 1));
    bool swapped = false;
    ModelVolume *added = nullptr;
    try {
        // This public native API shares the prepared immutable mesh and keeps
        // its fresh IDs/painting while assigning the correct live parent.
        added = object.add_volume(result);
        std::replace(next.begin(), next.end(), &result, added);
        object.volumes.swap(next);
        swapped = true;
        object.config.touch();
        object.invalidate_bounding_box();
        rebuild_plate_membership(false, &instances);
        const auto receipt = plate_mutation_snapshot(affected_before, {"model-structure"},
                                                     json::array(), &instances, false);
#ifdef NEO_MESH_BOOLEAN_COMMAND_TEST
        if (inject_failure)
            throw std::runtime_error("Injected Mesh Boolean publication failure");
#endif
        std::set<std::string> affected = affected_before;
        const auto after = member_plate_ids_for_instances(instances);
        affected.insert(after.begin(), after.end());
        std::unique_ptr<char, decltype(&std::free)> serialized(
            response(attach_plate_mutation(json{{"ok", true},
                                                {"changed", true},
                                                {"objectId", object.id().id},
                                                {"volumeId", added->id().id},
                                                {"objects", model_structure_json()},
                                                {"warning", warning}},
                                           receipt)),
            &std::free);
        live.plate_runtime_registry.invalidate_presentations(affected);
        // Avoid ModelObject::delete_volume: its last-Part normalization changes
        // instance transforms and IDs. Transfer only consumed Parts to the
        // temporary owner; its destructor deletes them without normalization.
        // Cleanup ownership only: clear_volumes/destructors do not consult
        // parent transforms. Retained Parts never leave the live collection.
        holder.volumes.insert(holder.volumes.end(), removed.begin(), removed.end());
        return serialized.release();
    } catch (...) {
        if (swapped)
            object.volumes.swap(next);
        if (added) {
            object.volumes.pop_back();
            holder.volumes.push_back(added);
        }
        object.config.assign_config(std::move(old_config));
        object.invalidate_bounding_box();
        live.instance_plate_ids = std::move(old_members);
        live.plate_out_of_bounds_ids = std::move(old_outside);
        live.plate_input_revisions = std::move(old_revisions);
        live.pending_membership_instance_ids = std::move(old_pending);
        live.plate_runtime_registry.restore_lifecycle(lifecycle);
        live.mutable_object_capture_cache.clear();
        PrimeTower::invalidate_projection_cache();
        throw;
    }
}

char *perform(const json &request) {
    if (!request.is_object())
        throw std::invalid_argument("Invalid Mesh Boolean request");
    auto *object = find_object_by_id(id(request, "objectId"));
    if (!object)
        throw std::invalid_argument("Mesh Boolean object not found");
    const bool keep_painting = flag(request, "keepPainting");
    const std::string entry = request.at("entry").get<std::string>();
    Model prepared;
    ModelObject *holder = prepared.add_object();
    TriangleMesh geometry;
    std::set<std::size_t> consumed;
    ModelVolume *source = nullptr;
    ModelVolume *tool = nullptr;
    std::string operation;
    json warning = nullptr;

    if (entry == "gizmo") {
        const auto instance_id = id(request, "instanceId");
        if (object->volumes.size() < 2 ||
            std::none_of(
                object->instances.begin(), object->instances.end(),
                [instance_id](const auto *instance) { return instance->id().id == instance_id; }))
            throw std::invalid_argument("Mesh Boolean requires a complete multipart instance");
        source = find_volume_by_id(id(request, "sourceVolumeId"));
        tool = find_volume_by_id(id(request, "toolVolumeId"));
        if (!source || !tool || source == tool || source->get_object() != object ||
            tool->get_object() != object)
            throw std::invalid_argument(
                "Mesh Boolean operands must be distinct Parts of the target object");
        const bool delete_input = flag(request, "deleteInput");
        operation = request.at("operation").get<std::string>();
        const std::string native_operation = operation == "union"          ? "UNION"
                                             : operation == "difference"   ? "A_NOT_B"
                                             : operation == "intersection" ? "INTERSECTION"
                                                                           : "";
        if (native_operation.empty())
            throw std::invalid_argument("Unknown Mesh Boolean operation");
        if (state().measurement.protects_volume(source->id().id) ||
            ((operation == "union" || delete_input) && state().measurement.protects_volume(tool->id().id)))
            throw std::invalid_argument("Close Measure before changing its target");
        validate_counts(*source);
        validate_counts(*tool);
        TriangleMesh a = source->mesh(), b = tool->mesh();
        a.transform(source->get_matrix(), true);
        b.transform(tool->get_matrix(), true);
        std::vector<TriangleMesh> results;
        MeshBoolean::mcut::make_boolean(a, b, results, native_operation);
        if (!results.empty())
            geometry = std::move(results.front());
        consumed.insert(source->id().id);
        if (operation == "union" || delete_input)
            consumed.insert(tool->id().id);
    } else if (entry == "object") {
        if (object->volumes.size() < 2 &&
            (object->volumes.empty() || !object->volumes.front()->is_splittable()))
            throw std::invalid_argument("Object is not multipart or splittable");
        if (state().measurement.protects_object(object->id().id))
            throw std::invalid_argument("Close Measure before changing its target");
        std::vector<csg::CSGPart> parts;
        for (const auto *volume : object->volumes) {
            consumed.insert(volume->id().id);
            if (volume->is_model_part() || volume->is_negative_volume())
                validate_counts(*volume);
        }
        csg::model_to_csgmesh(*object, Transform3d::Identity(), std::back_inserter(parts),
                              csg::mpartsPositive | csg::mpartsNegative);
        // Match Plater::combine_mesh_fff's MCUT and positive-Part fallback,
        // omitting only its deferred CGAL prechecks and instance baking.
        try {
            auto combined = csg::perform_csgmesh_booleans_mcut(Range{parts.begin(), parts.end()});
            if (combined)
                geometry = MeshBoolean::mcut::mcut_to_triangle_mesh(*combined);
        } catch (...) {
        }
#ifdef NEO_MESH_BOOLEAN_COMMAND_TEST
        if (request.value("testEmptyCombined", false))
            geometry = TriangleMesh();
#endif
        if (geometry.empty()) {
            warning = "positive_parts_only";
            for (const auto *volume : object->volumes)
                if (volume->is_model_part()) {
                    TriangleMesh part = volume->mesh();
                    part.transform(volume->get_matrix(), true);
                    geometry.merge(part);
                }
        }
    } else
        throw std::invalid_argument("Unknown Mesh Boolean entry point");

    if (geometry.empty())
        return response({{"ok", true}, {"changed", false}, {"warning", "empty_result"}});
    auto *result = holder->add_volume(std::move(geometry),
                                      source ? source->type() : ModelVolumeType::MODEL_PART, false);
    if (source) {
        result->name = source->name + " - " + operation;
        result->config.apply(source->config);
        result->set_material_id(source->material_id());
        if (keep_painting) {
            remap_painting(*source, *result);
            if (operation != "difference")
                remap_painting(*tool, *result);
        }
    } else {
        result->name = object->name;
        if (keep_painting)
            for (const auto *volume : object->volumes)
                if (volume->is_model_part())
                    remap_painting(*volume, *result);
    }
    bool inject_failure = false;
#ifdef NEO_MESH_BOOLEAN_COMMAND_TEST
    inject_failure = request.value("testFailPublish", false);
#endif
    return publish(*object, *holder, *result, consumed,
                   source ? source->id().id : object->volumes.front()->id().id, warning,
                   inject_failure);
}
} // namespace

extern "C" EMSCRIPTEN_KEEPALIVE const char *orc_mesh_boolean(const char *request) {
    try {
        return perform(json::parse(request ? request : ""));
    } catch (const std::exception &error) {
        try {
            return response({{"ok", false}, {"error", error.what()}});
        } catch (...) {
            return nullptr;
        }
    } catch (...) {
        try {
            return response({{"ok", false}, {"error", "Unknown Mesh Boolean failure"}});
        } catch (...) {
            return nullptr;
        }
    }
}
