#include "MeasureService.hpp"

#include <cassert>
#include <stdexcept>
#include <utility>

namespace Slic3r::Neo::Measurement {
namespace {
constexpr std::uint64_t max_safe_integer = 9007199254740991ULL;

void require_increment(std::uint64_t value)
{
    if (value >= max_safe_integer) throw std::overflow_error("measurement revision exhausted");
}
}

std::uint64_t Service::take_id(std::uint64_t& next)
{
    if (!next || next > max_safe_integer) throw std::overflow_error("measurement identity exhausted");
    return next++;
}

std::unique_ptr<Service::OpenCandidate> Service::prepare_open(const Model& model, const std::vector<TargetId>& targets)
{
    auto session = std::make_unique<Session>(model, targets);
    return std::make_unique<OpenCandidate>(OpenCandidate{take_id(m_next_session), std::move(session)});
}

void Service::publish_open(std::unique_ptr<OpenCandidate> candidate) noexcept
{
    assert(candidate && candidate->session);
    clear_displays();
    m_session.swap(candidate->session);
    m_id = candidate->id;
    m_target_revision = m_selection_revision = 1;
}

const Session& Service::require(std::uint64_t session_id) const
{
    if (!m_session || session_id != m_id) throw std::invalid_argument("measurement session is stale");
    return *m_session;
}

std::unique_ptr<Service::Display> Service::prepare_display(const Model& model, std::uint64_t session_id, const PointerEvent& event)
{
    const auto& session = require(session_id);
    auto hover = session.pick_mesh(model, event);
    auto snapshot = session.capture_display(model, hover);
    auto candidate = std::make_unique<Display>();
    candidate->id = take_id(m_next_display);
    candidate->session_id = session_id;
    candidate->target_revision = m_target_revision;
    candidate->selection_revision = m_selection_revision;
    candidate->snapshot = std::move(snapshot);
    return candidate;
}

void Service::publish_display(std::unique_ptr<Display> candidate) noexcept
{
    assert(candidate && candidate->session_id == m_id && candidate->target_revision == m_target_revision &&
        candidate->selection_revision == m_selection_revision);
    candidate->next = std::move(m_displays);
    m_displays = std::move(candidate);
}

const Service::Display& Service::display(std::uint64_t session_id, std::uint64_t display_id) const
{
    require(session_id);
    for (auto* display = m_displays.get(); display; display = display->next.get())
        if (display->id == display_id && display->session_id == session_id && display->target_revision == m_target_revision)
            return *display;
    throw std::invalid_argument("measurement display is stale");
}

void Service::release_display(std::uint64_t session_id, std::uint64_t display_id) noexcept
{
    auto* link = &m_displays;
    while (*link) {
        if ((*link)->id == display_id && (*link)->session_id == session_id) {
            auto removed = std::move(*link);
            *link = std::move(removed->next);
            return;
        }
        link = &(*link)->next;
    }
}

Service::SelectionCandidate Service::prepare_click(const Model& model, std::uint64_t session_id,
    const PointerEvent& event, std::optional<std::uint64_t> display_id, std::optional<std::size_t> marker, bool shift) const
{
    const auto& session = require(session_id);
    if (marker && !display_id) throw std::invalid_argument("measurement marker has no display");
    const auto fallback = display_id ? std::optional<DisplaySnapshot>{} : std::optional<DisplaySnapshot>{session.capture_display(model)};
    const auto& snapshot = display_id ? display(session_id, *display_id).snapshot : *fallback;
    const auto hit = session.pick_display(model, event, snapshot, marker);
    SelectionCandidate candidate{session_id, m_selection_revision, Outcome::Miss, nullptr};
    if (!hit) return candidate;
    if (std::holds_alternative<MeshPick>(*hit)) { candidate.outcome = Outcome::Mesh; return candidate; }
    require_increment(m_selection_revision);
    SelectionItem item = std::holds_alternative<MarkerHit>(*hit)
        ? std::get<MarkerHit>(*hit).marker.item
        : (shift ? point_item(std::get<GripperHit>(*hit).target, std::get<GripperHit>(*hit).source,
                              std::get<GripperHit>(*hit).point_on_feature)
                 : feature_item(std::get<GripperHit>(*hit).target, std::get<GripperHit>(*hit).source));
    candidate.selection = session.prepare_choose(model, std::move(item));
    candidate.outcome = Outcome::Selected;
    return candidate;
}

Service::SelectionCandidate Service::prepare_reset(const Model& model, std::uint64_t session_id, Reset action) const
{
    const auto& session = require(session_id);
    auto candidate = session.prepare_selection(model);
    SelectionCandidate result{session_id, m_selection_revision, Outcome::Unchanged, nullptr};
    bool changed = false;
    switch (action) {
    case Reset::First: changed = candidate->first().has_value(); if (changed) candidate->clear_first(); break;
    case Reset::Second: changed = candidate->second().has_value(); if (changed) candidate->clear_second(); break;
    case Reset::All: changed = candidate->first().has_value() || candidate->second().has_value(); if (changed) candidate->clear(); break;
    case Reset::Escape:
        changed = candidate->escape();
        if (!changed) result.outcome = Outcome::Close;
        break;
    }
    if (changed) {
        require_increment(m_selection_revision);
        result.selection = std::move(candidate);
        result.outcome = Outcome::Selected;
    }
    return result;
}

void Service::publish_selection(SelectionCandidate candidate) noexcept
{
    assert(m_session && candidate.session_id == m_id && candidate.base_revision == m_selection_revision);
    if (!candidate.selection) return;
    m_session->publish_selection(std::move(candidate.selection));
    ++m_selection_revision;
}

std::unique_ptr<Service::RebaseCandidate> Service::prepare_rebase(const Model& model, std::uint64_t session_id) const
{
    const auto& session = require(session_id);
    require_increment(m_target_revision);
    require_increment(m_selection_revision);
    return std::make_unique<RebaseCandidate>(RebaseCandidate{session_id, m_target_revision, m_selection_revision,
        session.rebase_after_scale(model)});
}

void Service::publish_rebase(std::unique_ptr<RebaseCandidate> candidate) noexcept
{
    assert(candidate && candidate->session && candidate->session_id == m_id &&
        candidate->target_revision == m_target_revision && candidate->selection_revision == m_selection_revision);
    clear_displays();
    m_session.swap(candidate->session);
    ++m_target_revision;
    ++m_selection_revision;
}

void Service::clear_displays() noexcept
{
    // Destroy iteratively even if a client has many outstanding snapshots.
    while (m_displays) {
        auto display = std::move(m_displays);
        m_displays = std::move(display->next);
    }
}

void Service::reset() noexcept
{
    clear_displays();
    m_session.reset();
    m_id = m_target_revision = m_selection_revision = 0;
}

} // namespace Slic3r::Neo::Measurement
