#include "plate_runtime_registry.hpp"

#include <iostream>

#define CHECK(condition) do { \
    if (!(condition)) { \
        std::cerr << "Plate runtime registry test failed: " #condition "\n"; \
        return 1; \
    } \
} while (false)

using Slic3r::Neo::Bridge::PlateRuntimeRegistry;

int main()
{
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
    PlateRuntimeRegistry::begin_slice(*first);
    CHECK(first->presentation == PlateRuntimeRegistry::PresentationLifecycle::Slicing);
    CHECK(first->print.get() == first_print);
    CHECK(first->gcode_result.get() == first_result);
    PlateRuntimeRegistry::mark_process_completed(*first, 0, 0);
    CHECK(first->presentation == PlateRuntimeRegistry::PresentationLifecycle::Slicing);
    CHECK(first->native_core_materialized);
    CHECK(first->completed_input_revision == 0);
    CHECK(PlateRuntimeRegistry::can_materialize_result(*first, 0));
    PlateRuntimeRegistry::mark_presentation_valid(*first, 0);
    CHECK(first->presentation == PlateRuntimeRegistry::PresentationLifecycle::Valid);
    CHECK(PlateRuntimeRegistry::is_publishable(*first, 0));

    // Re-slicing the same input keeps the revision and native allocations but
    // withdraws the old presentation until the new result is materialized.
    PlateRuntimeRegistry::begin_slice(*first);
    CHECK(first->presentation == PlateRuntimeRegistry::PresentationLifecycle::Slicing);
    CHECK(first->print.get() == first_print);
    CHECK(first->gcode_result.get() == first_result);
    CHECK(first->completed_input_revision == 0);
    CHECK(!PlateRuntimeRegistry::is_publishable(*first, 0));

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
    PlateRuntimeRegistry::begin_slice(*created);
    PlateRuntimeRegistry::mark_process_completed(*created, 0, 1);
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
    PlateRuntimeRegistry::begin_slice(*plate_b);
    PlateRuntimeRegistry::mark_process_completed(*plate_b, 4, 4);
    PlateRuntimeRegistry::mark_presentation_valid(*plate_b, 4);
    PlateRuntimeRegistry::begin_slice(*plate_c);
    PlateRuntimeRegistry::mark_process_completed(*plate_c, 7, 7);
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
    registry.reconcile({"plate-b", "plate-c", "plate-e"});
    registry.restore_lifecycle(lifecycle_before);
    CHECK(registry.find("plate-e")->presentation == PlateRuntimeRegistry::PresentationLifecycle::Invalid);
    return 0;
}
