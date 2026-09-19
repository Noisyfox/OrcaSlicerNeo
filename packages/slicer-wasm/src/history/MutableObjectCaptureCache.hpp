// ----------------------------------------------------------------
// Bridge-owned timestamp-gated mutable ModelObject capture cache.
// ----------------------------------------------------------------
#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "ProjectHistory.hpp"
#include "libslic3r/TriangleMesh.hpp"

namespace Slic3r::Neo::History::Codec {

// ModelObject timestamps are an optional fast path supplied by libslic3r and
// may legitimately remain zero for imported objects. The exact mutation
// fingerprint is the correctness gate. Keep the prior archive only while the
// object remains live, and retain mesh-owner tokens so a replaced mesh
// (including a recycled address) cannot make an old archive look current.
// These shared owners reference the live native mesh; they do not copy it and
// are replaced immediately on the next fingerprint miss.
class MutableObjectCaptureCache {
public:
    using MeshPtr = std::shared_ptr<const Slic3r::TriangleMesh>;

    struct VolumeFingerprint {
        std::array<double, 16> transform {};
        std::uint64_t config_timestamp { 0 };
        std::array<std::uint64_t, 4> facet_timestamps {};
        std::string name;
        std::string material_id;
        int type { 0 };
        std::string metadata;
        bool reusable { true };

        bool operator==(const VolumeFingerprint& other) const
        {
            return config_timestamp == other.config_timestamp &&
                facet_timestamps == other.facet_timestamps && name == other.name &&
                material_id == other.material_id && type == other.type &&
                reusable && other.reusable && metadata == other.metadata;
        }
    };

    struct InstanceFingerprint {
        std::array<double, 16> transform {};
        std::array<double, 16> assemble_transform {};
        bool printable { false };
        bool auto_drop { false };
        int print_volume_state { 0 };
        int arrange_order { 0 };
        std::size_t loaded_id { 0 };
        std::array<double, 3> assembly_offset {};
        bool assemble_initialized { false };

        bool operator==(const InstanceFingerprint& other) const
        {
            return assemble_transform == other.assemble_transform &&
                printable == other.printable && auto_drop == other.auto_drop &&
                print_volume_state == other.print_volume_state &&
                arrange_order == other.arrange_order &&
                loaded_id == other.loaded_id && assembly_offset == other.assembly_offset &&
                assemble_initialized == other.assemble_initialized;
        }
    };

    struct MutationFingerprint {
        std::uint64_t object_config_timestamp { 0 };
        std::string name;
        std::string module_name;
        std::string input_file;
        bool printable { false };
        std::string metadata;
        std::vector<VolumeFingerprint> volumes;
        std::vector<InstanceFingerprint> instances;

        bool operator==(const MutationFingerprint& other) const
        {
            return object_config_timestamp == other.object_config_timestamp && name == other.name &&
                module_name == other.module_name && input_file == other.input_file &&
                printable == other.printable && metadata == other.metadata &&
                volumes == other.volumes && instances == other.instances;
        }
    };

    struct Entry {
        std::uint64_t timestamp { 0 };
        std::shared_ptr<const Bytes> bytes;
        std::vector<MeshPtr> meshes;
        std::vector<ObjectID> volume_ids;
        std::vector<ObjectID> instance_ids;
        MutationFingerprint mutation_fingerprint;
    };

    void clear() noexcept
    {
        m_entries.clear();
        m_serialized_object_count = 0;
        m_reused_object_count = 0;
#ifdef NEO_REAL_PROJECT_PROFILE
        m_profile_miss_missing = m_profile_miss_timestamp = m_profile_miss_ids = 0;
        m_profile_miss_fingerprint = m_profile_miss_mesh_size = m_profile_miss_mesh_owner = 0;
        m_profile_fingerprint_object = m_profile_fingerprint_volume_transform = 0;
        m_profile_fingerprint_volume_metadata = m_profile_fingerprint_instance_transform = 0;
        m_profile_fingerprint_instance_metadata = 0;
#endif
    }

    // A bridge mutation invalidates the affected stable object identity before
    // the successor root is captured. This is deliberately independent from
    // ModelConfig timestamps: transforms and other mutable object fields are
    // not all represented by that timestamp.
    void invalidate(ObjectID id) noexcept
    {
        m_entries.erase(id);
    }

    // Unknown or compound model mutations take the conservative path. Keep
    // diagnostics cumulative while dropping every reusable archive.
    void invalidate_all() noexcept
    {
        m_entries.clear();
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
                      const std::vector<ObjectID>& instance_ids,
                      const MutationFingerprint& mutation_fingerprint) const
    {
        const auto it = m_entries.find(id);
        if (it == m_entries.end()) {
#ifdef NEO_REAL_PROJECT_PROFILE
            ++m_profile_miss_missing;
#endif
            return nullptr;
        }
        if (it->second.timestamp != timestamp) {
#ifdef NEO_REAL_PROJECT_PROFILE
            ++m_profile_miss_timestamp;
#endif
            return nullptr;
        }
        if (it->second.volume_ids != volume_ids || it->second.instance_ids != instance_ids) {
#ifdef NEO_REAL_PROJECT_PROFILE
            ++m_profile_miss_ids;
#endif
            return nullptr;
        }
        if (!(it->second.mutation_fingerprint == mutation_fingerprint)) {
#ifdef NEO_REAL_PROJECT_PROFILE
            ++m_profile_miss_fingerprint;
            const auto& prior = it->second.mutation_fingerprint;
            if (prior.object_config_timestamp != mutation_fingerprint.object_config_timestamp ||
                prior.name != mutation_fingerprint.name || prior.module_name != mutation_fingerprint.module_name ||
                prior.input_file != mutation_fingerprint.input_file || prior.printable != mutation_fingerprint.printable)
                ++m_profile_fingerprint_object;
            for (std::size_t index = 0; index < std::min(prior.volumes.size(), mutation_fingerprint.volumes.size()); ++index) {
                if (prior.volumes[index].transform != mutation_fingerprint.volumes[index].transform)
                    ++m_profile_fingerprint_volume_transform;
                if (!(prior.volumes[index] == mutation_fingerprint.volumes[index]) &&
                    prior.volumes[index].transform == mutation_fingerprint.volumes[index].transform)
                    ++m_profile_fingerprint_volume_metadata;
            }
            for (std::size_t index = 0; index < std::min(prior.instances.size(), mutation_fingerprint.instances.size()); ++index) {
                if (prior.instances[index].transform != mutation_fingerprint.instances[index].transform ||
                    prior.instances[index].assemble_transform != mutation_fingerprint.instances[index].assemble_transform)
                    ++m_profile_fingerprint_instance_transform;
                if (!(prior.instances[index] == mutation_fingerprint.instances[index]) &&
                    prior.instances[index].transform == mutation_fingerprint.instances[index].transform &&
                    prior.instances[index].assemble_transform == mutation_fingerprint.instances[index].assemble_transform)
                    ++m_profile_fingerprint_instance_metadata;
            }
#endif
            return nullptr;
        }
        if (it->second.meshes.size() != meshes.size()) {
#ifdef NEO_REAL_PROJECT_PROFILE
            ++m_profile_miss_mesh_size;
#endif
            return nullptr;
        }
        std::owner_less<MeshPtr> owner_less;
        for (std::size_t index = 0; index < meshes.size(); ++index) {
            const auto& prior = it->second.meshes[index];
            if (!prior && !meshes[index]) continue;
            if (!prior || !meshes[index] || owner_less(prior, meshes[index]) || owner_less(meshes[index], prior)) {
#ifdef NEO_REAL_PROJECT_PROFILE
                ++m_profile_miss_mesh_owner;
#endif
                return nullptr;
            }
        }
        return it->second.bytes ? &it->second : nullptr;
    }

    void insert(ObjectID id, std::uint64_t timestamp, std::shared_ptr<const Bytes> bytes,
                const std::vector<MeshPtr>& meshes, std::vector<ObjectID> volume_ids,
                std::vector<ObjectID> instance_ids, MutationFingerprint mutation_fingerprint)
    {
        Entry entry;
        entry.timestamp = timestamp;
        entry.bytes = std::move(bytes);
        entry.volume_ids = std::move(volume_ids);
        entry.instance_ids = std::move(instance_ids);
        entry.mutation_fingerprint = std::move(mutation_fingerprint);
        entry.meshes.reserve(meshes.size());
        entry.meshes = meshes;
        m_entries[id] = std::move(entry);
        ++m_serialized_object_count;
    }

    // Seed from an already-authoritative timestamp root after restore. This
    // performs no serialization and therefore does not increment capture-work
    // counters.
    void prime(ObjectID id, std::uint64_t timestamp, std::shared_ptr<const Bytes> bytes,
               const std::vector<MeshPtr>& meshes, std::vector<ObjectID> volume_ids,
               std::vector<ObjectID> instance_ids, MutationFingerprint mutation_fingerprint)
    {
        Entry entry;
        entry.timestamp = timestamp;
        entry.bytes = std::move(bytes);
        entry.meshes = meshes;
        entry.volume_ids = std::move(volume_ids);
        entry.instance_ids = std::move(instance_ids);
        entry.mutation_fingerprint = std::move(mutation_fingerprint);
        m_entries[id] = std::move(entry);
    }

    void record_reuse() noexcept { ++m_reused_object_count; }
    std::size_t serialized_object_count() const noexcept { return m_serialized_object_count; }
    std::size_t reused_object_count() const noexcept { return m_reused_object_count; }
#ifdef NEO_REAL_PROJECT_PROFILE
    std::array<std::size_t, 6> profile_miss_counts() const noexcept
    {
        return {m_profile_miss_missing, m_profile_miss_timestamp, m_profile_miss_ids,
                m_profile_miss_fingerprint, m_profile_miss_mesh_size, m_profile_miss_mesh_owner};
    }
    std::array<std::size_t, 5> profile_fingerprint_miss_counts() const noexcept
    {
        return {m_profile_fingerprint_object, m_profile_fingerprint_volume_transform,
                m_profile_fingerprint_volume_metadata, m_profile_fingerprint_instance_transform,
                m_profile_fingerprint_instance_metadata};
    }
#endif

private:
    std::map<ObjectID, Entry> m_entries;
    std::size_t m_serialized_object_count { 0 };
    std::size_t m_reused_object_count { 0 };
#ifdef NEO_REAL_PROJECT_PROFILE
    mutable std::size_t m_profile_miss_missing { 0 };
    mutable std::size_t m_profile_miss_timestamp { 0 };
    mutable std::size_t m_profile_miss_ids { 0 };
    mutable std::size_t m_profile_miss_fingerprint { 0 };
    mutable std::size_t m_profile_miss_mesh_size { 0 };
    mutable std::size_t m_profile_miss_mesh_owner { 0 };
    mutable std::size_t m_profile_fingerprint_object { 0 };
    mutable std::size_t m_profile_fingerprint_volume_transform { 0 };
    mutable std::size_t m_profile_fingerprint_volume_metadata { 0 };
    mutable std::size_t m_profile_fingerprint_instance_transform { 0 };
    mutable std::size_t m_profile_fingerprint_instance_metadata { 0 };
#endif
};

} // namespace Slic3r::Neo::History::Codec
