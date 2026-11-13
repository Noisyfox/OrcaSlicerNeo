// Synchronous, Worker-owned measurement bridge. Native features, snapshots
// and mesh owners never cross the ABI; display buffers have explicit leases.
#include <emscripten/emscripten.h>

#include <charconv>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <string>

#include "bridge_state.hpp"
#include "libslic3r/MeasureUtils.hpp"

namespace {
using namespace Slic3r;
using namespace Slic3r::Neo::Bridge;
using namespace Slic3r::Neo::Measurement;
using nlohmann::json;
using Response = std::unique_ptr<char, decltype(&std::free)>;
using Allocation = std::unique_ptr<void, decltype(&std::free)>;
constexpr std::uint64_t max_safe_integer = 9007199254740991ULL;

Response response(const json& value)
{
    const auto text = value.dump();
    Response result(static_cast<char*>(std::malloc(text.size() + 1)), &std::free);
    if (!result) throw std::bad_alloc();
    std::memcpy(result.get(), text.c_str(), text.size() + 1);
    return result;
}

void fields(const json& value, std::initializer_list<const char*> allowed)
{
    if (!value.is_object()) throw std::invalid_argument("invalid measurement request");
    for (auto it = value.begin(); it != value.end(); ++it) {
        bool found = false;
        for (const auto* key : allowed) if (it.key() == key) found = true;
        if (!found) throw std::invalid_argument("unsupported measurement request field: " + it.key());
    }
}

json request(const char* text, std::initializer_list<const char*> allowed)
{
    auto value = json::parse(text ? text : "");
    fields(value, allowed);
    if (!value.contains("version") || !value["version"].is_number_unsigned() || value["version"] != 1)
        throw std::invalid_argument("invalid measurement protocol version");
    return value;
}

std::uint64_t integer(const json& value, const char* key, std::uint64_t minimum = 1)
{
    if (!value.contains(key) || !value[key].is_number_unsigned()) throw std::invalid_argument("invalid measurement integer");
    const auto number = value[key].get<std::uint64_t>();
    if (number < minimum || number > max_safe_integer) throw std::invalid_argument("invalid measurement integer");
    return number;
}

std::uint64_t handle(const json& value, const char* key, const std::string& prefix)
{
    if (!value.contains(key) || !value[key].is_string()) throw std::invalid_argument("invalid measurement handle");
    const auto text = value[key].get<std::string>();
    if (text.compare(0, prefix.size(), prefix) != 0 || text.size() == prefix.size() || text[prefix.size()] == '0')
        throw std::invalid_argument("invalid measurement handle");
    std::uint64_t result = 0;
    const char* begin = text.data() + prefix.size();
    const char* end = text.data() + text.size();
    const auto parsed = std::from_chars(begin, end, result);
    if (parsed.ec != std::errc{} || parsed.ptr != end || !result || result > max_safe_integer)
        throw std::invalid_argument("invalid measurement handle");
    return result;
}

double number(const json& value)
{
    if (!value.is_number()) throw std::invalid_argument("invalid numeric data");
    const auto result = value.get<double>();
    if (!std::isfinite(result)) throw std::invalid_argument("invalid numeric data");
    return result;
}

json scalar(double value)
{
    if (!std::isfinite(value)) throw std::runtime_error("invalid numeric data");
    return value;
}

json vector(const Vec3d& value) { return json::array({scalar(value.x()), scalar(value.y()), scalar(value.z())}); }
json matrix(const Transform3d& value)
{
    json result = json::array();
    for (int i = 0; i < 16; ++i) result.push_back(scalar(value.data()[i]));
    return result;
}

void array(const json& value, std::size_t count, double* destination)
{
    if (!value.is_array() || value.size() != count) throw std::invalid_argument("invalid measurement vector");
    for (std::size_t i = 0; i < count; ++i) destination[i] = number(value[i]);
}

PointerEvent event(const json& value)
{
    const auto& input = value.at("event");
    fields(input, {"pointer", "viewport", "projection", "view"});
    PointerEvent result;
    array(input.at("pointer"), 2, result.pointer.data());
    array(input.at("viewport"), 4, result.viewport.data());
    array(input.at("projection"), 16, result.projection.data());
    array(input.at("view"), 16, result.view.data());
    return result;
}

std::vector<TargetId> targets(const json& value)
{
    const auto& list = value.at("targets");
    if (!list.is_array() || list.empty()) throw std::invalid_argument("measurement has no targets");
    std::vector<TargetId> result;
    result.reserve(list.size());
    for (const auto& item : list) {
        fields(item, {"objectId", "instanceId", "volumeId"});
        const auto object = integer(item, "objectId"), instance = integer(item, "instanceId"), volume = integer(item, "volumeId");
        if (object > std::numeric_limits<std::size_t>::max() || instance > std::numeric_limits<std::size_t>::max() ||
            volume > std::numeric_limits<std::size_t>::max()) throw std::invalid_argument("invalid measurement target");
        result.push_back({std::size_t(object), std::size_t(instance), std::size_t(volume)});
    }
    return result;
}

void admit()
{
    if (state().history_disabled || state().active_history_transaction ||
        !state().nested_history_transactions.empty() || state().history.operation_active())
        throw std::logic_error("measurement history is busy or disabled");
#ifndef ORCA_WASM_THREADING
    for (const auto& plate : state().plate_session_plates)
        if (state().plate_runtime_registry.has_active_job(plate.id)) throw std::logic_error("serial measurement runtime is busy");
#endif
}

template<class Fn> const char* invoke_cleanup(Fn&& fn)
{
    try { return fn(); }
    catch (const std::exception& error) { return response({{"error", error.what()}}).release(); }
    catch (...) { return response({{"error", "unknown measurement exception"}}).release(); }
}

template<class Fn> const char* invoke(Fn&& fn)
{
    return invoke_cleanup([&] { admit(); return fn(); });
}

std::string session_id(std::uint64_t id) { return "ms-" + std::to_string(id); }
std::string display_id(std::uint64_t id) { return "md-" + std::to_string(id); }
json target(const TargetId& value)
{
    return {{"objectId", value.object}, {"instanceId", value.instance}, {"volumeId", value.volume}};
}

std::string plane_id(std::uint64_t session, std::uint64_t revision, const TargetId& target, int plane)
{
    if (plane < 0) throw std::runtime_error("invalid measurement plane");
    return "mp-" + std::to_string(session) + "-" + std::to_string(revision) + "-" +
        std::to_string(target.object) + "-" + std::to_string(target.instance) + "-" +
        std::to_string(target.volume) + "-" + std::to_string(plane);
}

json feature(const Feature& value, const TargetId& target, std::uint64_t session, std::uint64_t revision)
{
    const auto& surface = value.surface;
    switch (surface.get_type()) {
    case Measure::SurfaceFeatureType::Point:
        return {{"type", "point"}, {"point", vector(surface.get_point())}};
    case Measure::SurfaceFeatureType::Edge: {
        const auto [start, end] = surface.get_edge();
        return {{"type", "edge"}, {"start", vector(start)}, {"end", vector(end)}, {"length", scalar((end - start).norm())},
            {"center", surface.get_extra_point() ? vector(*surface.get_extra_point()) : json(nullptr)}};
    }
    case Measure::SurfaceFeatureType::Circle: {
        const auto [center, radius, normal] = surface.get_circle();
        const double diameter = 2. * (radius * Measure::get_orthogonal(normal, true)).norm();
        return {{"type", "circle"}, {"center", vector(center)}, {"radius", scalar(radius)}, {"normal", vector(normal)},
            {"diameter", scalar(diameter)}};
    }
    case Measure::SurfaceFeatureType::Plane: {
        const auto [plane, normal, point] = surface.get_plane();
        return {{"type", "plane"}, {"normal", vector(normal)}, {"point", vector(point)},
            {"resourceId", plane_id(session, revision, target, plane)}, {"transform", matrix(surface.world_tran)}};
    }
    default: throw std::runtime_error("invalid measurement feature");
    }
}

const char* kind(SelectionKind value)
{
    switch (value) {
    case SelectionKind::Feature: return "feature";
    case SelectionKind::Center: return "center";
    case SelectionKind::Midpoint: return "midpoint";
    case SelectionKind::PointOnFeature: return "pointOnFeature";
    }
    throw std::runtime_error("invalid measurement selection");
}

json item(const SelectionItem& value, std::uint64_t session, std::uint64_t revision)
{
    return {{"target", target(value.target)}, {"kind", kind(value.kind)},
        {"source", feature(value.source, value.target, session, revision)},
        {"value", feature(value.value, value.target, session, revision)}};
}

json distance(const Measure::DistAndPoints& value)
{
    return {{"value", scalar(value.dist)}, {"from", vector(value.from)}, {"to", vector(value.to)}};
}

json result(const SelectionState& selection)
{
    const auto value = selection.result();
    if (!value || !value->has_any_data()) return nullptr;
    json angle = nullptr;
    if (value->angle) {
        const auto& a = *value->angle;
        angle = {{"radians", scalar(a.angle)}, {"center", vector(a.center)},
            {"edge1", json::array({vector(a.e1.first), vector(a.e1.second)})},
            {"edge2", json::array({vector(a.e2.first), vector(a.e2.second)})},
            {"radius", scalar(a.radius)}, {"coplanar", a.coplanar}};
    }
    const bool show_strict = value->distance_strict && (!value->distance_infinite ||
        std::abs(value->distance_strict->dist - value->distance_infinite->dist) > EPSILON);
    return {{"angle", std::move(angle)},
        {"infinite", value->distance_infinite ? distance(*value->distance_infinite) : json(nullptr)},
        {"strict", value->distance_strict ? distance(*value->distance_strict) : json(nullptr)},
        {"xyz", value->distance_xyz ? vector(*value->distance_xyz) : json(nullptr)},
        {"showStrict", show_strict}, {"showXyz", value->distance_xyz && value->distance_xyz->norm() > EPSILON}};
}

json status(std::uint64_t id, std::uint64_t target_revision, std::uint64_t selection_revision, const SelectionState& selection)
{
    return {{"ok", true}, {"version", 1}, {"sessionId", session_id(id)},
        {"targetRevision", target_revision}, {"selectionRevision", selection_revision},
        {"first", selection.first() ? item(*selection.first(), id, target_revision) : json(nullptr)},
        {"second", selection.second() ? item(*selection.second(), id, target_revision) : json(nullptr)},
        {"sameTarget", selection.same_target()}, {"result", result(selection)}};
}

std::uint64_t current_session(const json& value)
{
    const auto id = handle(value, "sessionId", "ms-");
    (void)state().measurement.require(id);
    if (integer(value, "targetRevision") != state().measurement.target_revision())
        throw std::invalid_argument("measurement target revision is stale");
    return id;
}

const char* outcome(Service::Outcome value)
{
    switch (value) {
    case Service::Outcome::Selected: return "selected";
    case Service::Outcome::Mesh: return "mesh";
    case Service::Outcome::Miss: return "miss";
    case Service::Outcome::Close: return "close";
    case Service::Outcome::Unchanged: return "unchanged";
    }
    throw std::runtime_error("invalid measurement outcome");
}

struct Lease { Allocation vertices{nullptr, &std::free}; };
std::map<std::uint64_t, Lease> leases;
std::uint64_t next_lease = 1;

const Feature& display_plane(const Service::Display& display, const std::string& role, TargetId& target)
{
    if (role == "hover" && display.snapshot.hover && display.snapshot.hover->feature) {
        target = display.snapshot.hover->target;
        return *display.snapshot.hover->feature;
    }
    const std::optional<SelectionItem>* selected = nullptr;
    if (role == "first") selected = &display.snapshot.selection.first();
    else if (role == "second") selected = &display.snapshot.selection.second();
    if (!selected || !*selected) throw std::invalid_argument("measurement plane is stale");
    target = (*selected)->target;
    return (*selected)->source;
}
}

extern "C" {
EMSCRIPTEN_KEEPALIVE const char* orc_measure_open(const char* text)
{
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "targets"});
        auto candidate = state().measurement.prepare_open(state().model, targets(value));
        auto out = response(status(candidate->id, 1, 1, candidate->session->selection()));
        state().measurement.publish_open(std::move(candidate));
        return out.release();
    });
}

EMSCRIPTEN_KEEPALIVE const char* orc_measure_read(const char* text)
{
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "sessionId", "targetRevision"});
        const auto id = current_session(value);
        const auto& session = state().measurement.require(id);
        session.validate(state().model);
        return response(status(id, state().measurement.target_revision(), state().measurement.selection_revision(), session.selection())).release();
    });
}

EMSCRIPTEN_KEEPALIVE const char* orc_measure_display(const char* text)
{
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "sessionId", "targetRevision", "event"});
        const auto id = current_session(value);
        auto candidate = state().measurement.prepare_display(state().model, id, event(value));
        const auto& session = state().measurement.require(id);
        json output = status(id, candidate->target_revision, candidate->selection_revision, candidate->snapshot.selection);
        output["displayId"] = display_id(candidate->id);
        output["hover"] = nullptr;
        if (const auto& hover = candidate->snapshot.hover) {
            output["hover"] = {{"target", target(hover->target)}, {"originalFacet", hover->original_facet},
                {"world", vector(hover->world)}, {"local", vector(hover->local)},
                {"feature", hover->feature ? feature(*hover->feature, hover->target, id, candidate->target_revision) : json(nullptr)}};
        }
        output["markers"] = json::array();
        const auto markers = session.markers(state().model, candidate->snapshot);
        for (std::size_t i = 0; i < markers.size(); ++i)
            output["markers"].push_back({{"index", i}, {"position", vector(markers[i].position)},
                {"item", item(markers[i].item, id, candidate->target_revision)}});
        auto out = response(output);
        state().measurement.publish_display(std::move(candidate));
        return out.release();
    });
}

EMSCRIPTEN_KEEPALIVE const char* orc_measure_click(const char* text)
{
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "sessionId", "targetRevision", "displayId", "marker", "shift", "event"});
        const auto id = current_session(value);
        std::optional<std::uint64_t> display;
        if (value.contains("displayId") && !value["displayId"].is_null()) display = handle(value, "displayId", "md-");
        std::optional<std::size_t> marker;
        if (value.contains("marker") && !value["marker"].is_null()) {
            const auto index = integer(value, "marker", 0);
            if (index > std::numeric_limits<std::size_t>::max()) throw std::invalid_argument("invalid measurement marker");
            marker = std::size_t(index);
        }
        if (!value.contains("shift") || !value["shift"].is_boolean()) throw std::invalid_argument("invalid measurement shift flag");
        auto candidate = state().measurement.prepare_click(state().model, id, event(value), display, marker, value["shift"].get<bool>());
        const auto& selected = candidate.selection ? *candidate.selection : state().measurement.require(id).selection();
        json output = status(id, state().measurement.target_revision(), candidate.revision(), selected);
        output["outcome"] = outcome(candidate.outcome);
        auto out = response(output);
        state().measurement.publish_selection(std::move(candidate));
        return out.release();
    });
}

EMSCRIPTEN_KEEPALIVE const char* orc_measure_reset(const char* text)
{
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "sessionId", "targetRevision", "action"});
        const auto id = current_session(value);
        if (!value.contains("action") || !value["action"].is_string()) throw std::invalid_argument("invalid measurement reset action");
        const auto action = value["action"].get<std::string>();
        Service::Reset mode;
        if (action == "first") mode = Service::Reset::First;
        else if (action == "second") mode = Service::Reset::Second;
        else if (action == "all") mode = Service::Reset::All;
        else if (action == "escape") mode = Service::Reset::Escape;
        else throw std::invalid_argument("invalid measurement reset action");
        auto candidate = state().measurement.prepare_reset(state().model, id, mode);
        const auto& selected = candidate.selection ? *candidate.selection : state().measurement.require(id).selection();
        json output = status(id, state().measurement.target_revision(), candidate.revision(), selected);
        output["outcome"] = outcome(candidate.outcome);
        auto out = response(output);
        state().measurement.publish_selection(std::move(candidate));
        return out.release();
    });
}

EMSCRIPTEN_KEEPALIVE const char* orc_measure_rebase(const char* text)
{
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "sessionId", "targetRevision"});
        const auto id = current_session(value);
        auto candidate = state().measurement.prepare_rebase(state().model, id);
        auto out = response(status(id, candidate->target_revision + 1, candidate->selection_revision + 1, candidate->session->selection()));
        state().measurement.publish_rebase(std::move(candidate));
        return out.release();
    });
}

EMSCRIPTEN_KEEPALIVE const char* orc_measure_close(const char* text)
{
    // Cleanup does not need a live target or an idle history transaction.
    return invoke_cleanup([&]() -> const char* {
        const auto value = request(text, {"version", "sessionId"});
        const auto id = handle(value, "sessionId", "ms-");
        (void)state().measurement.require(id);
        auto out = response({{"ok", true}, {"version", 1}, {"sessionId", session_id(id)}});
        state().measurement.reset();
        return out.release();
    });
}

EMSCRIPTEN_KEEPALIVE void orc_measure_display_release(const char* text)
{
    try {
        const auto value = request(text, {"version", "sessionId", "displayId"});
        state().measurement.release_display(handle(value, "sessionId", "ms-"), handle(value, "displayId", "md-"));
    } catch (...) {} // Releases never infer ownership from a pointer or malformed token.
}

EMSCRIPTEN_KEEPALIVE const char* orc_measure_plane(const char* text)
{
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "sessionId", "targetRevision", "displayId", "role", "resourceId"});
        const auto id = current_session(value);
        const auto& session = state().measurement.require(id);
        session.validate(state().model);
        const auto& display = state().measurement.display(id, handle(value, "displayId", "md-"));
        if (!value.contains("role") || !value["role"].is_string() || !value.contains("resourceId") || !value["resourceId"].is_string())
            throw std::invalid_argument("invalid measurement plane request");
        TargetId target{};
        const auto& source = display_plane(display, value["role"].get<std::string>(), target);
        if (source.surface.get_type() != Measure::SurfaceFeatureType::Plane || !source.surface.plane_indices)
            throw std::invalid_argument("measurement plane is stale");
        const auto resource = plane_id(id, display.target_revision, target, std::get<0>(source.surface.get_plane()));
        if (value["resourceId"] != resource) throw std::invalid_argument("measurement plane is stale");
        const auto& indices = *source.surface.plane_indices;
        const auto& mesh = source.geometry->mesh()->its;
        if (indices.size() > std::numeric_limits<std::size_t>::max() / (9 * sizeof(float))) throw std::bad_alloc();
        const auto count = indices.size() * 9;
        Lease lease;
        if (count) {
            lease.vertices.reset(std::malloc(count * sizeof(float)));
            if (!lease.vertices) throw std::bad_alloc();
            auto* output = static_cast<float*>(lease.vertices.get());
            for (int face : indices) {
                if (face < 0 || std::size_t(face) >= mesh.indices.size()) throw std::runtime_error("invalid measurement plane data");
                const auto triangle = mesh.indices[std::size_t(face)];
                Vec3f a = mesh.vertices[triangle[0]], b = mesh.vertices[triangle[1]], c = mesh.vertices[triangle[2]];
                const Vec3f offset = (b - a).cross(c - a).normalized() * .05f;
                for (const Vec3f& p : {Vec3f(a + offset), Vec3f(b + offset), Vec3f(c + offset)})
                    for (int axis = 0; axis < 3; ++axis) *output++ = p[axis];
            }
        }
        if (!next_lease || next_lease > max_safe_integer) throw std::overflow_error("measurement lease exhausted");
        const auto lease_id = next_lease++;
        auto out = response({{"ok", true}, {"version", 1}, {"sessionId", session_id(id)},
            {"targetRevision", display.target_revision}, {"displayId", display_id(display.id)}, {"resourceId", resource},
            {"leaseId", "ml-" + std::to_string(lease_id)},
            {"vertex_ptr", reinterpret_cast<std::uintptr_t>(lease.vertices.get())}, {"vertexCount", count / 3},
            {"transform", matrix(source.surface.world_tran)}});
        leases.emplace(lease_id, std::move(lease));
        return out.release();
    });
}

EMSCRIPTEN_KEEPALIVE void orc_measure_plane_release(const char* text)
{
    try { const auto value = request(text, {"version", "leaseId"}); leases.erase(handle(value, "leaseId", "ml-")); }
    catch (...) {}
}
}
