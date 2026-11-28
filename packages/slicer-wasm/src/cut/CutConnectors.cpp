#include "CutConnectors.hpp"
#include "CutSection.hpp"
#include "libslic3r/ClipperUtils.hpp"
#include "libslic3r/Geometry.hpp"
#include <map>
#include <set>

namespace Slic3r::Neo::Cutting {
std::vector<size_t> invalid_cut_connectors(const ModelObject& source, int instance, const Transform3d& plane,
                                           const CutConnectors& connectors)
{
    std::map<double, ExPolygons> sections;
    const auto fits = [&](const Vec3d& local, double z, double radius) {
        auto [it, inserted] = sections.try_emplace(z);
        if (inserted) {
            Transform3d section = plane;
            section.translation() += z * plane.linear().col(2);
            it->second = cut_section(source, *source.instances.at(instance), section);
        }
        const auto usable = offset_ex(it->second, -scale_(radius));
        const auto point = Point::new_scale(local);
        return std::any_of(usable.begin(), usable.end(), [&](const ExPolygon& p) { return p.contains(point); });
    };
    std::set<size_t> invalid;
    for (size_t i = 0; i < connectors.size(); ++i) {
        const auto& c = connectors[i];
        const Vec3d local = plane.inverse() * c.pos;
        const double radius = c.radius + c.radius_tolerance, depth = c.height + c.height_tolerance;
        if (!c.pos.allFinite() || !std::isfinite(radius) || !std::isfinite(depth) || c.radius <= 0. || c.height <= 0. ||
            c.radius_tolerance < 0. || c.height_tolerance < 0. || std::abs(local.z()) > EPSILON ||
            !fits(local, 0., radius) || !fits(local, depth, radius) ||
            (c.attribs.type == CutConnectorType::Dowel && !fits(local, -depth, radius))) invalid.insert(i);
        for (size_t j = 0; j < i; ++j) {
            const auto& other = connectors[j];
            if ((other.pos-c.pos).norm() < radius+other.radius+other.radius_tolerance) {
                invalid.insert(i); invalid.insert(j);
            }
        }
    }
    return { invalid.begin(), invalid.end() };
}

void add_cut_connectors(ModelObject& staged, const Vec3d& instance_offset, const Transform3d& plane,
                        const CutConnectors& connectors)
{
    size_t id = staged.cut_id.connectors_cnt();
    for (const auto& c : connectors) {
        const auto attr = c.attribs;
        const bool dowel = attr.type == CutConnectorType::Dowel;
        const int sectors = attr.shape == CutConnectorShape::Circle ? 360 : attr.shape == CutConnectorShape::Square ? 4 :
                            attr.shape == CutConnectorShape::Hexagon ? 6 : 3;
        indexed_triangle_set mesh;
        if (attr.type == CutConnectorType::Snap) mesh = its_make_snap(1., 1., 0.3, 0.15);
        else if (attr.style == CutConnectorStyle::Prism) mesh = its_make_cylinder(1., 1., 2.*PI/sectors);
        else if (dowel) mesh = its_make_frustum_dowel(1., 1., sectors);
        else mesh = its_make_frustum(1., 1., 2.*PI/sectors);
        auto* volume = staged.add_volume(TriangleMesh(std::move(mesh)), ModelVolumeType::NEGATIVE_VOLUME);
        Transform3d frame = plane;
        frame.translation() = c.pos-instance_offset;
        if (!dowel) frame.translation() += plane.linear().col(2) * (0.5*c.height);
        const double height = dowel && attr.style == CutConnectorStyle::Prism ? 2.*c.height : c.height;
        volume->set_transformation(frame * Geometry::rotation_transform(Vec3d(0.,0.,-c.z_angle)) *
            Geometry::scale_transform(Vec3d(c.radius,c.radius,height)));
        volume->cut_info = { attr.type, c.radius_tolerance, c.height_tolerance };
        volume->name = "Connector-" + std::to_string(++id);
    }
    staged.cut_id.increase_connectors_cnt(connectors.size());
}
}
