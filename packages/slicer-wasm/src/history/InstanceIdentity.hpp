#pragma once

#include <cstddef>
#include <set>
#include <vector>

#include "libslic3r/ObjectID.hpp"

namespace Slic3r {
class ModelObject;
}

namespace Slic3r::Neo::History {

using InstanceIDs = std::vector<::Slic3r::ObjectID>;

// Tracks the instance identities accepted while visiting one supplied object
// graph. Use one tracker for the complete capture or restore so duplicate IDs
// are rejected across ModelObject boundaries, not just within one object.
class InstanceIdentityGraph {
public:
    InstanceIDs capture(const ModelObject& object);
    void restore(ModelObject& object, const InstanceIDs& ids);

    std::size_t size() const noexcept { return m_ids.size(); }

private:
    std::set<std::size_t> m_ids;
};

} // namespace Slic3r::Neo::History
