#pragma once

#include "ProjectHistory.hpp"

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
};

// The three Worker-owned roots restored by one history operation. ModelState::
// serialized is the model-level manifest; mutable object archives are retained
// independently by stable ObjectID.
struct TimestampedRoots {
    ModelState model;
    SessionHistoryRoot session;
    Bytes project_config_overlay;
};

struct TimestampedEntryInfo {
    std::uint64_t id { 0 };
    std::string label;
    LogicalTimestamp before_timestamp { 0 };
    LogicalTimestamp after_timestamp { 0 };
};

struct TimestampedRestore {
    LogicalTimestamp timestamp { 0 };
    TimestampedRoots roots;
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
    std::size_t optional_bytes_released { 0 };
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
    bool commit_operation();
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
    std::size_t release_optional_data();
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
