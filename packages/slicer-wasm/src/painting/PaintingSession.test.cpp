#include "PaintingSession.hpp"
#include <iostream>
#include <stdexcept>

#define CHECK(x) do { if (!(x)) throw std::runtime_error("failed: " #x); } while(false)
#define THROWS(x) do { bool caught = false; try { x; } catch(const std::exception&) { caught = true; } CHECK(caught); } while(false)
using namespace Slic3r;
using namespace Slic3r::Neo::Painting;

namespace {
PointerEvent top(double x, double y) {
    PointerEvent event;
    event.viewport = Eigen::Vector4d(0, 0, 100, 100);
    event.pointer = Vec2d((x + 20) * 2.5, (20 - y) * 2.5);
    event.projection(0, 0) = .05; event.projection(1, 1) = .05; event.projection(2, 2) = -.01;
    event.view(2, 3) = -100;
    return event;
}
struct Fixture {
    Model model;
    ModelObject* object = model.add_object();
    ModelVolume* part = object->add_volume(TriangleMesh(its_make_cube(10., 10., 10.)));
    ModelInstance* instance = object->add_instance();
    Sessions sessions;
    void open() { sessions.publish(sessions.prepare_open(model, object->id().id, instance->id().id, 2, 1)); }
    const Session& s() { return *sessions.current(); }
    void begin(Tool tool, const Settings& settings, std::optional<PointerEvent> event = {}) {
        sessions.publish(sessions.prepare_begin(s().id, s().revision, tool, settings, event));
    }
    void sample(const Settings& settings, PointerEvent event) {
        sessions.publish(sessions.prepare_sample(s().id, s().revision, s().active_stroke_id, settings, event));
    }
    void cancel() { sessions.publish(sessions.prepare_cancel(s().id, s().revision, s().active_stroke_id)); }
    void finish() { sessions.publish(sessions.prepare_finish(s().id, s().revision, s().active_stroke_id)); }
    void preview(Tool tool, Settings settings, std::optional<PointerEvent> event = {}) {
        sessions.publish(sessions.prepare_preview(s().id, s().revision, tool, settings, event));
    }
};
void engine_tests() {
    Settings settings;
    Fixture f;
    auto* second = f.object->add_volume(TriangleMesh(its_make_cube(4., 4., 4.)));
    second->set_offset(Vec3d(12, 0, 0));
    auto* modifier = f.object->add_volume(TriangleMesh(its_make_cube(18., 10., 20.)));
    modifier->set_type(ModelVolumeType::PARAMETER_MODIFIER);
    f.object->printable = false; f.instance->printable = false;
    f.open();
    const auto original = f.part->mmu_segmentation_facets.get_data();
    const auto timestamp = f.part->mmu_segmentation_facets.timestamp();
    const auto hit = f.sessions.pick(f.s(), top(3, 4));
    CHECK(hit && hit->part == 0 && std::abs(hit->world.z() - 10) < 1e-5);
    CHECK(hit->original_facet >= 0 && hit->original_facet < 12);
    CHECK(f.sessions.pick(f.s(), top(13, 2))->part == 1);
    Fixture perspective;
    auto* foreground = perspective.object->add_volume(TriangleMesh(its_make_cube(4.,4.,4.)));
    foreground->set_offset(Vec3d(5,5,30));
    perspective.open();
    auto pe = top(0,0);
    pe.projection.setZero();
    pe.projection(0,0) = 1; pe.projection(1,1) = 1;
    pe.projection(2,2) = -501./499.; pe.projection(2,3) = -1000./499.; pe.projection(3,2) = -1;
    pe.pointer = Vec2d(50. + 5./68.*50., 50. - 5./68.*50.);
    const auto perspective_hit = perspective.sessions.pick(perspective.s(), pe);
    CHECK(perspective_hit && perspective_hit->part == 1);
    CHECK(perspective_hit->world.isApprox(Vec3d(5,5,32), 1e-4));
    CHECK(perspective.s().parts[1].selector->select_unsplit_triangle(perspective_hit->local.cast<float>(), perspective_hit->original_facet) >= 0);
    CHECK(!f.sessions.pick(f.s(), top(-10, -10)));
    auto bad = top(3, 4); bad.projection.setZero();
    THROWS(f.sessions.pick(f.s(), bad));
    bad = top(3, 4); bad.pointer.x() = std::numeric_limits<double>::infinity();
    THROWS(f.sessions.pick(f.s(), bad));
    settings.radius = 100;
    f.begin(Tool::Circle, settings, top(3, 4));
    CHECK(f.s().effective && f.s().parts[0].facet_counts()[1] > 0);
    CHECK(f.s().parts[0].facet_counts()[0] > 0); // Circle does not paint the hidden back.
    CHECK(f.s().parts[1].facet_counts()[1] == 0); // Cursor remains surface-part connected.
    f.cancel();
    f.begin(Tool::Sphere, settings, top(3, 4));
    CHECK(f.s().parts[0].facet_counts()[1] == 12); // Sphere wraps the connected back.
    f.finish();
    CHECK(f.s().phase == Phase::Finished);
    THROWS(f.sessions.prepare_target(f.model, f.s().id, f.s().revision, f.object->id().id, f.instance->id().id));
    THROWS(f.sessions.prepare_begin(f.s().id, f.s().revision, Tool::Triangle, settings, top(3, 4)));
    THROWS(f.sessions.prepare_finish(f.s().id, f.s().revision, f.s().active_stroke_id));
    f.cancel();
    CHECK(f.s().parts[0].facet_counts()[0] == 12);
    settings.radius = .5;
    f.begin(Tool::Triangle, settings, top(3, 4));
    CHECK(f.s().parts[0].facet_counts()[1] == 1);
    const auto revision = f.s().revision;
    const auto draft = f.s().parts[0].selector->serialize();
    bad = top(3, 4); bad.viewport.z() = 0;
    THROWS(f.sessions.prepare_sample(f.s().id, revision, f.s().active_stroke_id, settings, bad));
    THROWS(f.sessions.prepare_sample(f.s().id, revision, f.s().active_stroke_id + 1, settings, top(3, 4)));
    THROWS(f.sessions.prepare_sample(f.s().id, revision - 1, f.s().active_stroke_id, settings, top(3, 4)));
    settings.angle = 91;
    THROWS(f.sessions.prepare_sample(f.s().id, revision, f.s().active_stroke_id, settings, top(3, 4)));
    settings.angle = 30;
    CHECK(f.s().revision == revision && f.s().parts[0].selector->serialize() == draft);
    settings.erase = true;
    f.sample(settings, top(3, 4));
    f.finish(); CHECK(!f.s().effective); f.cancel();
    settings.erase = false;
    // Live radius/colour affect later samples in the same operation; one-pixel
    // native ray interpolation covers sparse admitted pointer events.
    settings.radius = .8;
    const auto unrelated_selector = f.s().parts[1].selector;
    f.begin(Tool::Circle, settings, top(1, 5));
    settings.state = 16; settings.radius = .5;
    f.sample(settings, top(9, 5));
    CHECK(f.s().parts[1].selector == unrelated_selector);
    CHECK(f.s().parts[0].facet_counts()[1] > 0 && f.s().parts[0].facet_counts()[16] > 0);
    const auto center_hit = *f.sessions.pick(f.s(), top(5.2, 5.1));
    const int center_facet = center_hit.original_facet;
    const Vec3f center_point = center_hit.local.cast<float>();
    const int center_leaf = f.s().parts[0].selector->select_unsplit_triangle(center_point, center_facet);
    CHECK(center_leaf >= 0);
    TriangleSelector expected(*f.s().parts[0].mesh);
    expected.deserialize(f.s().parts[0].selector->serialize());
    expected.bucket_fill_select_triangles(center_point, center_facet, {}, -1, false, true);
    expected.seed_fill_apply_on_triangles(EnforcerBlockerType::Extruder16);
    CHECK(expected.serialize() == f.s().parts[0].selector->serialize());
    f.cancel();
    f.begin(Tool::Circle, settings, top(1, 5));
    f.sample(settings, top(-5, 5)); // Miss breaks continuity.
    auto huge_miss = top(0, 0); huge_miss.pointer.x() = 1e300;
    const auto untouched_selector = f.s().parts[0].selector;
    f.sample(settings, huge_miss);
    CHECK(!f.s().last_hit && f.s().parts[0].selector == untouched_selector);
    f.sample(settings, top(9, 5));
    expected.deserialize(f.s().parts[0].selector->serialize());
    expected.bucket_fill_select_triangles(center_point, center_facet, {}, -1, false, true);
    expected.seed_fill_apply_on_triangles(EnforcerBlockerType::NONE);
    CHECK(expected.serialize() == f.s().parts[0].selector->serialize());
    f.cancel();
    // Region preview is the actual native bucket result, without draft writes.
    settings.state = 2; settings.angle = 30;
    f.preview(Tool::Region, settings, top(3, 4));
    CHECK(f.s().preview->selectors[1] == f.s().parts[1].selector);
    CHECK(f.s().preview->region_selection->selected_facet_count() == 2);
    CHECK(f.s().parts[0].facet_counts()[2] == 0);
    CHECK(f.s().preview->selectors[0]->num_facets(EnforcerBlockerType::Extruder2) == 2);
    auto candidate_data = f.s().preview->selectors[0]->serialize();
    const auto candidate_revision = f.s().revision;
    THROWS(f.sessions.prepare_begin(f.s().id, f.s().revision, Tool::Region, settings, top(3, 4), candidate_revision - 1));
    f.sessions.publish(f.sessions.prepare_begin(f.s().id, f.s().revision, Tool::Region, settings, top(3, 4), candidate_revision));
    CHECK(f.s().parts[0].selector->serialize() == candidate_data);
    f.sample(settings, top(13, 2));
    CHECK(f.s().parts[1].facet_counts()[2] == 2);
    f.cancel();
    settings.angle.reset();
    f.preview(Tool::Region, settings, top(3, 4));
    CHECK(f.s().preview->selectors[0]->num_facets(EnforcerBlockerType::Extruder2) == 12);
    f.preview(Tool::Region, settings, top(13, 2));
    CHECK(f.s().preview->selectors[0]->num_facets(EnforcerBlockerType::Extruder2) == 0);
    f.preview(Tool::Region, settings, top(-10, 2));
    CHECK(!f.s().preview->hit);
    CHECK(f.s().preview->selectors[1]->num_facets(EnforcerBlockerType::Extruder2) == 0);
    settings.angle = 0;
    settings.state = 0;
    f.preview(Tool::Region, settings, top(3, 4));
    CHECK(f.s().preview->region_selection->selected_facet_count() == 2);
    CHECK(!f.s().preview->region_selection->get_seed_fill_contour().empty());
    CHECK(f.s().preview->selectors[0]->serialize() == f.s().parts[0].selector->serialize());
    settings.state = 2;
    f.begin(Tool::Region, settings, top(3, 4)); CHECK(f.s().parts[0].facet_counts()[2] == 2); f.cancel();
    settings.angle = 90;
    f.begin(Tool::Region, settings, top(3, 4)); CHECK(f.s().parts[0].facet_counts()[2] == 12); f.cancel();
    // The side camera supplies a Z=2 lower bound. Height reaches the other part
    // even though the pointer hits the first part.
    auto side = top(3, 0);
    side.view << 1,0,0,0, 0,0,1,-2, 0,-1,0,-100, 0,0,0,1;
    settings.height = 1;
    f.begin(Tool::Height, settings, side);
    CHECK(f.s().last_hit && std::abs(f.s().last_hit->world.z() - 2) < 1e-5);
    CHECK(f.s().parts[0].facet_counts()[2] > 0 && f.s().parts[1].facet_counts()[2] > 0);
    for (const auto& p : f.s().parts) {
        const auto facets = p.selector->get_facets(EnforcerBlockerType::Extruder2);
        const auto matrix = f.s().instance_transform * p.volume_transform;
        for (const auto& triangle : facets.indices)
            for (int index : triangle) {
                const Vec3d world = matrix * facets.vertices[index].cast<double>();
                CHECK(world.z() > 1.9 && world.z() < 3.1);
            }
    }
    f.cancel();
    CHECK(f.part->mmu_segmentation_facets.timestamp() == timestamp && f.part->mmu_segmentation_facets.get_data() == original);
    // A failed response/preparation cannot publish staged draft work.
    auto abandoned = f.sessions.prepare_begin(f.s().id, f.s().revision, Tool::Triangle, settings, top(3, 4));
    CHECK(abandoned->effective && f.s().phase == Phase::Idle && f.s().parts[0].facet_counts()[2] == 0);

    Fixture transformed;
    transformed.part->set_scaling_factor(Vec3d(2, .5, 1.5));
    transformed.part->set_mirror(Vec3d(-1, 1, 1));
    transformed.instance->set_offset(Vec3d(5, 0, 3));
    transformed.open();
    const Transform3d transform = transformed.s().instance_transform * transformed.s().parts[0].volume_transform;
    const Vec3d expected_point = transform * Vec3d(1,1,5);
    const auto transformed_event = top(expected_point.x(), expected_point.y());
    const auto th = transformed.sessions.pick(transformed.s(), transformed_event);
    CHECK(th && th->world.isApprox(expected_point, 1e-4));
    CHECK(th->local.isApprox(Vec3d(1,1,5), 1e-4));
    settings.radius = 1.; settings.state = 3;
    transformed.begin(Tool::Circle, settings, transformed_event);
    CHECK(transformed.s().parts[0].facet_counts()[3] > 0);
    const auto painted_facets = transformed.s().parts[0].selector->get_facets(EnforcerBlockerType::Extruder3);
    for (const auto& triangle : painted_facets.indices) {
        Vec3d center = Vec3d::Zero();
        for (int index : triangle) center += transform * painted_facets.vertices[index].cast<double>();
        center /= 3.; CHECK((center.head<2>() - expected_point.head<2>()).norm() < 1.1);
    }
    transformed.cancel();
    Fixture rotated_height;
    rotated_height.part->set_rotation(Vec3d(.3,.45,.2));
    rotated_height.part->set_scaling_factor(Vec3d(1.4,.7,1.2));
    rotated_height.part->set_mirror(Vec3d(-1,1,1));
    rotated_height.instance->set_rotation(Vec3d(.2,-.15,.35));
    rotated_height.instance->set_offset(Vec3d(0,0,2));
    rotated_height.open();
    const Transform3d rotated_matrix = rotated_height.s().instance_transform * rotated_height.s().parts[0].volume_transform;
    const Vec3d rotated_center = rotated_matrix * Vec3d::Zero();
    auto rotated_side = top(rotated_center.x(), 0);
    rotated_side.view << 1,0,0,0, 0,0,1,-rotated_center.z(), 0,-1,0,-50, 0,0,0,1;
    const auto band_hit = rotated_height.sessions.pick(rotated_height.s(), rotated_side);
    CHECK(band_hit);
    settings.height = 1.3;
    rotated_height.begin(Tool::Height, settings, rotated_side);
    const auto rotated_painted = rotated_height.s().parts[0].selector->get_facets(EnforcerBlockerType::Extruder3);
    CHECK(!rotated_painted.indices.empty());
    for (const auto& triangle : rotated_painted.indices) for (int index : triangle) {
        const Vec3d world = rotated_matrix * rotated_painted.vertices[index].cast<double>();
        CHECK(world.z() > band_hit->world.z() - .1 && world.z() < band_hit->world.z() + settings.height + .1);
    }
    rotated_height.cancel();
    Fixture curved;
    curved.part->set_mesh(TriangleMesh(its_make_sphere(5, PI/12)));
    curved.open(); settings.radius = 20;
    curved.begin(Tool::Circle, settings, top(5, 5));
    CHECK(curved.s().parts[0].facet_counts()[0] > 0 && curved.s().parts[0].facet_counts()[3] > 0);
    curved.cancel(); curved.begin(Tool::Sphere, settings, top(5, 5));
    CHECK(curved.s().parts[0].facet_counts()[0] == 0); curved.cancel();

    Fixture gap;
    gap.part->set_mesh(TriangleMesh(its_make_cube(2.,2.,2.)));
    NativeSelector painted(gap.part->mesh()); painted.set_facet(0, EnforcerBlockerType::Extruder16);
    painted.set_facet(1, EnforcerBlockerType::Extruder2); // Competes with state zero as a neighbor.
    gap.part->mmu_segmentation_facets.set(painted);
    auto* gap_second = gap.object->add_volume(TriangleMesh(its_make_cube(2.,2.,2.)));
    gap_second->mmu_segmentation_facets.set(painted);
    gap.open(); settings.gap_area = 2.;
    gap.preview(Tool::Gap, settings);
    CHECK(gap.s().preview->selectors[0]->num_facets(EnforcerBlockerType::Extruder16) == 1); // strict <
    settings.gap_area = 2.01;
    gap.preview(Tool::Gap, settings);
    CHECK(gap.s().preview->selectors[0]->num_facets(EnforcerBlockerType::Extruder16) == 0);
    CHECK(gap.s().parts[0].facet_counts()[16] == 1);
    auto gap_expected = gap.s().preview->selectors[0]->serialize();
    gap.sessions.publish(gap.sessions.prepare_begin(gap.s().id, gap.s().revision, Tool::Gap, settings, {}, gap.s().revision));
    CHECK(gap.s().phase == Phase::Finished && gap.s().changed_parts.size() == 2);
    CHECK(gap.s().parts[0].selector->serialize() == gap_expected);
    CHECK(gap.s().parts[1].facet_counts()[16] == 0); gap.cancel();
    gap.begin(Tool::EraseAll, settings); CHECK(gap.s().changed_parts.size() == 2); gap.cancel();
    CHECK(gap.part->mmu_segmentation_facets.get_data() == painted.serialize());
    settings.gap_area = 5.01; THROWS(gap.sessions.prepare_preview(gap.s().id, gap.s().revision, Tool::Gap, settings, {}));
    settings.gap_area = -1; THROWS(settings.validate());
    settings.gap_area = 0; gap.preview(Tool::Gap, settings);
    gap.sessions.publish(gap.sessions.prepare_begin(gap.s().id, gap.s().revision, Tool::Gap, settings, {}, gap.s().revision));
    CHECK(!gap.s().effective); gap.cancel();
    // Subdivision/undivision leaves private selector free lists. Reconstructing
    // clones must behave like the uninterrupted pinned selector afterwards.
    TriangleMesh clone_mesh(its_make_cube(10., 10., 10.));
    TriangleSelector reference(clone_mesh);
    auto reconstructed = std::make_shared<NativeSelector>(clone_mesh);
    const int top_facet = hit->original_facet;
    auto brush = [&](TriangleSelector& selector, float radius, int state) {
        auto cursor = TriangleSelector::SinglePointCursor::cursor_factory(Vec3f(3,4,10), Vec3f(3,4,200),
            radius, TriangleSelector::SPHERE, Transform3d::Identity(), {});
        selector.select_patch(top_facet, std::move(cursor), static_cast<EnforcerBlockerType>(state), Transform3d::Identity(), true);
    };
    for (const auto [radius, state] : std::vector<std::pair<float,int>>{{.6f,1},{.25f,2},{1.f,0},{.4f,16},{20.f,0},{.3f,3}}) {
        brush(reference, radius, state);
        brush(*reconstructed, radius, state);
        CHECK(reference.serialize() == reconstructed->serialize());
        reconstructed = reconstructed->clone();
        CHECK(reference.serialize() == reconstructed->serialize());
    }
    NativeSelector multiple_neighbors(clone_mesh);
    for (int face = 0; face < 12; ++face) multiple_neighbors.set_facet(face, EnforcerBlockerType::Extruder3);
    AABBMesh original_faces(clone_mesh);
    const auto one_top = original_faces.query_ray_hit(Vec3d(4,5,100), Vec3d(0,0,-1));
    multiple_neighbors.set_facet(one_top.face(), EnforcerBlockerType::Extruder2);
    auto island_cursor = TriangleSelector::SinglePointCursor::cursor_factory(Vec3f(5,5,10), Vec3f(5,5,100),
        .25f, TriangleSelector::SPHERE, Transform3d::Identity(), {});
    multiple_neighbors.select_patch(one_top.face(), std::move(island_cursor), EnforcerBlockerType::Extruder16, Transform3d::Identity(), true);
    const auto patches = multiple_neighbors.gap_candidates(1.);
    CHECK(patches.size() == 1);
    CHECK(patches[0].neighbors.size() == 2 && *patches[0].neighbors.begin() == EnforcerBlockerType::Extruder2);
    const auto large_state3_count = multiple_neighbors.num_facets(EnforcerBlockerType::Extruder3);
    multiple_neighbors.apply_gaps(patches);
    CHECK(multiple_neighbors.num_facets(EnforcerBlockerType::Extruder16) == 0);
    CHECK(multiple_neighbors.num_facets(EnforcerBlockerType::Extruder3) == large_state3_count);
    std::cout << "Painting six-tool engine tests passed\n";
}
}

int main() {
    engine_tests();
    Model model;
    auto* object = model.add_object();
    auto* part = object->add_volume(TriangleMesh(its_make_cube(10., 10., 10.)));
    auto* second = object->add_volume(TriangleMesh(its_make_cube(5., 5., 5.)));
    auto* modifier = object->add_volume(TriangleMesh(its_make_cube(3., 3., 3.)));
    modifier->set_type(ModelVolumeType::PARAMETER_MODIFIER);
    auto* instance = object->add_instance();
    auto* another_instance = object->add_instance();
    object->printable = false;
    instance->printable = false;
    instance->set_offset(Vec3d(10000, -10000, 0));
    TriangleSelector painted(part->mesh());
    painted.set_facet(0, EnforcerBlockerType::Extruder16);
    part->mmu_segmentation_facets.set(painted);
    const auto annotation_time = part->mmu_segmentation_facets.timestamp();
    const auto data = part->mmu_segmentation_facets.get_data();
    Sessions sessions;
    const auto object_id = object->id().id, instance_id = instance->id().id;
    THROWS(sessions.prepare_open(model, object_id, instance_id, 1, 1));
    THROWS(sessions.prepare_open(model, object_id, 999999, 2, 1));
    THROWS(sessions.prepare_open(model, 999999, instance_id, 2, 1));
    auto candidate = sessions.prepare_open(model, object_id, instance_id, 64, 1);
    CHECK(!sessions.current()); // Preparation does not publish on allocation failure.
    const auto id = candidate->id;
    CHECK(candidate->parts.size() == 2);
    CHECK(candidate->parts[0].facet_counts()[16] == 1);
    CHECK(candidate->parts[0].facet_counts()[0] == 11);
    CHECK(candidate->parts[1].volume_id == second->id().id);
    sessions.publish(std::move(candidate));
    sessions.validate_target(model, sessions.require(id, 1));
    CHECK(part->mmu_segmentation_facets.timestamp() == annotation_time);
    CHECK(part->mmu_segmentation_facets.get_data() == data);
    THROWS(sessions.prepare_open(model, object_id, instance_id, 2, 1));
    THROWS(sessions.require(id + 1, 1));
    THROWS(sessions.require(id, 2));
    THROWS(MmuAnnotationAdapter::validate_state(-1));
    THROWS(MmuAnnotationAdapter::validate_state(17));
    MmuAnnotationAdapter::validate_state(0);
    MmuAnnotationAdapter::validate_state(16);
    THROWS(sessions.prepare_target(model, id, 1, 999999, instance_id));
    CHECK(sessions.current()->revision == 1);
    auto rebound = sessions.prepare_target(model, id, 1, object_id, another_instance->id().id);
    CHECK(rebound->id == id && rebound->history_session_id == 1 && rebound->revision == 2);
    sessions.publish(std::move(rebound)); // No slot entry gate on target switches.
    auto* other = model.add_object();
    other->add_volume(TriangleMesh(its_make_cube(2., 2., 2.)));
    auto* other_instance = other->add_instance();
    sessions.publish(sessions.prepare_target(model, id, 2, other->id().id, other_instance->id().id));
    CHECK(sessions.current()->parts.size() == 1);
    CHECK(sessions.current()->history_session_id == 1);
    std::weak_ptr<const TriangleMesh> retained = sessions.current()->parts[0].mesh;
    model.clear_objects();
    THROWS(sessions.validate_target(model, sessions.require(id, 3)));
    CHECK(!retained.expired()); // Mesh references stay safe even before reset.
    sessions.reset();
    CHECK(retained.expired());
    CHECK(!sessions.current());
    auto* fresh_object = model.add_object();
    fresh_object->add_volume(TriangleMesh(its_make_cube(2., 2., 2.)));
    const auto fresh_instance_id = fresh_object->add_instance()->id().id;
    auto fresh = sessions.prepare_open(model, fresh_object->id().id, fresh_instance_id, 2, 2);
    CHECK(fresh->id > id);
    sessions.publish(std::move(fresh));
    fresh_object->volumes.front()->mmu_segmentation_facets.reset();
    THROWS(sessions.validate_target(model, *sessions.current()));
    sessions.reset();
    std::cout << "Painting session lifecycle tests passed\n";
}
