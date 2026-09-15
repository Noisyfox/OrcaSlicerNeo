// ----------------------------------------------------------------
// Runtime ownership for the FFF per-plate Print domain.
// ----------------------------------------------------------------
#include "plate_runtime_registry.hpp"

#include <stdexcept>
#include <unordered_set>

namespace Slic3r::Neo::Bridge {

void PlateRuntimeRegistry::reconcile(const std::vector<std::string>& plate_ids)
{
    std::unordered_set<std::string> desired;
    desired.reserve(plate_ids.size());

    for (const std::string& plate_id : plate_ids) {
        if (plate_id.empty())
            throw std::invalid_argument("plate runtime registry requires a non-empty id");
        if (!desired.insert(plate_id).second)
            throw std::invalid_argument("plate runtime registry requires unique ids");

        if (entries_.find(plate_id) == entries_.end()) {
            Entry entry;
            entry.plate_id = plate_id;
            entry.print = std::make_unique<Print>();
            entry.gcode_result = std::make_unique<GCodeProcessorResult>();
            entries_.emplace(plate_id, std::move(entry));
        }
    }

    for (auto it = entries_.begin(); it != entries_.end();) {
        if (desired.find(it->first) == desired.end())
            it = entries_.erase(it);
        else
            ++it;
    }
}

void PlateRuntimeRegistry::clear() noexcept
{
    entries_.clear();
}

void PlateRuntimeRegistry::begin_slice(Entry& entry) noexcept
{
    // Keep the Print and GCodeProcessorResult allocations alive.  A slice
    // transition only withdraws the presentation that React may publish.
    entry.presentation = PresentationLifecycle::Slicing;
}

void PlateRuntimeRegistry::mark_process_completed(Entry& entry,
                                                  const std::uint64_t completed_revision,
                                                  const std::uint64_t current_revision) noexcept
{
    entry.native_core_materialized = true;
    entry.completed_input_revision = completed_revision;
    // Result/export materialization may promote this intermediate state to
    // valid without losing the retained native core objects.
    entry.presentation = completed_revision == current_revision
        ? PresentationLifecycle::Slicing
        : PresentationLifecycle::Invalid;
}

void PlateRuntimeRegistry::mark_presentation_valid(Entry& entry,
                                                   const std::uint64_t current_revision) noexcept
{
    entry.presentation = entry.native_core_materialized &&
            entry.completed_input_revision.has_value() &&
            *entry.completed_input_revision == current_revision
        ? PresentationLifecycle::Valid
        : PresentationLifecycle::Invalid;
}

void PlateRuntimeRegistry::mark_presentation_invalid(Entry& entry) noexcept
{
    entry.presentation = PresentationLifecycle::Invalid;
}

bool PlateRuntimeRegistry::can_materialize_result(const Entry& entry,
                                                  const std::uint64_t current_revision) noexcept
{
    return (entry.presentation == PresentationLifecycle::Slicing ||
            entry.presentation == PresentationLifecycle::Valid) &&
           entry.native_core_materialized &&
           entry.completed_input_revision.has_value() &&
           *entry.completed_input_revision == current_revision;
}

bool PlateRuntimeRegistry::is_publishable(const Entry& entry,
                                          const std::uint64_t current_revision) noexcept
{
    return entry.presentation == PresentationLifecycle::Valid &&
           entry.native_core_materialized &&
           entry.completed_input_revision.has_value() &&
           *entry.completed_input_revision == current_revision;
}

PlateRuntimeRegistry::Entry* PlateRuntimeRegistry::find(const std::string_view plate_id) noexcept
{
    const auto it = entries_.find(std::string(plate_id));
    return it == entries_.end() ? nullptr : &it->second;
}

const PlateRuntimeRegistry::Entry* PlateRuntimeRegistry::find(const std::string_view plate_id) const noexcept
{
    const auto it = entries_.find(std::string(plate_id));
    return it == entries_.end() ? nullptr : &it->second;
}

} // namespace Slic3r::Neo::Bridge
