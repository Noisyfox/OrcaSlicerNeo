#pragma once

#include <memory>
#include <optional>
#include <vector>

#include "MeasureGeometry.hpp"
#include "libslic3r/Model.hpp"

namespace Slic3r::Neo::Measurement {

struct TargetId {
    std::size_t object;
    std::size_t instance;
    std::size_t volume;
    bool operator==(const TargetId& other) const {
        return object == other.object && instance == other.instance && volume == other.volume;
    }
};

// Column-major camera matrices and top-left CSS-pixel pointer/viewport,
// matching the existing native painting picker.
struct PointerEvent {
    Vec2d pointer = Vec2d::Zero();
    Eigen::Vector4d viewport = Eigen::Vector4d(0, 0, 1, 1);
    Eigen::Matrix4d projection = Eigen::Matrix4d::Identity();
    Eigen::Matrix4d view = Eigen::Matrix4d::Identity();
};

struct MeshPick {
    TargetId target;
    int original_facet;
    Vec3d local;
    Vec3d world;
    std::optional<Feature> feature;
};

// A mesh pick is only one part of Measure picking: visible feature grippers and
// off-mesh center/midpoint markers require their own hit tests in the session
// interaction layer. This class never treats a mesh miss as a marker miss.
class Session {
public:
    Session(const Model& model, const std::vector<TargetId>& targets);
    ~Session();
    Session(const Session&) = delete;
    Session& operator=(const Session&) = delete;

    std::size_t target_count() const { return m_targets.size(); }
    void validate(const Model& model) const;
    std::optional<MeshPick> pick_mesh(const Model& model, const PointerEvent& event) const;

private:
    struct Target;
    std::vector<std::unique_ptr<Target>> m_targets;
};

} // namespace Slic3r::Neo::Measurement
