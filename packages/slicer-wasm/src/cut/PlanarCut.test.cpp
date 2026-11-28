#include "libslic3r/CutUtils.hpp"
#include "libslic3r/Geometry.hpp"
#include "libslic3r/TriangleMesh.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <utility>

namespace {
using namespace Slic3r;
using Attribute = ModelObjectCutAttribute;

void require(bool condition, const char* message)
{
    if (!condition)
        throw std::runtime_error(message);
}

ModelObject* fixture(Model& model, TriangleMesh mesh)
{
    ModelObject* object = model.add_object();
    object->add_volume(std::move(mesh));
    object->add_instance();
    return object;
}

void check_solid(const ModelVolume& volume, double expected_volume)
{
    const auto& mesh = volume.mesh().its;
    require(its_num_open_edges(mesh) == 0, "output has open edges");
    require(std::abs(its_volume(mesh) - expected_volume) < expected_volume * 1e-5,
            "unexpected output volume or winding");
}

void cube_case(ModelObjectCutAttributes attributes)
{
    const bool upper = attributes.has(Attribute::KeepUpper);
    const bool lower = attributes.has(Attribute::KeepLower);
    const bool as_parts = attributes.has(Attribute::KeepAsParts);
    Model model;
    auto* cube = fixture(model, make_cube(20., 20., 20.));
    const auto plane = Geometry::translation_transform(Vec3d(0., 0., 8.));
    Cut cut(cube, 0, plane, attributes);
    const auto& result = cut.perform_with_plane();
    require(result.size() == (as_parts ? 1u : size_t(upper) + size_t(lower)), "unexpected object count");
    size_t solids = 0;
    for (const ModelObject* object : result) {
        require(object->instances.size() == 1, "instance lost during cut");
        require(object->volumes.size() == (as_parts ? 2u : 1u), "unexpected part count");
        for (const ModelVolume* part : object->volumes) {
            const bool is_upper = upper && solids == 0;
            const auto bounds = part->mesh().transformed_bounding_box(part->get_matrix());
            require(std::abs(bounds.min.z() - (is_upper ? 8. : 0.)) < 1e-5, "wrong lower bound");
            require(std::abs(bounds.max.z() - (is_upper ? 20. : 8.)) < 1e-5, "wrong upper bound");
            check_solid(*part, is_upper ? 4800. : 3200.);
            ++solids;
        }
    }
    check_solid(*cube->volumes.front(), 8000.);
}

double orient(const Vec3d& a, const Vec3d& b)
{
    return a.x() * b.y() - a.y() * b.x();
}

void tilted_ring_case()
{
    Model model;
    auto* ring = fixture(model, make_torus(10., 3., PI / 24.));
    const double half_volume = its_volume(ring->volumes.front()->mesh().its) / 2.;
    const Transform3d plane = Geometry::rotation_transform(Vec3d(0.11, 0.08, 0.));
    Cut cut(ring, 0, plane, Attribute::KeepUpper | Attribute::KeepLower);
    const auto& result = cut.perform_with_plane();
    require(result.size() == 2, "tilted ring did not produce two objects");
    for (const ModelObject* object : result) {
        require(object->volumes.size() == 1, "tilted ring has unexpected parts");
        const auto& part = *object->volumes.front();
        check_solid(part, half_volume);
        const Transform3d to_plane = plane.inverse() * part.get_matrix();
        const auto& mesh = part.mesh().its;
        size_t cap_facets = 0;
        for (const auto& face : mesh.indices) {
            const Vec3d a = to_plane * mesh.vertices[face[0]].cast<double>();
            const Vec3d b = to_plane * mesh.vertices[face[1]].cast<double>();
            const Vec3d c = to_plane * mesh.vertices[face[2]].cast<double>();
            if (std::max({std::abs(a.z()), std::abs(b.z()), std::abs(c.z())}) > 1e-5)
                continue;
            ++cap_facets;
            // The origin lies inside the bore. Every cap triangle must exclude it.
            const double ab = orient(a, b), bc = orient(b, c), ca = orient(c, a);
            require(std::min({ab, bc, ca}) < 0. && std::max({ab, bc, ca}) > 0.,
                    "cut cap spans the bore");
        }
        require(cap_facets > 0, "tilted ring has no planar cap");
    }
}
}

int main()
{
    try {
        const auto both = Attribute::KeepUpper | Attribute::KeepLower;
        cube_case(both);
        cube_case(Attribute::KeepUpper);
        cube_case(Attribute::KeepLower);
        cube_case(both | Attribute::KeepAsParts);
        tilted_ring_case();
        std::puts("Planar Cut: all five geometry cases passed");
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "Planar Cut: %s\n", error.what());
        return 1;
    }
}
