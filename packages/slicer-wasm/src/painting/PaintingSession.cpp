#include "PaintingSession.hpp"
#include <limits>
#include <stdexcept>

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
        auto selector = std::make_unique<TriangleSelector>(*mesh);
        MmuAnnotationAdapter::load(*volume, *selector);
        session.parts.push_back({volume->id().id, std::move(mesh), std::move(selector),
            volume->get_matrix(), volume->mmu_segmentation_facets.timestamp()});
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

const Session& Sessions::require(std::uint64_t id, std::uint64_t revision) const
{
    if (!m_session || m_session->id != id) throw std::invalid_argument("painting session is stale");
    if (m_session->revision != revision) throw std::invalid_argument("painting revision is stale");
    if (m_session->active_stroke_id) throw std::logic_error("painting stroke is busy");
    return *m_session;
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

} // namespace Slic3r::Neo::Painting
