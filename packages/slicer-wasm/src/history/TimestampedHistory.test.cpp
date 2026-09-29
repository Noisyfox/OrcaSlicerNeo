#include "TimestampedHistory.hpp"

#include <cstdlib>
#include <iostream>
#include <utility>

using namespace Slic3r::Neo::History;

#define CHECK(condition)                                                                                              \
    do {                                                                                                              \
        if (!(condition)) {                                                                                           \
            std::cerr << "CHECK failed at line " << __LINE__ << ": " #condition << '\n';                           \
            return EXIT_FAILURE;                                                                                      \
        }                                                                                                             \
    } while (false)

static Bytes bytes(std::uint8_t value, std::size_t count = 1)
{
    return Bytes(count, value);
}

static MutableObject object(ObjectID id, std::uint64_t timestamp, std::uint8_t value, std::size_t count = 1)
{
    MutableObject result;
    result.id = id;
    result.timestamp = timestamp;
    result.data = std::make_shared<const Bytes>(bytes(value, count));
    result.volume_ids = { id + 1000 };
    result.instance_ids = { id + 2000 };
    return result;
}

static TimestampedRoots roots(std::uint8_t marker, std::vector<MutableObject> objects,
                              std::uint8_t plate = 0, std::uint8_t context = 0,
                              std::uint8_t project = 0)
{
    TimestampedRoots result;
    result.model.serialized = bytes(marker);
    result.model.mutable_objects = std::move(objects);
    result.session.plate_session = bytes(plate);
    result.session.history_context = bytes(context);
    if (plate != 0) result.session.scene_plate_ids = {"plate-" + std::to_string(plate)};
    result.project_config = bytes(project);
    return result;
}

static bool object_is(const TimestampedRestore& restored, std::size_t index, ObjectID id,
                      std::uint64_t timestamp, std::uint8_t value)
{
    if (index >= restored.roots.model.mutable_objects.size()) return false;
    const auto& object = restored.roots.model.mutable_objects[index];
    return object.id == id && object.timestamp == timestamp && object.data && *object.data == bytes(value);
}

static bool is_navigation_sentinel(const TimestampedRestore& restored)
{
    return restored.timestamp == 77 && restored.roots.model.serialized == bytes(77) &&
           restored.roots.model.mutable_objects.size() == 1 && object_is(restored, 0, 77, 77, 77) &&
           restored.roots.session.plate_session == bytes(77) &&
           restored.roots.session.history_context == bytes(77) && restored.roots.project_config == bytes(77) &&
           restored.scene_delta.object_ids == std::vector<ObjectID>({77}) &&
           restored.scene_delta.object_order == std::vector<ObjectID>({77});
}

int main()
{
    // Transform roots share a potentially large archive but remain distinct
    // authoritative states. Unversioned archive edits must also mark the
    // object in the renderer delta even when config timestamp stays zero.
    TimestampedHistory overlays;
    auto overlay_before = roots(1, {object(1, 0, 1, 1024 * 1024)});
    overlay_before.model.mutable_objects[0].instance_transforms.push_back({});
    auto overlay_after = overlay_before;
    overlay_after.model.mutable_objects[0].instance_transforms[0][12] = 9;
    CHECK(overlays.begin_operation("move", overlay_before));
    const auto overlay_bytes = overlays.bytes_used();
    CHECK(overlays.commit_operation(overlay_after));
    TimestampedRestore overlay_restore;
    CHECK(overlays.undo(overlay_after, overlay_restore));
    CHECK(overlay_restore.scene_delta.object_ids == std::vector<ObjectID>({1}));
    CHECK(overlay_restore.roots.model.mutable_objects[0].instance_transforms[0][12] == 0);
    CHECK(overlays.bytes_used() < overlay_bytes + 8192);
    CHECK(overlays.redo(overlay_restore));
    CHECK(overlay_restore.roots.model.mutable_objects[0].instance_transforms[0][12] == 9);
    auto metadata_after = overlay_after;
    metadata_after.model.mutable_objects[0].data = std::make_shared<const Bytes>(bytes(2));
    CHECK(overlays.begin_operation("paint", overlay_after));
    CHECK(overlays.commit_operation(metadata_after));
    CHECK(overlays.entries().back().scene_delta.object_ids == std::vector<ObjectID>({1}));
    CHECK(overlays.entries().back().operation_kind == TimestampedOperationKind::NonPaint);
    CHECK(overlays.entries().back().editing_session_id == 0);

    // One semantic operation may add, move, and delete multiple stable-ID
    // objects. A non-adjacent menu target restores its explicit timestamp.
    TimestampedHistory sequence;
    const auto initial = roots(10, { object(10, 1, 10), object(20, 1, 20) }, 1, 11, 21);
    const auto compound = roots(11, { object(10, 2, 12), object(30, 1, 30) }, 2, 12, 22);
    const auto final = roots(12, { object(10, 2, 12), object(30, 2, 32) }, 3, 13, 23);
    CHECK(sequence.begin_operation("compound add/move/delete", initial));
    CHECK(sequence.begin_operation("nested edits join outer", initial));
    CHECK(sequence.commit_operation(compound));
    CHECK(sequence.entries().empty());
    CHECK(sequence.commit_operation(compound));
    CHECK(sequence.begin_operation("move added object", compound));
    CHECK(sequence.commit_operation(final));
    CHECK(sequence.entries().size() == 2);
    CHECK(sequence.entries()[0].before_timestamp == 0);
    CHECK(sequence.entries()[0].after_timestamp == 1);
    CHECK(sequence.entries()[1].before_timestamp == 1);
    CHECK(sequence.entries()[1].after_timestamp == 2);
    CHECK(sequence.entries()[0].scene_delta.object_ids == std::vector<ObjectID>({10, 20, 30}));
    CHECK(sequence.entries()[0].scene_delta.volume_ids == std::vector<ObjectID>({1010, 1020, 1030}));
    CHECK(sequence.entries()[0].scene_delta.instance_ids == std::vector<ObjectID>({2010, 2020, 2030}));
    CHECK(sequence.entries()[0].scene_delta.plate_ids == std::vector<std::string>({"plate-1", "plate-2"}));

    TimestampedRestore restored;
    CHECK(sequence.undo(final, restored));
    CHECK(restored.timestamp == 1);
    CHECK(restored.roots.model.mutable_objects.size() == 2);
    CHECK(object_is(restored, 0, 10, 2, 12));
    CHECK(object_is(restored, 1, 30, 1, 30));
    CHECK(sequence.redo(restored));
    CHECK(restored.timestamp == 2);
    CHECK(sequence.restore_before(sequence.entries()[0].id, nullptr, restored));
    CHECK(restored.timestamp == 0);
    CHECK(object_is(restored, 0, 10, 1, 10));
    CHECK(object_is(restored, 1, 20, 1, 20));
    CHECK(restored.scene_delta.object_ids == std::vector<ObjectID>({10, 20, 30}));
    CHECK(restored.scene_delta.volume_ids == std::vector<ObjectID>({1010, 1020, 1030}));
    CHECK(restored.scene_delta.instance_ids == std::vector<ObjectID>({2010, 2020, 2030}));
    CHECK(restored.scene_delta.object_order == std::vector<ObjectID>({10, 20}));
    CHECK(restored.scene_delta.plate_ids ==
          std::vector<std::string>({"plate-1", "plate-2", "plate-3"}));
    CHECK(sequence.restore_after(sequence.entries()[1].id, nullptr, restored));
    CHECK(restored.timestamp == 2);
    CHECK(object_is(restored, 0, 10, 2, 12));
    CHECK(object_is(restored, 1, 30, 2, 32));

    // All roots come from the same timestamp; no model-only restore can expose
    // a plate/context/config mixture from another frame.
    CHECK(restored.roots.session.plate_session == bytes(3));
    CHECK(restored.roots.session.history_context == bytes(13));
    CHECK(restored.roots.project_config == bytes(23));
    CHECK(sequence.restore(0, nullptr, restored));
    CHECK(restored.roots.model.serialized == bytes(10));
    CHECK(restored.roots.session.plate_session == bytes(1));
    CHECK(restored.roots.session.history_context == bytes(11));
    CHECK(restored.roots.project_config == bytes(21));

    // Snapshot manifests share unchanged object archives. Only object 2 gets
    // a second retained version at timestamp 1.
    TimestampedHistory sharing;
    const auto shared_before = roots(1, { object(1, 7, 1), object(2, 8, 2) });
    const auto shared_after = roots(2, { object(1, 7, 1), object(2, 9, 3) });
    CHECK(sharing.begin_operation("edit object 2", shared_before));
    CHECK(sharing.commit_operation(shared_after));
    CHECK(sharing.begin_operation("next operation", shared_after));
    const auto object_1_before = sharing.object_archive(0, 1);
    const auto object_1_after = sharing.object_archive(1, 1);
    const auto object_2_before = sharing.object_archive(0, 2);
    const auto object_2_after = sharing.object_archive(1, 2);
    CHECK(object_1_before && object_1_before == object_1_after);
    CHECK(object_1_before->data == object_1_after->data);
    CHECK(object_2_before && object_2_after && object_2_before != object_2_after);
    CHECK(sharing.object_archive_count() == 3);
    CHECK(sharing.object_intervals().size() == 3);
    CHECK(sharing.abort_operation());

    // Abort returns the captured predecessor for rollback and publishes no
    // timestamp or entry of its own.
    TimestampedHistory aborted;
    CHECK(aborted.begin_operation("failed", shared_before));
    TimestampedRestore aborted_predecessor;
    CHECK(aborted.abort_operation(&aborted_predecessor));
    CHECK(aborted_predecessor.roots.model.serialized == shared_before.model.serialized);
    CHECK(aborted_predecessor.roots.model.mutable_objects.size() == 2);
    CHECK(aborted.entries().empty());
    CHECK(aborted.snapshot_count() == 0);

    // Save marks an uncaptured topmost logical timestamp and allocates no
    // snapshot or object archive. First Undo captures it as the Redo endpoint.
    TimestampedHistory lazy;
    const auto lazy_before = roots(1, { object(1, 1, 1) });
    const auto lazy_after = roots(2, { object(1, 2, 2) });
    CHECK(lazy.begin_operation("move", lazy_before));
    CHECK(lazy.commit_operation(lazy_after));
    CHECK(lazy.snapshot_count() == 1);
    CHECK(lazy.object_archive_count() == 1);
    lazy.mark_current_as_saved();
    CHECK(lazy.snapshot_count() == 1);
    CHECK(lazy.object_archive_count() == 1);
    CHECK(!lazy.project_modified());
    CHECK(lazy.undo(lazy_after, restored));
    CHECK(lazy.snapshot_count() == 2);
    CHECK(lazy.can_redo());
    CHECK(lazy.project_modified());
    CHECK(lazy.redo(restored));
    CHECK(!lazy.project_modified());

    // A materialized timestamp is immutable after Redo. UI-only context at
    // the live top must not rewrite that endpoint or make the next Undo stale.
    auto lazy_ui_only = lazy_after;
    lazy_ui_only.session.history_context = bytes(99);
    CHECK(lazy.undo(lazy_ui_only, restored));
    CHECK(restored.timestamp == 0);
    CHECK(lazy.redo(restored));
    CHECK(restored.roots.session.history_context == lazy_after.session.history_context);

    // Unversioned metadata edits retain a distinct archive and publish their
    // renderer delta without copying archive bytes into the acceleration.
    TimestampedHistory timestamp_hint;
    const auto hint_before = roots(1, { object(1, 5, 1) });
    const auto hint_after = roots(2, { object(1, 5, 2) });
    CHECK(timestamp_hint.begin_operation("timestamp hint", hint_before));
    CHECK(timestamp_hint.commit_operation(hint_after));
    CHECK(timestamp_hint.undo(hint_after, restored));
    CHECK(restored.scene_delta.object_ids == std::vector<ObjectID>({1}));
    CHECK(timestamp_hint.object_archive_count() == 2);
    CHECK(timestamp_hint.redo(restored));
    CHECK(object_is(restored, 0, 1, 5, 2));
    CHECK(restored.scene_delta.object_ids == std::vector<ObjectID>({1}));

    // Active SceneDelta derivation retains only bounded ID/version metadata.
    // Increasing serialized object bytes grows bytes_used by exactly one
    // authoritative archive, not by a second before-scene copy.
    TimestampedHistory small_delta_metadata;
    TimestampedHistory large_delta_metadata;
    const auto small_metadata_roots = roots(1, { object(1, 1, 1, 1) });
    const auto large_metadata_roots = roots(1, { object(1, 1, 1, 1024 * 1024) });
    CHECK(small_delta_metadata.begin_operation("metadata", small_metadata_roots));
    CHECK(large_delta_metadata.begin_operation("metadata", large_metadata_roots));
    const auto small_archive = small_delta_metadata.object_archive(0, 1);
    const auto large_archive = large_delta_metadata.object_archive(0, 1);
    CHECK(small_archive && large_archive);
    const auto authoritative_archive_growth =
        large_archive->data->capacity() - small_archive->data->capacity();
    CHECK(large_delta_metadata.bytes_used() - small_delta_metadata.bytes_used() ==
          authoritative_archive_growth);
    CHECK(small_delta_metadata.abort_operation());
    CHECK(large_delta_metadata.abort_operation());

    // Committing from an earlier timestamp discards the old Redo future.
    TimestampedHistory branch;
    const auto branch_0 = roots(1, { object(1, 1, 1) });
    const auto branch_1 = roots(2, { object(1, 2, 2) });
    const auto branch_2 = roots(3, { object(1, 3, 3) });
    CHECK(branch.begin_operation("first", branch_0));
    CHECK(branch.commit_operation(branch_1));
    CHECK(branch.begin_operation("old future", branch_1));
    CHECK(branch.commit_operation(branch_2));
    CHECK(branch.undo(branch_2, restored));
    CHECK(branch.can_redo());
    auto branch_predecessor = branch_1;
    branch_predecessor.session.history_context = bytes(9);
    CHECK(branch.begin_operation("new branch", branch_predecessor));
    const auto branch_3 = roots(4, { object(1, 4, 4) });
    CHECK(branch.commit_operation(branch_3));
    CHECK(branch.entries().size() == 2);
    CHECK(branch.entries()[1].before_timestamp == 1);
    CHECK(branch.entries()[1].after_timestamp == 3);
    CHECK(!branch.can_redo());
    CHECK(!branch.object_archive(2, 1));
    CHECK(branch.undo(branch_3, restored));
    CHECK(restored.roots.session.history_context == bytes(9));

    // Old timestamps are evicted before the nearest usable predecessor. If a
    // saved checkpoint is among them, dirty state becomes conservative.
    TimestampedHistory budget;
    const auto budget_0 = roots(1, { object(1, 1, 1, 1024) });
    const auto budget_1 = roots(2, { object(1, 2, 2, 1024) });
    const auto budget_2 = roots(3, { object(1, 3, 3, 1024) });
    CHECK(budget.begin_operation("one", budget_0));
    CHECK(budget.commit_operation(budget_1));
    budget.mark_current_as_saved();
    const auto saved_snapshot_count = budget.snapshot_count();
    const auto saved_archive_count = budget.object_archive_count();
    CHECK(budget.begin_operation("two", budget_1));
    CHECK(budget.snapshot_count() == saved_snapshot_count + 1);
    CHECK(budget.object_archive_count() == saved_archive_count + 1);
    CHECK(budget.commit_operation(budget_2));
    CHECK(budget.begin_operation("three", budget_2));
    CHECK(budget.commit_operation(budget_2));
    CHECK(budget.set_navigation_floor(0));
    budget.set_byte_budget(1);
    CHECK(budget.snapshot_count() == 1);
    CHECK(budget.object_archive(2, 1));
    CHECK(!budget.object_archive(0, 1));
    CHECK(budget.navigation_floor() == std::optional<LogicalTimestamp>(0));
    CHECK(!budget.set_navigation_floor(0)); // An evicted timestamp is no longer a valid new floor.
    CHECK(budget.navigation_floor() == std::optional<LogicalTimestamp>(0));
    CHECK(budget.can_undo());
    CHECK(budget.saved_checkpoint_evicted());
    CHECK(budget.project_modified());
    CHECK(budget.resource_diagnostics().oversized_nearest_history_retained);

    // A floor may be the uncaptured current timestamp. Attempts to cross it
    // reject before Undo's lazy top capture or any result/save/resource change.
    TimestampedHistory floor_history;
    const auto floor_0 = roots(1, {object(1, 1, 1)});
    const auto floor_1 = roots(2, {object(1, 2, 2)});
    const auto floor_2 = roots(3, {object(1, 3, 3)});
    CHECK(floor_history.begin_operation("floor first", floor_0));
    CHECK(floor_history.commit_operation(floor_1));
    CHECK(floor_history.begin_operation("floor second", floor_1));
    CHECK(floor_history.commit_operation(floor_2));
    CHECK(floor_history.current_timestamp() == 2);
    CHECK(floor_history.snapshot_count() == 2);
    floor_history.mark_current_as_saved();
    CHECK(floor_history.set_navigation_floor(2));
    CHECK(floor_history.navigation_floor() == std::optional<LogicalTimestamp>(2));
    CHECK(!floor_history.can_undo());

    TimestampedRestore sentinel;
    sentinel.timestamp = 77;
    sentinel.roots = roots(77, {object(77, 77, 77)}, 77, 77, 77);
    sentinel.scene_delta.object_ids = {77};
    sentinel.scene_delta.object_order = {77};
    TimestampedRestore rejected_restore = sentinel;
    const auto before_rejected_current = floor_history.current_timestamp();
    const auto before_rejected_entries = floor_history.entries();
    const auto before_rejected_snapshot_count = floor_history.snapshot_count();
    const auto before_rejected_archive_count = floor_history.object_archive_count();
    const auto before_rejected_bytes = floor_history.bytes_used();
    const auto before_rejected_resources = floor_history.resource_diagnostics();
    const auto before_rejected_saved = floor_history.saved_timestamp();
    const auto before_rejected_evicted = floor_history.saved_checkpoint_evicted();
    const auto rejected_entries_unchanged = [&]() {
        const auto& after = floor_history.entries();
        if (after.size() != before_rejected_entries.size()) return false;
        for (std::size_t i = 0; i < after.size(); ++i) {
            const auto& before_entry = before_rejected_entries[i];
            const auto& after_entry = after[i];
            if (after_entry.id != before_entry.id || after_entry.label != before_entry.label ||
                after_entry.before_timestamp != before_entry.before_timestamp ||
                after_entry.after_timestamp != before_entry.after_timestamp ||
                after_entry.operation_kind != before_entry.operation_kind ||
                after_entry.editing_session_id != before_entry.editing_session_id ||
                after_entry.scene_delta.object_ids != before_entry.scene_delta.object_ids ||
                after_entry.scene_delta.volume_ids != before_entry.scene_delta.volume_ids ||
                after_entry.scene_delta.instance_ids != before_entry.scene_delta.instance_ids ||
                after_entry.scene_delta.plate_ids != before_entry.scene_delta.plate_ids ||
                after_entry.scene_delta.object_order != before_entry.scene_delta.object_order)
                return false;
        }
        return true;
    };
    const auto rejected_navigation_unchanged = [&]() {
        const auto after = floor_history.resource_diagnostics();
        return floor_history.current_timestamp() == before_rejected_current &&
               rejected_entries_unchanged() &&
               floor_history.snapshot_count() == before_rejected_snapshot_count &&
               floor_history.object_archive_count() == before_rejected_archive_count &&
               floor_history.bytes_used() == before_rejected_bytes &&
               after.bytes_used == before_rejected_resources.bytes_used &&
               after.byte_budget == before_rejected_resources.byte_budget &&
               after.evicted_timestamp_count == before_rejected_resources.evicted_timestamp_count &&
               after.last_evicted_timestamp == before_rejected_resources.last_evicted_timestamp &&
               after.oversized_nearest_history_retained ==
                   before_rejected_resources.oversized_nearest_history_retained &&
               floor_history.saved_timestamp() == before_rejected_saved &&
               floor_history.saved_checkpoint_evicted() == before_rejected_evicted &&
               !floor_history.project_modified() && is_navigation_sentinel(rejected_restore);
    };

    CHECK(!floor_history.undo(floor_2, rejected_restore));
    CHECK(rejected_navigation_unchanged());
    CHECK(!floor_history.restore(1, &floor_2, rejected_restore));
    CHECK(rejected_navigation_unchanged());
    CHECK(!floor_history.restore_before(floor_history.entries()[0].id, &floor_2, rejected_restore));
    CHECK(rejected_navigation_unchanged());
    CHECK(!floor_history.restore_after(floor_history.entries()[0].id, &floor_2, rejected_restore));
    CHECK(rejected_navigation_unchanged());

    // The floor is reversible, an existing retained timestamp is valid, and
    // Redo remains usable when it returns to a timestamp at or above the floor.
    CHECK(floor_history.set_navigation_floor(1));
    CHECK(floor_history.navigation_floor() == std::optional<LogicalTimestamp>(1));
    CHECK(floor_history.can_undo());
    CHECK(floor_history.undo(floor_2, restored));
    CHECK(restored.timestamp == 1);
    CHECK(!floor_history.can_undo());
    CHECK(floor_history.can_redo());
    CHECK(floor_history.redo(restored));
    CHECK(restored.timestamp == 2);
    CHECK(floor_history.can_undo());
    CHECK(floor_history.set_navigation_floor(std::nullopt));
    CHECK(!floor_history.navigation_floor());
    CHECK(floor_history.can_undo());

    // Future and unavailable retained timestamps are rejected. The current
    // uncaptured timestamp remains a valid floor.
    TimestampedHistory invalid_floor;
    CHECK(invalid_floor.set_navigation_floor(0));
    CHECK(!invalid_floor.set_navigation_floor(1));
    CHECK(invalid_floor.navigation_floor() == std::optional<LogicalTimestamp>(0));
    CHECK(invalid_floor.current_timestamp() == 0);
    CHECK(invalid_floor.snapshot_count() == 0);
    CHECK(invalid_floor.object_archive_count() == 0);

    // Floor changes are rejected throughout an active native operation,
    // including attempts to clear it; the operation itself remains intact.
    TimestampedHistory active_floor;
    CHECK(active_floor.set_navigation_floor(0));
    CHECK(active_floor.begin_operation("active floor", floor_0));
    const auto active_floor_bytes = active_floor.bytes_used();
    const auto active_floor_snapshots = active_floor.snapshot_count();
    CHECK(!active_floor.set_navigation_floor(0));
    CHECK(!active_floor.set_navigation_floor(std::nullopt));
    CHECK(active_floor.operation_active());
    CHECK(active_floor.navigation_floor() == std::optional<LogicalTimestamp>(0));
    CHECK(active_floor.current_timestamp() == 0);
    CHECK(active_floor.entries().empty());
    CHECK(active_floor.snapshot_count() == active_floor_snapshots);
    CHECK(active_floor.bytes_used() == active_floor_bytes);
    CHECK(active_floor.abort_operation());

    // Opening an editing session sets the current timestamp as its reversible
    // floor without capturing state, changing the save marker, or pruning Redo.
    TimestampedHistory editing_session_history;
    const auto session_before = roots(31, {object(31, 1, 31)}, 1, 11, 21);
    const auto session_first = roots(32, {object(31, 2, 32)}, 2, 12, 22);
    const auto session_redo = roots(33, {object(31, 3, 33)}, 3, 13, 23);
    CHECK(editing_session_history.begin_operation("before session", session_before));
    CHECK(editing_session_history.commit_operation(session_first));
    CHECK(editing_session_history.begin_operation("preexisting redo", session_first));
    CHECK(editing_session_history.commit_operation(session_redo));
    CHECK(editing_session_history.undo(session_redo, restored));
    CHECK(restored.timestamp == 1);
    editing_session_history.mark_current_as_saved();
    const auto session_entries_before = editing_session_history.entries();
    const auto session_snapshots_before = editing_session_history.snapshot_count();
    const auto session_saved_before = editing_session_history.saved_timestamp();
    const bool session_modified_before = editing_session_history.project_modified();
    CHECK(editing_session_history.can_redo());
    const auto editing_session = editing_session_history.begin_editing_session();
    CHECK(editing_session && editing_session->id != 0 && editing_session->entry_timestamp == 1 &&
          !editing_session->has_effective_commit);
    const auto session_status = editing_session_history.editing_session_status();
    CHECK(session_status && session_status->id == editing_session->id &&
          session_status->entry_timestamp == 1 && !session_status->has_effective_commit);
    CHECK(!editing_session_history.operation_active());
    CHECK(editing_session_history.navigation_floor() == std::optional<LogicalTimestamp>(1));
    CHECK(editing_session_history.current_timestamp() == 1);
    CHECK(editing_session_history.entries().size() == session_entries_before.size());
    CHECK(editing_session_history.snapshot_count() == session_snapshots_before);
    CHECK(editing_session_history.saved_timestamp() == session_saved_before);
    CHECK(editing_session_history.project_modified() == session_modified_before);
    CHECK(editing_session_history.can_redo());
    CHECK(!editing_session_history.can_undo());

    // An empty/no-effect command follows the existing abort path. It adds no
    // history entry, leaves Redo intact, and does not set the lifetime latch.
    CHECK(editing_session_history.begin_operation("empty project operation", session_first));
    CHECK(editing_session_history.abort_operation());
    CHECK(editing_session_history.entries().size() == session_entries_before.size());
    CHECK(editing_session_history.can_redo());
    auto session_status_after_abort = editing_session_history.editing_session_status();
    CHECK(session_status_after_abort && !session_status_after_abort->has_effective_commit);

    // Overlap and public floor changes are rejected without changing the
    // active record or opening timestamp boundary.
    const auto floor_before_overlap = editing_session_history.navigation_floor();
    const auto bytes_before_overlap = editing_session_history.bytes_used();
    CHECK(!editing_session_history.begin_editing_session());
    CHECK(!editing_session_history.set_navigation_floor(std::nullopt));
    CHECK(!editing_session_history.set_navigation_floor(0));
    CHECK(!editing_session_history.set_navigation_floor(1));
    session_status_after_abort = editing_session_history.editing_session_status();
    CHECK(session_status_after_abort && session_status_after_abort->id == editing_session->id &&
          !session_status_after_abort->has_effective_commit);
    CHECK(editing_session_history.navigation_floor() == floor_before_overlap);
    CHECK(editing_session_history.bytes_used() == bytes_before_overlap);
    CHECK(editing_session_history.can_redo());

    // Conflicting manual floors and active operations prevent session entry
    // without taking snapshots, consuming an ID, or otherwise changing state.
    TimestampedHistory conflicting_floor;
    CHECK(conflicting_floor.begin_operation("floor setup", session_before));
    CHECK(conflicting_floor.commit_operation(session_first));
    CHECK(conflicting_floor.set_navigation_floor(0));
    const auto conflict_bytes_before = conflicting_floor.bytes_used();
    const auto conflict_snapshots_before = conflicting_floor.snapshot_count();
    CHECK(!conflicting_floor.begin_editing_session());
    CHECK(!conflicting_floor.editing_session_status());
    CHECK(conflicting_floor.navigation_floor() == std::optional<LogicalTimestamp>(0));
    CHECK(conflicting_floor.bytes_used() == conflict_bytes_before);
    CHECK(conflicting_floor.snapshot_count() == conflict_snapshots_before);
    CHECK(conflicting_floor.set_navigation_floor(1));
    const auto matching_floor_session = conflicting_floor.begin_editing_session();
    CHECK(matching_floor_session && matching_floor_session->id == 1 &&
          matching_floor_session->entry_timestamp == 1);

    TimestampedHistory active_operation_session;
    CHECK(active_operation_session.begin_operation("already active", session_before));
    const auto active_operation_bytes_before = active_operation_session.bytes_used();
    const auto active_operation_snapshots_before = active_operation_session.snapshot_count();
    CHECK(!active_operation_session.begin_editing_session());
    CHECK(!active_operation_session.editing_session_status());
    CHECK(!active_operation_session.navigation_floor());
    CHECK(active_operation_session.operation_active());
    CHECK(active_operation_session.bytes_used() == active_operation_bytes_before);
    CHECK(active_operation_session.snapshot_count() == active_operation_snapshots_before);
    CHECK(active_operation_session.abort_operation());
    const auto after_active_operation_session = active_operation_session.begin_editing_session();
    CHECK(after_active_operation_session && after_active_operation_session->id == 1);
    active_operation_session.clear();

    // Classifications and session identity follow the outer transaction even
    // when nested callers request the opposite kind. Each completed command
    // remains independently navigable above the session floor.
    const auto session_paint_one = roots(34, {object(31, 3, 34)}, 4, 14, 24);
    CHECK(editing_session_history.begin_operation("surface A", session_first, TimestampedOperationKind::Paint));
    CHECK(editing_session_history.begin_operation("nested non-paint", session_first,
                                                  TimestampedOperationKind::NonPaint));
    CHECK(editing_session_history.commit_operation(session_paint_one));
    CHECK(editing_session_history.entries().size() == session_entries_before.size());
    session_status_after_abort = editing_session_history.editing_session_status();
    CHECK(session_status_after_abort && !session_status_after_abort->has_effective_commit);
    CHECK(editing_session_history.commit_operation(session_paint_one));
    CHECK(editing_session_history.entries().back().operation_kind == TimestampedOperationKind::Paint);
    CHECK(editing_session_history.entries().back().editing_session_id == editing_session->id);
    session_status_after_abort = editing_session_history.editing_session_status();
    CHECK(session_status_after_abort && session_status_after_abort->has_effective_commit);

    const auto session_config = roots(35, {object(31, 4, 35)}, 5, 15, 25);
    CHECK(editing_session_history.begin_operation("layer height", session_paint_one,
                                                  TimestampedOperationKind::NonPaint));
    CHECK(editing_session_history.begin_operation("nested paint", session_paint_one,
                                                  TimestampedOperationKind::Paint));
    CHECK(editing_session_history.commit_operation(session_config));
    const auto entries_during_nested_nonpaint = editing_session_history.entries().size();
    CHECK(editing_session_history.commit_operation(session_config));
    CHECK(editing_session_history.entries().size() == entries_during_nested_nonpaint + 1);
    CHECK(editing_session_history.entries().back().operation_kind == TimestampedOperationKind::NonPaint);
    CHECK(editing_session_history.entries().back().editing_session_id == editing_session->id);

    const auto session_paint_two = roots(36, {object(31, 5, 36)}, 6, 16, 26);
    CHECK(editing_session_history.begin_operation("surface B", session_config, TimestampedOperationKind::Paint));
    CHECK(editing_session_history.commit_operation(session_paint_two));
    CHECK(editing_session_history.entries().size() == 4);
    CHECK(editing_session_history.entries()[0].operation_kind == TimestampedOperationKind::NonPaint);
    CHECK(editing_session_history.entries()[0].editing_session_id == 0);
    CHECK(editing_session_history.entries()[1].operation_kind == TimestampedOperationKind::Paint);
    CHECK(editing_session_history.entries()[2].operation_kind == TimestampedOperationKind::NonPaint);
    CHECK(editing_session_history.entries()[3].operation_kind == TimestampedOperationKind::Paint);
    for (std::size_t i = 1; i < editing_session_history.entries().size(); ++i)
        CHECK(editing_session_history.entries()[i].editing_session_id == editing_session->id);

    editing_session_history.mark_current_as_saved();
    CHECK(editing_session_history.saved_timestamp() == std::optional<LogicalTimestamp>(5));
    session_status_after_abort = editing_session_history.editing_session_status();
    CHECK(session_status_after_abort && session_status_after_abort->has_effective_commit);
    CHECK(editing_session_history.undo(session_paint_two, restored));
    CHECK(restored.timestamp == 4);
    CHECK(editing_session_history.undo(session_config, restored));
    CHECK(restored.timestamp == 3);
    CHECK(editing_session_history.undo(session_paint_one, restored));
    CHECK(restored.timestamp == editing_session->entry_timestamp);
    CHECK(!editing_session_history.can_undo());
    CHECK(!editing_session_history.restore(0, &session_paint_one, rejected_restore));
    CHECK(editing_session_history.can_redo());
    session_status_after_abort = editing_session_history.editing_session_status();
    CHECK(session_status_after_abort && session_status_after_abort->has_effective_commit);
    CHECK(editing_session_history.redo(restored));
    CHECK(restored.timestamp == 3);
    CHECK(editing_session_history.redo(restored));
    CHECK(restored.timestamp == 4);
    CHECK(editing_session_history.redo(restored));
    CHECK(restored.timestamp == 5);

    // A session containing only a non-paint project commit also sets the
    // lifetime latch, including after Undo returns to the session entry.
    TimestampedHistory nonpaint_only_session;
    const auto nonpaint_before = roots(37, {object(41, 1, 37)});
    const auto nonpaint_after = roots(38, {object(41, 2, 38)}, 0, 0, 38);
    const auto nonpaint_session = nonpaint_only_session.begin_editing_session();
    CHECK(nonpaint_session && !nonpaint_session->has_effective_commit);
    CHECK(nonpaint_only_session.begin_operation("configuration only", nonpaint_before,
                                                TimestampedOperationKind::NonPaint));
    CHECK(nonpaint_only_session.commit_operation(nonpaint_after));
    auto nonpaint_status = nonpaint_only_session.editing_session_status();
    CHECK(nonpaint_status && nonpaint_status->has_effective_commit);
    nonpaint_only_session.mark_current_as_saved();
    CHECK(nonpaint_only_session.undo(nonpaint_after, restored));
    CHECK(restored.timestamp == nonpaint_session->entry_timestamp);
    nonpaint_status = nonpaint_only_session.editing_session_status();
    CHECK(nonpaint_status && nonpaint_status->has_effective_commit);

    editing_session_history.set_byte_budget(1);
    CHECK(editing_session_history.resource_diagnostics().evicted_timestamp_count > 0);
    session_status_after_abort = editing_session_history.editing_session_status();
    CHECK(session_status_after_abort && session_status_after_abort->id == editing_session->id &&
          session_status_after_abort->entry_timestamp == editing_session->entry_timestamp &&
          session_status_after_abort->has_effective_commit);

    // clear() drops the open session and its floor, while retaining the ID
    // sequence so stale identities cannot match a later session on this object.
    const EditingSessionId stale_session_id = editing_session->id;
    editing_session_history.clear();
    CHECK(!editing_session_history.editing_session_status());
    CHECK(!editing_session_history.navigation_floor());
    CHECK(editing_session_history.current_timestamp() == 0);
    CHECK(editing_session_history.entries().empty());
    CHECK(!editing_session_history.saved_timestamp());
    const auto after_clear_session = editing_session_history.begin_editing_session();
    CHECK(after_clear_session && after_clear_session->id == stale_session_id + 1 &&
          !after_clear_session->has_effective_commit);
    editing_session_history.clear();

    CHECK(floor_history.set_navigation_floor(1));
    TimestampedHistory moved_floor(std::move(floor_history));
    CHECK(moved_floor.navigation_floor() == std::optional<LogicalTimestamp>(1));
    TimestampedHistory assigned_floor;
    assigned_floor = std::move(moved_floor);
    CHECK(assigned_floor.navigation_floor() == std::optional<LogicalTimestamp>(1));
    assigned_floor.clear();
    CHECK(!assigned_floor.navigation_floor());

    std::cout << "TimestampedHistory tests passed\n";
    return EXIT_SUCCESS;
}
