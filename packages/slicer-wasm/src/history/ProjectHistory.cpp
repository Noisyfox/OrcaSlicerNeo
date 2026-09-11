#include "ProjectHistory.hpp"

#include <algorithm>
#include <limits>
#include <map>
#include <set>
#include <stdexcept>
#include <utility>

namespace Slic3r::Neo::History {

namespace {
using Blob = std::shared_ptr<const Bytes>;

void add_bytes(std::size_t& total, std::size_t amount)
{
    const auto max = std::numeric_limits<std::size_t>::max();
    total = amount > max - total ? max : total + amount;
}

void add_product(std::size_t& total, std::size_t count, std::size_t unit)
{
    const auto max = std::numeric_limits<std::size_t>::max();
    add_bytes(total, count > max / unit ? max : count * unit);
}

void add_string_storage(std::size_t& total, const std::string& value)
{
    // The size threshold is canonical; implementations expose different SSO
    // capacities (including on wasm), so capacity() must not decide whether a
    // short value owns an external allocation. For a canonical long value,
    // capacity() is the retained allocation observable to the container and a
    // fixed terminator unit completes the estimate.
    if (value.size() > ResourceAccounting::kInlineStringCapacity) {
        const auto max = std::numeric_limits<std::size_t>::max();
        add_bytes(total, value.capacity() == max ? max : value.capacity() + ResourceAccounting::kStringTerminatorBytes);
    }
}

Blob make_blob(const Bytes& bytes)
{
    return std::make_shared<const Bytes>(bytes);
}

bool bytes_equal(const Blob& lhs, const Bytes& rhs)
{
    return lhs && *lhs == rhs;
}

struct StoredMutable {
    ObjectID id { 0 };
    std::uint64_t timestamp { 0 };
    Blob data;
};

struct StoredMesh {
    std::string key;
    Blob resident;
    Blob deferred;
    bool optional { false };
};

struct StoredState {
    Blob serialized;
    std::vector<StoredMutable> mutable_objects;
    std::vector<StoredMesh> immutable_meshes;
    Bytes context;
    std::optional<RestoreState::DirectFrame> direct_frame;
};

struct StoredEntry {
    EntryInfo info;
    StoredState state;
};

static_assert(ResourceAccounting::kMutableObjectSlotBytes >= sizeof(StoredMutable),
              "mutable-object accounting slot must cover StoredMutable");
static_assert(ResourceAccounting::kImmutableMeshSlotBytes >= sizeof(StoredMesh),
              "immutable-mesh accounting slot must cover StoredMesh");
static_assert(ResourceAccounting::kStoredEntryBytes >= sizeof(StoredEntry),
              "entry accounting slot must cover StoredEntry");
static_assert(ResourceAccounting::kObjectIntervalSlotBytes >= sizeof(ObjectVersionInterval),
              "interval accounting slot must cover ObjectVersionInterval");

constexpr std::size_t kNoProject = std::numeric_limits<std::size_t>::max();

std::size_t project_at_or_before(const std::vector<StoredEntry>& states, std::size_t start)
{
    if (states.empty() || start >= states.size()) return kNoProject;
    std::size_t index = start;
    while (true) {
        if (states[index].info.category == Category::Project) return index;
        if (index == 0) break;
        --index;
    }
    return kNoProject;
}

std::size_t previous_project(const std::vector<StoredEntry>& states, std::size_t start)
{
    while (start > 0) {
        --start;
        if (states[start].info.category == Category::Project) return start;
    }
    return kNoProject;
}

std::size_t next_project(const std::vector<StoredEntry>& states, std::size_t start)
{
    for (std::size_t index = start + 1; index < states.size(); ++index)
        if (states[index].info.category == Category::Project && states[index].info.id != 0)
            return index;
    return kNoProject;
}

} // namespace

struct ProjectHistory::Impl {
    std::vector<StoredEntry> states; // state 0 is the baseline; entries are states 1..n
    std::uint64_t next_entry_id { 1 };

    static bool equal(const StoredState& lhs, const ModelState& model, const Bytes& context)
    {
        if (lhs.context != context || !bytes_equal(lhs.serialized, model.serialized) ||
            lhs.mutable_objects.size() != model.mutable_objects.size() ||
            lhs.immutable_meshes.size() != model.immutable_meshes.size())
            return false;
        for (std::size_t i = 0; i < lhs.mutable_objects.size(); ++i) {
            const auto& a = lhs.mutable_objects[i];
            const auto& b = model.mutable_objects[i];
            if (a.id != b.id || a.timestamp != b.timestamp || !bytes_equal(a.data, b.data))
                return false;
        }
        for (std::size_t i = 0; i < lhs.immutable_meshes.size(); ++i) {
            const auto& a = lhs.immutable_meshes[i];
            const auto& b = model.immutable_meshes[i];
            if (a.key != b.key || a.optional != b.optional ||
                (a.resident && b.resident ? *a.resident != *b.resident : bool(a.resident) != bool(b.resident)) ||
                (a.deferred && b.deferred ? *a.deferred != *b.deferred : bool(a.deferred) != bool(b.deferred)))
                return false;
        }
        return true;
    }

    static StoredState store(const ModelState& model, const Bytes& context,
                             const StoredState* previous,
                             std::optional<RestoreState::DirectFrame> direct_frame)
    {
        StoredState state;
        state.serialized = previous && bytes_equal(previous->serialized, model.serialized)
            ? previous->serialized : make_blob(model.serialized);
        state.context = context;
        if (direct_frame && (!direct_frame->payload || direct_frame->bytes == 0))
            direct_frame.reset();
        state.direct_frame = std::move(direct_frame);

        state.mutable_objects.reserve(model.mutable_objects.size());
        for (const auto& object : model.mutable_objects) {
            Blob data;
            if (previous) {
                auto it = std::find_if(previous->mutable_objects.begin(), previous->mutable_objects.end(),
                    [&object](const StoredMutable& old) { return old.id == object.id && bytes_equal(old.data, object.data); });
                if (it != previous->mutable_objects.end()) data = it->data;
            }
            if (!data) data = make_blob(object.data);
            state.mutable_objects.push_back({ object.id, object.timestamp, std::move(data) });
        }

        state.immutable_meshes.reserve(model.immutable_meshes.size());
        for (const auto& mesh : model.immutable_meshes) {
            StoredMesh stored;
            stored.key = mesh.key;
            stored.resident = mesh.resident;
            stored.deferred = mesh.deferred;
            stored.optional = mesh.optional;
            // A key identifies immutable content across snapshots.  Reuse a
            // prior resident/deferred blob when the adapter supplied equal
            // content but not the same shared_ptr.
            if (previous) {
                auto it = std::find_if(previous->immutable_meshes.begin(), previous->immutable_meshes.end(),
                    [&mesh](const StoredMesh& old) {
                        return old.key == mesh.key &&
                            ((!mesh.resident && !old.resident) || (mesh.resident && old.resident && *mesh.resident == *old.resident)) &&
                            ((!mesh.deferred && !old.deferred) || (mesh.deferred && old.deferred && *mesh.deferred == *old.deferred));
                    });
                if (it != previous->immutable_meshes.end()) {
                    stored.resident = it->resident;
                    stored.deferred = it->deferred;
                }
            }
            state.immutable_meshes.push_back(std::move(stored));
        }
        return state;
    }

    static ModelState restore_model(const StoredState& state)
    {
        ModelState model;
        if (state.serialized) model.serialized = *state.serialized;
        model.mutable_objects.reserve(state.mutable_objects.size());
        for (const auto& object : state.mutable_objects)
            model.mutable_objects.push_back({ object.id, object.timestamp, object.data ? *object.data : Bytes{} });
        model.immutable_meshes.reserve(state.immutable_meshes.size());
        for (const auto& mesh : state.immutable_meshes)
            model.immutable_meshes.push_back({ mesh.key, mesh.resident, mesh.deferred, mesh.optional });
        return model;
    }
};

ProjectHistory::ProjectHistory(std::size_t byte_budget)
    : m_impl(std::make_unique<Impl>()), m_byte_budget(byte_budget) {}

ProjectHistory::~ProjectHistory() = default;
ProjectHistory::ProjectHistory(ProjectHistory&&) noexcept = default;
ProjectHistory& ProjectHistory::operator=(ProjectHistory&&) noexcept = default;

void ProjectHistory::clear()
{
    m_impl->states.clear();
    m_cursor = 0;
    m_saved_checkpoint = static_cast<std::size_t>(-1);
    m_saved_checkpoint_evicted = false;
    m_optional_bytes_released = 0;
    m_evicted_entry_count = 0;
    m_last_evicted_entry_id = 0;
    m_object_intervals.clear();
}

bool ProjectHistory::commit(std::string label, Category category, const ModelState& model, const Bytes& context,
                            std::optional<RestoreState::DirectFrame> direct_frame,
                            std::optional<RestoreState::DirectFrame> predecessor_direct_frame)
{
    if (m_impl->states.empty()) {
        m_impl->states.push_back({ { 0, {}, Category::Project },
                                   Impl::store(model, context, nullptr, std::move(direct_frame)) });
        m_cursor = 0;
        rebuild_intervals();
        return true;
    }

    if (Impl::equal(m_impl->states[m_cursor].state, model, context)) return false;

    // Keep a cheap shared-payload copy until the operation has completed. The
    // retained blobs are immutable/shared, so this protects the branch,
    // cursor, saved checkpoint, and resource counters if interval rebuilding
    // or budget accounting throws after the branch has been changed.
    ProjectHistory backup(m_byte_budget);
    backup.m_impl->states = m_impl->states;
    backup.m_impl->next_entry_id = m_impl->next_entry_id;
    backup.m_cursor = m_cursor;
    backup.m_saved_checkpoint = m_saved_checkpoint;
    backup.m_saved_checkpoint_evicted = m_saved_checkpoint_evicted;
    backup.m_optional_bytes_released = m_optional_bytes_released;
    backup.m_evicted_entry_count = m_evicted_entry_count;
    backup.m_last_evicted_entry_id = m_last_evicted_entry_id;
    backup.m_object_intervals = m_object_intervals;

    try {
        // A fast frame describes the currently retained predecessor.  Attach
        // it only as part of the same transactional branch append so a failed
        // commit cannot leave a newly charged side payload behind.
        // A narrow edit can follow a different narrow edit.  Keep the
        // predecessor frame supplied by the caller even when the current
        // checkpoint has another direct-frame kind (for example a Prime Tower
        // move after a filament mutation).  The serialized context remains
        // the complete logical predecessor; retaining the unrelated frame
        // would route Undo through the wrong restore validator.
        if (predecessor_direct_frame && predecessor_direct_frame->payload && predecessor_direct_frame->bytes != 0)
            m_impl->states[m_cursor].state.direct_frame = std::move(predecessor_direct_frame);
        // Build the complete retained state before touching the current branch.
        // Serialization/allocation failures must not discard redo entries or move
        // the cursor; the bridge relies on this when a published mutation's
        // history commit throws.
        StoredState prepared = Impl::store(model, context, &m_impl->states[m_cursor].state,
                                           std::move(direct_frame));
        m_impl->states.reserve(m_impl->states.size() + 1);

        // A new branch invalidates all redo IDs and any saved checkpoint that was
        // only reachable through the discarded branch.
        if (m_cursor + 1 < m_impl->states.size()) {
            if (m_saved_checkpoint != static_cast<std::size_t>(-1) && m_saved_checkpoint > m_cursor)
                m_saved_checkpoint_evicted = true;
            m_impl->states.erase(m_impl->states.begin() + static_cast<std::ptrdiff_t>(m_cursor + 1), m_impl->states.end());
        }

        EntryInfo info { m_impl->next_entry_id++, std::move(label), category };
        m_impl->states.push_back({ std::move(info), std::move(prepared) });
        ++m_cursor;
        rebuild_intervals();
        release_least_recently_used();
        return true;
    } catch (...) {
        m_impl->states = std::move(backup.m_impl->states);
        m_impl->next_entry_id = backup.m_impl->next_entry_id;
        m_cursor = backup.m_cursor;
        m_saved_checkpoint = backup.m_saved_checkpoint;
        m_saved_checkpoint_evicted = backup.m_saved_checkpoint_evicted;
        m_optional_bytes_released = backup.m_optional_bytes_released;
        m_evicted_entry_count = backup.m_evicted_entry_count;
        m_last_evicted_entry_id = backup.m_last_evicted_entry_id;
        m_object_intervals = std::move(backup.m_object_intervals);
        throw;
    }
}

bool ProjectHistory::commit_with_baseline(std::string label, Category category,
                                          const ModelState& baseline_model, const Bytes& baseline_context,
                                          const ModelState& model, const Bytes& context,
                                          std::optional<RestoreState::DirectFrame> baseline_direct_frame,
                                          std::optional<RestoreState::DirectFrame> direct_frame)
{
    if (!m_impl->states.empty()) return commit(std::move(label), category, model, context);
    try {
        // Seed the baseline directly, then mark it as the saved checkpoint
        // before appending the first project state.  No caller-visible
        // intermediate state exists, and the guard restores the empty
        // history if allocation/serialization fails while constructing it.
        m_impl->states.push_back({ { 0, {}, Category::Project },
                                   Impl::store(baseline_model, baseline_context, nullptr,
                                               std::move(baseline_direct_frame)) });
        m_cursor = 0;
        rebuild_intervals();
        mark_current_as_saved();
        if (!commit(std::move(label), category, model, context, std::move(direct_frame))) {
            clear();
            return false;
        }
        return true;
    } catch (...) {
        clear();
        throw;
    }
}

bool ProjectHistory::commit_reusing_current_model(std::string label, Category category, const Bytes& context,
                                                  std::optional<RestoreState::DirectFrame> direct_frame,
                                                  std::optional<RestoreState::DirectFrame> predecessor_direct_frame)
{
    if (m_impl->states.empty()) return false;
    const auto& current = m_impl->states[m_cursor].state;
    if (current.context == context && !direct_frame) return false;

    ProjectHistory backup(m_byte_budget);
    backup.m_impl->states = m_impl->states;
    backup.m_impl->next_entry_id = m_impl->next_entry_id;
    backup.m_cursor = m_cursor;
    backup.m_saved_checkpoint = m_saved_checkpoint;
    backup.m_saved_checkpoint_evicted = m_saved_checkpoint_evicted;
    backup.m_optional_bytes_released = m_optional_bytes_released;
    backup.m_evicted_entry_count = m_evicted_entry_count;
    backup.m_last_evicted_entry_id = m_last_evicted_entry_id;
    backup.m_object_intervals = m_object_intervals;
    try {
        // A narrow edit may follow a different narrow edit.  The supplied
        // predecessor frame describes this command's exact restore boundary;
        // retaining an unrelated frame would route Undo through the wrong
        // validator (for example filament state instead of Prime Tower X/Y).
        if (predecessor_direct_frame && predecessor_direct_frame->payload && predecessor_direct_frame->bytes != 0)
            m_impl->states[m_cursor].state.direct_frame = std::move(predecessor_direct_frame);

        StoredState prepared;
        prepared.serialized = current.serialized;
        prepared.mutable_objects = current.mutable_objects;
        prepared.immutable_meshes = current.immutable_meshes;
        prepared.context = context;
        if (direct_frame && (!direct_frame->payload || direct_frame->bytes == 0)) direct_frame.reset();
        prepared.direct_frame = std::move(direct_frame);
        m_impl->states.reserve(m_impl->states.size() + 1);
        if (m_cursor + 1 < m_impl->states.size()) {
            if (m_saved_checkpoint != static_cast<std::size_t>(-1) && m_saved_checkpoint > m_cursor)
                m_saved_checkpoint_evicted = true;
            m_impl->states.erase(m_impl->states.begin() + static_cast<std::ptrdiff_t>(m_cursor + 1), m_impl->states.end());
        }
#ifdef NEO_PROJECT_HISTORY_TEST
        if (m_fail_next_reusing_commit_for_test) {
            m_fail_next_reusing_commit_for_test = false;
            throw std::runtime_error("injected sidecar commit failure");
        }
#endif
        EntryInfo info { m_impl->next_entry_id++, std::move(label), category };
        m_impl->states.push_back({ std::move(info), std::move(prepared) });
        ++m_cursor;
        rebuild_intervals();
        release_least_recently_used();
        return true;
    } catch (...) {
        m_impl->states = std::move(backup.m_impl->states);
        m_impl->next_entry_id = backup.m_impl->next_entry_id;
        m_cursor = backup.m_cursor;
        m_saved_checkpoint = backup.m_saved_checkpoint;
        m_saved_checkpoint_evicted = backup.m_saved_checkpoint_evicted;
        m_optional_bytes_released = backup.m_optional_bytes_released;
        m_evicted_entry_count = backup.m_evicted_entry_count;
        m_last_evicted_entry_id = backup.m_last_evicted_entry_id;
        m_object_intervals = std::move(backup.m_object_intervals);
        throw;
    }
}

bool ProjectHistory::undo(RestoreState& result)
{
    RestorePlan plan;
    if (!prepare_undo(plan) || !commit_restore(plan)) return false;
    result = plan.state;
    return true;
}

bool ProjectHistory::redo(RestoreState& result)
{
    RestorePlan plan;
    if (!prepare_redo(plan) || !commit_restore(plan)) return false;
    result = plan.state;
    return true;
}

bool ProjectHistory::jump(std::uint64_t entry_id, JumpDirection direction, RestoreState& result)
{
    RestorePlan plan;
    if (!prepare_jump(entry_id, direction, plan) || !commit_restore(plan)) return false;
    result = plan.state;
    return true;
}

bool ProjectHistory::jump(std::uint64_t entry_id, RestoreState& result)
{
    RestorePlan plan;
    if (!prepare_jump(entry_id, plan) || !commit_restore(plan)) return false;
    result = plan.state;
    return true;
}

bool ProjectHistory::prepare_undo(RestorePlan& result) const
{
    const std::size_t current_project = project_at_or_before(m_impl->states, m_cursor);
    const std::size_t target = current_project == kNoProject
        ? kNoProject : previous_project(m_impl->states, current_project);
    if (target == kNoProject) return false;
    result.from_cursor = m_cursor;
    result.target_cursor = target;
    const auto& state = m_impl->states[target];
    if (!state.state.direct_frame || state.state.direct_frame->kind != RestoreState::DirectFrame::Kind::PrimeTower)
        result.state.model = Impl::restore_model(state.state);
    result.state.context = state.state.context;
    result.state.entry = state.info;
    result.state.direct_frame = state.state.direct_frame;
    // Undoing a Prime Tower command targets the predecessor checkpoint, whose
    // retained sidecar may belong to an earlier filament edit.  The current
    // Prime Tower entry still owns the exact narrow before/after frame; pass
    // that frame through so restore never falls back to filament validation.
    const auto& source = m_impl->states[current_project];
    if ((!result.state.direct_frame || result.state.direct_frame->kind != RestoreState::DirectFrame::Kind::PrimeTower) &&
        source.info.label == "Move Prime Tower" && source.state.direct_frame &&
        source.state.direct_frame->kind == RestoreState::DirectFrame::Kind::PrimeTower)
        result.state.direct_frame = source.state.direct_frame;
    return true;
}

bool ProjectHistory::prepare_redo(RestorePlan& result) const
{
    const std::size_t current_project = project_at_or_before(m_impl->states, m_cursor);
    if (current_project == kNoProject) return false;
    const std::size_t target = next_project(m_impl->states, current_project);
    if (target == kNoProject) return false;
    result.from_cursor = m_cursor;
    result.target_cursor = target;
    const auto& state = m_impl->states[target];
    if (!state.state.direct_frame || state.state.direct_frame->kind != RestoreState::DirectFrame::Kind::PrimeTower)
        result.state.model = Impl::restore_model(state.state);
    result.state.context = state.state.context;
    result.state.entry = state.info;
    result.state.direct_frame = state.state.direct_frame;
    return true;
}

bool ProjectHistory::prepare_jump(std::uint64_t entry_id, RestorePlan& result) const
{
    auto it = std::find_if(m_impl->states.begin(), m_impl->states.end(),
        [entry_id](const StoredEntry& entry) { return entry.info.id == entry_id; });
    if (it == m_impl->states.end()) return false;
    result.from_cursor = m_cursor;
    result.target_cursor = static_cast<std::size_t>(std::distance(m_impl->states.begin(), it));
    if (!it->state.direct_frame || it->state.direct_frame->kind != RestoreState::DirectFrame::Kind::PrimeTower)
        result.state.model = Impl::restore_model(it->state);
    result.state.context = it->state.context;
    result.state.entry = it->info;
    result.state.direct_frame = it->state.direct_frame;
    return true;
}

bool ProjectHistory::prepare_jump(std::uint64_t entry_id, JumpDirection direction, RestorePlan& result) const
{
    auto it = std::find_if(m_impl->states.begin(), m_impl->states.end(),
        [entry_id](const StoredEntry& entry) { return entry.info.id == entry_id; });
    if (it == m_impl->states.end()) return false;
    const auto selected = static_cast<std::size_t>(std::distance(m_impl->states.begin(), it));
    // The menu is projected from the current Worker cursor.  Reject a stale
    // list item that has crossed the cursor instead of allowing a directional
    // jump to silently move through the opposite menu.
    if (it->info.category != Category::Project || it->info.id == 0) return false;
    if (direction == JumpDirection::Undo) {
        if (selected > m_cursor) return false;
    } else if (selected <= m_cursor) {
        return false;
    }
    std::size_t target = selected;
    if (direction == JumpDirection::Undo && it->info.id != 0) {
        target = previous_project(m_impl->states, selected);
        if (target == kNoProject) return false;
    }
    result.from_cursor = m_cursor;
    result.target_cursor = target;
    const auto& target_entry = m_impl->states[target];
    if (!target_entry.state.direct_frame || target_entry.state.direct_frame->kind != RestoreState::DirectFrame::Kind::PrimeTower)
        result.state.model = Impl::restore_model(target_entry.state);
    result.state.context = target_entry.state.context;
    result.state.entry = target_entry.info;
    result.state.direct_frame = target_entry.state.direct_frame;
    return true;
}

bool ProjectHistory::commit_restore(const RestorePlan& plan)
{
    if (!can_commit_restore(plan)) return false;
    m_cursor = plan.target_cursor;
    return true;
}

bool ProjectHistory::can_commit_restore(const RestorePlan& plan) const
{
    if (plan.from_cursor != m_cursor || plan.target_cursor >= m_impl->states.size()) return false;
    const auto& target = m_impl->states[plan.target_cursor];
    return target.info.id == plan.state.entry.id;
}

bool ProjectHistory::can_undo() const
{
    const std::size_t current_project = project_at_or_before(m_impl->states, m_cursor);
    return current_project != kNoProject && previous_project(m_impl->states, current_project) != kNoProject;
}

bool ProjectHistory::can_redo() const
{
    const std::size_t current_project = project_at_or_before(m_impl->states, m_cursor);
    return current_project != kNoProject && next_project(m_impl->states, current_project) != kNoProject;
}
std::size_t ProjectHistory::entry_count() const { return m_impl->states.empty() ? 0 : m_impl->states.size() - 1; }

const EntryInfo* ProjectHistory::undo_entry() const
{
    if (!can_undo()) return nullptr;
    const std::size_t current_project = project_at_or_before(m_impl->states, m_cursor);
    return current_project == kNoProject ? nullptr : &m_impl->states[current_project].info;
}

const EntryInfo* ProjectHistory::redo_entry() const
{
    if (!can_redo()) return nullptr;
    const std::size_t current_project = project_at_or_before(m_impl->states, m_cursor);
    const std::size_t target = current_project == kNoProject
        ? kNoProject : next_project(m_impl->states, current_project);
    return target == kNoProject ? nullptr : &m_impl->states[target].info;
}

std::vector<EntryInfo> ProjectHistory::entries() const
{
    std::vector<EntryInfo> result;
    result.reserve(m_impl->states.size());
    for (const auto& state : m_impl->states) result.push_back(state.info);
    return result;
}

const RestoreState& ProjectHistory::current() const
{
    static const RestoreState empty;
    if (m_impl->states.empty()) return empty;
    // The returned object is intentionally materialized in a thread-local
    // cache: callers use it for diagnostics; undo/redo are the restoring API.
    thread_local RestoreState cache;
    const auto& state = m_impl->states[m_cursor];
    cache.model = Impl::restore_model(state.state);
    cache.context = state.state.context;
    cache.entry = state.info;
    cache.direct_frame = state.state.direct_frame;
    return cache;
}

void ProjectHistory::mark_current_as_saved()
{
    if (m_impl->states.empty()) return;
    m_saved_checkpoint = m_cursor;
    m_saved_checkpoint_evicted = false;
}

bool ProjectHistory::project_modified() const
{
    if (m_saved_checkpoint_evicted || m_saved_checkpoint == static_cast<std::size_t>(-1) || m_impl->states.empty())
        return true;
    if (m_saved_checkpoint == m_cursor) return false;
    const auto [lo, hi] = std::minmax(m_saved_checkpoint, m_cursor);
    for (std::size_t i = lo + 1; i <= hi; ++i)
        if (m_impl->states[i].info.category == Category::Project) return true;
    return false;
}

std::size_t ProjectHistory::saved_checkpoint() const
{
    return m_saved_checkpoint == static_cast<std::size_t>(-1) ? std::numeric_limits<std::size_t>::max() : m_saved_checkpoint;
}

void ProjectHistory::set_byte_budget(std::size_t byte_budget)
{
    m_byte_budget = byte_budget;
    release_least_recently_used();
}

std::size_t ProjectHistory::bytes_used() const
{
    static_assert(ResourceAccounting::kImplAllocationBytes >= sizeof(Impl),
                  "impl accounting slot must cover ProjectHistory::Impl");
    std::set<const Bytes*> seen;
    std::set<const void*> seen_direct_frames;
    std::size_t total = 0;
    add_bytes(total, ResourceAccounting::kImplAllocationBytes);
    add_product(total, m_impl->states.capacity(), ResourceAccounting::kStoredEntryBytes);
    add_product(total, m_object_intervals.capacity(), ResourceAccounting::kObjectIntervalSlotBytes);
    for (const auto& state : m_impl->states) {
        auto count = [&seen, &total](const Blob& blob) {
            if (!blob || !seen.insert(blob.get()).second) return;
            // The vector capacity is the retained payload allocation.  The
            // fixed unit covers the Bytes object and shared_ptr control block
            // (including make_shared's combined allocation) exactly once per
            // shared payload, regardless of how many states reference it.
            add_bytes(total, blob->capacity());
            add_bytes(total, ResourceAccounting::kSharedBlobAllocationBytes);
        };
        count(state.state.serialized);
        add_bytes(total, state.state.context.capacity());
        if (state.state.direct_frame) {
            add_bytes(total, ResourceAccounting::kDirectFrameSlotBytes);
            const auto& frame = *state.state.direct_frame;
            if (frame.payload && seen_direct_frames.insert(frame.payload.get()).second)
                add_bytes(total, frame.bytes);
        }
        add_product(total, state.state.mutable_objects.capacity(), ResourceAccounting::kMutableObjectSlotBytes);
        add_product(total, state.state.immutable_meshes.capacity(), ResourceAccounting::kImmutableMeshSlotBytes);
        add_string_storage(total, state.info.label);
        for (const auto& object : state.state.mutable_objects) count(object.data);
        for (const auto& mesh : state.state.immutable_meshes) {
            add_string_storage(total, mesh.key);
            count(mesh.resident);
            count(mesh.deferred);
        }
    }
    return total;
}

std::size_t ProjectHistory::release_optional_data()
{
    const auto before = bytes_used();
    for (auto& state : m_impl->states)
        for (auto& mesh : state.state.immutable_meshes)
            if (mesh.optional && mesh.resident && mesh.deferred) {
                mesh.resident.reset();
            }
    const auto released = before >= bytes_used() ? before - bytes_used() : 0;
    m_optional_bytes_released += released;
    return released;
}

ResourceDiagnostics ProjectHistory::resource_diagnostics() const
{
    ResourceDiagnostics result;
    result.bytes_used = bytes_used();
    result.byte_budget = m_byte_budget;
    result.optional_bytes_released = m_optional_bytes_released;
    result.evicted_entry_count = m_evicted_entry_count;
    result.last_evicted_entry_id = m_last_evicted_entry_id;
    if (!m_impl->states.empty()) {
        result.oldest_retained_entry_id = m_impl->states.front().info.id;
        // A retained two-frame timeline whose accounting is still above the
        // normal ceiling is the intentional oversized-operation exception.
        result.oversized_entry_retained = result.bytes_used > m_byte_budget &&
            m_impl->states.size() <= 2;
    }
    return result;
}

void ProjectHistory::release_least_recently_used()
{
    if (m_impl->states.empty()) return;
    if (bytes_used() <= m_byte_budget) return;
    release_optional_data();
    // A single operation may legitimately be larger than the normal budget.
    // Keep both sides of that atomic operation so it remains undoable; the
    // budget is a retention target, not permission to discard its predecessor.
    if (m_impl->states.size() == 2 && bytes_used() > m_byte_budget) return;
    while (bytes_used() > m_byte_budget && m_impl->states.size() > 1) {
        // Keep the live state and its direct predecessor.  The predecessor is
        // the atomic operation's before-state: evicting it would make undo
        // jump over the immediately preceding operation.  Among all other
        // states, remove the oldest one, including redo states only when no
        // older unprotected history remains.  The retained predecessor is
        // naturally promoted to the baseline when index zero is removed.
        const std::size_t predecessor = m_cursor > 0 ? m_cursor - 1 : m_cursor;
        std::size_t remove = m_impl->states.size();
        for (std::size_t index = 0; index < m_impl->states.size(); ++index) {
            if (index == m_cursor || index == predecessor) continue;
            remove = index;
            break;
        }
        if (remove == m_impl->states.size()) break;
        if (m_saved_checkpoint == remove) {
            m_saved_checkpoint = static_cast<std::size_t>(-1);
            m_saved_checkpoint_evicted = true;
        } else if (m_saved_checkpoint != static_cast<std::size_t>(-1) && m_saved_checkpoint > remove) {
            --m_saved_checkpoint;
        }
        m_last_evicted_entry_id = m_impl->states[remove].info.id;
        ++m_evicted_entry_count;
        m_impl->states.erase(m_impl->states.begin() + static_cast<std::ptrdiff_t>(remove));
        if (m_cursor > remove) --m_cursor;
        rebuild_intervals();
        // A single atomic state/entry larger than the budget is retained with
        // its predecessor, so the successful operation can still be undone.
        if (m_impl->states.size() <= 2 && bytes_used() > m_byte_budget) break;
    }
}

void ProjectHistory::rebuild_intervals()
{
    m_object_intervals.clear();
    if (m_impl->states.empty()) return;
    struct ActiveVersion {
        ObjectVersionInterval interval;
        Blob data;
    };
    std::map<ObjectID, ActiveVersion> active;
    for (std::size_t time = 0; time < m_impl->states.size(); ++time) {
        std::set<ObjectID> present;
        for (const auto& object : m_impl->states[time].state.mutable_objects) {
            present.insert(object.id);
            auto it = active.find(object.id);
            const bool same = it != active.end() && it->second.interval.end == time &&
                it->second.data && object.data && *it->second.data == *object.data;
            if (!same) {
                if (it != active.end()) {
                    m_object_intervals.push_back(it->second.interval);
                    active.erase(it);
                }
                active.emplace(object.id, ActiveVersion{ { object.id, time, time + 1 }, object.data });
            } else {
                it->second.interval.end = time + 1;
            }
        }
        for (auto it = active.begin(); it != active.end();) {
            if (!present.count(it->first)) {
                m_object_intervals.push_back(it->second.interval);
                it = active.erase(it);
            } else ++it;
        }
    }
    for (const auto& [id, active_version] : active) m_object_intervals.push_back(active_version.interval);
    std::sort(m_object_intervals.begin(), m_object_intervals.end(), [](const auto& a, const auto& b) {
        return a.begin < b.begin || (a.begin == b.begin && a.id < b.id);
    });
}

} // namespace Slic3r::Neo::History
