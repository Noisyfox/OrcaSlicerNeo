#include "MeasureSession.hpp"

#include <cmath>
#include <map>
#include <set>
#include <stdexcept>
#include <tuple>
#include <unordered_map>
#include <Eigen/LU>
#include "libslic3r/AABBMesh.hpp"

namespace Slic3r::Neo::Measurement {
namespace {
struct ResolvedTarget {
    const ModelInstance* instance;
    const ModelVolume* volume;
};

class ModelLookup {
    struct Object {
        const ModelObject* model;
        bool indexed = false;
        std::unordered_map<std::size_t, const ModelInstance*> instances;
        std::unordered_map<std::size_t, const ModelVolume*> volumes;
    };
    std::unordered_map<std::size_t, Object> m_objects;
public:
    explicit ModelLookup(const Model& model) {
        m_objects.reserve(model.objects.size());
        for (const auto* object : model.objects) m_objects.emplace(object->id().id, Object{object});
    }
    ResolvedTarget resolve(const TargetId& id) {
        auto found = m_objects.find(id.object);
        if (found == m_objects.end()) throw std::invalid_argument("measurement object is stale");
        auto& object = found->second;
        if (!object.indexed) {
            object.instances.reserve(object.model->instances.size());
            object.volumes.reserve(object.model->volumes.size());
            for (const auto* instance : object.model->instances) object.instances.emplace(instance->id().id, instance);
            for (const auto* volume : object.model->volumes) object.volumes.emplace(volume->id().id, volume);
            object.indexed = true;
        }
        const auto instance = object.instances.find(id.instance);
        if (instance == object.instances.end()) throw std::invalid_argument("measurement instance is stale");
        const auto volume = object.volumes.find(id.volume);
        if (volume == object.volumes.end()) throw std::invalid_argument("measurement volume is stale");
        return {instance->second, volume->second};
    }
};

struct MeshCache {
    // The acceleration borrows its mesh, so it must be destroyed before the
    // geometry releases the source mesh. Both are shared by sibling instances.
    std::shared_ptr<Geometry> geometry;
    AABBMesh acceleration;
    explicit MeshCache(std::shared_ptr<const TriangleMesh> mesh)
        : geometry(Geometry::create(mesh)), acceleration(*mesh) {}
};

Eigen::Matrix4d inverse_checked(const Eigen::Matrix4d& matrix)
{
    if (!matrix.allFinite()) throw std::invalid_argument("measurement matrix is not finite");
    Eigen::FullPivLU<Eigen::Matrix4d> lu(matrix);
    if (!lu.isInvertible()) throw std::invalid_argument("measurement matrix is singular");
    auto inverse = lu.inverse().eval();
    if (!inverse.allFinite()) throw std::invalid_argument("measurement inverse is not finite");
    return inverse;
}

Vec3d unproject(const Eigen::Matrix4d& inverse, const Eigen::Vector4d& clip)
{
    const Eigen::Vector4d point = inverse * clip;
    if (!point.allFinite() || std::abs(point.w()) < 1e-15) throw std::invalid_argument("invalid measurement camera projection");
    const Vec3d result = point.head<3>() / point.w();
    if (!result.allFinite()) throw std::invalid_argument("invalid measurement camera projection");
    return result;
}

Feature point_feature(const Feature& source, const Vec3d& world_point)
{
    Measure::SurfaceFeature point(world_point);
    point.world_tran = source.surface.world_tran;
    point.volume = source.surface.volume;
    const Transform3d inverse(inverse_checked(source.surface.world_tran.matrix()));
    point.origin_surface_feature = std::make_shared<Measure::SurfaceFeature>(inverse * world_point);
    return {source.geometry, std::move(point)};
}

bool marker(SelectionKind kind) { return kind == SelectionKind::Center || kind == SelectionKind::Midpoint; }

bool same_source(const SelectionItem& a, const SelectionItem& b)
{
    return a.target == b.target && a.source.surface == b.source.surface;
}

bool same_item(const SelectionItem& a, const SelectionItem& b)
{
    // Orca compares source and selected features rather than distinguishing a
    // regular point from the same point selected with Shift. Neo distinguishes
    // the two marker types even when their positions happen to coincide.
    const bool same_kind = a.kind == b.kind || (!marker(a.kind) && !marker(b.kind));
    return same_kind && same_source(a, b) && a.value.surface == b.value.surface;
}
}

SelectionItem feature_item(TargetId target, Feature source)
{
    auto value = source;
    return {target, std::move(source), std::move(value), SelectionKind::Feature};
}

SelectionItem center_item(TargetId target, Feature source)
{
    Vec3d center;
    if (source.surface.get_type() == Measure::SurfaceFeatureType::Circle)
        center = std::get<0>(source.surface.get_circle());
    else if (source.surface.get_type() == Measure::SurfaceFeatureType::Edge && source.surface.get_extra_point())
        center = *source.surface.get_extra_point();
    else
        throw std::invalid_argument("measurement feature has no center");
    auto value = point_feature(source, center);
    // Preserve the exact source-space center for later transform updates.
    if (source.surface.origin_surface_feature) {
        const auto& origin = *source.surface.origin_surface_feature;
        if (origin.get_type() == Measure::SurfaceFeatureType::Circle)
            value.surface.origin_surface_feature = std::make_shared<Measure::SurfaceFeature>(std::get<0>(origin.get_circle()));
        else if (origin.get_type() == Measure::SurfaceFeatureType::Edge && origin.get_extra_point())
            value.surface.origin_surface_feature = std::make_shared<Measure::SurfaceFeature>(*origin.get_extra_point());
    }
    return {target, std::move(source), std::move(value), SelectionKind::Center};
}

SelectionItem midpoint_item(TargetId target, Feature source)
{
    auto value = edge_midpoint(source);
    return {target, std::move(source), std::move(value), SelectionKind::Midpoint};
}

SelectionItem point_item(TargetId target, Feature source, const Vec3d& world_point)
{
    auto value = point_feature(source, world_point);
    return {target, std::move(source), std::move(value), SelectionKind::PointOnFeature};
}

void SelectionState::choose(SelectionItem item)
{
    if (!m_first) { m_first = std::move(item); return; }
    if (same_item(*m_first, item)) { clear_first(); return; }
    if (m_second && same_item(*m_second, item)) { clear_second(); return; }

    // Center and midpoint markers retain their source identity. Switching
    // between a source and either marker updates that source's own slot.
    auto replace_source = [&](std::optional<SelectionItem>& existing) {
        if (!existing || !same_source(*existing, item)) return false;
        if ((marker(item.kind) && existing->kind != SelectionKind::PointOnFeature) ||
            (item.kind == SelectionKind::Feature && marker(existing->kind))) {
            existing = std::move(item);
            return true;
        }
        return false;
    };
    if (replace_source(m_first) || replace_source(m_second)) return;
    m_second = std::move(item);
}

void SelectionState::clear_first()
{
    m_first = std::move(m_second);
    m_second.reset();
}

bool SelectionState::escape()
{
    if (m_second) { m_second.reset(); return true; }
    if (m_first) { m_first.reset(); return true; }
    return false;
}

bool SelectionState::same_target() const
{
    return m_first && (!m_second || m_first->target == m_second->target);
}

std::optional<Measure::MeasurementResult> SelectionState::result() const
{
    if (!m_first) return std::nullopt;
    if (m_second) return measurement(m_first->value, m_second->value);
    return measurement(m_first->value);
}

struct Session::Target {
    TargetId id;
    Transform3d instance_transform;
    Transform3d volume_transform;
    std::shared_ptr<MeshCache> mesh;
};

Session::Session(const Model& model, const std::vector<TargetId>& targets)
{
    if (targets.empty()) throw std::invalid_argument("measurement has no targets");
    std::set<std::tuple<std::size_t, std::size_t, std::size_t>> seen;
    std::map<const TriangleMesh*, std::shared_ptr<MeshCache>> cache;
    ModelLookup lookup(model);
    m_targets.reserve(targets.size());
    for (const auto& id : targets) {
        if (!seen.emplace(id.object, id.instance, id.volume).second)
            throw std::invalid_argument("duplicate measurement target");
        const auto resolved = lookup.resolve(id);
        auto source = resolved.volume->mesh_ptr();
        if (!source || source->its.indices.empty()) throw std::invalid_argument("measurement target has no mesh");
        auto& shared = cache[source.get()];
        if (!shared) shared = std::make_shared<MeshCache>(std::move(source));
        m_targets.push_back(std::make_unique<Target>(Target{id, resolved.instance->get_matrix(),
            resolved.volume->get_matrix(), shared}));
    }
}

Session::~Session() = default;

void Session::validate(const Model& model) const
{
    ModelLookup lookup(model);
    for (const auto& target : m_targets) {
        const auto resolved = lookup.resolve(target->id);
        if (resolved.instance->get_matrix().matrix() != target->instance_transform.matrix() ||
            resolved.volume->get_matrix().matrix() != target->volume_transform.matrix() ||
            resolved.volume->mesh_ptr() != target->mesh->geometry->mesh())
            throw std::invalid_argument("measurement target is stale");
    }
}

void Session::choose(const Model& model, SelectionItem item)
{
    validate(model);
    for (const auto& target : m_targets) {
        if (!(target->id == item.target)) continue;
        const Transform3d transform = target->instance_transform * target->volume_transform;
        if (item.source.geometry != target->mesh->geometry || item.value.geometry != target->mesh->geometry ||
            item.source.surface.world_tran.matrix() != transform.matrix())
            throw std::invalid_argument("measurement feature is stale");
        m_selection.choose(std::move(item));
        return;
    }
    throw std::invalid_argument("measurement feature target is stale");
}

std::optional<MeshPick> Session::pick_mesh(const Model& model, const PointerEvent& event) const
{
    validate(model);
    if (!event.pointer.allFinite() || !event.viewport.allFinite() || event.viewport.z() <= 0 || event.viewport.w() <= 0)
        throw std::invalid_argument("invalid measurement pointer/viewport");
    inverse_checked(event.projection);
    inverse_checked(event.view);
    if (!event.view.row(3).isApprox(Eigen::RowVector4d(0, 0, 0, 1)))
        throw std::invalid_argument("measurement view must be affine");
    const auto inverse = inverse_checked(event.projection * event.view);
    const double right = event.viewport.x() + event.viewport.z(), bottom = event.viewport.y() + event.viewport.w();
    if (!std::isfinite(right) || !std::isfinite(bottom)) throw std::invalid_argument("invalid measurement viewport extent");
    if (event.pointer.x() < event.viewport.x() || event.pointer.x() > right ||
        event.pointer.y() < event.viewport.y() || event.pointer.y() > bottom) {
        for (const auto& target : m_targets) inverse_checked((target->instance_transform * target->volume_transform).matrix());
        return std::nullopt;
    }
    const double x = 2 * (event.pointer.x() - event.viewport.x()) / event.viewport.z() - 1;
    const double y = 1 - 2 * (event.pointer.y() - event.viewport.y()) / event.viewport.w();
    const Vec3d origin = unproject(inverse, Eigen::Vector4d(x, y, -1, 1));
    const Vec3d far = unproject(inverse, Eigen::Vector4d(x, y, 1, 1));
    const double length = (far - origin).norm();
    if (!std::isfinite(length) || length <= 1e-12) throw std::invalid_argument("degenerate measurement ray");
    const Vec3d direction = (far - origin) / length;
    const Target* closest = nullptr;
    int facet = -1;
    Vec3d local = Vec3d::Zero(), world = Vec3d::Zero();
    double distance = length;
    for (const auto& target : m_targets) {
        const Transform3d transform = target->instance_transform * target->volume_transform;
        const Transform3d inverse_transform(inverse_checked(transform.matrix()));
        const Vec3d local_origin = inverse_transform * origin;
        const Vec3d local_direction = inverse_transform.linear() * direction;
        const double local_scale = local_direction.norm();
        if (!std::isfinite(local_scale) || local_scale <= 0) throw std::invalid_argument("degenerate measurement target ray");
        const auto hit = target->mesh->acceleration.query_ray_hit(local_origin, local_direction / local_scale);
        const double world_distance = hit.distance() / local_scale;
        if (hit.is_hit() && world_distance >= 0 && world_distance <= distance) {
            distance = world_distance;
            local = hit.position(); world = transform * local;
            if (!local.allFinite() || !world.allFinite()) throw std::invalid_argument("invalid measurement intersection");
            closest = target.get(); facet = hit.face();
        }
    }
    if (!closest) return std::nullopt;
    const Transform3d transform = closest->instance_transform * closest->volume_transform;
    return MeshPick{closest->id, facet, local, world,
        closest->mesh->geometry->feature(std::size_t(facet), local, transform)};
}

} // namespace Slic3r::Neo::Measurement
