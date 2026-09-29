#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
#include "libslic3r/Model.hpp"
#include "libslic3r/TriangleSelector.hpp"

namespace Slic3r::Neo::Painting {

// Each annotation channel will supply its own state and publication rules.
// MMU is the only implemented adapter; other channels never share its tree.
struct MmuAnnotationAdapter {
    static constexpr int max_state = 16;
    static void validate_state(int state);
    static void load(const ModelVolume& volume, TriangleSelector& selector);
};

struct PartDraft {
    std::size_t volume_id;
    // TriangleSelector keeps references into this immutable mesh. Declare the
    // owner first so selector destruction always precedes mesh destruction.
    std::shared_ptr<const TriangleMesh> mesh;
    std::unique_ptr<TriangleSelector> selector;
    Transform3d volume_transform;
    std::uint64_t annotation_timestamp;
    std::array<std::size_t, 17> facet_counts() const;
};

struct Session {
    std::uint64_t id;
    std::uint64_t history_session_id;
    std::uint64_t revision = 1;
    std::size_t object_id;
    std::size_t instance_id;
    Transform3d instance_transform;
    std::vector<PartDraft> parts;
    // Stroke identities are session-local monotonic integers. No tool sampling
    // or commit command is exposed by this lifecycle-only foundation.
    std::uint64_t next_stroke_id = 1;
    std::uint64_t active_stroke_id = 0;
};

class Sessions {
public:
    std::unique_ptr<Session> prepare_open(const Model& model, std::size_t object_id,
        std::size_t instance_id, std::size_t filament_slots, std::uint64_t history_session_id);
    std::unique_ptr<Session> prepare_target(const Model& model, std::uint64_t id,
        std::uint64_t revision, std::size_t object_id, std::size_t instance_id);
    const Session& require(std::uint64_t id, std::uint64_t revision) const;
    // Reject stale topology/annotation/transforms without ever dereferencing
    // pointers into a replaced Model. Later restore/remap integration rebuilds.
    void validate_target(const Model& model, const Session& session) const;
    void publish(std::unique_ptr<Session> candidate) noexcept { m_session.swap(candidate); }
    void reset() noexcept { m_session.reset(); }
    const Session* current() const noexcept { return m_session.get(); }
private:
    static void bind(Session& session, const Model& model, std::size_t object_id, std::size_t instance_id);
    std::uint64_t m_next_id = 1; // Never reset when a project is replaced.
    std::unique_ptr<Session> m_session;
};

} // namespace Slic3r::Neo::Painting
