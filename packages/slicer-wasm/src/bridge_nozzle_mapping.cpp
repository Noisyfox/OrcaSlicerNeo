#include "bridge_nozzle_mapping.hpp"
#include "bridge_filament.hpp"
#include "bridge_plate.hpp"
#include "bridge_preset_drafts.hpp"
#include "bridge_profiles.hpp"
#include "bridge_prime_tower.hpp"
#include "bridge_state.hpp"
#include "bridge_history.hpp"
#include "bridge_scoped_config.hpp"
#include "libslic3r/Print.hpp"

#include <algorithm>
#include <charconv>
#include <limits>
#include <map>
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

void normalize_capacities(DynamicPrintConfig& project, const std::size_t nozzles)
{
    std::vector<std::string> encoded;
    for (int capacity : decode_capacities(project, nozzles)) encoded.push_back("1#" + std::to_string(capacity));
    project.set_key_value("extruder_ams_count", new ConfigOptionStrings(std::move(encoded)));
}

void restore_remembered_capacities()
{
    const auto printer = PresetDrafts::effective_printer_config();
    const auto count = printer.opt<ConfigOptionFloats>("nozzle_diameter")->size();
    const auto memory = json::parse(state().profile_config.get("nozzle_capacity_memory"), nullptr, false);
    const auto name = state().presets.printers.get_selected_preset_name();
    const auto values = memory.is_object() && memory.contains(name) ? memory[name] : json::array();
    std::vector<std::string> encoded;
    for (std::size_t i = 0; i < count; ++i)
        encoded.push_back("1#" + std::to_string(i < values.size() ? values[i].get<int>() : 1));
    state().presets.project_config.set_key_value("extruder_ams_count", new ConfigOptionStrings(std::move(encoded)));
}

json configure_memory(const json& request)
{
    if (!request.is_object() || !request.contains("memory") || !request["memory"].is_object() ||
        !request.contains("initializeNewProject") || !request["initializeNewProject"].is_boolean())
        throw std::invalid_argument("Capacity memory and fresh-project intent are required");
    for (const auto& [name, values] : request["memory"].items()) {
        if (name.empty() || name.size() > 4096 || !values.is_array() || values.empty() || values.size() > MAXIMUM_EXTRUDER_NUMBER)
            throw std::invalid_argument("Invalid printer capacity memory");
        for (const auto& value : values)
            if (!value.is_number_unsigned() || value.get<std::uint64_t>() < 1 || value.get<std::uint64_t>() > std::numeric_limits<int>::max())
                throw std::invalid_argument("Capacity memory requires positive native integers");
    }
    if (request["initializeNewProject"].get<bool>() && !state().model.objects.empty())
        throw std::invalid_argument("Only a fresh empty project may seed capacities");
    const auto previous_memory = state().profile_config.get("nozzle_capacity_memory");
    const auto previous_project = state().presets.project_config;
    try {
        state().profile_config.set("nozzle_capacity_memory", request["memory"].dump());
        if (request["initializeNewProject"].get<bool>()) restore_remembered_capacities();
        return {{"ok", true}};
    } catch (...) {
        state().profile_config.set("nozzle_capacity_memory", previous_memory);
        state().presets.project_config = previous_project;
        throw;
    }
}

DynamicPrintConfig full_config(const std::string& plate_id, bool apply_extruder)
{
    const auto* plate = PlateSession::find_plate(plate_id);
    if (!plate) throw std::invalid_argument("Plate no longer exists");
    const auto& project = state().presets.project_config;
    const auto count = Filament::State::material_slot_count(project);
    auto config = PresetDrafts::effective_full_config(apply_extruder,
        effective_map(plate->settings, project, "filament_map", count, 1),
        effective_map(plate->settings, project, "filament_volume_map", count, 0));
    config.apply(plate->settings, true);
    config.set_key_value("filament_map", new ConfigOptionInts(effective_map(plate->settings, project, "filament_map", count, 1)));
    config.set_key_value("filament_volume_map", new ConfigOptionInts(effective_map(plate->settings, project, "filament_volume_map", count, 0)));
    config.set_key_value("filament_nozzle_map", new ConfigOptionInts(
        effective_map(plate->settings, project, "filament_nozzle_map", count, 0)));
    const auto mode = saved_mode(plate->settings);
    const auto project_mode = saved_mode(project);
    const int effective_mode = mode.is_null() || mode == int(fmmDefault)
        ? (project_mode.is_null() || project_mode == int(fmmDefault) ? int(fmmAutoForFlush) : project_mode.get<int>())
        : mode.get<int>();
    config.set_key_value("filament_map_mode", new ConfigOptionEnum<FilamentMapMode>(FilamentMapMode(effective_mode)));
    // Orca supplies this session-only inventory through its GUI/device layer.
    // For ordinary one-nozzle-per-head printers the effective topology already
    // defines it completely. Supply it only to the temporary Print config;
    // preserve a supplied inventory and do not invent multi-nozzle hardware.
    const auto* stats = config.opt<ConfigOptionStrings>("extruder_nozzle_stats");
    const auto* maxima = config.opt<ConfigOptionInts>("extruder_max_nozzle_count");
    if (effective_mode == fmmNozzleManual && (!stats || stats->empty()) &&
        (!maxima || std::none_of(maxima->values.begin(), maxima->values.end(), [](int count) { return count > 1; }))) {
        const auto* flows = config.opt<ConfigOptionEnumsGeneric>("nozzle_volume_type");
        std::vector<std::map<NozzleVolumeType, int>> inventory;
        for (std::size_t i = 0; i < config.opt<ConfigOptionFloats>("nozzle_diameter")->size(); ++i) {
            const auto flow = flows && i < flows->size() ? NozzleVolumeType(flows->get_at(i)) : nvtStandard;
            inventory.push_back({{flow == nvtHybrid ? nvtStandard : flow, 1}});
        }
        config.set_key_value("extruder_nozzle_stats", new ConfigOptionStrings(save_extruder_nozzle_stats_to_string(inventory)));
    }
    std::vector<std::string> capacities;
    for (int capacity : decode_capacities(project, config.opt<ConfigOptionFloats>("nozzle_diameter")->size()))
        capacities.push_back("1#" + std::to_string(capacity));
    config.set_key_value("extruder_ams_count", new ConfigOptionStrings(std::move(capacities)));
    return config;
}

void validate_slice(const std::string& plate_id)
{
    const auto printer = PresetDrafts::effective_printer_config();
    if (printer.opt<ConfigOptionFloats>("nozzle_diameter")->size() <= 1 || !printer.opt_bool("single_extruder_multi_material")) return;
    const auto input = projection(plate_id);
    if (!input.value("ok", false)) throw std::invalid_argument(input.value("error", "Invalid mapping inputs"));
    const int mode = input["effective"]["mode"].get<int>();
    if (mode < 0 || mode > 3 || !input["modes"][mode]["available"].get<bool>())
        throw std::invalid_argument(mode >= 0 && mode <= 3 ? input["modes"][mode]["reason"].get<std::string>() : "Unknown mapping mode");
    for (const auto& diagnostic : input["diagnostics"])
        if (diagnostic["severity"] == "error") throw std::invalid_argument(diagnostic["message"].get<std::string>());
}

void initialize_plate(DynamicPrintConfig& settings)
{
    const auto printer = PresetDrafts::effective_printer_config();
    const auto* diameters = printer.opt<ConfigOptionFloats>("nozzle_diameter");
    if (!diameters || diameters->size() < 2 || !printer.opt_bool("single_extruder_multi_material")) return;
    const bool automatic = diameters->size() == 2 && state().presets.is_bbl_vendor();
    settings.set_key_value("filament_map_mode", new ConfigOptionEnum<FilamentMapMode>(automatic ? fmmAutoForFlush : fmmManual));
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
namespace {
json failure(const char* code, const std::string& message)
{
    return {{"ok", false}, {"errorCode", code}, {"error", message}};
}
int concrete_flow(std::size_t nozzle)
{
    const auto* flows = state().presets.project_config.opt<ConfigOptionEnumsGeneric>("nozzle_volume_type");
    const int flow = flows && nozzle < flows->size() ? flows->get_at(nozzle) : int(nvtStandard);
    return flow == nvtHybrid ? int(nvtStandard) : flow;
}
}

json mutate(const json& request)
{
    auto& bridge = state();
    if (!request.is_object() || !request.contains("plateId") || !request["plateId"].is_string() ||
        !request.contains("revision") || !request["revision"].is_number_unsigned() ||
        !request.contains("plateRevision") || !request["plateRevision"].is_number_unsigned() ||
        !request.contains("history_context") || !request.contains("change") || !request["change"].is_object())
        return failure("invalid_request", "Mapping target, revisions, change and history context are required");
    const auto id = request["plateId"].get<std::string>();
    const auto before = projection(id);
    if (!before.value("ok", false)) return before;
    if (request["revision"] != bridge.history_revision || request["plateRevision"] != before["revision"])
        return failure("stale_revision", "Nozzle mapping inputs changed; refresh before editing");
    if (!before["eligible"].get<bool>()) return failure("unavailable", "Requires SEMM and multiple extruders");
    if (bridge.active_history_transaction || bridge.history_disabled)
        return failure("history_unavailable", "Nozzle mapping requires an independent history transaction");
    const auto context = HistoryMetadata::parse_history_context(request["history_context"].dump().c_str());
    const auto& change = request["change"];
    const auto kind = change.value("kind", "");
    const auto count = before["effective"]["filamentMap"].size();
    const auto nozzles = before["nozzles"].size();
    auto* plate = PlateSession::find_plate_mutable(id);
    auto candidate = plate->settings;
    auto project = bridge.presets.project_config;
    bool changed = false;
    if (kind == "capacity") {
        if (!change.contains("nozzle") || !change["nozzle"].is_number_unsigned() ||
            change["nozzle"].get<std::uint64_t>() < 1 || change["nozzle"].get<std::uint64_t>() > nozzles ||
            !change.contains("capacity") || !change["capacity"].is_number_unsigned() ||
            change["capacity"].get<std::uint64_t>() < 1 || change["capacity"].get<std::uint64_t>() > std::numeric_limits<int>::max())
            return failure("invalid_request", "Capacity requires a live nozzle and a positive native integer");
        auto capacities = decode_capacities(project, nozzles);
        const auto nozzle = change["nozzle"].get<std::size_t>() - 1;
        changed = capacities[nozzle] != change["capacity"].get<int>();
        capacities[nozzle] = change["capacity"].get<int>();
        if (changed) {
            std::vector<std::string> encoded;
            for (int capacity : capacities) encoded.push_back("1#" + std::to_string(capacity));
            project.set_key_value("extruder_ams_count", new ConfigOptionStrings(std::move(encoded)));
        }
    } else if (kind == "mode") {
        if (!change.contains("mode") || !change["mode"].is_number_unsigned() || change["mode"].get<unsigned>() > 3)
            return failure("invalid_request", "Unknown mapping mode");
        const int mode = change["mode"].get<int>();
        if (!before["modes"][mode]["available"].get<bool>()) return failure("unavailable", before["modes"][mode]["reason"]);
        changed = before["effective"]["mode"] != mode;
        if (changed) candidate.set_key_value("filament_map_mode", new ConfigOptionEnum<FilamentMapMode>(FilamentMapMode(mode)));
    } else if (kind == "mapping") {
        if (!change.contains("mode") || !change["mode"].is_number_unsigned() || change["mode"].get<unsigned>() > 3)
            return failure("invalid_request", "Unknown mapping mode");
        int mode = change["mode"].get<int>();
        if (!before["modes"][mode]["available"].get<bool>()) return failure("unavailable", before["modes"][mode]["reason"]);
        if (!change.contains("filamentMap") || !change["filamentMap"].is_array() || change["filamentMap"].size() != count)
            return failure("invalid_request", "Mapping must contain every project filament");
        for (const auto& target : change["filamentMap"])
            if (!target.is_number_unsigned() || target.get<std::uint64_t>() < 1 || target.get<std::uint64_t>() > nozzles)
                return failure("invalid_request", "Mapping targets an unavailable nozzle");
        const bool mapping_changed = change["filamentMap"] != before["effective"]["filamentMap"];
        if (mapping_changed && mode == fmmNozzleManual) mode = fmmManual;
        changed = mapping_changed || before["effective"]["mode"] != mode;
        if (mapping_changed) {
            auto maps = change["filamentMap"].get<std::vector<int>>();
            auto volumes = before["effective"]["volumeMap"].get<std::vector<int>>();
            auto tips = before["effective"]["nozzleMap"].get<std::vector<int>>();
            for (std::size_t i = 0; i < count; ++i) if (maps[i] != before["effective"]["filamentMap"][i]) {
                volumes[i] = concrete_flow(maps[i] - 1); tips[i] = 0;
            }
            candidate.set_key_value("filament_map", new ConfigOptionInts(std::move(maps)));
            candidate.set_key_value("filament_volume_map", new ConfigOptionInts(std::move(volumes)));
            candidate.set_key_value("filament_nozzle_map", new ConfigOptionInts(std::move(tips)));
        }
        if (changed) candidate.set_key_value("filament_map_mode", new ConfigOptionEnum<FilamentMapMode>(FilamentMapMode(mode)));
    } else return failure("invalid_request", "Unknown mapping operation");
    if (!changed) return {{"ok", true}, {"changed", false}, {"snapshot", before},
        {"history_status", HistoryMetadata::history_status_json(bridge)}};

    const auto before_project = bridge.presets.project_config;
    const auto before_settings = plate->settings;
    const auto before_metadata = plate->settings_metadata;
    const auto before_revisions = bridge.plate_input_revisions;
    const auto before_pending = bridge.pending_membership_instance_ids;
    const auto before_lifecycle = bridge.plate_runtime_registry.capture_lifecycle();
    const auto before_context = bridge.history_live_context;
    const auto before_stamp = bridge.next_plate_input_stamp;
    const auto predecessor = HistoryMetadata::canonical_history_context(bridge, context,
        PlateSession::plate_session_snapshot_json(), Filament::State::history_state_json(bridge.presets));
    if (!HistoryMetadata::begin_timestamped_operation(bridge, kind == "capacity" ? "Set Nozzle Capacity" : "Set Plate Filament Mapping", predecessor))
        return failure("history_unavailable", "Could not capture mapping predecessor");
    bool committed = false;
    try {
        bridge.presets.project_config = std::move(project);
        plate->settings = std::move(candidate);
        plate->settings_metadata = Filament::State::config_metadata_json(plate->settings);
        const auto affected = kind == "capacity" ? PlateSession::all_plate_ids() : std::set<std::string>{id};
        auto plates = PlateSession::configuration_mutation_snapshot(affected, {"nozzle-mapping"});
        auto snapshot = projection(id);
        if (!snapshot.value("ok", false)) throw std::runtime_error(snapshot.value("error", "Invalid mapping projection"));
        auto scoped = ScopedConfig::native_scoped_config_full_transport(bridge.history_revision + 1);
        const auto successor = HistoryMetadata::canonical_history_context(bridge, context, plates,
            Filament::State::history_state_json(bridge.presets));
        if (request.value("inject_failure_stage", "") == "before-publication") throw std::runtime_error("injected mapping publication failure");
        if (!HistoryMetadata::commit_timestamped_operation(bridge, successor)) throw std::runtime_error("History rejected mapping mutation");
        committed = true;
        return {{"ok", true}, {"changed", true}, {"snapshot", std::move(snapshot)},
            {"plate_session", std::move(plates)}, {"native_scoped_config", std::move(scoped)},
            {"history_status", HistoryMetadata::history_status_json(bridge)}};
    } catch (...) {
        if (!committed) {
            HistoryMetadata::abort_timestamped_operation(bridge);
            bridge.presets.project_config = before_project;
            plate->settings = before_settings; plate->settings_metadata = before_metadata;
            bridge.plate_input_revisions = before_revisions;
            bridge.pending_membership_instance_ids = before_pending;
            bridge.next_plate_input_stamp = before_stamp;
            bridge.plate_runtime_registry.restore_lifecycle(before_lifecycle);
            bridge.history_live_context = before_context;
            PrimeTower::invalidate_projection_cache();
        }
        throw;
    }
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

extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_mutate_nozzle_mapping(const char* request)
{
    using namespace Slic3r::Neo::Bridge;
    try { return Profiles::duplicate_json(NozzleMapping::mutate(nlohmann::json::parse(request ? request : "")).dump()); }
    catch (const std::exception& error) { return Profiles::duplicate_json(nlohmann::json{{"ok", false}, {"errorCode", "invalid_request"}, {"error", error.what()}}.dump()); }
    catch (...) { return Profiles::duplicate_json(nlohmann::json{{"ok", false}, {"errorCode", "native_exception"}, {"error", "Unknown mapping mutation failure"}}.dump()); }
}

// Harness-only inspection of derived Print state, never an editable input API.
extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_test_nozzle_mapping_slice(const char* plate_id)
{
    using namespace Slic3r::Neo::Bridge;
    const auto* entry = state().plate_runtime_registry.find(plate_id ? plate_id : "");
    if (!entry || !entry->print) return Profiles::duplicate_json("{\"ok\":false}");
    const auto& print = *entry->print;
    const auto& config = print.config();
    return Profiles::duplicate_json(nlohmann::json{{"ok", true}, {"filamentMap", print.get_filament_maps()},
        {"volumeMap", print.get_filament_volume_maps()}, {"nozzleMap", print.get_filament_nozzle_maps()},
        {"capacity", config.extruder_ams_count.values}, {"nozzle_temperature", config.nozzle_temperature.values}}.dump());
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_configure_nozzle_capacity_memory(const char* request)
{
    using namespace Slic3r::Neo::Bridge;
    try { return Profiles::duplicate_json(NozzleMapping::configure_memory(nlohmann::json::parse(request ? request : "")).dump()); }
    catch (const std::exception& error) { return Profiles::duplicate_json(nlohmann::json{{"ok", false}, {"error", error.what()}}.dump()); }
}

// Native published-import policy fixture; does not publish into the live session.
extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_test_nozzle_mapping_published()
{
    using namespace Slic3r;
    using namespace Slic3r::Neo::Bridge;
    try {
        auto candidate = state().presets;
        auto imported = PresetDrafts::effective_full_config_secure();
        imported.set_key_value("extruder_ams_count", new ConfigOptionStrings({"1#99", "1#99"}));
        PublishedConfig published;
        published.published = true;
        candidate.load_config_model("published-capacity-fixture", imported, Semver(), &published);
        return Profiles::duplicate_json(nlohmann::json{{"ok", true},
            {"capacity", NozzleMapping::decode_capacities(candidate.project_config, 2)}}.dump());
    } catch (const std::exception& error) {
        return Profiles::duplicate_json(nlohmann::json{{"ok", false}, {"error", error.what()}}.dump());
    }
}
