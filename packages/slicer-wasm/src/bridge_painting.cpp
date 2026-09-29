// Native painting drafts. Model/history publication belongs to the separate
// commit boundary; finished drafts remain pending until consumed or discarded.
#include <emscripten/emscripten.h>
#include <cstdlib>
#include <cstring>
#include <memory>
#include "bridge_state.hpp"
#include "bridge_history.hpp"

namespace {
using namespace Slic3r::Neo::Bridge;
using nlohmann::json;
using namespace Slic3r::Neo::Painting;
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
            {"facetCounts", part.facet_counts()},
            {"draftResourceId", "pd-" + std::to_string(session.id) + "-" + std::to_string(session.revision) + "-" + std::to_string(part.volume_id)}});
    }
    json out = {{"ok", true}, {"version", 1}, {"session", {
        {"id", "ps-" + std::to_string(session.id)},
        {"historySessionId", HistoryMetadata::history_editing_session_id(session.history_session_id)},
        {"revision", session.revision}, {"objectId", session.object_id}, {"instanceId", session.instance_id},
        {"annotation", "mmu"}, {"phase", session.phase == Phase::Idle ? "idle" : session.phase == Phase::Drawing ? "drawing" : "finished"},
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
            {"selectedFacetCount", session.preview->region_selection ? session.preview->region_selection->selected_facet_count() : 0},
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
Settings settings(const json& value) {
    fields(value, {"state", "erase", "radius", "height", "angle", "gapArea"});
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
    if (value.contains("radius")) out.radius = number(value["radius"]);
    if (value.contains("height")) out.height = number(value["height"]);
    if (value.contains("angle")) out.angle = value["angle"].is_null() ? std::optional<double>{} : number(value["angle"]);
    if (value.contains("gapArea")) out.gap_area = number(value["gapArea"]);
    out.validate();
    return out;
}
Tool tool(const json& value) {
    if (!value.is_string()) throw std::invalid_argument("invalid painting tool");
    const auto name = value.get<std::string>();
    if (name == "circle") return Tool::Circle;
    if (name == "sphere") return Tool::Sphere;
    if (name == "triangle") return Tool::Triangle;
    if (name == "height") return Tool::Height;
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
    return {{"ok", true}, {"version", 1}, {"sessionId", "ps-" + std::to_string(session.id)},
        {"revision", session.revision}, {"strokeId", session.active_stroke_id ? json("pst-" + std::to_string(session.id) + "-" + std::to_string(session.active_stroke_id)) : json(nullptr)},
        {"phase", session.phase == Phase::Idle ? "idle" : session.phase == Phase::Drawing ? "drawing" : "finished"},
        {"effective", session.effective}, {"changedPartIds", session.changed_parts}, {"hit", std::move(hit)},
        {"candidateRevision", session.preview ? json(session.revision) : json(nullptr)}};
}
const Session& engine_session(const json& value) {
    const auto& session = state().painting.require(handle(value, "sessionId", "ps-"), integer(value, "revision"), false);
    require_history(session.history_session_id);
    state().painting.validate_target(state().model, session);
    return session;
}
const char* publish(std::unique_ptr<Session> candidate) {
    auto out = response(receipt(*candidate));
    state().painting.publish(std::move(candidate));
    return out.release();
}
template<class Fn> const char* invoke(Fn&& fn) {
    try { admit(); return fn(); }
    catch (const std::exception& error) { return response({{"error", error.what()}}).release(); }
    catch (...) { return response({{"error", "unknown painting exception"}}).release(); }
}
}
extern "C" {
EMSCRIPTEN_KEEPALIVE const char* orc_painting_session_open(const char* text) {
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "historySessionId", "objectId", "instanceId"});
        const auto history_id = handle(value, "historySessionId", "hs-");
        require_history(history_id);
        auto candidate = state().painting.prepare_open(state().model, integer(value, "objectId"), integer(value, "instanceId"),
            state().presets.filament_presets.size(), history_id);
        auto out = response(metadata(*candidate)); // Allocation precedes noexcept publication.
        state().painting.publish(std::move(candidate));
        return out.release();
    });
}
EMSCRIPTEN_KEEPALIVE const char* orc_painting_session_target(const char* text) {
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "sessionId", "revision", "objectId", "instanceId"});
        const auto& previous = state().painting.require(handle(value, "sessionId", "ps-"), integer(value, "revision"));
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
        const auto value = request(text, {"version", "sessionId", "revision"});
        const auto& session = state().painting.require(handle(value, "sessionId", "ps-"), integer(value, "revision"), false);
        require_history(session.history_session_id);
        state().painting.validate_target(state().model, session);
        return response(metadata(session)).release();
    });
}
EMSCRIPTEN_KEEPALIVE const char* orc_painting_session_close(const char* text) {
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "sessionId", "revision"});
        const auto& session = state().painting.require(handle(value, "sessionId", "ps-"), integer(value, "revision"));
        require_history(session.history_session_id);
        auto out = response({{"ok", true}, {"version", 1}});
        state().painting.reset();
        return out.release();
    });
}
EMSCRIPTEN_KEEPALIVE const char* orc_painting_preview(const char* text) {
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "sessionId", "revision", "tool", "settings", "event"});
        const auto& session = engine_session(value);
        return publish(state().painting.prepare_preview(session.id, session.revision, tool(value.at("tool")), settings(value.at("settings")), event(value)));
    });
}
EMSCRIPTEN_KEEPALIVE const char* orc_painting_stroke_begin(const char* text) {
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "sessionId", "revision", "tool", "settings", "event", "candidateRevision"});
        const auto& session = engine_session(value);
        std::optional<std::uint64_t> candidate;
        if (value.contains("candidateRevision")) candidate = integer(value, "candidateRevision");
        return publish(state().painting.prepare_begin(session.id, session.revision, tool(value.at("tool")), settings(value.at("settings")), event(value), candidate));
    });
}
EMSCRIPTEN_KEEPALIVE const char* orc_painting_stroke_sample(const char* text) {
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "sessionId", "revision", "strokeId", "settings", "event"});
        const auto& session = engine_session(value);
        const auto input = event(value);
        if (!input) throw std::invalid_argument("painting sample requires an event");
        return publish(state().painting.prepare_sample(session.id, session.revision, stroke(value, session.id), settings(value.at("settings")), *input));
    });
}
EMSCRIPTEN_KEEPALIVE const char* orc_painting_stroke_finish(const char* text) {
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "sessionId", "revision", "strokeId"});
        const auto& session = engine_session(value);
        return publish(state().painting.prepare_finish(session.id, session.revision, stroke(value, session.id)));
    });
}
EMSCRIPTEN_KEEPALIVE const char* orc_painting_stroke_cancel(const char* text) {
    return invoke([&]() -> const char* {
        const auto value = request(text, {"version", "sessionId", "revision", "strokeId"});
        const auto& session = engine_session(value);
        return publish(state().painting.prepare_cancel(session.id, session.revision, stroke(value, session.id)));
    });
}
}
