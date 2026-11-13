#include "MeasureSession.hpp"

#include <cmath>
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
        CHECK(part->feature);
        session.choose(model, feature_item(front->target, *front->feature));
        session.choose(model, feature_item(part->target, *part->feature));
        CHECK(session.selection().first() && session.selection().second() && !session.selection().same_target());
        Feature foreign{Slic3r::Neo::Measurement::Geometry::create(first->mesh_ptr()), front->feature->surface};
        THROWS(session.choose(model, feature_item(b, foreign)));
        session.clear_selection();
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

void selection_semantics()
{
    auto geometry = Slic3r::Neo::Measurement::Geometry::create(std::make_shared<TriangleMesh>(its_make_cube(10., 10., 10.)));
    const TargetId one{1, 2, 3}, other{1, 2, 4};
    Feature edge{geometry, Measure::SurfaceFeature(Measure::SurfaceFeatureType::Edge,
        Vec3d(0, 0, 0), Vec3d(10, 0, 0), Vec3d(5, 5, 0))};
    edge.surface.origin_surface_feature = std::make_shared<Measure::SurfaceFeature>(edge.surface);
    Feature point_b{geometry, Measure::SurfaceFeature(Vec3d(0, 0, 10))};
    Feature point_c{geometry, Measure::SurfaceFeature(Vec3d(0, 3, 10))};
    SelectionState state;
    CHECK(!state.escape());
    state.choose(feature_item(one, edge));
    state.choose(feature_item(one, point_b));
    CHECK(state.first() && state.second() && state.same_target());

    state.choose(midpoint_item(one, edge));
    CHECK(state.first()->kind == SelectionKind::Midpoint && state.second()->value.surface == point_b.surface);
    CHECK(state.first()->value.surface.get_point().isApprox(Vec3d(5, 0, 0)));
    auto distance = state.result();
    CHECK(distance && distance->distance_strict && std::abs(distance->distance_strict->dist - std::sqrt(125.)) < 1e-9);
    state.choose(center_item(one, edge));
    CHECK(state.first()->kind == SelectionKind::Center && state.second()->value.surface == point_b.surface);
    CHECK(state.first()->value.surface.get_point().isApprox(Vec3d(5, 5, 0)));
    state.choose(feature_item(one, edge));
    CHECK(state.first()->kind == SelectionKind::Feature && state.second());
    state.choose(feature_item(one, point_c));
    CHECK(state.first()->value.surface == edge.surface && state.second()->value.surface == point_c.surface);
    state.choose(feature_item(one, edge)); // removing first promotes second, as in Orca
    CHECK(state.first() && state.first()->value.surface == point_c.surface && !state.second());
    state.choose(feature_item(one, point_b));
    state.choose(feature_item(one, point_b)); // selecting the second again clears it
    CHECK(state.first() && !state.second());
    state.choose(feature_item(other, point_b));
    CHECK(!state.same_target());
    CHECK(state.escape() && state.first() && !state.second());
    CHECK(state.escape() && !state.first());
    CHECK(!state.escape());

    state.choose(midpoint_item(one, edge)); // direct midpoint selection needs no prior edge slot
    CHECK(state.first()->kind == SelectionKind::Midpoint && !state.second());
    state.choose(feature_item(one, edge));
    CHECK(state.first()->kind == SelectionKind::Feature && !state.second());
    state.clear();
    state.choose(feature_item(one, point_b));
    state.choose(point_item(one, point_b, point_b.surface.get_point()));
    CHECK(!state.first()); // the same native point remains a toggle in Shift mode

    Feature circle{geometry, Measure::SurfaceFeature(Measure::SurfaceFeatureType::Circle,
        Vec3d(2, 3, 4), Vec3d::UnitZ(), std::nullopt, 5.)};
    state.choose(feature_item(one, circle));
    auto radius = state.result();
    CHECK(radius && radius->distance_strict && std::abs(radius->distance_strict->dist - 5.) < 1e-9);
    state.choose(center_item(one, circle));
    CHECK(state.first()->kind == SelectionKind::Center && !state.result());
    state.choose(feature_item(one, circle));
    CHECK(state.first()->kind == SelectionKind::Feature && !state.second());
}
}

int main()
{
    try {
        multi_target_pick_and_staleness();
        transformed_target_pick();
        selection_semantics();
        std::cout << "Measure session tests passed\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
