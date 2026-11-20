#pragma once

#include "bridge_filament.hpp"

namespace Slic3r::Neo::Bridge::Filament::Mixes {

std::string material_type(const PresetBundle& bundle, size_t index);
json stored_recipe(const DynamicPrintConfig& config, size_t index);
void restore_recipes(PresetBundle& bundle, const std::vector<json>& recipes);
json recipe(const PresetBundle& bundle, size_t index);
json decompose(PresetBundle& bundle, const json& query);
json recommendations(const PresetBundle& bundle, int size);
json triangle_palette(const json& colours);
json preview(const PresetBundle& bundle, const json& draft, const json& component_colours = nullptr);
void write(PresetBundle& bundle, size_t index, const json& draft, const json& preview);
void refresh_colours(PresetBundle& bundle);

} // namespace Slic3r::Neo::Bridge::Filament::Mixes
