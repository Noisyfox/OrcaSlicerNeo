#include "libslic3r/MeshBoolean.hpp"
#include "libslic3r/TriangleMesh.hpp"
#include <cmath>
#include <cstdio>
#include <emscripten/emscripten.h>
#include <stdexcept>
#include <string>

using namespace Slic3r;
void run_numeric_backend_tests();
void run_mcut_context_tests();

namespace {
void require(bool value, const char *message) {
    if (!value)
        throw std::runtime_error(message);
}
TriangleMesh box(float x = 0, float y = 0, float z = 0) {
    indexed_triangle_set mesh;
    mesh.vertices = {{0, 0, 0}, {2, 0, 0}, {2, 2, 0}, {0, 2, 0},
                     {0, 0, 2}, {2, 0, 2}, {2, 2, 2}, {0, 2, 2}};
    mesh.indices = {{0, 2, 1}, {0, 3, 2}, {4, 5, 6}, {4, 6, 7}, {0, 1, 5}, {0, 5, 4},
                    {1, 2, 6}, {1, 6, 5}, {2, 3, 7}, {2, 7, 6}, {3, 0, 4}, {3, 4, 7}};
    for (auto &point : mesh.vertices)
        point += Vec3f(x, y, z);
    return TriangleMesh(std::move(mesh));
}
double volume(const TriangleMesh &mesh) {
    double result = 0;
    for (const auto &f : mesh.its.indices) {
        const Vec3d a = mesh.its.vertices[f[0]].cast<double>();
        const Vec3d b = mesh.its.vertices[f[1]].cast<double>();
        const Vec3d c = mesh.its.vertices[f[2]].cast<double>();
        result += a.dot(b.cross(c)) / 6;
    }
    return std::abs(result);
}
void check(const TriangleMesh &mesh, double expected, double tolerance = 1e-5,
           bool require_non_self_intersection = true) {
    static unsigned case_index = 0;
    ++case_index;
    require(!mesh.empty() && std::abs(volume(mesh) - expected) < tolerance,
            "Boolean volume mismatch");
    auto cgal = MeshBoolean::cgal::triangle_mesh_to_cgal(mesh);
    const bool bound = MeshBoolean::cgal::does_bound_a_volume(*cgal);
    const bool self = MeshBoolean::cgal::does_self_intersect(*cgal);
    if (!bound || (require_non_self_intersection && self))
        throw std::runtime_error("Boolean topology mismatch in case " + std::to_string(case_index) +
                                 " bound=" + std::to_string(bound) + " self=" + std::to_string(self));
    if (!require_non_self_intersection)
        std::printf("{\"kind\":\"transformed-wrapper\",\"volume\":%.17g,\"faces\":%zu,\"closed\":true,\"selfIntersecting\":%s}\n",
                    volume(mesh), mesh.its.indices.size(), self ? "true" : "false");
}
TriangleMesh mcut(const TriangleMesh &a, const TriangleMesh &b, const char *op) {
    std::vector<TriangleMesh> result;
    MeshBoolean::mcut::make_boolean(a, b, result, op);
    require(result.size() <= 1, "Unexpected wrapper result count");
    return result.empty() ? TriangleMesh() : std::move(result.front());
}
void wrappers() {
    const auto a = box(), b = box(.75f, .5f, .25f);
    const double overlap = 1.25 * 1.5 * 1.75;
    auto result = a;
    MeshBoolean::cgal::plus(result, b);
    check(result, 16 - overlap);
    result = a;
    MeshBoolean::cgal::minus(result, b);
    check(result, 8 - overlap);
    result = a;
    MeshBoolean::cgal::intersect(result, b);
    check(result, overlap);
    auto ea = MeshBoolean::triangle_mesh_to_eigen(a), eb = MeshBoolean::triangle_mesh_to_eigen(b);
    MeshBoolean::minus(ea, eb);
    check(MeshBoolean::eigen_to_triangle_mesh(ea), 8 - overlap);
    ea = MeshBoolean::triangle_mesh_to_eigen(a);
    MeshBoolean::self_union(ea);
    check(MeshBoolean::eigen_to_triangle_mesh(ea), 8);

    // Recorded from the pinned original threaded MCUT, with libc++'s RNG.
    // This fixture requires general-position perturbation; its native volume
    // intentionally differs from the analytical box volume. Do not hide it
    // behind a large tolerance against the analytical value.
    const double native[] = {12.718449825690882, 4.7184497660862448, 3.281550233913757};
    const char *operations[] = {"UNION", "A_NOT_B", "INTERSECTION"};
    for (unsigned op = 0; op < 3; ++op) {
        check(mcut(a, b, operations[op]), native[op], 1e-10);
        check(mcut(a, b, operations[op]), native[op], 1e-10);
    }
    // Preserve the upstream disconnected Union fallback, including both shells.
    check(mcut(a, box(5, 0, 0), "UNION"), 16);
    auto disconnected = a;
    disconnected.merge(box(5, 0, 0));
    check(mcut(disconnected, b, "A_NOT_B"), 8 + native[1], 1e-9);
    require(mcut(a, box(5, 0, 0), "INTERSECTION").empty(), "Disjoint intersection must be empty");
    auto enclosing = box();
    enclosing.scale(4.0);
    enclosing.translate(Vec3f(-2, -2, -2));
    // The original MCUT wrapper receives no fragments for containment. Keep
    // its existing fallback semantics rather than replacing them with CSG
    // set arithmetic: Difference retains A and Intersection returns empty.
    check(mcut(a, enclosing, "A_NOT_B"), 8);
    require(mcut(a, enclosing, "INTERSECTION").empty(), "Native containment intersection changed");
    const auto contained_union = mcut(a, enclosing, "UNION");
    require(contained_union.its.indices.size() == 24 &&
                std::abs(volume(contained_union) - 520) < 1e-8,
            "Native containment Union concatenation changed");
    // Exercise the wrapper's transformed and mirrored winding handling.
    for (bool mirror : {false, true}) {
        auto ta = a, tb = b;
        Transform3d t = Transform3d::Identity();
        t.linear() = Eigen::AngleAxisd(.47, Vec3d(1, 2, 3).normalized()).toRotationMatrix();
        if (mirror)
            t.linear().col(0) *= -1;
        t.translation() = Vec3d(11, -7, 3);
        ta.transform(t, true);
        tb.transform(t, true);
        const auto merged = mcut(ta, tb, "UNION");
        // Float input/output rounding can leave self-intersections in the
        // original MCUT result. Record those, and validate its enclosed volume
        // and closed topology. The product does not add post-result repair or
        // promise CGAL-valid output for arbitrary transformed input meshes.
        check(merged, 16 - overlap, 0.005, false);
    }
}
} // namespace
extern "C" EMSCRIPTEN_KEEPALIVE int neo_test_mesh_boolean() {
    try {
        std::puts("{\"kind\":\"mesh-boolean-phase\",\"phase\":\"numeric\"}");
        run_numeric_backend_tests();
        std::puts("{\"kind\":\"mesh-boolean-phase\",\"phase\":\"mcut-contexts\"}");
        run_mcut_context_tests();
        std::puts("{\"kind\":\"mesh-boolean-phase\",\"phase\":\"wrappers\"}");
        wrappers();
        std::puts("{\"kind\":\"mesh-boolean-backend\",\"passed\":true}");
        return 0;
    } catch (const std::exception &error) {
        std::fprintf(stderr, "mesh-boolean-backend: %s\n", error.what());
        return 1;
    }
}
