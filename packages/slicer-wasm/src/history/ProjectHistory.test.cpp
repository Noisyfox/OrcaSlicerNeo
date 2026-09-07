#include "ProjectHistory.hpp"

#include <cassert>
#include <cstdint>

using namespace Slic3r::Neo::History;

static Bytes bytes(std::uint8_t value, std::size_t count = 1)
{
    return Bytes(count, value);
}

static ModelState model(std::uint8_t value, std::size_t count = 1)
{
    ModelState state;
    state.serialized = bytes(value, count);
    state.mutable_objects.push_back({ 42, value, bytes(value, count) });
    return state;
}

int main()
{
    ProjectHistory history(4096);
    assert(history.commit("baseline", Category::Project, model(1), bytes(9)));
    assert(history.commit("move", Category::Project, model(2), bytes(8)));
    assert(history.commit("selection", Category::Context, model(2), bytes(7)));
    assert(history.entry_count() == 2);
    assert(history.object_intervals().size() == 2);
    assert(history.object_intervals()[0].id == 42);
    assert(history.object_intervals()[0].begin == 0 && history.object_intervals()[0].end == 1);
    assert(history.object_intervals()[1].begin == 1 && history.object_intervals()[1].end == 3);

    RestoreState restored;
    assert(history.undo(restored));
    assert(restored.model.serialized == bytes(2));
    assert(restored.context == bytes(8));
    assert(history.undo(restored));
    assert(restored.model.serialized == bytes(1));
    assert(history.redo(restored));
    assert(restored.model.serialized == bytes(2));

    // A new branch truncates redo, while equal model/context is a no-op.
    assert(history.commit("branch", Category::Project, model(3), bytes(6)));
    assert(!history.can_redo());
    assert(!history.commit("same", Category::Project, model(3), bytes(6)));

    // Identical immutable mesh content is shared, and optional resident data
    // can be released while its deferred representation remains restorable.
    auto mesh = std::make_shared<const Bytes>(bytes(4, 128));
    auto deferred = std::make_shared<const Bytes>(bytes(5, 16));
    ModelState with_mesh = model(4, 8);
    with_mesh.immutable_meshes.push_back({ "mesh-1", mesh, deferred, true });
    assert(history.commit("mesh", Category::Project, with_mesh, bytes(3)));
    const auto used_before = history.bytes_used();
    assert(history.release_optional_data() > 0);
    assert(history.bytes_used() < used_before);
    assert(history.undo(restored));
    assert(restored.model.immutable_meshes.front().resident == nullptr);
    assert(restored.model.immutable_meshes.front().deferred != nullptr);

    // A single atomic entry larger than the budget remains available.
    ProjectHistory oversized(32);
    assert(oversized.commit("base", Category::Project, model(1), {}));
    assert(oversized.commit("large", Category::Project, model(2, 512), {}));
    assert(oversized.bytes_used() > oversized.byte_budget());
    assert(oversized.can_undo());
    assert(oversized.undo(restored));

    // Evicting the saved checkpoint conservatively reports dirty state.
    ProjectHistory checkpoint(1);
    checkpoint.commit("base", Category::Project, model(1, 4), {});
    checkpoint.mark_current_as_saved();
    checkpoint.commit("large", Category::Project, model(2, 4), {});
    assert(checkpoint.saved_checkpoint_evicted());
    assert(checkpoint.project_modified());
}
