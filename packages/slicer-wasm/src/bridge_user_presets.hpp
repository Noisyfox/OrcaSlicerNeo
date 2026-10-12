#pragma once
#include "libslic3r/PresetBundle.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::UserPresets {
bool deleted(Preset::Type type, const std::string& name);
bool is_snapshot(Preset::Type type, const std::string& name);
const Preset* baseline(Preset::Type type, const std::string& name);
std::string display_label(const Preset& preset);
bool picker_is_user(const Preset& preset);
bool picker_is_project_embedded(const Preset& preset);
bool picker_visible(const Preset& preset);
std::string view_name(Preset::Type type, const std::string& name);
std::string print_reset_target();
bool modified(Preset::Type type, const std::string& name, const DynamicPrintConfig& effective);
void reset_session();
// Rebind all active references, including the shared draft owner.
void adopt(Preset::Type type, const std::string& from, const std::string& to);
// Standard embedded copies for 3MF; session snapshot names never cross this boundary.
std::vector<Preset> export_presets(DynamicPrintConfig& config, const std::vector<Preset*>& embedded);
}
