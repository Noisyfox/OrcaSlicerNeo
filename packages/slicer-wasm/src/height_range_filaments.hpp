#pragma once

#include <cstddef>
#include <set>

namespace Slic3r {
class DynamicPrintConfig;
class ModelInstance;

namespace Neo {
// Add logical slots before the caller expands mixes or maps slots to nozzles.
void collect_height_range_filaments(const ModelInstance& instance, const DynamicPrintConfig& config,
                                    std::size_t slot_count, std::set<int>& slots);
}
}
