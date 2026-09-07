#include "ProjectHistory.hpp"

#include <cstdint>
#include <iostream>

#define CHECK(condition) do { \
    if (!(condition)) { \
        std::cerr << "ProjectHistory test failed: " #condition << "\\n"; \
        return 1; \
    } \
} while (false)

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
    CHECK(history.commit("baseline", Category::Project, model(1), bytes(9)));
    CHECK(history.commit("move", Category::Project, model(2), bytes(8)));
    CHECK(history.commit("selection", Category::Context, model(2), bytes(7)));
    CHECK(history.entry_count() == 2);
    CHECK(history.object_intervals().size() == 2);
    CHECK(history.object_intervals()[0].id == 42);
    CHECK(history.object_intervals()[0].begin == 0 && history.object_intervals()[0].end == 1);
    CHECK(history.object_intervals()[1].begin == 1 && history.object_intervals()[1].end == 3);

    RestoreState restored;
    CHECK(history.undo(restored));
    CHECK(restored.model.serialized == bytes(2));
    CHECK(restored.context == bytes(8));
    CHECK(history.undo(restored));
    CHECK(restored.model.serialized == bytes(1));
    CHECK(history.redo(restored));
    CHECK(restored.model.serialized == bytes(2));

    // A new branch truncates redo, while equal model/context is a no-op.
    CHECK(history.commit("branch", Category::Project, model(3), bytes(6)));
    CHECK(!history.can_redo());
    CHECK(!history.commit("same", Category::Project, model(3), bytes(6)));

    // Identical immutable mesh content is shared, and optional resident data
    // can be released while its deferred representation remains restorable.
    auto mesh = std::make_shared<const Bytes>(bytes(4, 128));
    auto deferred = std::make_shared<const Bytes>(bytes(5, 16));
    ModelState with_mesh = model(4, 8);
    with_mesh.immutable_meshes.push_back({ "mesh-1", mesh, deferred, true });
    CHECK(history.commit("mesh", Category::Project, with_mesh, bytes(3)));
    const auto used_before = history.bytes_used();
    CHECK(history.release_optional_data() > 0);
    CHECK(history.bytes_used() < used_before);
    CHECK(!history.current().model.immutable_meshes.empty());
    CHECK(history.current().model.immutable_meshes.front().resident == nullptr);
    CHECK(history.current().model.immutable_meshes.front().deferred != nullptr);
    CHECK(history.undo(restored));

    // A single atomic entry larger than the budget remains available.
    ProjectHistory oversized(32);
    CHECK(oversized.commit("base", Category::Project, model(1), {}));
    CHECK(oversized.commit("large", Category::Project, model(2, 512), {}));
    CHECK(oversized.bytes_used() > oversized.byte_budget());
    CHECK(oversized.can_undo());
    CHECK(oversized.undo(restored));

    // When older history is evicted, the current oversized operation still
    // undoes to its direct predecessor rather than skipping over it.
    ProjectHistory recent(1);
    CHECK(recent.commit("base", Category::Project, model(1), {}));
    CHECK(recent.commit("move", Category::Project, model(2), {}));
    CHECK(recent.commit("large", Category::Project, model(3, 512), {}));
    CHECK(recent.can_undo());
    CHECK(recent.undo(restored));
    CHECK(restored.model.serialized == bytes(2));

    // Evicting the saved checkpoint conservatively reports dirty state.
    ProjectHistory checkpoint(1);
    checkpoint.commit("base", Category::Project, model(1, 4), {});
    checkpoint.commit("saved", Category::Project, model(2, 4), {});
    checkpoint.mark_current_as_saved();
    checkpoint.commit("move", Category::Project, model(3, 4), {});
    checkpoint.commit("large", Category::Project, model(4, 4), {});
    CHECK(checkpoint.saved_checkpoint_evicted());
    CHECK(checkpoint.project_modified());
    return 0;
}
