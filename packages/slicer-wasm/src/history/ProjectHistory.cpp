#include "ProjectHistory.hpp"

#include <algorithm>
#include <limits>
#include <map>
#include <set>
#include <utility>

namespace Slic3r::Neo::History {

namespace {
using Blob = std::shared_ptr<const Bytes>;

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
};

struct StoredEntry {
    EntryInfo info;
    StoredState state;
};

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
                             const StoredState* previous)
    {
        StoredState state;
        state.serialized = previous && bytes_equal(previous->serialized, model.serialized)
            ? previous->serialized : make_blob(model.serialized);
        state.context = context;

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
    m_object_intervals.clear();
}

bool ProjectHistory::commit(std::string label, Category category, const ModelState& model, const Bytes& context)
{
    if (m_impl->states.empty()) {
        m_impl->states.push_back({ { 0, {}, Category::Project }, Impl::store(model, context, nullptr) });
        m_cursor = 0;
        rebuild_intervals();
        return true;
    }

    if (Impl::equal(m_impl->states[m_cursor].state, model, context)) return false;

    // A new branch invalidates all redo IDs and any saved checkpoint that was
    // only reachable through the discarded branch.
    if (m_cursor + 1 < m_impl->states.size()) {
        if (m_saved_checkpoint != static_cast<std::size_t>(-1) && m_saved_checkpoint > m_cursor)
            m_saved_checkpoint_evicted = true;
        m_impl->states.erase(m_impl->states.begin() + static_cast<std::ptrdiff_t>(m_cursor + 1), m_impl->states.end());
    }

    const StoredState* previous = &m_impl->states.back().state;
    EntryInfo info { m_impl->next_entry_id++, std::move(label), category };
    m_impl->states.push_back({ std::move(info), Impl::store(model, context, previous) });
    ++m_cursor;
    rebuild_intervals();
    release_least_recently_used();
    return true;
}

bool ProjectHistory::undo(RestoreState& result)
{
    if (!can_undo()) return false;
    --m_cursor;
    const auto& state = m_impl->states[m_cursor];
    result.model = Impl::restore_model(state.state);
    result.context = state.state.context;
    result.entry = state.info;
    return true;
}

bool ProjectHistory::redo(RestoreState& result)
{
    if (!can_redo()) return false;
    ++m_cursor;
    const auto& state = m_impl->states[m_cursor];
    result.model = Impl::restore_model(state.state);
    result.context = state.state.context;
    result.entry = state.info;
    return true;
}

bool ProjectHistory::can_undo() const { return !m_impl->states.empty() && m_cursor > 0; }
bool ProjectHistory::can_redo() const { return !m_impl->states.empty() && m_cursor + 1 < m_impl->states.size(); }
std::size_t ProjectHistory::entry_count() const { return m_impl->states.empty() ? 0 : m_impl->states.size() - 1; }

const EntryInfo* ProjectHistory::undo_entry() const
{
    return can_undo() ? &m_impl->states[m_cursor].info : nullptr;
}

const EntryInfo* ProjectHistory::redo_entry() const
{
    return can_redo() ? &m_impl->states[m_cursor + 1].info : nullptr;
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
    std::set<const void*> seen;
    std::size_t total = 0;
    for (const auto& state : m_impl->states) {
        auto count = [&seen, &total](const Blob& blob) {
            if (blob && seen.insert(blob.get()).second) total += blob->size();
        };
        count(state.state.serialized);
        total += state.state.context.size();
        for (const auto& object : state.state.mutable_objects) count(object.data);
        for (const auto& mesh : state.state.immutable_meshes) {
            count(mesh.resident);
            count(mesh.deferred);
        }
    }
    total += m_impl->states.size() * sizeof(StoredEntry);
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
    return before >= bytes_used() ? before - bytes_used() : 0;
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
