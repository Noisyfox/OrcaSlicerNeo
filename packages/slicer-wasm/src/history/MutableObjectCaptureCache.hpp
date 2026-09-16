// ----------------------------------------------------------------
// Bridge-owned timestamp-gated mutable ModelObject capture cache.
// ----------------------------------------------------------------
#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <set>
#include <utility>
#include <vector>

#include "ProjectHistory.hpp"
#include "libslic3r/TriangleMesh.hpp"

namespace Slic3r::Neo::History::Codec {

// ModelObject timestamps are an optional fast path supplied by libslic3r.
// Keep the prior archive only while the object remains live, and retain weak
// mesh-owner tokens so a replaced mesh (including a recycled address) cannot
// accidentally make an old object archive look current.
class MutableObjectCaptureCache {
public:
    using MeshPtr = std::shared_ptr<const Slic3r::TriangleMesh>;

    struct Entry {
        std::uint64_t timestamp { 0 };
        std::shared_ptr<const Bytes> bytes;
        std::vector<std::weak_ptr<const Slic3r::TriangleMesh>> meshes;
        std::vector<ObjectID> volume_ids;
        std::vector<ObjectID> instance_ids;
    };

    void clear() noexcept
    {
        m_entries.clear();
        m_serialized_object_count = 0;
        m_reused_object_count = 0;
    }

    void retain_only(const std::set<ObjectID>& live)
    {
        for (auto it = m_entries.begin(); it != m_entries.end();) {
            if (live.find(it->first) == live.end()) it = m_entries.erase(it);
            else ++it;
        }
    }

    const Entry* find(ObjectID id, std::uint64_t timestamp,
                      const std::vector<MeshPtr>& meshes,
                      const std::vector<ObjectID>& volume_ids,
                      const std::vector<ObjectID>& instance_ids) const
    {
        if (timestamp == 0) return nullptr;
        const auto it = m_entries.find(id);
        if (it == m_entries.end() || it->second.timestamp != timestamp ||
            it->second.volume_ids != volume_ids || it->second.instance_ids != instance_ids ||
            it->second.meshes.size() != meshes.size())
            return nullptr;
        std::owner_less<MeshPtr> owner_less;
        for (std::size_t index = 0; index < meshes.size(); ++index) {
            const auto prior = it->second.meshes[index].lock();
            if (!prior && !meshes[index]) continue;
            if (!prior || !meshes[index] || owner_less(prior, meshes[index]) || owner_less(meshes[index], prior))
                return nullptr;
        }
        return it->second.bytes ? &it->second : nullptr;
    }

    void insert(ObjectID id, std::uint64_t timestamp, std::shared_ptr<const Bytes> bytes,
                const std::vector<MeshPtr>& meshes, std::vector<ObjectID> volume_ids,
                std::vector<ObjectID> instance_ids)
    {
        Entry entry;
        entry.timestamp = timestamp;
        entry.bytes = std::move(bytes);
        entry.volume_ids = std::move(volume_ids);
        entry.instance_ids = std::move(instance_ids);
        entry.meshes.reserve(meshes.size());
        for (const auto& mesh : meshes) entry.meshes.emplace_back(mesh);
        m_entries[id] = std::move(entry);
        ++m_serialized_object_count;
    }

    void record_reuse() noexcept { ++m_reused_object_count; }
    std::size_t serialized_object_count() const noexcept { return m_serialized_object_count; }
    std::size_t reused_object_count() const noexcept { return m_reused_object_count; }

private:
    std::map<ObjectID, Entry> m_entries;
    std::size_t m_serialized_object_count { 0 };
    std::size_t m_reused_object_count { 0 };
};

} // namespace Slic3r::Neo::History::Codec
