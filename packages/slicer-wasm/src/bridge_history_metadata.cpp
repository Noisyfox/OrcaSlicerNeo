#include "bridge_history_metadata.hpp"

#include <limits>
#include <stdexcept>

namespace Slic3r::Neo::Bridge::HistoryMetadata {

std::string history_entry_id(const std::uint64_t id)
{
    return std::string("entry-") + std::to_string(id);
}

bool parse_history_entry_id(const char* value, std::uint64_t& id)
{
    if (!value) return false;
    const std::string text(value);
    if (text.rfind("entry-", 0) != 0 || text.size() == 6) return false;
    try {
        std::size_t consumed = 0;
        id = std::stoull(text.substr(6), &consumed);
        return consumed == text.size() - 6;
    } catch (...) {
        return false;
    }
}

bool parse_history_jump_direction(const char* value, History::JumpDirection& direction)
{
    if (!value) return false;
    const std::string text(value);
    if (text == "undo") { direction = History::JumpDirection::Undo; return true; }
    if (text == "redo") { direction = History::JumpDirection::Redo; return true; }
    return false;
}

json parse_history_context(const char* context_cstr)
{
    if (!context_cstr || !*context_cstr)
        throw std::runtime_error("history context is required");
    const json context = json::parse(context_cstr);
    if (!context.is_object() || !context.contains("selection") ||
        !context["selection"].is_object() ||
        !context.contains("activePlateId") ||
        !(context["activePlateId"].is_null() || context["activePlateId"].is_string()) ||
        !context.contains("gizmo") ||
        !(context["gizmo"].is_null() || context["gizmo"].is_object()) ||
        !context.contains("projectConfigOverlay") ||
        !context["projectConfigOverlay"].is_object())
        throw std::runtime_error("invalid history context");
    if (context.contains("filamentState") &&
        (!context["filamentState"].is_object() || context["filamentState"].value("version", 0) != 1))
        throw std::runtime_error("invalid history filament state");
    const auto& selection = context["selection"];
    if (!selection.contains("mode") || !selection["mode"].is_string() ||
        !selection.contains("objectIds") || !selection["objectIds"].is_array() ||
        !selection.contains("partIds") || !selection["partIds"].is_array() ||
        !selection.contains("instanceIds") || !selection["instanceIds"].is_array())
        throw std::runtime_error("invalid history selection");
    for (const char* key : {"objectIds", "partIds", "instanceIds"})
        for (const auto& id : selection[key])
            if (!id.is_number_integer() || id.get<std::int64_t>() < 0)
                throw std::runtime_error("invalid history selection id");
    if (context["gizmo"].is_object() &&
        (!context["gizmo"].contains("type") || !context["gizmo"]["type"].is_string()))
        throw std::runtime_error("invalid history gizmo");
    return context;
}

json default_history_context(const BridgeState& state,
                             const json& plate_session,
                             const json& filament_state)
{
    return json{
        {"selection", {{"mode", "object"}, {"objectIds", json::array()},
                        {"partIds", json::array()}, {"instanceIds", json::array()}}},
        {"activePlateId", state.current_plate_id.empty() ? json(nullptr) : json(state.current_plate_id)},
        {"gizmo", nullptr}, {"projectConfigOverlay", state.project_config_overlay},
        {"plateSession", plate_session},
        {"filamentState", filament_state},
    };
}

json canonical_history_context(const BridgeState& state,
                               json context,
                               const json& plate_session,
                               const json& filament_state)
{
    if (!context.is_object()) context = default_history_context(state, plate_session, filament_state);
    // The Worker is authoritative for plate identity, collection, membership,
    // and revisions. React contributes only the projected editing context.
    context["activePlateId"] = state.current_plate_id.empty()
        ? json(nullptr) : json(state.current_plate_id);
    context["plateSession"] = plate_session;
    context["projectConfigOverlay"] = state.project_config_overlay;
    // Filament presets, colours, routing, matrices, and per-project config
    // are not part of ModelState. Every authoritative history context must
    // therefore carry the current native filament state.
    context["filamentState"] = filament_state;
    return context;
}

void record_history_context(BridgeState& state,
                            const std::string& label,
                            const json& requested,
                            const json& plate_session,
                            const json& filament_state,
                            const History::ModelState& model_state)
{
    if (state.active_history_transaction) return;
    const json context = canonical_history_context(state, requested, plate_session, filament_state);
    if (state.history.entries().empty()) {
        const json baseline = default_history_context(state, plate_session, filament_state);
        const std::string encoded = baseline.dump();
        const History::Bytes context_bytes(encoded.begin(), encoded.end());
        state.history.commit("", History::Category::Project, model_state, context_bytes);
        state.history.mark_current_as_saved();
    }
    const std::string encoded = context.dump();
    const History::Bytes context_bytes(encoded.begin(), encoded.end());
    // Context-only records intentionally do not advance history_revision: the
    // model, filament rack, and slice inputs remain unchanged.
    state.history.commit(label, History::Category::Context, model_state, context_bytes);
}

void record_active_plate_context(BridgeState& state,
                                 const json& plate_session,
                                 const json& filament_state,
                                 const History::ModelState& model_state)
{
    json context = default_history_context(state, plate_session, filament_state);
    if (!state.history.entries().empty()) {
        try {
            const auto& current = state.history.current();
            context = json::parse(std::string(current.context.begin(), current.context.end()));
        } catch (...) { context = default_history_context(state, plate_session, filament_state); }
    }
    context["activePlateId"] = state.current_plate_id.empty()
        ? json(nullptr) : json(state.current_plate_id);
    record_history_context(state, "Active Plate", context, plate_session, filament_state, model_state);
}

json history_status_json(const BridgeState& state)
{
    const auto entries = state.history.entries();
    const std::size_t cursor = state.history.cursor();
    json undo = json::array();
    json redo = json::array();
    for (std::size_t i = cursor; i > 0; --i) {
        const auto& entry = entries[i];
        if (entry.category != History::Category::Project || entry.id == 0) continue;
        undo.push_back(json{{"id", history_entry_id(entry.id)}, {"label", entry.label},
                            {"category", entry.category == History::Category::Project ? "project" : "context"}});
    }
    for (std::size_t i = cursor + 1; i < entries.size(); ++i) {
        const auto& entry = entries[i];
        if (entry.category != History::Category::Project || entry.id == 0) continue;
        redo.push_back(json{{"id", history_entry_id(entry.id)}, {"label", entry.label},
                            {"category", entry.category == History::Category::Project ? "project" : "context"}});
    }
    const auto* undo_entry = state.history.undo_entry();
    const auto* redo_entry = state.history.redo_entry();
    const auto saved = state.history.saved_checkpoint();
    const auto resources = state.history.resource_diagnostics();
    return json{
        {"canUndo", state.history.can_undo()}, {"canRedo", state.history.can_redo()},
        {"undoLabel", undo_entry ? json(undo_entry->label) : json(nullptr)},
        {"redoLabel", redo_entry ? json(redo_entry->label) : json(nullptr)},
        {"undoEntries", std::move(undo)}, {"redoEntries", std::move(redo)},
        {"cursor", cursor},
        {"savedCheckpoint", saved == std::numeric_limits<std::size_t>::max() ? json(nullptr) : json(saved)},
        {"savedCheckpointEvicted", state.history.saved_checkpoint_evicted()},
        {"dirty", state.history.project_modified()},
        {"bytesUsed", state.history.bytes_used()}, {"byteBudget", state.history.byte_budget()},
        {"optionalBytesReleased", resources.optional_bytes_released},
        {"evictedEntryCount", resources.evicted_entry_count},
        {"lastEvictedEntryId", resources.last_evicted_entry_id == 0
            ? json(nullptr) : json(history_entry_id(resources.last_evicted_entry_id))},
        {"oldestRetainedEntryId", state.history.entries().empty()
            ? json(nullptr) : json(history_entry_id(resources.oldest_retained_entry_id))},
        {"oversizedEntryRetained", resources.oversized_entry_retained},
        {"disabled", state.history_disabled},
        {"activeTransactionId", state.active_history_transaction ? json(state.active_history_transaction->id) : json(nullptr)},
        {"revision", state.history_revision},
    };
}

json restore_diagnostics_json(const BridgeState& state)
{
    return json{
        {"minimalMutableRestoreCount", state.history_minimal_mutable_restore_count},
        {"fullPresetBundleCopyCount", state.full_preset_bundle_copy_count},
    };
}

} // namespace Slic3r::Neo::Bridge::HistoryMetadata
