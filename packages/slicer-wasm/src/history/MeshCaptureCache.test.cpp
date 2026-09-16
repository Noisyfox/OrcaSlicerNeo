#include "../bridge_history.hpp"

#include <iostream>
#include <sstream>

#include <cereal/archives/binary.hpp>

#include "libslic3r/Model.hpp"
#include "libslic3r/TriangleMesh.hpp"
#include "MutableObjectCaptureCache.hpp"

#define CHECK(condition) do { \
    if (!(condition)) { \
        std::cerr << "Mesh capture test failed: " #condition << "\\n"; \
        return 1; \
    } \
} while (false)

using namespace Slic3r;
using Slic3r::Neo::History::RestoreState;
using Slic3r::Neo::History::Codec::MeshCaptureCache;
using Slic3r::Neo::History::Codec::MutableObjectCaptureCache;
using Slic3r::Neo::History::Codec::capture_model_state;
using Slic3r::Neo::History::Codec::model_state_equal;
using Slic3r::Neo::History::Codec::stage_model;

static Model model_with_cube(double side)
{
    Model model;
    ModelObject* object = model.add_object();
    object->add_instance();
    object->add_volume(TriangleMesh(its_make_cube(side, side, side)));
    return model;
}

static RestoreState restore_state(const Slic3r::Neo::History::ModelState& model)
{
    RestoreState restored;
    restored.model = model;
    return restored;
}

int main()
{
    Model original = model_with_cube(20.0);
    ModelObject* original_object = original.objects.front();
    ModelVolume* original_volume = original_object->volumes.front();
    original_volume->supported_facets.set_triangle_from_string(0, "1C");
    original_volume->seam_facets.set_triangle_from_string(1, "2");
    original_volume->mmu_segmentation_facets.set_triangle_from_string(2, "3A");
    original_volume->fuzzy_skin_facets.set_triangle_from_string(3, "4");
    const ObjectID original_object_id = original_object->id();
    const ObjectID original_volume_id = original_volume->id();
    const ObjectID original_instance_id = original_object->instances.front()->id();
    MeshCaptureCache cache;
    const auto first = capture_model_state(original, cache);
    const auto second = capture_model_state(original, cache);
    CHECK(cache.serialized_mesh_count() == 1);
    CHECK(first.immutable_meshes.size() == 1);
    CHECK(second.immutable_meshes.size() == 1);
    CHECK(first.immutable_meshes.front().key == second.immutable_meshes.front().key);
    CHECK(first.immutable_meshes.front().resident == nullptr);
    CHECK(first.immutable_meshes.front().deferred == nullptr);
    CHECK(first.immutable_meshes.front().native != nullptr);
    CHECK(first.immutable_meshes.front().native == second.immutable_meshes.front().native);
    CHECK(first.mutable_objects.front().id == original_object_id.id);
    CHECK(first.mutable_objects.front().volume_ids ==
          std::vector<Slic3r::Neo::History::ObjectID>{original_volume_id.id});
    CHECK(first.mutable_objects.front().instance_ids ==
          std::vector<Slic3r::Neo::History::ObjectID>{original_instance_id.id});

    const auto recaptured = capture_model_state(original, cache);
    CHECK(model_state_equal(first, recaptured));
    cache.clear();
    CHECK(cache.serialized_mesh_count() == 0);
    CHECK(model_state_equal(first, capture_model_state(original, cache)));
    CHECK(cache.serialized_mesh_count() == 1);
    Model restored_original = stage_model(original, restore_state(first));
    CHECK(restored_original.objects.front()->id() == original_object_id);
    CHECK(restored_original.objects.front()->volumes.front()->id() == original_volume_id);
    CHECK(restored_original.objects.front()->instances.front()->id() == original_instance_id);
    CHECK(restored_original.objects.front()->volumes.front()->get_mesh_shared_ptr().get() ==
          first.immutable_meshes.front().native.get());
    CHECK(restored_original.objects.front()->volumes.front()->supported_facets.equals(
          original_volume->supported_facets));
    CHECK(restored_original.objects.front()->volumes.front()->seam_facets.equals(
          original_volume->seam_facets));
    CHECK(restored_original.objects.front()->volumes.front()->mmu_segmentation_facets.equals(
          original_volume->mmu_segmentation_facets));
    CHECK(restored_original.objects.front()->volumes.front()->fuzzy_skin_facets.equals(
          original_volume->fuzzy_skin_facets));
    MeshCaptureCache restore_cache;
    CHECK(model_state_equal(first, capture_model_state(restored_original, restore_cache)));

    // Explicitly byte-backed states remain restorable for compatibility with
    // test fixtures and any state deliberately downgraded by a later gate.
    std::ostringstream mesh_stream(std::ios::binary | std::ios::out);
    cereal::BinaryOutputArchive mesh_archive(mesh_stream);
    mesh_archive(*first.immutable_meshes.front().native);
    const std::string encoded_mesh = mesh_stream.str();
    Slic3r::Neo::History::ModelState byte_fallback = first;
    byte_fallback.immutable_meshes.front().native.reset();
    byte_fallback.immutable_meshes.front().native_bytes = 0;
    byte_fallback.immutable_meshes.front().resident = std::make_shared<const Slic3r::Neo::History::Bytes>(
        Slic3r::Neo::History::Bytes(encoded_mesh.begin(), encoded_mesh.end()));
    Model restored_fallback = stage_model(original, restore_state(byte_fallback));
    CHECK(restored_fallback.objects.front()->volumes.front()->mesh().facets_count() ==
          original.objects.front()->volumes.front()->mesh().facets_count());
    CHECK(restored_fallback.objects.front()->volumes.front()->get_mesh_shared_ptr().get() !=
          first.immutable_meshes.front().native.get());

    // ProjectHistory retains and restores the same native shared owner across
    // both navigation directions; it does not decode a byte fallback.
    Slic3r::Neo::History::ProjectHistory native_history;
    CHECK(native_history.commit("base", Slic3r::Neo::History::Category::Project, first, {}));
    original.objects.front()->config.touch();
    const auto changed = capture_model_state(original, cache);
    CHECK(native_history.commit("edit", Slic3r::Neo::History::Category::Project, changed, {}));
    RestoreState native_restored;
    CHECK(native_history.undo(native_restored));
    Model native_undo = stage_model(original, native_restored);
    CHECK(native_undo.objects.front()->volumes.front()->get_mesh_shared_ptr().get() ==
          first.immutable_meshes.front().native.get());
    CHECK(native_history.redo(native_restored));
    Model native_redo = stage_model(original, native_restored);
    CHECK(native_redo.objects.front()->volumes.front()->get_mesh_shared_ptr().get() ==
          first.immutable_meshes.front().native.get());

    // Native mesh accounting is omitted while the live caller shares the
    // owner, then charged once history becomes the sole owner. Eviction drops
    // that ownership instead of leaving an unbounded native cache behind.
    auto sole_mesh = std::make_shared<const TriangleMesh>(its_make_cube(18.0, 18.0, 18.0));
    Slic3r::Neo::History::ModelState native_state;
    native_state.immutable_meshes.push_back({"native-only", {}, {}, false, sole_mesh, sole_mesh->memsize()});
    Slic3r::Neo::History::ModelState no_native_state = native_state;
    no_native_state.immutable_meshes.front().native.reset();
    Slic3r::Neo::History::ProjectHistory native_budget(1u << 20);
    CHECK(native_budget.commit("native", Slic3r::Neo::History::Category::Project, native_state, {}));
    Slic3r::Neo::History::ProjectHistory no_native_budget(1u << 20);
    CHECK(no_native_budget.commit("native", Slic3r::Neo::History::Category::Project, no_native_state, {}));
    CHECK(native_budget.bytes_used() == no_native_budget.bytes_used());
    native_state.immutable_meshes.front().native.reset();
    std::weak_ptr<const TriangleMesh> sole_mesh_weak = sole_mesh;
    sole_mesh.reset();
    CHECK(native_budget.bytes_used() > no_native_budget.bytes_used());
    native_budget.set_byte_budget(1);
    Slic3r::Neo::History::ModelState no_mesh_after;
    no_mesh_after.serialized = {1};
    CHECK(native_budget.commit("second", Slic3r::Neo::History::Category::Project, no_mesh_after, {}));
    no_mesh_after.serialized = {2};
    CHECK(native_budget.commit("third", Slic3r::Neo::History::Category::Project, no_mesh_after, {}));
    CHECK(native_budget.resource_diagnostics().evicted_entry_count > 0);
    CHECK(sole_mesh_weak.expired());

    CHECK(cache.serialized_mesh_count() == 1);

    Model replaced = model_with_cube(30.0);
    const auto replacement = capture_model_state(replaced, cache);
    CHECK(cache.serialized_mesh_count() == 2);
    CHECK(replacement.immutable_meshes.size() == 1);
    CHECK(replacement.immutable_meshes.front().key != first.immutable_meshes.front().key);
    CHECK(replacement.immutable_meshes.front().native != first.immutable_meshes.front().native);
    CHECK(capture_model_state(replaced, cache).immutable_meshes.front().key ==
          replacement.immutable_meshes.front().key);
    CHECK(cache.serialized_mesh_count() == 2);

    Model restored_replacement = stage_model(replaced, restore_state(replacement));
    CHECK(model_state_equal(replacement, capture_model_state(restored_replacement, restore_cache)));

    // A non-zero ModelConfig timestamp is the Orca-style archive gate. The
    // complete object record remains in every ModelState; only the Cereal work
    // is skipped for an unchanged live object.
    Model objects = model_with_cube(10.0);
    objects.objects.front()->add_instance();
    ModelObject* second_object = objects.add_object();
    second_object->add_instance();
    second_object->add_volume(TriangleMesh(its_make_cube(12.0, 12.0, 12.0)));
    MeshCaptureCache object_mesh_cache;
    MutableObjectCaptureCache object_cache;
    const auto object_first = capture_model_state(objects, object_mesh_cache, object_cache);
    const auto object_second = capture_model_state(objects, object_mesh_cache, object_cache);
    CHECK(object_cache.serialized_object_count() == 2);
    CHECK(object_cache.reused_object_count() == 2);
    CHECK(object_first.mutable_objects[0].data == object_second.mutable_objects[0].data);
    CHECK(object_first.mutable_objects[1].data == object_second.mutable_objects[1].data);
    CHECK(object_first.mutable_objects[0].instance_ids.size() == 2);
    CHECK(object_first.mutable_objects[1].instance_ids.size() == 1);

    // Touching only one object archives only that object. A zero timestamp is
    // explicitly rejected by the cache, because it is not reliable enough to
    // gate serialization (the live ModelConfig API does not expose a setter
    // for the intentionally-invalid zero value).
    objects.objects[0]->config.touch();
    const auto object_third = capture_model_state(objects, object_mesh_cache, object_cache);
    CHECK(object_cache.serialized_object_count() == 3);
    CHECK(object_cache.reused_object_count() == 3);
    CHECK(object_third.mutable_objects[0].data != object_second.mutable_objects[0].data);
    CHECK(object_third.mutable_objects[1].data == object_second.mutable_objects[1].data);
    CHECK(object_cache.find(objects.objects[0]->id().id, 0, {}, {}, {}) == nullptr);

    // Removing a live object drops its entry before the next capture, so a
    // later add cannot reuse a stale record even if its payload happens to be
    // similar.
    Model remove_add = model_with_cube(14.0);
    ModelObject* removed = remove_add.add_object();
    removed->add_instance();
    removed->add_volume(TriangleMesh(its_make_cube(16.0, 16.0, 16.0)));
    MeshCaptureCache remove_mesh_cache;
    MutableObjectCaptureCache remove_object_cache;
    capture_model_state(remove_add, remove_mesh_cache, remove_object_cache);
    const auto removed_id = removed->id().id;
    remove_add.delete_object(ObjectID(removed_id));
    capture_model_state(remove_add, remove_mesh_cache, remove_object_cache);
    ModelObject* added = remove_add.add_object();
    added->add_instance();
    added->add_volume(TriangleMesh(its_make_cube(16.0, 16.0, 16.0)));
    capture_model_state(remove_add, remove_mesh_cache, remove_object_cache);
    CHECK(added->id().id != removed_id);
    CHECK(remove_object_cache.serialized_object_count() == 3);

    // Consecutive retained states still restore complete, self-sufficient
    // object records. This exercises both navigation directions after the
    // timestamp-gated captures rather than reconstructing deltas.
    Slic3r::Neo::History::ProjectHistory history;
    CHECK(history.commit("base", Slic3r::Neo::History::Category::Project, object_first, {}));
    CHECK(history.commit("one object", Slic3r::Neo::History::Category::Project, object_third, {}));
    objects.objects[1]->config.touch();
    const auto object_fourth = capture_model_state(objects, object_mesh_cache, object_cache);
    CHECK(history.commit("second object", Slic3r::Neo::History::Category::Project, object_fourth, {}));
    RestoreState restored_state;
    CHECK(history.undo(restored_state));
    Model restored_third = stage_model(objects, restored_state);
    CHECK(model_state_equal(object_third, capture_model_state(restored_third, object_mesh_cache)));
    CHECK(restored_third.objects[0]->instances[0]->id().id ==
          object_third.mutable_objects[0].instance_ids[0]);
    CHECK(restored_third.objects[0]->instances[1]->id().id ==
          object_third.mutable_objects[0].instance_ids[1]);
    CHECK(restored_third.objects[1]->instances[0]->id().id ==
          object_third.mutable_objects[1].instance_ids[0]);
    CHECK(history.undo(restored_state));
    Model restored_first = stage_model(objects, restored_state);
    CHECK(model_state_equal(object_first, capture_model_state(restored_first, object_mesh_cache)));
    CHECK(history.redo(restored_state));
    Model restored_again = stage_model(objects, restored_state);
    CHECK(model_state_equal(object_third, capture_model_state(restored_again, object_mesh_cache)));
    return 0;
}
