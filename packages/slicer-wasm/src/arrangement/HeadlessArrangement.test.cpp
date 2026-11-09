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
void exclusion_tests() {
    Settings current;
    current.scope = Scope::CurrentPlate;
    Fixture elevated;
    elevated.scene.config.set_key_value("bed_exclude_volumes", new ConfigOptionString("20..40;0x0,100x0,100x100,0x100"));
    auto* instance = elevated.add(10, 0, 10);
    auto low = prepare(elevated.scene, current);
    CHECK(low.params.excluded_regions.size() == 1);
    CHECK(low.params.excluded_regions[0].is_bed_exclusion);
    CHECK(low.params.excluded_regions[0].bed_exclusion_extruder_id == -1);
    CHECK(!arrangement::bed_exclusion_applies(low.movable[0], low.params.excluded_regions[0]));
    CHECK(solve(low).placements[0].plate == 0);
    instance->set_offset({0, 0, 25});
    auto high = prepare(elevated.scene, current);
    CHECK(high.movable[0].has_z_range && high.movable[0].z_min == 25);
    CHECK(arrangement::bed_exclusion_applies(high.movable[0], high.params.excluded_regions[0]));
    CHECK(!solve(high).placements[0].plate);

    Fixture mapped;
    mapped.scene.config.set_num_extruders(2);
    mapped.scene.config.set_key_value("bed_exclude_volume_mode", new ConfigOptionEnum<BedExcludeVolumeMode>(BedExcludeVolumeMode::PerExtruder));
    mapped.scene.config.set_key_value("extruder_bed_exclude_volumes", new ConfigOptionStrings({"", "0..50;0x0,100x0,100x100,0x100"}));
    mapped.scene.config.set_key_value("filament_map_mode", new ConfigOptionEnum<FilamentMapMode>(fmmManual));
    mapped.scene.config.set_key_value("filament_map", new ConfigOptionInts({1, 2}));
    auto* first = mapped.add(10);
    auto clear = prepare(mapped.scene, current);
    CHECK(clear.movable[0].bed_exclusion_extruder_ids == std::vector<int>({0}));
    CHECK(clear.params.excluded_regions[0].bed_exclusion_extruder_id == 1);
    CHECK(solve(clear).placements[0].plate == 0);
    first->get_object()->config.set_key_value("top_surface_filament_id", new ConfigOptionInt(2));
    auto feature = prepare(mapped.scene, current);
    CHECK(feature.movable[0].bed_exclusion_extruder_ids == std::vector<int>({0, 1}));
    CHECK(!solve(feature).placements[0].plate);
    first->get_object()->config.set_key_value("top_shell_layers", new ConfigOptionInt(0));
    CHECK(prepare(mapped.scene, current).movable[0].bed_exclusion_extruder_ids == std::vector<int>({0}));
    first->get_object()->config.set_key_value("enable_support", new ConfigOptionBool(true));
    first->get_object()->config.set_key_value("support_filament", new ConfigOptionInt(2));
    CHECK(prepare(mapped.scene, current).movable[0].bed_exclusion_extruder_ids == std::vector<int>({0, 1}));
    first->get_object()->config.set_key_value("enable_support", new ConfigOptionBool(false));

    mapped.scene.plates.push_back({"plate-2"});
    mapped.scene.plates[1].settings.set_key_value("filament_map", new ConfigOptionInts({2, 1}));
    mapped.scene.plates[1].settings.set_key_value("filament_map_mode", new ConfigOptionEnum<FilamentMapMode>(fmmDefault));
    CHECK(prepare(mapped.scene, {}).movable[0].bed_exclusion_extruder_ids == std::vector<int>({0, 1}));
    CHECK(prepare(mapped.scene, current).movable[0].bed_exclusion_extruder_ids == std::vector<int>({0}));
    mapped.scene.bambu = true;
    mapped.scene.config.set_key_value("filament_map_mode", new ConfigOptionEnum<FilamentMapMode>(fmmAutoForFlush));
    auto automatic = prepare(mapped.scene, current);
    CHECK(automatic.movable[0].bed_exclusion_extruder_ids.empty());
    CHECK(!solve(automatic).placements[0].plate);
    mapped.scene.bambu = false;
    first->get_object()->config.set_key_value("extruder", new ConfigOptionInt(2));
    // Generic multi-tool auto mapping follows tool ids, not Bambu's seed map.
    mapped.scene.config.set_key_value("filament_map", new ConfigOptionInts({1, 1}));
    CHECK(prepare(mapped.scene, current).movable[0].bed_exclusion_extruder_ids == std::vector<int>({1}));

    Fixture offset;
    offset.scene.config.set_num_extruders(2);
    offset.scene.config.set_key_value("bed_exclude_volume_mode", new ConfigOptionEnum<BedExcludeVolumeMode>(BedExcludeVolumeMode::ToolheadOffset));
    offset.scene.config.set_key_value("extruder_offset", new ConfigOptionPoints({{0, 0}, {20, 5}}));
    offset.scene.config.set_key_value("master_extruder_id", new ConfigOptionInt(1));
    offset.scene.config.set_key_value("bed_exclude_volumes", new ConfigOptionString("10..30;0x0,10x0,10x10,0x10"));
    offset.scene.config.set_key_value("bed_exclude_area", new ConfigOptionPoints({{70,70},{80,70},{80,80},{70,80}}));
    offset.add(10);
    const auto shifted = prepare(offset.scene, current);
    CHECK(shifted.params.excluded_regions.size() == 3);
    const auto first_box = get_extents(shifted.params.excluded_regions[0].poly.contour);
    const auto second_box = get_extents(shifted.params.excluded_regions[1].poly.contour);
    CHECK(second_box.min.x() - first_box.min.x() == scaled(20.));
    CHECK(second_box.min.y() - first_box.min.y() == scaled(5.));
    CHECK(!shifted.params.excluded_regions[2].is_bed_exclusion);
}
void tests() {
    exclusion_tests();
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

    // Native itemid is packing order, not the source-instance index. Packing
    // differently sized objects rewrites it; an unfit object retains its old
    // value and can share that value with a successfully packed object.
    Fixture identity;
    auto* small = identity.add(10);
    auto* unfit = identity.add(200);
    auto* large = identity.add(40);
    Settings rotated; rotated.rotate = true;
    auto identity_prepared = prepare(identity.scene, rotated);
    auto native_polygons = identity_prepared.movable;
    arrangement::arrange(native_polygons, identity_prepared.fixed,
                         identity_prepared.bed, identity_prepared.params);
    CHECK(native_polygons[0].itemid != 0 || native_polygons[2].itemid != 2);
    auto identities = solve(identity_prepared);
    CHECK(identities.placements.size() == 3);
    CHECK(identities.placements[0].instance_id == small->id().id);
    CHECK(identities.placements[1].instance_id == unfit->id().id);
    CHECK(identities.placements[2].instance_id == large->id().id);
    CHECK(!identities.placements[1].plate);
    for (std::size_t i : {std::size_t(0), std::size_t(2)}) {
        CHECK(identities.placements[i].plate.has_value());
        CHECK(identities.placements[i].position == unscale(native_polygons[i].translation));
        CHECK(identities.placements[i].rotation == native_polygons[i].rotation);
    }
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
