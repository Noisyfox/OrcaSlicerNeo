#include "TimestampedHistory.hpp"

#include <algorithm>
#include <limits>
#include <map>
#include <set>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace Slic3r::Neo::History {

namespace {

template <class T> bool shared_bytes_equal(const std::shared_ptr<const T>& lhs, const std::shared_ptr<const T>& rhs)
{
    if (lhs == rhs) return true;
    if (!lhs || !rhs) return false;
    return *lhs == *rhs;
}

bool mutable_equal(const MutableObject& lhs, const MutableObject& rhs)
{
    return lhs.id == rhs.id && lhs.timestamp == rhs.timestamp && shared_bytes_equal(lhs.data, rhs.data) &&
           lhs.volume_ids == rhs.volume_ids && lhs.instance_ids == rhs.instance_ids &&
           lhs.volume_transforms == rhs.volume_transforms &&
           lhs.instance_transforms == rhs.instance_transforms;
}

bool mesh_equal(const ImmutableMesh& lhs, const ImmutableMesh& rhs)
{
    return lhs.key == rhs.key && lhs.native == rhs.native && lhs.native_bytes == rhs.native_bytes;
}

std::size_t string_bytes(const std::string& value)
{
    return value.capacity() + 1;
}

template <class T> std::size_t vector_bytes(const std::vector<T>& value)
{
    return value.capacity() * sizeof(T);
}

template <class T> void sort_unique(std::vector<T>& values)
{
    std::sort(values.begin(), values.end());
    values.erase(std::unique(values.begin(), values.end()), values.end());
}

template <class T> void append_unique(std::vector<T>& target, const std::vector<T>& source)
{
    target.insert(target.end(), source.begin(), source.end());
    sort_unique(target);
}

struct SceneObjectState {
    ObjectID id { 0 };
    std::uint64_t timestamp { 0 };
    std::shared_ptr<const Bytes> archive;
    std::vector<ObjectID> volume_ids;
    std::vector<ObjectID> instance_ids;
    std::vector<MutableObject::Transform> volume_transforms;
    std::vector<MutableObject::Transform> instance_transforms;
};

struct SceneState {
    std::vector<SceneObjectState> objects;
    std::vector<std::string> plate_ids;
};

SceneState scene_state(const TimestampedRoots& roots)
{
    SceneState result;
    result.objects.reserve(roots.model.mutable_objects.size());
    for (const MutableObject& object : roots.model.mutable_objects)
        result.objects.push_back({object.id, object.timestamp, object.data, object.volume_ids, object.instance_ids,
                                  object.volume_transforms, object.instance_transforms});
    result.plate_ids = roots.session.scene_plate_ids;
    sort_unique(result.plate_ids);
    return result;
}

SceneDelta scene_delta(const SceneState& before, const SceneState& after)
{
    SceneDelta result;
    std::unordered_map<ObjectID, const SceneObjectState*> before_by_id;
    std::unordered_map<ObjectID, const SceneObjectState*> after_by_id;
    for (const auto& object : before.objects) before_by_id.emplace(object.id, &object);
    for (const auto& object : after.objects) after_by_id.emplace(object.id, &object);

    std::unordered_set<ObjectID> ids;
    for (const auto& object : before.objects) ids.insert(object.id);
    for (const auto& object : after.objects) ids.insert(object.id);
    for (ObjectID id : ids) {
        const auto old_object = before_by_id.find(id);
        const auto new_object = after_by_id.find(id);
        const bool changed = old_object == before_by_id.end() || new_object == after_by_id.end() ||
            old_object->second->timestamp != new_object->second->timestamp ||
            !shared_bytes_equal(old_object->second->archive, new_object->second->archive) ||
            old_object->second->volume_ids != new_object->second->volume_ids ||
            old_object->second->instance_ids != new_object->second->instance_ids ||
            old_object->second->volume_transforms != new_object->second->volume_transforms ||
            old_object->second->instance_transforms != new_object->second->instance_transforms;
        if (!changed) continue;
        result.object_ids.push_back(id);
        if (old_object != before_by_id.end()) {
            append_unique(result.volume_ids, old_object->second->volume_ids);
            append_unique(result.instance_ids, old_object->second->instance_ids);
        }
        if (new_object != after_by_id.end()) {
            append_unique(result.volume_ids, new_object->second->volume_ids);
            append_unique(result.instance_ids, new_object->second->instance_ids);
        }
    }
    sort_unique(result.object_ids);

    // PlateSession remains authoritative. Conservatively touch every stable
    // plate participating in the transaction; this covers membership,
    // topology, configuration, and current-plate context without retaining a
    // second parsed session representation.
    result.plate_ids = before.plate_ids;
    append_unique(result.plate_ids, after.plate_ids);
    return result;
}

void merge_scene_delta(SceneDelta& target, const SceneDelta& source)
{
    append_unique(target.object_ids, source.object_ids);
    append_unique(target.volume_ids, source.volume_ids);
    append_unique(target.instance_ids, source.instance_ids);
    append_unique(target.plate_ids, source.plate_ids);
}

} // namespace

struct TimestampedHistory::Impl {
    using StoredMesh = ImmutableMesh;

    struct Snapshot {
        LogicalTimestamp timestamp { 0 };
        std::shared_ptr<const Bytes> model_manifest;
        std::vector<ObjectID> object_order;
        std::unordered_map<ObjectID, std::shared_ptr<const MutableObject>> objects;
        std::vector<std::shared_ptr<StoredMesh>> meshes;
        std::shared_ptr<const Bytes> plate_session;
        std::shared_ptr<const Bytes> history_context;
        std::shared_ptr<const Bytes> project_config;
    };

    struct Operation {
        std::string label;
        LogicalTimestamp before_timestamp { 0 };
        std::size_t depth { 1 };
        std::shared_ptr<Snapshot> prior_snapshot;
        SceneState before_scene;
    };

    static constexpr std::size_t kImplBytes = 256;
    static constexpr std::size_t kSnapshotBytes = 320;
    static constexpr std::size_t kEntryBytes = 128;
    static constexpr std::size_t kObjectArchiveBytes = 128;
    static constexpr std::size_t kMeshArchiveBytes = 160;
    static constexpr std::size_t kSharedBlobBytes = 64;
    static constexpr std::size_t kIntervalBytes = 64;

    explicit Impl(std::size_t budget) : byte_budget(budget) {}

    std::size_t byte_budget;
    LogicalTimestamp current_timestamp { 0 };
    LogicalTimestamp next_timestamp { 1 };
    std::uint64_t next_entry_id { 1 };
    std::map<LogicalTimestamp, std::shared_ptr<Snapshot>> snapshots;
    std::vector<TimestampedEntryInfo> entries;
    std::optional<Operation> operation;
    std::optional<LogicalTimestamp> saved_timestamp;
    bool saved_checkpoint_evicted { false };
    std::size_t evicted_timestamp_count { 0 };
    LogicalTimestamp last_evicted_timestamp { 0 };
    bool oversized_nearest_history_retained { false };
    std::vector<TimestampedObjectVersionInterval> intervals;

    const Snapshot* previous_snapshot(LogicalTimestamp timestamp) const
    {
        auto it = snapshots.lower_bound(timestamp);
        if (it == snapshots.begin()) return nullptr;
        return std::prev(it)->second.get();
    }

    static std::shared_ptr<const Bytes> store_blob(const Bytes& source, const std::shared_ptr<const Bytes>& previous)
    {
        if (previous && *previous == source) return previous;
        return std::make_shared<const Bytes>(source);
    }

    bool roots_equal(const Snapshot& snapshot, const TimestampedRoots& roots) const
    {
        if (!snapshot.model_manifest || *snapshot.model_manifest != roots.model.serialized ||
            snapshot.object_order.size() != roots.model.mutable_objects.size() ||
            snapshot.meshes.size() != roots.model.immutable_meshes.size() ||
            !snapshot.plate_session || *snapshot.plate_session != roots.session.plate_session ||
            !snapshot.history_context || *snapshot.history_context != roots.session.history_context ||
            !snapshot.project_config ||
            *snapshot.project_config != roots.project_config)
            return false;

        for (std::size_t index = 0; index < snapshot.object_order.size(); ++index) {
            const auto& source = roots.model.mutable_objects[index];
            if (snapshot.object_order[index] != source.id) return false;
            const auto found = snapshot.objects.find(source.id);
            if (found == snapshot.objects.end() || !mutable_equal(*found->second, source)) return false;
        }
        for (std::size_t index = 0; index < snapshot.meshes.size(); ++index) {
            if (!mesh_equal(*snapshot.meshes[index], roots.model.immutable_meshes[index])) return false;
        }
        return true;
    }

    bool capture(LogicalTimestamp timestamp, const TimestampedRoots& roots, bool replace_existing = false)
    {
        const auto existing = snapshots.find(timestamp);
        if (existing != snapshots.end() && roots_equal(*existing->second, roots)) return true;
        if (existing != snapshots.end() && !replace_existing) return false;

        const Snapshot* previous = existing != snapshots.end() ? existing->second.get() : previous_snapshot(timestamp);
        auto snapshot = std::make_shared<Snapshot>();
        snapshot->timestamp = timestamp;
        snapshot->model_manifest = store_blob(roots.model.serialized, previous ? previous->model_manifest : nullptr);
        snapshot->plate_session = store_blob(roots.session.plate_session, previous ? previous->plate_session : nullptr);
        snapshot->history_context = store_blob(roots.session.history_context, previous ? previous->history_context : nullptr);
        snapshot->project_config =
            store_blob(roots.project_config, previous ? previous->project_config : nullptr);

        snapshot->object_order.reserve(roots.model.mutable_objects.size());
        snapshot->objects.reserve(roots.model.mutable_objects.size());
        for (const MutableObject& source : roots.model.mutable_objects) {
            if (source.id == 0 || snapshot->objects.find(source.id) != snapshot->objects.end()) return false;
            std::shared_ptr<const MutableObject> archive;
            if (previous) {
                const auto found = previous->objects.find(source.id);
                if (found != previous->objects.end()) {
                    if (mutable_equal(*found->second, source)) archive = found->second;
                }
            }
            if (!archive) archive = std::make_shared<const MutableObject>(source);
            snapshot->object_order.push_back(source.id);
            snapshot->objects.emplace(source.id, std::move(archive));
        }

        snapshot->meshes.reserve(roots.model.immutable_meshes.size());
        std::unordered_set<std::string> mesh_keys;
        for (const ImmutableMesh& source : roots.model.immutable_meshes) {
            if (!mesh_keys.insert(source.key).second) return false;
            std::shared_ptr<StoredMesh> archive;
            if (previous) {
                const auto found = std::find_if(previous->meshes.begin(), previous->meshes.end(),
                    [&source](const auto& candidate) { return candidate->key == source.key; });
                if (found != previous->meshes.end() && mesh_equal(**found, source)) archive = *found;
            }
            if (!archive) {
                archive = std::make_shared<StoredMesh>();
                archive->key = source.key;
                archive->native = source.native;
                archive->native_bytes = source.native_bytes;
            }
            snapshot->meshes.push_back(std::move(archive));
        }

        if (existing == snapshots.end())
            snapshots.emplace(timestamp, std::move(snapshot));
        else
            existing->second = std::move(snapshot);
        rebuild_intervals();
        return true;
    }

    bool refresh_restored_context(LogicalTimestamp timestamp, const TimestampedRoots& roots)
    {
        const auto existing = snapshots.find(timestamp);
        if (existing == snapshots.end()) return false;
        const Snapshot& prior = *existing->second;
        if (prior.object_order.size() != roots.model.mutable_objects.size() ||
            prior.meshes.size() != roots.model.immutable_meshes.size())
            return false;
        for (std::size_t index = 0; index < prior.object_order.size(); ++index) {
            const auto found = prior.objects.find(prior.object_order[index]);
            if (found == prior.objects.end()) return false;
            const MutableObject& retained = *found->second;
            const MutableObject& live = roots.model.mutable_objects[index];
            // The restored timestamp's archive is immutable and remains the
            // authority. A fresh cereal stream may differ in internal derived
            // bytes, so validate every independently versioned/overlaid field
            // and refresh only session/editing roots; never replace the model
            // archive at an existing timestamp.
            if (prior.object_order[index] != live.id || retained.timestamp != live.timestamp ||
                retained.volume_ids != live.volume_ids || retained.instance_ids != live.instance_ids ||
                retained.volume_transforms != live.volume_transforms ||
                retained.instance_transforms != live.instance_transforms)
                return false;
        }
        for (std::size_t index = 0; index < prior.meshes.size(); ++index)
            if (prior.meshes[index]->key != roots.model.immutable_meshes[index].key) return false;

        auto snapshot = std::make_shared<Snapshot>(prior);
        snapshot->plate_session = store_blob(roots.session.plate_session, prior.plate_session);
        snapshot->history_context = store_blob(roots.session.history_context, prior.history_context);
        snapshot->project_config =
            store_blob(roots.project_config, prior.project_config);
        existing->second = std::move(snapshot);
        return true;
    }

    bool load(LogicalTimestamp timestamp, TimestampedRestore& result) const
    {
        const auto found = snapshots.find(timestamp);
        if (found == snapshots.end()) return false;
        const Snapshot& snapshot = *found->second;

        TimestampedRestore restored;
        restored.timestamp = timestamp;
        restored.roots.model.serialized = *snapshot.model_manifest;
        restored.roots.model.mutable_objects.reserve(snapshot.object_order.size());
        for (ObjectID id : snapshot.object_order) {
            const auto object = snapshot.objects.find(id);
            if (object == snapshot.objects.end()) return false;
            restored.roots.model.mutable_objects.push_back(*object->second);
        }
        restored.roots.model.immutable_meshes.reserve(snapshot.meshes.size());
        for (const auto& mesh : snapshot.meshes) restored.roots.model.immutable_meshes.push_back(*mesh);
        restored.roots.session.plate_session = *snapshot.plate_session;
        restored.roots.session.history_context = *snapshot.history_context;
        restored.roots.project_config = *snapshot.project_config;
        result = std::move(restored);
        return true;
    }

    const TimestampedEntryInfo* undo_entry() const
    {
        const auto found = std::find_if(entries.rbegin(), entries.rend(), [this](const auto& entry) {
            return entry.after_timestamp == current_timestamp;
        });
        return found == entries.rend() ? nullptr : &*found;
    }

    const TimestampedEntryInfo* redo_entry() const
    {
        const auto found = std::find_if(entries.begin(), entries.end(), [this](const auto& entry) {
            return entry.before_timestamp == current_timestamp;
        });
        return found == entries.end() ? nullptr : &*found;
    }

    bool timestamp_available(LogicalTimestamp timestamp) const
    {
        return snapshots.find(timestamp) != snapshots.end() ||
               (timestamp == current_timestamp && snapshots.find(timestamp) == snapshots.end());
    }

    bool collect_scene_delta(LogicalTimestamp target, SceneDelta& result) const
    {
        auto cursor = current_timestamp;
        while (cursor != target) {
            if (target < cursor) {
                const auto found = std::find_if(entries.rbegin(), entries.rend(), [cursor](const auto& entry) {
                    return entry.after_timestamp == cursor;
                });
                if (found == entries.rend()) return false;
                merge_scene_delta(result, found->scene_delta);
                cursor = found->before_timestamp;
            } else {
                const auto found = std::find_if(entries.begin(), entries.end(), [cursor](const auto& entry) {
                    return entry.before_timestamp == cursor;
                });
                if (found == entries.end()) return false;
                merge_scene_delta(result, found->scene_delta);
                cursor = found->after_timestamp;
            }
        }
        return true;
    }

    void note_checkpoint_loss(LogicalTimestamp timestamp)
    {
        if (saved_timestamp && *saved_timestamp == timestamp) {
            saved_timestamp.reset();
            saved_checkpoint_evicted = true;
        }
    }

    void erase_snapshot(LogicalTimestamp timestamp, bool budget_eviction)
    {
        if (snapshots.erase(timestamp) == 0) return;
        note_checkpoint_loss(timestamp);
        if (budget_eviction) {
            ++evicted_timestamp_count;
            last_evicted_timestamp = timestamp;
        }
    }

    void prune_unusable_entries()
    {
        entries.erase(std::remove_if(entries.begin(), entries.end(), [this](const auto& entry) {
            return !timestamp_available(entry.before_timestamp) || !timestamp_available(entry.after_timestamp);
        }), entries.end());
        entries.shrink_to_fit();
    }

    void truncate_redo_branch()
    {
        const auto first_future = std::find_if(entries.begin(), entries.end(), [this](const auto& entry) {
            return entry.before_timestamp == current_timestamp;
        });
        if (first_future == entries.end()) return;
        entries.erase(first_future, entries.end());
        entries.shrink_to_fit();

        std::set<LogicalTimestamp> retained { current_timestamp };
        for (const auto& entry : entries) {
            retained.insert(entry.before_timestamp);
            retained.insert(entry.after_timestamp);
        }
        std::vector<LogicalTimestamp> discarded;
        for (const auto& [timestamp, snapshot] : snapshots)
            if (retained.find(timestamp) == retained.end()) discarded.push_back(timestamp);
        for (LogicalTimestamp timestamp : discarded) erase_snapshot(timestamp, false);
        rebuild_intervals();
    }

    std::set<LogicalTimestamp> protected_timestamps() const
    {
        std::set<LogicalTimestamp> result;
        if (snapshots.find(current_timestamp) != snapshots.end()) result.insert(current_timestamp);
        if (const auto* entry = undo_entry()) result.insert(entry->before_timestamp);
        if (const auto* entry = redo_entry()) result.insert(entry->after_timestamp);
        return result;
    }

    std::size_t bytes_used() const
    {
        std::size_t result = kImplBytes + entries.capacity() * kEntryBytes + intervals.capacity() * kIntervalBytes;
        std::unordered_set<const Bytes*> blobs;
        std::unordered_set<const MutableObject*> objects;
        std::unordered_set<const StoredMesh*> meshes;
        std::unordered_set<const ::Slic3r::TriangleMesh*> native_meshes;

        const auto add_blob = [&result, &blobs](const std::shared_ptr<const Bytes>& blob) {
            if (blob && blobs.insert(blob.get()).second) result += kSharedBlobBytes + blob->capacity();
        };
        for (const auto& [timestamp, snapshot] : snapshots) {
            result += kSnapshotBytes + vector_bytes(snapshot->object_order) +
                      snapshot->objects.bucket_count() * sizeof(void*) + vector_bytes(snapshot->meshes);
            add_blob(snapshot->model_manifest);
            add_blob(snapshot->plate_session);
            add_blob(snapshot->history_context);
            add_blob(snapshot->project_config);
            for (const auto& [id, object] : snapshot->objects) {
                if (!objects.insert(object.get()).second) continue;
                add_blob(object->data);
                result += kObjectArchiveBytes +
                    vector_bytes(object->volume_ids) +
                    vector_bytes(object->instance_ids) + vector_bytes(object->volume_transforms) +
                    vector_bytes(object->instance_transforms);
            }
            for (const auto& mesh : snapshot->meshes) {
                if (!meshes.insert(mesh.get()).second) continue;
                result += kMeshArchiveBytes + string_bytes(mesh->key);
                if (mesh->native && native_meshes.insert(mesh->native.get()).second)
                    result += std::max(mesh->native_bytes, std::size_t(64));
            }
        }
        for (const auto& entry : entries) {
            result += string_bytes(entry.label) + vector_bytes(entry.scene_delta.object_ids) +
                      vector_bytes(entry.scene_delta.volume_ids) + vector_bytes(entry.scene_delta.instance_ids) +
                      vector_bytes(entry.scene_delta.plate_ids);
            for (const auto& plate_id : entry.scene_delta.plate_ids) result += string_bytes(plate_id);
        }
        if (operation) {
            result += kEntryBytes + string_bytes(operation->label) + vector_bytes(operation->before_scene.objects) +
                      vector_bytes(operation->before_scene.plate_ids);
            for (const auto& object : operation->before_scene.objects)
                result += vector_bytes(object.volume_ids) + vector_bytes(object.instance_ids) +
                    vector_bytes(object.volume_transforms) + vector_bytes(object.instance_transforms);
            for (const auto& plate_id : operation->before_scene.plate_ids) result += string_bytes(plate_id);
        }
        return result;
    }

    void enforce_budget()
    {
        while (bytes_used() > byte_budget) {
            const auto protected_set = protected_timestamps();
            const auto candidate = std::find_if(snapshots.begin(), snapshots.end(), [&protected_set](const auto& item) {
                return protected_set.find(item.first) == protected_set.end();
            });
            if (candidate == snapshots.end()) break;
            erase_snapshot(candidate->first, true);
            prune_unusable_entries();
            rebuild_intervals();
        }
        oversized_nearest_history_retained = bytes_used() > byte_budget;
    }

    void rebuild_intervals()
    {
        intervals.clear();
        struct Active {
            LogicalTimestamp begin { 0 };
            std::shared_ptr<const MutableObject> archive;
        };
        std::unordered_map<ObjectID, Active> active;
        for (const auto& [timestamp, snapshot] : snapshots) {
            std::unordered_set<ObjectID> present;
            for (ObjectID id : snapshot->object_order) {
                const auto object = snapshot->objects.find(id);
                if (object == snapshot->objects.end()) continue;
                present.insert(id);
                const auto previous = active.find(id);
                if (previous == active.end()) {
                    active.emplace(id, Active { timestamp, object->second });
                } else if (previous->second.archive != object->second) {
                    intervals.push_back({ id, previous->second.archive->timestamp, previous->second.begin,
                                          timestamp, previous->second.archive });
                    previous->second = Active { timestamp, object->second };
                }
            }
            for (auto it = active.begin(); it != active.end();) {
                if (present.find(it->first) != present.end()) {
                    ++it;
                    continue;
                }
                intervals.push_back({ it->first, it->second.archive->timestamp, it->second.begin,
                                      timestamp, it->second.archive });
                it = active.erase(it);
            }
        }
        for (const auto& [id, version] : active)
            intervals.push_back({ id, version.archive->timestamp, version.begin, TimestampedHistory::kOpenEnded,
                                  version.archive });
        std::sort(intervals.begin(), intervals.end(), [](const auto& lhs, const auto& rhs) {
            return lhs.begin != rhs.begin ? lhs.begin < rhs.begin : lhs.id < rhs.id;
        });
        intervals.shrink_to_fit();
    }
};

TimestampedHistory::TimestampedHistory(std::size_t byte_budget) : m_impl(std::make_unique<Impl>(byte_budget)) {}
TimestampedHistory::~TimestampedHistory() = default;
TimestampedHistory::TimestampedHistory(TimestampedHistory&&) noexcept = default;
TimestampedHistory& TimestampedHistory::operator=(TimestampedHistory&&) noexcept = default;

void TimestampedHistory::clear()
{
    const std::size_t budget = m_impl->byte_budget;
    m_impl = std::make_unique<Impl>(budget);
}

bool TimestampedHistory::begin_operation(std::string label, const TimestampedRoots& predecessor)
{
    if (m_impl->operation) {
        ++m_impl->operation->depth;
        return true;
    }
    const auto existing = m_impl->snapshots.find(m_impl->current_timestamp);
    const auto prior_snapshot = existing == m_impl->snapshots.end() ? std::shared_ptr<Impl::Snapshot>() : existing->second;
    // A restored timestamp already owns its immutable model archive. Refresh
    // only the live session/editing roots so the next real mutation samples
    // UI-only context without re-archiving or rewriting that model version.
    if (existing == m_impl->snapshots.end()) {
        if (!m_impl->capture(m_impl->current_timestamp, predecessor, true)) return false;
    } else if (!m_impl->refresh_restored_context(m_impl->current_timestamp, predecessor)) {
        return false;
    }
    m_impl->operation = Impl::Operation {
        std::move(label), m_impl->current_timestamp, 1, prior_snapshot, scene_state(predecessor)};
    return true;
}

bool TimestampedHistory::commit_operation(const TimestampedRoots& successor, SceneDelta* committed_delta)
{
    if (!m_impl->operation) return false;
    if (m_impl->operation->depth > 1) {
        --m_impl->operation->depth;
        return true;
    }
    const auto operation = std::move(*m_impl->operation);
    m_impl->operation.reset();
    m_impl->truncate_redo_branch();
    const LogicalTimestamp after = m_impl->next_timestamp++;
    m_impl->entries.push_back({m_impl->next_entry_id++, operation.label, operation.before_timestamp, after,
                               scene_delta(operation.before_scene, scene_state(successor))});
    if (committed_delta) {
        *committed_delta = m_impl->entries.back().scene_delta;
        for (const auto& object : successor.model.mutable_objects)
            committed_delta->object_order.push_back(object.id);
    }
    m_impl->current_timestamp = after;
    m_impl->rebuild_intervals();
    m_impl->enforce_budget();
    return true;
}

bool TimestampedHistory::abort_operation(TimestampedRestore* predecessor)
{
    if (!m_impl->operation) return false;
    const auto operation = std::move(*m_impl->operation);
    m_impl->operation.reset();
    TimestampedRestore restored;
    if (!m_impl->load(operation.before_timestamp, restored)) return false;
    if (operation.prior_snapshot) {
        m_impl->snapshots[operation.before_timestamp] = operation.prior_snapshot;
        m_impl->rebuild_intervals();
    } else {
        m_impl->snapshots.erase(operation.before_timestamp);
        m_impl->rebuild_intervals();
    }
    if (predecessor) *predecessor = std::move(restored);
    return true;
}

bool TimestampedHistory::operation_active() const { return m_impl->operation.has_value(); }

bool TimestampedHistory::undo(const TimestampedRoots& live_current, TimestampedRestore& result)
{
    if (m_impl->operation) return false;
    const auto* entry = m_impl->undo_entry();
    if (!entry) return false;
    const LogicalTimestamp target = entry->before_timestamp;
    // Only the uncaptured logical top needs a lazy archive. A timestamp that
    // was already materialized (for example after Redo) remains immutable;
    // UI-only selection/current-plate changes must not rewrite or stale it.
    if (m_impl->snapshots.find(m_impl->current_timestamp) == m_impl->snapshots.end() &&
        !m_impl->capture(m_impl->current_timestamp, live_current))
        return false;
    return restore(target, &live_current, result);
}

bool TimestampedHistory::redo(TimestampedRestore& result)
{
    if (m_impl->operation) return false;
    const auto* entry = m_impl->redo_entry();
    return entry && restore(entry->after_timestamp, nullptr, result);
}

bool TimestampedHistory::restore(LogicalTimestamp target, const TimestampedRoots* live_current,
                                 TimestampedRestore& result)
{
    if (m_impl->operation) return false;
    if (m_impl->snapshots.find(m_impl->current_timestamp) == m_impl->snapshots.end()) {
        if (!live_current || !m_impl->capture(m_impl->current_timestamp, *live_current)) return false;
    }
    SceneDelta delta;
    if (!m_impl->collect_scene_delta(target, delta) || !m_impl->load(target, result)) return false;
    delta.object_order.reserve(result.roots.model.mutable_objects.size());
    for (const MutableObject& object : result.roots.model.mutable_objects) delta.object_order.push_back(object.id);
    result.scene_delta = std::move(delta);
    m_impl->current_timestamp = target;
    m_impl->enforce_budget();
    return true;
}

bool TimestampedHistory::restore_before(std::uint64_t entry_id, const TimestampedRoots* live_current,
                                        TimestampedRestore& result)
{
    const auto found = std::find_if(m_impl->entries.begin(), m_impl->entries.end(), [entry_id](const auto& entry) {
        return entry.id == entry_id;
    });
    return found != m_impl->entries.end() && restore(found->before_timestamp, live_current, result);
}

bool TimestampedHistory::restore_after(std::uint64_t entry_id, const TimestampedRoots* live_current,
                                       TimestampedRestore& result)
{
    const auto found = std::find_if(m_impl->entries.begin(), m_impl->entries.end(), [entry_id](const auto& entry) {
        return entry.id == entry_id;
    });
    return found != m_impl->entries.end() && restore(found->after_timestamp, live_current, result);
}

bool TimestampedHistory::can_undo() const
{
    const auto* entry = m_impl->undo_entry();
    return entry && m_impl->snapshots.find(entry->before_timestamp) != m_impl->snapshots.end();
}

bool TimestampedHistory::can_redo() const
{
    const auto* entry = m_impl->redo_entry();
    return entry && m_impl->snapshots.find(entry->after_timestamp) != m_impl->snapshots.end();
}

LogicalTimestamp TimestampedHistory::current_timestamp() const { return m_impl->current_timestamp; }
const std::vector<TimestampedEntryInfo>& TimestampedHistory::entries() const { return m_impl->entries; }

void TimestampedHistory::mark_current_as_saved()
{
    m_impl->saved_timestamp = m_impl->current_timestamp;
    m_impl->saved_checkpoint_evicted = false;
}

bool TimestampedHistory::project_modified() const
{
    return m_impl->saved_checkpoint_evicted || !m_impl->saved_timestamp ||
           *m_impl->saved_timestamp != m_impl->current_timestamp;
}

bool TimestampedHistory::saved_checkpoint_evicted() const { return m_impl->saved_checkpoint_evicted; }
std::optional<LogicalTimestamp> TimestampedHistory::saved_timestamp() const { return m_impl->saved_timestamp; }

std::size_t TimestampedHistory::byte_budget() const { return m_impl->byte_budget; }

void TimestampedHistory::set_byte_budget(std::size_t byte_budget)
{
    m_impl->byte_budget = byte_budget;
    m_impl->enforce_budget();
}

std::size_t TimestampedHistory::bytes_used() const { return m_impl->bytes_used(); }

TimestampedResourceDiagnostics TimestampedHistory::resource_diagnostics() const
{
    return { m_impl->bytes_used(), m_impl->byte_budget,
             m_impl->evicted_timestamp_count, m_impl->last_evicted_timestamp,
             m_impl->oversized_nearest_history_retained };
}

std::size_t TimestampedHistory::snapshot_count() const { return m_impl->snapshots.size(); }

std::size_t TimestampedHistory::object_archive_count() const
{
    std::unordered_set<const MutableObject*> archives;
    for (const auto& [timestamp, snapshot] : m_impl->snapshots)
        for (const auto& [id, archive] : snapshot->objects) archives.insert(archive.get());
    return archives.size();
}

std::shared_ptr<const MutableObject> TimestampedHistory::object_archive(LogicalTimestamp timestamp, ObjectID id) const
{
    const auto snapshot = m_impl->snapshots.find(timestamp);
    if (snapshot == m_impl->snapshots.end()) return {};
    const auto object = snapshot->second->objects.find(id);
    return object == snapshot->second->objects.end() ? std::shared_ptr<const MutableObject>() : object->second;
}

const std::vector<TimestampedObjectVersionInterval>& TimestampedHistory::object_intervals() const
{
    return m_impl->intervals;
}

} // namespace Slic3r::Neo::History
