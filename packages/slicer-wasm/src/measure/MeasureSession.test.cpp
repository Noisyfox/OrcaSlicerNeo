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
        session.choose(model, point_item(b, *front->feature, front->world));
        session.choose(model, point_item(a, *back->feature, back->world));
        auto nearest_marker = session.pick_marker(model, top(3, 4), std::nullopt, 1);
        CHECK(nearest_marker && nearest_marker->index == 0 && nearest_marker->marker.item.target == b);
        session.clear_selection();
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

indexed_triangle_set tube()
{
    constexpr int count = 36;
    indexed_triangle_set mesh;
    for (const auto [radius, height] : {std::pair{7.f, 0.f}, {7.f, 10.f}, {3.f, 0.f}, {3.f, 10.f}}) {
        for (int i = 0; i < count; ++i) {
            const float angle = float(2 * PI * i / count);
            mesh.vertices.emplace_back(radius * std::cos(angle), radius * std::sin(angle), height);
        }
    }
    for (int i = 0; i < count; ++i) {
        const int j = (i + 1) % count;
        const int ob = i, ob2 = j, ot = count + i, ot2 = count + j;
        const int ib = 2 * count + i, ib2 = 2 * count + j, it = 3 * count + i, it2 = 3 * count + j;
        mesh.indices.insert(mesh.indices.end(), {
            Vec3i32(ob, ob2, ot), Vec3i32(ob2, ot2, ot),
            Vec3i32(ib, it, ib2), Vec3i32(ib2, it, it2),
            Vec3i32(ot, ot2, it), Vec3i32(ot2, it2, it),
            Vec3i32(ob, ib, ob2), Vec3i32(ob2, ib, ib2),
        });
    }
    return mesh;
}

void off_mesh_center_and_midpoint_picking()
{
    Model model; auto* object = model.add_object();
    auto* volume = object->add_volume(TriangleMesh(tube())); auto* instance = object->add_instance();
    const TargetId id{object->id().id, instance->id().id, volume->id().id};
    Session session(model, {id});
    auto hover = session.pick_mesh(model, top(3.1, .5));
    CHECK(hover && hover->feature && hover->feature->surface.get_type() == Measure::SurfaceFeatureType::Circle);
    CHECK(!session.pick_mesh(model, top(2.5, .5)));
    auto circle_gripper = session.pick_gripper(model, top(2.5, .5), hover);
    CHECK(circle_gripper && circle_gripper->source.surface.get_type() == Measure::SurfaceFeatureType::Circle);
    const auto [circle_center, circle_radius, circle_normal] = circle_gripper->source.surface.get_circle();
    CHECK(std::abs((circle_gripper->point_on_feature - circle_center).norm() - circle_radius) < 1e-8);
    CHECK(std::abs((circle_gripper->point_on_feature - circle_center).dot(circle_normal)) < 1e-8);
    CHECK(!session.pick_mesh(model, top(0, 0))); // The ring center lies in empty space.
    auto visible = session.markers(model, hover);
    CHECK(visible.size() == 1 && visible[0].item.kind == SelectionKind::Center);
    auto center = session.pick_marker(model, top(0, 0), hover);
    CHECK(center && center->marker.item.kind == SelectionKind::Center);
    auto click = session.pick(model, top(0, 0), hover);
    CHECK(click && std::holds_alternative<MarkerHit>(*click));
    CHECK(!session.pick(model, top(30, 30), hover)); // A stale hover cannot select a moved click.
    auto offset_viewport = top(0, 0);
    offset_viewport.viewport = Eigen::Vector4d(20, 30, 120, 80);
    offset_viewport.pointer = Vec2d(80, 70);
    CHECK(session.pick_marker(model, offset_viewport, hover));
    auto perspective = top(0, 0);
    perspective.projection.setZero();
    perspective.projection(0, 0) = 1.3; perspective.projection(1, 1) = 1.3;
    perspective.projection(2, 2) = -201. / 199.; perspective.projection(2, 3) = -400. / 199.;
    perspective.projection(3, 2) = -1.;
    CHECK(session.pick_marker(model, perspective, hover));
    CHECK(!session.pick_marker(model, top(10, 10), hover));
    auto moved_camera = top(0, 0); moved_camera.view(0, 3) = -20;
    CHECK(!session.pick_marker(model, moved_camera, hover)); // use the click's camera, not hover's
    THROWS(session.pick_marker(model, top(0, 0), hover, 1));
    session.choose(model, center->marker.item);
    CHECK(session.selection().first()->kind == SelectionKind::Center);
    auto selected_center = session.pick_marker(model, top(0, 0));
    CHECK(selected_center);
    session.choose(model, selected_center->marker.item);
    CHECK(!session.selection().first());

    Model box; auto* box_object = box.add_object();
    auto* box_volume = box_object->add_volume(TriangleMesh(its_make_cube(10., 10., 10.)));
    auto* box_instance = box_object->add_instance();
    const TargetId box_id{box_object->id().id, box_instance->id().id, box_volume->id().id};
    Session box_session(box, {box_id});
    auto edge = box_session.pick_mesh(box, top(.05, 4));
    CHECK(edge && edge->feature && edge->feature->surface.get_type() == Measure::SurfaceFeatureType::Edge);
    CHECK(!box_session.pick_mesh(box, top(-2, 4)));
    auto edge_gripper = box_session.pick_gripper(box, top(-2, 4), edge);
    CHECK(edge_gripper && edge_gripper->source.surface.get_type() == Measure::SurfaceFeatureType::Edge);
    CHECK(edge_gripper->point_on_feature.isApprox(Vec3d(0, 4, 10), 1e-5));
    auto point = box_session.pick_mesh(box, top(9.95, 9.95));
    CHECK(point && point->feature && point->feature->surface.get_type() == Measure::SurfaceFeatureType::Point);
    box_session.choose(box, feature_item(box_id, *edge->feature));
    box_session.choose(box, feature_item(box_id, *point->feature));
    const auto [start, end] = edge->feature->surface.get_edge();
    const Vec3d midpoint = (start + end) * .5;
    const auto markers = box_session.markers(box, edge);
    std::size_t midpoint_index = markers.size();
    for (std::size_t i = 0; i < markers.size(); ++i)
        if (markers[i].item.kind == SelectionKind::Midpoint) midpoint_index = i;
    CHECK(midpoint_index < markers.size());
    auto midpoint_hit = box_session.pick_marker(box, top(midpoint.x(), midpoint.y()), edge, midpoint_index);
    CHECK(midpoint_hit && midpoint_hit->marker.item.kind == SelectionKind::Midpoint);
    box_session.choose(box, midpoint_hit->marker.item);
    CHECK(box_session.selection().first()->kind == SelectionKind::Midpoint && box_session.selection().second());

    // Co-located polygon center and midpoint remain separate native identities.
    auto overlapping = *edge;
    auto same_position = Feature{edge->feature->geometry, Measure::SurfaceFeature(Measure::SurfaceFeatureType::Edge,
        start, end, midpoint)};
    same_position.surface.world_tran = edge->feature->surface.world_tran;
    same_position.surface.origin_surface_feature = edge->feature->surface.origin_surface_feature;
    overlapping.feature = same_position;
    box_session.clear_selection();
    auto candidates = box_session.markers(box, overlapping);
    CHECK(candidates.size() == 2 && candidates[0].item.kind == SelectionKind::Center &&
        candidates[1].item.kind == SelectionKind::Midpoint);
    auto center_hint = box_session.pick_marker(box, top(midpoint.x(), midpoint.y()), overlapping, 0);
    auto midpoint_hint = box_session.pick_marker(box, top(midpoint.x(), midpoint.y()), overlapping, 1);
    CHECK(center_hint && center_hint->marker.item.kind == SelectionKind::Center);
    CHECK(midpoint_hint && midpoint_hint->marker.item.kind == SelectionKind::Midpoint);

    // Plane grippers use Orca's 0.05 local-unit overlay, even after the
    // selected plane is no longer the current mesh hover.
    auto plane = box_session.pick_mesh(box, top(3, 4));
    CHECK(plane && plane->feature && plane->feature->surface.get_type() == Measure::SurfaceFeatureType::Plane);
    box_session.choose(box, feature_item(box_id, *plane->feature));
    auto plane_gripper = box_session.pick_gripper(box, top(3, 4));
    CHECK(plane_gripper && plane_gripper->source.surface.get_type() == Measure::SurfaceFeatureType::Plane);
    CHECK(plane_gripper->point_on_feature.isApprox(Vec3d(3, 4, 10.05), 1e-5));
    auto zoomed = top(.05, 2);
    zoomed.projection(0, 0) = .1; zoomed.projection(1, 1) = .1;
    zoomed.pointer = Vec2d((.05 + 10) * 5, (10 - 2) * 5);
    auto edge_over_plane = box_session.pick(box, zoomed, edge);
    CHECK(edge_over_plane && std::holds_alternative<GripperHit>(*edge_over_plane));
    CHECK(std::get<GripperHit>(*edge_over_plane).source.surface.get_type() == Measure::SurfaceFeatureType::Edge);
    box_session.choose(box, point_item(box_id, plane_gripper->source, plane_gripper->point_on_feature));
    CHECK(box_session.selection().second()->kind == SelectionKind::PointOnFeature);
    box_session.clear_selection();

    // In perspective, Orca projects the cylinder hit onto its axis. That may
    // differ from the nearest point on the projected center line.
    auto inclined = *edge;
    Feature diagonal{edge->feature->geometry, Measure::SurfaceFeature(Measure::SurfaceFeatureType::Edge,
        Vec3d(-4, 0, 20), Vec3d(4, 0, 60))};
    diagonal.surface.world_tran = edge->feature->surface.world_tran;
    inclined.feature = diagonal;
    auto perspective_edge = top(0, 0);
    perspective_edge.projection.setZero();
    perspective_edge.projection(0, 0) = 1.3; perspective_edge.projection(1, 1) = 1.3;
    perspective_edge.projection(2, 2) = -201. / 199.; perspective_edge.projection(2, 3) = -400. / 199.;
    perspective_edge.projection(3, 2) = -1.;
    perspective_edge.pointer = Vec2d((46.75 + 56.5) / 2., 50);
    auto perspective_hit = box_session.pick_gripper(box, perspective_edge, inclined);
    CHECK(perspective_hit);
    const Vec3d axis = Vec3d(8, 0, 40), offset = perspective_hit->point_on_feature - Vec3d(-4, 0, 20);
    CHECK(offset.cross(axis).norm() < 1e-6 && offset.dot(axis) >= 0 && offset.dot(axis) <= axis.squaredNorm());
    CHECK(!perspective_hit->point_on_feature.isApprox(Vec3d(4. / 3., 0, 140. / 3.), 1e-3));
    diagonal.surface = Measure::SurfaceFeature(Measure::SurfaceFeatureType::Edge, Vec3d(0, 0, 20), Vec3d(0, 0, 60));
    diagonal.surface.world_tran = edge->feature->surface.world_tran;
    inclined.feature = diagonal;
    perspective_edge.pointer = Vec2d(50, 50);
    auto end_on = box_session.pick_gripper(box, perspective_edge, inclined);
    CHECK(end_on && end_on->point_on_feature.isApprox(Vec3d(0, 0, 60), 1e-5));

    auto tilted = *edge;
    const Vec3d tilted_normal(0, std::sqrt(.5), std::sqrt(.5));
    Feature tilted_circle{edge->feature->geometry, Measure::SurfaceFeature(Measure::SurfaceFeatureType::Circle,
        Vec3d(5, 5, 10), tilted_normal, std::nullopt, 3.)};
    tilted_circle.surface.world_tran = edge->feature->surface.world_tran;
    tilted.feature = tilted_circle;
    auto tilted_event = zoomed; tilted_event.pointer = Vec2d(90, 25);
    auto tilted_hit = box_session.pick_gripper(box, tilted_event, tilted);
    CHECK(tilted_hit && std::abs((tilted_hit->point_on_feature - Vec3d(5, 5, 10)).norm() - 3.) < 1e-8);
    CHECK(std::abs((tilted_hit->point_on_feature - Vec3d(5, 5, 10)).dot(tilted_normal)) < 1e-8);
}

void large_plane_gripper()
{
    // Exercise a plane spanning more than one overlay chunk, with the hit in
    // the second chunk. Chunking limits individual indices, not mesh size.
    constexpr int width = 190;
    constexpr int layer_vertices = (width + 1) * (width + 1);
    indexed_triangle_set mesh;
    for (int z = 0; z <= 1; ++z) for (int y = 0; y <= width; ++y)
        for (int x = 0; x <= width; ++x) mesh.vertices.emplace_back(x * .1f, y * .1f, float(z));
    for (int y = 0; y < width; ++y) for (int x = 0; x < width; ++x) {
        const int first = y * (width + 1) + x;
        mesh.indices.emplace_back(first + layer_vertices, first + 1 + layer_vertices, first + width + 1 + layer_vertices);
        mesh.indices.emplace_back(first + 1 + layer_vertices, first + width + 2 + layer_vertices, first + width + 1 + layer_vertices);
        mesh.indices.emplace_back(first, first + width + 1, first + 1);
        mesh.indices.emplace_back(first + 1, first + width + 1, first + width + 2);
    }
    auto side = [&](int a, int b) {
        mesh.indices.emplace_back(a, b, a + layer_vertices);
        mesh.indices.emplace_back(b, b + layer_vertices, a + layer_vertices);
    };
    for (int i = 0; i < width; ++i) {
        side(i, i + 1);
        side(i * (width + 1) + width, (i + 1) * (width + 1) + width);
        side(width * (width + 1) + width - i, width * (width + 1) + width - i - 1);
        side((width - i) * (width + 1), (width - i - 1) * (width + 1));
    }
    Model model; auto* object = model.add_object();
    auto* volume = object->add_volume(TriangleMesh(mesh)); auto* instance = object->add_instance();
    const TargetId id{object->id().id, instance->id().id, volume->id().id};
    Session session(model, {id});
    auto pick = session.pick_mesh(model, top(10.05, 18.05));
    CHECK(pick && pick->feature && pick->feature->surface.get_type() == Measure::SurfaceFeatureType::Plane);
    CHECK(pick->feature->surface.plane_indices->size() > 65536);
    session.choose(model, feature_item(id, *pick->feature));
    auto hit = session.pick_gripper(model, top(10.05, 18.05));
    CHECK(hit && hit->point_on_feature.isApprox(Vec3d(10.05, 18.05, 1.05), 1e-4));
}

void upstream_mesh_pick_rules()
{
    Model open_model; auto* open_object = open_model.add_object();
    auto open_mesh = its_make_cube(10., 10., 10.);
    open_mesh.indices.erase(open_mesh.indices.begin() + 2, open_mesh.indices.begin() + 4);
    auto* open_volume = open_object->add_volume(TriangleMesh(open_mesh)); auto* open_instance = open_object->add_instance();
    const TargetId open_id{open_object->id().id, open_instance->id().id, open_volume->id().id};
    Session open_session(open_model, {open_id});
    CHECK(!open_session.pick_mesh(open_model, top(3, 4))); // Orca ignores an unpaired mesh hit.

    Model sunk; auto* object = sunk.add_object();
    auto* volume = object->add_volume(TriangleMesh(its_make_cube(10., 10., 10.)));
    auto* instance = object->add_instance(); instance->set_offset(Vec3d(0, 0, -5));
    const TargetId id{object->id().id, instance->id().id, volume->id().id};
    Session session(sunk, {id});
    auto visible = session.pick_mesh(sunk, top(3, 4));
    CHECK(visible && visible->world.isApprox(Vec3d(3, 4, 5), 1e-5));
    auto below = top(3, 4); below.projection(2, 2) = .01; below.view(2, 3) = -50;
    CHECK(!session.pick_mesh(sunk, below)); // Below-bed intersections are filtered before pairing.
}

void scale_rebases_selections()
{
    Model model; auto* object = model.add_object();
    auto* volume = object->add_volume(TriangleMesh(its_make_cube(10., 10., 10.)));
    auto* instance = object->add_instance();
    auto* other_instance = object->add_instance(); other_instance->set_offset(Vec3d(20, 0, 0));
    const TargetId id{object->id().id, instance->id().id, volume->id().id};
    const TargetId other_id{object->id().id, other_instance->id().id, volume->id().id};
    Session session(model, {id, other_id});
    auto edge = session.pick_mesh(model, top(.05, 4));
    auto point = session.pick_mesh(model, top(9.95, 9.95));
    CHECK(edge && edge->feature && edge->feature->surface.get_type() == Measure::SurfaceFeatureType::Edge);
    CHECK(point && point->feature && point->feature->surface.get_type() == Measure::SurfaceFeatureType::Point);
    session.choose(model, midpoint_item(id, *edge->feature));
    session.choose(model, feature_item(id, *point->feature));
    const auto old_first = *session.selection().first();
    const auto old_second = *session.selection().second();
    CHECK(old_first.value.surface.origin_surface_feature && old_second.value.surface.origin_surface_feature);
    const Vec3d local_midpoint = old_first.value.surface.origin_surface_feature->get_point();
    const Vec3d local_point = old_second.value.surface.origin_surface_feature->get_point();

    volume->set_scaling_factor(Vec3d(2, .5, 1.5)); volume->set_mirror(Vec3d(-1, 1, 1));
    instance->set_offset(Vec3d(3, 4, 5));
    other_instance->set_scaling_factor(Vec3d(.75, .75, .75));
    THROWS(session.validate(model));
    auto staged = session.rebase_after_scale(model);
    staged->validate(model);
    CHECK(staged->target_count() == 2);
    const Transform3d transform = instance->get_matrix() * volume->get_matrix();
    CHECK(staged->selection().first()->kind == SelectionKind::Midpoint && staged->selection().second());
    CHECK(staged->selection().first()->value.surface.get_point().isApprox(transform * local_midpoint));
    CHECK(staged->selection().second()->value.surface.get_point().isApprox(transform * local_point));
    CHECK(staged->selection().first()->source.geometry == old_first.source.geometry); // no mesh/cache rebuild
    CHECK(session.selection().first()->value.surface == old_first.value.surface); // staging did not mutate live state
    auto result = staged->selection().result();
    CHECK(result && result->distance_strict &&
        std::abs(result->distance_strict->dist - (transform * local_point - transform * local_midpoint).norm()) < 1e-9);
    volume->set_mesh(TriangleMesh(its_make_cube(11., 10., 10.)));
    THROWS(staged->rebase_after_scale(model));
    CHECK(staged->selection().first()->kind == SelectionKind::Midpoint);
}
}

int main()
{
    try {
        multi_target_pick_and_staleness();
        transformed_target_pick();
        selection_semantics();
        off_mesh_center_and_midpoint_picking();
        large_plane_gripper();
        upstream_mesh_pick_rules();
        scale_rebases_selections();
        std::cout << "Measure session tests passed\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
