// ----------------------------------------------------------------
// Runtime Printer / Filament preset overlays owned by the Neo bridge.
// ----------------------------------------------------------------
#pragma once

#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "libslic3r/PresetBundle.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge {

class PresetDraftRegistry {
public:
    using Key = std::pair<Preset::Type, std::string>;
    using Overrides = std::map<std::string, std::string>;

    const Overrides* find(Preset::Type type, const std::string& canonical_name) const;
    Overrides* find(Preset::Type type, const std::string& canonical_name);
    bool contains(Preset::Type type, const std::string& canonical_name) const;
    void ensure_entry(Preset::Type type, const std::string& canonical_name);
    void set(Preset::Type type, const std::string& canonical_name,
             const std::string& key, const std::string& serialized_value);
    void erase_field(Preset::Type type, const std::string& canonical_name,
                     const std::string& key);
    void erase_preset(Preset::Type type, const std::string& canonical_name);
    void clear();
    nlohmann::json snapshot_json() const;
    static PresetDraftRegistry from_snapshot_json(const nlohmann::json& value,
                                                 const PresetBundle& bundle);
    bool operator==(const PresetDraftRegistry& other) const { return m_entries == other.m_entries; }

private:
    std::map<Key, Overrides> m_entries;
};

namespace PresetDrafts {

DynamicPrintConfig effective_full_config(
    const PresetBundle& bundle, const PresetDraftRegistry& drafts,
    bool apply_extruder = true,
    std::optional<std::vector<int>> filament_maps = std::nullopt,
    std::optional<std::vector<int>> filament_volume_maps = std::nullopt);

DynamicPrintConfig effective_full_config(
    bool apply_extruder = true,
    std::optional<std::vector<int>> filament_maps = std::nullopt,
    std::optional<std::vector<int>> filament_volume_maps = std::nullopt);

DynamicPrintConfig effective_full_config_secure(
    const PresetBundle& bundle, const PresetDraftRegistry& drafts,
    std::optional<std::vector<int>> filament_maps = std::nullopt);

DynamicPrintConfig effective_full_config_secure(
    std::optional<std::vector<int>> filament_maps = std::nullopt);

DynamicPrintConfig effective_printer_config();

nlohmann::json get_draft_json(Preset::Type type, const std::string& canonical_name);
nlohmann::json mutate_draft_json(const nlohmann::json& request);

} // namespace PresetDrafts
} // namespace Slic3r::Neo::Bridge
