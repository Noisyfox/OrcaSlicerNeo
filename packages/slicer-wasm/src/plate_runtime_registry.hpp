// ----------------------------------------------------------------
// Runtime ownership for the FFF per-plate Print domain.
//
// Plate definitions are session state.  This registry deliberately keeps the
// native Print and G-code result outside the serialized plate definition and
// reconciles ownership by the session-stable plate id.
// ----------------------------------------------------------------
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <map>
#include <unordered_map>
#include <vector>

#include "libslic3r/GCode/GCodeProcessor.hpp"
#include "libslic3r/Print.hpp"

namespace Slic3r::Neo::Bridge {

class PlateRuntimeRegistry {
public:
    enum class PresentationLifecycle {
        Invalid,
        Slicing,
        Valid,
    };

    struct Entry {
        std::string plate_id;
        std::uint64_t incarnation_id = 0;
        std::unique_ptr<Print> print;
        std::unique_ptr<GCodeProcessorResult> gcode_result;
        // Presentation state is deliberately separate from the retained
        // native Print/G-code objects.  A new slice hides the old React
        // presentation without discarding the native core cache.
        PresentationLifecycle presentation = PresentationLifecycle::Invalid;
        // This is the revision completed by the most recent successful
        // process.  The current revision remains authoritative in
        // BridgeState::plate_input_revisions and is never duplicated here.
        std::optional<std::uint64_t> completed_input_revision;
        // Runtime-only identity of the successful Slice which produced the
        // retained core result. It is carried to React as a decimal string so
        // delayed projection payloads cannot impersonate a newer Slice for
        // the same unchanged input stamp.
        std::optional<std::uint64_t> completed_slice_task_id;
        bool native_core_materialized = false;

    private:
        friend class PlateRuntimeRegistry;
        std::size_t active_job_leases = 0;
        std::optional<std::uint64_t> active_slice_task_id;
        std::optional<std::uint64_t> active_input_revision;
        bool retired = false;
        bool cancel_requested = false;
    };

    class JobLease {
    public:
        JobLease() = default;
        JobLease(const JobLease&) = delete;
        JobLease& operator=(const JobLease&) = delete;
        JobLease(JobLease&& other) noexcept;
        JobLease& operator=(JobLease&& other) noexcept;
        ~JobLease();

        Entry& entry() const noexcept { return *entry_; }
        std::uint64_t slice_task_id() const noexcept { return slice_task_id_; }
        std::uint64_t input_revision() const noexcept { return input_revision_; }
        explicit operator bool() const noexcept { return entry_ != nullptr; }

    private:
        friend class PlateRuntimeRegistry;
        JobLease(PlateRuntimeRegistry& owner, std::shared_ptr<Entry> entry,
                 std::uint64_t slice_task_id, std::uint64_t input_revision) noexcept;
        void release() noexcept;

        PlateRuntimeRegistry* owner_ = nullptr;
        std::shared_ptr<Entry> entry_;
        std::uint64_t slice_task_id_ = 0;
        std::uint64_t input_revision_ = 0;
        bool process_completed_ = false;
    };

    struct Retirement {
        std::string plate_id;
        std::uint64_t incarnation_id = 0;
    };
    using Retirements = std::vector<Retirement>;

    // Runtime-only lifecycle metadata used to make plate-structure rollback
    // atomic without copying or serializing the native Print/result objects.
    // The pointer identities ensure a restored metadata record is never
    // applied to a freshly-created replacement entry.
    struct LifecycleSnapshot {
        const Print* print = nullptr;
        const GCodeProcessorResult* gcode_result = nullptr;
        PresentationLifecycle presentation = PresentationLifecycle::Invalid;
        std::optional<std::uint64_t> completed_input_revision;
        std::optional<std::uint64_t> completed_slice_task_id;
        bool native_core_materialized = false;
    };
    using LifecycleSnapshots = std::map<std::string, LifecycleSnapshot>;

#ifdef NEO_REAL_PROJECT_PROFILE
    struct ProfileEntry {
        std::string plate_id;
        const Print* print = nullptr;
        const GCodeProcessorResult* gcode_result = nullptr;
        bool native_core_materialized = false;
    };

    // Dedicated-profile builds may inspect immutable entry pointers while the
    // stateful Worker is idle. Normal production builds contain neither this
    // API nor the profiling ABI which consumes it.
    std::vector<ProfileEntry> profile_entries() const;
#endif

    // Reconcile runtime ownership with the current ordered plate ids.  An
    // existing id retains the same Print and result pointers; a new id gets a
    // fresh pair. An absent id is released immediately unless a job lease owns
    // it, in which case the exact incarnation becomes a retired tombstone until
    // that lease reaches its terminal state.
    Retirements reconcile(const std::vector<std::string>& plate_ids);
    // History restores replace the persistent plate/session input after the
    // target frame has been validated.  The bridge supplies the IDs whose
    // persistent slice inputs changed; numeric historical revisions are not a
    // runtime eligibility signal.  Unaffected entries retain their native
    // allocations and presentation, changed entries lose presentation, new
    // IDs get a fresh entry, and deleted IDs are released.
    Retirements reconcile_history(const std::vector<std::string>& plate_ids,
                                  const std::set<std::string>& affected_plate_ids);
    void clear() noexcept;

    // A running slice owns one explicit lease on an immutable registry-entry
    // incarnation. The lease, rather than a raw map pointer, remains valid if
    // Delete Plate removes the live entry. A plate has at most one active job.
    JobLease begin_slice(std::string_view plate_id,
                         std::uint64_t slice_task_id,
                         std::uint64_t input_revision);
    bool mark_process_completed(JobLease& lease,
                                std::uint64_t completed_revision,
                                std::uint64_t current_revision) noexcept;
    void mark_process_failed(JobLease& lease) noexcept;
    bool can_publish_completed_job(const JobLease& lease,
                                   std::uint64_t current_revision) const noexcept;
    bool has_active_job(std::string_view plate_id) const noexcept;
    // Request cancellation of the exact live or retired entry held by a job
    // lease.  This is non-blocking and never waits for Print::process().
    bool request_job_cancellation(const JobLease& lease) noexcept;
    // Cancellation is deliberately a separate, non-blocking operation after
    // the persistent deletion commits. Only retired leased incarnations are
    // addressable; live entries and restored same-id entries cannot be hit.
    bool request_retired_job_cancellation(std::uint64_t incarnation_id) noexcept;
    bool cancellation_requested(const JobLease& lease) const noexcept;
    static void mark_presentation_valid(Entry& entry,
                                        std::uint64_t current_revision) noexcept;
    static void mark_presentation_invalid(Entry& entry) noexcept;
    void invalidate_presentations(const std::set<std::string>& plate_ids) noexcept;
    LifecycleSnapshots capture_lifecycle() const;
    void restore_lifecycle(const LifecycleSnapshots& snapshots) noexcept;
    static bool can_materialize_result(const Entry& entry,
                                       std::uint64_t current_revision) noexcept;
    static bool is_publishable(const Entry& entry,
                               std::uint64_t current_revision) noexcept;

    Entry* find(std::string_view plate_id) noexcept;
    const Entry* find(std::string_view plate_id) const noexcept;

    std::size_t size() const noexcept;
    bool empty() const noexcept;
    std::size_t retired_size() const noexcept;

private:
    void release_job(JobLease& lease) noexcept;

    mutable std::mutex mutex_;
    std::unordered_map<std::string, std::shared_ptr<Entry>> entries_;
    std::unordered_map<std::uint64_t, std::shared_ptr<Entry>> retired_entries_;
    std::uint64_t next_incarnation_id_ = 1;
};

} // namespace Slic3r::Neo::Bridge
