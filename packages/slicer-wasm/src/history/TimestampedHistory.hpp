#pragma once

#include "ModelState.hpp"

#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace Slic3r::Neo::History {

using LogicalTimestamp = std::uint64_t;

struct SessionHistoryRoot {
    Bytes plate_session;
    Bytes history_context;
    // Stable runtime plate identities used only to derive renderer deltas.
    // The serialized plate_session remains the authoritative history root.
    std::vector<std::string> scene_plate_ids;
};

// Non-authoritative renderer acceleration retained beside one timestamp edge.
// The object-version snapshots remain the sole restore authority. IDs are
// stable native/session identities; positional indices never enter history.
struct SceneDelta {
    std::vector<ObjectID> object_ids;
    std::vector<ObjectID> volume_ids;
    std::vector<ObjectID> instance_ids;
    std::vector<std::string> plate_ids;
    // Populated only on a completed restore so the renderer can reorder
    // retained objects without projecting the complete model again.
    std::vector<ObjectID> object_order;
};

// The three Worker-owned roots restored by one history operation. ModelState::
// serialized is the model-level manifest; mutable object archives are retained
// independently by stable ObjectID.
struct TimestampedRoots {
    ModelState model;
    SessionHistoryRoot session;
    // Exact native Project configuration root. It contains the serialized
    // local project config map, never a Neo overlay store.
    Bytes project_config;
};

struct TimestampedEntryInfo {
    std::uint64_t id { 0 };
    std::string label;
    LogicalTimestamp before_timestamp { 0 };
    LogicalTimestamp after_timestamp { 0 };
    SceneDelta scene_delta;
};

struct TimestampedRestore {
    LogicalTimestamp timestamp { 0 };
    TimestampedRoots roots;
    SceneDelta scene_delta;
};

struct TimestampedObjectVersionInterval {
    ObjectID id { 0 };
    std::uint64_t object_timestamp { 0 };
    LogicalTimestamp begin { 0 };
    LogicalTimestamp end { 0 };
    std::shared_ptr<const MutableObject> archive;
};

struct TimestampedResourceDiagnostics {
    std::size_t bytes_used { 0 };
    std::size_t byte_budget { 0 };
    std::size_t evicted_timestamp_count { 0 };
    LogicalTimestamp last_evicted_timestamp { 0 };
    bool oversized_nearest_history_retained { false };
};

class TimestampedHistory {
public:
    static constexpr std::size_t kDefaultByteBudget = std::size_t(256) * 1024 * 1024;
    static constexpr LogicalTimestamp kOpenEnded = std::numeric_limits<LogicalTimestamp>::max();

    explicit TimestampedHistory(std::size_t byte_budget = kDefaultByteBudget);
    ~TimestampedHistory();
    TimestampedHistory(TimestampedHistory&&) noexcept;
    TimestampedHistory& operator=(TimestampedHistory&&) noexcept;
    TimestampedHistory(const TimestampedHistory&) = delete;
    TimestampedHistory& operator=(const TimestampedHistory&) = delete;

    void clear();

    // The outer operation captures its predecessor before the first write.
    // Nested calls join that operation. Only the outer commit creates one
    // named before/after timestamp pair; its resulting topmost state remains
    // uncaptured until a later operation or the first Undo needs it.
    bool begin_operation(std::string label, const TimestampedRoots& predecessor);
    bool commit_operation(const TimestampedRoots& successor, SceneDelta* committed_delta = nullptr);
    bool abort_operation(TimestampedRestore* predecessor = nullptr);
    bool operation_active() const;

    bool undo(const TimestampedRoots& live_current, TimestampedRestore& result);
    bool redo(TimestampedRestore& result);
    bool restore(LogicalTimestamp target, const TimestampedRoots* live_current, TimestampedRestore& result);
    bool restore_before(std::uint64_t entry_id, const TimestampedRoots* live_current,
                        TimestampedRestore& result);
    bool restore_after(std::uint64_t entry_id, const TimestampedRoots* live_current,
                       TimestampedRestore& result);

    bool can_undo() const;
    bool can_redo() const;
    LogicalTimestamp current_timestamp() const;
    const std::vector<TimestampedEntryInfo>& entries() const;

    void mark_current_as_saved();
    bool project_modified() const;
    bool saved_checkpoint_evicted() const;
    std::optional<LogicalTimestamp> saved_timestamp() const;

    std::size_t byte_budget() const;
    void set_byte_budget(std::size_t byte_budget);
    std::size_t bytes_used() const;
    TimestampedResourceDiagnostics resource_diagnostics() const;

    std::size_t snapshot_count() const;
    std::size_t object_archive_count() const;
    std::shared_ptr<const MutableObject> object_archive(LogicalTimestamp timestamp, ObjectID id) const;
    const std::vector<TimestampedObjectVersionInterval>& object_intervals() const;

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace Slic3r::Neo::History
