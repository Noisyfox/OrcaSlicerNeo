#include "../bridge_history.hpp"

#include <iostream>

#include "libslic3r/Model.hpp"
#include "libslic3r/TriangleMesh.hpp"

#define CHECK(condition) do { \
    if (!(condition)) { \
        std::cerr << "Mesh capture test failed: " #condition << "\\n"; \
        return 1; \
    } \
} while (false)

using namespace Slic3r;
using Slic3r::Neo::History::RestoreState;
using Slic3r::Neo::History::Codec::MeshCaptureCache;
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
    return 0;
}
