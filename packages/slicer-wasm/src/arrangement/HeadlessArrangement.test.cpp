#include "HeadlessArrangement.hpp"
#include <iostream>
#include <stdexcept>
#ifdef ORCA_WASM_THREADING
#include <tbb/global_control.h>
#endif
using namespace Slic3r;
using namespace Slic3r::Neo::Arrangement;
#define CHECK(x) do { if (!(x)) throw std::runtime_error("failed: " #x); } while (false)
struct Fixture {
    Model model;
    SceneInput scene;
    Fixture() {
        scene.config = DynamicPrintConfig::full_print_config();
        scene.config.set_key_value("printable_area", new ConfigOptionPoints({{0,0},{100,0},{100,100},{0,100}}));
        scene.config.set_key_value("printable_height", new ConfigOptionFloat(100));
        scene.config.set_key_value("enable_prime_tower", new ConfigOptionBool(false));
        scene.config.set_key_value("skirt_loops", new ConfigOptionInt(0));
        scene.plates.push_back({"plate-1"});
    }
    ModelInstance* add(double size, std::optional<std::size_t> plate = 0, double height = 10) {
        auto* object = model.add_object();
        object->add_volume(TriangleMesh(its_make_cube(size, size, height)));
        auto* instance = object->add_instance();
        scene.instances.push_back({instance, plate});
        return instance;
    }
};
void tests() {
    Fixture f;
    auto* a = f.add(70); auto* b = f.add(70);
    const auto before = a->get_offset();
    auto prepared = prepare(f.scene, {});
    CHECK(prepared.destination_plates.size() == 36);
    CHECK(!prepared.movable[0].setter);
    auto result = solve(prepared);
    CHECK(result.placements.size() == 2);
    CHECK(result.placements[0].plate != result.placements[1].plate);
    CHECK(a->get_offset() == before && b->get_offset() == before);
    Settings current; current.scope = Scope::CurrentPlate;
    auto local = solve(prepare(f.scene, current));
    CHECK(std::count_if(local.placements.begin(), local.placements.end(), [](const auto& p) { return p.plate.has_value(); }) == 1);
    CHECK(!local.plate_limit_reached);
    auto canceled = solve(prepared, [] { return true; });
    CHECK(canceled.canceled && canceled.placements.empty());

    Fixture scope;
    scope.scene.plates.push_back({"plate-2"});
    scope.add(10, 1); // Geometrically overlaps current, but belongs to another plate.
    scope.add(10, std::nullopt); // Unowned overlapping object is in scope.
    auto* outside = scope.add(10, std::nullopt); outside->set_offset({1000,1000,0});
    CHECK(prepare(scope.scene, current).instances.size() == 1);
    scope.scene.plates[1].locked = true;
    CHECK(prepare(scope.scene, {}).instances.size() == 2);
    scope.scene.plates[0].locked = true;
    bool refused = false;
    try { prepare(scope.scene, current); } catch (const std::invalid_argument&) { refused = true; }
    CHECK(refused);

    Fixture partial;
    partial.add(10);
    partial.add(200);
    partial.add(10, 0, 120);
    auto* hidden = partial.add(10); hidden->printable = false;
    auto outcomes = solve(prepare(partial.scene, {}));
    CHECK(std::count_if(outcomes.placements.begin(), outcomes.placements.end(), [](const auto& p) { return p.plate.has_value(); }) == 1);
    CHECK(!hidden->printable);
    CHECK(std::count_if(outcomes.placements.begin(), outcomes.placements.end(), [](const auto& p) { return p.parking == ParkingReason::TooTall; }) == 1);

    Fixture capacity;
    capacity.add(70); capacity.add(70);
    for (int i = 1; i < 36; ++i) capacity.scene.plates.push_back({"locked-" + std::to_string(i), Vec3d::Zero(), true});
    auto limited = solve(prepare(capacity.scene, {}));
    CHECK(limited.plate_limit_reached);
    CHECK(std::count_if(limited.placements.begin(), limited.placements.end(), [](const auto& p) { return p.plate.has_value(); }) == 1);

    Fixture mode;
    mode.add(10);
    mode.scene.plates[0].settings.set_key_value("print_sequence", new ConfigOptionEnum<PrintSequence>(PrintSequence::ByObject));
    CHECK(prepare(mode.scene, {}).instances.empty());
    current.distance = 123;
    auto sequential = prepare(mode.scene, current);
    CHECK(sequential.params.is_seq_print && sequential.params.min_obj_distance != scaled(123.));
    CHECK(!mode.scene.plates[0].locked);

    Fixture regions;
    current.distance = 0;
    regions.scene.bambu = true;
    regions.scene.config.set_key_value("scan_first_layer", new ConfigOptionBool(true));
    regions.scene.config.set_key_value("bed_exclude_area", new ConfigOptionPoints({{0,0},{20,0},{20,20},{0,20}}));
    regions.add(10);
    auto constrained = prepare(regions.scene, current);
    CHECK(constrained.params.excluded_regions.size() == 1);
    CHECK(constrained.fixed.size() == 1 && constrained.fixed[0].is_extrusion_cali_object);
    auto placed = solve(constrained);
    CHECK(placed.placements.front().plate == 0);

    Fixture materials;
    materials.add(20);
    auto* other = materials.add(20);
    other->get_object()->config.set_key_value("extruder", new ConfigOptionInt(2));
    materials.scene.config.set_key_value("filament_type", new ConfigOptionStrings({"PLA", "PLA"}));
    Settings separate; separate.multiple_materials = false;
    auto separated = solve(prepare(materials.scene, separate));
    CHECK(separated.placements[0].plate != separated.placements[1].plate);
    auto mixed = solve(prepare(materials.scene, {}));
    CHECK(mixed.placements[0].plate == mixed.placements[1].plate);
    auto* extra = other->get_object()->add_volume(TriangleMesh(its_make_cube(10.,10.,10.)));
    extra->config.set_key_value("extruder", new ConfigOptionInt(1));
    auto subset = solve(prepare(materials.scene, separate));
    CHECK(subset.placements[0].plate == subset.placements[1].plate);
    materials.scene.config.set_key_value("enable_prime_tower", new ConfigOptionBool(true));
    auto towers = prepare(materials.scene, {});
    CHECK(towers.fixed.size() == 36);
    CHECK(towers.fixed.back().is_wipe_tower && !towers.fixed.back().setter);
    CHECK(towers.estimated_tower_positions.size() == 36);
    CHECK(towers.estimated_tower_positions.front().second.y() < 100);
    CHECK(materials.scene.config.option<ConfigOptionFloats>("wipe_tower_y")->get_at(0) == 220);
    // An out-of-bounds instance must not enlarge every estimated tower through
    // its filament, height or layer-height override; Orca uses total containment.
    auto* rejected_source = materials.add(20, 0, 120);
    rejected_source->set_offset({95,95,0});
    rejected_source->get_object()->config.set_key_value("extruder", new ConfigOptionInt(3));
    rejected_source->get_object()->config.set_key_value("layer_height", new ConfigOptionFloat(.01));
    materials.scene.instances.back().fully_inside_plate = false;
    auto* parked_source = materials.add(20, std::nullopt);
    parked_source->printable = false;
    parked_source->get_object()->config.set_key_value("extruder", new ConfigOptionInt(4));
    auto filtered_towers = prepare(materials.scene, {});
    CHECK(filtered_towers.fixed.front().poly.contour.points == towers.fixed.front().poly.contour.points);
    CHECK(filtered_towers.estimated_tower_positions.front().second == towers.estimated_tower_positions.front().second);
    materials.scene.plates[0].tower = towers.fixed.front();
    auto existing_tower = prepare(materials.scene, {});
    CHECK(existing_tower.estimated_tower_positions.size() == 35);
    CHECK(existing_tower.estimated_tower_positions.front().first == 1);
    CHECK(existing_tower.fixed.front().poly.contour.points == towers.fixed.front().poly.contour.points);
    materials.scene.config.set_key_value("print_sequence", new ConfigOptionEnum<PrintSequence>(PrintSequence::ByObject));
    CHECK(prepare(materials.scene, {}).fixed.empty());

    Fixture frozen;
    frozen.add(20);
    auto snapshot = prepare(frozen.scene, {});
    frozen.model.clear_objects();
    // Solver owns native polygons, never ModelInstance pointers or setters.
    CHECK(solve(std::move(snapshot)).placements[0].plate == 0);
}
int main() {
    try {
#ifdef ORCA_WASM_THREADING
        tbb::global_control threads(tbb::global_control::max_allowed_parallelism, 4);
        tbb::task_scheduler_handle scheduler{tbb::attach{}};
#endif
        tests();
#ifdef ORCA_WASM_THREADING
        CHECK(tbb::finalize(scheduler, std::nothrow));
#endif
        std::cout << "Headless arrangement checks passed\n";
        return 0;
    } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
