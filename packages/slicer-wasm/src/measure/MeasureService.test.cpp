#include "MeasureService.hpp"

#include <iostream>
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

void session_lifecycle_and_ordered_clicks()
{
    Model model; auto* object = model.add_object();
    auto* volume = object->add_volume(TriangleMesh(its_make_cube(10., 10., 10.)));
    auto* instance = object->add_instance();
    const TargetId target{object->id().id, instance->id().id, volume->id().id};
    Service service;
    auto abandoned = service.prepare_open(model, {target});
    const auto abandoned_id = abandoned->id;
    abandoned.reset();
    THROWS(service.require(abandoned_id));
    auto opened = service.prepare_open(model, {target});
    const auto id = opened->id;
    CHECK(id > abandoned_id);
    service.publish_open(std::move(opened));
    CHECK(service.id() == id && service.target_revision() == 1 && service.selection_revision() == 1);
    THROWS(service.prepare_open(model, {}));
    CHECK(service.id() == id);

    auto orphan = service.prepare_display(model, id, top(.05, 4));
    const auto orphan_id = orphan->id;
    orphan.reset();
    THROWS(service.display(id, orphan_id));
    auto edge = service.prepare_display(model, id, top(.05, 4));
    const auto edge_id = edge->id;
    const auto edge_markers = service.require(id).markers(model, edge->snapshot);
    CHECK(edge_markers.size() == 1 && edge_markers[0].item.kind == SelectionKind::Midpoint);
    const auto midpoint = edge_markers[0].position;
    service.publish_display(std::move(edge));

    // A later published selection does not rewrite the identity of the marker
    // that was visible when the next press was captured.
    {
        auto abandoned_click = service.prepare_click(model, id, top(9.95, 9.95), std::nullopt, std::nullopt, false);
        CHECK(abandoned_click.selection && !service.require(id).selection().first());
    }
    CHECK(service.selection_revision() == 1 && !service.require(id).selection().first());
    auto first = service.prepare_click(model, id, top(9.95, 9.95), std::nullopt, std::nullopt, false);
    CHECK(first.outcome == Service::Outcome::Selected && first.revision() == 2 && first.selection->first());
    CHECK(!service.require(id).selection().first());
    service.publish_selection(std::move(first));
    CHECK(service.selection_revision() == 2 && service.require(id).selection().first());
    auto second = service.prepare_click(model, id, top(midpoint.x(), midpoint.y()), edge_id, 0, false);
    CHECK(second.outcome == Service::Outcome::Selected && second.revision() == 3 && second.selection->second());
    CHECK(second.selection->second()->kind == SelectionKind::Midpoint);
    service.publish_selection(std::move(second));
    CHECK(service.require(id).selection().second()->kind == SelectionKind::Midpoint);
    THROWS(service.prepare_click(model, id, top(0, 5), edge_id, 5, false));
    THROWS(service.prepare_click(model, id, top(0, 5), std::nullopt, 0, false));
    auto miss = service.prepare_click(model, id, top(-20, -20), edge_id, std::nullopt, false);
    CHECK(miss.outcome == Service::Outcome::Miss && !miss.selection && miss.revision() == 3);
    service.release_display(id + 1, edge_id); // Wrong owner cannot release a live resource.
    (void)service.display(id, edge_id);
    service.release_display(id, edge_id);
    service.release_display(id, edge_id); // Duplicate releases are safe.
    THROWS(service.display(id, edge_id));

    auto cleared = service.prepare_reset(model, id, Service::Reset::First);
    CHECK(cleared.selection && cleared.selection->first()->kind == SelectionKind::Midpoint && !cleared.selection->second());
    CHECK(service.require(id).selection().second());
    service.publish_selection(std::move(cleared));
    auto no_second = service.prepare_reset(model, id, Service::Reset::Second);
    CHECK(!no_second.selection && no_second.outcome == Service::Outcome::Unchanged);
    service.publish_selection(std::move(no_second));
    CHECK(service.selection_revision() == 4);
    auto escape = service.prepare_reset(model, id, Service::Reset::Escape);
    CHECK(escape.selection && !escape.selection->first());
    service.publish_selection(std::move(escape));
    CHECK(service.prepare_reset(model, id, Service::Reset::Escape).outcome == Service::Outcome::Close);

    auto point_on_plane = service.prepare_click(model, id, top(3, 4), std::nullopt, std::nullopt, true);
    CHECK(point_on_plane.selection && point_on_plane.selection->first()->kind == SelectionKind::PointOnFeature);
    service.publish_selection(std::move(point_on_plane));
    auto clear_all = service.prepare_reset(model, id, Service::Reset::All);
    service.publish_selection(std::move(clear_all));

    auto active = service.prepare_display(model, id, top(.05, 4));
    const auto active_id = active->id;
    service.publish_display(std::move(active));
    auto selected = service.prepare_click(model, id, top(midpoint.x(), midpoint.y()), active_id, 0, false);
    service.publish_selection(std::move(selected));
    const auto before = *service.require(id).selection().first();
    volume->set_scaling_factor(Vec3d(2, 2, 2));
    auto rebased = service.prepare_rebase(model, id);
    CHECK(rebased->session->selection().first()->kind == SelectionKind::Midpoint);
    CHECK(service.require(id).selection().first()->value.surface == before.value.surface);
    CHECK(rebased->session->selection().first()->value.surface.get_point().isApprox(
        instance->get_matrix() * volume->get_matrix() * before.value.surface.origin_surface_feature->get_point()));
    service.publish_rebase(std::move(rebased));
    CHECK(service.target_revision() == 2 && service.require(id).selection().first());
    THROWS(service.display(id, active_id));
    auto replaced = service.prepare_open(model, {target});
    const auto replacement_id = replaced->id;
    service.publish_open(std::move(replaced));
    CHECK(replacement_id > id && !service.require(replacement_id).selection().first());
    THROWS(service.require(id));
    service.reset();
    THROWS(service.require(replacement_id));
    auto after_reset = service.prepare_open(model, {target});
    CHECK(after_reset->id > replacement_id);
}
}

int main()
{
    try { session_lifecycle_and_ordered_clicks(); }
    catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
    std::cout << "Measure service tests passed\n";
    return 0;
}
