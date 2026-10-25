#include "bridge_nozzle_mapping.hpp"
#include "bridge_filament.hpp"
#include "bridge_plate.hpp"
#include "bridge_preset_drafts.hpp"
#include "bridge_profiles.hpp"
#include "bridge_prime_tower.hpp"
#include "bridge_state.hpp"

#include <algorithm>
#include <charconv>
#include <limits>
#include <set>
#include <stdexcept>
#include <string_view>
#include <emscripten/emscripten.h>

namespace Slic3r::Neo::Bridge::NozzleMapping {
using nlohmann::json;

namespace {
int nonnegative_integer(std::string_view value)
{
    int result = 0;
    const auto parsed = std::from_chars(value.data(), value.data() + value.size(), result);
    if (value.empty() || parsed.ec != std::errc{} || parsed.ptr != value.data() + value.size() || result < 0)
        throw std::invalid_argument("Invalid or overflowing nozzle capacity");
    return result;
}

json saved_map(const DynamicPrintConfig& config, const char* key)
{
    const auto* values = config.opt<ConfigOptionInts>(key);
    return values ? json(values->values) : json(nullptr);
}

std::vector<int> effective_map(const DynamicPrintConfig& plate, const DynamicPrintConfig& project,
                             const char* key, std::size_t count, int fallback)
{
    const auto* values = plate.opt<ConfigOptionInts>(key);
    if (!values || values->values.empty()) values = project.opt<ConfigOptionInts>(key);
    std::vector<int> result = values ? values->values : std::vector<int>{};
    if (result.size() > count) throw std::invalid_argument("Mapping exceeds project filament count");
    result.resize(count, fallback);
    return result;
}

json saved_mode(const DynamicPrintConfig& config)
{
    const auto* value = config.option("filament_map_mode");
    return value ? json(value->getInt()) : json(nullptr);
}
} // namespace

std::vector<int> decode_capacities(const DynamicPrintConfig& config, std::size_t nozzles)
{
    std::vector<int> result(nozzles, 1);
    const auto* values = config.opt<ConfigOptionStrings>("extruder_ams_count");
    if (!values) return result;
    for (std::size_t i = 0; i < std::min(nozzles, values->values.size()); ++i) {
        std::string_view remaining(values->values[i]);
        int total = 0;
        std::set<int> widths;
        while (!remaining.empty()) {
            const auto separator = remaining.find('|');
            const auto token = remaining.substr(0, separator);
            const auto hash = token.find('#');
            if (hash == std::string_view::npos) throw std::invalid_argument("Invalid nozzle capacity entry");
            const int slots = nonnegative_integer(token.substr(0, hash));
            const int count = nonnegative_integer(token.substr(hash + 1));
            if (!widths.insert(slots).second) throw std::invalid_argument("Duplicate nozzle capacity entry");
            if (count != 0 && slots > (std::numeric_limits<int>::max() - total) / count)
                throw std::invalid_argument("Nozzle capacity exceeds native integer range");
            total += slots * count;
            if (separator == std::string_view::npos) break;
            remaining.remove_prefix(separator + 1);
            if (remaining.empty()) throw std::invalid_argument("Invalid trailing capacity separator");
        }
        result[i] = std::max(1, total);
    }
    return result;
}

json projection(const std::string& plate_id)
{
    const auto* plate = PlateSession::find_plate(plate_id);
    if (!plate) return {{"ok", false}, {"errorCode", "plate_not_found"}, {"error", "Plate no longer exists"}};
    const auto& project = state().presets.project_config;
    const auto printer = PresetDrafts::effective_printer_config();
    const auto* diameters = printer.opt<ConfigOptionFloats>("nozzle_diameter");
    const std::size_t nozzles = diameters ? diameters->size() : 0;
    const bool eligible = nozzles > 1 && printer.opt_bool("single_extruder_multi_material");
    const bool automatic = eligible && nozzles == 2 && state().presets.is_bbl_vendor();
    const std::string automatic_reason = !eligible ? "Requires SEMM and multiple extruders"
        : !automatic ? "Automatic filament saving is unavailable for this printer topology" : "";
    const auto capacities = decode_capacities(project, nozzles);
    const auto count = Filament::State::material_slot_count(project);
    const auto maps = effective_map(plate->settings, project, "filament_map", count, 1);
    const auto volumes = effective_map(plate->settings, project, "filament_volume_map", count, 0);
    const auto tips = effective_map(plate->settings, project, "filament_nozzle_map", count, 0);
    const auto mode = saved_mode(plate->settings);
    const auto project_mode = saved_mode(project);
    const int effective_mode = mode.is_null() || mode == int(fmmDefault)
        ? (project_mode.is_null() || project_mode == int(fmmDefault) ? int(fmmAutoForFlush) : project_mode.get<int>())
        : mode.get<int>();
    json heads = json::array();
    for (std::size_t i = 0; i < nozzles; ++i)
        heads.push_back({{"id", i + 1}, {"diameter", diameters->values[i]}, {"capacity", capacities[i]}});
    const auto used = PrimeTower::used_filament_slots_for_plate(plate_id);
    json diagnostics = json::array();
    const bool manual = effective_mode == fmmManual || effective_mode == fmmNozzleManual;
    std::vector<int> assigned(nozzles, 0);
    for (const int slot : used) {
        const int target = maps.at(slot - 1);
        if (target < 1 || static_cast<std::size_t>(target) > nozzles) {
            if (manual) diagnostics.push_back({{"code", "invalid_target"}, {"severity", "error"},
                {"message", "A used filament targets an unavailable nozzle"}, {"filament", slot}});
        }
        else ++assigned[target - 1];
    }
    if (manual)
        for (std::size_t i = 0; i < nozzles; ++i)
            if (assigned[i] > capacities[i]) diagnostics.push_back({{"code", "capacity_exceeded"},
                {"severity", "warning"}, {"message", "Assigned filaments exceed nozzle capacity"}, {"nozzle", i + 1}});
    const auto revision = state().plate_input_revisions.find(plate_id);
    return {{"ok", true}, {"plateId", plate_id},
        {"revision", revision == state().plate_input_revisions.end() ? 0 : revision->second},
        {"eligible", eligible}, {"nozzles", heads}, {"usedFilaments", used},
        {"modes", json::array({
            {{"mode", int(fmmAutoForFlush)}, {"available", automatic}, {"reason", automatic_reason}},
            {{"mode", int(fmmAutoForMatch)}, {"available", false}, {"reason", "Device material synchronization is unavailable"}},
            {{"mode", int(fmmManual)}, {"available", eligible}, {"reason", eligible ? "" : "Requires SEMM and multiple extruders"}},
            {{"mode", int(fmmNozzleManual)}, {"available", eligible}, {"reason", eligible ? "" : "Requires SEMM and multiple extruders"}}
        })},
        {"saved", {{"mode", mode}, {"filamentMap", saved_map(plate->settings, "filament_map")},
            {"volumeMap", saved_map(plate->settings, "filament_volume_map")},
            {"nozzleMap", saved_map(plate->settings, "filament_nozzle_map")}}},
        {"effective", {{"mode", effective_mode}, {"filamentMap", maps}, {"volumeMap", volumes}, {"nozzleMap", tips}}},
        {"diagnostics", diagnostics}};
}
} // namespace Slic3r::Neo::Bridge::NozzleMapping

extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_get_nozzle_mapping(const char* plate_id)
{
    using namespace Slic3r::Neo::Bridge;
    using Profiles::duplicate_json;
    try { return duplicate_json(NozzleMapping::projection(plate_id ? plate_id : "").dump()); }
    catch (const std::exception& e) {
        return duplicate_json(nlohmann::json{{"ok", false}, {"errorCode", "invalid_mapping_state"}, {"error", e.what()}}.dump());
    }
    catch (...) {
        return duplicate_json(nlohmann::json{{"ok", false}, {"errorCode", "native_exception"},
            {"error", "Unknown nozzle mapping projection failure"}}.dump());
    }
}
