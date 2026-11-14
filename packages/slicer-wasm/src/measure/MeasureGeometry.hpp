#pragma once

#include <memory>
#include <optional>

#include "libslic3r/Measure.hpp"
#include "libslic3r/TriangleMesh.hpp"

namespace Slic3r::Neo::Measurement {

class Geometry;

// Plane features reference the Measuring cache. Keep that cache and the
// source mesh alive for as long as a feature is retained by a session.
struct Feature {
    std::shared_ptr<const Geometry> geometry;
    Measure::SurfaceFeature surface;
};

// One Orca analyzer per immutable source mesh. Feature recognition remains
// lazy, as in the native gizmo; transforms are applied by Orca itself.
class Geometry : public std::enable_shared_from_this<Geometry> {
public:
    static std::shared_ptr<Geometry> create(std::shared_ptr<const TriangleMesh> mesh);

    const std::shared_ptr<const TriangleMesh>& mesh() const { return m_mesh; }
    std::optional<Feature> feature(std::size_t face, const Vec3d& local_point,
        const Transform3d& world_transform, bool only_plane = false) const;
    Feature reproject(const Feature& feature, const Transform3d& world_transform) const;

private:
    explicit Geometry(std::shared_ptr<const TriangleMesh> mesh);
    Feature attach(Measure::SurfaceFeature surface, const Transform3d& world_transform) const;
    std::shared_ptr<const TriangleMesh> m_mesh;
    Measure::Measuring m_measuring;
};

// The midpoint is the only added feature: its origin remains in mesh space so
// a later transform can update it in the same way as native Orca features.
Feature edge_midpoint(const Feature& edge);

// Mirror the native gizmo: pair measurements use circle-result mode, and a
// lone circle is measured against its center. No display rounding is applied.
std::optional<Measure::MeasurementResult> measurement(const Feature& first,
    const std::optional<Feature>& second = std::nullopt);

} // namespace Slic3r::Neo::Measurement
