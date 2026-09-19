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
    result.project_config_overlay = bytes(project);
    return result;
}

static bool object_is(const TimestampedRestore& restored, std::size_t index, ObjectID id,
                      std::uint64_t timestamp, std::uint8_t value)
{
    if (index >= restored.roots.model.mutable_objects.size()) return false;
    const auto& object = restored.roots.model.mutable_objects[index];
    return object.id == id && object.timestamp == timestamp && object.data && *object.data == bytes(value);
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
    CHECK(restored.roots.project_config_overlay == bytes(23));
    CHECK(sequence.restore(0, nullptr, restored));
    CHECK(restored.roots.model.serialized == bytes(10));
    CHECK(restored.roots.session.plate_session == bytes(1));
    CHECK(restored.roots.session.history_context == bytes(11));
    CHECK(restored.roots.project_config_overlay == bytes(21));

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

    // Reconstructable immutable data is released before any timestamp.
    TimestampedHistory optional_data;
    auto optional_roots = roots(1, { object(1, 1, 1) });
    ImmutableMesh optional_mesh;
    optional_mesh.key = "mesh-1";
    optional_mesh.resident = std::make_shared<const Bytes>(bytes(8, 512));
    optional_mesh.deferred = std::make_shared<const Bytes>(bytes(9, 8));
    optional_mesh.optional = true;
    optional_roots.model.immutable_meshes.push_back(optional_mesh);
    CHECK(optional_data.begin_operation("mesh", optional_roots));
    CHECK(optional_data.commit_operation(optional_roots));
    const auto optional_bytes_before = optional_data.bytes_used();
    optional_data.set_byte_budget(optional_bytes_before - 128);
    CHECK(optional_data.snapshot_count() == 1);
    CHECK(optional_data.resource_diagnostics().optional_bytes_released >= 512);
    CHECK(optional_data.resource_diagnostics().evicted_timestamp_count == 0);
    CHECK(optional_data.bytes_used() <= optional_data.byte_budget());

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
    budget.set_byte_budget(1);
    CHECK(budget.snapshot_count() == 1);
    CHECK(budget.object_archive(2, 1));
    CHECK(budget.can_undo());
    CHECK(budget.saved_checkpoint_evicted());
    CHECK(budget.project_modified());
    CHECK(budget.resource_diagnostics().oversized_nearest_history_retained);

    std::cout << "TimestampedHistory tests passed\n";
    return EXIT_SUCCESS;
}
