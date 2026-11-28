#include "CutSection.hpp"
#include "libslic3r/ClipperUtils.hpp"
#include "libslic3r/TriangleMeshSlicer.hpp"

namespace Slic3r::Neo::Cutting {
ExPolygons cut_section(const ModelObject& source, const ModelInstance& reference, const Transform3d& plane)
{
    const Transform3d to_plane = plane.inverse() * reference.get_matrix();
    Polygons solids, negatives;
    for (const ModelVolume* part : source.volumes) {
        if (!part->is_model_part() && !part->is_negative_volume()) continue;
        MeshSlicingParams params;
        params.trafo = to_plane * part->get_matrix();
        Polygons loops = slice_mesh(part->mesh().its, 0.f, params);
        if (params.trafo.linear().determinant() < 0.)
            for (auto& loop : loops) loop.reverse();
        append(part->is_negative_volume() ? negatives : solids, std::move(loops));
    }
    return negatives.empty() ? union_ex(solids) : diff_ex(union_ex(solids), union_ex(negatives));
}
}
