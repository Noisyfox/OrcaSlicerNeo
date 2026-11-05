#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <map>
#include <mcut/mcut.h>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
struct Mesh {
    std::vector<double> vertices;
    std::vector<uint32_t> triangles;
    std::vector<uint32_t> sizes;
};
struct Observation {
    double volume = 0;
    size_t vertices = 0, triangles = 0, components = 0;
    bool closed = true, oriented = true, finite = true;
};
static int contexts_created = 0, contexts_released = 0;
static void require(bool value, const std::string &message) {
    if (!value)
        throw std::runtime_error(message);
}
static void check(McResult value, const char *operation) {
    require(value == MC_NO_ERROR, std::string(operation) + ": " + std::to_string(int(value)));
}
struct Context {
    McContext handle = MC_NULL_HANDLE;
    Context() {
        check(mcCreateContext(&handle, 0), "create_context");
        ++contexts_created;
    }
    ~Context() {
        if (handle && mcReleaseContext(handle) == MC_NO_ERROR)
            ++contexts_released;
    }
};
static Mesh box(double x, double y, double z) {
    Mesh result;
    const double coordinates[] = {0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0,
                                  0, 0, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2};
    result.vertices.assign(std::begin(coordinates), std::end(coordinates));
    for (size_t i = 0; i < result.vertices.size(); i += 3) {
        result.vertices[i] += x;
        result.vertices[i + 1] += y;
        result.vertices[i + 2] += z;
    }
    result.triangles = {0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
                        1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7};
    result.sizes.assign(result.triangles.size() / 3, 3);
    return result;
}
static double signed_volume(const Mesh &mesh) {
    double volume = 0;
    for (size_t i = 0; i < mesh.triangles.size(); i += 3) {
        const double *a = &mesh.vertices[3 * mesh.triangles[i]];
        const double *b = &mesh.vertices[3 * mesh.triangles[i + 1]];
        const double *c = &mesh.vertices[3 * mesh.triangles[i + 2]];
        volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) +
                   a[2] * (b[0] * c[1] - b[1] * c[0])) /
                  6;
    }
    return volume;
}
static McFlags operation_flags(unsigned operation) {
    if (operation == 0)
        return MC_DISPATCH_FILTER_FRAGMENT_SEALING_OUTSIDE |
               MC_DISPATCH_FILTER_FRAGMENT_LOCATION_ABOVE;
    if (operation == 1)
        return MC_DISPATCH_FILTER_FRAGMENT_SEALING_INSIDE |
               MC_DISPATCH_FILTER_FRAGMENT_LOCATION_ABOVE;
    return MC_DISPATCH_FILTER_FRAGMENT_SEALING_INSIDE | MC_DISPATCH_FILTER_FRAGMENT_LOCATION_BELOW;
}
static McResult dispatch(McContext context, const Mesh &a, const Mesh &b, unsigned operation) {
    return mcDispatch(context,
                      MC_DISPATCH_VERTEX_ARRAY_DOUBLE | MC_DISPATCH_ENFORCE_GENERAL_POSITION |
                          operation_flags(operation),
                      a.vertices.data(), a.triangles.data(), a.sizes.data(),
                      uint32_t(a.vertices.size() / 3), uint32_t(a.sizes.size()), b.vertices.data(),
                      b.triangles.data(), b.sizes.data(), uint32_t(b.vertices.size() / 3),
                      uint32_t(b.sizes.size()));
}
static Observation observe(McContext context) {
    uint32_t count = 0;
    check(
        mcGetConnectedComponents(context, MC_CONNECTED_COMPONENT_TYPE_FRAGMENT, 0, nullptr, &count),
        "count_components");
    require(count > 0, "no output fragments");
    std::vector<McConnectedComponent> components(count);
    check(mcGetConnectedComponents(context, MC_CONNECTED_COMPONENT_TYPE_FRAGMENT, count,
                                   components.data(), nullptr),
          "list_components");
    Observation result;
    result.components = count;
    for (const auto component : components) {
        Mesh mesh;
        McSize bytes = 0;
        check(mcGetConnectedComponentData(context, component,
                                          MC_CONNECTED_COMPONENT_DATA_VERTEX_DOUBLE, 0, nullptr,
                                          &bytes),
              "size_vertices");
        mesh.vertices.resize(bytes / sizeof(double));
        check(mcGetConnectedComponentData(context, component,
                                          MC_CONNECTED_COMPONENT_DATA_VERTEX_DOUBLE, bytes,
                                          mesh.vertices.data(), nullptr),
              "read_vertices");
        check(mcGetConnectedComponentData(context, component,
                                          MC_CONNECTED_COMPONENT_DATA_FACE_TRIANGULATION, 0,
                                          nullptr, &bytes),
              "size_faces");
        mesh.triangles.resize(bytes / sizeof(uint32_t));
        check(mcGetConnectedComponentData(context, component,
                                          MC_CONNECTED_COMPONENT_DATA_FACE_TRIANGULATION, bytes,
                                          mesh.triangles.data(), nullptr),
              "read_faces");
        require(mesh.triangles.size() % 3 == 0, "nontriangular output");
        for (double value : mesh.vertices)
            result.finite &= std::isfinite(value);
        std::map<std::pair<uint32_t, uint32_t>, std::pair<int, int>> edges;
        for (size_t i = 0; i < mesh.triangles.size(); i += 3)
            for (unsigned j = 0; j < 3; ++j) {
                const auto a = mesh.triangles[i + j], b = mesh.triangles[i + (j + 1) % 3];
                require(a < mesh.vertices.size() / 3 && b < mesh.vertices.size() / 3,
                        "out of range output index");
                auto &edge = edges[std::minmax(a, b)];
                ++edge.first;
                edge.second += a < b ? 1 : -1;
            }
        for (const auto &[key, edge] : edges) {
            result.closed &= edge.first == 2;
            result.oriented &= edge.second == 0;
        }
        result.vertices += mesh.vertices.size() / 3;
        result.triangles += mesh.triangles.size() / 3;
        for (double &value : mesh.vertices)
            value = static_cast<float>(value);
        result.volume += std::abs(signed_volume(mesh));
    }
    check(mcReleaseConnectedComponents(context, 0, nullptr), "release_components");
    return result;
}
static Observation run(McContext context, const Mesh &a, const Mesh &b, unsigned operation) {
    check(dispatch(context, a, b, operation), "dispatch");
    auto result = observe(context);
    require(result.closed && result.oriented && result.finite,
            "invalid output topology or coordinates");
    return result;
}
} // namespace

void run_mcut_context_tests() {
    const auto a = box(0, 0, 0), b = box(.75, .5, .25);
    const auto equal = [](const Observation &x, const Observation &y) {
        require(x.vertices == y.vertices && x.triangles == y.triangles &&
                    x.components == y.components && std::abs(x.volume - y.volume) < 1e-12,
                "Context perturbation state changed across independent Contexts");
    };
    for (unsigned operation = 0; operation < 3; ++operation) {
        Context x, y;
        equal(run(x.handle, a, b, operation), run(y.handle, a, b, operation));
    }
    std::array<Observation, 2> reference;
    {
        Context x;
        reference[0] = run(x.handle, a, b, 0);
        reference[1] = run(x.handle, a, b, 1);
    }
    {
        Context x, y;
        equal(run(x.handle, a, b, 0), reference[0]);
        equal(run(y.handle, a, b, 0), reference[0]);
        equal(run(x.handle, a, b, 1), reference[1]);
        equal(run(y.handle, a, b, 1), reference[1]);
    }
    for (unsigned i = 0; i < 100; ++i) {
        Context x;
        equal(run(x.handle, a, b, 0), reference[0]);
    }
    {
        Context x;
        auto invalid = a;
        invalid.triangles[0] = 999999;
        require(dispatch(x.handle, invalid, b, 0) != MC_NO_ERROR, "Invalid indices accepted");
        equal(run(x.handle, a, b, 0), reference[0]);
    }
    require(contexts_created == contexts_released, "Context release mismatch");
    std::puts("{\"kind\":\"mcut-contexts\",\"passed\":true}");
}
