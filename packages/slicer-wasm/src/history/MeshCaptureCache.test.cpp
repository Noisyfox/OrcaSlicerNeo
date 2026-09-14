#include "../bridge_history.hpp"

#include <iostream>

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
    MeshCaptureCache cache;
    const auto first = capture_model_state(original, cache);
    const auto second = capture_model_state(original, cache);
    CHECK(cache.serialized_mesh_count() == 1);
    CHECK(first.immutable_meshes.size() == 1);
    CHECK(second.immutable_meshes.size() == 1);
    CHECK(first.immutable_meshes.front().key == second.immutable_meshes.front().key);
    CHECK(first.immutable_meshes.front().resident == second.immutable_meshes.front().resident);

    Model restored_original = stage_model(original, restore_state(first));
    MeshCaptureCache restore_cache;
    CHECK(model_state_equal(first, capture_model_state(restored_original, restore_cache)));

    cache.clear();
    CHECK(cache.serialized_mesh_count() == 0);
    CHECK(model_state_equal(first, capture_model_state(original, cache)));
    CHECK(cache.serialized_mesh_count() == 1);

    Model replaced = model_with_cube(30.0);
    const auto replacement = capture_model_state(replaced, cache);
    CHECK(cache.serialized_mesh_count() == 2);
    CHECK(replacement.immutable_meshes.size() == 1);
    CHECK(replacement.immutable_meshes.front().key != first.immutable_meshes.front().key);
    CHECK(replacement.immutable_meshes.front().resident != first.immutable_meshes.front().resident);
    CHECK(capture_model_state(replaced, cache).immutable_meshes.front().key ==
          replacement.immutable_meshes.front().key);
    CHECK(cache.serialized_mesh_count() == 2);

    Model restored_replacement = stage_model(replaced, restore_state(replacement));
    CHECK(model_state_equal(replacement, capture_model_state(restored_replacement, restore_cache)));

    // A non-zero ModelConfig timestamp is the Orca-style archive gate. The
    // complete object record remains in every ModelState; only the Cereal work
    // is skipped for an unchanged live object.
    Model objects = model_with_cube(10.0);
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
    CHECK(object_cache.find(objects.objects[0]->id().id, 0, {}, {}) == nullptr);

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
    CHECK(history.undo(restored_state));
    Model restored_first = stage_model(objects, restored_state);
    CHECK(model_state_equal(object_first, capture_model_state(restored_first, object_mesh_cache)));
    CHECK(history.redo(restored_state));
    Model restored_again = stage_model(objects, restored_state);
    CHECK(model_state_equal(object_third, capture_model_state(restored_again, object_mesh_cache)));
    return 0;
}
