#include "plate_runtime_registry.hpp"

#include <iostream>
#include <type_traits>

#define CHECK(condition) do { \
    if (!(condition)) { \
        std::cerr << "Plate runtime registry test failed: " #condition "\n"; \
        return 1; \
    } \
} while (false)

using Slic3r::Neo::Bridge::PlateRuntimeRegistry;

// A snapshot must stay bounded regardless of the retained G-code size.
static_assert(std::is_trivially_copyable_v<PlateRuntimeRegistry::LifecycleSnapshot>);
static_assert(sizeof(PlateRuntimeRegistry::LifecycleSnapshot) <= 128);

int main()
{
    {
        PlateRuntimeRegistry rollback_registry;
        rollback_registry.reconcile({"plate-rollback"});
        auto* entry = rollback_registry.find("plate-rollback");
        {
            auto job = rollback_registry.begin_slice("plate-rollback", 1, 0);
            CHECK(rollback_registry.mark_process_completed(job, 0, 0));
        }
        entry->result_generation = 1;
        entry->gcode_path = "/registry-lifecycle-test.gcode";
        entry->gcode_size = 8 * 1024 * 1024;
        entry->gcode_line_ends.assign(1024 * 1024, 8);
        entry->gcode_text_available = true;
        PlateRuntimeRegistry::mark_presentation_valid(*entry, 0);
        const auto* line_index = entry->gcode_line_ends.data();
        const auto* print = entry->print.get();
        const auto* result = entry->gcode_result.get();
        const auto available = rollback_registry.capture_lifecycle();

        rollback_registry.invalidate_presentations({"plate-rollback"});
        CHECK(!PlateRuntimeRegistry::is_publishable(*entry, 0));
        rollback_registry.restore_lifecycle(available);
        CHECK(PlateRuntimeRegistry::is_publishable(*entry, 0));
        CHECK(entry->print.get() == print && entry->gcode_result.get() == result);
        CHECK(entry->gcode_path == "/registry-lifecycle-test.gcode");
        CHECK(entry->gcode_size == 8 * 1024 * 1024);
        CHECK(entry->gcode_line_ends.data() == line_index);
        CHECK(entry->gcode_line_ends.size() == 1024 * 1024);
        CHECK(entry->gcode_line_ends.back() == 8);
        CHECK(entry->gcode_text_available && entry->native_core_materialized);

        // A new job on the same input must not expose the retained old result.
        {
            auto job = rollback_registry.begin_slice("plate-rollback", 2, 0);
            rollback_registry.restore_lifecycle(available);
            CHECK(entry->presentation == PlateRuntimeRegistry::PresentationLifecycle::Slicing);
            CHECK(!PlateRuntimeRegistry::is_publishable(*entry, 0));
            CHECK(rollback_registry.mark_process_completed(job, 0, 0));
        }
        rollback_registry.restore_lifecycle(available);
        CHECK(entry->completed_slice_task_id == 2);
        CHECK(!PlateRuntimeRegistry::is_publishable(*entry, 0));

        // Even on the same native objects, a replaced result cannot be rewound.
        PlateRuntimeRegistry::mark_presentation_valid(*entry, 0);
        const auto previous_generation = rollback_registry.capture_lifecycle();
        ++entry->result_generation;
        entry->gcode_size = 16;
        entry->gcode_line_ends = {8, 16};
        rollback_registry.invalidate_presentations({"plate-rollback"});
        rollback_registry.restore_lifecycle(previous_generation);
        CHECK(!PlateRuntimeRegistry::is_publishable(*entry, 0));
        CHECK(entry->result_generation == 2);
        CHECK(entry->gcode_size == 16);
        CHECK(entry->gcode_line_ends == std::vector<std::size_t>({8, 16}));

        // Reusing the plate id never revives an earlier incarnation's result.
        rollback_registry.reconcile({});
        rollback_registry.reconcile({"plate-rollback"});
        entry = rollback_registry.find("plate-rollback");
        rollback_registry.restore_lifecycle(available);
        CHECK(!PlateRuntimeRegistry::is_publishable(*entry, 0));
        CHECK(entry->result_generation == 0);
        CHECK(entry->gcode_path.empty() && entry->gcode_line_ends.empty());
        CHECK(!entry->gcode_text_available && !entry->native_core_materialized);
    }

    PlateRuntimeRegistry registry;

    registry.reconcile({"plate-a"});
    CHECK(registry.size() == 1);
    auto* first = registry.find("plate-a");
    CHECK(first != nullptr);
    CHECK(first->plate_id == "plate-a");
    CHECK(first->print != nullptr);
    CHECK(first->gcode_result != nullptr);
    CHECK(first->presentation == PlateRuntimeRegistry::PresentationLifecycle::Invalid);
    CHECK(!first->completed_input_revision.has_value());
    CHECK(!first->native_core_materialized);

    const auto* first_print = first->print.get();
    const auto* first_result = first->gcode_result.get();
    {
        auto job = registry.begin_slice("plate-a", 17, 0);
        CHECK(&job.entry() == first);
        CHECK(first->presentation == PlateRuntimeRegistry::PresentationLifecycle::Slicing);
        CHECK(first->print.get() == first_print);
        CHECK(first->gcode_result.get() == first_result);
        CHECK(registry.has_active_job("plate-a"));
        CHECK(registry.mark_process_completed(job, 0, 0));
        CHECK(registry.can_publish_completed_job(job, 0));
    }
    CHECK(!registry.has_active_job("plate-a"));
    CHECK(first->presentation == PlateRuntimeRegistry::PresentationLifecycle::Slicing);
    CHECK(first->native_core_materialized);
    CHECK(first->completed_input_revision == 0);
    CHECK(first->completed_slice_task_id == 17);
    CHECK(PlateRuntimeRegistry::can_materialize_result(*first, 0));
    PlateRuntimeRegistry::mark_presentation_valid(*first, 0);
    CHECK(first->presentation == PlateRuntimeRegistry::PresentationLifecycle::Valid);
    CHECK(PlateRuntimeRegistry::is_publishable(*first, 0));

    // Re-slicing the same input keeps the revision and native allocations but
    // withdraws the old presentation until the new result is materialized.
    {
        auto job = registry.begin_slice("plate-a", 19, 0);
        CHECK(first->presentation == PlateRuntimeRegistry::PresentationLifecycle::Slicing);
        CHECK(first->print.get() == first_print);
        CHECK(first->gcode_result.get() == first_result);
        CHECK(first->completed_input_revision == 0);
        CHECK(!PlateRuntimeRegistry::is_publishable(*first, 0));
        CHECK(registry.mark_process_completed(job, 0, 0));
    }

    registry.reconcile({"plate-a", "plate-b"});
    CHECK(registry.size() == 2);
    auto* retained = registry.find("plate-a");
    auto* created = registry.find("plate-b");
    CHECK(retained != nullptr);
    CHECK(created != nullptr);
    CHECK(retained->print.get() == first_print);
    CHECK(retained->gcode_result.get() == first_result);
    CHECK(created->print.get() != retained->print.get());
    CHECK(created->gcode_result.get() != retained->gcode_result.get());
    CHECK(created->presentation == PlateRuntimeRegistry::PresentationLifecycle::Invalid);
    {
        auto job = registry.begin_slice("plate-b", 18, 0);
        CHECK(registry.mark_process_completed(job, 0, 1));
        CHECK(!registry.can_publish_completed_job(job, 1));
    }
    CHECK(created->presentation == PlateRuntimeRegistry::PresentationLifecycle::Invalid);
    CHECK(created->native_core_materialized);
    CHECK(!PlateRuntimeRegistry::can_materialize_result(*created, 1));
    CHECK(!PlateRuntimeRegistry::is_publishable(*created, 1));

    registry.reconcile({"plate-b"});
    CHECK(registry.size() == 1);
    CHECK(registry.find("plate-a") == nullptr);
    auto* retained_after_delete = registry.find("plate-b");
    CHECK(retained_after_delete != nullptr);
    const auto* second_print = retained_after_delete->print.get();
    const auto* second_result = retained_after_delete->gcode_result.get();

    registry.reconcile({"plate-b", "plate-c", "plate-d"});
    CHECK(registry.size() == 3);
    CHECK(registry.find("plate-b")->print.get() == second_print);
    CHECK(registry.find("plate-b")->gcode_result.get() == second_result);
    CHECK(registry.find("plate-c")->print.get() != registry.find("plate-d")->print.get());
    CHECK(registry.find("plate-c")->gcode_result.get() != registry.find("plate-d")->gcode_result.get());

    registry.reconcile({"plate-d", "plate-b", "plate-c"});
    CHECK(registry.size() == 3);
    CHECK(registry.find("plate-b")->print.get() == second_print);
    CHECK(registry.find("plate-b")->gcode_result.get() == second_result);

    // A structural reflow invalidates exactly the changed-origin set.  The
    // registry keeps every native allocation resident, and a rollback can
    // restore the prior lifecycle metadata only for those same incarnations.
    auto* plate_b = registry.find("plate-b");
    auto* plate_c = registry.find("plate-c");
    CHECK(plate_b != nullptr && plate_c != nullptr);
    {
        auto job = registry.begin_slice("plate-b", 41, 4);
        CHECK(registry.mark_process_completed(job, 4, 4));
    }
    PlateRuntimeRegistry::mark_presentation_valid(*plate_b, 4);
    {
        auto job = registry.begin_slice("plate-c", 71, 7);
        CHECK(registry.mark_process_completed(job, 7, 7));
    }
    PlateRuntimeRegistry::mark_presentation_valid(*plate_c, 7);
    const auto b_print = plate_b->print.get();
    const auto b_result = plate_b->gcode_result.get();
    const auto lifecycle_before = registry.capture_lifecycle();
    registry.invalidate_presentations({"plate-c"});
    CHECK(plate_b->presentation == PlateRuntimeRegistry::PresentationLifecycle::Valid);
    CHECK(plate_c->presentation == PlateRuntimeRegistry::PresentationLifecycle::Invalid);
    CHECK(plate_b->print.get() == b_print && plate_b->gcode_result.get() == b_result);
    registry.restore_lifecycle(lifecycle_before);
    CHECK(plate_b->presentation == PlateRuntimeRegistry::PresentationLifecycle::Valid);
    CHECK(plate_c->presentation == PlateRuntimeRegistry::PresentationLifecycle::Valid);
    CHECK(plate_b->completed_slice_task_id == 41);
    CHECK(plate_c->completed_slice_task_id == 71);
    registry.reconcile({"plate-b", "plate-c", "plate-e"});
    registry.restore_lifecycle(lifecycle_before);
    CHECK(registry.find("plate-e")->presentation == PlateRuntimeRegistry::PresentationLifecycle::Invalid);

    // An input invalidation on the active entry commits immediately and only
    // requests the retained Print's atomic cancellation; it never waits for
    // the job lease or releases the entry under the running process.
    {
        auto job = registry.begin_slice("plate-b", 72, 8);
        registry.invalidate_presentations({"plate-b"});
        CHECK(registry.cancellation_requested(job));
        CHECK(registry.has_active_job("plate-b"));
        registry.mark_process_failed(job);
        job.entry().print->restart();
    }

    // A history restore retains an unchanged plate's native entry and
    // presentation, but a changed stable id is never made publishable merely
    // because its retained completed revision happens to match the target.
    const auto* retained_b_print = registry.find("plate-b")->print.get();
    const auto* retained_b_result = registry.find("plate-b")->gcode_result.get();
    const auto b_lifecycle = registry.find("plate-b")->presentation;
    registry.reconcile_history({"plate-b", "plate-f"},
                               {});
    CHECK(registry.find("plate-b")->print.get() == retained_b_print);
    CHECK(registry.find("plate-b")->gcode_result.get() == retained_b_result);
    CHECK(registry.find("plate-b")->presentation == b_lifecycle);
    CHECK(registry.find("plate-c") == nullptr);
    CHECK(registry.find("plate-e") == nullptr);
    CHECK(registry.find("plate-f") != nullptr);
    CHECK(registry.find("plate-f")->presentation == PlateRuntimeRegistry::PresentationLifecycle::Invalid);

    // A changed revision must withdraw presentation even when the retained
    // native result was completed at the same numeric target revision.
    auto* changed = registry.find("plate-b");
    {
        auto job = registry.begin_slice("plate-b", 42, 4);
        CHECK(registry.mark_process_completed(job, 4, 4));
    }
    PlateRuntimeRegistry::mark_presentation_valid(*changed, 4);
    registry.reconcile_history({"plate-b", "plate-f"},
                               {"plate-b"});
    CHECK(changed->print.get() == retained_b_print);
    CHECK(changed->gcode_result.get() == retained_b_result);
    CHECK(changed->presentation == PlateRuntimeRegistry::PresentationLifecycle::Invalid);

    // Deleting a leased entry removes it from the live registry immediately
    // but retains the exact native incarnation as a non-publishable tombstone.
    // Restoring the stable plate id before the old terminal creates a fresh
    // Print/result pair and cannot adopt the old job's lifecycle.
    registry.reconcile({"plate-b", "plate-f", "plate-z"});
    auto* old_z = registry.find("plate-z");
    CHECK(old_z != nullptr);
    const auto old_z_incarnation = old_z->incarnation_id;
    const auto* old_z_print = old_z->print.get();
    const auto* old_z_result = old_z->gcode_result.get();
    {
        auto old_job = registry.begin_slice("plate-z", 91, 12);
        const auto retired = registry.reconcile({"plate-b", "plate-f"});
        CHECK(retired.size() == 1);
        CHECK(retired[0].plate_id == "plate-z");
        CHECK(retired[0].incarnation_id == old_z_incarnation);
        CHECK(registry.find("plate-z") == nullptr);
        CHECK(registry.retired_size() == 1);
#ifdef ORCA_WASM_THREADING
        CHECK(registry.request_retired_job_cancellation(old_z_incarnation));
        CHECK(registry.cancellation_requested(old_job));
#endif
        CHECK(!registry.mark_process_completed(old_job, 12, 12));
        CHECK(!registry.can_publish_completed_job(old_job, 12));

        registry.reconcile({"plate-b", "plate-f", "plate-z"});
        auto* restored_z = registry.find("plate-z");
        CHECK(restored_z != nullptr);
        CHECK(restored_z->incarnation_id != old_z_incarnation);
        CHECK(restored_z->print.get() != old_z_print);
        CHECK(restored_z->gcode_result.get() != old_z_result);
        CHECK(restored_z->presentation == PlateRuntimeRegistry::PresentationLifecycle::Invalid);
        CHECK(old_job.entry().print.get() == old_z_print);
        CHECK(old_job.entry().gcode_result.get() == old_z_result);
    }
    CHECK(registry.retired_size() == 0);
    CHECK(registry.find("plate-z") != nullptr);
    return 0;
}
