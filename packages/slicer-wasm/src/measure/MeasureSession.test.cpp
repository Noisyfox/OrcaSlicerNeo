#include "MeasureSession.hpp"

#include <iostream>
#include <limits>
#include <stdexcept>

#define CHECK(x) do { if (!(x)) throw std::runtime_error("failed: " #x); } while (false)
#define THROWS(x) do { bool caught = false; try { x; } catch (const std::exception&) { caught = true; } CHECK(caught); } while (false)

using namespace Slic3r;
using namespace Slic3r::Neo::Measurement;

namespace {
PointerEvent top(double x, double y)
{
    PointerEvent event;
    event.viewport = Eigen::Vector4d(0, 0, 100, 100);
    event.pointer = Vec2d((x + 40) * 1.25, (40 - y) * 1.25);
    event.projection(0, 0) = .025; event.projection(1, 1) = .025; event.projection(2, 2) = -.01;
    event.view(2, 3) = -100;
    return event;
}

void multi_target_pick_and_staleness()
{
    Model model;
    auto* object = model.add_object();
    auto* first = object->add_volume(TriangleMesh(its_make_cube(10., 10., 10.)));
    auto* second = object->add_volume(TriangleMesh(its_make_cube(10., 10., 10.)));
    second->set_offset(Vec3d(20, 5, 5));
    auto* instance = object->add_instance();
    auto* raised = object->add_instance(); raised->set_offset(Vec3d(0, 0, 20));
    auto* other = model.add_object();
    auto* other_volume = other->add_volume(TriangleMesh(its_make_cube(10., 10., 10.)));
    auto* other_instance = other->add_instance(); other_instance->set_offset(Vec3d(30, 0, 0));
    auto* unrelated = model.add_object();
    auto* unrelated_volume = unrelated->add_volume(TriangleMesh(its_make_cube(2., 2., 2.)));
    unrelated->add_instance();

    const TargetId a{object->id().id, instance->id().id, first->id().id};
    const TargetId b{object->id().id, raised->id().id, first->id().id};
    const TargetId c{object->id().id, instance->id().id, second->id().id};
    const TargetId d{other->id().id, other_instance->id().id, other_volume->id().id};
    THROWS(Session(model, {}));
    THROWS(Session(model, {a, a}));
    THROWS(Session(model, {{a.object, d.instance, a.volume}}));
    THROWS(Session(model, {{a.object, a.instance, d.volume}}));

    std::optional<MeshPick> retained;
    {
        Session session(model, {a, b, c, d});
        CHECK(session.target_count() == 4);
        auto front = session.pick_mesh(model, top(3, 4));
        CHECK(front && front->target == b && front->feature);
        CHECK(front->world.isApprox(Vec3d(3, 4, 30), 1e-5));
        CHECK(front->local.isApprox((raised->get_matrix() * first->get_matrix()).inverse() * front->world, 1e-5));
        CHECK(front->original_facet == 2 || front->original_facet == 3);
        CHECK(front->feature->surface.get_type() == Measure::SurfaceFeatureType::Plane);

        auto below = top(3, 4); below.projection(2, 2) = .01; below.view(2, 3) = -50;
        auto back = session.pick_mesh(model, below);
        CHECK(back && back->target == a && back->feature);
        CHECK(back->original_facet == 0 || back->original_facet == 1);
        CHECK(back->feature->geometry == front->feature->geometry); // sibling instances share the source cache
        auto part = session.pick_mesh(model, top(18, 4));
        CHECK(part && part->target == c && part->world.isApprox(Vec3d(18, 4, 10), 1e-5));
        auto different_object = session.pick_mesh(model, top(33, 4));
        CHECK(different_object && different_object->target == d);
        CHECK(!session.pick_mesh(model, top(-10, 0)));
        auto outside = top(3, 4); outside.pointer.x() = -1;
        CHECK(!session.pick_mesh(model, outside));
        auto invalid = top(3, 4); invalid.view(3, 0) = 1;
        THROWS(session.pick_mesh(model, invalid));
        invalid = top(3, 4); invalid.projection(0, 0) = 0;
        THROWS(session.pick_mesh(model, invalid));
        invalid = top(3, 4); invalid.pointer.x() = std::numeric_limits<double>::infinity();
        THROWS(session.pick_mesh(model, invalid));

        unrelated_volume->set_offset(Vec3d(2, 3, 4));
        session.validate(model); // edits to an unrelated target remain valid
        raised->set_offset(Vec3d(0, 0, 21));
        THROWS(session.pick_mesh(model, top(-10, 0))); // reject stale targets even for a miss
        raised->set_offset(Vec3d(0, 0, 20));
        session.validate(model);
        second->set_offset(Vec3d(20, 5, 6));
        THROWS(session.validate(model));
        second->set_offset(Vec3d(20, 5, 5));
        session.validate(model);
        retained = std::move(front);
        first->set_mesh(TriangleMesh(its_make_cube(11., 10., 10.)));
        THROWS(session.validate(model)); // both instances share the replaced source volume
    }
    CHECK(retained && retained->feature && retained->feature->surface.plane_indices);
    CHECK(!retained->feature->surface.plane_indices->empty());
}

void transformed_target_pick()
{
    Model model; auto* object = model.add_object();
    auto* volume = object->add_volume(TriangleMesh(its_make_cube(10., 10., 10.)));
    auto* instance = object->add_instance();
    volume->set_scaling_factor(Vec3d(2, .5, 1.5)); volume->set_mirror(Vec3d(-1, 1, 1));
    instance->set_offset(Vec3d(5, 0, 3));
    const TargetId id{object->id().id, instance->id().id, volume->id().id};
    Session session(model, {id});
    const Transform3d transform = instance->get_matrix() * volume->get_matrix();
    const Vec3d expected = transform * Vec3d(1, 1, 5);
    const auto hit = session.pick_mesh(model, top(expected.x(), expected.y()));
    CHECK(hit && hit->target == id && hit->feature);
    CHECK(hit->local.isApprox(Vec3d(1, 1, 5), 1e-5));
    CHECK(hit->world.isApprox(expected, 1e-5));
}
}

int main()
{
    try {
        multi_target_pick_and_staleness();
        transformed_target_pick();
        std::cout << "Measure session tests passed\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
