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

static ModelState model_with_shared_mesh(const std::shared_ptr<const Bytes>& mesh, const char* key)
{
    ModelState state;
    state.immutable_meshes.push_back({ key, mesh, {}, false });
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

    // Preparation is non-mutating: an adapter can reject the staged bytes
    // without advancing the cursor, then retry the same target.
    RestorePlan prepared;
    const auto before_cursor = history.cursor();
    CHECK(history.prepare_undo(prepared));
    CHECK(history.cursor() == before_cursor);
    CHECK(prepared.from_cursor == before_cursor);
    // The current state is a context-only record after `move`; one Undo must
    // skip it and restore the preceding project frame's predecessor.
    CHECK(prepared.target_cursor == 0);
    ProjectHistory restore_commit;
    CHECK(restore_commit.commit("baseline", Category::Project, model(1), bytes(1)));
    CHECK(restore_commit.commit("edit", Category::Project, model(2), bytes(2)));
    RestorePlan committed;
    CHECK(restore_commit.prepare_undo(committed));
    CHECK(restore_commit.commit_restore(committed));
    CHECK(restore_commit.cursor() == committed.target_cursor);
    RestorePlan stale = committed;
    stale.from_cursor = 123;
    CHECK(!restore_commit.commit_restore(stale));
    CHECK(restore_commit.cursor() == committed.target_cursor);
    CHECK(!restore_commit.commit_restore(committed));

    RestoreState restored;
    CHECK(history.undo(restored));
    CHECK(restored.model.serialized == bytes(1));
    CHECK(restored.context == bytes(9));
    CHECK(!history.can_undo());
    CHECK(history.redo(restored));
    CHECK(restored.model.serialized == bytes(2));
    CHECK(restored.context == bytes(8));
    CHECK(!history.can_redo());

    // Multiple consecutive context records after a project operation are
    // skipped as one navigation unit. Redo is symmetric and restores the
    // next project frame, not the context records themselves.
    ProjectHistory consecutive_context;
    CHECK(consecutive_context.commit("baseline", Category::Project, model(1), bytes(10)));
    CHECK(consecutive_context.commit("edit", Category::Project, model(2), bytes(11)));
    CHECK(consecutive_context.commit("selection 1", Category::Context, model(2), bytes(12)));
    CHECK(consecutive_context.commit("selection 2", Category::Context, model(2), bytes(13)));
    CHECK(consecutive_context.can_undo());
    CHECK(consecutive_context.undo(restored));
    CHECK(consecutive_context.cursor() == 0);
    CHECK(restored.model.serialized == bytes(1));
    CHECK(restored.context == bytes(10));
    CHECK(consecutive_context.can_redo());
    CHECK(consecutive_context.redo(restored));
    CHECK(consecutive_context.cursor() == 1);
    CHECK(restored.model.serialized == bytes(2));
    CHECK(restored.context == bytes(11));
    CHECK(!consecutive_context.can_redo());

    // A context-only branch after Undo still discards all redo project
    // entries, while context-only history at the baseline remains non-dirty
    // and non-navigable.
    ProjectHistory context_branch;
    CHECK(context_branch.commit("baseline", Category::Project, model(1), bytes(20)));
    context_branch.mark_current_as_saved();
    CHECK(context_branch.commit("edit", Category::Project, model(2), bytes(21)));
    CHECK(context_branch.commit("selection 1", Category::Context, model(2), bytes(22)));
    CHECK(context_branch.commit("selection 2", Category::Context, model(2), bytes(23)));
    CHECK(context_branch.undo(restored));
    CHECK(!context_branch.project_modified());
    CHECK(context_branch.commit("new selection", Category::Context, model(1), bytes(24)));
    CHECK(!context_branch.can_redo());
    CHECK(!context_branch.project_modified());
    ProjectHistory baseline_context;
    CHECK(baseline_context.commit("baseline", Category::Project, model(1), bytes(30)));
    baseline_context.mark_current_as_saved();
    CHECK(baseline_context.commit("selection", Category::Context, model(1), bytes(31)));
    CHECK(!baseline_context.can_undo());
    CHECK(!baseline_context.can_redo());
    CHECK(!baseline_context.project_modified());

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

    // Directional menu jumps resolve the selected operation, not the entry
    // itself: Undo lands before the named project operation, while Redo lands
    // on its after-state. Context records between project frames are skipped,
    // and a stale/opposite-direction menu item is rejected by the core.
    ProjectHistory directional;
    CHECK(directional.commit("baseline", Category::Project, model(1), bytes(40)));
    CHECK(directional.commit("first", Category::Project, model(2), bytes(41)));
    CHECK(directional.commit("selection", Category::Context, model(2), bytes(42)));
    CHECK(directional.commit("second", Category::Project, model(3), bytes(43)));
    const auto directional_entries = directional.entries();
    CHECK(directional_entries.size() == 4);
    const auto baseline_id = directional_entries[0].id;
    const auto first_id = directional_entries[1].id;
    const auto context_id = directional_entries[2].id;
    const auto second_id = directional_entries[3].id;
    CHECK(directional.jump(second_id, JumpDirection::Undo, restored));
    CHECK(restored.model.serialized == bytes(2));
    CHECK(directional.cursor() == 1);
    CHECK(directional.jump(first_id, JumpDirection::Undo, restored));
    CHECK(restored.model.serialized == bytes(1));
    CHECK(directional.cursor() == 0);
    CHECK(directional.jump(first_id, JumpDirection::Redo, restored));
    CHECK(restored.model.serialized == bytes(2));
    CHECK(directional.cursor() == 1);
    CHECK(directional.jump(second_id, JumpDirection::Redo, restored));
    CHECK(restored.model.serialized == bytes(3));
    CHECK(directional.cursor() == 3);
    CHECK(!directional.jump(second_id, JumpDirection::Redo, restored));
    CHECK(!directional.jump(context_id, JumpDirection::Undo, restored));
    CHECK(directional.jump(first_id, JumpDirection::Undo, restored));
    CHECK(!directional.jump(context_id, JumpDirection::Redo, restored));
    CHECK(!directional.jump(999999, JumpDirection::Undo, restored));
    CHECK(!directional.jump(baseline_id, JumpDirection::Undo, restored));

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

    // Resource accounting is deterministic and charges retained capacities,
    // not allocator-specific live heap readings.  Payload deltas are exact:
    // serialized and mutable blobs each retain their vector capacity plus one
    // fixed shared allocation unit.
    ProjectHistory small_payload(1u << 20);
    ProjectHistory large_payload(1u << 20);
    CHECK(small_payload.commit("same", Category::Project, model(1, 8), {}));
    CHECK(large_payload.commit("same", Category::Project, model(1, 24), {}));
    CHECK(large_payload.bytes_used() - small_payload.bytes_used() == 2 * (24 - 8));

    // Long entry labels and mesh keys charge their observed retained string
    // capacities; short-string storage is covered by the fixed record unit.
    ModelState short_strings = model(2, 4);
    short_strings.immutable_meshes.push_back({ "mesh", {}, {}, false });
    ModelState long_strings = model(2, 4);
    long_strings.immutable_meshes.push_back({ std::string(80, 'm'), {}, {}, false });
    ProjectHistory short_string_history(1u << 20);
    ProjectHistory long_string_history(1u << 20);
    CHECK(short_string_history.commit("baseline", Category::Project, model(1), {}));
    CHECK(long_string_history.commit("baseline", Category::Project, model(1), {}));
    CHECK(short_string_history.commit("short", Category::Project, short_strings, {}));
    CHECK(long_string_history.commit(std::string(80, 'l'), Category::Project, long_strings, {}));
    const auto short_label_capacity = short_string_history.current().entry.label.capacity();
    const auto long_label_capacity = long_string_history.current().entry.label.capacity();
    const auto short_key_capacity = short_string_history.current().model.immutable_meshes.front().key.capacity();
    const auto long_key_capacity = long_string_history.current().model.immutable_meshes.front().key.capacity();
    const auto string_bytes = [](std::size_t size, std::size_t capacity) {
        return size > ResourceAccounting::kInlineStringCapacity
            ? capacity + ResourceAccounting::kStringTerminatorBytes : std::size_t(0);
    };
    const auto label_delta = string_bytes(80, long_label_capacity) - string_bytes(5, short_label_capacity);
    const auto key_delta = string_bytes(80, long_key_capacity) - string_bytes(4, short_key_capacity);
    if (long_string_history.bytes_used() - short_string_history.bytes_used() != label_delta + key_delta) {
        std::cerr << "string accounting: actual=" << (long_string_history.bytes_used() - short_string_history.bytes_used())
                  << " expected=" << (label_delta + key_delta) << " label=" << label_delta << " key=" << key_delta
                  << " caps=" << short_label_capacity << "," << long_label_capacity << ","
                  << short_key_capacity << "," << long_key_capacity << "\n";
        return 1;
    }

    // Empty and short strings use the canonical inline threshold rather than
    // the implementation-reported SSO capacity. This remains identical on
    // native and wasm even when their string capacity layouts differ.
    ProjectHistory empty_label_history(1u << 20);
    ProjectHistory short_label_history(1u << 20);
    CHECK(empty_label_history.commit("baseline", Category::Project, model(1), {}));
    CHECK(short_label_history.commit("baseline", Category::Project, model(1), {}));
    CHECK(empty_label_history.commit("", Category::Project, model(2), {}));
    CHECK(short_label_history.commit("short", Category::Project, model(2), {}));
    CHECK(empty_label_history.bytes_used() == short_label_history.bytes_used());

    // Identical shared payloads are charged once even when two retained
    // states use different keys and therefore cannot reuse by key matching.
    auto shared_payload = std::make_shared<const Bytes>(bytes(0xA1, 96));
    ModelState shared_first = model_with_shared_mesh(shared_payload, "first");
    ModelState shared_second = model_with_shared_mesh(shared_payload, "second");
    auto distinct_payload = std::make_shared<const Bytes>(bytes(0xA1, 96));
    ModelState distinct_second = model_with_shared_mesh(distinct_payload, "second");
    ProjectHistory shared_history(1u << 20);
    ProjectHistory distinct_history(1u << 20);
    CHECK(shared_history.commit("first", Category::Project, shared_first, {}));
    CHECK(shared_history.commit("second", Category::Project, shared_second, {}));
    CHECK(distinct_history.commit("first", Category::Project, shared_first, {}));
    CHECK(distinct_history.commit("second", Category::Project, distinct_second, {}));
    CHECK(distinct_history.bytes_used() - shared_history.bytes_used() ==
        shared_payload->capacity() + ResourceAccounting::kSharedBlobAllocationBytes);

    // Container capacity is part of the retained estimate.  Adding one
    // mutable object has an exact slot, payload, and interval delta.
    ModelState one_object = model(3, 7);
    ModelState two_objects = one_object;
    two_objects.mutable_objects.push_back({ 99, 3, bytes(7, 7) });
    ProjectHistory one_object_history(1u << 20);
    ProjectHistory two_object_history(1u << 20);
    CHECK(one_object_history.commit("objects", Category::Project, one_object, {}));
    CHECK(two_object_history.commit("objects", Category::Project, two_objects, {}));
    CHECK(two_object_history.bytes_used() - one_object_history.bytes_used() ==
        ResourceAccounting::kMutableObjectSlotBytes +
        ResourceAccounting::kObjectIntervalSlotBytes + 7 +
        ResourceAccounting::kSharedBlobAllocationBytes);

    // Context is charged at the retained vector capacity (the stored copy's
    // capacity equals its size), and optional release/eviction use this same
    // estimate rather than the old payload-only count.
    ProjectHistory context_small(1u << 20);
    ProjectHistory context_large(1u << 20);
    CHECK(context_small.commit("context", Category::Project, {}, bytes(9, 3)));
    CHECK(context_large.commit("context", Category::Project, {}, bytes(9, 11)));
    CHECK(context_large.bytes_used() - context_small.bytes_used() == 8);

    // Direct restore frames are owned by retained history entries.  A shared
    // frame must be returned verbatim for undo/redo, charged once for its
    // payload, and never be required for the serialized restore fallback.
    const auto direct_payload = std::make_shared<const Bytes>(bytes(0x5a, 128));
    const RestoreState::DirectFrame direct_frame {
        RestoreState::DirectFrame::Kind::Filament,
        std::static_pointer_cast<const void>(direct_payload), direct_payload->size()
    };
    ProjectHistory direct_history(1u << 20);
    ProjectHistory serialized_fallback(1u << 20);
    CHECK(direct_history.commit("baseline", Category::Project, model(1), {}, direct_frame));
    CHECK(direct_history.commit("edit", Category::Project, model(2), {}, direct_frame));
    CHECK(serialized_fallback.commit("baseline", Category::Project, model(1), {}));
    CHECK(serialized_fallback.commit("edit", Category::Project, model(2), {}));
    CHECK(direct_history.bytes_used() - serialized_fallback.bytes_used() ==
        2 * ResourceAccounting::kDirectFrameSlotBytes + direct_payload->size());
    RestorePlan direct_undo;
    CHECK(direct_history.prepare_undo(direct_undo));
    CHECK(direct_undo.state.direct_frame);
    CHECK(direct_undo.state.direct_frame->payload.get() == direct_payload.get());
    CHECK(direct_undo.state.direct_frame->bytes == direct_payload->size());
    CHECK(direct_history.commit_restore(direct_undo));
    RestorePlan direct_redo;
    CHECK(direct_history.prepare_redo(direct_redo));
    CHECK(direct_redo.state.direct_frame);
    CHECK(direct_redo.state.direct_frame->payload.get() == direct_payload.get());
    CHECK(direct_history.commit_restore(direct_redo));
    RestorePlan fallback_undo;
    CHECK(serialized_fallback.prepare_undo(fallback_undo));
    CHECK(!fallback_undo.state.direct_frame);

    // Sidecar-only Prime Tower commits retain the current model blobs, attach
    // a typed predecessor frame for Undo, and still truncate a redo branch.
    const auto prime_before_payload = std::make_shared<const Bytes>(bytes(0x31, 24));
    const auto prime_after_payload = std::make_shared<const Bytes>(bytes(0x32, 24));
    const RestoreState::DirectFrame prime_before {
        RestoreState::DirectFrame::Kind::PrimeTower,
        std::static_pointer_cast<const void>(prime_before_payload), prime_before_payload->size()
    };
    const RestoreState::DirectFrame prime_after {
        RestoreState::DirectFrame::Kind::PrimeTower,
        std::static_pointer_cast<const void>(prime_after_payload), prime_after_payload->size()
    };
    ProjectHistory narrow(1u << 20);
    const auto retained_model = model(7, 4096);
    CHECK(narrow.commit("baseline", Category::Project, retained_model, bytes(0x41, 16)));
    narrow.mark_current_as_saved();
    CHECK(narrow.commit_reusing_current_model("prime move", Category::Project, bytes(0x42, 20),
                                              prime_after, prime_before));
    CHECK(narrow.entry_count() == 1);
    CHECK(narrow.project_modified());
    CHECK(narrow.current().model.serialized == retained_model.serialized);
    CHECK(narrow.current().direct_frame);
    CHECK(narrow.current().direct_frame->kind == RestoreState::DirectFrame::Kind::PrimeTower);
    CHECK(narrow.undo(restored));
    CHECK(restored.direct_frame);
    CHECK(restored.direct_frame->kind == RestoreState::DirectFrame::Kind::PrimeTower);
    CHECK(restored.direct_frame->payload.get() == prime_before_payload.get());
    CHECK(!narrow.project_modified());
    CHECK(narrow.redo(restored));
    CHECK(restored.direct_frame);
    CHECK(restored.direct_frame->payload.get() == prime_after_payload.get());
    CHECK(narrow.undo(restored));
    CHECK(narrow.commit_reusing_current_model("branched prime move", Category::Project,
                                              bytes(0x43, 20), prime_after));
    CHECK(!narrow.can_redo());

    // The sidecar transaction also restores a partially-mutated branch when
    // the append throws. This exercises the same predecessor/direct-frame
    // path used by Prime Tower without relying on allocator failure.
    ProjectHistory exception_rollback(1u << 20);
    CHECK(exception_rollback.commit("base", Category::Project, retained_model, bytes(0x51, 8)));
    CHECK(exception_rollback.commit("redo candidate", Category::Project, retained_model, bytes(0x52, 8), prime_after));
    CHECK(exception_rollback.undo(restored));
    const auto rollback_entries = exception_rollback.entries();
    const auto rollback_cursor = exception_rollback.cursor();
    const auto rollback_bytes = exception_rollback.bytes_used();
    exception_rollback.fail_next_reusing_commit_for_test();
    bool rollback_threw = false;
    try {
        exception_rollback.commit_reusing_current_model("failing prime move", Category::Project,
                                                        bytes(0x53, 8), prime_after, prime_before);
    } catch (...) {
        rollback_threw = true;
    }
    CHECK(rollback_threw);
    CHECK(exception_rollback.entries().size() == rollback_entries.size());
    CHECK(exception_rollback.entries().front().id == rollback_entries.front().id);
    CHECK(exception_rollback.entries().back().id == rollback_entries.back().id);
    CHECK(exception_rollback.cursor() == rollback_cursor);
    CHECK(exception_rollback.bytes_used() == rollback_bytes);
    CHECK(exception_rollback.can_redo());
    CHECK(exception_rollback.current().context == bytes(0x51, 8));

    // A narrow commit under a tiny budget follows the same eviction policy as
    // a normal commit, and an empty/no-op call leaves the timeline unchanged.
    ProjectHistory narrow_budget(1);
    CHECK(narrow_budget.commit("baseline", Category::Project, model(1, 32), bytes(1)));
    const auto narrow_count = narrow_budget.entry_count();
    CHECK(!narrow_budget.commit_reusing_current_model("empty", Category::Project, bytes(1)));
    CHECK(narrow_budget.entry_count() == narrow_count);
    CHECK(narrow_budget.commit_reusing_current_model("budgeted move", Category::Project,
                                                      bytes(3, 2048), prime_after));
    CHECK(narrow_budget.resource_diagnostics().evicted_entry_count > 0 ||
          narrow_budget.resource_diagnostics().oversized_entry_retained);

    // Under budget pressure direct frames leave with their entry: retained
    // entries still expose their exact frame while an evicted target has no
    // plan and therefore cannot accidentally read an unbudgeted side cache.
    ProjectHistory direct_eviction(1);
    CHECK(direct_eviction.commit("base", Category::Project, model(1), {}, direct_frame));
    CHECK(direct_eviction.commit("edit", Category::Project, model(2), {}, direct_frame));
    const auto direct_eviction_entries = direct_eviction.entries();
    CHECK(direct_eviction.commit("tail", Category::Project, model(3), {}, direct_frame));
    CHECK(direct_eviction.resource_diagnostics().evicted_entry_count > 0);
    bool evicted_direct_entry = false;
    for (const auto& entry : direct_eviction_entries) {
        RestorePlan evicted_direct_plan;
        if (!direct_eviction.prepare_jump(entry.id, JumpDirection::Undo, evicted_direct_plan) &&
            !direct_eviction.prepare_jump(entry.id, JumpDirection::Redo, evicted_direct_plan))
            evicted_direct_entry = true;
    }
    CHECK(evicted_direct_entry);

    // Resource effects are observable diagnostics, not notifications.  The
    // released-byte counter is cumulative for this project session and the
    // retained oldest entry remains a safe restore target.
    const auto mesh_diagnostics = history.resource_diagnostics();
    CHECK(mesh_diagnostics.optional_bytes_released > 0);
    CHECK(mesh_diagnostics.bytes_used == history.bytes_used());
    CHECK(mesh_diagnostics.byte_budget == history.byte_budget());

    // A single atomic entry larger than the budget remains available.
    ProjectHistory oversized(32);
    CHECK(oversized.commit("base", Category::Project, model(1), {}));
    CHECK(oversized.commit("large", Category::Project, model(2, 512), {}));
    CHECK(oversized.bytes_used() > oversized.byte_budget());
    CHECK(oversized.can_undo());
    CHECK(oversized.resource_diagnostics().oversized_entry_retained);
    CHECK(oversized.undo(restored));

    // When older history is evicted, the current oversized operation still
    // undoes to its direct predecessor rather than skipping over it.
    ProjectHistory recent(1);
    CHECK(recent.commit("base", Category::Project, model(1), {}));
    CHECK(recent.commit("move", Category::Project, model(2), {}));
    const auto entries_before_eviction = recent.entries();
    CHECK(recent.commit("large", Category::Project, model(3, 512), {}));
    CHECK(recent.commit("tail", Category::Project, model(4), {}));
    CHECK(recent.can_undo());
    const auto entries_after_eviction = recent.entries();
    std::uint64_t evicted_entry_id = 0;
    for (const auto& before : entries_before_eviction) {
        bool retained = false;
        for (const auto& after : entries_after_eviction)
            if (after.id == before.id) retained = true;
        if (!retained && before.category == Category::Project)
            evicted_entry_id = before.id;
    }
    CHECK(evicted_entry_id != 0);
    CHECK(recent.resource_diagnostics().evicted_entry_count > 0);
    CHECK(recent.resource_diagnostics().last_evicted_entry_id == evicted_entry_id);
    CHECK(recent.resource_diagnostics().oldest_retained_entry_id != 0);
    RestorePlan evicted_plan;
    CHECK(!recent.prepare_jump(evicted_entry_id, JumpDirection::Undo, evicted_plan));
    CHECK(!recent.prepare_jump(evicted_entry_id, JumpDirection::Redo, evicted_plan));
    CHECK(!recent.jump(evicted_entry_id, JumpDirection::Undo, restored));
    CHECK(!recent.jump(evicted_entry_id, JumpDirection::Redo, restored));
    CHECK(recent.undo(restored));
    CHECK(restored.model.serialized == bytes(3, 512));
    const auto retained_entry_id = recent.entries().back().id;
    RestorePlan retained_plan;
    CHECK(recent.prepare_jump(retained_entry_id, JumpDirection::Redo, retained_plan));
    CHECK(recent.jump(retained_entry_id, JumpDirection::Redo, restored));
    CHECK(restored.model.serialized == bytes(4));

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

    // Deterministic large-model fixture (fixtures/history-large-model.json):
    // 24 mutable objects share one immutable mesh while 12 edits touch only
    // object 7.  A complete-model archive per edit would exceed this bound;
    // object deltas plus one mesh remain comfortably below it.
    ModelState large_base;
    large_base.immutable_meshes.push_back({
        "large-shared-mesh", std::make_shared<const Bytes>(bytes(0xA5, 64 * 1024)), {}, false});
    for (ObjectID id = 1; id <= 24; ++id)
        large_base.mutable_objects.push_back({id, 1, bytes(static_cast<std::uint8_t>(id), 4 * 1024)});
    ProjectHistory large(256 * 1024);
    CHECK(large.commit("large baseline", Category::Project, large_base, {}));
    for (std::uint8_t edit = 1; edit <= 12; ++edit) {
        auto next = large_base;
        next.mutable_objects.front().timestamp = edit + 1;
        next.mutable_objects.front().data = bytes(edit, 4 * 1024);
        CHECK(large.commit("large edit", Category::Project, next, {}));
        large_base = std::move(next);
    }
    CHECK(large.bytes_used() < 512 * 1024);
    CHECK(large.current().model.immutable_meshes.front().resident);
    const auto shared_resident = large.current().model.immutable_meshes.front().resident.get();
    CHECK(large.undo(restored));
    CHECK(restored.model.immutable_meshes.front().resident.get() == shared_resident);
    CHECK(large.redo(restored));
    CHECK(restored.model.immutable_meshes.front().resident.get() == shared_resident);

    return 0;
}
