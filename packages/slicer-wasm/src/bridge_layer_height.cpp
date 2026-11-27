#include "bridge_model_operations.hpp"
#include "bridge_nozzle_mapping.hpp"
#include "bridge_plate.hpp"
#include "bridge_profiles.hpp"
#include "bridge_scoped_config.hpp"
#include "libslic3r/Print.hpp"
#include <emscripten/emscripten.h>

namespace Slic3r::Neo::Bridge::LayerHeight {
using json = nlohmann::json;

namespace {
ModelObject& target(const json& request)
{
    const auto& id = request.at("objectId");
    if (!id.is_number_unsigned()) throw std::invalid_argument("Invalid layer height object");
    auto* object = ModelOperations::find_object_by_id(id.get<size_t>());
    if (!object || object->instances.empty() || !(object->max_z() > 0))
        throw std::invalid_argument("Layer height object is unavailable");
    return *object;
}

SlicingParameters parameters(const ModelObject& object, const std::string& plate_id)
{
    const auto* plate = PlateSession::find_plate(plate_id);
    if (!plate) throw std::invalid_argument("Layer height plate is unavailable");
    auto config = NozzleMapping::full_config(plate_id, false);
    config.normalize_fdm();
    // Resolve the plate's effective nozzle variants and material shrinkage with
    // the native Print. Never repurpose a Print owned by an in-flight slice.
    Model model(state().model);
    model.curr_plate_index = plate->display_index;
    for (auto* member : model.objects)
        for (auto* instance : member->instances) {
            const auto it = state().instance_plate_ids.find(instance->id().id);
            instance->print_volume_state = it != state().instance_plate_ids.end() && it->second == plate_id
                ? ModelInstancePVS_Inside : ModelInstancePVS_Fully_Outside;
        }
    Print print;
    print.is_BBL_printer() = state().presets.is_bbl_vendor();
    print.set_plate_index(plate->display_index);
    print.set_plate_origin(plate->origin);
    print.apply(model, config);
    for (const PrintObject* item : print.objects())
        if (item->model_object()->id() == object.id())
            return item->slicing_parameters();
    // An unprintable or parked instance can still be edited in Prepare.
    return PrintObject::slicing_parameters(print.full_print_config(), object, object.max_z(),
                                            print.shrinkage_compensation());
}

std::vector<double> effective(const ModelObject& object, const SlicingParameters& params)
{
    std::vector<double> curve;
    PrintObject::update_layer_height_profile(object, params, curve);
    if (curve.size() < 4) throw std::invalid_argument("Object has no editable layer profile");
    return curve;
}

json stamp(const ModelObject& object, const std::string& plate_id)
{
    return {{"plateId", plate_id}, {"inputRevision", state().plate_input_revisions.at(plate_id)},
            {"profileRevision", object.layer_height_profile.timestamp()},
            {"historyRevision", state().history_revision}};
}

json snapshot(const ModelObject& object, const SlicingParameters& params, const std::vector<double>& curve,
              const std::string& plate_id)
{
    return {{"objectId", object.id().id}, {"stamp", stamp(object, plate_id)}, {"curve", curve},
            {"objectHeight", params.object_print_z_uncompensated_height()}, {"baseHeight", params.layer_height},
            {"minHeight", params.min_layer_height}, {"maxHeight", params.max_layer_height},
            {"firstHeight", params.first_object_layer_height}, {"canReset", !check_object_layers_fixed(params, curve)},
            {"hasSavedCurve", !object.layer_height_profile.empty()}};
}

json commit(ModelObject& object, const std::vector<double>& next)
{
    if (next == object.layer_height_profile.get()) return {{"ok", true}, {"changed", false}};
    std::set<size_t> instances;
    for (auto* instance : object.instances) instances.insert(instance->id().id);
    const auto plates = PlateSession::member_plate_ids_for_instances(instances);
    object.layer_height_profile.set(next);
    auto mutation = PlateSession::configuration_mutation_snapshot(plates, {"scoped-config"});
    mutation["native_scoped_config"] = ScopedConfig::native_scoped_config_full_transport(state().history_revision);
    return PlateSession::attach_plate_mutation({{"ok", true}, {"changed", true}}, mutation);
}

// A draft owns its inputs across Worker calls. It never retains a ModelObject
// pointer because opening a project or restoring history can replace the model.
struct Stroke {
    uint64_t id;
    size_t object_id;
    json revision;
    SlicingParameters params;
    std::vector<double> initial;
    std::vector<double> working;
};
std::optional<Stroke> stroke;
uint64_t last_stroke_id = 0;

json frame(const ModelObject& object, const SlicingParameters& params, const std::vector<double>& curve,
           const std::string& plate_id)
{
    constexpr int cols = 1024;
    const int rows = int(std::clamp(std::ceil(16. * params.object_print_z_height() /
                                    params.min_layer_height / (cols - 1)), 1., 1024.));
    const size_t bytes = size_t(rows) * cols * 4;
    auto layers = generate_object_layers(params, curve, false);
    auto pixels = std::unique_ptr<void, decltype(&std::free)>(std::calloc(1, bytes), &std::free);
    if (!pixels) throw std::bad_alloc();
    const int cells = generate_layer_height_texture(params, layers, pixels.get(), rows, cols, false);
    json result = {{"ok", true}, {"profile", snapshot(object, params, curve, plate_id)},
                   {"width", cols}, {"height", rows}, {"cells", cells},
                   {"pointer", reinterpret_cast<uintptr_t>(pixels.get())}};
    pixels.release();
    return result;
}

json brush(ModelObject& object, const std::string& plate_id, const json& request, const std::string& op)
{
    const auto revision = stamp(object, plate_id);
    if (op == "begin") {
        if (request.at("stamp") != revision) throw std::invalid_argument("Layer height target changed");
        auto params = parameters(object, plate_id);
        auto curve = effective(object, params);
        stroke.emplace(Stroke{++last_stroke_id, object.id().id, revision, params, curve, curve});
        return {{"ok", true}, {"strokeId", stroke->id}};
    }
    if (!stroke || request.at("strokeId") != stroke->id || stroke->object_id != object.id().id ||
        stroke->revision.at("plateId") != plate_id)
        throw std::invalid_argument("Unknown layer height stroke");
    if (op == "cancel") {
        stroke.reset();
        return {{"ok", true}};
    }
    if (stroke->revision != revision) {
        stroke.reset();
        throw std::invalid_argument("Layer height target changed");
    }
    if (op == "finish") {
        auto completed = std::move(*stroke);
        stroke.reset();
        if (completed.working == completed.initial) return {{"ok", true}, {"changed", false}};
        return commit(object, completed.working);
    }
    const auto& samples = request.at("samples");
    if (!samples.is_array() || samples.empty()) throw std::invalid_argument("Missing layer height samples");
    for (const auto& sample : samples) {
        const double z = sample.at("z").get<double>(), width = sample.at("width").get<double>();
        const auto& action = sample.at("action");
        if (!action.is_number_unsigned() || action > 3 || !std::isfinite(z) || width < 1.5 || width > 10)
            throw std::invalid_argument("Invalid layer height sample");
    }
    for (const auto& sample : samples) {
        const double z = sample.at("z"), width = sample.at("width");
        // Orca's resampler needs a preceding knot when the brush begins at
        // zero on a raft. Supply a temporary knot at negative epsilon.
        const bool pad = !stroke->params.first_object_layer_height_fixed() && z >= 0 && z <= width * 0.5;
        auto& curve = stroke->working;
        if (pad) {
            const auto first = curve[1];
            curve.insert(curve.begin(), {-EPSILON, first});
        }
        adjust_layer_height_profile(object, stroke->params, curve, z, double(0.005f), width,
                                    LayerHeightEditActionType(sample.at("action").get<unsigned>()));
        if (pad) curve.erase(curve.begin(), curve.begin() + 2);
    }
    return frame(object, stroke->params, stroke->working, plate_id);
}

json command(const json& request)
{
    auto& object = target(request);
    const auto plate_id = request.at("plateId").get<std::string>();
    if (!PlateSession::find_plate(plate_id)) throw std::invalid_argument("Layer height plate is unavailable");
    const auto op = request.at("operation").get<std::string>();
    if (op == "begin" || op == "samples" || op == "finish" || op == "cancel")
        return brush(object, plate_id, request, op);
    if (op != "read" && op != "preview" && request.at("stamp") != stamp(object, plate_id))
        throw std::invalid_argument("Layer height target changed");
    const auto params = parameters(object, plate_id);
    const auto curve = effective(object, params);
    if (op == "preview") return frame(object, params, curve, plate_id);
    if (op == "read") return {{"ok", true}, {"profile", snapshot(object, params, curve, plate_id)}};
    std::vector<double> next;
    if (op == "adaptive") {
        const double quality = request.at("quality").get<double>();
        if (!(quality >= 0 && quality <= 1)) throw std::invalid_argument("Invalid adaptive quality");
        next = layer_height_profile_adaptive(params, object, quality);
    } else if (op == "smooth") {
        const auto& radius = request.at("radius");
        if (!radius.is_number_unsigned() || radius < 1 || radius > 10)
            throw std::invalid_argument("Invalid smoothing radius");
        next = smooth_height_profile(curve, params, {radius.get<unsigned>(), request.at("keepMin").get<bool>()});
    } else if (op == "reset") {
        if (check_object_layers_fixed(params, curve)) throw std::invalid_argument("Layer height is fixed");
    } else throw std::invalid_argument("Unknown layer height operation");
    return commit(object, next);
}
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_layer_height(const char* encoded)
{
    try {
        return Profiles::duplicate_json(command(json::parse(encoded ? encoded : "")).dump());
    } catch (const std::exception& e) {
        return Profiles::error_json(e.what());
    }
}
}
