#pragma once

#include "bridge_filament.hpp"

namespace Slic3r::Neo::Bridge::Filament::Mixes {

std::string material_type(const PresetBundle& bundle, size_t index);
json recipe(const PresetBundle& bundle, size_t index);
json decompose(PresetBundle& bundle, const json& query);
json recommendations(const PresetBundle& bundle, int size);
json preview(const PresetBundle& bundle, const json& draft);
void write(PresetBundle& bundle, size_t index, const json& draft, const json& preview);
void refresh_colours(PresetBundle& bundle);

} // namespace Slic3r::Neo::Bridge::Filament::Mixes
