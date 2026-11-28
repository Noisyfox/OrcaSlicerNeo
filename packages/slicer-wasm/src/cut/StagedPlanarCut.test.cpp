#include "PlanarCut.hpp"
#include "libslic3r/Geometry.hpp"

#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>

namespace {
using namespace Slic3r;
using namespace Slic3r::Neo::Cutting;

void expect(bool condition, const char* message)
{
    if (!condition)
        throw std::runtime_error(message);
}

bool near(double a, double b) { return std::abs(a - b) < 1e-4; }

bool volume_near(double value, double expected) { return std::abs(value - expected) <= expected * 1e-5; }

ModelObject& cube(Model& model)
{
    ModelObject* object = model.add_object();
    object->add_volume(make_cube(20., 20., 20.));
    object->add_instance();
    return *object;
}

void transformed_reference(bool mirrored)
{
    Model model;
    auto& source = cube(model);
    source.auto_drop = false;
    source.volumes.front()->set_material_id("test");
    source.volumes.front()->material()->attributes["label"] = "original";
    source.volumes.front()->translate(3., 0., 0.);
    auto* selected = source.add_instance();
    selected->set_offset(Vec3d(110., 240., 50.));
    selected->set_rotation(Vec3d(0., 0., PI / 2.));
    selected->set_scaling_factor(Vec3d(2., 1., 1.));
    if (mirrored)
        selected->set_mirror(Vec3d(-1., 1., 1.));
    const auto selected_frame = selected->get_matrix();
    PlanarCutOptions options;
    options.center = selected_frame * Vec3d(11., 0., 0.);
    options.rotation = Geometry::rotation_transform(Vec3d(-PI / 2., 0., 0.)).linear();
    options.upper = SideAction::Keep;

    const auto result = stage_planar_cut(source, selected->id(), options);
    expect(result.objects.size() == 2, "transformed reference lost a side");
    for (size_t i = 0; i < 2; ++i) {
        const auto& output = *result.objects[i];
        expect(output.instances.size() == 2 && output.volumes.size() == 1, "output lost an instance");
        expect(output.instances[0]->get_offset().isApprox(Vec3d::Zero()) &&
               output.instances[1]->get_offset().isApprox(selected->get_offset()), "instance offset applied twice");
        const auto& part = *output.volumes.front();
        const double expected_volume = ((i == 0) != mirrored) ? 9600. : 6400.;
        const auto volume = its_volume(part.mesh().its);
        if (!volume_near(volume, expected_volume))
            throw std::runtime_error("Transformed cut volume " + std::to_string(volume)
                + ", expected " + std::to_string(expected_volume));
        expect(part.material()->attributes.at("label") == "original", "orphaned named material");
    }
    expect(source.instances.size() == 2 && selected->get_matrix().isApprox(selected_frame)
        && volume_near(its_volume(source.volumes.front()->mesh().its), 8000.), "source modified during staging");
}

void orientation_and_bed(bool auto_drop)
{
    Model model;
    auto& source = cube(model);
    source.auto_drop = auto_drop;
    source.instances[0]->set_offset(Vec3d(10., 15., 40.));
    PlanarCutOptions options;
    options.center = Vec3d(15., 15., 40.);
    options.rotation = Geometry::rotation_transform(Vec3d(0., PI / 2., 0.)).linear();
    auto result = stage_planar_cut(source, source.instances[0]->id(), options);
    const auto& upper = *result.objects.at(0);
    const auto& lower = *result.objects.at(1);
    expect(upper.auto_drop == auto_drop && lower.auto_drop == auto_drop, "Auto Drop not inherited");
    const auto a = upper.instance_bounding_box(0);
    const auto b = lower.instance_bounding_box(0);
    expect(near(a.size().z(), 15.) && near(b.size().z(), 20.), "wrong cut-face orientation");
    expect(near(a.min.z(), auto_drop ? 0. : 45.) && near(b.min.z(), auto_drop ? 0. : 40.),
           "unexpected post-rotation bed placement");

    options.as_parts = true;
    const auto parts = stage_planar_cut(source, source.instances[0]->id(), options);
    const auto& multipart = *parts.objects.at(0);
    expect(parts.objects.size() == 1 && multipart.parts_count() == 2, "multipart result cardinality");
    expect(multipart.instance_bounding_box(0).size().isApprox(Vec3d(20., 20., 20.)), "parts relative pose lost");

    options.as_parts = false;
    options.upper = SideAction::Discard;
    options.lower = SideAction::Flip;
    const auto flipped = stage_planar_cut(source, source.instances[0]->id(), options);
    expect(flipped.objects.size() == 1 && near(flipped.objects[0]->min_z(), auto_drop ? 0. : 20.),
           "single flipped side height");
}

void multipart_source()
{
    Model model;
    auto& source = cube(model);
    source.add_volume(make_cube(3., 4., 5.))->translate(25., 0., 0.);
    source.add_volume(make_cube(2., 2., 2.), ModelVolumeType::NEGATIVE_VOLUME)->translate(4., 4., 2.);
    source.add_volume(make_cube(2., 2., 4.), ModelVolumeType::PARAMETER_MODIFIER)->translate(4., 4., 6.);
    source.cut_id.init();
    PlanarCutOptions options;
    options.center.z() = 8.;
    auto result = stage_planar_cut(source, source.instances[0]->id(), options);
    const auto& upper = *result.objects.at(0);
    const auto& lower = *result.objects.at(1);
    expect(upper.parts_count() == 1 && upper.volumes.size() == 2, "upper modifier distribution");
    expect(lower.parts_count() == 2 && lower.volumes.size() == 4, "lower modifier distribution");
    expect(upper.cut_id.id() == source.cut_id.id() && upper.cut_id == lower.cut_id
        && upper.cut_id.check_sum() == lower.cut_id.check_sum()
        && upper.cut_id.check_sum() == source.cut_id.check_sum() + 1, "re-cut identity lost");
    expect(source.volumes.size() == 4 && source.parts_count() == 2, "multipart source was replaced");
}

void failed_staging()
{
    Model model;
    auto& source = cube(model);
    auto* modifier = source.add_volume(make_cube(20., 20., 20.), ModelVolumeType::PARAMETER_MODIFIER);
    modifier->set_material_id("missing");
    model.delete_material("missing");
    const auto* selected = source.instances.front();
    PlanarCutOptions options;
    options.center.z() = 8.;
    try {
        stage_planar_cut(source, selected->id(), options);
    } catch (const std::runtime_error& error) {
        expect(std::string(error.what()) == "Missing source material for Cut output", "unexpected staging failure");
        expect(model.objects.size() == 1 && source.volumes.size() == 2 && source.volumes.back() == modifier
            && source.instances.front() == selected && volume_near(its_volume(source.volumes.front()->mesh().its), 8000.),
            "partial native result leaked into source");
        return;
    }
    throw std::runtime_error("staged object with an unresolved material was accepted");
}

void rejected_requests()
{
    Model model;
    auto& source = cube(model);
    auto* instance = source.instances[0];
    const auto volume_id = source.volumes.front()->id();
    const auto frame = instance->get_matrix();
    auto rejects = [&](ObjectID id, const PlanarCutOptions& options) {
        try {
            stage_planar_cut(source, id, options);
        } catch (const std::invalid_argument&) {
            return;
        }
        throw std::runtime_error("invalid Cut request accepted");
    };
    PlanarCutOptions options;
    options.center.z() = 8.;
    rejects(source.id(), options);
    options.center.z() = 20.;
    rejects(instance->id(), options);
    options.center.z() = std::numeric_limits<double>::quiet_NaN();
    rejects(instance->id(), options);
    options.center.z() = 8.;
    options.rotation(0, 0) = -1.;
    rejects(instance->id(), options);
    options.rotation.setIdentity();
    options.upper = options.lower = SideAction::Discard;
    rejects(instance->id(), options);
    options.lower = SideAction::Keep;
    options.as_parts = true;
    rejects(instance->id(), options);
    expect(model.objects.size() == 1 && model.objects.front() == &source && source.instances.front() == instance
        && frame.isApprox(instance->get_matrix()) && source.volumes.front()->id() == volume_id
        && volume_near(its_volume(source.volumes.front()->mesh().its), 8000.), "failed cut modified the source");
}
} // namespace

void test_staged_planar_cut()
{
    transformed_reference(false);
    transformed_reference(true);
    orientation_and_bed(false);
    orientation_and_bed(true);
    rejected_requests();
    multipart_source();
    failed_staging();
}
