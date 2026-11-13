#include "MeasureGeometry.hpp"

#include <stdexcept>

namespace Slic3r::Neo::Measurement {
namespace {
const indexed_triangle_set& checked_its(const std::shared_ptr<const TriangleMesh>& mesh)
{
    if (!mesh) throw std::invalid_argument("measurement source mesh is unavailable");
    return mesh->its;
}
}

Geometry::Geometry(std::shared_ptr<const TriangleMesh> mesh)
    : m_mesh(std::move(mesh)), m_measuring(checked_its(m_mesh))
{}

std::shared_ptr<Geometry> Geometry::create(std::shared_ptr<const TriangleMesh> mesh)
{
    return std::shared_ptr<Geometry>(new Geometry(std::move(mesh)));
}

std::optional<Feature> Geometry::feature(std::size_t face, const Vec3d& local_point,
    const Transform3d& world_transform, bool only_plane) const
{
    auto surface = m_measuring.get_feature(face, local_point, world_transform, only_plane);
    if (!surface) return std::nullopt;
    surface->world_tran = world_transform;
    if (surface->get_type() == Measure::SurfaceFeatureType::Plane) {
        const int plane = std::get<0>(surface->get_plane());
        // Orca's GUI associates the plane with its source triangle indices and
        // transformed boundary features before asking for pair measurements.
        surface->plane_indices = const_cast<std::vector<int>*>(&m_measuring.get_plane_triangle_indices(plane));
        surface->world_plane_features = std::make_shared<std::vector<Measure::SurfaceFeature>>();
        const auto& boundary = m_measuring.get_plane_features(plane);
        surface->world_plane_features->reserve(boundary.size());
        for (const auto& source : boundary) {
            auto transformed = source;
            transformed.translate(world_transform);
            surface->world_plane_features->push_back(std::move(transformed));
        }
    }
    return Feature{shared_from_this(), std::move(*surface)};
}

Feature edge_midpoint(const Feature& edge)
{
    if (edge.surface.get_type() != Measure::SurfaceFeatureType::Edge)
        throw std::invalid_argument("measurement midpoint requires an edge");
    const auto [start, end] = edge.surface.get_edge();
    Measure::SurfaceFeature point((start + end) * 0.5);
    point.volume = edge.surface.volume;
    point.world_tran = edge.surface.world_tran;
    if (edge.surface.origin_surface_feature) {
        const auto [local_start, local_end] = edge.surface.origin_surface_feature->get_edge();
        point.origin_surface_feature = std::make_shared<Measure::SurfaceFeature>((local_start + local_end) * 0.5);
    }
    return {edge.geometry, std::move(point)};
}

std::optional<Measure::MeasurementResult> measurement(const Feature& first, const std::optional<Feature>& second)
{
    if (second) return Measure::get_measurement(first.surface, second->surface, true);
    if (first.surface.get_type() != Measure::SurfaceFeatureType::Circle) return std::nullopt;
    const auto [center, radius, normal] = first.surface.get_circle();
    (void)radius;
    (void)normal;
    return Measure::get_measurement(first.surface, Measure::SurfaceFeature(center));
}

} // namespace Slic3r::Neo::Measurement
