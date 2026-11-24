#include "bridge_height_ranges.hpp"
#include "bridge_filament.hpp"
#include "bridge_model_operations.hpp"
#include "bridge_plate.hpp"
#include "bridge_profiles.hpp"
#include "bridge_scoped_config.hpp"

#include <emscripten/emscripten.h>

namespace Slic3r::Neo::Bridge::HeightRanges {
using json = nlohmann::json;

json rows(const ModelObject& object)
{
    json result = json::array();
    for (const auto& [bounds, config] : object.layer_config_ranges)
        result.push_back({{"min", bounds.first}, {"max", bounds.second}, {"revision", config.timestamp()},
                          {"values", Filament::State::config_metadata_json(config.get())}});
    return result;
}

namespace {
using Bounds = t_layer_height_range;

double number(const json& value)
{
    if (!value.is_number() || !std::isfinite(value.get<double>()))
        throw std::invalid_argument("Expected a finite number");
    return value.get<double>();
}

Bounds bounds_from(const json& row)
{
    return {number(row.at("min")), number(row.at("max"))};
}

std::vector<Bounds> resolve_selection(const json& request, const t_layer_config_ranges& ranges)
{
    const auto& rows = request.at("targets");
    if (!rows.is_array() || rows.empty()) throw std::invalid_argument("Select at least one height range");
    std::vector<Bounds> result;
    std::set<Bounds> seen;
    for (const auto& row : rows) {
        const auto key = bounds_from(row);
        auto it = ranges.find(key);
        if (it == ranges.end() || !row.at("revision").is_number_unsigned() ||
            it->second.timestamp() != row.at("revision").get<uint64_t>())
            throw std::invalid_argument("Height range changed since selection");
        if (!seen.insert(key).second) throw std::invalid_argument("Duplicate height range target");
        result.push_back(key);
    }
    return result;
}

double parent_height(const ModelObject& object)
{
    return (object.config.has("layer_height") ? object.config.get() :
        state().presets.prints.get_edited_preset().config).opt_float("layer_height");
}

DynamicPrintConfig defaults(const ModelObject& object)
{
    DynamicPrintConfig config;
    config.set_key_value("layer_height", new ConfigOptionFloat(parent_height(object)));
    config.set_key_value("extruder", new ConfigOptionInt(0));
    return config;
}

double printer_value(const char* key, int slot)
{
    const auto& printer = state().presets.printers.get_edited_preset().config;
    const auto* values = printer.opt<ConfigOptionFloats>(key);
    if (!values || values->empty()) throw std::invalid_argument(std::string("Missing printer option ") + key);
    return values->get_at(std::max(0, slot - 1));
}

Bounds add_after(t_layer_config_ranges& ranges, const Bounds& key, const ModelObject& object)
{
    Bounds added{key.second, key.second + 2};
    const auto next = std::next(ranges.find(key));
    if (next != ranges.end()) {
        const auto [low, high] = next->first;
        const double min_height = printer_value("min_layer_height", 0);
        if (key.second == low) {
            const double old_min = printer_value("min_layer_height", next->second.has("extruder") ? next->second.opt_int("extruder") : 0);
            const double span = high - low;
            if (span < min_height + old_min - EPSILON) throw std::invalid_argument("Height range is too short to split");
            added.second = min_height > span / 2 ? high - min_height : low + std::max(old_min, span / 2);
            auto previous = next->second;
            ranges.erase(next);
            ranges[{added.second, high}].assign_config(previous);
        } else {
            if (low < key.second || low - key.second < min_height - EPSILON)
                throw std::invalid_argument("Insufficient gap after this height range");
            added.second = low;
        }
    }
    ranges[added].assign_config(defaults(object));
    return added;
}

void edit_field(ModelConfig& config, const ModelObject& object, const json& request)
{
    const std::string op = request.at("operation");
    const std::string key = request.at("key");
    const bool filament = key == "extruder" || std::any_of(Filament::routing_options.begin(), Filament::routing_options.end(),
        [&](const auto& item) { return item.feature && key == item.key; });
    const auto* definition = print_config_def.get(key);
    static const PrintRegionConfig region;
    if (!definition || definition->readonly || (!filament && key != "layer_height" && !region.option(key)))
        throw std::invalid_argument("Unsupported height range option: " + key);
    if (op == "reset") {
        if (key == "layer_height") config.set_key_value(key, new ConfigOptionFloat(parent_height(object)));
        else if (key == "extruder") config.set_key_value(key, new ConfigOptionInt(0));
        else config.erase(key);
        return;
    }
    if (filament) {
        const auto& slot = request.at("value");
        if (!slot.is_number_unsigned() || slot.get<uint64_t>() > Filament::State::material_slot_count(state().presets.project_config))
            throw std::invalid_argument("Invalid height range filament slot");
        config.set_key_value(key, new ConfigOptionInt(slot.get<int>()));
    } else if (key == "layer_height") {
        const double height = number(request.at("value"));
        const int slot = config.has("extruder") ? config.opt_int("extruder") : 0;
        double max = printer_value("max_layer_height", slot);
        if (max < EPSILON) max = 0.75 * printer_value("nozzle_diameter", slot);
        if (height <= 0 || height < printer_value("min_layer_height", slot) || height > max)
            throw std::invalid_argument("Layer height is outside the printer limits");
        config.set_key_value(key, new ConfigOptionFloat(height));
    } else {
        const auto value = request.at("value").get<std::string>();
        DynamicPrintConfig candidate = config.get();
        ScopedConfig::set_scoped_value(candidate, key, value);
        config.assign_config(std::move(candidate));
    }
}

json edit(const json& request)
{
    const auto& id = request.at("objectId");
    if (!id.is_number_unsigned()) throw std::invalid_argument("Invalid object id");
    auto* object = ModelOperations::find_object_by_id(id.get<size_t>());
    if (!object) throw std::invalid_argument("Object no longer exists");
    auto candidate = object->layer_config_ranges;
    const std::string op = request.at("operation");
    std::vector<Bounds> selected;
    if (op == "initialize") {
        if (candidate.empty()) candidate[{0, 2}].assign_config(defaults(*object));
    } else if (op == "paste") {
        const auto& rows = request.at("rows");
        if (!rows.is_array() || rows.empty()) throw std::invalid_argument("No copied height ranges");
        for (const auto& row : rows) {
            const auto bounds = bounds_from(row);
            if (candidate.count(bounds)) continue;
            const auto& options = row.at("values");
            if (!options.is_object()) throw std::invalid_argument("Invalid copied height range");
            DynamicPrintConfig config;
            for (auto it = options.begin(); it != options.end(); ++it)
                config.set_deserialize_strict(it.key(), it.value().get<std::string>());
            candidate[bounds].assign_config(std::move(config));
            selected.push_back(bounds);
        }
    } else {
        selected = resolve_selection(request, candidate);
        if (op == "append" || op == "min" || op == "max") {
            if (selected.size() != 1) throw std::invalid_argument("Select one height range");
            const Bounds old = selected.front();
            if (op == "append") selected.front() = add_after(candidate, old, *object);
            else {
                const double value = number(request.at("value"));
                if (value < 0 || (op == "max" && value < old.first))
                    throw std::invalid_argument("Invalid height range endpoint");
                Bounds updated = op == "min" ? Bounds{value, value < old.second ? old.second : value + 0.5} : Bounds{old.first, value};
                if (std::abs(value - (op == "min" ? old.first : old.second)) >= EPSILON) {
                    auto config = candidate.at(old);
                    candidate.erase(old);
                    candidate[updated].assign_config(config);
                    selected.front() = updated;
                }
            }
        } else if (op == "remove") {
            for (const auto& key : selected) candidate.erase(key);
            selected.clear();
        } else if (op == "set" || op == "reset") {
            for (const auto& key : selected) edit_field(candidate.at(key), *object, request);
        } else throw std::invalid_argument("Unknown height range operation");
    }
    const auto& previous = object->layer_config_ranges;
    const bool changed = candidate.size() != previous.size() ||
        !std::equal(candidate.begin(), candidate.end(), previous.begin(), [](const auto& a, const auto& b) {
            return a.first == b.first && a.second.get() == b.second.get();
        });
    json selection = json::array();
    for (const auto& [min, max] : selected) selection.push_back({{"min", min}, {"max", max}});
    json result{{"ok", true}, {"changed", changed}, {"selection", std::move(selection)}};
    if (!changed) return result;

    std::set<size_t> instances;
    for (const auto* instance : object->instances) instances.insert(instance->id().id);
    const auto plates = PlateSession::member_plate_ids_for_instances(instances);
    object->layer_config_ranges.swap(candidate);
    object->config.touch();
    auto mutation = PlateSession::configuration_mutation_snapshot(plates, {"scoped-config"});
    mutation["native_scoped_config"] = ScopedConfig::native_scoped_config_full_transport(state().history_revision);
    return PlateSession::attach_plate_mutation(std::move(result), mutation);
}
}
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_edit_height_ranges(const char* encoded)
{
    using namespace Slic3r::Neo::Bridge;
    try {
        return Profiles::duplicate_json(HeightRanges::edit(nlohmann::json::parse(encoded ? encoded : "")).dump());
    } catch (const std::exception& error) {
        return Profiles::error_json(error.what());
    }
}
