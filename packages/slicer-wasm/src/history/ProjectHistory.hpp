#pragma once

// A deliberately headless, Worker-owned history store.  This file must stay
// independent of the native GUI and of the bridge ABI.  The bridge will add a
// serialization adapter in a later step; this core only sees bytes.

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace Slic3r::Neo::History {

using Bytes = std::vector<std::uint8_t>;
using ObjectID = std::uint64_t;

struct MutableObject {
    ObjectID id { 0 };
    // A non-zero timestamp is an optional fast path for callers that already
    // know an object's content did not change.  The bytes remain authoritative.
    std::uint64_t timestamp { 0 };
    Bytes data;
    // ModelVolume's native undo archive omits ObjectBase. Retain the ordered
    // IDs separately so restore can reapply them after materialization.
    std::vector<ObjectID> volume_ids;
};

// Immutable mesh data is shared by identity and can be discarded from the
// resident history when a budget is reached.  deferred is a reconstructable
// representation supplied by the model adapter (typically a compressed mesh).
struct ImmutableMesh {
    std::string key;
    std::shared_ptr<const Bytes> resident;
    std::shared_ptr<const Bytes> deferred;
    bool optional { false };
};

// A model adapter may use serialized for the complete model, or use the
// ObjectID-keyed collections below to retain mutable objects independently.
// ProjectHistory does not interpret either representation.
struct ModelState {
    Bytes serialized;
    std::vector<MutableObject> mutable_objects;
    std::vector<ImmutableMesh> immutable_meshes;
};

enum class Category : std::uint8_t { Project, Context };

// A menu jump is directional: Undo selects an operation and restores the
// project frame immediately before it; Redo selects an operation and restores
// that operation's after-state.  The direction is part of the Worker/core
// contract so the renderer never has to derive a fragile adjacent entry id.
enum class JumpDirection : std::uint8_t { Undo, Redo };

struct EntryInfo {
    std::uint64_t id { 0 };
    std::string label;
    Category category { Category::Project };
};

struct RestoreState {
    ModelState model;
    Bytes context;
    EntryInfo entry;
    // Bridge-owned, immutable fast-path state.  ProjectHistory deliberately
    // treats it as opaque: its explicit byte charge participates in the same
    // eviction policy as the authoritative archive state, and a missing frame
    // always falls back to the archive restore path.
    struct DirectFrame {
        enum class Kind : std::uint8_t { Filament, PrimeTower };
        Kind kind { Kind::Filament };
        std::shared_ptr<const void> payload;
        std::size_t bytes { 0 };
    };
    std::optional<DirectFrame> direct_frame;
};

// A prepared restore is deliberately separate from the history cursor.  The
// model adapter may fail while parsing/validating the retained bytes; in that
// case the caller must be able to discard this plan without changing the
// active model or navigation state.
struct RestorePlan {
    RestoreState state;
    std::size_t from_cursor { 0 };
    std::size_t target_cursor { 0 };
    // A direct frame can optimize the one adjacent transition it describes.
    // It never makes the target model/context optional for other navigation.
    bool direct_frame_transition { false };
};

// Half-open version interval used by the object history implementation.  It
// is public for diagnostics/tests, but callers do not need to manage it.
struct ObjectVersionInterval {
    ObjectID id { 0 };
    std::uint64_t begin { 0 };
    std::uint64_t end { 0 };
};

// Resource effects are deliberately data-only.  The bridge exposes these
// counters through HistoryStatus for diagnostics; no history operation emits
// a user-facing notification when the budget releases or evicts data.
struct ResourceDiagnostics {
    std::size_t bytes_used { 0 };
    std::size_t byte_budget { 0 };
    std::size_t optional_bytes_released { 0 };
    std::size_t evicted_entry_count { 0 };
    std::uint64_t last_evicted_entry_id { 0 };
    std::uint64_t oldest_retained_entry_id { 0 };
    bool oversized_entry_retained { false };
};

// ProjectHistory reports a deterministic retained-allocation estimate rather
// than the host allocator's live heap usage.  Payload/vector capacities are
// observed from the retained containers; metadata and shared-control-block
// costs use canonical fixed upper-bound slots so native and wasm64 runs use
// the same budget scale without depending on ABI or allocator telemetry.
struct ResourceAccounting {
    static constexpr std::size_t kImplAllocationBytes = 256;
    static constexpr std::size_t kStoredEntryBytes = 512;
    static constexpr std::size_t kMutableObjectSlotBytes = 64;
    static constexpr std::size_t kImmutableMeshSlotBytes = 128;
    static constexpr std::size_t kObjectIntervalSlotBytes = 32;
    static constexpr std::size_t kSharedBlobAllocationBytes = 64;
    static constexpr std::size_t kDirectFrameSlotBytes = 32;
    static constexpr std::size_t kStringTerminatorBytes = 1;
    // Canonical short-string threshold, independent of the implementation's
    // actual SSO capacity. Values at or below this size are covered by the
    // fixed StoredEntry/StoredMesh slot; longer strings charge their observed
    // retained capacity plus one terminator byte.
    static constexpr std::size_t kInlineStringCapacity = 15;
};

class ProjectHistory {
public:
    static constexpr std::size_t kDefaultByteBudget = std::size_t(256) * 1024 * 1024;

    explicit ProjectHistory(std::size_t byte_budget = kDefaultByteBudget);
    ~ProjectHistory();
    ProjectHistory(ProjectHistory&&) noexcept;
    ProjectHistory& operator=(ProjectHistory&&) noexcept;
    ProjectHistory(const ProjectHistory&) = delete;
    ProjectHistory& operator=(const ProjectHistory&) = delete;

    void clear();

    // The first commit establishes the baseline from which Undo starts.  Each
    // subsequent commit stores the new state.  A commit with identical model
    // and context bytes is a no-op and does not consume a history entry.
    bool commit(std::string label, Category category, const ModelState& model, const Bytes& context,
                std::optional<RestoreState::DirectFrame> direct_frame = std::nullopt,
                std::optional<RestoreState::DirectFrame> predecessor_direct_frame = std::nullopt);
    // Publish the initial baseline and its first project mutation as one
    // history operation.  The bridge uses this when a freshly initialized
    // session receives its first atomic command; a failed command must not
    // leave a baseline behind without the corresponding mutation.
    bool commit_with_baseline(std::string label, Category category,
                              const ModelState& baseline_model, const Bytes& baseline_context,
                              const ModelState& model, const Bytes& context,
                              std::optional<RestoreState::DirectFrame> baseline_direct_frame = std::nullopt,
                              std::optional<RestoreState::DirectFrame> direct_frame = std::nullopt);
    // Append a sidecar-only frame while retaining the current model blobs by
    // shared identity. This is for narrow coordinate/configuration edits that
    // must not serialize or copy the complete model state.
    bool commit_reusing_current_model(std::string label, Category category, const Bytes& context,
                                      std::optional<RestoreState::DirectFrame> direct_frame = std::nullopt,
                                      std::optional<RestoreState::DirectFrame> predecessor_direct_frame = std::nullopt);
    bool record(std::string label, Category category, const ModelState& model, const Bytes& context)
    { return commit(std::move(label), category, model, context); }

    bool undo(RestoreState& result);
    bool redo(RestoreState& result);
    // Move directly to a retained entry.  The baseline (id 0) is a valid
    // target for restore, while unknown/evicted ids are rejected.
    bool jump(std::uint64_t entry_id, JumpDirection direction, RestoreState& result);
    bool jump(std::uint64_t entry_id, RestoreState& result);

    // Two-phase navigation used by the bridge.  Preparation never advances
    // m_cursor.  commit_restore only succeeds for a plan prepared against the
    // current cursor and a still-retained target.
    bool prepare_undo(RestorePlan& result) const;
    bool prepare_redo(RestorePlan& result) const;
    bool prepare_jump(std::uint64_t entry_id, JumpDirection direction, RestorePlan& result) const;
    bool prepare_jump(std::uint64_t entry_id, RestorePlan& result) const;
    bool can_commit_restore(const RestorePlan& plan) const;
    bool commit_restore(const RestorePlan& plan);

    // Standard navigation deliberately skips internal context records.  The
    // records remain retained (and therefore still truncate redo when a new
    // context is committed), but one-step Undo/Redo only lands on project
    // modifying frames.
    bool can_undo() const;
    bool can_redo() const;
    std::size_t cursor() const { return m_cursor; }
    std::size_t entry_count() const;
    const EntryInfo* undo_entry() const;
    const EntryInfo* redo_entry() const;
    std::vector<EntryInfo> entries() const;
    const RestoreState& current() const;

    void mark_current_as_saved();
    bool project_modified() const;
    bool saved_checkpoint_evicted() const { return m_saved_checkpoint_evicted; }
    std::size_t saved_checkpoint() const;

    std::size_t byte_budget() const { return m_byte_budget; }
    void set_byte_budget(std::size_t byte_budget);
    std::size_t bytes_used() const;
    // Public for deterministic diagnostics and for the later resource gate.
    void release_least_recently_used();
    std::size_t release_optional_data();
    ResourceDiagnostics resource_diagnostics() const;

#ifdef NEO_PROJECT_HISTORY_TEST
    // Test-only fault injection exercises the transaction guard after a
    // sidecar commit has already truncated a redo branch.
    void fail_next_reusing_commit_for_test() noexcept { m_fail_next_reusing_commit_for_test = true; }
#endif

    const std::vector<ObjectVersionInterval>& object_intervals() const { return m_object_intervals; }

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
    std::size_t m_byte_budget;
    std::size_t m_cursor { 0 };
    std::size_t m_saved_checkpoint { static_cast<std::size_t>(-1) };
    bool m_saved_checkpoint_evicted { false };
    std::size_t m_optional_bytes_released { 0 };
    std::size_t m_evicted_entry_count { 0 };
    std::uint64_t m_last_evicted_entry_id { 0 };
    std::vector<ObjectVersionInterval> m_object_intervals;
#ifdef NEO_PROJECT_HISTORY_TEST
    bool m_fail_next_reusing_commit_for_test { false };
#endif

    friend struct Impl;

    void rebuild_intervals();
};

} // namespace Slic3r::Neo::History
