#pragma once

#include <memory>
#include <optional>
#include <variant>
#include <vector>

#include "MeasureGeometry.hpp"
#include "libslic3r/Model.hpp"

namespace Slic3r::Neo::Measurement {

struct TargetId {
    std::size_t object;
    std::size_t instance;
    std::size_t volume;
    bool operator==(const TargetId& other) const {
        return object == other.object && instance == other.instance && volume == other.volume;
    }
};

// Column-major camera matrices and top-left CSS-pixel pointer/viewport,
// matching the existing native painting picker.
struct PointerEvent {
    Vec2d pointer = Vec2d::Zero();
    Eigen::Vector4d viewport = Eigen::Vector4d(0, 0, 1, 1);
    Eigen::Matrix4d projection = Eigen::Matrix4d::Identity();
    Eigen::Matrix4d view = Eigen::Matrix4d::Identity();
};

struct MeshPick {
    TargetId target;
    int original_facet;
    Vec3d local;
    Vec3d world;
    std::optional<Feature> feature;
};

enum class SelectionKind { Feature, Center, Midpoint, PointOnFeature };

struct SelectionItem {
    TargetId target;
    Feature source;
    Feature value;
    SelectionKind kind;
};

struct Marker {
    SelectionItem item;
    Vec3d position;
};

struct MarkerHit {
    std::size_t index;
    Marker marker;
    double distance;
};

struct GripperHit {
    TargetId target;
    Feature source;
    Vec3d point_on_feature;
    double distance;
};

using InteractionHit = std::variant<MarkerHit, GripperHit, MeshPick>;

SelectionItem feature_item(TargetId target, Feature source);
SelectionItem center_item(TargetId target, Feature source);
SelectionItem midpoint_item(TargetId target, Feature source);
SelectionItem point_item(TargetId target, Feature source, const Vec3d& world_point);

class SelectionState {
public:
    const std::optional<SelectionItem>& first() const { return m_first; }
    const std::optional<SelectionItem>& second() const { return m_second; }
    void choose(SelectionItem item);
    void clear_first();
    void clear_second() { m_second.reset(); }
    void clear() { m_first.reset(); m_second.reset(); }
    // Returns false only when the caller should close an already-empty tool.
    bool escape();
    bool same_target() const;
    std::optional<Measure::MeasurementResult> result() const;
private:
    friend class Session;
    std::optional<SelectionItem> m_first;
    std::optional<SelectionItem> m_second;
};

// A mesh pick is only one part of Measure picking: visible feature grippers and
// off-mesh center/midpoint markers require their own hit tests in the session
// interaction layer. This class never treats a mesh miss as a marker miss.
class Session {
public:
    Session(const Model& model, const std::vector<TargetId>& targets);
    ~Session();
    Session(const Session&) = delete;
    Session& operator=(const Session&) = delete;

    std::size_t target_count() const { return m_targets.size(); }
    void validate(const Model& model) const;
    // A scale edit stages new transforms and features while retaining the
    // immutable source caches; ordinary stale target edits remain rejected.
    std::unique_ptr<Session> rebase_after_scale(const Model& model) const;
    std::optional<MeshPick> pick_mesh(const Model& model, const PointerEvent& event) const;
    std::vector<Marker> markers(const Model& model, const std::optional<MeshPick>& hover = std::nullopt) const;
    std::optional<MarkerHit> pick_marker(const Model& model, const PointerEvent& event,
        const std::optional<MeshPick>& hover = std::nullopt, std::optional<std::size_t> preferred = std::nullopt) const;
    std::optional<GripperHit> pick_gripper(const Model& model, const PointerEvent& event,
        const std::optional<MeshPick>& hover = std::nullopt) const;
    std::optional<InteractionHit> pick(const Model& model, const PointerEvent& event,
        const std::optional<MeshPick>& hover = std::nullopt, std::optional<std::size_t> preferred_marker = std::nullopt) const;
    const SelectionState& selection() const { return *m_selection; }
    // Prepare selection changes before allocating a bridge response. Publishing
    // the prepared state is a no-throw swap, so failed requests leave it intact.
    std::unique_ptr<SelectionState> prepare_selection(const Model& model) const;
    std::unique_ptr<SelectionState> prepare_choose(const Model& model, SelectionItem item) const;
    void publish_selection(std::unique_ptr<SelectionState> candidate) noexcept { m_selection.swap(candidate); }
    void choose(const Model& model, SelectionItem item);
    void clear_first() { m_selection->clear_first(); }
    void clear_second() { m_selection->clear_second(); }
    void clear_selection() { m_selection->clear(); }
    bool escape() { return m_selection->escape(); }

private:
    Session() = default;
    struct Target;
    const Target& require_source(const TargetId& id, const Feature& source) const;
    std::vector<std::unique_ptr<Target>> m_targets;
    std::unique_ptr<SelectionState> m_selection = std::make_unique<SelectionState>();
};

} // namespace Slic3r::Neo::Measurement
