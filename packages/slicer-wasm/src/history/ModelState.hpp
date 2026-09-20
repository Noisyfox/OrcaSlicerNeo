#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace Slic3r {
class TriangleMesh;
}

namespace Slic3r::Neo::History {

using Bytes = std::vector<std::uint8_t>;
using ObjectID = std::uint64_t;

struct MutableObject {
    using Transform = std::array<double, 16>;

    ObjectID id { 0 };
    // A non-zero timestamp is an optional fast path for callers that already
    // know an object's content did not change.  The bytes remain authoritative.
    std::uint64_t timestamp { 0 };
    // Object archives are immutable once captured. Sharing the payload is
    // essential: a timestamp root contains a complete object manifest, but
    // unchanged objects must not copy their cereal archive on every capture.
    std::shared_ptr<const Bytes> data;
    // ModelVolume's native undo archive omits ObjectBase. Retain the ordered
    // IDs separately so restore can reapply them after materialization.
    std::vector<ObjectID> volume_ids;
    // ModelInstance's native undo archive also omits ObjectBase. Preserve the
    // ordered native IDs so the bridge can reapply them after add_instance()
    // materializes the complete object graph.
    std::vector<ObjectID> instance_ids;
    // Transform-only edits are represented as a sparse overlay on the
    // immutable object archive. The archive remains a complete canonical
    // fallback for every other mutable field; restore reapplies these exact
    // matrices after deserializing it.
    std::vector<Transform> volume_transforms;
    std::vector<Transform> instance_transforms;
};

// Immutable native mesh ownership shared by identity across history roots.
struct ImmutableMesh {
    std::string key;
    std::shared_ptr<const ::Slic3r::TriangleMesh> native;
    // The adapter measures the complete native type; history stays headless.
    std::size_t native_bytes { 0 };
};

// The serialized model manifest and ObjectID-keyed immutable object archives
// together form one complete model root.
struct ModelState {
    Bytes serialized;
    std::vector<MutableObject> mutable_objects;
    std::vector<ImmutableMesh> immutable_meshes;
};

enum class JumpDirection : std::uint8_t { Undo, Redo };

} // namespace Slic3r::Neo::History
