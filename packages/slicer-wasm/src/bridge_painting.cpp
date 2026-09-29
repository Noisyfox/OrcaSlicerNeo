// Lifecycle-only painting ABI. Tool samples, geometry publication and commits
// are deliberately absent until their native implementations are complete.
#include <emscripten/emscripten.h>
#include <cstdlib>
#include <cstring>
#include <memory>
#include "bridge_state.hpp"
#include "bridge_history.hpp"

namespace {
using namespace Slic3r::Neo::Bridge;
using nlohmann::json;
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
    return {{"ok", true}, {"version", 1}, {"session", {
        {"id", "ps-" + std::to_string(session.id)},
        {"historySessionId", HistoryMetadata::history_editing_session_id(session.history_session_id)},
        {"revision", session.revision}, {"objectId", session.object_id}, {"instanceId", session.instance_id},
        {"annotation", "mmu"}, {"phase", "idle"}, {"strokeId", nullptr}, {"parts", std::move(parts)} }}};
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
        const auto& session = state().painting.require(handle(value, "sessionId", "ps-"), integer(value, "revision"));
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
}
