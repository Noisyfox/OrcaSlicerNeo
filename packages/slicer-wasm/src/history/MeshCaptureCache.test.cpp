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

    // Transform state is a sparse timestamp-root overlay on the complete
    // object archive. Mutating one instance shares both immutable archives;
    // the exact matrix changes independently and is reapplied on restore.
    objects.objects[0]->instances[0]->set_offset(Vec3d(4.0, 2.0, 1.0));
    const auto object_third = capture_model_state(objects, object_mesh_cache, object_cache);
    CHECK(object_cache.serialized_object_count() == 2);
    CHECK(object_cache.reused_object_count() == 4);
    CHECK(object_third.mutable_objects[0].data == object_second.mutable_objects[0].data);
    CHECK(object_third.mutable_objects[1].data == object_second.mutable_objects[1].data);
    CHECK(object_third.mutable_objects[0].instance_transforms !=
          object_second.mutable_objects[0].instance_transforms);
    Model transformed_restore = stage_model(objects, restore_state(object_third));
    Slic3r::Neo::History::Codec::RestoreTimings reuse_timings;
    Model reused_restore = stage_model(objects, restore_state(object_first), &reuse_timings, &object_third);
    CHECK(reuse_timings.reused_objects == 2);
    CHECK(reuse_timings.deserialized_objects == 0);
    CHECK(reused_restore.objects[0]->id() == objects.objects[0]->id());
    CHECK(reused_restore.objects[0]->instances[0]->id() == objects.objects[0]->instances[0]->id());
    CHECK(reused_restore.objects[0]->instances[0]->get_offset() == Vec3d::Zero());
    CHECK(reused_restore.objects[0]->volumes[0]->id() == objects.objects[0]->volumes[0]->id());
    CHECK(reused_restore.objects[1]->id() == objects.objects[1]->id());
    Model mixed_live = objects;
    MutableObjectCaptureCache mixed_cache;
    CHECK(prime_model_capture_cache(mixed_live, object_third, mixed_cache));
    mixed_live.objects[1]->name = "changed archive";
    const auto changed_archive = capture_model_state(mixed_live, object_mesh_cache, mixed_cache);
    Slic3r::Neo::History::Codec::RestoreTimings mixed_timings;
    Model mixed_restore = stage_model(mixed_live, restore_state(object_first), &mixed_timings, &changed_archive);
    CHECK(mixed_timings.reused_objects == 1);
    CHECK(mixed_timings.deserialized_objects == 1);
    CHECK(mixed_restore.objects[1]->name == reused_restore.objects[1]->name);
    MeshCaptureCache transformed_mesh_cache;
    MutableObjectCaptureCache transformed_object_cache;
    CHECK(transformed_restore.objects[0]->instances[0]->get_offset() == Vec3d(4.0, 2.0, 1.0));
    CHECK(prime_model_capture_cache(transformed_restore, object_third, transformed_object_cache));
    CHECK(model_state_equal(object_third,
          capture_model_state(transformed_restore, transformed_mesh_cache, transformed_object_cache)));
    MutableObjectCaptureCache restored_prime_cache;
    CHECK(prime_model_capture_cache(transformed_restore, object_third, restored_prime_cache));
    MeshCaptureCache restored_prime_mesh_cache;
    const auto primed_capture = capture_model_state(
        transformed_restore, restored_prime_mesh_cache, restored_prime_cache);
    CHECK(model_state_equal(object_third, primed_capture));
    CHECK(restored_prime_cache.serialized_object_count() == 0);
    CHECK(restored_prime_cache.reused_object_count() == 2);
    auto invalid_overlay = object_third;
    invalid_overlay.mutable_objects[0].instance_transforms[0][12] += 1.0;
    CHECK(!prime_model_capture_cache(transformed_restore, invalid_overlay, restored_prime_cache));
    // Zero is a valid imported-object timestamp. Exact fingerprints, stable
    // child IDs, and mesh ownership still allow safe reuse without relying on
    // a timestamp touch.
    MutableObjectCaptureCache zero_timestamp_cache;
    MutableObjectCaptureCache::MutationFingerprint zero_fingerprint;
    zero_fingerprint.name = "imported-zero-timestamp";
    zero_timestamp_cache.insert(42, 0, std::make_shared<const Neo::History::Bytes>(
                                    Neo::History::Bytes {1, 2, 3}), {},
                                {43}, {44}, zero_fingerprint);
    CHECK(zero_timestamp_cache.find(42, 0, {}, {43}, {44}, zero_fingerprint) != nullptr);
    zero_fingerprint.name = "mutated-without-timestamp";
    CHECK(zero_timestamp_cache.find(42, 0, {}, {43}, {44}, zero_fingerprint) == nullptr);

    // Painting timestamps participate independently. This models a future
    // high-frequency painting child transaction that does not touch the
    // object's configuration timestamp.
    objects.objects[1]->volumes[0]->mmu_segmentation_facets.set_triangle_from_string(0, "2");
    objects.objects[1]->volumes[0]->mmu_segmentation_facets.touch();
    const auto painted = capture_model_state(objects, object_mesh_cache, object_cache);
    CHECK(object_cache.serialized_object_count() == 3);
    CHECK(object_cache.reused_object_count() == 5);
    CHECK(painted.mutable_objects[0].data == object_third.mutable_objects[0].data);
    CHECK(painted.mutable_objects[1].data != object_third.mutable_objects[1].data);

    // Unknown mutation classes deliberately discard all reusable mutable
    // archives. The next canonical root remains complete and self-contained.
    object_cache.invalidate_all();
    const auto conservative = capture_model_state(objects, object_mesh_cache, object_cache);
    CHECK(object_cache.serialized_object_count() == 5);
    CHECK(painted.mutable_objects[0].instance_transforms == conservative.mutable_objects[0].instance_transforms);
    CHECK(*painted.mutable_objects[1].data == *conservative.mutable_objects[1].data);

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

    // Non-transform fields cannot hide behind an unchanged object timestamp.
    Model metadata_model = model_with_cube(8.0);
    MeshCaptureCache metadata_mesh_cache;
    MutableObjectCaptureCache metadata_cache;
    auto metadata_before = capture_model_state(metadata_model, metadata_mesh_cache, metadata_cache);
    auto* metadata_object = metadata_model.objects[0];
    auto* metadata_volume = metadata_object->volumes[0];
    metadata_volume->set_offset(Vec3d(3, 4, 5));
    auto metadata_after = capture_model_state(metadata_model, metadata_mesh_cache, metadata_cache);
    CHECK(metadata_before.mutable_objects[0].data == metadata_after.mutable_objects[0].data);
    CHECK(stage_model(metadata_model, restore_state(metadata_after)).objects[0]->volumes[0]->get_offset() == Vec3d(3, 4, 5));
    metadata_before = metadata_after;
    metadata_volume->source.is_converted_from_inches = true;
    metadata_after = capture_model_state(metadata_model, metadata_mesh_cache, metadata_cache);
    CHECK(metadata_before.mutable_objects[0].data != metadata_after.mutable_objects[0].data);
    metadata_before = metadata_after;
    metadata_object->origin_translation = Vec3d(8, 9, 10);
    metadata_after = capture_model_state(metadata_model, metadata_mesh_cache, metadata_cache);
    CHECK(metadata_before.mutable_objects[0].data != metadata_after.mutable_objects[0].data);
    metadata_before = metadata_after;
    metadata_object->instances[0]->set_offset_to_assembly(Vec3d(2, 3, 4));
    metadata_after = capture_model_state(metadata_model, metadata_mesh_cache, metadata_cache);
    CHECK(metadata_before.mutable_objects[0].data != metadata_after.mutable_objects[0].data);
    metadata_before = metadata_after;
    metadata_volume->config.set_key_value("extruder", new ConfigOptionInt(2));
    metadata_after = capture_model_state(metadata_model, metadata_mesh_cache, metadata_cache);
    CHECK(metadata_before.mutable_objects[0].data != metadata_after.mutable_objects[0].data);
    metadata_before = metadata_after;
    metadata_volume->set_mesh(TriangleMesh(its_make_cube(9.0, 9.0, 9.0)));
    metadata_after = capture_model_state(metadata_model, metadata_mesh_cache, metadata_cache);
    CHECK(metadata_before.mutable_objects[0].data != metadata_after.mutable_objects[0].data);

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
    CHECK(restored_third.objects[0]->instances[0]->get_offset() == Vec3d(4.0, 2.0, 1.0));
    CHECK(prime_model_capture_cache(restored_third, object_third, object_cache));
    CHECK(model_state_equal(object_third, capture_model_state(restored_third, object_mesh_cache, object_cache)));
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
    CHECK(restored_again.objects[0]->instances[0]->get_offset() == Vec3d(4.0, 2.0, 1.0));
    CHECK(prime_model_capture_cache(restored_again, object_third, object_cache));
    CHECK(model_state_equal(object_third, capture_model_state(restored_again, object_mesh_cache, object_cache)));
    return 0;
}
