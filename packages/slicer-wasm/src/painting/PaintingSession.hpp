#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
#include <optional>
#include "libslic3r/Model.hpp"
#include "libslic3r/AABBMesh.hpp"
#include "NativeSelector.hpp"

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
    std::shared_ptr<NativeSelector> selector;
    Transform3d volume_transform;
    std::uint64_t annotation_timestamp;
    std::shared_ptr<const AABBMesh> acceleration;
    std::uint64_t geometry_revision = 1;
    std::array<std::size_t, 17> facet_counts() const;
};

enum class Tool { Circle, Sphere, Triangle, Height, Region, Gap, EraseAll };
enum class Phase { Idle, Drawing, Finished };
struct Settings {
    int state = 1;
    bool erase = false;
    double radius = 2.;
    double height = 1.;
    std::optional<double> angle = 30.; // nullopt disables geometry edge detection.
    double gap_area = 0.;
    void validate() const;
};
// Matrices are OpenGL column-major, pointer and viewport use the same CSS-pixel
// coordinate system, origin at top left; clip-space depth is [-1,1].
struct PointerEvent {
    Vec2d pointer = Vec2d::Zero();
    Eigen::Vector4d viewport = Eigen::Vector4d(0, 0, 1, 1);
    Eigen::Matrix4d projection = Eigen::Matrix4d::Identity();
    Eigen::Matrix4d view = Eigen::Matrix4d::Identity();
};
struct Hit {
    std::size_t part;
    int original_facet;
    Vec3d local;
    Vec3d world;
    Vec3d ray_origin;
};
struct Preview {
    Tool tool;
    Settings settings;
    std::optional<Hit> hit;
    std::vector<std::shared_ptr<NativeSelector>> selectors;
    // TriangleSelectorGUI keeps seed membership/contours distinct from paint
    // colour. Retain that selection even when the prospective colour is NONE
    // or already assigned; stage07 can derive its display without reselecting.
    std::shared_ptr<const NativeSelector> region_selection;
    // Leaf IDs refer to the unchanged Session::parts selectors, not the
    // prospective selectors above. Gap fragments remain separately inspectable.
    std::vector<std::vector<NativeSelector::GapPatch>> gap_regions;
};

struct Session {
    std::uint64_t id;
    std::uint64_t history_session_id;
    std::uint64_t revision = 1;
    std::size_t object_id;
    std::size_t instance_id;
    Transform3d instance_transform;
    std::vector<PartDraft> parts;
    std::uint64_t next_stroke_id = 1;
    std::uint64_t active_stroke_id = 0;
    Phase phase = Phase::Idle;
    Tool tool = Tool::Circle;
    std::vector<std::shared_ptr<NativeSelector>> before_stroke;
    std::shared_ptr<const std::vector<TriangleSelector::TriangleSplittingData>> before_data;
    std::optional<PointerEvent> last_event;
    std::optional<Hit> last_hit;
    std::optional<Preview> preview;
    bool effective = false;
    std::vector<std::size_t> changed_parts;
};

class Sessions {
public:
    std::unique_ptr<Session> prepare_open(const Model& model, std::size_t object_id,
        std::size_t instance_id, std::size_t filament_slots, std::uint64_t history_session_id);
    std::unique_ptr<Session> prepare_target(const Model& model, std::uint64_t id,
        std::uint64_t revision, std::size_t object_id, std::size_t instance_id);
    const Session& require(std::uint64_t id, std::uint64_t revision, bool idle_only = true) const;
    std::optional<Hit> pick(const Session& session, const PointerEvent& event) const;
    std::unique_ptr<Session> prepare_begin(std::uint64_t id, std::uint64_t revision, Tool tool,
        const Settings& settings, const std::optional<PointerEvent>& event, std::optional<std::uint64_t> candidate_revision = {});
    std::unique_ptr<Session> prepare_sample(std::uint64_t id, std::uint64_t revision, std::uint64_t stroke,
        const Settings& settings, const PointerEvent& event);
    std::unique_ptr<Session> prepare_finish(std::uint64_t id, std::uint64_t revision, std::uint64_t stroke);
    std::unique_ptr<Session> prepare_cancel(std::uint64_t id, std::uint64_t revision, std::uint64_t stroke);
    std::unique_ptr<Session> prepare_preview(std::uint64_t id, std::uint64_t revision, Tool tool,
        const Settings& settings, const std::optional<PointerEvent>& event);
    // Reject stale topology/annotation/transforms without ever dereferencing
    // pointers into a replaced Model. Later restore/remap integration rebuilds.
    void validate_target(const Model& model, const Session& session) const;
    void publish(std::unique_ptr<Session> candidate) noexcept { m_session.swap(candidate); }
    void update_geometry_revisions(Session& candidate) const;
    std::unique_ptr<Session> prepare_commit(std::uint64_t id, std::uint64_t revision, std::uint64_t stroke,
        const std::optional<Settings>& settings, const std::optional<PointerEvent>& event);
    std::unique_ptr<Session> prepare_reconcile(const Model& model);
    static void complete(Session& session) noexcept;
    void discard_pending() noexcept;
    void reset() noexcept { m_session.reset(); }
    const Session* current() const noexcept { return m_session.get(); }
private:
    static std::unique_ptr<Session> stage(const Session& session);
    void sample(Session& session, const Settings& settings, const PointerEvent& event);
    static void apply_hit(Session& session, const Settings& settings, const Hit& hit, const std::optional<Hit>& previous, std::vector<bool>& touched);
    static void compare(Session& session, const std::vector<bool>& touched);
    static void bind(Session& session, const Model& model, std::size_t object_id, std::size_t instance_id);
    std::uint64_t m_next_id = 1; // Never reset when a project is replaced.
    std::unique_ptr<Session> m_session;
};

} // namespace Slic3r::Neo::Painting
