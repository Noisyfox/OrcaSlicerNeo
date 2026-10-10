#pragma once
#include "libslic3r/Preset.hpp"
#include "nlohmann/json.hpp"
namespace Slic3r::Neo::Bridge::ConfigElements {
using json = nlohmann::json;
size_t element_count(const DynamicPrintConfig&, Preset::Type, const std::string&);
json vectors_json(const DynamicPrintConfig& source, const DynamicPrintConfig& effective, Preset::Type);
json set_element(DynamicPrintConfig&, const std::string&, const std::string&, uint64_t, const json&, size_t);
json reset_element(DynamicPrintConfig&, const DynamicPrintConfig& source, const std::string&, uint64_t, size_t);
bool equal_elements(const ConfigOption&, const ConfigOption&, const ConfigOptionDef&);
}
