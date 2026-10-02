#pragma once

#include "libslic3r/Arrange.hpp"
#include "libslic3r/Model.hpp"

#include <optional>

namespace Slic3r::Neo::Arrangement {

enum class Scope { All, CurrentPlate };
enum class ParkingReason { None, NonPrintable, Degenerate, TooTall, Unfit, PlateLimit, CurrentPlateOverflow };

struct Settings {
    Scope scope = Scope::All;
    double distance = 0;
    bool rotate = false;
    bool align_y = false;
    bool multiple_materials = true;
    bool avoid_calibration = true;
};

struct PlateInput {
    std::string id;
    Vec3d origin = Vec3d::Zero();
    bool locked = false;
    DynamicPrintConfig settings;
    // Already projected in plate-local coordinates. Its setter is discarded.
    std::optional<arrangement::ArrangePolygon> tower;
};

struct InstanceInput {
    ModelInstance* instance = nullptr;
    std::optional<std::size_t> plate;
    // Native plate validity, distinct from membership or intersection. Tower
    // estimates use only fully contained instances, as PartPlate does.
    bool fully_inside_plate = true;
};

// Consumed only on the state-owning Worker. None of these model pointers are
// retained in Prepared or used by the background solver.
struct SceneInput {
    DynamicPrintConfig config;
    std::vector<PlateInput> plates;
    std::vector<InstanceInput> instances;
    std::size_t current_plate = 0;
    bool bambu = false;
};

struct Placement {
    std::size_t instance_id = 0;
    // Real display index; indices beyond the initial plate count create plates.
    // Empty means outside-plate parking.
    std::optional<std::size_t> plate;
    Vec2d position = Vec2d::Zero();
    double rotation = 0;
    ParkingReason parking = ParkingReason::None;
};

struct Prepared {
    Scope scope = Scope::All;
    DynamicPrintConfig config;
    arrangement::ArrangeParams params;
    arrangement::ArrangePolygons movable;
    arrangement::ArrangePolygons fixed;
    Points bed;
    std::vector<std::size_t> destination_plates;
    // Only towers without an existing projected footprint are normalized.
    // Publish these plate-local coordinates for occupied destinations together
    // with the model placements so the live tower matches the reserved area.
    std::vector<std::pair<std::size_t, Vec2d>> estimated_tower_positions;
    // Movable itemid indexes these records, even if native packing reorders items.
    std::vector<Placement> instances;
    std::vector<Placement> parked;
};

struct Result {
    std::vector<Placement> placements;
    bool canceled = false;
    bool plate_limit_reached = false;
};

Prepared prepare(const SceneInput& scene, const Settings& settings);
Result solve(Prepared prepared,
             std::function<bool()> canceled = {},
             std::function<void(unsigned, std::string)> progress = {});

} // namespace Slic3r::Neo::Arrangement
