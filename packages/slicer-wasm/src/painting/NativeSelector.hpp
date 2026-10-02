#pragma once
#include "libslic3r/TriangleSelector.hpp"
#include "libslic3r/Geometry.hpp"
#include <memory>
#include <queue>
#include <set>

namespace Slic3r::Neo::Painting {
// Non-GUI adapter over the pinned selector. The only ported algorithm is Orca's
// TriangleSelectorPatch::update_triangles_per_patch/update_selector_triangles
// (GLGizmoPainterBase.cpp). Rendering/VBO/wx dependencies are intentionally absent.
class NativeSelector final : public TriangleSelector {
public:
    using TriangleSelector::TriangleSelector;
    std::shared_ptr<NativeSelector> clone() const {
        auto out = std::make_shared<NativeSelector>(m_mesh);
        // Reconstruction also rebuilds the selector's private free lists.
        // Copying just protected triangle/vertex arrays would leave those
        // lists inconsistent after undivision or garbage collection.
        out->deserialize(serialize());
        return out;
    }
    struct GapPatch {
        std::vector<int> facets;
        std::set<EnforcerBlockerType> neighbors;
        float area = 0;
    };
    std::vector<GapPatch> gap_candidates(double threshold) const {
        const auto [neighbors, propagated] = precompute_all_neighbors();
        std::vector<bool> visited(m_triangles.size(), false);
        std::vector<GapPatch> patches;
        for (int start = 0; start < int(m_triangles.size()); ++start) {
            if (visited[start] || !m_triangles[start].valid() || m_triangles[start].is_split()) continue;
            GapPatch patch;
            double area = 0.;
            const auto state = m_triangles[start].get_state();
            std::queue<int> queue;
            queue.push(start);
            while (!queue.empty()) {
                const int current = queue.front(); queue.pop();
                if (visited[current]) continue;
                visited[current] = true;
                const auto& triangle = m_triangles[current];
                patch.facets.push_back(current);
                // Orca measures mesh-space area (not world-scaled area) and
                // saturates at its maximum threshold, 5 mm^2.
                if (area < 5.) {
                    const auto& a = m_vertices[triangle.verts_idxs[0]].v;
                    const auto& b = m_vertices[triangle.verts_idxs[1]].v;
                    const auto& c = m_vertices[triangle.verts_idxs[2]].v;
                    area += (a - b).cross(a - c).norm() * .5;
                }
                std::vector<int> touching;
                const auto& v = triangle.verts_idxs;
                append_touching_subtriangles(neighbors[current](0), v[1], v[0], touching);
                append_touching_subtriangles(neighbors[current](1), v[2], v[1], touching);
                append_touching_subtriangles(neighbors[current](2), v[0], v[2], touching);
                for (int next : propagated[current])
                    if (next != -1 && !m_triangles[next].is_split()) touching.push_back(next);
                for (int next : touching) {
                    if (next < 0) continue;
                    const auto next_state = m_triangles[next].get_state();
                    if (next_state != state) patch.neighbors.insert(next_state);
                    else if (!visited[next]) queue.push(next);
                }
            }
            // TrianglePatch stores float area and Orca's gap control is float.
            patch.area = float(area);
            if (patch.area < float(threshold) && !patch.neighbors.empty()) patches.push_back(std::move(patch));
        }
        // Analyze every patch before applying: neighboring small regions must
        // use their original states, exactly as Orca's preview and Apply do.
        return patches;
    }
    void apply_gaps(const std::vector<GapPatch>& patches) {
        for (const auto& patch : patches)
            for (int facet : patch.facets) m_triangles[facet].set_state(*patch.neighbors.begin());
    }
    // Same inverse-transpose, normalized Z and strict angular boundary as the
    // pinned select_patch/seed_fill_select_triangles. A zero angle disables the
    // native filter; no determinant flip is applied to mirrored normals.
    std::set<int> overhang_facets(const Transform3d& transform, double angle) const {
        const Matrix3f normal_matrix = transform.linear().inverse().transpose().cast<float>();
        const float native_angle = float(angle);
        const float limit = -cos(Geometry::deg2rad(native_angle));
        std::set<int> result;
        for (int i = 0; i < int(m_triangles.size()); ++i) {
            const auto& tr = m_triangles[i];
            if (tr.valid() && !tr.is_split() && (native_angle == 0.f ||
                (normal_matrix * m_face_normals[tr.source_triangle]).normalized().z() < limit)) result.insert(i);
        }
        return result;
    }
    // Display uses the native leaf topology and selection flags, independently
    // from the prospective state. Contours use the pinned selector's T-joints.
    struct Display {
        std::vector<float> vertices; // nonindexed xyz + normal triangles
        std::vector<std::array<std::size_t, 3>> groups; // state, first vertex, count
    };
    Display display(const std::set<int>* membership = nullptr, bool selected_only = false) const {
        Display out;
        std::array<std::vector<float>, 17> buckets;
        const auto append = [&](int i) {
            const auto& triangle = m_triangles[i];
            if (!triangle.valid() || triangle.is_split() || (selected_only && !triangle.is_selected_by_seed_fill())) return;
            auto& bucket = buckets[std::size_t(triangle.get_state())];
            const auto& a = m_vertices[triangle.verts_idxs[0]].v;
            const auto& b = m_vertices[triangle.verts_idxs[1]].v;
            const auto& c = m_vertices[triangle.verts_idxs[2]].v;
            const Vec3f cross = (b - a).cross(c - a);
            const Vec3f normal = cross.squaredNorm() > 0 ? cross.normalized().eval() : Vec3f::Zero();
            for (int vertex : triangle.verts_idxs) {
                for (int j = 0; j < 3; ++j) bucket.push_back(m_vertices[vertex].v[j]);
                for (int j = 0; j < 3; ++j) bucket.push_back(normal[j]);
            }
        };
        if (membership) for (int i : *membership) append(i);
        else for (int i = 0; i < int(m_triangles.size()); ++i) append(i);
        for (std::size_t state = 0; state < buckets.size(); ++state) {
            const auto& bucket = buckets[state];
            if (bucket.empty()) continue;
            out.groups.push_back({state, out.vertices.size() / 6, bucket.size() / 6});
            out.vertices.insert(out.vertices.end(), bucket.begin(), bucket.end());
        }
        return out;
    }
    std::vector<float> contour() const {
        std::vector<float> result;
        for (const auto& edge : get_seed_fill_contour())
            for (int vertex : edge) for (float value : m_vertices[vertex].v) result.push_back(value);
        return result;
    }
    std::size_t selected_facet_count() const {
        std::size_t count = 0;
        for (const auto& triangle : m_triangles)
            if (triangle.valid() && !triangle.is_split() && triangle.is_selected_by_seed_fill()) ++count;
        return count;
    }
};
} // namespace Slic3r::Neo::Painting
