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
