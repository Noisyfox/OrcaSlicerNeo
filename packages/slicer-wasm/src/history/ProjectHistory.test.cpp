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

static ModelState model_with_native_state(std::uint8_t value, std::size_t native_bytes)
{
    auto state = model(value);
    state.mutable_objects.front().data = bytes(value, native_bytes);
    state.immutable_meshes.push_back({
        "mesh-shared", std::make_shared<const Bytes>(bytes(value, native_bytes)), {}, false});
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

    // Context-only records remain in the retained timeline and truncate a
    // redo branch, but standard one-step navigation skips them.  A session
    // containing only a context change does not become undoable.
    ProjectHistory context_only;
    CHECK(context_only.commit("baseline", Category::Project, model(1), bytes(1)));
    context_only.mark_current_as_saved();
    CHECK(context_only.commit("selection", Category::Context, model(1), bytes(2)));
    CHECK(!context_only.can_undo());
    CHECK(!context_only.can_redo());
    CHECK(!context_only.project_modified());
    CHECK(context_only.commit("edit", Category::Project, model(2), bytes(3)));
    CHECK(context_only.undo(restored));
    CHECK(restored.model.serialized == bytes(1));
    CHECK(!context_only.project_modified());
    CHECK(context_only.redo(restored));
    CHECK(restored.model.serialized == bytes(2));
    CHECK(context_only.project_modified());
    CHECK(context_only.undo(restored));
    CHECK(context_only.commit("new selection", Category::Context, model(1), bytes(4)));
    CHECK(!context_only.can_redo());

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

    // Native adapter storage is admitted to the same accounting and
    // retention lifecycle as the compact record. Eviction must remove an
    // entire restore frame, never leave a retained entry without its model
    // object or immutable mesh data.
    ProjectHistory native(640);
    CHECK(native.commit("base", Category::Project, model_with_native_state(1, 256), {}));
    CHECK(native.commit("move", Category::Project, model_with_native_state(2, 256), {}));
    CHECK(native.bytes_used() >= 512);
    CHECK(native.commit("latest", Category::Project, model_with_native_state(3, 256), {}));
    for (const auto& entry : native.entries()) {
        CHECK(native.jump(entry.id, restored));
        CHECK(!restored.model.mutable_objects.empty());
        CHECK(!restored.model.immutable_meshes.empty());
        CHECK(restored.model.immutable_meshes.front().resident != nullptr);
    }
    CHECK(native.undo(restored));
    CHECK(!restored.model.mutable_objects.empty());
    CHECK(!restored.model.immutable_meshes.empty());

    // Object versions are keyed independently: changing object 7 must not
    // duplicate object 9 or the unchanged immutable mesh in the next entry.
    auto shared_mesh = std::make_shared<const Bytes>(bytes(6, 64));
    ModelState shared_base;
    shared_base.mutable_objects.push_back({7, 10, bytes(1, 32)});
    shared_base.mutable_objects.push_back({9, 20, bytes(2, 32)});
    shared_base.immutable_meshes.push_back({"shared-native-mesh", shared_mesh, {}, false});
    ModelState shared_edit = shared_base;
    shared_edit.mutable_objects[0] = {7, 11, bytes(3, 32)};
    ProjectHistory shared(4096);
    CHECK(shared.commit("base", Category::Project, shared_base, {}));
    CHECK(shared.commit("one object", Category::Project, shared_edit, {}));
    CHECK(shared.object_intervals().size() == 3);
    const auto has_interval = [&shared](ObjectID id, std::size_t begin, std::size_t end) {
        for (const auto& interval : shared.object_intervals())
            if (interval.id == id && interval.begin == begin && interval.end == end) return true;
        return false;
    };
    CHECK(has_interval(7, 0, 1));
    CHECK(has_interval(7, 1, 2));
    CHECK(has_interval(9, 0, 2));
    CHECK(shared.current().model.immutable_meshes.front().resident.get() == shared_mesh.get());
    CHECK(shared.undo(restored));
    CHECK(restored.model.immutable_meshes.front().resident.get() == shared_mesh.get());
    CHECK(restored.model.mutable_objects[1].data == bytes(2, 32));

    return 0;
}
