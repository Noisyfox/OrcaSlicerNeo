#include "MeasureGeometry.hpp"

#include <cmath>
#include <iostream>
#include <stdexcept>

#define CHECK(x) do { if (!(x)) throw std::runtime_error("failed: " #x); } while (false)

using namespace Slic3r;
using namespace Slic3r::Neo::Measurement;

namespace {
Vec3d vertex(const indexed_triangle_set& mesh, int index)
{
    return mesh.vertices[index].cast<double>();
}

void cube_features_and_lifetime()
{
    auto mesh = std::make_shared<TriangleMesh>(its_make_cube(10., 10., 10.));
    auto geometry = Geometry::create(mesh);
    std::weak_ptr<const Geometry> weak = geometry;
    const auto triangle = mesh->its.indices[0];
    const Vec3d a = vertex(mesh->its, triangle[0]);
    const Vec3d b = vertex(mesh->its, triangle[1]);
    const Vec3d c = vertex(mesh->its, triangle[2]);

    // Include non-uniform scale, mirroring and shear. This intentionally uses
    // the pinned Orca transform, including its current affine limitations.
    Transform3d transform = Transform3d::Identity();
    transform.linear() << -1.5, .3, 0, 0, .7, .2, 0, 0, 1.25;
    transform.translation() = Vec3d(2, -3, 4);
    Measure::Measuring reference(mesh->its);
    auto plane = geometry->feature(0, (a + b + c) / 3., transform, true);
    CHECK(plane && plane->surface.get_type() == Measure::SurfaceFeatureType::Plane);
    auto expected = reference.get_feature(0, (a + b + c) / 3., transform, true);
    CHECK(expected && plane->surface == *expected);
    CHECK(plane->surface.plane_indices && !plane->surface.plane_indices->empty());
    CHECK(plane->surface.world_plane_features && !plane->surface.world_plane_features->empty());
    const int plane_id = std::get<0>(plane->surface.get_plane());
    const auto& boundaries = reference.get_plane_features(plane_id);
    CHECK(boundaries.size() == plane->surface.world_plane_features->size());
    for (std::size_t i = 0; i < boundaries.size(); ++i) {
        auto native = boundaries[i]; native.translate(transform);
        CHECK(native == plane->surface.world_plane_features->at(i));
    }
    CHECK(!measurement(*plane));
    CHECK(!geometry->feature(mesh->its.indices.size(), a, transform));

    const Measure::SurfaceFeature* source_edge = nullptr;
    for (const auto& boundary : boundaries) {
        if (boundary.get_type() == Measure::SurfaceFeatureType::Edge) { source_edge = &boundary; break; }
    }
    CHECK(source_edge);
    const auto [start, end] = source_edge->get_edge();
    auto edge = geometry->feature(0, (start + end) * .5, transform);
    auto native_edge = reference.get_feature(0, (start + end) * .5, transform, false);
    CHECK(edge && native_edge && edge->surface.get_type() == Measure::SurfaceFeatureType::Edge);
    CHECK(edge->surface == *native_edge);
    auto middle = edge_midpoint(*edge);
    CHECK(middle.surface.get_type() == Measure::SurfaceFeatureType::Point);
    CHECK(middle.surface.get_point().isApprox((transform * start + transform * end) * .5));
    CHECK(middle.surface.origin_surface_feature);
    CHECK(middle.surface.origin_surface_feature->get_point().isApprox((start + end) * .5));

    auto first = geometry->feature(0, a, transform);
    auto second = geometry->feature(0, b, transform);
    CHECK(first && second && first->surface.get_type() == Measure::SurfaceFeatureType::Point &&
        second->surface.get_type() == Measure::SurfaceFeatureType::Point);
    auto result = measurement(*first, *second);
    CHECK(result && result->distance_strict && result->distance_xyz);
    CHECK(std::abs(result->distance_strict->dist - (transform * b - transform * a).norm()) < 1e-9);

    // A nonparallel edge/plane pair makes Orca traverse the transformed plane
    // boundaries; omitting the GUI's world-plane setup would dereference null.
    auto flat = geometry->feature(0, (a + b + c) / 3., Transform3d::Identity(), true);
    CHECK(flat);
    const auto [index, normal, origin] = flat->surface.get_plane();
    const Vec3d axis = std::abs(normal.z()) < .9 ? Vec3d::UnitZ() : Vec3d::UnitX();
    const Vec3d tangent = normal.cross(axis).normalized();
    Feature crossing{geometry, Measure::SurfaceFeature(Measure::SurfaceFeatureType::Edge,
        origin + normal * 3. + tangent, origin - normal * 4. + tangent * 2.)};
    auto edge_plane = measurement(crossing, *flat);
    CHECK(edge_plane && edge_plane->angle && edge_plane->distance_infinite);
    CHECK(std::isfinite(edge_plane->distance_infinite->dist));
    (void)index;

    // Drop the caller's mesh and analyzer ownership; selected planes still
    // own the cache their triangle indices and transformed boundary refer to.
    mesh.reset(); geometry.reset();
    CHECK(!weak.expired());
    CHECK(!plane->surface.plane_indices->empty());
    CHECK(plane->surface.world_plane_features->size() == boundaries.size());
}

void circle_measurements()
{
    auto mesh = std::make_shared<TriangleMesh>(its_make_cylinder(5., 10., 2 * PI / 36));
    auto geometry = Geometry::create(mesh);
    Measure::Measuring reference(mesh->its);
    Transform3d transform = Transform3d::Identity();
    transform.linear() << 1.5, .2, 0, 0, .7, 0, 0, 0, -1;
    transform.translation() = Vec3d(4, 3, 2);

    std::optional<Feature> circle;
    for (int plane = 0; plane < reference.get_num_of_planes() && !circle; ++plane) {
        for (const auto& boundary : reference.get_plane_features(plane)) {
            if (boundary.get_type() != Measure::SurfaceFeatureType::Circle) continue;
            const auto [center, radius, normal] = boundary.get_circle();
            const Vec3d axis = std::abs(normal.z()) < .9 ? Vec3d::UnitZ() : Vec3d::UnitX();
            const Vec3d point = center + radius * normal.cross(axis).normalized();
            const auto face = reference.get_plane_triangle_indices(plane).front();
            auto native = reference.get_feature(face, point, transform, false);
            auto candidate = geometry->feature(face, point, transform);
            if (!candidate || candidate->surface.get_type() != Measure::SurfaceFeatureType::Circle) continue;
            CHECK(native && candidate->surface == *native);
            circle = std::move(candidate);
            break;
        }
    }
    CHECK(circle);
    const auto [center, radius, normal] = circle->surface.get_circle();
    auto single = measurement(*circle);
    CHECK(single && single->distance_strict);
    CHECK(std::abs(single->distance_strict->dist - radius) < 1e-9);

    // The GUI asks Orca for center-based circle results when two features are
    // selected, without rounding the native distance to the displayed digits.
    Feature point{geometry, Measure::SurfaceFeature(center + Vec3d(3, 4, 7))};
    auto pair = measurement(point, *circle);
    CHECK(pair && pair->distance_strict);
    CHECK(std::abs(pair->distance_strict->dist - std::sqrt(74.)) < 1e-9);
    (void)normal;
}
}

int main()
{
    try {
        cube_features_and_lifetime();
        circle_measurements();
        std::cout << "Measure geometry tests passed\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
