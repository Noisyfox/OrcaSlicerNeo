#include "bridge_mixed_filament.hpp"

#include "libslic3r/FilamentMixer.hpp"
#include "libslic3r/ColorDecomposeRecipe.hpp"
#include <cmath>
#include <numeric>
#include <sstream>

namespace Slic3r::Neo::Bridge::Filament::Mixes {

template<class Option> static auto read(const DynamicPrintConfig& config, const char* key, size_t index)
{
    const auto* option = config.opt<Option>(key);
    using Value = typename decltype(option->values)::value_type;
    return option && index < option->size() ? Value(option->values[index]) : Value{};
}

std::string material_type(const PresetBundle& bundle, size_t index)
{
    if (index >= bundle.filament_presets.size()) return {};
    const auto* preset = bundle.filaments.find_preset(bundle.filament_presets[index], false);
    if (!preset) return {};
    return read<ConfigOptionStrings>(preset->config, "filament_type", 0);
}

static std::string component_error(const PresetBundle& bundle, const std::vector<unsigned>& ids)
{
    if (ids.size() < 2 || ids.size() > 3) return "Choose two or three components.";
    std::set<unsigned> seen;
    std::string first;
    for (unsigned id : ids) {
        if (!id || id > State::material_slot_count(bundle.project_config) || bundle.is_mixed_filament(id - 1))
            return "Replace the missing filament.";
        if (!seen.insert(id).second) return "Choose distinct physical filaments.";
        const auto type = material_type(bundle, id - 1);
        if (type.empty() || (!first.empty() && first != type)) return "Choose filaments of the same material type.";
        first = type;
    }
    return {};
}

static GradientCurve curve_from_points(const json& points)
{
    GradientCurve curve;
    if (!points.is_array()) throw std::invalid_argument("Invalid gradient curve");
    for (const auto& point : points) {
        GradientAnchor p;
        p.x = point.at("x").get<double>();
        p.y = point.at("y").get<double>();
        if (!point.at("in").is_null()) p.m_in = point.at("in").get<double>();
        if (!point.at("out").is_null()) p.m_out = point.at("out").get<double>();
        if (!std::isfinite(p.x) || !std::isfinite(p.y) || p.x < 0 || p.x > 1 ||
            p.y < kGradientMinRatio || p.y > kGradientMaxRatio ||
            (!curve.empty() && p.x <= curve.points.back().x))
            throw std::invalid_argument("Invalid gradient control point");
        curve.points.push_back(p);
    }
    if (!curve.empty() && (curve.points.front().x != 0 || curve.points.back().x != 1))
        throw std::invalid_argument("Gradient endpoints must span the full height");
    return curve;
}

json recipe(const PresetBundle& bundle, size_t index)
{
    if (!bundle.is_mixed_filament(index)) return nullptr;
    const auto& cfg = bundle.project_config;
    const auto ids = parse_mixed_components(read<ConfigOptionStrings>(cfg, "filament_mixed_components", index));
    const auto fractions = parse_mixed_ratios(read<ConfigOptionStrings>(cfg, "filament_mixed_sublayer_ratios", index), ids.size());
    std::vector<int> ratios;
    for (double fraction : fractions) ratios.push_back(int(std::lround(fraction * 100)));
    if (!ratios.empty()) ratios.back() += 100 - std::accumulate(ratios.begin(), ratios.end(), 0);
    json points = json::array();
    for (const auto& p : parse_gradient_curve(read<ConfigOptionStrings>(cfg, "filament_mixed_gradient_curve", index)).points)
        points.push_back({{"x", p.x}, {"y", p.y}, {"in", p.m_in}, {"out", p.m_out}});
    const bool gradient = read<ConfigOptionBools>(cfg, "filament_mixed_gradient", index);
    const auto range = read<ConfigOptionStrings>(cfg, "filament_mixed_gradient_range", index);
    double bottom = .10, top = .90;
    if (!range.empty()) {
        std::istringstream stream(range);
        stream.imbue(std::locale::classic());
        char separator;
        double start, end;
        if (stream >> start >> separator >> end && separator == ',') {
            bottom = start;
            top = end;
        }
    }
    // Older 3MFs may carry only a linear range. Expose its actual endpoints
    // to the editor without synthesising a different curve on first edit.
    if (gradient && points.empty()) {
        points.push_back({{"x",0.0},{"y",bottom},{"in",nullptr},{"out",nullptr}});
        points.push_back({{"x",1.0},{"y",top},{"in",nullptr},{"out",nullptr}});
    }
    json result = {{"components", ids}, {"ratios", ratios}, {"gradient", gradient},
        {"reverse", gradient && bottom < top}, {"perPart", bool(read<ConfigOptionBools>(cfg, "filament_mixed_gradient_per_part", index))},
        {"points", points}, {"error", component_error(bundle, ids)}};
    if (result["error"] == "" && std::any_of(ratios.begin(), ratios.end(), [](int r) { return r < 10; }))
        result["error"] = "Each component needs at least 10%.";
    result["ramp"] = json::array();
    if (result["gradient"] == true && result["error"] == "") {
        try { result["ramp"] = preview(bundle, result)["ramp"]; }
        catch (const std::exception& e) { result["error"] = e.what(); }
    }
    return result;
}

json preview(const PresetBundle& bundle, const json& draft)
{
    const auto ids = draft.at("components").get<std::vector<unsigned>>();
    const auto error = component_error(bundle, ids);
    if (!error.empty()) throw std::invalid_argument(error);
    const auto& raw = draft.at("ratios");
    if (!raw.is_array() || raw.size() != ids.size() ||
        !std::all_of(raw.begin(), raw.end(), [](const json& v) { return v.is_number_integer() && v >= 10 && v <= 90; }))
        throw std::invalid_argument("Each component needs at least 10%.");
    const auto ratios = raw.get<std::vector<int>>();
    if (std::accumulate(ratios.begin(), ratios.end(), 0) != 100) throw std::invalid_argument("Ratios must total 100%.");
    const bool gradient = draft.at("gradient").get<bool>();
    const bool reverse = draft.at("reverse").get<bool>();
    const bool per_part = draft.at("perPart").get<bool>();
    auto curve = curve_from_points(draft.at("points"));
    if ((gradient && ids.size() != 2) || (!gradient && (per_part || !curve.empty())))
        throw std::invalid_argument("Gradients require two components.");
    std::vector<std::string> colours;
    for (unsigned id : ids) colours.push_back(read<ConfigOptionStrings>(bundle.project_config, "filament_colour", id - 1));
    json ramp = json::array(), samples = json::array();
    if (gradient) {
        if (curve.empty()) curve.points = {{0., reverse ? .1 : .9}, {1., reverse ? .9 : .1}};
        for (int i = 0; i <= 16; ++i) {
            const int weight = int(std::lround(10000 * sample_gradient_curve(curve, i / 16.)));
            samples.push_back(weight / 10000.0);
            ramp.push_back(blend_color_multi(colours, {weight, 10000 - weight}));
        }
    }
    return {{"colour", blend_color_multi(colours, ratios)}, {"ramp", ramp}, {"samples",samples}};
}

json decompose(PresetBundle& bundle, const json& query)
{
    const size_t source = query.at("source").get<size_t>();
    const std::string type = query.at("material").get<std::string>();
    const std::string method = query.at("method").get<std::string>();
    const size_t physical = bundle.num_physical_filaments();
    if (physical < 2 || source == 0 || source > physical)
        throw std::invalid_argument("Choose a physical filament in a rack with at least two materials.");
    const auto& cfg = bundle.project_config;
    const auto target_hex = read<ConfigOptionStrings>(cfg, "filament_colour", source-1);
    ColorDecomposeRgb target;
    if (!color_decompose_hex_to_rgb(target_hex, target)) throw std::invalid_argument("Invalid target colour.");
    std::vector<ColorDecomposePhysicalFilament> candidates;
    std::string base_preset;
    for (size_t i = 0; i < physical; ++i) {
        const auto& preset = bundle.filament_presets.at(i);
        auto category = material_type(bundle, i);
        if (preset.find("Bambu PLA Basic") != std::string::npos) category = "PLA Basic";
        if (category != type) continue;
        if (base_preset.empty()) base_preset = preset;
        if (i + 1 != source) candidates.push_back({read<ConfigOptionStrings>(cfg, "filament_colour", i),
            preset, type, false, static_cast<unsigned>(i+1)});
    }
    ColorDecomposeRecipeResult result;
    if (method == "project") {
        if (candidates.size() < 2) throw std::invalid_argument("Choose two other physical filaments of this type.");
        result = recommend_from_physical_filaments(target, candidates, type);
    } else {
        if (type != "PLA Basic" || (method != "CMYW" && method != "RYBW"))
            throw std::invalid_argument("The standard palettes require PLA Basic.");
        if (base_preset.empty()) {
            for (const auto& preset : bundle.filaments.get_presets())
                if (preset.is_compatible && preset.name.find("Bambu PLA Basic") != std::string::npos) {
                    base_preset = preset.name;
                    break;
                }
        }
        if (base_preset.empty()) throw std::invalid_argument("No compatible PLA Basic preset is available.");
        result = lookup_standard_recipe(target, method == "CMYW" ? ColorDecomposeRecipeMode::CMYW : ColorDecomposeRecipeMode::RYBW, type);
    }
    if (!result.valid || result.components.empty()) throw std::invalid_argument("No matching recipe was found.");
    if (result.components.size() == 1) throw std::invalid_argument("This colour already matches one filament.");
    json additions = json::array(), ids = json::array(), ratios = json::array();
    for (const auto& component : result.components) {
        size_t id = component.filament_index;
        if (!id) {
            ColorDecomposeRgb rgb;
            for (const auto& candidate : candidates)
                if (color_decompose_hex_to_rgb(candidate.color_hex, rgb) && color_decompose_rgb_to_hex(rgb) == component.color_hex) {
                    id = candidate.filament_index;
                    break;
                }
            if (!id) {
                additions.push_back({{"colour",component.color_hex},{"name",component.base_color},{"preset",base_preset}});
                id = physical + additions.size();
            }
        }
        ids.push_back(id);
        ratios.push_back(component.ratio);
    }
    std::string error;
    if (bundle.filament_presets.size() + additions.size() + 1 > size_t(EnforcerBlockerType::ExtruderMax))
        error = "The base filaments and mix would exceed 32 project slots.";
    else if (!additions.empty() && !State::supports_independent_materials(bundle.printers.get_edited_preset().config) && !bundle.is_bbl_vendor())
        error = "This printer cannot add the required physical slots.";
    return {{"target", target_hex}, {"matched", result.matched_color_hex}, {"additions", additions}, {"error",error},
        {"recipe", {{"components",ids},{"ratios",ratios},{"gradient",false},{"reverse",false},{"perPart",false},{"points",json::array()}}}};
}

json recommendations(const PresetBundle& bundle, int size)
{
    if (size != 2 && size != 3) throw std::invalid_argument("Choose two or three components.");
    std::map<std::string, std::vector<unsigned>> groups;
    for (size_t i = 0; i < State::material_slot_count(bundle.project_config); ++i) {
        const auto type = material_type(bundle, i);
        if (!bundle.is_mixed_filament(i) && !type.empty() && (type.size() < 2 || type.compare(type.size() - 2, 2, "-S") != 0))
            groups[type].push_back(i + 1);
    }
    json items = json::array();
    auto add = [&](const std::vector<unsigned>& ids, const std::vector<int>& ratios) {
        std::vector<std::string> colours;
        for (unsigned id : ids) colours.push_back(read<ConfigOptionStrings>(bundle.project_config, "filament_colour", id-1));
        items.push_back({{"components", ids}, {"ratios", ratios}, {"colour", blend_color_multi(colours, ratios)}});
    };
    for (const auto& [type, group] : groups)
        for (size_t i = 0; i < group.size() && items.size() < 100; ++i)
            for (size_t j = i+1; j < group.size() && items.size() < 100; ++j) {
                if (size == 2) add({group[i], group[j]}, {50,50});
                else for (size_t k = j+1; k < group.size() && items.size() < 100; ++k) {
                    for (size_t dominant = 0; dominant < 3 && items.size() < 100; ++dominant) {
                        std::vector<int> weights{25,25,25};
                        weights[dominant] = 50;
                        add({group[i],group[j],group[k]}, weights);
                    }
                }
            }
    return items;
}

template<class Option, class Value>
static void put(DynamicPrintConfig& cfg, const char* key, size_t index, const Value& value)
{
    auto& values = cfg.option<Option>(key, true)->values;
    values.resize(State::material_slot_count(cfg));
    values.at(index) = value;
}

void write(PresetBundle& bundle, size_t index, const json& draft, const json& preview)
{
    auto& cfg = bundle.project_config;
    const auto ids = draft.at("components").get<std::vector<unsigned>>();
    const bool gradient = draft.at("gradient");
    const bool reverse = draft.at("reverse");
    bundle.filament_presets[index] = bundle.filament_presets[ids.front() - 1];
    put<ConfigOptionBools>(cfg, "filament_is_mixed", index, true);
    put<ConfigOptionStrings>(cfg, "filament_mixed_components", index, format_mixed_components(ids));
    put<ConfigOptionStrings>(cfg, "filament_mixed_sublayer_ratios", index, format_mixed_ratios(draft.at("ratios").get<std::vector<int>>()));
    put<ConfigOptionBools>(cfg, "filament_mixed_gradient", index, gradient);
    put<ConfigOptionStrings>(cfg, "filament_mixed_gradient_range", index, gradient ? (reverse ? "0.1000,0.9000" : "0.9000,0.1000") : "");
    put<ConfigOptionStrings>(cfg, "filament_mixed_gradient_curve", index, serialize_gradient_curve(curve_from_points(draft.at("points"))));
    put<ConfigOptionBools>(cfg, "filament_mixed_gradient_per_part", index, draft.at("perPart").get<bool>());
    for (auto key : {"filament_colour","filament_multi_colour"})
        put<ConfigOptionStrings>(cfg, key, index, preview.at("colour").get<std::string>());
}

void refresh_colours(PresetBundle& bundle)
{
    auto& cfg = bundle.project_config;
    for (size_t i = 0; i < State::material_slot_count(cfg); ++i) {
        if (!bundle.is_mixed_filament(i)) continue;
        auto ids = parse_mixed_components(read<ConfigOptionStrings>(cfg, "filament_mixed_components", i));
        if (!component_error(bundle, ids).empty()) continue;
        std::vector<std::string> colours;
        for (auto id : ids) colours.push_back(read<ConfigOptionStrings>(cfg, "filament_colour", id - 1));
        std::vector<int> weights;
        for (auto v : parse_mixed_ratios(read<ConfigOptionStrings>(cfg, "filament_mixed_sublayer_ratios", i), ids.size()))
            weights.push_back(int(std::lround(v * 10000)));
        const auto mixed = blend_color_multi(colours, weights);
        for (auto key : {"filament_colour","filament_multi_colour"}) put<ConfigOptionStrings>(cfg, key, i, mixed);
        bundle.filament_presets[i] = bundle.filament_presets[ids.front()-1];
    }
}
} // namespace Slic3r::Neo::Bridge::Filament::Mixes
