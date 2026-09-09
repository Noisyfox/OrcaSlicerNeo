// Model editing and geometry operations for the Neo WASM bridge.
#pragma once
#include <cstddef>
#include <optional>
#include <string>
#include <vector>
#include "bridge_state.hpp"
#include "libslic3r/Model.hpp"
#include "nlohmann/json.hpp"
namespace Slic3r::Neo::Bridge::ModelOperations {
using json = nlohmann::json;
std::size_t model_instance_count(const Model& model);
ModelObject* append_model_object_geometry(Model& destination, const ModelObject& source);
std::optional<std::size_t> to_object_id(double value);
std::optional<std::vector<std::size_t>> parse_positive_id_array(const json& value);
ModelObject* find_object_by_id(std::size_t id);
ModelVolume* find_volume_by_id(std::size_t id);
ModelInstance* find_instance_by_id(std::size_t id);
const char* volume_type_string(ModelVolumeType type);
std::optional<ModelVolumeType> volume_type_from_string(const std::string& value);
json model_structure_json();
} // namespace Slic3r::Neo::Bridge::ModelOperations
