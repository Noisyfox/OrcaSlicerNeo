#include "PaintingSession.hpp"
#include <iostream>
#include <stdexcept>

#define CHECK(x) do { if (!(x)) throw std::runtime_error("failed: " #x); } while(false)
#define THROWS(x) do { bool caught = false; try { x; } catch(const std::exception&) { caught = true; } CHECK(caught); } while(false)
using namespace Slic3r;
using namespace Slic3r::Neo::Painting;

int main() {
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
