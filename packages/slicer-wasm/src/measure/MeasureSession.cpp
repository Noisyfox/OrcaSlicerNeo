#include "MeasureSession.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
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

struct PlaneChunk {
    indexed_triangle_set mesh;
    std::unique_ptr<AABBMesh> acceleration;
};

struct PlaneCache { std::vector<std::unique_ptr<PlaneChunk>> chunks; };

struct GripperMesh {
    indexed_triangle_set mesh;
    std::unique_ptr<AABBMesh> acceleration;
};

const GripperMesh& sphere_gripper()
{
    static const auto result = [] {
        auto shape = std::make_unique<GripperMesh>();
        constexpr int count = 16;
        const float sector_step = float(2. * PI / count), stack_step = float(PI / count);
        for (int i = 0; i <= count; ++i) {
            const double angle = .5 * PI - stack_step * i;
            const double xy = 7.5 * std::cos(angle), z = 7.5 * std::sin(angle);
            if (i == 0 || i == count) shape->mesh.vertices.emplace_back(float(xy), 0.f, float(z));
            else for (int j = 0; j < count; ++j) {
                const double sector = sector_step * j;
                shape->mesh.vertices.emplace_back(float(xy * std::cos(sector)), float(xy * std::sin(sector)), float(z));
            }
        }
        for (int i = 0; i < count; ++i) {
            int first = i == 0 ? 0 : 1 + (i - 1) * count;
            int second = i == 0 ? 1 : first + count;
            const int first_start = first, second_start = second;
            for (int j = 0; j < count; ++j) {
                int next_first = first, next_second = second;
                if (i != 0) {
                    next_first = j + 1 == count ? first_start : first + 1;
                    shape->mesh.indices.emplace_back(first, second, next_first);
                }
                if (i + 1 != count) {
                    next_second = j + 1 == count ? second_start : second + 1;
                    shape->mesh.indices.emplace_back(next_first, second, next_second);
                }
                first = next_first; second = next_second;
            }
        }
        shape->acceleration = std::make_unique<AABBMesh>(shape->mesh);
        return shape;
    }();
    return *result;
}

const GripperMesh& cylinder_gripper()
{
    static const auto result = [] {
        auto shape = std::make_unique<GripperMesh>();
        constexpr int count = 16;
        const float step = float(2. * PI / count);
        for (int i = 0; i < count; ++i) {
            const float angle = step * i;
            const Vec3f point(5.f * std::cos(angle), 5.f * std::sin(angle), 0.f);
            shape->mesh.vertices.push_back(point);
            shape->mesh.vertices.push_back(point + Vec3f::UnitZ());
        }
        for (int i = 0; i < count; ++i) {
            const int a = i * 2, b = ((i + 1) % count) * 2;
            shape->mesh.indices.emplace_back(a, b, b + 1);
            shape->mesh.indices.emplace_back(a, b + 1, a + 1);
        }
        const int bottom = int(shape->mesh.vertices.size());
        shape->mesh.vertices.emplace_back(0.f, 0.f, 0.f);
        const int top = int(shape->mesh.vertices.size());
        shape->mesh.vertices.emplace_back(0.f, 0.f, 1.f);
        for (int i = 0; i < count; ++i) {
            const int a = i * 2, b = ((i + 1) % count) * 2;
            shape->mesh.indices.emplace_back(bottom, b, a);
            shape->mesh.indices.emplace_back(top, a + 1, b + 1);
        }
        shape->acceleration = std::make_unique<AABBMesh>(shape->mesh);
        return shape;
    }();
    return *result;
}

struct TorusCache {
    Measure::SurfaceFeature feature;
    float thickness;
    GripperMesh shape;
    TorusCache(const Feature& source, float width) : feature(source.surface), thickness(width) {
        const auto [center_double, radius_double, normal_double] = feature.get_circle();
        const Vec3f center = center_double.cast<float>(), normal = normal_double.cast<float>();
        const float radius = float(radius_double);
        constexpr int sectors = 64, sections = 16;
        const float sector_step = 2.f * float(PI) / float(sectors), section_step = 2.f * float(PI) / float(sections);
        const Eigen::Quaternionf rotation = Eigen::Quaternionf::FromTwoVectors(Vec3f::UnitZ(), normal);
        for (int i = 0; i < sectors; ++i) {
            const float angle = sector_step * i;
            const Vec3f radial(std::cos(angle), std::sin(angle), 0.f);
            const Vec3f local_center = radius * radial;
            const Vec3f section_center = center + rotation * local_center;
            const Vec3f section_normal = (rotation * local_center.normalized().cross(Vec3f::UnitZ()).normalized()).normalized();
            const Vec3f base = thickness * radial;
            for (int j = 0; j < sections; ++j)
                shape.mesh.vertices.push_back(section_center + Eigen::AngleAxisf(section_step * j, section_normal) * base);
        }
        for (int i = 0; i < sectors; ++i) for (int j = 0; j < sections; ++j) {
            const int a = i * sections + j, b = ((i + 1) % sectors) * sections + j;
            const int c = ((i + 1) % sectors) * sections + (j + 1) % sections;
            const int d = i * sections + (j + 1) % sections;
            shape.mesh.indices.emplace_back(a, b, c);
            shape.mesh.indices.emplace_back(a, c, d);
        }
        shape.acceleration = std::make_unique<AABBMesh>(shape.mesh);
    }
};

struct MeshCache {
    // The acceleration borrows its mesh, so it must be destroyed before the
    // geometry releases the source mesh. Both are shared by sibling instances.
    std::shared_ptr<Geometry> geometry;
    AABBMesh acceleration;
    std::map<int, std::unique_ptr<PlaneCache>> planes;
    std::vector<std::unique_ptr<TorusCache>> circles;
    explicit MeshCache(std::shared_ptr<const TriangleMesh> mesh)
        : geometry(Geometry::create(mesh)), acceleration(*mesh) {}

    const AABBMesh& circle(const Feature& feature, double pixel_scale) {
        const float thickness = float(5. * pixel_scale);
        for (const auto& cached : circles) {
            if (cached->thickness == thickness && cached->feature.get_pt1() == feature.surface.get_pt1() &&
                cached->feature.get_pt2() == feature.surface.get_pt2() && cached->feature.get_value() == feature.surface.get_value())
                return *cached->shape.acceleration;
        }
        auto candidate = std::make_unique<TorusCache>(feature, thickness);
        if (circles.size() == 3) circles.erase(circles.begin());
        circles.push_back(std::move(candidate));
        return *circles.back()->shape.acceleration;
    }

    const PlaneCache& plane(const Feature& feature) {
        const int index = std::get<0>(feature.surface.get_plane());
        auto found = planes.find(index);
        if (found != planes.end()) return *found->second;
        auto candidate = std::make_unique<PlaneCache>();
        const auto& source = geometry->mesh()->its;
        const auto& facets = *feature.surface.plane_indices;
        // Chunk the expanded overlay so its local int32 indices never impose
        // a global triangle limit on the selected plane.
        constexpr std::size_t chunk_size = 65536;
        for (std::size_t begin = 0; begin < facets.size(); begin += chunk_size) {
            const auto end = std::min(begin + chunk_size, facets.size());
            auto chunk = std::make_unique<PlaneChunk>();
            chunk->mesh.vertices.reserve((end - begin) * 3);
            chunk->mesh.indices.reserve(end - begin);
            for (std::size_t i = begin; i < end; ++i) {
                const auto triangle = source.indices[facets[i]];
                Vec3f a = source.vertices[triangle[0]], b = source.vertices[triangle[1]], c = source.vertices[triangle[2]];
                const Vec3f normal = (b - a).cross(c - a).normalized();
                // GLGizmoMeasure offsets each source triangle in local space.
                a += normal * .05f; b += normal * .05f; c += normal * .05f;
                const auto first = std::int32_t(chunk->mesh.vertices.size());
                chunk->mesh.vertices.insert(chunk->mesh.vertices.end(), {a, b, c});
                chunk->mesh.indices.emplace_back(first, first + 1, first + 2);
            }
            chunk->acceleration = std::make_unique<AABBMesh>(chunk->mesh);
            candidate->chunks.push_back(std::move(chunk));
        }
        auto inserted = planes.emplace(index, std::move(candidate));
        return *inserted.first->second;
    }
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

struct PointerRay {
    Vec3d origin;
    Vec3d direction;
    double length;
    Eigen::Matrix4d camera;
    Eigen::Matrix4d inverse_camera;
};

std::optional<PointerRay> pointer_ray(const PointerEvent& event)
{
    if (!event.pointer.allFinite() || !event.viewport.allFinite() || event.viewport.z() <= 0 || event.viewport.w() <= 0)
        throw std::invalid_argument("invalid measurement pointer/viewport");
    inverse_checked(event.projection);
    inverse_checked(event.view);
    if (!event.view.row(3).isApprox(Eigen::RowVector4d(0, 0, 0, 1)))
        throw std::invalid_argument("measurement view must be affine");
    const Eigen::Matrix4d camera = event.projection * event.view;
    const auto inverse = inverse_checked(camera);
    const double right = event.viewport.x() + event.viewport.z(), bottom = event.viewport.y() + event.viewport.w();
    if (!std::isfinite(right) || !std::isfinite(bottom)) throw std::invalid_argument("invalid measurement viewport extent");
    if (event.pointer.x() < event.viewport.x() || event.pointer.x() > right ||
        event.pointer.y() < event.viewport.y() || event.pointer.y() > bottom) return std::nullopt;
    const double x = 2 * (event.pointer.x() - event.viewport.x()) / event.viewport.z() - 1;
    const double y = 1 - 2 * (event.pointer.y() - event.viewport.y()) / event.viewport.w();
    const Vec3d origin = unproject(inverse, Eigen::Vector4d(x, y, -1, 1));
    const Vec3d far = unproject(inverse, Eigen::Vector4d(x, y, 1, 1));
    const double length = (far - origin).norm();
    if (!std::isfinite(length) || length <= 1e-12) throw std::invalid_argument("degenerate measurement ray");
    return PointerRay{origin, (far - origin) / length, length, camera, inverse};
}

std::optional<double> pixel_scale(const PointerRay& ray, const PointerEvent& event, const Vec3d& world)
{
    const Eigen::Vector4d clip = ray.camera * Eigen::Vector4d(world.x(), world.y(), world.z(), 1);
    if (!clip.allFinite()) throw std::invalid_argument("invalid measurement display projection");
    if (clip.w() <= 1e-15) return std::nullopt;
    const Vec3d ndc = clip.head<3>() / clip.w();
    const Vec3d adjacent = unproject(ray.inverse_camera, Eigen::Vector4d(ndc.x(), ndc.y() + 2. / event.viewport.w(), ndc.z(), 1));
    const double scale = (adjacent - world).norm();
    if (!std::isfinite(scale) || scale <= 0) throw std::invalid_argument("invalid measurement display projection");
    return scale;
}

struct ShapeHit { Vec3d local; Vec3d world; double distance; };

std::optional<ShapeHit> shape_hit(const AABBMesh& shape, const Transform3d& transform, const PointerRay& ray)
{
    const Transform3d inverse(inverse_checked(transform.matrix()));
    const Vec3d origin = inverse * ray.origin;
    const Vec3d direction = inverse.linear() * ray.direction;
    const double scale = direction.norm();
    if (!std::isfinite(scale) || scale <= 0) throw std::invalid_argument("degenerate measurement gripper ray");
    const auto hit = shape.query_ray_hit(origin, direction / scale);
    const double distance = hit.distance() / scale;
    if (!hit.is_hit() || distance < 0 || distance > ray.length) return std::nullopt;
    // MeshRaycaster publishes the local hit as Vec3f before the GUI uses it.
    const Vec3d local = hit.position().cast<float>().cast<double>(), world = transform * local;
    if (!local.allFinite() || !world.allFinite()) throw std::invalid_argument("invalid measurement intersection");
    return ShapeHit{local, world, distance};
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

bool Session::contains_object(std::size_t object) const
{
    return std::any_of(m_targets.begin(), m_targets.end(), [object](const auto& target) { return target->id.object == object; });
}

bool Session::contains_instance(std::size_t object, std::size_t instance) const
{
    return std::any_of(m_targets.begin(), m_targets.end(), [object, instance](const auto& target) {
        return target->id.object == object && target->id.instance == instance;
    });
}

bool Session::contains_volume(std::size_t volume) const
{
    return std::any_of(m_targets.begin(), m_targets.end(), [volume](const auto& target) { return target->id.volume == volume; });
}

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

std::unique_ptr<Session> Session::rebase_after_scale(const Model& model) const
{
    ModelLookup lookup(model);
    auto next = std::unique_ptr<Session>(new Session());
    next->m_targets.reserve(m_targets.size());
    for (const auto& target : m_targets) {
        const auto resolved = lookup.resolve(target->id);
        if (resolved.volume->mesh_ptr() != target->mesh->geometry->mesh())
            throw std::invalid_argument("measurement source mesh is stale");
        next->m_targets.push_back(std::make_unique<Target>(Target{target->id, resolved.instance->get_matrix(),
            resolved.volume->get_matrix(), target->mesh}));
    }
    next->m_selection = std::make_unique<SelectionState>(*m_selection);
    auto reproject = [&](std::optional<SelectionItem>& item) {
        if (!item) return;
        for (const auto& target : next->m_targets) {
            if (!(target->id == item->target)) continue;
            const Transform3d transform = target->instance_transform * target->volume_transform;
            item->source = target->mesh->geometry->reproject(item->source, transform);
            item->value = target->mesh->geometry->reproject(item->value, transform);
            return;
        }
        throw std::invalid_argument("measurement feature target is stale");
    };
    reproject(next->m_selection->m_first);
    reproject(next->m_selection->m_second);
    return next;
}

std::unique_ptr<SelectionState> Session::prepare_selection(const Model& model) const
{
    validate(model);
    return std::make_unique<SelectionState>(*m_selection);
}

std::unique_ptr<SelectionState> Session::prepare_choose(const Model& model, SelectionItem item) const
{
    validate(model);
    const auto& target = require_source(item.target, item.source);
    if (item.value.geometry != target.mesh->geometry)
        throw std::invalid_argument("measurement feature is stale");
    auto candidate = std::make_unique<SelectionState>(*m_selection);
    candidate->choose(std::move(item));
    return candidate;
}

void Session::choose(const Model& model, SelectionItem item)
{
    publish_selection(prepare_choose(model, std::move(item)));
}

const Session::Target& Session::require_source(const TargetId& id, const Feature& source) const
{
    for (const auto& target : m_targets) {
        if (!(target->id == id)) continue;
        const Transform3d transform = target->instance_transform * target->volume_transform;
        if (source.geometry != target->mesh->geometry || source.surface.world_tran.matrix() != transform.matrix())
            throw std::invalid_argument("measurement feature is stale");
        return *target;
    }
    throw std::invalid_argument("measurement feature target is stale");
}

DisplaySnapshot Session::capture_display(const Model& model, const std::optional<MeshPick>& hover) const
{
    validate(model);
    if (hover && hover->feature) require_source(hover->target, *hover->feature);
    return {*m_selection, hover};
}

std::vector<Marker> Session::markers(const Model& model, const std::optional<MeshPick>& hover) const
{
    return markers_for(model, *m_selection, hover);
}

std::vector<Marker> Session::markers(const Model& model, const DisplaySnapshot& display) const
{
    return markers_for(model, display.selection, display.hover);
}

std::vector<Marker> Session::markers_for(const Model& model, const SelectionState& selection,
    const std::optional<MeshPick>& hover) const
{
    validate(model);
    std::vector<Marker> result;
    auto add = [&](SelectionItem item) {
        for (const auto& marker : result) if (same_item(marker.item, item)) return;
        const Vec3d position = item.value.surface.get_point();
        result.push_back({std::move(item), position});
    };
    auto add_source = [&](const TargetId& target, const Feature& source) {
        const auto type = source.surface.get_type();
        if (type == Measure::SurfaceFeatureType::Point) add(feature_item(target, source));
        else if (type == Measure::SurfaceFeatureType::Circle) add(center_item(target, source));
        else if (type == Measure::SurfaceFeatureType::Edge) {
            if (source.surface.get_extra_point()) add(center_item(target, source));
            add(midpoint_item(target, source));
        }
    };
    auto add_selection = [&](const std::optional<SelectionItem>& item) {
        if (!item) return;
        const auto& target = require_source(item->target, item->source);
        if (item->value.geometry != target.mesh->geometry)
            throw std::invalid_argument("measurement feature is stale");
        if (item->value.surface.get_type() == Measure::SurfaceFeatureType::Point) add(*item);
        if (item->kind != SelectionKind::PointOnFeature) add_source(item->target, item->source);
    };
    add_selection(selection.first());
    add_selection(selection.second());
    if (hover && hover->feature) {
        require_source(hover->target, *hover->feature);
        add_source(hover->target, *hover->feature);
    }
    return result;
}

std::optional<MarkerHit> Session::pick_marker(const Model& model, const PointerEvent& event,
    const std::optional<MeshPick>& hover, std::optional<std::size_t> preferred) const
{
    return pick_marker_for(model, event, *m_selection, hover, preferred);
}

std::optional<MarkerHit> Session::pick_marker_for(const Model& model, const PointerEvent& event,
    const SelectionState& selection, const std::optional<MeshPick>& hover, std::optional<std::size_t> preferred) const
{
    const auto candidates = markers_for(model, selection, hover);
    if (preferred && *preferred >= candidates.size()) throw std::invalid_argument("measurement marker is stale");
    const auto ray = pointer_ray(event);
    if (!ray) return std::nullopt;
    std::optional<MarkerHit> closest;
    bool preferred_hit = !preferred;
    for (std::size_t i = 0; i < candidates.size(); ++i) {
        const auto& marker = candidates[i];
        const auto scale = pixel_scale(*ray, event, marker.position);
        if (!scale) continue;
        Transform3d transform = Transform3d::Identity();
        transform.translate(marker.position); transform.scale(*scale);
        const auto hit = shape_hit(*sphere_gripper().acceleration, transform, *ray);
        if (!hit) continue;
        if (preferred && *preferred == i) preferred_hit = true;
        if (!closest || hit->distance < closest->distance - 1e-9 ||
            (std::abs(hit->distance - closest->distance) < 1e-9 && preferred && *preferred == i))
            closest = MarkerHit{i, marker, hit->distance};
    }
    return preferred_hit ? closest : std::nullopt;
}

std::optional<GripperHit> Session::pick_gripper(const Model& model, const PointerEvent& event,
    const std::optional<MeshPick>& hover) const
{
    return pick_gripper_for(model, event, *m_selection, hover);
}

std::optional<GripperHit> Session::pick_gripper_for(const Model& model, const PointerEvent& event,
    const SelectionState& selection, const std::optional<MeshPick>& hover) const
{
    validate(model);
    const auto ray = pointer_ray(event);
    if (!ray) {
        for (const auto& target : m_targets) inverse_checked((target->instance_transform * target->volume_transform).matrix());
        return std::nullopt;
    }
    struct Source { TargetId target; Feature feature; };
    std::vector<Source> sources;
    auto add = [&](const TargetId& target, const Feature& feature) {
        for (const auto& source : sources)
            if (source.target == target && source.feature.surface == feature.surface) return;
        require_source(target, feature);
        sources.push_back({target, feature});
    };
    auto selected = [&](const std::optional<SelectionItem>& item) {
        if (item && item->kind == SelectionKind::Feature) add(item->target, item->source);
    };
    selected(selection.first()); selected(selection.second());
    if (hover && hover->feature) add(hover->target, *hover->feature);

    std::optional<GripperHit> closest;
    auto consider = [&](const Source& source, const Vec3d& point, double distance) {
        if (!closest || distance < closest->distance)
            closest = GripperHit{source.target, source.feature, point, distance};
    };
    for (const auto& source : sources) {
        const auto type = source.feature.surface.get_type();
        if (type == Measure::SurfaceFeatureType::Edge) {
            const auto [from, to] = source.feature.surface.get_edge();
            auto scale = pixel_scale(*ray, event, (from + to) * .5);
            if (!scale) scale = pixel_scale(*ray, event, from);
            if (!scale) scale = pixel_scale(*ray, event, to);
            if (!scale) continue;
            const Vec3d direction = to - from;
            Transform3d transform = Transform3d::Identity();
            transform.translate(from);
            transform.rotate(Eigen::Quaterniond::FromTwoVectors(Vec3d::UnitZ(), direction));
            transform.scale(Vec3d(*scale, *scale, direction.norm()));
            if (const auto hit = shape_hit(*cylinder_gripper().acceleration, transform, *ray))
                consider(source, transform * Vec3d(0, 0, hit->local.z()), hit->distance);
        } else if (type == Measure::SurfaceFeatureType::Circle) {
            const auto [center, radius, normal] = source.feature.surface.get_circle();
            const auto scale = pixel_scale(*ray, event, center);
            if (!scale) continue;
            const auto& target = require_source(source.target, source.feature);
            const auto hit = shape_hit(target.mesh->circle(source.feature, *scale), Transform3d::Identity(), *ray);
            if (!hit) continue;
            const Eigen::Quaterniond rotation = Eigen::Quaterniond::FromTwoVectors(Vec3d::UnitZ(), normal);
            const Vec3d relative = hit->world - center;
            const Vec3d projected = relative - relative.dot(normal) * normal;
            const Vec3d local = rotation.conjugate() * projected;
            const double angle = std::atan2(local.y(), local.x());
            consider(source, center + rotation * (radius * Vec3d(std::cos(angle), std::sin(angle), 0)), hit->distance);
        } else if (type == Measure::SurfaceFeatureType::Plane) {
            const auto& target = require_source(source.target, source.feature);
            const Transform3d transform = target.instance_transform * target.volume_transform;
            for (const auto& chunk : target.mesh->plane(source.feature).chunks) {
                if (const auto hit = shape_hit(*chunk->acceleration, transform, *ray))
                    consider(source, hit->world, hit->distance);
            }
        }
    }
    return closest;
}

std::optional<InteractionHit> Session::pick(const Model& model, const PointerEvent& event,
    const std::optional<MeshPick>& hover, std::optional<std::size_t> preferred_marker) const
{
    return pick_display(model, event, capture_display(model, hover), preferred_marker);
}

std::optional<InteractionHit> Session::pick_display(const Model& model, const PointerEvent& event,
    const DisplaySnapshot& display, std::optional<std::size_t> preferred_marker) const
{
    // Displayed markers and grippers are checked against this press before
    // source-mesh picking, as in Orca. This also avoids extracting an
    // unrelated mesh feature merely to select an off-mesh marker.
    auto marker_hit = pick_marker_for(model, event, display.selection, display.hover, preferred_marker);
    // A renderer-provided marker identity must actually be hit at this press.
    // Never fall through to an unrelated gripper when its hint is stale.
    if (preferred_marker && !marker_hit) return std::nullopt;
    auto gripper = pick_gripper_for(model, event, display.selection, display.hover);
    if (marker_hit && (!gripper || marker_hit->distance <= gripper->distance)) return InteractionHit{std::move(*marker_hit)};
    if (gripper) return InteractionHit{std::move(*gripper)};

    // A newly hit feature is derived from this press, not the last hover.
    auto mesh = pick_mesh(model, event);
    if (mesh && mesh->feature) {
        // Point features use a sphere gripper rather than the edge/circle/plane
        // shapes handled by pick_gripper. A click can arrive before a hover
        // response, so also test the newly found point against this press.
        if (mesh->feature->surface.get_type() == Measure::SurfaceFeatureType::Point) {
            if (auto fresh_marker = pick_marker_for(model, event, display.selection, mesh, std::nullopt))
                return InteractionHit{std::move(*fresh_marker)};
        }
        auto fresh = pick_gripper_for(model, event, display.selection, mesh);
        if (fresh) return InteractionHit{std::move(*fresh)};
    }
    if (mesh) return InteractionHit{std::move(*mesh)};
    return std::nullopt;
}

std::optional<MeshPick> Session::pick_mesh(const Model& model, const PointerEvent& event) const
{
    validate(model);
    const auto ray = pointer_ray(event);
    if (!ray) {
        for (const auto& target : m_targets) inverse_checked((target->instance_transform * target->volume_transform).matrix());
        return std::nullopt;
    }
    const Target* closest = nullptr;
    int facet = -1;
    Vec3d local = Vec3d::Zero(), world = Vec3d::Zero();
    double distance = ray->length;
    for (const auto& target : m_targets) {
        const Transform3d transform = target->instance_transform * target->volume_transform;
        const Transform3d inverse_transform(inverse_checked(transform.matrix()));
        const Vec3d local_origin = inverse_transform * ray->origin;
        const Vec3d local_direction = inverse_transform.linear() * ray->direction;
        const double local_scale = local_direction.norm();
        if (!std::isfinite(local_scale) || local_scale <= 0) throw std::invalid_argument("degenerate measurement target ray");
        const auto hits = target->mesh->acceleration.query_ray_hits(local_origin, local_direction / local_scale);
        std::size_t first = 0;
        while (first < hits.size() && (transform * hits[first].position()).z() < SINKING_Z_THRESHOLD) ++first;
        // GLGizmoMeasure uses MeshRaycaster::unproject_on_mesh: after the bed
        // filter, an unpaired entry/exit hit is not a selectable mesh hit.
        if (first == hits.size() || (hits.size() - first) % 2 != 0) continue;
        const auto& hit = hits[first];
        const double world_distance = hit.distance() / local_scale;
        if (hit.is_hit() && world_distance >= 0 && world_distance <= distance) {
            distance = world_distance;
            local = hit.position().cast<float>().cast<double>(); world = transform * local;
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
