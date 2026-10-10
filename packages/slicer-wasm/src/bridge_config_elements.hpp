#pragma once
#include "libslic3r/Preset.hpp"
#include "nlohmann/json.hpp"
namespace Slic3r::Neo::Bridge::ConfigElements {
using json = nlohmann::json;
size_t element_count(const DynamicPrintConfig&, Preset::Type, const std::string&);
std::optional<std::string> editor_vector_type(const std::string&, const ConfigOptionDef&);
json vectors_json(const DynamicPrintConfig& source, const DynamicPrintConfig& effective, Preset::Type,
                  const json& overrides);
// Sparse overlay entries are null (inherit) or {value: typed native element}.
json explicit_values(const DynamicPrintConfig&, Preset::Type, const std::string&, std::optional<size_t> count = std::nullopt);
void apply_override(DynamicPrintConfig&, Preset::Type, const std::string&, const json&);
json set_override(DynamicPrintConfig&, Preset::Type, const std::string&, const json&,
                  const std::string&, uint64_t, const json&);
json reset_override(DynamicPrintConfig&, const DynamicPrintConfig&, Preset::Type,
                    const std::string&, const json&, uint64_t);
bool has_override(const json&);
json set_element(DynamicPrintConfig&, const std::string&, const std::string&, uint64_t, const json&, size_t);
json reset_element(DynamicPrintConfig&, const DynamicPrintConfig& source, const std::string&, uint64_t, size_t);
bool equal_elements(const ConfigOption&, const ConfigOption&, const ConfigOptionDef&);
}
