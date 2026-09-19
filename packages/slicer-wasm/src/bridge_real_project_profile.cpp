// Dedicated real-project performance attribution.
//
// CMake adds this translation unit only when NEO_REAL_PROJECT_PROFILE=ON.
// The normal production module therefore has no profiling symbol, string,
// data structure, or runtime guard.
#include "bridge_state.hpp"
#include "bridge_profiles.hpp"

#include "libslic3r/Layer.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <map>
#include <set>
#include <string>
#include <vector>

#include <emscripten/emscripten.h>
#include <emscripten/heap.h>

namespace Slic3r::Neo::Bridge::RealProjectProfile {
namespace {

constexpr const char* kBuildIdentity = "ORCA_REAL_PROJECT_PROFILE_V1";

void add_bytes(std::size_t& target, const std::size_t amount)
{
    const std::size_t maximum = std::numeric_limits<std::size_t>::max();
    target = amount > maximum - target ? maximum : target + amount;
}

template<class T> void add_capacity(std::size_t& target, const std::vector<T>& values)
{
    const std::size_t maximum = std::numeric_limits<std::size_t>::max();
    add_bytes(target, values.capacity() > maximum / sizeof(T)
        ? maximum : values.capacity() * sizeof(T));
}

struct SharedMeshAccounting {
    std::size_t references = 0;
    std::size_t unique_meshes = 0;
    std::size_t vertex_bytes = 0;
    std::size_t index_bytes = 0;
};

SharedMeshAccounting account_meshes(const Model& model)
{
    SharedMeshAccounting result;
    std::set<std::shared_ptr<const TriangleMesh>,
             std::owner_less<std::shared_ptr<const TriangleMesh>>> unique;
    for (const ModelObject* object : model.objects) {
        for (const ModelVolume* volume : object->volumes) {
            ++result.references;
            const auto mesh = volume->mesh_ptr();
            if (!mesh || !unique.insert(mesh).second) continue;
            ++result.unique_meshes;
            const auto maximum = std::numeric_limits<std::size_t>::max();
            add_bytes(result.vertex_bytes, mesh->its.vertices.capacity() > maximum / sizeof(stl_vertex)
                ? maximum : mesh->its.vertices.capacity() * sizeof(stl_vertex));
            add_bytes(result.index_bytes, mesh->its.indices.capacity() > maximum / sizeof(stl_triangle_vertex_indices)
                ? maximum : mesh->its.indices.capacity() * sizeof(stl_triangle_vertex_indices));
        }
    }
    return result;
}

std::size_t structural_model_copy_bytes(const Model& model)
{
    std::size_t result = sizeof(Model);
    add_bytes(result, model.objects.capacity() * sizeof(ModelObject*));
    for (const ModelObject* object : model.objects) {
        add_bytes(result, sizeof(ModelObject));
        add_bytes(result, object->volumes.capacity() * sizeof(ModelVolume*));
        add_bytes(result, object->instances.capacity() * sizeof(ModelInstance*));
        for (const ModelVolume* volume : object->volumes) add_bytes(result, sizeof(*volume));
        for (const ModelInstance* instance : object->instances) add_bytes(result, sizeof(*instance));
    }
    return result;
}

nlohmann::json plate_profile(const PlateRuntimeRegistry::ProfileEntry& entry)
{
    const Print& print = *entry.print;
    const GCodeProcessorResult& result = *entry.gcode_result;
    std::size_t print_object_count = 0;
    std::size_t print_instance_count = 0;
    std::size_t layer_count = 0;
    std::size_t support_layer_count = 0;
    std::size_t derived_bytes = sizeof(Print) + sizeof(GCodeProcessorResult);
    for (const PrintObject* object : print.objects()) {
        ++print_object_count;
        print_instance_count += object->instances().size();
        layer_count += object->layers().size();
        support_layer_count += object->support_layers().size();
        add_bytes(derived_bytes, sizeof(PrintObject));
        add_bytes(derived_bytes, object->layers().size() * sizeof(Layer));
        add_bytes(derived_bytes, object->support_layers().size() * sizeof(SupportLayer));
    }
    add_capacity(derived_bytes, result.moves);
    add_capacity(derived_bytes, result.lines_ends);
    add_capacity(derived_bytes, result.printable_area);
    add_capacity(derived_bytes, result.bed_exclude_area);
    add_capacity(derived_bytes, result.wrapping_exclude_area);

    const SharedMeshAccounting meshes = account_meshes(print.model());
    return {
        {"plate_id", entry.plate_id},
        {"native_core_materialized", entry.native_core_materialized},
        {"core_cache_object_count", 2},
        {"print_object_count", print_object_count},
        {"print_instance_count", print_instance_count},
        {"layer_count", layer_count},
        {"support_layer_count", support_layer_count},
        {"gcode_move_count", result.moves.size()},
        {"gcode_line_end_count", result.lines_ends.size()},
        {"structural_model_copy_estimated_bytes", structural_model_copy_bytes(print.model())},
        {"derived_cache_estimated_bytes", derived_bytes},
        {"shared_mesh_reference_count", meshes.references},
        // Shared mesh storage is charged once at the authoritative-model level
        // below. This scalar makes the non-duplication explicit per plate.
        {"shared_mesh_bytes_attributed_to_plate", 0},
    };
}

} // namespace

nlohmann::json snapshot()
{
    auto entries = state().plate_runtime_registry.profile_entries();
    std::sort(entries.begin(), entries.end(), [](const auto& lhs, const auto& rhs) {
        return lhs.plate_id < rhs.plate_id;
    });
    nlohmann::json plates = nlohmann::json::array();
    for (const auto& entry : entries) plates.push_back(plate_profile(entry));

    const SharedMeshAccounting shared = account_meshes(state().model);
    const auto object_cache_misses = state().mutable_object_capture_cache.profile_miss_counts();
    const auto object_fingerprint_misses =
        state().mutable_object_capture_cache.profile_fingerprint_miss_counts();
    std::size_t shared_total_bytes = shared.vertex_bytes;
    add_bytes(shared_total_bytes, shared.index_bytes);
    return {
        {"version", 1},
        {"profile_build", true},
        {"build_identity", kBuildIdentity},
#ifdef ORCA_WASM_THREADING
        {"threaded", true},
#else
        {"threaded", false},
#endif
        {"wasm_heap_bytes", emscripten_get_heap_size()},
        {"registry_entry_count", entries.size()},
        {"retired_registry_entry_count", state().plate_runtime_registry.retired_size()},
        {"prime_tower_projection_cache_entries", state().prime_tower_projection_cache.size()},
        {"history", {
            {"entry_count", state().history.entries().size()},
            {"retained_estimated_bytes", state().history.bytes_used()},
            {"serialized_mesh_count", state().mesh_capture_cache.serialized_mesh_count()},
            {"serialized_object_count", state().mutable_object_capture_cache.serialized_object_count()},
            {"reused_object_count", state().mutable_object_capture_cache.reused_object_count()},
            {"object_cache_misses", {
                {"missing", object_cache_misses[0]}, {"timestamp", object_cache_misses[1]},
                {"ids", object_cache_misses[2]}, {"fingerprint", object_cache_misses[3]},
                {"mesh_size", object_cache_misses[4]}, {"mesh_owner", object_cache_misses[5]},
            }},
            {"object_fingerprint_misses", {
                {"object", object_fingerprint_misses[0]},
                {"volume_transform", object_fingerprint_misses[1]},
                {"volume_metadata", object_fingerprint_misses[2]},
                {"instance_transform", object_fingerprint_misses[3]},
                {"instance_metadata", object_fingerprint_misses[4]},
            }},
        }},
        {"shared_source_mesh", {
            {"reference_count", shared.references},
            {"unique_mesh_count", shared.unique_meshes},
            {"vertex_bytes", shared.vertex_bytes},
            {"index_bytes", shared.index_bytes},
            {"total_bytes", shared_total_bytes},
        }},
        {"plates", std::move(plates)},
    };
}

} // namespace Slic3r::Neo::Bridge::RealProjectProfile

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_take_real_project_profile_snapshot()
{
    try {
        return Slic3r::Neo::Bridge::Profiles::duplicate_json(
            Slic3r::Neo::Bridge::RealProjectProfile::snapshot().dump());
    } catch (const std::exception& error) {
        return Slic3r::Neo::Bridge::Profiles::duplicate_json(nlohmann::json{
            {"version", 1}, {"profile_build", true}, {"error", error.what()}}.dump());
    }
}

}
