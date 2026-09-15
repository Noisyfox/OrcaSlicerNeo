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

    const auto* first_print = first->print.get();
    const auto* first_result = first->gcode_result.get();
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
    return 0;
}
