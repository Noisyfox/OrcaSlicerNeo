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

json command(const json& request)
{
    auto& object = target(request);
    const auto plate_id = request.at("plateId").get<std::string>();
    if (!PlateSession::find_plate(plate_id)) throw std::invalid_argument("Layer height plate is unavailable");
    const auto op = request.at("operation").get<std::string>();
    if (op != "read" && request.at("stamp") != stamp(object, plate_id))
        throw std::invalid_argument("Layer height target changed");
    const auto params = parameters(object, plate_id);
    const auto curve = effective(object, params);
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
