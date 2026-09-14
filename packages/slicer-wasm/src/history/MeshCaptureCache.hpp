// ----------------------------------------------------------------
// Bridge-owned immutable mesh capture cache.
// ----------------------------------------------------------------
#pragma once

#include <map>
#include <memory>
#include <set>
#include <string>

#include "ProjectHistory.hpp"
#include "libslic3r/TriangleMesh.hpp"

namespace Slic3r::Neo::History::Codec {

// A cache entry is keyed by shared ownership identity rather than a raw
// TriangleMesh address. Retaining the shared pointer in the key keeps the mesh
// alive for exactly as long as the cache entry is retained and prevents a
// later mesh from being mistaken for a destroyed mesh at a recycled address.
// The entry stores only a session-local reference key; native mesh ownership
// is carried by each captured ModelState and history entry, not by bytes.
class MeshCaptureCache {
public:
    using MeshPtr = std::shared_ptr<const Slic3r::TriangleMesh>;

    struct Entry {
        std::string key;
    };

    using EntryMap = std::map<MeshPtr, Entry, std::owner_less<MeshPtr>>;

    void clear() noexcept
    {
        m_entries.clear();
        m_serialized_mesh_count = 0;
    }

    void retain_only(const std::set<MeshPtr, std::owner_less<MeshPtr>>& live)
    {
        for (auto it = m_entries.begin(); it != m_entries.end();) {
            if (live.find(it->first) == live.end()) it = m_entries.erase(it);
            else ++it;
        }
    }

    const Entry* find(const MeshPtr& mesh) const
    {
        const auto it = m_entries.find(mesh);
        return it == m_entries.end() ? nullptr : &it->second;
    }

    void insert(MeshPtr mesh, Entry entry)
    {
        m_entries.emplace(std::move(mesh), std::move(entry));
        ++m_serialized_mesh_count;
    }

    std::size_t serialized_mesh_count() const noexcept { return m_serialized_mesh_count; }

private:
    EntryMap m_entries;
    std::size_t m_serialized_mesh_count { 0 };
};

} // namespace Slic3r::Neo::History::Codec
