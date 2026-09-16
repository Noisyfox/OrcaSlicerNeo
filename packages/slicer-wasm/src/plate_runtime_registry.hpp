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
    };

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

    // Reconcile runtime ownership with the current ordered plate ids.  An
    // existing id retains the same Print and result pointers; a new id gets a
    // fresh pair and an absent id is released immediately.
    void reconcile(const std::vector<std::string>& plate_ids);
    // History restores replace the persistent plate/session input after the
    // target frame has been validated.  The bridge supplies the IDs whose
    // persistent slice inputs changed; numeric historical revisions are not a
    // runtime eligibility signal.  Unaffected entries retain their native
    // allocations and presentation, changed entries lose presentation, new
    // IDs get a fresh entry, and deleted IDs are released.
    void reconcile_history(const std::vector<std::string>& plate_ids,
                          const std::set<std::string>& affected_plate_ids);
    void clear() noexcept;

    // Lifecycle transitions intentionally touch metadata only.  In
    // particular, beginning a slice must preserve both native core pointers.
    static void begin_slice(Entry& entry) noexcept;
    static void mark_process_completed(Entry& entry,
                                       std::uint64_t completed_revision,
                                       std::uint64_t current_revision,
                                       std::uint64_t slice_task_id) noexcept;
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

    std::size_t size() const noexcept { return entries_.size(); }
    bool empty() const noexcept { return entries_.empty(); }

private:
    std::unordered_map<std::string, Entry> entries_;
};

} // namespace Slic3r::Neo::Bridge
