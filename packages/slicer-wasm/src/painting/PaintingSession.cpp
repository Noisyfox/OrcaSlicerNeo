#include "PaintingSession.hpp"
#include <limits>
#include <stdexcept>
#include <cmath>
#include <Eigen/LU>
#include "PaintingProfile.hpp"

namespace Slic3r::Neo::Painting {

void MmuAnnotationAdapter::validate_state(int state)
{
    if (state < 0 || state > max_state) throw std::invalid_argument("painting state must be in 0..16");
}

void MmuAnnotationAdapter::load(const ModelVolume& volume, TriangleSelector& selector)
{
    const auto& data = volume.mmu_segmentation_facets.get_data();
    for (const auto state : TriangleSelector::extract_used_facet_states(data))
        validate_state(static_cast<int>(state));
    selector.deserialize(data, true, EnforcerBlockerType::ExtruderMax);
}

std::array<std::size_t, 17> PartDraft::facet_counts() const
{
    std::array<std::size_t, 17> counts{};
    for (int state = 0; state <= MmuAnnotationAdapter::max_state; ++state)
        counts[state] = selector->num_facets(static_cast<EnforcerBlockerType>(state));
    return counts;
}

void Sessions::bind(Session& session, const Model& model, std::size_t object_id, std::size_t instance_id)
{
    const ModelObject* object = nullptr;
    for (const auto* candidate : model.objects)
        if (candidate->id().id == object_id) { object = candidate; break; }
    if (!object) throw std::invalid_argument("painting object is unavailable");
    const ModelInstance* instance = nullptr;
    for (const auto* candidate : object->instances)
        if (candidate->id().id == instance_id) { instance = candidate; break; }
    if (!instance) throw std::invalid_argument("painting instance does not belong to object");
    session.object_id = object_id;
    session.instance_id = instance_id;
    session.instance_transform = instance->get_matrix();
    for (const auto* volume : object->volumes) {
        if (!volume->is_model_part()) continue;
        auto mesh = volume->mesh_ptr();
        if (!mesh || mesh->its.indices.empty()) continue;
        auto selector = std::make_shared<NativeSelector>(*mesh);
        MmuAnnotationAdapter::load(*volume, *selector);
        auto acceleration = std::make_shared<AABBMesh>(*mesh);
        session.parts.push_back({volume->id().id, std::move(mesh), std::move(selector),
            volume->get_matrix(), volume->mmu_segmentation_facets.timestamp(), std::move(acceleration), session.revision});
    }
    if (session.parts.empty()) throw std::invalid_argument("painting object has no solid mesh parts");
}

std::unique_ptr<Session> Sessions::prepare_open(const Model& model, std::size_t object_id,
    std::size_t instance_id, std::size_t filament_slots, std::uint64_t history_session_id)
{
    if (m_session) throw std::logic_error("painting session is already active");
    if (filament_slots < 2) throw std::invalid_argument("painting activation requires at least two filament slots");
    if (!history_session_id) throw std::invalid_argument("painting requires an active history session");
    if (m_next_id == std::numeric_limits<std::uint64_t>::max()) throw std::overflow_error("painting session IDs exhausted");
    auto candidate = std::make_unique<Session>();
    candidate->id = m_next_id++;
    candidate->history_session_id = history_session_id;
    bind(*candidate, model, object_id, instance_id);
    return candidate;
}

const Session& Sessions::require(std::uint64_t id, std::uint64_t revision, bool idle_only) const
{
    if (!m_session || m_session->id != id) throw std::invalid_argument("painting session is stale");
    if (m_session->revision != revision) throw std::invalid_argument("painting revision is stale");
    if (idle_only && m_session->phase != Phase::Idle) throw std::logic_error("painting stroke is busy or awaiting publication/discard");
    return *m_session;
}

void Settings::validate() const
{
    MmuAnnotationAdapter::validate_state(state);
    if (!std::isfinite(radius) || radius <= 0 || radius > std::numeric_limits<float>::max() ||
        !std::isfinite(height) || height <= 0 || height > std::numeric_limits<float>::max())
        throw std::invalid_argument("painting radius and height must be positive finite millimetres");
    const float radius_squared = float(radius) * float(radius);
    if (!std::isfinite(radius_squared) || radius_squared <= 0 || float(height) <= 0)
        throw std::invalid_argument("painting size is outside native selector precision");
    if (angle && (!std::isfinite(*angle) || *angle < 0 || *angle > 90))
        throw std::invalid_argument("painting angle must be 0..90 or null");
    if (!std::isfinite(gap_area) || gap_area < 0 || gap_area > 5)
        throw std::invalid_argument("painting gap area must be 0..5");
}

namespace {
Eigen::Matrix4d inverse_checked(const Eigen::Matrix4d& matrix)
{
    if (!matrix.allFinite()) throw std::invalid_argument("painting matrix is not finite");
    Eigen::FullPivLU<Eigen::Matrix4d> lu(matrix);
    if (!lu.isInvertible()) throw std::invalid_argument("painting matrix is singular");
    auto inverse = lu.inverse().eval();
    if (!inverse.allFinite()) throw std::invalid_argument("painting inverse is not finite");
    return inverse;
}
Vec3d unproject(const Eigen::Matrix4d& inverse, const Eigen::Vector4d& clip)
{
    const Eigen::Vector4d point = inverse * clip;
    if (!point.allFinite() || std::abs(point.w()) < 1e-15) throw std::invalid_argument("invalid painting camera projection");
    const Vec3d result = point.head<3>() / point.w();
    if (!result.allFinite()) throw std::invalid_argument("invalid painting camera projection");
    return result;
}
void require_stroke(const Session& session, std::uint64_t stroke, bool finished_allowed = false)
{
    if (!stroke || stroke != session.active_stroke_id || session.phase == Phase::Idle ||
        (!finished_allowed && session.phase != Phase::Drawing))
        throw std::invalid_argument("painting stroke is stale or finished");
}
}

std::optional<Hit> Sessions::pick(const Session& session, const PointerEvent& event) const
{
#ifdef NEO_PAINTING_PROFILE
    Profile::Scope profile_hit(Profile::hit);
#endif
    if (!event.pointer.allFinite() || !event.viewport.allFinite() || event.viewport.z() <= 0 || event.viewport.w() <= 0)
        throw std::invalid_argument("invalid painting pointer/viewport");
    // Validate both matrices independently, including a malformed view whose
    // product with projection could otherwise hide an invalid affine camera.
    inverse_checked(event.projection);
    inverse_checked(event.view);
    if (!event.view.row(3).isApprox(Eigen::RowVector4d(0, 0, 0, 1)))
        throw std::invalid_argument("painting view must be affine");
    const auto inverse = inverse_checked(event.projection * event.view);
    const double right = event.viewport.x() + event.viewport.z(), bottom = event.viewport.y() + event.viewport.w();
    if (!std::isfinite(right) || !std::isfinite(bottom)) throw std::invalid_argument("invalid painting viewport extent");
    if (event.pointer.x() < event.viewport.x() || event.pointer.x() > right ||
        event.pointer.y() < event.viewport.y() || event.pointer.y() > bottom) {
        for (const auto& part : session.parts) inverse_checked((session.instance_transform * part.volume_transform).matrix());
        return {};
    }
    const double x = 2 * (event.pointer.x() - event.viewport.x()) / event.viewport.z() - 1;
    const double y = 1 - 2 * (event.pointer.y() - event.viewport.y()) / event.viewport.w();
    const Vec3d origin = unproject(inverse, Eigen::Vector4d(x, y, -1, 1));
    const Vec3d far = unproject(inverse, Eigen::Vector4d(x, y, 1, 1));
    const double length = (far - origin).norm();
    if (!std::isfinite(length) || length <= 1e-12) throw std::invalid_argument("degenerate painting ray");
    const Vec3d direction = (far - origin) / length;
    std::optional<Hit> closest;
    double distance = length;
    // Validate every eligible transform before accepting a hit/miss. A broken
    // part cannot silently disappear from authoritative nearest-hit picking.
    for (std::size_t i = 0; i < session.parts.size(); ++i) {
        const auto& part = session.parts[i];
        const Transform3d transform = session.instance_transform * part.volume_transform;
        Transform3d inverse_transform(inverse_checked(transform.matrix()));
        const Vec3d local_origin = inverse_transform * origin;
        const Vec3d local_direction = inverse_transform.linear() * direction;
        const double local_scale = local_direction.norm();
        if (!std::isfinite(local_scale) || local_scale <= 0) throw std::invalid_argument("degenerate painting part ray");
        const auto hit = part.acceleration->query_ray_hit(local_origin, local_direction / local_scale);
        const double world_distance = hit.distance() / local_scale;
        if (hit.is_hit() && world_distance >= 0 && world_distance <= distance) {
            distance = world_distance;
            const Vec3d world = transform * hit.position();
            if (!world.allFinite() || !hit.position().allFinite()) throw std::invalid_argument("invalid painting intersection");
            closest = Hit{i, hit.face(), hit.position(), world, origin};
        }
    }
    if (x < -1 || x > 1 || y < -1 || y > 1) return {};
    return closest;
}

std::unique_ptr<Session> Sessions::stage(const Session& session)
{
    if (session.revision >= 9007199254740991ULL) throw std::overflow_error("painting revision exhausted");
    auto result = std::make_unique<Session>(session);
    ++result->revision;
    return result;
}

void Sessions::apply_hit(Session& session, const Settings& settings, const Hit& hit, const std::optional<Hit>& previous, std::vector<bool>& touched)
{
#ifdef NEO_PAINTING_PROFILE
    Profile::Scope profile_selector(Profile::selector);
#endif
    const auto state = static_cast<EnforcerBlockerType>(settings.erase ? 0 : settings.state);
    const TriangleSelector::ClippingPlane clipping;
    const std::size_t begin = session.tool == Tool::Height ? 0 : hit.part;
    const std::size_t end = session.tool == Tool::Height ? session.parts.size() : hit.part + 1;
    for (std::size_t i = begin; i < end; ++i) {
        auto& part = session.parts[i];
        if (!touched[i]) {
            part.selector = part.selector->clone();
            touched[i] = true;
        }
        const Transform3d transform = session.instance_transform * part.volume_transform;
        const Transform3d inverse = transform.inverse();
        Transform3d linear = transform; linear.translation().setZero();
        // Near-plane ray origin, rather than camera position, also supplies the
        // correct parallel direction for an orthographic camera.
        const Vec3f source = (inverse * hit.ray_origin).cast<float>();
        if (session.tool == Tool::Triangle || session.tool == Tool::Region) {
            part.selector->bucket_fill_select_triangles(hit.local.cast<float>(), hit.original_facet,
                clipping, session.tool == Tool::Region && settings.angle ? float(*settings.angle) : -1.f,
                session.tool == Tool::Region, true);
            part.selector->seed_fill_apply_on_triangles(state);
        } else if (session.tool == Tool::Height) {
            auto cursor = TriangleSelector::SinglePointCursor::cursor_factory(float(hit.world.z()), source,
                float(settings.height), transform, clipping);
            part.selector->select_patch(0, std::move(cursor), state, linear, true);
        } else {
            const auto type = session.tool == Tool::Circle ? TriangleSelector::CIRCLE : TriangleSelector::SPHERE;
            std::unique_ptr<TriangleSelector::Cursor> cursor;
            if (previous && previous->part == hit.part && (previous->local - hit.local).squaredNorm() > 1e-14)
                cursor = TriangleSelector::DoublePointCursor::cursor_factory(previous->local.cast<float>(),
                    hit.local.cast<float>(), source, float(settings.radius), type, transform, clipping);
            else cursor = TriangleSelector::SinglePointCursor::cursor_factory(hit.local.cast<float>(), source,
                float(settings.radius), type, transform, clipping);
            part.selector->select_patch(hit.original_facet, std::move(cursor), state, linear, true);
        }
    }
}

void Sessions::sample(Session& session, const Settings& settings, const PointerEvent& event)
{
    settings.validate();
    const auto endpoint = pick(session, event); // Reject malformed inputs before any staged work.
    if (session.last_event && (session.last_event->view != event.view || session.last_event->projection != event.projection ||
        session.last_event->viewport != event.viewport)) throw std::invalid_argument("painting camera changed during stroke");
    if (!endpoint) {
        // Captured pointer events routinely leave the viewport. A miss is a
        // continuity break, not an unbounded screen-space interpolation job.
        session.last_event = event; session.last_hit.reset(); session.preview.reset();
        return;
    }
    std::vector<bool> touched(session.parts.size(), false);
    // Orca projects a sequence at one-pixel spacing before using its capsule
    // cursor between neighboring hits. Reconstruct those rays natively; an
    // empty-space crossing or part change always breaks capsule continuity.
    const Vec2d start = session.last_event && session.last_hit ? session.last_event->pointer : event.pointer;
    const double steps_value = std::ceil((event.pointer - start).norm());
    if (!std::isfinite(steps_value) || steps_value >= double(std::numeric_limits<std::size_t>::max())) throw std::invalid_argument("painting trajectory is too large");
    const std::size_t steps = std::max<std::size_t>(1, std::size_t(steps_value));
    auto previous = session.last_hit;
    for (std::size_t index = 1; index <= steps; ++index) {
        auto intermediate = event;
        intermediate.pointer = start + (event.pointer - start) * (double(index) / double(steps));
        auto hit = index == steps ? endpoint : pick(session, intermediate);
        if (hit) apply_hit(session, settings, *hit, previous, touched);
        previous = hit;
    }
    session.last_event = event;
    session.last_hit = endpoint;
    session.preview.reset();
    if (session.tool == Tool::Triangle) {
        // Orca POINTER leaves the current native leaf selected after each
        // admitted sample. Keep flags isolated from draft annotation topology.
        auto selected = session.parts[endpoint->part].selector->clone();
        selected->bucket_fill_select_triangles(endpoint->local.cast<float>(), endpoint->original_facet, {}, -1.f, false, true);
        Preview preview{Tool::Triangle, settings, endpoint, {}, std::move(selected), {}};
        for (const auto& part : session.parts) preview.selectors.push_back(part.selector);
        session.preview = std::move(preview);
    }
    compare(session, touched);
}

void Sessions::compare(Session& session, const std::vector<bool>& touched)
{
    for (std::size_t i = 0; i < session.parts.size(); ++i) {
        if (!touched[i]) continue;
        const auto volume_id = session.parts[i].volume_id;
        auto found = std::find(session.changed_parts.begin(), session.changed_parts.end(), volume_id);
        const bool changed = !(session.parts[i].selector->serialize() == (*session.before_data)[i]);
        if (changed && found == session.changed_parts.end()) session.changed_parts.push_back(volume_id);
        else if (!changed && found != session.changed_parts.end()) session.changed_parts.erase(found);
    }
    session.effective = !session.changed_parts.empty();
}

std::unique_ptr<Session> Sessions::prepare_begin(std::uint64_t id, std::uint64_t revision, Tool tool,
    const Settings& settings, const std::optional<PointerEvent>& event, std::optional<std::uint64_t> candidate_revision)
{
    const auto& current = require(id, revision);
    settings.validate();
    if ((tool == Tool::Gap || tool == Tool::EraseAll) == bool(event)) throw std::invalid_argument("painting tool event mismatch");
    if (candidate_revision && (*candidate_revision != revision || !current.preview || current.preview->tool != tool))
        throw std::invalid_argument("painting candidate is stale");
    if (tool == Tool::Gap && !candidate_revision) throw std::invalid_argument("gap Apply requires a current candidate");
    if (candidate_revision) {
        const auto& saved = current.preview->settings;
        if (saved.state != settings.state || saved.erase != settings.erase || saved.angle != settings.angle || saved.gap_area != settings.gap_area)
            throw std::invalid_argument("painting candidate settings changed");
        if (event) {
            const auto hit = pick(current, *event);
            if (bool(hit) != bool(current.preview->hit) || (hit && (hit->part != current.preview->hit->part ||
                hit->original_facet != current.preview->hit->original_facet || !hit->local.isApprox(current.preview->hit->local))))
                throw std::invalid_argument("painting candidate pointer changed");
        }
    }
    auto next = stage(current);
    if (next->next_stroke_id >= 9007199254740991ULL) throw std::overflow_error("painting stroke IDs exhausted");
    next->active_stroke_id = next->next_stroke_id++;
    next->phase = Phase::Drawing;
    next->tool = tool;
    next->effective = false;
    next->before_stroke.clear();
    auto before_data = std::make_shared<std::vector<TriangleSelector::TriangleSplittingData>>();
    next->changed_parts.clear();
    for (const auto& part : current.parts) {
        next->before_stroke.push_back(part.selector);
        before_data->push_back(part.selector->serialize());
    }
    next->before_data = std::move(before_data);
    next->last_event.reset(); next->last_hit.reset();
    if (tool == Tool::Gap) {
        for (std::size_t i = 0; i < next->parts.size(); ++i) next->parts[i].selector = current.preview->selectors[i];
        next->phase = Phase::Finished;
        compare(*next, std::vector<bool>(next->parts.size(), true));
    } else if (tool == Tool::EraseAll) {
#ifdef NEO_PAINTING_PROFILE
        Profile::Scope profile_selector(Profile::selector);
#endif
        for (auto& part : next->parts) part.selector = std::make_shared<NativeSelector>(*part.mesh);
        next->phase = Phase::Finished;
        compare(*next, std::vector<bool>(next->parts.size(), true));
    } else sample(*next, settings, *event);
    if (tool != Tool::Triangle) next->preview.reset();
    return next;
}

std::unique_ptr<Session> Sessions::prepare_sample(std::uint64_t id, std::uint64_t revision, std::uint64_t stroke,
    const Settings& settings, const PointerEvent& event)
{
    const auto& current = require(id, revision, false);
    require_stroke(current, stroke);
    auto next = stage(current);
    sample(*next, settings, event);
    return next;
}

std::unique_ptr<Session> Sessions::prepare_finish(std::uint64_t id, std::uint64_t revision, std::uint64_t stroke)
{
    const auto& current = require(id, revision, false);
    require_stroke(current, stroke);
    auto next = stage(current);
    next->phase = Phase::Finished;
    // Even a no-op remains explicitly pending, so a host cannot accidentally
    // treat an uncertain terminal response as a newly admitted stroke.
    return next;
}

std::unique_ptr<Session> Sessions::prepare_cancel(std::uint64_t id, std::uint64_t revision, std::uint64_t stroke)
{
    const auto& current = require(id, revision, false);
    require_stroke(current, stroke, true);
    auto next = stage(current);
    for (std::size_t i = 0; i < next->parts.size(); ++i) next->parts[i].selector = next->before_stroke[i];
    next->before_stroke.clear(); next->before_data.reset(); next->changed_parts.clear();
    next->preview.reset(); next->last_event.reset(); next->last_hit.reset();
    next->phase = Phase::Idle; next->active_stroke_id = 0; next->effective = false;
    return next;
}

std::unique_ptr<Session> Sessions::prepare_preview(std::uint64_t id, std::uint64_t revision, Tool tool,
    const Settings& settings, const std::optional<PointerEvent>& event)
{
    const auto& current = require(id, revision);
    settings.validate();
    if (tool != Tool::Triangle && tool != Tool::Region && tool != Tool::Gap) throw std::invalid_argument("painting tool has no candidate preview");
    if ((tool != Tool::Gap) != bool(event)) throw std::invalid_argument("painting preview event mismatch");
    auto next = stage(current);
    const auto hit = event ? pick(current, *event) : std::optional<Hit>{};
    // Candidate selectors are isolated from the authoritative draft as well as
    // Model annotations. Replacing a hover discards the previous candidate.
    Session work = current;
    work.tool = tool;
    Preview preview{tool, settings, hit, {}, {}, {}};
    if (tool == Tool::Gap) for (auto& part : work.parts) {
#ifdef NEO_PAINTING_PROFILE
        Profile::Scope profile_selector(Profile::selector);
#endif
        // Reconstruct before collecting leaf IDs; deserialization may renumber
        // leaves after prior garbage collection.
        part.selector = part.selector->clone();
        auto patches = part.selector->gap_candidates(settings.gap_area);
        // Keep a stable source selector for future fragment geometry extraction.
        // IDs are instead mapped to the current part below by independent analysis.
        preview.gap_regions.push_back(current.parts[preview.gap_regions.size()].selector->gap_candidates(settings.gap_area));
        part.selector->apply_gaps(patches);
    }
    else if (hit) {
        auto selected = current.parts[hit->part].selector->clone();
        {
#ifdef NEO_PAINTING_PROFILE
        Profile::Scope profile_region(Profile::selector);
#endif
        selected->bucket_fill_select_triangles(hit->local.cast<float>(), hit->original_facet, {},
            tool == Tool::Region && settings.angle ? float(*settings.angle) : -1.f, tool == Tool::Region, true);
        }
        preview.facet_selection = std::move(selected);
        std::vector<bool> touched(work.parts.size(), false);
        if (tool == Tool::Region) apply_hit(work, settings, *hit, {}, touched);
    }
    for (auto& part : work.parts) preview.selectors.push_back(std::move(part.selector));
    next->preview = std::move(preview);
    return next;
}

std::unique_ptr<Session> Sessions::prepare_target(const Model& model, std::uint64_t id,
    std::uint64_t revision, std::size_t object_id, std::size_t instance_id)
{
    const auto& previous = require(id, revision);
    if (revision == std::numeric_limits<std::uint64_t>::max()) throw std::overflow_error("painting revision exhausted");
    auto candidate = std::make_unique<Session>();
    candidate->id = previous.id;
    candidate->history_session_id = previous.history_session_id;
    candidate->revision = revision + 1;
    candidate->next_stroke_id = previous.next_stroke_id;
    bind(*candidate, model, object_id, instance_id);
    return candidate;
}

void Sessions::validate_target(const Model& model, const Session& session) const
{
    const ModelObject* object = nullptr;
    for (const auto* candidate : model.objects)
        if (candidate->id().id == session.object_id) { object = candidate; break; }
    if (!object) throw std::invalid_argument("painting target is stale");
    bool instance_matches = false;
    for (const auto* instance : object->instances)
        if (instance->id().id == session.instance_id && instance->get_matrix().matrix() == session.instance_transform.matrix())
            instance_matches = true;
    if (!instance_matches) throw std::invalid_argument("painting instance is stale");
    std::size_t index = 0;
    for (const auto* volume : object->volumes) {
        if (!volume->is_model_part() || volume->mesh().its.indices.empty()) continue;
        if (index >= session.parts.size()) throw std::invalid_argument("painting parts are stale");
        const auto& part = session.parts[index++];
        if (volume->id().id != part.volume_id || volume->mesh_ptr() != part.mesh ||
            volume->mmu_segmentation_facets.timestamp() != part.annotation_timestamp ||
            volume->get_matrix().matrix() != part.volume_transform.matrix())
            throw std::invalid_argument("painting part is stale");
    }
    if (index != session.parts.size()) throw std::invalid_argument("painting parts are stale");
}

void Sessions::update_geometry_revisions(Session& candidate) const
{
    if (!m_session || m_session->id != candidate.id) return;
    for (auto& part : candidate.parts) {
        const auto found = std::find_if(m_session->parts.begin(), m_session->parts.end(),
            [&](const auto& old) { return old.volume_id == part.volume_id; });
        if (found == m_session->parts.end()) continue;
        part.geometry_revision = found->geometry_revision;
        if (part.mesh != found->mesh || (part.selector != found->selector && !(part.selector->serialize() == found->selector->serialize())))
            part.geometry_revision = candidate.revision;
    }
}
void Sessions::discard_pending() noexcept
{
    if (!m_session || m_session->phase == Phase::Idle) return;
    ++m_session->revision;
    for (std::size_t i = 0; i < m_session->parts.size(); ++i) {
        if (m_session->parts[i].selector != m_session->before_stroke[i])
            m_session->parts[i].geometry_revision = m_session->revision;
        m_session->parts[i].selector = m_session->before_stroke[i];
    }
    complete(*m_session);
}
void Sessions::complete(Session& session) noexcept
{
    session.before_stroke.clear(); session.before_data.reset(); session.changed_parts.clear();
    session.preview.reset(); session.last_event.reset(); session.last_hit.reset();
    session.phase = Phase::Idle; session.active_stroke_id = 0; session.effective = false;
}
std::unique_ptr<Session> Sessions::prepare_commit(std::uint64_t id, std::uint64_t revision,
    std::uint64_t stroke, const std::optional<Settings>& settings, const std::optional<PointerEvent>& event)
{
    const auto& current = require(id, revision, false);
    require_stroke(current, stroke, true);
    if (bool(settings) != bool(event)) throw std::invalid_argument("final sample requires settings and event");
    if (event && current.phase != Phase::Drawing) throw std::invalid_argument("finished stroke has no final sample");
    auto candidate = stage(current);
    if (event) sample(*candidate, *settings, *event);
    candidate->phase = Phase::Finished;
    update_geometry_revisions(*candidate);
    return candidate;
}
std::unique_ptr<Session> Sessions::prepare_reconcile(const Model& model)
{
    if (!m_session) return {};
    require(m_session->id, m_session->revision);
    try { validate_target(model, *m_session); return {}; }
    catch (const std::invalid_argument&) {}
    auto candidate = prepare_target(model, m_session->id, m_session->revision, m_session->object_id, m_session->instance_id);
    update_geometry_revisions(*candidate);
    return candidate;
}

} // namespace Slic3r::Neo::Painting
