// Worker-owned drafts, binary display resources and atomic Paint publication.
// Finished drafts remain pending until explicitly committed or discarded.
#include <emscripten/emscripten.h>
#include <cstdlib>
#include <cstring>
#include <memory>
#include "bridge_state.hpp"
#include "bridge_history.hpp"
#include "bridge_painting.hpp"
#include "painting/PaintingProfile.hpp"
#include "bridge_plate.hpp"
#include "bridge_filament.hpp"
#include "bridge_prime_tower.hpp"
#include "bridge_slicing_pipeline.hpp"

namespace {
using namespace Slic3r::Neo::Bridge;
using nlohmann::json;
using namespace Slic3r::Neo::Painting;
#ifdef NEO_PROJECT_HISTORY_TEST
bool fail_next_commit = false;
#endif
using Response = std::unique_ptr<char, decltype(&std::free)>;
Response response(const json& value) {
    const auto text = value.dump();
    Response result(static_cast<char*>(std::malloc(text.size() + 1)), &std::free);
    if (!result) throw std::bad_alloc();
    std::memcpy(result.get(), text.c_str(), text.size() + 1);
    return result;
}
json request(const char* text, std::initializer_list<const char*> fields) {
    const auto value = json::parse(text ? text : "");
    if (!value.is_object()) throw std::invalid_argument("painting request must be an object");
    for (auto it = value.begin(); it != value.end(); ++it) {
        bool found = false;
        for (const auto* field : fields) if (it.key() == field) found = true;
        if (!found) throw std::invalid_argument("unsupported painting request field: " + it.key());
    }
    if (!value.contains("version") || !value["version"].is_number_unsigned() || value["version"] != 1) throw std::invalid_argument("invalid painting protocol version");
    return value;
}
Channel channel(const json& value) {
    if (!value.contains("channel") || !value["channel"].is_string()) throw std::invalid_argument("missing or invalid painting channel");
    const auto name = value["channel"].get<std::string>();
    if (name == "mmu") return Channel::Mmu;
    if (name == "support") return Channel::Support;
    if (name == "seam") return Channel::Seam;
    if (name == "fuzzy") return Channel::Fuzzy;
    throw std::invalid_argument("invalid painting channel");
}
void require_channel(const json& value, const Session& session) {
    if (channel(value) != session.channel) throw std::invalid_argument("painting channel is stale");
}
std::uint64_t integer(const json& value, const char* key) {
    if (!value.contains(key) || !value[key].is_number_unsigned()) throw std::invalid_argument(std::string("invalid painting ") + key);
    const auto number = value[key].get<std::uint64_t>();
    if (!number || number > 9007199254740991ULL) throw std::invalid_argument(std::string("invalid painting ") + key);
    return number;
}
std::uint64_t handle(const json& value, const char* key, const char* prefix) {
    if (!value.contains(key) || !value[key].is_string()) throw std::invalid_argument("missing painting session handle");
    auto text = value[key].get<std::string>();
    if (text.compare(0, 3, prefix) != 0) throw std::invalid_argument("invalid painting session handle");
    text.replace(0, 3, "hs-");
    std::uint64_t id;
    if (!HistoryMetadata::parse_history_editing_session_id(text, id)) throw std::invalid_argument("invalid painting session handle");
    return id;
}
void admit() {
    if (state().history_disabled || state().active_history_transaction ||
        !state().nested_history_transactions.empty() || state().history.operation_active())
        throw std::logic_error("painting history is busy or disabled");
#ifndef ORCA_WASM_THREADING
    for (const auto& plate : state().plate_session_plates)
        if (state().plate_runtime_registry.has_active_job(plate.id)) throw std::logic_error("serial painting runtime is busy");
#endif
}
void require_history(std::uint64_t id) {
    const auto current = state().history.editing_session_status();
    if (!current || current->id != id) throw std::invalid_argument("painting history session is stale");
}
json metadata(const Slic3r::Neo::Painting::Session& session) {
    json parts = json::array();
    for (const auto& part : session.parts) {
        parts.push_back({{"volumeId", part.volume_id}, {"sourceTriangleCount", part.mesh->its.indices.size()},
            {"annotationTimestamp", part.annotation_timestamp}, {"facetCounts", part.facet_counts()},
            {"volumeTransform", std::vector<double>(part.volume_transform.data(), part.volume_transform.data() + 16)},
            {"draftResourceId", "pd-" + std::string(channel_name(session.channel)) + "-" + std::to_string(session.id) + "-" + std::to_string(part.geometry_revision) + "-" + std::to_string(part.volume_id)}});
    }
    json out = {{"ok", true}, {"version", 1}, {"session", {
        {"id", "ps-" + std::to_string(session.id)},
        {"historySessionId", HistoryMetadata::history_editing_session_id(session.history_session_id)},
        {"revision", session.revision}, {"objectId", session.object_id}, {"instanceId", session.instance_id},
        {"channel", channel_name(session.channel)}, {"instanceTransform", std::vector<double>(session.instance_transform.data(), session.instance_transform.data() + 16)}, {"phase", session.phase == Phase::Idle ? "idle" : session.phase == Phase::Drawing ? "drawing" : "finished"},
        {"strokeId", session.active_stroke_id ? json("pst-" + std::to_string(session.id) + "-" + std::to_string(session.active_stroke_id)) : json(nullptr)},
        {"parts", std::move(parts)} }}};
    if (session.preview) {
        json preview_parts = json::array();
        for (std::size_t i = 0; i < session.parts.size(); ++i) {
            std::array<std::size_t, 17> counts{};
            for (int state = 0; state <= 16; ++state)
                counts[state] = session.preview->selectors[i]->num_facets(static_cast<Slic3r::EnforcerBlockerType>(state));
            preview_parts.push_back({{"volumeId", session.parts[i].volume_id}, {"facetCounts", counts}});
        }
        std::size_t gap_regions = 0;
        for (const auto& regions : session.preview->gap_regions) gap_regions += regions.size();
        out["session"]["candidate"] = {{"revision", session.revision}, {"parts", std::move(preview_parts)},
            {"selectedFacetCount", session.preview->facet_selection ? session.preview->facet_selection->selected_facet_count() : 0},
            {"gapRegionCount", gap_regions}};
    }
    return out;
}
void fields(const json& value, std::initializer_list<const char*> allowed) {
    if (!value.is_object()) throw std::invalid_argument("painting value must be an object");
    for (auto it = value.begin(); it != value.end(); ++it) {
        bool found = false;
        for (const auto* key : allowed) if (it.key() == key) found = true;
        if (!found) throw std::invalid_argument("unsupported painting field: " + it.key());
    }
}
double number(const json& value) {
    if (!value.is_number()) throw std::invalid_argument("painting value must be numeric");
    const double out = value.get<double>();
    if (!std::isfinite(out)) throw std::invalid_argument("painting value must be finite");
    return out;
}
Settings settings(const json& value, Channel channel) {
    fields(value, {"state", "erase", "radius", "height", "angle", "gapArea", "vertical", "overhangAngle", "restrictToOverhangs"});
    Settings out;
    if (value.contains("state")) {
        const double state = number(value["state"]);
        if (state < 0 || state > 16 || std::floor(state) != state) throw std::invalid_argument("invalid painting state");
        out.state = int(state);
    }
    if (value.contains("erase")) {
        if (!value["erase"].is_boolean()) throw std::invalid_argument("invalid painting erase setting");
        out.erase = value["erase"].get<bool>();
    }
    if (value.contains("vertical")) {
        if (!value["vertical"].is_boolean()) throw std::invalid_argument("invalid painting vertical setting");
        out.vertical = value["vertical"].get<bool>();
    }
    if (value.contains("radius")) out.radius = number(value["radius"]);
    if (value.contains("height")) out.height = number(value["height"]);
    if (value.contains("angle")) out.angle = value["angle"].is_null() ? std::optional<double>{} : number(value["angle"]);
    if (value.contains("gapArea")) out.gap_area = number(value["gapArea"]);
    if (value.contains("overhangAngle")) {
        if (channel != Channel::Support) throw std::invalid_argument("overhang settings are support-only");
        out.overhang_angle = value["overhangAngle"].is_null() ? std::optional<double>{} : number(value["overhangAngle"]);
    }
    if (value.contains("restrictToOverhangs")) {
        if (!value["restrictToOverhangs"].is_boolean()) throw std::invalid_argument("invalid overhang restriction");
        out.restrict_to_overhangs = value["restrictToOverhangs"].get<bool>();
    }
    out.validate(channel);
    return out;
}
Tool tool(const json& value) {
    if (!value.is_string()) throw std::invalid_argument("invalid painting tool");
    const auto name = value.get<std::string>();
    if (name == "circle") return Tool::Circle;
    if (name == "sphere") return Tool::Sphere;
    if (name == "triangle") return Tool::Triangle;
    if (name == "height") return Tool::Height;
    if (name == "smartFill") return Tool::SmartFill;
    if (name == "overhang") return Tool::Overhang;
    if (name == "region") return Tool::Region;
    if (name == "gap") return Tool::Gap;
    if (name == "eraseAll") return Tool::EraseAll;
    throw std::invalid_argument("invalid painting tool");
}
void array(const json& value, std::size_t size, double* output) {
    if (!value.is_array() || value.size() != size) throw std::invalid_argument("invalid painting vector/matrix");
    for (std::size_t i = 0; i < size; ++i) output[i] = number(value[i]);
}
std::optional<PointerEvent> event(const json& value) {
    if (!value.contains("event")) return {};
    const auto& input = value["event"];
    fields(input, {"pointer", "viewport", "projection", "view"});
    PointerEvent out;
    array(input.at("pointer"), 2, out.pointer.data());
    array(input.at("viewport"), 4, out.viewport.data());
    array(input.at("projection"), 16, out.projection.data());
    array(input.at("view"), 16, out.view.data());
    return out;
}
std::uint64_t stroke(const json& value, std::uint64_t session) {
    if (!value.contains("strokeId") || !value["strokeId"].is_string()) throw std::invalid_argument("missing painting stroke");
    const auto text = value["strokeId"].get<std::string>();
    const auto prefix = "pst-" + std::to_string(session) + "-";
    if (text.compare(0, prefix.size(), prefix) != 0) throw std::invalid_argument("painting stroke belongs to another session");
    std::uint64_t out;
    if (!HistoryMetadata::parse_history_editing_session_id("hs-" + text.substr(prefix.size()), out)) throw std::invalid_argument("invalid painting stroke");
    return out;
}
json receipt(const Session& session) {
    json hit = nullptr;
    const auto& selected = session.preview ? session.preview->hit : session.last_hit;
    if (selected) hit = {{"volumeId", session.parts[selected->part].volume_id}, {"originalFacet", selected->original_facet},
        {"world", {selected->world.x(), selected->world.y(), selected->world.z()}}};
    json out = {{"ok", true}, {"version", 1}, {"sessionId", "ps-" + std::to_string(session.id)}, {"channel", channel_name(session.channel)},
        {"revision", session.revision}, {"strokeId", session.active_stroke_id ? json("pst-" + std::to_string(session.id) + "-" + std::to_string(session.active_stroke_id)) : json(nullptr)},
        {"phase", session.phase == Phase::Idle ? "idle" : session.phase == Phase::Drawing ? "drawing" : "finished"},
        {"effective", session.effective}, {"changedPartIds", session.changed_parts}, {"hit", std::move(hit)},
        {"candidateRevision", session.preview && session.phase == Phase::Idle ? json(session.revision) : json(nullptr)}};
#ifdef NEO_PAINTING_PROFILE
    out["paintingProfile"] = {{"nativeHitUs", Profile::hit.microseconds}, {"nativeHitCalls", Profile::hit.calls},
        {"nativeSelectorUs", Profile::selector.microseconds}, {"nativeSelectorCalls", Profile::selector.calls},
        {"nativeGeometryUs", Profile::geometry.microseconds}, {"nativeGeometryCalls", Profile::geometry.calls}};
#endif
    return out;
}
const Session& engine_session(const json& value) {
    const auto& session = state().painting.require(handle(value, "sessionId", "ps-"), integer(value, "revision"), false);
    require_channel(value, session);
    require_history(session.history_session_id);
    state().painting.validate_target(state().model, session);
    return session;
}
const char* publish(std::unique_ptr<Session> candidate, bool selection_receipt = true) {
    state().painting.update_geometry_revisions(*candidate);
    auto result = receipt(*candidate);
    if (!selection_receipt) result["candidateRevision"] = nullptr;
    auto out = response(result);
    state().painting.publish(std::move(candidate));
    return out.release();
}
json settle() {
    auto& bridge = state();
    const auto* runtime = bridge.plate_runtime_registry.find(bridge.current_plate_id);
    const json key = {bridge.painting_derived_version, bridge.history.current_timestamp(), PlateSession::current_plate_session_sequence(),
        bridge.plate_input_revisions, bridge.current_plate_id, runtime ? runtime->result_generation : 0};
    if (bridge.painting_settlement_key != key) {
        auto result = json{{"materials", Filament::Session::filament_session_snapshot_json()},
                           {"primeTower", PrimeTower::projection_json()}};
        bridge.painting_settlement = std::move(result);
        ++bridge.painting_settled_version;
        bridge.painting_settlement_key = key;
    }
    // Metadata-only history transitions must not rescan material use. Their
    // optimistic command epoch remains current in the cached projection.
    if (bridge.painting_settlement.contains("materials") && bridge.painting_settlement["materials"].contains("revisions")) {
        bridge.painting_settlement["materials"]["revisions"]["session"] = bridge.history_revision;
        bridge.painting_settlement["materials"]["revisions"]["project"] = bridge.history_revision;
    }
    return {{"ok", true}, {"version", 1}, {"settledVersion", bridge.painting_settled_version},
            {"projections", bridge.painting_settlement}};
}
std::string resource_id(const Session& session, const PartDraft& part) {
    return "pd-" + std::string(channel_name(session.channel)) + "-" + std::to_string(session.id) + "-" + std::to_string(part.geometry_revision) + "-" + std::to_string(part.volume_id);
}
struct Buffers {
    std::vector<std::unique_ptr<void, decltype(&std::free)>> allocations;
    std::uintptr_t copy(const std::vector<float>& values) {
        if (values.empty()) return 0;
        std::unique_ptr<void, decltype(&std::free)> ptr(std::malloc(values.size() * sizeof(float)), &std::free);
        if (!ptr) throw std::bad_alloc();
        std::memcpy(ptr.get(), values.data(), values.size() * sizeof(float));
        const auto address = reinterpret_cast<std::uintptr_t>(ptr.get());
        allocations.push_back(std::move(ptr));
        return address;
    }

};
// Request-owned leases survive session/history resets until the synchronous client
// copies and releases them. IDs never repeat; release never trusts payload pointers.
std::map<std::uint64_t, Buffers> geometry_leases;
std::uint64_t next_geometry_lease = 1;
json geometry(Buffers& buffers, const NativeSelector::Display& data, const std::vector<float>& contour,
              std::size_t volume, const std::string& id, const char* kind) {
    return {{"volumeId", volume}, {"resourceId", id}, {"kind", kind},
        {"vertex_ptr", buffers.copy(data.vertices)}, {"vertexCount", data.vertices.size() / 6},
        {"groups", data.groups}, {"contour_ptr", buffers.copy(contour)}, {"contourVertexCount", contour.size() / 3}};
}
template<class Fn> const char* invoke(Fn&& fn) {
    try { admit(); return fn(); }
    catch (const std::exception& error) { return response({{"error", error.what()}}).release(); }
    catch (...) { return response({{"error", "unknown painting exception"}}).release(); }
}
}
namespace Slic3r::Neo::Bridge::PaintingBridge {
void settle_dependencies() { if (state().painting_derived_version) (void)settle(); }
bool use_deferred_projection() {
    // Live external transactions may mutate config before their timestamp is
    // published. They use ordinary authoritative readers, as do closed gizmos.
    return state().painting.current() && state().painting_derived_version &&
        !state().history.operation_active() && !state().active_history_transaction;
}
nlohmann::json material_projection() { return use_deferred_projection() ? settle()["projections"]["materials"] : Filament::Session::filament_session_snapshot_json(); }
nlohmann::json tower_projection() { return settle()["projections"]["primeTower"]; }
}
extern "C" {
#ifdef NEO_PROJECT_HISTORY_TEST
EMSCRIPTEN_KEEPALIVE void orc_painting_test_fail_next_commit() { fail_next_commit = true; }
#endif
EMSCRIPTEN_KEEPALIVE const char* orc_painting_session_open(const char* text) {
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "channel", "historySessionId", "objectId", "instanceId"});
        const auto history_id = handle(value, "historySessionId", "hs-");
        require_history(history_id);
        auto candidate = state().painting.prepare_open(state().model, integer(value, "objectId"), integer(value, "instanceId"),
            channel(value), Slic3r::Neo::Bridge::Filament::State::material_slot_count(state().presets.project_config), history_id);
        auto out = response(metadata(*candidate)); // Allocation precedes noexcept publication.
        state().painting.publish(std::move(candidate));
        return out.release();
    });
}
EMSCRIPTEN_KEEPALIVE const char* orc_painting_session_target(const char* text) {
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "channel", "sessionId", "revision", "objectId", "instanceId"});
        const auto& previous = state().painting.require(handle(value, "sessionId", "ps-"), integer(value, "revision"));
        require_channel(value, previous);
        require_history(previous.history_session_id);
        auto candidate = state().painting.prepare_target(state().model, previous.id, previous.revision,
            integer(value, "objectId"), integer(value, "instanceId"));
        auto out = response(metadata(*candidate));
        state().painting.publish(std::move(candidate));
        return out.release();
    });
}
EMSCRIPTEN_KEEPALIVE const char* orc_painting_session_read(const char* text) {
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "channel", "sessionId", "revision", "latest"});
        const auto requested_revision = integer(value, "revision");
        if (value.contains("latest") && !value["latest"].is_boolean()) throw std::invalid_argument("invalid latest read flag");
        const auto& session = state().painting.require(handle(value, "sessionId", "ps-"), value.value("latest", false) && state().painting.current() ? state().painting.current()->revision : requested_revision, false);
        require_channel(value, session);
        require_history(session.history_session_id);
        state().painting.validate_target(state().model, session);
        return response(metadata(session)).release();
    });
}
EMSCRIPTEN_KEEPALIVE const char* orc_painting_session_close(const char* text) {
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "channel", "sessionId", "revision"});
        const auto& session = state().painting.require(handle(value, "sessionId", "ps-"), integer(value, "revision"));
        require_channel(value, session);
        require_history(session.history_session_id);
        (void)settle();
        auto out = response({{"ok", true}, {"version", 1}, {"channel", channel_name(session.channel)}});
        state().painting.reset();
        return out.release();
    });
}
EMSCRIPTEN_KEEPALIVE const char* orc_painting_preview(const char* text) {
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "channel", "sessionId", "revision", "tool", "settings", "event"});
        const auto& session = engine_session(value);
        const auto selected_tool = tool(value.at("tool"));
        if (selected_tool == Tool::Overhang && !value.at("settings").contains("overhangAngle")) throw std::invalid_argument("highlight preview requires overhangAngle or null");
        return publish(state().painting.prepare_preview(session.id, session.revision, selected_tool, settings(value.at("settings"), session.channel), event(value)), selected_tool != Tool::Overhang);
    });
}
EMSCRIPTEN_KEEPALIVE const char* orc_painting_stroke_begin(const char* text) {
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "channel", "sessionId", "revision", "tool", "settings", "event", "candidateRevision"});
        const auto& session = engine_session(value);
        std::optional<std::uint64_t> candidate;
        if (value.contains("candidateRevision")) candidate = integer(value, "candidateRevision");
        return publish(state().painting.prepare_begin(session.id, session.revision, tool(value.at("tool")), settings(value.at("settings"), session.channel), event(value), candidate));
    });
}
EMSCRIPTEN_KEEPALIVE const char* orc_painting_stroke_sample(const char* text) {
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "channel", "sessionId", "revision", "strokeId", "settings", "event"});
        const auto& session = engine_session(value);
        const auto input = event(value);
        if (!input) throw std::invalid_argument("painting sample requires an event");
        return publish(state().painting.prepare_sample(session.id, session.revision, stroke(value, session.id), settings(value.at("settings"), session.channel), *input));
    });
}
EMSCRIPTEN_KEEPALIVE const char* orc_painting_stroke_finish(const char* text) {
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "channel", "sessionId", "revision", "strokeId"});
        const auto& session = engine_session(value);
        return publish(state().painting.prepare_finish(session.id, session.revision, stroke(value, session.id)));
    });
}
EMSCRIPTEN_KEEPALIVE const char* orc_painting_stroke_cancel(const char* text) {
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "channel", "sessionId", "revision", "strokeId"});
        const auto& session = engine_session(value);
        return publish(state().painting.prepare_cancel(session.id, session.revision, stroke(value, session.id)));
    });
}
EMSCRIPTEN_KEEPALIVE const char* orc_painting_geometry(const char* text) {
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "channel", "sessionId", "revision", "knownResourceIds"});
        const auto& session = engine_session(value);
        std::set<std::string> known;
        if (value.contains("knownResourceIds")) {
            if (!value["knownResourceIds"].is_array()) throw std::invalid_argument("invalid known painting resources");
            for (const auto& key : value["knownResourceIds"]) known.insert(key.get<std::string>());
        }
        Buffers buffers;
        json resources = json::array(), parts = json::array(), candidates = json::array();
        {
#ifdef NEO_PAINTING_PROFILE
        Profile::Scope profile_geometry(Profile::geometry);
#endif
        for (std::size_t i = 0; i < session.parts.size(); ++i) {
            const auto& part = session.parts[i];
            const auto key = resource_id(session, part);
            parts.push_back({{"volumeId", part.volume_id}, {"resourceId", key}});
            if (!known.count(key)) resources.push_back(geometry(buffers, part.selector->display(), {}, part.volume_id, key, "draft"));
            if (session.highlight_angle) {
                const auto highlight_key = "ph-support-" + std::to_string(session.id) + "-" + std::to_string(part.geometry_revision) + "-" + std::to_string(part.volume_id) + "-" + std::to_string(session.highlight_revision);
                candidates.push_back({{"volumeId", part.volume_id}, {"resourceId", highlight_key}, {"kind", "overhang"}});
                if (!known.count(highlight_key)) {
                    const auto membership = part.selector->overhang_facets(session.instance_transform * part.volume_transform, *session.highlight_angle);
                    resources.push_back(geometry(buffers, part.selector->display(&membership), {}, part.volume_id, highlight_key, "overhang"));
                }
            }
            if (!session.preview) continue;
            const auto prefix = "pc-" + std::string(channel_name(session.channel)) + "-" + std::to_string(session.id) + "-" + std::to_string(session.revision) + "-" + std::to_string(part.volume_id);
            if (session.preview->facet_selection && session.preview->hit && session.preview->hit->part == i) {
                const char* kind = session.preview->tool == Tool::Triangle ? "triangle" : session.preview->tool == Tool::SmartFill ? "smartFill" : "region";
                candidates.push_back({{"volumeId", part.volume_id}, {"resourceId", prefix}, {"kind", kind}});
                if (!known.count(prefix)) resources.push_back(geometry(buffers, session.preview->facet_selection->display(nullptr, true),
                    session.preview->facet_selection->contour(), part.volume_id, prefix, kind));
            }
            if (i < session.preview->gap_regions.size()) {
                std::size_t index = 0;
                for (const auto& patch : session.preview->gap_regions[i]) {
                    const auto patch_key = prefix + "-" + std::to_string(index++);
                    candidates.push_back({{"volumeId", part.volume_id}, {"resourceId", patch_key}, {"kind", "gap"}});
                    if (known.count(patch_key)) continue;
                    const std::set<int> membership(patch.facets.begin(), patch.facets.end());
                    auto display = part.selector->display(&membership);
                    // Membership IDs belong to the original selector; the
                    // prospective clone can renumber its leaves. Paint this
                    // native patch with the same destination used by Apply.
                    for (auto& group : display.groups) group[0] = std::size_t(*patch.neighbors.begin());
                    resources.push_back(geometry(buffers, std::move(display), {}, part.volume_id,
                        patch_key, "gap"));
                }
            }
        }
        }
        if (!next_geometry_lease) throw std::overflow_error("painting geometry lease exhausted");
        const auto lease = next_geometry_lease++;
#ifdef NEO_PAINTING_PROFILE
        const auto previous_geometry_leases = geometry_leases.size();
#endif
        geometry_leases.emplace(lease, std::move(buffers));
        try {
            json result = {{"ok", true}, {"version", 1}, {"leaseId", "pg-" + std::to_string(lease)}, {"sessionId", "ps-" + std::to_string(session.id)}, {"channel", channel_name(session.channel)},
                {"revision", session.revision}, {"parts", std::move(parts)}, {"candidates", std::move(candidates)}, {"resources", std::move(resources)}};
#ifdef NEO_PAINTING_PROFILE
            result["paintingProfile"] = {{"nativeHitUs", Profile::hit.microseconds}, {"nativeHitCalls", Profile::hit.calls},
                {"nativeSelectorUs", Profile::selector.microseconds}, {"nativeSelectorCalls", Profile::selector.calls},
                {"nativeGeometryUs", Profile::geometry.microseconds}, {"nativeGeometryCalls", Profile::geometry.calls},
                {"previousGeometryLeases", previous_geometry_leases}, {"currentGeometryLeases", geometry_leases.size()}};
#endif
            auto out = response(result);
            return out.release();
        } catch (...) { geometry_leases.erase(lease); throw; }
    });
}
EMSCRIPTEN_KEEPALIVE void orc_painting_geometry_release(const char* text) {
    // No admission or live session requirement. Unknown/duplicate leases are safe.
    try { const auto value = request(text, {"version", "leaseId"}); geometry_leases.erase(handle(value, "leaseId", "pg-")); }
    catch (...) {} // Malformed ownership tokens cannot authorize speculative frees.
}
EMSCRIPTEN_KEEPALIVE const char* orc_painting_settle(const char* text) {
    return invoke([&]() -> const char* {
        (void)request(text, {"version"});
        return response(settle()).release();
    });
}
EMSCRIPTEN_KEEPALIVE const char* orc_painting_stroke_commit(const char* text) {
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "channel", "sessionId", "revision", "strokeId", "settings", "event"});
        const auto& session = engine_session(value);
        const auto stroke_id = stroke(value, session.id);
        if (session.phase == Phase::Idle || stroke_id != session.active_stroke_id) throw std::invalid_argument("painting stroke is stale");
        // Even response/recovery allocation failure must not retain a failed
        // draft. This guard needs no allocation; stale requests never own it.
        struct DiscardOnFailure {
            Sessions& owner; bool released = false;
            ~DiscardOnFailure() { if (!released) owner.discard_pending(); }
        } discard{state().painting};
        // Prepare recovery before any mutation. Every recoverable commit failure
        // discards the whole draft, including a failed final endpoint.
        auto recovery = state().painting.prepare_cancel(session.id, session.revision, stroke_id);
        state().painting.update_geometry_revisions(*recovery);
        Slic3r::Model backup_model;
        auto* backup_owner = backup_model.add_object();
        std::vector<std::pair<Slic3r::ModelVolume*, Slic3r::ModelVolume*>> backups;
        bool started = false;
        auto old_revisions = state().plate_input_revisions;
        auto old_lifecycle = state().plate_runtime_registry.capture_lifecycle();
        auto old_context = state().history_live_context;
        try {
            std::optional<Settings> final_settings;
            if (value.contains("settings")) final_settings = settings(value["settings"], session.channel);
            auto candidate = state().painting.prepare_commit(session.id, session.revision, stroke_id, final_settings, event(value));
            const bool effective = candidate->effective;
            const auto changed = candidate->changed_parts;
            std::set<std::string> affected;
            Response out(nullptr, &std::free);
            if (effective) {
                auto context = state().history_live_context;
                if (!context.contains("plateSession")) context = HistoryMetadata::default_history_context(state(),
                    PlateSession::plate_session_snapshot_json(), Filament::State::history_state_json(state().presets));
                auto before = HistoryMetadata::capture_history_roots(state(), context);
                if (!state().history.begin_operation(history_name(candidate->channel), before, Slic3r::Neo::History::TimestampedOperationKind::Paint))
                    throw std::logic_error("could not begin painting history");
                started = true;
                for (auto* object : state().model.objects) if (object->id().id == candidate->object_id) {
                    std::set<std::size_t> instances;
                    for (const auto* instance : object->instances) instances.insert(instance->id().id);
                    affected = PlateSession::member_plate_ids_for_instances(instances);
                    for (auto* volume : object->volumes) {
                        if (std::find(changed.begin(), changed.end(), volume->id().id) == changed.end()) continue;
                        backups.emplace_back(volume, backup_owner->add_volume(*volume));
                        auto part = std::find_if(candidate->parts.begin(), candidate->parts.end(),
                            [&](const auto& part) { return part.volume_id == volume->id().id; });
                        for (auto used : Slic3r::TriangleSelector::extract_used_facet_states(part->selector->serialize()))
                            if (candidate->channel == Channel::Mmu && std::size_t(used) > Slic3r::Neo::Bridge::Filament::State::material_slot_count(state().presets.project_config)) throw std::invalid_argument("painting state has no filament slot");
                        annotation(*volume, candidate->channel).set(*part->selector);
                        part->annotation_timestamp = annotation(*volume, candidate->channel).timestamp();
                    }
                }
                for (const auto& id : affected) state().plate_input_revisions[id] = allocate_plate_input_stamp(state());
                state().plate_runtime_registry.invalidate_presentations(affected);
                context["plateSession"]["input_revisions"] = PlateSession::plate_revisions_json();
                auto after = HistoryMetadata::capture_history_roots(state(), context);
                Sessions::complete(*candidate);
                if (!state().history.commit_operation(after, nullptr, [&](const auto& history) {
                    auto result = receipt(*candidate);
                    result["committed"] = true; result["changedPartIds"] = changed;
                    result["affectedPlateIds"] = affected;
                    result["history"] = HistoryMetadata::history_status_json(state(), history, state().history_revision + 1);
#ifdef NEO_PROJECT_HISTORY_TEST
                    if (fail_next_commit) { fail_next_commit = false; throw std::runtime_error("injected painting commit failure"); }
#endif
                    out = response(result);
                })) throw std::logic_error("could not commit painting history");
                started = false;
                state().history_live_context.swap(context);
                HistoryMetadata::advance_history_epoch(state());
                // MMU and support painting affect material/support use. Seam
                // and fuzzy alter slicing but retain material-use summaries.
                // Evict only after the history response has been prepared, so
                // failed publication leaves warm caches and settlement intact.
                if (candidate->channel == Channel::Mmu || candidate->channel == Channel::Support) {
                    PrimeTower::invalidate_projection_cache_and_usage_summaries(affected);
                    ++state().painting_derived_version;
                } else {
                    PrimeTower::invalidate_projection_cache(affected);
                }
                // Only noexcept publication work follows the history swap.
            } else {
                Sessions::complete(*candidate);
                auto result = receipt(*candidate); result["committed"] = false;
                result["affectedPlateIds"] = json::array(); result["history"] = HistoryMetadata::history_status_json(state());
                out = response(result);
            }
            state().painting.publish(std::move(candidate));
            discard.released = true;
            return out.release();
        } catch (const std::exception& error) {
            if (started) HistoryMetadata::abort_timestamped_operation(state());
            for (auto& [volume, backup] : backups) annotation(*volume, recovery->channel).assign(std::move(annotation(*backup, recovery->channel)));
            state().mutable_object_capture_cache.clear();
            state().plate_input_revisions.swap(old_revisions);
            state().plate_runtime_registry.restore_lifecycle(old_lifecycle);
            state().history_live_context.swap(old_context);
            auto result = receipt(*recovery); result["error"] = error.what(); result["recovered"] = true;
            auto out = response(result);
            state().painting.publish(std::move(recovery));
            discard.released = true;
            return out.release();
        }
    });
}

}
