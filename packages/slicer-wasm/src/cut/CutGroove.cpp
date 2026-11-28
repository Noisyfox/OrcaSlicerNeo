#include "CutGroove.hpp"
#include "CutSection.hpp"
#include "libslic3r/ClipperUtils.hpp"
#include <stdexcept>

namespace Slic3r::Neo::Cutting {
float validate_groove(const ModelObject& source, int index, const Transform3d& plane, const Dovetail& g)
{
    const auto& p = g.profile;
    if (!(g.count >= 1 && g.count <= 100 && std::isfinite(g.gap) && g.gap >= 0 &&
          std::isfinite(p.depth) && p.depth > 0 && std::isfinite(p.width) && p.width > 0 &&
          p.depth_tolerance >= 0 && p.depth_tolerance < p.depth &&
          p.width_tolerance >= 0 && p.width_tolerance < p.width &&
          p.flaps_angle >= float(PI/6) && p.flaps_angle <= float(2*PI/3) &&
          p.angle >= 0 && p.angle <= float(PI/12)))
        throw std::invalid_argument("Invalid dovetail dimensions, angles, count or tolerances");
    const double mouth = p.width + 2.*p.depth / std::tan(p.flaps_angle);
    if (mouth <= EPSILON) throw std::invalid_argument("Dovetail flanks intersect");
    const float radius = float(source.instance_bounding_box(index).radius());
    const double spacing = g.gap + Cut::calculate_groove_width(p, radius);
    // At each end of the flank height both edges must cross solid material.
    // Test the two sloping lines per groove in the exact native XY section.
    for (int level : {-1, 1}) {
        auto at = plane;
        at.translation() += plane.linear().col(2) * (level*0.5*p.depth);
        const auto sections = cut_section(source, *source.instances.at(index), at);
        for (int i = 0; i < g.count; ++i) for (int side : {-1, 1}) {
            const double half_width = 0.5*(level > 0 ? p.width : mouth);
            const double center = (i-(g.count-1)*0.5)*spacing;
            const double slope = std::tan(p.angle), span = radius*1.125;
            const double end_y = slope > 0. ? std::min(span, half_width/slope) : span;
            const auto x_at = [&](double y) { return center + side*(half_width-y*slope); };
            // Bounds-test in double before converting GUI dimensions to scaled Clipper coordinates.
            const double start_x = x_at(-span), end_x = x_at(end_y);
            const bool intersects = std::any_of(sections.begin(), sections.end(), [&](const ExPolygon& section) {
                const auto bounds = get_extents(section.contour);
                if (std::min(start_x,end_x) > unscale<double>(bounds.max.x()) ||
                    std::max(start_x,end_x) < unscale<double>(bounds.min.x())) return false;
                const Polyline line(Point::new_scale(start_x,-span),Point::new_scale(end_x,end_y));
                return !intersection_pl(line,section).empty();
            });
            if (!intersects) throw std::invalid_argument("Dovetail array extends outside the cut section");
        }
    }
    return radius;
}
}
