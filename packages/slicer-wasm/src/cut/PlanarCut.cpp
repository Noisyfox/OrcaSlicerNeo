#include "PlanarCut.hpp"
#include "CutPieces.hpp"
#include "libslic3r/CutUtils.hpp"

#include <algorithm>
#include <stdexcept>

namespace Slic3r::Neo::Cutting {
namespace {
using Attribute = ModelObjectCutAttribute;

ModelObjectCutAttributes attributes(const PlanarCutOptions& options)
{
    const bool upper = options.upper != SideAction::Discard;
    const bool lower = options.lower != SideAction::Discard;
    if ((!upper && !lower) || (options.as_parts && !(upper && lower)))
        throw std::invalid_argument("Invalid side retention for planar Cut");

    auto flags = only_if(upper, Attribute::KeepUpper) | only_if(lower, Attribute::KeepLower)
        | only_if(options.keep_paint, Attribute::KeepPaint);
    if (options.as_parts)
        return flags | Attribute::KeepAsParts;
    return flags | only_if(options.upper == SideAction::PlaceOnCut, Attribute::PlaceOnCutUpper)
        | only_if(options.lower == SideAction::PlaceOnCut, Attribute::PlaceOnCutLower)
        | only_if(options.upper == SideAction::Flip, Attribute::FlipUpper)
        | only_if(options.lower == SideAction::Flip, Attribute::FlipLower);
}

void check_sides(const ModelObject& source, const ModelInstance& instance, const Transform3d& plane)
{
    const Transform3d to_plane = plane.inverse() * instance.get_transformation().get_matrix_no_offset();
    bool upper = false;
    bool lower = false;
    for (const ModelVolume* volume : source.volumes) {
        if (!volume->is_model_part() || volume->mesh().empty())
            continue;
        const Transform3d transform = to_plane * volume->get_matrix();
        const auto& mesh = volume->mesh().its;
        // Only referenced vertices contribute geometry. Project directly onto
        // local Z and stop once there are triangles on both sides.
        for (const auto& face : mesh.indices) {
            for (int index : face) {
                const double z = transform.linear().row(2).dot(mesh.vertices[index].cast<double>())
                    + transform.translation().z();
                upper |= z > EPSILON;
                lower |= z < -EPSILON;
                if (upper && lower)
                    return;
            }
        }
    }
    throw std::invalid_argument("Cut requires solid geometry on both sides of the plane");
}
} // namespace

Model stage_planar_cut(const ModelObject& source, ObjectID reference, const PlanarCutOptions& options, const CutPieces* reviewed)
{
    const auto selected = std::find_if(source.instances.begin(), source.instances.end(),
        [reference](const ModelInstance* instance) { return instance->id() == reference; });
    if (selected == source.instances.end())
        throw std::invalid_argument("Cut reference instance no longer belongs to the source object");
    if (source.is_cut() && source.volumes.size() == 1 && source.volumes.front()->is_cut_connector()
        && source.volumes.front()->cut_info.connector_type == CutConnectorType::Dowel)
        throw std::invalid_argument("A standalone dowel cannot be cut");
    if (!options.center.allFinite() || !options.rotation.allFinite()
        || !options.rotation.isUnitary(1e-8) || options.rotation.determinant() < 0.)
        throw std::invalid_argument("Invalid world-space Cut pose");

    const auto flags = attributes(options) | only_if(!source.is_cut(), Attribute::InvalidateCutInfo);
    Transform3d plane = Transform3d::Identity();
    plane.linear() = options.rotation;
    plane.translation() = options.center - (*selected)->get_offset();
    check_sides(source, **selected, plane);

    const int index = int(selected - source.instances.begin());
    std::optional<CutPieces> regenerated;
    std::vector<Cut::Part> assignment;
    if (options.grouping) {
        if (options.as_parts) throw std::invalid_argument("Connected-piece assignment requires separate results");
        const auto& original = options.grouping->plane;
        const Vec3d normal = options.rotation.col(2);
        const double alignment = normal.dot(original.linear().col(2));
        if (std::abs(std::abs(alignment)-1.) > 1e-8 ||
            std::abs(normal.dot(options.center-original.translation())) > EPSILON)
            throw std::invalid_argument("Cut piece assignments belong to another plane");
        if (!reviewed) reviewed = &regenerated.emplace(prepare_cut_pieces(source, index, original));
        assignment = reviewed->parts;
        for (auto& part : assignment) if (alignment < 0.) part.selected = !part.selected;
        std::set<size_t> unique;
        for (const size_t id : options.grouping->toggled) {
            if (id >= assignment.size() || assignment[id].is_modifier || !unique.insert(id).second)
                throw std::invalid_argument("Invalid connected Cut piece");
            assignment[id].selected = !assignment[id].selected;
        }
    }
    Cut cut(reviewed ? reviewed->model.objects.front() : &source, index, plane, flags);
    const auto& objects = reviewed ? cut.perform_by_contour(&source, assignment, 0) : cut.perform_with_plane();
    const bool both = flags.has(Attribute::KeepUpper) && flags.has(Attribute::KeepLower);
    const size_t expected = both && !options.as_parts ? 2 : 1;
    if (objects.size() != expected)
        throw std::runtime_error("Cut did not produce all requested outputs");

    Model result;
    for (const ModelObject* object : objects) {
        if (object->parts_count() == 0)
            throw std::runtime_error("Cut produced an object without solid parts");
        for (const ModelVolume* volume : object->volumes) {
            const auto& id = volume->material_id();
            if (!id.empty() && !result.get_material(id)) {
                // Cloning a volume can create an empty placeholder for a missing
                // material. Preserve the definition owned by the live source.
                const auto& materials = source.get_model()->materials;
                const auto material = materials.find(id);
                if (material == materials.end())
                    throw std::runtime_error("Missing source material for Cut output");
                result.add_material(id, *material->second);
            }
        }
        ModelObject* output = result.add_object(*object);
        if (source.is_cut() && both)
            output->cut_id.increase_check_sum(1);
        output->auto_drop = source.auto_drop;
        output->ensure_on_bed();
    }
    return result;
}
} // namespace Slic3r::Neo::Cutting
