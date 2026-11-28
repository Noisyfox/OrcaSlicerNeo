#include "CutPieces.hpp"
#include "CutSection.hpp"
#include <stdexcept>

namespace Slic3r::Neo::Cutting {
bool CutPieces::section_active(size_t index, const std::set<size_t>& toggled) const
{
    if (section_pieces.at(index).empty()) return true;
    bool a = false, b = false;
    for (size_t id : section_pieces[index]) {
        const bool upper = parts[id].selected != bool(toggled.count(id));
        a |= upper; b |= !upper;
    }
    return a && b;
}
bool CutPieces::accepts_connector(const Vec3d& local, const std::set<size_t>& toggled) const
{
    for (size_t i = 0; i < sections.size(); ++i)
        if (section_active(i, toggled) && sections[i].contains(Point::new_scale(local))) return true;
    return false;
}

CutPieces prepare_cut_pieces(const ModelObject& source, int index, const Transform3d& world_plane)
{
    auto local = world_plane;
    local.translation() -= source.instances.at(index)->get_offset();
    Cut cut(&source, index, local);
    const auto& objects = cut.perform_with_plane();
    if (objects.empty()) throw std::invalid_argument("Cut did not produce connected pieces");
    CutPieces result;
    for (const auto& [name, material] : source.get_model()->materials)
        result.model.add_material(name, *material);
    auto* staged = result.model.add_object(*objects.front());
    for (int i = int(staged->volumes.size())-1; i >= 0; --i) {
        auto* volume = staged->volumes[i];
        if (volume->is_splittable()) volume->split(1, false);
    }
    result.sections = cut_section(source, *source.instances.at(index), world_plane);
    result.section_pieces.resize(result.sections.size());
    const auto to_plane = world_plane.inverse() * staged->instances[index]->get_matrix();
    for (const auto* volume : staged->volumes) {
        const Transform3d transform = to_plane * volume->get_matrix();
        const auto& mesh = volume->mesh().its;
        bool upper = false;
        for (const auto& p : mesh.vertices) {
            const double z = transform.linear().row(2).dot(p.cast<double>()) + transform.translation().z();
            if (std::abs(z) > EPSILON) { upper = z > 0.; break; }
        }
        // Associate cap triangles with their filled section, respecting holes.
        // Multiple original solids can meet the same section on either side.
        if (volume->is_model_part()) {
            std::set<size_t> seen;
            for (const auto& face : mesh.indices) {
                const Vec3d a = transform * mesh.vertices[face[0]].cast<double>();
                if (std::abs(a.z()) > EPSILON) continue;
                const Vec3d b = transform * mesh.vertices[face[1]].cast<double>();
                const Vec3d c = transform * mesh.vertices[face[2]].cast<double>();
                if (std::max(std::abs(b.z()), std::abs(c.z())) > EPSILON) continue;
                const auto sample = Point::new_scale((a+b+c)/3.);
                for (size_t id = 0; id < result.sections.size(); ++id)
                    if (!seen.count(id) && result.sections[id].contains(sample)) {
                        result.section_pieces[id].push_back(result.parts.size());
                        seen.insert(id);
                    }
            }
        }
        result.parts.push_back({upper, !volume->is_model_part()});
    }
    return result;
}
}
