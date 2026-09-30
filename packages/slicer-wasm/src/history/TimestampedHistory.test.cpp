#include "TimestampedHistory.hpp"

#include <cstdlib>
#include <iostream>
#include <stdexcept>
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

static bool scene_delta_is_equal(const SceneDelta& lhs, const SceneDelta& rhs)
{
    return lhs.object_ids == rhs.object_ids && lhs.volume_ids == rhs.volume_ids &&
           lhs.instance_ids == rhs.instance_ids && lhs.plate_ids == rhs.plate_ids &&
           lhs.object_order == rhs.object_order;
}

static bool entry_is_equal(const TimestampedEntryInfo& lhs, const TimestampedEntryInfo& rhs)
{
    return lhs.id == rhs.id && lhs.label == rhs.label && lhs.before_timestamp == rhs.before_timestamp &&
           lhs.after_timestamp == rhs.after_timestamp && scene_delta_is_equal(lhs.scene_delta, rhs.scene_delta) &&
           lhs.operation_kind == rhs.operation_kind && lhs.editing_session_id == rhs.editing_session_id;
}

static bool entries_are_equal(const std::vector<TimestampedEntryInfo>& lhs,
                              const std::vector<TimestampedEntryInfo>& rhs)
{
    if (lhs.size() != rhs.size()) return false;
    for (std::size_t index = 0; index < lhs.size(); ++index)
        if (!entry_is_equal(lhs[index], rhs[index])) return false;
    return true;
}

static bool intervals_are_equal(const std::vector<TimestampedObjectVersionInterval>& lhs,
                                const std::vector<TimestampedObjectVersionInterval>& rhs)
{
    if (lhs.size() != rhs.size()) return false;
    for (std::size_t index = 0; index < lhs.size(); ++index) {
        const auto& left = lhs[index];
        const auto& right = rhs[index];
        if (left.id != right.id || left.object_timestamp != right.object_timestamp ||
            left.begin != right.begin || left.end != right.end || left.archive != right.archive)
            return false;
    }
    return true;
}

static bool resource_diagnostics_are_equal(const TimestampedResourceDiagnostics& lhs,
                                           const TimestampedResourceDiagnostics& rhs)
{
    return lhs.bytes_used == rhs.bytes_used && lhs.byte_budget == rhs.byte_budget &&
           lhs.evicted_timestamp_count == rhs.evicted_timestamp_count &&
           lhs.last_evicted_timestamp == rhs.last_evicted_timestamp &&
           lhs.oversized_nearest_history_retained == rhs.oversized_nearest_history_retained;
}

static bool commit_history(TimestampedHistory& history, std::string label,
                           const TimestampedRoots& before, const TimestampedRoots& after,
                           TimestampedOperationKind kind = TimestampedOperationKind::NonPaint)
{
    return history.begin_operation(std::move(label), before, kind) && history.commit_operation(after);
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

    // Continuous paint runs compact around a retained non-paint separator.
    // The unrelated project entry predates the session and keeps its identity.
    TimestampedHistory compacted_runs;
    const auto run_initial = roots(1, {object(10, 1, 10), object(20, 1, 20)}, 10, 20, 30);
    const auto run_before_session = roots(2, {object(10, 2, 11), object(20, 1, 20)}, 11, 21, 31);
    CHECK(compacted_runs.begin_operation("older project edit", run_initial));
    CHECK(compacted_runs.commit_operation(run_before_session));
    const auto older_entry = compacted_runs.entries().back();
    const auto compact_session = compacted_runs.begin_editing_session();
    CHECK(compact_session && compact_session->entry_timestamp == older_entry.after_timestamp);

    const auto paint_a = roots(3, {object(10, 3, 12), object(20, 1, 20)}, 12, 22, 32);
    const auto paint_b = roots(4, {object(10, 3, 12), object(20, 2, 22)}, 13, 23, 33);
    const auto config_edit = roots(5, {object(10, 3, 12), object(20, 2, 22)}, 13, 24, 34);
    const auto paint_c = roots(6, {object(10, 4, 14), object(20, 2, 22)}, 14, 25, 35);
    const auto paint_d = roots(7, {object(10, 4, 14), object(20, 3, 25)}, 15, 26, 36);
    CHECK(compacted_runs.begin_operation("stroke A", run_before_session, TimestampedOperationKind::Paint));
    CHECK(compacted_runs.commit_operation(paint_a));
    CHECK(compacted_runs.begin_operation("stroke B", paint_a, TimestampedOperationKind::Paint));
    CHECK(compacted_runs.commit_operation(paint_b));
    CHECK(compacted_runs.begin_operation("layer height", paint_b, TimestampedOperationKind::NonPaint));
    CHECK(compacted_runs.commit_operation(config_edit));
    CHECK(compacted_runs.begin_operation("stroke C", config_edit, TimestampedOperationKind::Paint));
    CHECK(compacted_runs.commit_operation(paint_c));
    CHECK(compacted_runs.begin_operation("stroke D", paint_c, TimestampedOperationKind::Paint));
    CHECK(compacted_runs.commit_operation(paint_d));
    const auto ungrouped_entries = compacted_runs.entries();
    const auto ungrouped_snapshots = compacted_runs.snapshot_count();
    const auto ungrouped_bytes = compacted_runs.bytes_used();
    CHECK(ungrouped_entries.size() == 6);
    CHECK(compacted_runs.compact_editing_session(compact_session->id, "Grouped surface paint"));
    CHECK(compacted_runs.entries().size() == 4);
    CHECK(compacted_runs.snapshot_count() + 2 == ungrouped_snapshots);
    CHECK(compacted_runs.bytes_used() < ungrouped_bytes);
    CHECK(entry_is_equal(compacted_runs.entries()[0], older_entry));
    CHECK(compacted_runs.entries()[1].id == ungrouped_entries[1].id);
    CHECK(compacted_runs.entries()[1].label == "Grouped surface paint");
    CHECK(compacted_runs.entries()[1].before_timestamp == ungrouped_entries[1].before_timestamp);
    CHECK(compacted_runs.entries()[1].after_timestamp == ungrouped_entries[2].after_timestamp);
    CHECK(compacted_runs.entries()[1].operation_kind == TimestampedOperationKind::Paint);
    CHECK(compacted_runs.entries()[1].editing_session_id == compact_session->id);
    CHECK(compacted_runs.entries()[1].scene_delta.object_ids == std::vector<ObjectID>({10, 20}));
    CHECK(compacted_runs.entries()[1].scene_delta.volume_ids == std::vector<ObjectID>({1010, 1020}));
    CHECK(compacted_runs.entries()[1].scene_delta.instance_ids == std::vector<ObjectID>({2010, 2020}));
    CHECK(compacted_runs.entries()[1].scene_delta.plate_ids ==
          std::vector<std::string>({"plate-11", "plate-12", "plate-13"}));
    CHECK(entry_is_equal(compacted_runs.entries()[2], ungrouped_entries[3]));
    CHECK(compacted_runs.entries()[3].id == ungrouped_entries[4].id);
    CHECK(compacted_runs.entries()[3].label == "Grouped surface paint");
    CHECK(compacted_runs.entries()[3].before_timestamp == ungrouped_entries[4].before_timestamp);
    CHECK(compacted_runs.entries()[3].after_timestamp == ungrouped_entries[5].after_timestamp);
    CHECK(compacted_runs.entries()[3].scene_delta.object_ids == std::vector<ObjectID>({10, 20}));
    CHECK(compacted_runs.entries()[3].scene_delta.volume_ids == std::vector<ObjectID>({1010, 1020}));
    CHECK(compacted_runs.entries()[3].scene_delta.instance_ids == std::vector<ObjectID>({2010, 2020}));
    CHECK(compacted_runs.entries()[3].scene_delta.plate_ids ==
          std::vector<std::string>({"plate-13", "plate-14", "plate-15"}));
    auto compact_status = compacted_runs.editing_session_status();
    CHECK(compact_status && compact_status->id == compact_session->id && compact_status->has_effective_commit);
    CHECK(compacted_runs.navigation_floor() == std::optional<LogicalTimestamp>(compact_session->entry_timestamp));
    CHECK(compacted_runs.current_timestamp() == ungrouped_entries.back().after_timestamp);

    TimestampedRestore compact_restore;
    CHECK(compacted_runs.restore_before(compacted_runs.entries()[1].id, &paint_d, compact_restore));
    CHECK(compact_restore.timestamp == compact_session->entry_timestamp);
    CHECK(compact_restore.roots.model.serialized == bytes(2));
    CHECK(object_is(compact_restore, 0, 10, 2, 11));
    CHECK(object_is(compact_restore, 1, 20, 1, 20));
    CHECK(compact_restore.roots.session.plate_session == bytes(11));
    CHECK(compact_restore.roots.project_config == bytes(31));
    CHECK(compacted_runs.restore_after(compacted_runs.entries()[1].id, &run_before_session, compact_restore));
    CHECK(compact_restore.timestamp == ungrouped_entries[2].after_timestamp);
    CHECK(compact_restore.roots.model.serialized == bytes(4));
    CHECK(object_is(compact_restore, 0, 10, 3, 12));
    CHECK(object_is(compact_restore, 1, 20, 2, 22));
    CHECK(compacted_runs.restore_after(compacted_runs.entries()[2].id, &paint_b, compact_restore));
    CHECK(compact_restore.roots.model.serialized == bytes(5));
    CHECK(compact_restore.roots.project_config == bytes(34));
    CHECK(compacted_runs.restore_after(compacted_runs.entries()[3].id, &config_edit, compact_restore));
    CHECK(compact_restore.timestamp == ungrouped_entries.back().after_timestamp);
    CHECK(compact_restore.roots.model.serialized == bytes(7));
    CHECK(object_is(compact_restore, 0, 10, 4, 14));
    CHECK(object_is(compact_restore, 1, 20, 3, 25));
    CHECK(compacted_runs.navigation_floor() == std::optional<LogicalTimestamp>(compact_session->entry_timestamp));
    compacted_runs.clear();

    // The cursor caps compaction at the applied prefix. Redo-side entry C and
    // its endpoint remain available, while B's removed ID and timestamp do not.
    TimestampedHistory cursor_compaction;
    const auto cursor_0 = roots(20, {object(30, 1, 20)});
    const auto cursor_a = roots(21, {object(30, 2, 21)});
    const auto cursor_b = roots(22, {object(30, 3, 22)});
    const auto cursor_c = roots(23, {object(30, 4, 23)});
    const auto cursor_session = cursor_compaction.begin_editing_session();
    CHECK(cursor_session);
    CHECK(cursor_compaction.begin_operation("stroke A", cursor_0, TimestampedOperationKind::Paint));
    CHECK(cursor_compaction.commit_operation(cursor_a));
    CHECK(cursor_compaction.begin_operation("stroke B", cursor_a, TimestampedOperationKind::Paint));
    CHECK(cursor_compaction.commit_operation(cursor_b));
    CHECK(cursor_compaction.begin_operation("stroke C", cursor_b, TimestampedOperationKind::Paint));
    CHECK(cursor_compaction.commit_operation(cursor_c));
    const auto removed_b_id = cursor_compaction.entries()[1].id;
    const auto redo_c = cursor_compaction.entries()[2];
    CHECK(cursor_compaction.undo(cursor_c, compact_restore));
    CHECK(compact_restore.timestamp == 2);
    const auto cursor_before = cursor_compaction.current_timestamp();
    const auto cursor_floor = cursor_compaction.navigation_floor();
    auto cursor_status = cursor_compaction.editing_session_status();
    CHECK(cursor_status && cursor_status->has_effective_commit);
    CHECK(cursor_compaction.compact_editing_session(cursor_session->id));
    CHECK(cursor_compaction.entries().size() == 2);
    CHECK(cursor_compaction.entries()[0].id == 1);
    CHECK(cursor_compaction.entries()[0].label == "Paint");
    CHECK(cursor_compaction.entries()[0].before_timestamp == 0);
    CHECK(cursor_compaction.entries()[0].after_timestamp == cursor_before);
    CHECK(entry_is_equal(cursor_compaction.entries()[1], redo_c));
    CHECK(cursor_compaction.current_timestamp() == cursor_before);
    CHECK(cursor_compaction.navigation_floor() == cursor_floor);
    cursor_status = cursor_compaction.editing_session_status();
    CHECK(cursor_status && cursor_status->id == cursor_session->id && cursor_status->has_effective_commit);
    CHECK(cursor_compaction.can_redo());
    TimestampedRestore rejected_compact_restore {
        77, roots(77, {object(77, 77, 77)}, 77, 77, 77), SceneDelta{{77}, {}, {}, {}, {77}}};
    CHECK(!cursor_compaction.restore_before(removed_b_id, &cursor_b, rejected_compact_restore));
    CHECK(is_navigation_sentinel(rejected_compact_restore));
    CHECK(!cursor_compaction.restore_after(removed_b_id, &cursor_b, rejected_compact_restore));
    CHECK(is_navigation_sentinel(rejected_compact_restore));
    CHECK(!cursor_compaction.restore(1, &cursor_b, rejected_compact_restore));
    CHECK(is_navigation_sentinel(rejected_compact_restore));
    CHECK(cursor_compaction.current_timestamp() == cursor_before);
    CHECK(cursor_compaction.redo(compact_restore));
    CHECK(compact_restore.timestamp == 3);
    CHECK(compact_restore.roots.model.serialized == bytes(23));
    CHECK(object_is(compact_restore, 0, 30, 4, 23));
    cursor_compaction.clear();

    // A removed interior saved checkpoint becomes conservatively unknown;
    // a saved endpoint keeps its original timestamp and clean state.
    TimestampedHistory saved_inside_history;
    const auto saved_session = saved_inside_history.begin_editing_session();
    const auto saved_0 = roots(30, {object(40, 1, 30)});
    const auto saved_1 = roots(31, {object(40, 2, 31)});
    const auto saved_2 = roots(32, {object(40, 3, 32)});
    CHECK(saved_session);
    CHECK(saved_inside_history.begin_operation("stroke A", saved_0, TimestampedOperationKind::Paint));
    CHECK(saved_inside_history.commit_operation(saved_1));
    saved_inside_history.mark_current_as_saved();
    CHECK(saved_inside_history.begin_operation("stroke B", saved_1, TimestampedOperationKind::Paint));
    CHECK(saved_inside_history.commit_operation(saved_2));
    CHECK(saved_inside_history.compact_editing_session(saved_session->id));
    CHECK(!saved_inside_history.saved_timestamp());
    CHECK(saved_inside_history.saved_checkpoint_evicted());
    CHECK(saved_inside_history.project_modified());

    TimestampedHistory saved_endpoint_history;
    const auto saved_endpoint_session = saved_endpoint_history.begin_editing_session();
    CHECK(saved_endpoint_session);
    CHECK(saved_endpoint_history.begin_operation("stroke A", saved_0, TimestampedOperationKind::Paint));
    CHECK(saved_endpoint_history.commit_operation(saved_1));
    CHECK(saved_endpoint_history.begin_operation("stroke B", saved_1, TimestampedOperationKind::Paint));
    CHECK(saved_endpoint_history.commit_operation(saved_2));
    saved_endpoint_history.mark_current_as_saved();
    const auto saved_endpoint = saved_endpoint_history.saved_timestamp();
    CHECK(saved_endpoint == std::optional<LogicalTimestamp>(2));
    CHECK(saved_endpoint_history.compact_editing_session(saved_endpoint_session->id));
    CHECK(saved_endpoint_history.saved_timestamp() == saved_endpoint);
    CHECK(!saved_endpoint_history.saved_checkpoint_evicted());
    CHECK(!saved_endpoint_history.project_modified());

    // A session with no paint and a singleton paint are successful no-ops.
    TimestampedHistory no_paint_compaction;
    const auto no_paint_session = no_paint_compaction.begin_editing_session();
    CHECK(no_paint_session);
    const auto no_paint_bytes = no_paint_compaction.bytes_used();
    const auto no_paint_snapshots = no_paint_compaction.snapshot_count();
    CHECK(no_paint_compaction.compact_editing_session(no_paint_session->id));
    CHECK(no_paint_compaction.entries().empty());
    CHECK(no_paint_compaction.bytes_used() == no_paint_bytes);
    CHECK(no_paint_compaction.snapshot_count() == no_paint_snapshots);

    TimestampedHistory singleton_compaction;
    const auto singleton_session = singleton_compaction.begin_editing_session();
    const auto singleton_0 = roots(40, {object(50, 1, 40)});
    const auto singleton_1 = roots(41, {object(50, 2, 41)});
    CHECK(singleton_session);
    CHECK(singleton_compaction.begin_operation("only stroke", singleton_0, TimestampedOperationKind::Paint));
    CHECK(singleton_compaction.commit_operation(singleton_1));
    const auto singleton_entry = singleton_compaction.entries().front();
    const auto singleton_bytes = singleton_compaction.bytes_used();
    const auto singleton_snapshots = singleton_compaction.snapshot_count();
    CHECK(singleton_compaction.compact_editing_session(singleton_session->id));
    CHECK(singleton_compaction.entries().size() == 1);
    CHECK(entry_is_equal(singleton_compaction.entries().front(), singleton_entry));
    CHECK(singleton_compaction.bytes_used() == singleton_bytes);
    CHECK(singleton_compaction.snapshot_count() == singleton_snapshots);

    // Invalid IDs and an active operation reject compaction without side effects.
    TimestampedHistory rejected_compaction;
    const auto rejected_session = rejected_compaction.begin_editing_session();
    CHECK(rejected_session);
    TimestampedHistory no_session_compaction;
    const auto no_session_bytes = no_session_compaction.bytes_used();
    CHECK(!no_session_compaction.compact_editing_session(1));
    CHECK(no_session_compaction.bytes_used() == no_session_bytes);
    const auto stale_entries = rejected_compaction.entries();
    const auto stale_bytes = rejected_compaction.bytes_used();
    const auto stale_snapshots = rejected_compaction.snapshot_count();
    const auto stale_current = rejected_compaction.current_timestamp();
    const auto stale_floor = rejected_compaction.navigation_floor();
    CHECK(!rejected_compaction.compact_editing_session(rejected_session->id + 1));
    CHECK(entries_are_equal(rejected_compaction.entries(), stale_entries));
    CHECK(rejected_compaction.bytes_used() == stale_bytes);
    CHECK(rejected_compaction.snapshot_count() == stale_snapshots);
    CHECK(rejected_compaction.current_timestamp() == stale_current);
    CHECK(rejected_compaction.navigation_floor() == stale_floor);
    const auto active_predecessor = roots(50, {object(60, 1, 50)});
    CHECK(rejected_compaction.begin_operation("pending stroke", active_predecessor, TimestampedOperationKind::Paint));
    const auto active_entries = rejected_compaction.entries();
    const auto active_bytes = rejected_compaction.bytes_used();
    const auto active_snapshots = rejected_compaction.snapshot_count();
    const auto active_current = rejected_compaction.current_timestamp();
    const auto active_session_floor = rejected_compaction.navigation_floor();
    CHECK(!rejected_compaction.compact_editing_session(rejected_session->id));
    CHECK(rejected_compaction.operation_active());
    CHECK(entries_are_equal(rejected_compaction.entries(), active_entries));
    CHECK(rejected_compaction.bytes_used() == active_bytes);
    CHECK(rejected_compaction.snapshot_count() == active_snapshots);
    CHECK(rejected_compaction.current_timestamp() == active_current);
    CHECK(rejected_compaction.navigation_floor() == active_session_floor);
    CHECK(rejected_compaction.editing_session_status()->id == rejected_session->id);
    CHECK(rejected_compaction.abort_operation());

    // After budget eviction only the retained adjacent suffix may compact;
    // the evicted first stroke and its floor snapshot never return.
    TimestampedHistory evicted_compaction;
    const auto evicted_session = evicted_compaction.begin_editing_session();
    const auto evicted_0 = roots(60, {object(70, 1, 60)});
    const auto evicted_1 = roots(61, {object(70, 2, 61)});
    const auto evicted_2 = roots(62, {object(70, 3, 62)});
    const auto evicted_3 = roots(63, {object(70, 4, 63)});
    const auto evicted_4 = roots(64, {object(70, 5, 64)});
    CHECK(evicted_session);
    CHECK(evicted_compaction.begin_operation("evicted A", evicted_0, TimestampedOperationKind::Paint));
    CHECK(evicted_compaction.commit_operation(evicted_1));
    const auto evicted_a_id = evicted_compaction.entries().back().id;
    CHECK(evicted_compaction.begin_operation("retained B", evicted_1, TimestampedOperationKind::Paint));
    CHECK(evicted_compaction.commit_operation(evicted_2));
    CHECK(evicted_compaction.begin_operation("retained C", evicted_2, TimestampedOperationKind::Paint));
    CHECK(evicted_compaction.commit_operation(evicted_3));
    CHECK(evicted_compaction.begin_operation("retained D", evicted_3, TimestampedOperationKind::Paint));
    CHECK(evicted_compaction.commit_operation(evicted_4));
    const auto evicted_b_id = evicted_compaction.entries()[1].id;
    evicted_compaction.set_byte_budget(evicted_compaction.bytes_used() - 1);
    CHECK(evicted_compaction.resource_diagnostics().evicted_timestamp_count > 0);
    CHECK(evicted_compaction.entries().size() == 3);
    CHECK(evicted_compaction.entries().front().id == evicted_b_id);
    const auto floor_before_eviction_compact = evicted_compaction.navigation_floor();
    const auto evicted_status_before = evicted_compaction.editing_session_status();
    CHECK(evicted_status_before && evicted_status_before->has_effective_commit);
    CHECK(evicted_compaction.compact_editing_session(evicted_session->id));
    CHECK(evicted_compaction.entries().size() == 1);
    CHECK(evicted_compaction.entries().front().id == evicted_b_id);
    CHECK(evicted_compaction.entries().front().before_timestamp == 1);
    CHECK(evicted_compaction.entries().front().after_timestamp == 4);
    CHECK(evicted_compaction.navigation_floor() == floor_before_eviction_compact);
    CHECK(evicted_compaction.current_timestamp() == 4);
    const auto evicted_status_after = evicted_compaction.editing_session_status();
    CHECK(evicted_status_after && evicted_status_after->id == evicted_session->id &&
          evicted_status_after->has_effective_commit);
    CHECK(!evicted_compaction.restore_before(evicted_a_id, &evicted_4, rejected_compact_restore));
    CHECK(is_navigation_sentinel(rejected_compact_restore));
    CHECK(!evicted_compaction.restore(0, &evicted_4, rejected_compact_restore));
    CHECK(is_navigation_sentinel(rejected_compact_restore));
    CHECK(evicted_compaction.current_timestamp() == 4);
    evicted_compaction.clear();

    // Entry metadata and capacity are budgeted. A large run of tiny strokes
    // releases the removed canonical entry slots after compaction.
    TimestampedHistory compacted_many;
    const auto many_session = compacted_many.begin_editing_session();
    CHECK(many_session);
    auto many_previous = roots(80, {object(80, 1, 80)});
    constexpr std::size_t kManyStrokes = 40;
    for (std::size_t index = 0; index < kManyStrokes; ++index) {
        const auto next = roots(static_cast<std::uint8_t>(81 + index),
                                {object(80, index + 2, static_cast<std::uint8_t>(81 + index))});
        CHECK(compacted_many.begin_operation("tiny stroke", many_previous, TimestampedOperationKind::Paint));
        CHECK(compacted_many.commit_operation(next));
        many_previous = next;
    }
    const auto many_bytes_before = compacted_many.bytes_used();
    const auto many_entry_capacity_before = compacted_many.entries().capacity();
    CHECK(compacted_many.entries().size() == kManyStrokes);
    CHECK(compacted_many.compact_editing_session(many_session->id));
    CHECK(compacted_many.entries().size() == 1);
    CHECK(compacted_many.entries().capacity() * 2 < many_entry_capacity_before);
    CHECK(many_bytes_before >= compacted_many.bytes_used() + (kManyStrokes - 1) * std::size_t(192));

    // Closing a session compacts each applied paint run around non-paint
    // separators, preserves the current roots and save point, and removes child
    // identities and intermediate timestamps.
    TimestampedHistory top_close;
    const auto close_before_session = roots(100, {object(10, 1, 10), object(20, 1, 20)}, 1, 1, 1);
    const auto close_session_entry = roots(101, {object(10, 2, 11), object(20, 1, 20)}, 1, 1, 2);
    CHECK(commit_history(top_close, "before painting", close_before_session, close_session_entry));
    const auto top_session = top_close.begin_editing_session();
    CHECK(top_session && top_session->entry_timestamp == 1);
    const auto close_a = roots(102, {object(10, 3, 12), object(20, 1, 20)}, 1, 2, 2);
    const auto close_b = roots(103, {object(10, 3, 12), object(20, 2, 21)}, 1, 2, 2);
    const auto close_config = roots(104, {object(10, 3, 12), object(20, 2, 21)}, 1, 2, 3);
    const auto close_c = roots(105, {object(10, 4, 13), object(20, 2, 21)}, 1, 2, 3);
    const auto close_d = roots(106, {object(10, 4, 13), object(20, 3, 22)}, 1, 2, 3);
    CHECK(commit_history(top_close, "stroke A", close_session_entry, close_a, TimestampedOperationKind::Paint));
    CHECK(commit_history(top_close, "stroke B", close_a, close_b, TimestampedOperationKind::Paint));
    CHECK(commit_history(top_close, "configuration", close_b, close_config));
    CHECK(commit_history(top_close, "stroke C", close_config, close_c, TimestampedOperationKind::Paint));
    CHECK(commit_history(top_close, "stroke D", close_c, close_d, TimestampedOperationKind::Paint));
    const auto top_entries_before_close = top_close.entries();
    const auto top_removed_b_id = top_entries_before_close[2].id;
    const auto removed_d_id = top_entries_before_close[5].id;
    CHECK(top_entries_before_close[1].after_timestamp == 2 && top_entries_before_close[4].after_timestamp == 5);
    top_close.mark_current_as_saved();
    CHECK(top_close.close_editing_session(top_session->id));
    CHECK(!top_close.editing_session_status());
    CHECK(!top_close.navigation_floor());
    CHECK(top_close.current_timestamp() == 6);
    CHECK(top_close.entries().size() == 4);
    CHECK(entry_is_equal(top_close.entries()[0], top_entries_before_close[0]));
    CHECK(top_close.entries()[1].id == top_entries_before_close[1].id);
    CHECK(top_close.entries()[1].label == "Paint");
    CHECK(top_close.entries()[1].before_timestamp == 1 && top_close.entries()[1].after_timestamp == 3);
    CHECK(top_close.entries()[1].operation_kind == TimestampedOperationKind::Paint);
    CHECK(top_close.entries()[1].editing_session_id == top_session->id);
    CHECK(top_close.entries()[1].scene_delta.object_ids == std::vector<ObjectID>({10, 20}));
    CHECK(entry_is_equal(top_close.entries()[2], top_entries_before_close[3]));
    CHECK(top_close.entries()[3].id == top_entries_before_close[4].id);
    CHECK(top_close.entries()[3].label == "Paint");
    CHECK(top_close.entries()[3].before_timestamp == 4 && top_close.entries()[3].after_timestamp == 6);
    CHECK(top_close.entries()[3].operation_kind == TimestampedOperationKind::Paint);
    CHECK(top_close.entries()[3].editing_session_id == top_session->id);
    CHECK(top_close.entries()[3].scene_delta.object_ids == std::vector<ObjectID>({10, 20}));
    CHECK(!top_close.can_redo() && top_close.can_undo());
    CHECK(top_close.saved_timestamp() == std::optional<LogicalTimestamp>(6));
    CHECK(!top_close.saved_checkpoint_evicted() && !top_close.project_modified());
    TimestampedRestore close_restore;
    CHECK(top_close.restore_before(top_close.entries()[1].id, &close_d, close_restore));
    CHECK(close_restore.timestamp == 1);
    CHECK(close_restore.roots.model.serialized == close_session_entry.model.serialized);
    CHECK(object_is(close_restore, 0, 10, 2, 11) && object_is(close_restore, 1, 20, 1, 20));
    CHECK(close_restore.roots.project_config == close_session_entry.project_config);
    CHECK(top_close.restore_after(top_close.entries()[1].id, nullptr, close_restore));
    CHECK(close_restore.timestamp == 3);
    CHECK(close_restore.roots.model.serialized == close_b.model.serialized);
    CHECK(object_is(close_restore, 0, 10, 3, 12) && object_is(close_restore, 1, 20, 2, 21));
    CHECK(top_close.restore_after(top_close.entries()[2].id, nullptr, close_restore));
    CHECK(close_restore.timestamp == 4);
    CHECK(close_restore.roots.project_config == close_config.project_config);
    CHECK(top_close.restore_after(top_close.entries()[3].id, nullptr, close_restore));
    CHECK(close_restore.timestamp == 6);
    CHECK(close_restore.roots.model.serialized == close_d.model.serialized);
    CHECK(object_is(close_restore, 0, 10, 4, 13) && object_is(close_restore, 1, 20, 3, 22));
    CHECK(top_close.current_timestamp() == 6);
    CHECK(!top_close.restore_before(top_removed_b_id, &close_d, close_restore));
    CHECK(!top_close.restore_after(top_removed_b_id, &close_d, close_restore));
    CHECK(!top_close.restore_before(removed_d_id, &close_d, close_restore));
    CHECK(!top_close.restore_after(removed_d_id, &close_d, close_restore));
    CHECK(!top_close.restore(2, nullptr, close_restore));
    CHECK(!top_close.restore(5, nullptr, close_restore));
    CHECK(top_close.current_timestamp() == 6 && !top_close.can_redo());
    const auto fresh_session = top_close.begin_editing_session();
    CHECK(fresh_session && fresh_session->id != top_session->id);
    const auto fresh_floor = top_close.navigation_floor();
    CHECK(!top_close.close_editing_session(top_session->id));
    CHECK(top_close.editing_session_status()->id == fresh_session->id);
    CHECK(top_close.navigation_floor() == fresh_floor);
    CHECK(top_close.close_editing_session(fresh_session->id));

    // A committed session that has been fully undone still discards its Redo
    // branch and invalidates a saved checkpoint stored on that branch. Clearing
    // the floor makes the pre-session operation undoable again.
    TimestampedHistory undo_close;
    const auto undo_before = roots(110, {object(30, 1, 30)});
    const auto undo_entry_root = roots(111, {object(30, 2, 31)});
    const auto undo_a = roots(112, {object(30, 3, 32)});
    const auto undo_b = roots(113, {object(30, 4, 33)});
    CHECK(commit_history(undo_close, "before paint", undo_before, undo_entry_root));
    const auto undo_session = undo_close.begin_editing_session();
    CHECK(undo_session);
    CHECK(commit_history(undo_close, "undo-close A", undo_entry_root, undo_a, TimestampedOperationKind::Paint));
    CHECK(commit_history(undo_close, "undo-close B", undo_a, undo_b, TimestampedOperationKind::Paint));
    const auto undo_a_id = undo_close.entries()[1].id;
    const auto undo_b_id = undo_close.entries()[2].id;
    undo_close.mark_current_as_saved();
    CHECK(undo_close.undo(undo_b, close_restore) && close_restore.timestamp == 2);
    CHECK(undo_close.undo(undo_a, close_restore) && close_restore.timestamp == 1);
    CHECK(undo_close.editing_session_status()->has_effective_commit);
    CHECK(undo_close.can_redo() && undo_close.saved_timestamp() == std::optional<LogicalTimestamp>(3));
    const auto undo_close_bytes_before_close = undo_close.bytes_used();
    const auto undo_close_capacity_before_close = undo_close.entries().capacity();
    CHECK(undo_close.close_editing_session(undo_session->id));
    CHECK(undo_close.current_timestamp() == 1);
    CHECK(!undo_close.navigation_floor() && !undo_close.editing_session_status());
    CHECK(undo_close.entries().size() == 1 && undo_close.entries()[0].id == 1);
    CHECK(!undo_close.can_redo() && undo_close.can_undo());
    CHECK(undo_close.entries().capacity() * 2 < undo_close_capacity_before_close);
    CHECK(undo_close_bytes_before_close >= undo_close.bytes_used() + 2 * std::size_t(192));
    CHECK(!undo_close.saved_timestamp() && undo_close.saved_checkpoint_evicted() && undo_close.project_modified());
    CHECK(!undo_close.restore_before(undo_a_id, &undo_entry_root, close_restore));
    CHECK(!undo_close.restore_after(undo_b_id, &undo_entry_root, close_restore));
    CHECK(!undo_close.restore(2, nullptr, close_restore));
    CHECK(!undo_close.restore(3, nullptr, close_restore));
    CHECK(undo_close.undo(undo_entry_root, close_restore));
    CHECK(close_restore.timestamp == 0 && close_restore.roots.model.serialized == undo_before.model.serialized);
    CHECK(!undo_close.can_undo() && undo_close.can_redo());
    CHECK(undo_close.redo(close_restore));
    CHECK(close_restore.timestamp == 1 && close_restore.roots.model.serialized == undo_entry_root.model.serialized);

    // At a mixed-history cursor, close compacts only the applied prefix,
    // preserves its non-paint separator, and drops all Redo children.
    TimestampedHistory midcursor_close;
    const auto mid_0 = roots(120, {object(40, 1, 40), object(50, 1, 50)});
    const auto mid_a = roots(121, {object(40, 2, 41), object(50, 1, 50)});
    const auto mid_b = roots(122, {object(40, 2, 41), object(50, 2, 51)});
    const auto mid_config = roots(123, {object(40, 2, 41), object(50, 2, 51)}, 0, 0, 1);
    const auto mid_c = roots(124, {object(40, 3, 42), object(50, 2, 51)}, 0, 0, 1);
    const auto mid_d = roots(125, {object(40, 3, 42), object(50, 3, 52)}, 0, 0, 1);
    const auto mid_session = midcursor_close.begin_editing_session();
    CHECK(mid_session);
    CHECK(commit_history(midcursor_close, "mid A", mid_0, mid_a, TimestampedOperationKind::Paint));
    CHECK(commit_history(midcursor_close, "mid B", mid_a, mid_b, TimestampedOperationKind::Paint));
    CHECK(commit_history(midcursor_close, "mid configuration", mid_b, mid_config));
    CHECK(commit_history(midcursor_close, "mid C", mid_config, mid_c, TimestampedOperationKind::Paint));
    CHECK(commit_history(midcursor_close, "mid D", mid_c, mid_d, TimestampedOperationKind::Paint));
    const auto mid_entries_before_close = midcursor_close.entries();
    CHECK(midcursor_close.undo(mid_d, close_restore) && close_restore.timestamp == 4);
    CHECK(midcursor_close.undo(mid_c, close_restore) && close_restore.timestamp == 3);
    CHECK(midcursor_close.can_redo() && midcursor_close.navigation_floor() == std::optional<LogicalTimestamp>(0));
    CHECK(midcursor_close.close_editing_session(mid_session->id));
    CHECK(midcursor_close.current_timestamp() == 3);
    CHECK(midcursor_close.entries().size() == 2);
    CHECK(midcursor_close.entries()[0].id == mid_entries_before_close[0].id);
    CHECK(midcursor_close.entries()[0].before_timestamp == 0 && midcursor_close.entries()[0].after_timestamp == 2);
    CHECK(midcursor_close.entries()[0].label == "Paint");
    CHECK(midcursor_close.entries()[0].scene_delta.object_ids == std::vector<ObjectID>({40, 50}));
    CHECK(entry_is_equal(midcursor_close.entries()[1], mid_entries_before_close[2]));
    CHECK(!midcursor_close.navigation_floor() && !midcursor_close.editing_session_status());
    CHECK(!midcursor_close.can_redo() && midcursor_close.can_undo());
    CHECK(midcursor_close.restore_after(midcursor_close.entries()[1].id, nullptr, close_restore));
    CHECK(close_restore.timestamp == 3 && close_restore.roots.model.serialized == mid_config.model.serialized);
    CHECK(close_restore.roots.project_config == mid_config.project_config);
    CHECK(!midcursor_close.restore_before(mid_entries_before_close[3].id, &mid_config, close_restore));
    CHECK(!midcursor_close.restore_after(mid_entries_before_close[4].id, &mid_config, close_restore));
    CHECK(!midcursor_close.restore(4, nullptr, close_restore));
    CHECK(!midcursor_close.restore(5, nullptr, close_restore));

    // A non-paint commit sets the same lifetime latch and clears Redo even
    // after Undo returns to the session entry.
    TimestampedHistory nonpaint_close;
    const auto nonpaint_close_before = roots(130, {object(60, 1, 60)});
    const auto nonpaint_close_after = roots(131, {object(60, 2, 61)}, 0, 0, 1);
    const auto nonpaint_close_session = nonpaint_close.begin_editing_session();
    CHECK(nonpaint_close_session);
    CHECK(commit_history(nonpaint_close, "project configuration", nonpaint_close_before, nonpaint_close_after));
    CHECK(nonpaint_close.entries().size() == 1);
    CHECK(nonpaint_close.entries()[0].operation_kind == TimestampedOperationKind::NonPaint);
    CHECK(nonpaint_close.undo(nonpaint_close_after, close_restore) && close_restore.timestamp == 0);
    CHECK(nonpaint_close.editing_session_status()->has_effective_commit && nonpaint_close.can_redo());
    CHECK(nonpaint_close.close_editing_session(nonpaint_close_session->id));
    CHECK(nonpaint_close.entries().empty());
    CHECK(nonpaint_close.current_timestamp() == 0 && !nonpaint_close.can_redo());
    CHECK(!nonpaint_close.navigation_floor() && !nonpaint_close.editing_session_status());
    CHECK(!nonpaint_close.restore(1, nullptr, close_restore));

    // A session with no effective commit leaves an existing Redo branch and its
    // saved checkpoint intact, including after an aborted no-effect operation.
    TimestampedHistory no_effect_close;
    const auto no_effect_0 = roots(140, {object(70, 1, 70)});
    const auto no_effect_1 = roots(141, {object(70, 2, 71)});
    const auto no_effect_2 = roots(142, {object(70, 3, 72)});
    CHECK(commit_history(no_effect_close, "no-effect base", no_effect_0, no_effect_1));
    CHECK(commit_history(no_effect_close, "existing redo", no_effect_1, no_effect_2));
    const auto no_effect_redo_entry = no_effect_close.entries().back();
    no_effect_close.mark_current_as_saved();
    CHECK(no_effect_close.undo(no_effect_2, close_restore) && close_restore.timestamp == 1);
    const auto no_effect_session = no_effect_close.begin_editing_session();
    CHECK(no_effect_session && !no_effect_session->has_effective_commit);
    CHECK(no_effect_close.begin_operation("aborted no-effect edit", no_effect_1));
    CHECK(no_effect_close.abort_operation());
    CHECK(!no_effect_close.editing_session_status()->has_effective_commit);
    const auto no_effect_entries = no_effect_close.entries();
    const auto no_effect_snapshots = no_effect_close.snapshot_count();
    CHECK(no_effect_close.can_redo());
    CHECK(no_effect_close.close_editing_session(no_effect_session->id));
    CHECK(entries_are_equal(no_effect_close.entries(), no_effect_entries));
    CHECK(entry_is_equal(no_effect_close.entries().back(), no_effect_redo_entry));
    CHECK(no_effect_close.current_timestamp() == 1 && no_effect_close.snapshot_count() == no_effect_snapshots);
    CHECK(!no_effect_close.navigation_floor() && !no_effect_close.editing_session_status());
    CHECK(no_effect_close.can_redo());
    CHECK(no_effect_close.saved_timestamp() == std::optional<LogicalTimestamp>(2));
    CHECK(!no_effect_close.saved_checkpoint_evicted() && no_effect_close.project_modified());
    CHECK(no_effect_close.redo(close_restore));
    CHECK(close_restore.timestamp == 2 && close_restore.roots.model.serialized == no_effect_2.model.serialized);
    CHECK(!no_effect_close.project_modified());

    // Closing after oldest-first eviction compacts only what remains and never
    // recreates the evicted stroke's entry or timestamp.
    TimestampedHistory evicted_close;
    const auto evicted_close_session = evicted_close.begin_editing_session();
    const auto evicted_close_0 = roots(150, {object(80, 1, 80)});
    const auto evicted_close_1 = roots(151, {object(80, 2, 81)});
    const auto evicted_close_2 = roots(152, {object(80, 3, 82)});
    const auto evicted_close_3 = roots(153, {object(80, 4, 83)});
    const auto evicted_close_4 = roots(154, {object(80, 5, 84)});
    CHECK(evicted_close_session);
    CHECK(commit_history(evicted_close, "evicted A", evicted_close_0, evicted_close_1,
                         TimestampedOperationKind::Paint));
    const auto evicted_close_a_id = evicted_close.entries().back().id;
    CHECK(commit_history(evicted_close, "retained B", evicted_close_1, evicted_close_2,
                         TimestampedOperationKind::Paint));
    const auto evicted_close_b_id = evicted_close.entries().back().id;
    CHECK(commit_history(evicted_close, "retained C", evicted_close_2, evicted_close_3,
                         TimestampedOperationKind::Paint));
    CHECK(commit_history(evicted_close, "retained D", evicted_close_3, evicted_close_4,
                         TimestampedOperationKind::Paint));
    evicted_close.set_byte_budget(evicted_close.bytes_used() - 1);
    CHECK(evicted_close.resource_diagnostics().evicted_timestamp_count > 0);
    CHECK(evicted_close.entries().front().id == evicted_close_b_id);
    const auto eviction_count_before_close = evicted_close.resource_diagnostics().evicted_timestamp_count;
    CHECK(evicted_close.close_editing_session(evicted_close_session->id));
    CHECK(evicted_close.entries().size() == 1);
    CHECK(evicted_close.entries()[0].id == evicted_close_b_id);
    CHECK(evicted_close.entries()[0].before_timestamp == 1 && evicted_close.entries()[0].after_timestamp == 4);
    CHECK(evicted_close.current_timestamp() == 4 && !evicted_close.navigation_floor());
    CHECK(evicted_close.resource_diagnostics().evicted_timestamp_count >= eviction_count_before_close);
    CHECK(!evicted_close.restore_before(evicted_close_a_id, &evicted_close_4, close_restore));
    CHECK(!evicted_close.restore(0, nullptr, close_restore));
    CHECK(evicted_close.current_timestamp() == 4 && !evicted_close.can_redo());

    // Invalid identities and active operations fail before changing any part of
    // the history, saved checkpoint, session floor or retained resources.
    TimestampedHistory rejected_close;
    const auto reject_before = roots(160, {object(90, 1, 90)});
    const auto reject_entry = roots(161, {object(90, 2, 91)});
    const auto reject_paint = roots(162, {object(90, 3, 92)});
    CHECK(commit_history(rejected_close, "reject base", reject_before, reject_entry));
    const auto reject_session = rejected_close.begin_editing_session();
    CHECK(reject_session);
    CHECK(commit_history(rejected_close, "reject paint", reject_entry, reject_paint,
                         TimestampedOperationKind::Paint));
    rejected_close.mark_current_as_saved();
    const auto assert_rejected_unchanged = [&](const std::vector<TimestampedEntryInfo>& entries_before,
                                               const std::vector<TimestampedObjectVersionInterval>& intervals_before,
                                               const TimestampedResourceDiagnostics& resources_before,
                                               std::size_t snapshots_before, std::size_t archives_before,
                                               std::size_t bytes_before, LogicalTimestamp current_before,
                                               std::optional<LogicalTimestamp> floor_before,
                                               std::optional<LogicalTimestamp> saved_before,
                                               bool checkpoint_evicted_before, bool modified_before,
                                               bool operation_before) {
        const auto status = rejected_close.editing_session_status();
        return entries_are_equal(rejected_close.entries(), entries_before) &&
               intervals_are_equal(rejected_close.object_intervals(), intervals_before) &&
               resource_diagnostics_are_equal(rejected_close.resource_diagnostics(), resources_before) &&
               rejected_close.snapshot_count() == snapshots_before &&
               rejected_close.object_archive_count() == archives_before && rejected_close.bytes_used() == bytes_before &&
               rejected_close.current_timestamp() == current_before && rejected_close.navigation_floor() == floor_before &&
               rejected_close.saved_timestamp() == saved_before &&
               rejected_close.saved_checkpoint_evicted() == checkpoint_evicted_before &&
               rejected_close.project_modified() == modified_before &&
               rejected_close.operation_active() == operation_before && status && status->id == reject_session->id &&
               status->has_effective_commit;
    };
    const auto reject_entries = rejected_close.entries();
    const auto reject_intervals = rejected_close.object_intervals();
    const auto reject_resources = rejected_close.resource_diagnostics();
    const auto reject_snapshots = rejected_close.snapshot_count();
    const auto reject_archives = rejected_close.object_archive_count();
    const auto reject_bytes = rejected_close.bytes_used();
    const auto reject_current = rejected_close.current_timestamp();
    const auto reject_floor = rejected_close.navigation_floor();
    const auto reject_saved = rejected_close.saved_timestamp();
    const bool reject_checkpoint_evicted = rejected_close.saved_checkpoint_evicted();
    const bool reject_modified = rejected_close.project_modified();
    const bool reject_operation = rejected_close.operation_active();
    CHECK(!rejected_close.close_editing_session(reject_session->id + 1));
    CHECK(assert_rejected_unchanged(reject_entries, reject_intervals, reject_resources, reject_snapshots,
                                    reject_archives, reject_bytes, reject_current, reject_floor, reject_saved,
                                    reject_checkpoint_evicted, reject_modified, reject_operation));
    CHECK(rejected_close.begin_operation("active close refusal", reject_paint, TimestampedOperationKind::Paint));
    const auto active_reject_entries = rejected_close.entries();
    const auto active_reject_intervals = rejected_close.object_intervals();
    const auto active_reject_resources = rejected_close.resource_diagnostics();
    const auto active_reject_snapshots = rejected_close.snapshot_count();
    const auto active_reject_archives = rejected_close.object_archive_count();
    const auto active_reject_bytes = rejected_close.bytes_used();
    const auto active_reject_current = rejected_close.current_timestamp();
    const auto active_reject_floor = rejected_close.navigation_floor();
    const auto active_reject_saved = rejected_close.saved_timestamp();
    const bool active_reject_checkpoint_evicted = rejected_close.saved_checkpoint_evicted();
    const bool active_reject_modified = rejected_close.project_modified();
    const bool active_reject_operation = rejected_close.operation_active();
    CHECK(!rejected_close.close_editing_session(reject_session->id));
    CHECK(assert_rejected_unchanged(active_reject_entries, active_reject_intervals, active_reject_resources,
                                    active_reject_snapshots, active_reject_archives, active_reject_bytes,
                                    active_reject_current, active_reject_floor, active_reject_saved,
                                    active_reject_checkpoint_evicted, active_reject_modified,
                                    active_reject_operation));
    CHECK(rejected_close.abort_operation(&close_restore));
    CHECK(close_restore.timestamp == 2 && close_restore.roots.model.serialized == reject_paint.model.serialized);

    // Bridge response preparation can fail before session publication. The
    // callback sees the complete candidate while the live history remains
    // untouched, including its Redo branch and saved checkpoint.
    TimestampedHistory publish_open;
    const auto publish_open_0 = roots(170, {object(100, 1, 170)});
    const auto publish_open_1 = roots(171, {object(100, 2, 171)});
    const auto publish_open_2 = roots(172, {object(100, 3, 172)});
    CHECK(commit_history(publish_open, "publish open A", publish_open_0, publish_open_1));
    CHECK(commit_history(publish_open, "publish open B", publish_open_1, publish_open_2));
    publish_open.mark_current_as_saved();
    CHECK(publish_open.undo(publish_open_2, close_restore));
    const auto publish_open_entries = publish_open.entries();
    const auto publish_open_intervals = publish_open.object_intervals();
    const auto publish_open_resources = publish_open.resource_diagnostics();
    const auto publish_open_snapshots = publish_open.snapshot_count();
    const auto publish_open_archives = publish_open.object_archive_count();
    const auto publish_open_bytes = publish_open.bytes_used();
    const auto publish_open_cursor = publish_open.current_timestamp();
    const auto publish_open_saved = publish_open.saved_timestamp();
    const bool publish_open_checkpoint_evicted = publish_open.saved_checkpoint_evicted();
    const bool publish_open_modified = publish_open.project_modified();
    bool publish_open_candidate_seen = false;
    bool publish_open_callback_threw = false;
    try {
        (void) publish_open.begin_editing_session([&](const TimestampedHistory& candidate) {
            const auto status = candidate.editing_session_status();
            publish_open_candidate_seen = status && status->id != 0 &&
                status->entry_timestamp == publish_open_cursor && !status->has_effective_commit &&
                candidate.navigation_floor() == std::optional<LogicalTimestamp>(publish_open_cursor) &&
                entries_are_equal(candidate.entries(), publish_open_entries) && candidate.can_redo() &&
                candidate.saved_timestamp() == publish_open_saved;
            throw std::runtime_error("injected pre-publication open failure");
        });
    } catch (const std::runtime_error&) {
        publish_open_callback_threw = true;
    }
    CHECK(publish_open_candidate_seen && publish_open_callback_threw);
    CHECK(entries_are_equal(publish_open.entries(), publish_open_entries));
    CHECK(intervals_are_equal(publish_open.object_intervals(), publish_open_intervals));
    CHECK(resource_diagnostics_are_equal(publish_open.resource_diagnostics(), publish_open_resources));
    CHECK(publish_open.snapshot_count() == publish_open_snapshots &&
          publish_open.object_archive_count() == publish_open_archives && publish_open.bytes_used() == publish_open_bytes);
    CHECK(publish_open.current_timestamp() == publish_open_cursor && !publish_open.editing_session_status() &&
          !publish_open.navigation_floor() && publish_open.saved_timestamp() == publish_open_saved &&
          publish_open.saved_checkpoint_evicted() == publish_open_checkpoint_evicted &&
          publish_open.project_modified() == publish_open_modified && publish_open.can_redo());

    // Close response preparation sees the post-cleanup candidate. If it throws,
    // the original open session, child entries, saved marker and Redo remain
    // reachable because the candidate has not been swapped into place.
    TimestampedHistory publish_close;
    const auto publish_close_0 = roots(180, {object(110, 1, 180)});
    const auto publish_close_1 = roots(181, {object(110, 2, 181)});
    const auto publish_close_2 = roots(182, {object(110, 3, 182)});
    const auto publish_close_3 = roots(183, {object(110, 4, 183)});
    CHECK(commit_history(publish_close, "publish close base", publish_close_0, publish_close_1));
    const auto publish_close_session = publish_close.begin_editing_session();
    CHECK(publish_close_session);
    CHECK(commit_history(publish_close, "publish close stroke A", publish_close_1, publish_close_2,
                         TimestampedOperationKind::Paint));
    CHECK(commit_history(publish_close, "publish close stroke B", publish_close_2, publish_close_3,
                         TimestampedOperationKind::Paint));
    publish_close.mark_current_as_saved();
    CHECK(publish_close.undo(publish_close_3, close_restore) && close_restore.timestamp == 2);
    CHECK(publish_close.undo(publish_close_2, close_restore) && close_restore.timestamp == 1);
    const auto publish_close_entries = publish_close.entries();
    const auto publish_close_intervals = publish_close.object_intervals();
    const auto publish_close_resources = publish_close.resource_diagnostics();
    const auto publish_close_snapshots = publish_close.snapshot_count();
    const auto publish_close_archives = publish_close.object_archive_count();
    const auto publish_close_bytes = publish_close.bytes_used();
    const auto publish_close_cursor = publish_close.current_timestamp();
    const auto publish_close_floor = publish_close.navigation_floor();
    const auto publish_close_saved = publish_close.saved_timestamp();
    const bool publish_close_checkpoint_evicted = publish_close.saved_checkpoint_evicted();
    const bool publish_close_modified = publish_close.project_modified();
    bool publish_close_candidate_seen = false;
    bool publish_close_callback_threw = false;
    try {
        (void) publish_close.close_editing_session(publish_close_session->id, "Paint",
            [&](const TimestampedHistory& candidate) {
                publish_close_candidate_seen = !candidate.editing_session_status() &&
                    !candidate.navigation_floor() && candidate.current_timestamp() == publish_close_cursor &&
                    candidate.entries().size() == 1 && !candidate.can_redo() &&
                    !candidate.saved_timestamp() && candidate.saved_checkpoint_evicted() &&
                    candidate.project_modified() && candidate.bytes_used() < publish_close_bytes;
                throw std::runtime_error("injected pre-publication close failure");
            });
    } catch (const std::runtime_error&) {
        publish_close_callback_threw = true;
    }
    CHECK(publish_close_candidate_seen && publish_close_callback_threw);
    CHECK(entries_are_equal(publish_close.entries(), publish_close_entries));
    CHECK(intervals_are_equal(publish_close.object_intervals(), publish_close_intervals));
    CHECK(resource_diagnostics_are_equal(publish_close.resource_diagnostics(), publish_close_resources));
    CHECK(publish_close.snapshot_count() == publish_close_snapshots &&
          publish_close.object_archive_count() == publish_close_archives &&
          publish_close.bytes_used() == publish_close_bytes);
    const auto publish_close_status = publish_close.editing_session_status();
    CHECK(publish_close.current_timestamp() == publish_close_cursor &&
          publish_close.navigation_floor() == publish_close_floor && publish_close_status &&
          publish_close_status->id == publish_close_session->id && publish_close_status->has_effective_commit &&
          publish_close.saved_timestamp() == publish_close_saved &&
          publish_close.saved_checkpoint_evicted() == publish_close_checkpoint_evicted &&
          publish_close.project_modified() == publish_close_modified && publish_close.can_redo());

    CHECK(publish_close.begin_operation("failed paint", publish_close_1, TimestampedOperationKind::Paint));
    const auto commit_bytes = publish_close.bytes_used();
    bool commit_threw = false;
    try {
        publish_close.commit_operation(publish_close_2, nullptr, [](const TimestampedHistory& candidate) {
            if (candidate.operation_active() || candidate.can_redo()) throw std::logic_error("bad candidate");
            throw std::runtime_error("injected commit publication failure");
        });
    } catch (const std::runtime_error&) { commit_threw = true; }
    CHECK(commit_threw && publish_close.operation_active());
    CHECK(publish_close.current_timestamp() == publish_close_cursor && publish_close.bytes_used() == commit_bytes);
    CHECK(entries_are_equal(publish_close.entries(), publish_close_entries));
    CHECK(publish_close.saved_timestamp() == publish_close_saved && publish_close.saved_checkpoint_evicted() == publish_close_checkpoint_evicted);
    CHECK(publish_close.abort_operation());
    CHECK(publish_close.can_redo() && publish_close.current_timestamp() == publish_close_cursor);

    std::cout << "TimestampedHistory tests passed\n";
    return EXIT_SUCCESS;
}
