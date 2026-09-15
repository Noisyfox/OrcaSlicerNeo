// Model editing and geometry operations for the Neo WASM bridge.
#include "bridge_model_operations.hpp"
#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <tuple>
#include <utility>
#include <emscripten/emscripten.h>
#include "bridge_buffers.hpp"
#include "bridge_plate.hpp"
#include "bridge_performance.hpp"
#include "bridge_prime_tower.hpp"
#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/TriangleMesh.hpp"
using namespace Slic3r;
using nlohmann::json;
using Neo::Bridge::state;
using Neo::Bridge::TransformHistoryRecord;
using namespace Neo::Bridge::ModelOperations;
using namespace Neo::Bridge::PlateSession;
namespace {
char* dup_json(const std::string& text) {
    char* result = static_cast<char*>(std::malloc(text.size() + 1));
    if (!result) return nullptr;
    std::memcpy(result, text.data(), text.size());
    result[text.size()] = '\0';
    return result;
}
char* error_json(const std::string& message) {
    return dup_json(json{{"ok", false}, {"error", message}}.dump());
}
void invalidate_preview_source() {
    auto& s = state();
    Neo::Bridge::PrimeTower::invalidate_projection_cache();
    ++s.preview_result_id;
    s.preview_gcode_path.clear();
    s.preview_gcode_size = 0;
    s.preview_gcode_line_ends.clear();
    s.preview_text_available = false;
    s.preview_plate_id.clear();
    s.preview_plate_revision = 0;
}
void invalidate_transform_delta_candidate() {
    if (state().active_history_transaction &&
        state().active_history_transaction->transform_delta_candidate)
        state().active_history_transaction->transform_delta_invalidated = true;
}
std::string sanitized_model_basename(const char* filename, const char* ext) {
    std::string name = filename ? filename : "";
    const auto slash = name.find_last_of("\\/");
    if (slash != std::string::npos) name.erase(0, slash + 1);
    for (char& c : name) {
        const unsigned char uc = static_cast<unsigned char>(c);
        if (!(std::isalnum(uc) || c == '.' || c == '_' || c == '-')) c = '_';
    }
    const std::string fallback_ext = ext && *ext ? ext : "stl";
    if (name.empty() || name == "." || name == "..") name = "uploaded_model." + fallback_ext;
    if (name.find_last_of('.') == std::string::npos) name += "." + fallback_ext;
    return name;
}
}
namespace Slic3r::Neo::Bridge::ModelOperations {
std::size_t model_instance_count(const Model& model) {
    std::size_t count = 0;
    for (const ModelObject* object : model.objects) count += object->instances.size();
    return count;
}
ModelObject* append_model_object_geometry(Model& destination, const ModelObject& source) {
    ModelObject* object = destination.add_object();
    object->name = source.name; object->module_name = source.module_name;
    object->input_file = source.input_file; object->printable = source.printable;
    object->origin_translation = source.origin_translation;
    if (const auto* extruder = dynamic_cast<const ConfigOptionInt*>(source.config.option("extruder"));
        extruder != nullptr && extruder->value > 0)
        object->config.set_key_value("extruder", new ConfigOptionInt(extruder->value));
    for (const ModelVolume* volume : source.volumes) {
        TriangleMesh empty_mesh;
        ModelVolume* added = object->add_volume(std::move(empty_mesh), volume->type());
        std::shared_ptr<const TriangleMesh> shared_mesh = volume->get_mesh_shared_ptr();
        added->set_mesh(shared_mesh); added->name = volume->name;
        added->source = volume->source; added->set_material_id(volume->material_id());
        added->set_transformation(volume->get_transformation());
    }
    for (const ModelInstance* instance : source.instances) object->add_instance(*instance);
    return object;
}
std::optional<std::size_t> to_object_id(const double v) {
    if (!std::isfinite(v) || v < 1.0 || std::floor(v) != v) return std::nullopt;
    return static_cast<std::size_t>(v);
}
std::optional<std::vector<std::size_t>> parse_positive_id_array(const json& j) {
    if (!j.is_array() || j.empty()) return std::nullopt;
    std::vector<std::size_t> out; out.reserve(j.size());
    for (const auto& item : j) {
        if (!item.is_number()) return std::nullopt;
        const double v = item.get<double>();
        if (!std::isfinite(v) || v < 1.0 || std::floor(v) != v) return std::nullopt;
        const std::size_t id = static_cast<std::size_t>(v);
        if (std::find(out.begin(), out.end(), id) == out.end()) out.push_back(id);
    }
    return out;
}
ModelObject* find_object_by_id(const std::size_t id) {
    for (auto& object : state().model.objects) if (object->id().id == id) return object;
    return nullptr;
}
ModelVolume* find_volume_by_id(const std::size_t id) {
    for (auto& object : state().model.objects)
        for (auto& volume : object->volumes) if (volume->id().id == id) return volume;
    return nullptr;
}
ModelInstance* find_instance_by_id(const std::size_t id) {
    for (auto& object : state().model.objects)
        for (auto& instance : object->instances) if (instance->id().id == id) return instance;
    return nullptr;
}
const char* volume_type_string(const ModelVolumeType type) {
    switch (type) {
        case ModelVolumeType::MODEL_PART: return "model_part";
        case ModelVolumeType::NEGATIVE_VOLUME: return "negative_volume";
        case ModelVolumeType::PARAMETER_MODIFIER: return "parameter_modifier";
        case ModelVolumeType::SUPPORT_BLOCKER: return "support_blocker";
        case ModelVolumeType::SUPPORT_ENFORCER: return "support_enforcer";
        default: return "model_part";
    }
}
std::optional<ModelVolumeType> volume_type_from_string(const std::string& value) {
    if (value == "model_part") return ModelVolumeType::MODEL_PART;
    if (value == "negative_volume") return ModelVolumeType::NEGATIVE_VOLUME;
    if (value == "parameter_modifier") return ModelVolumeType::PARAMETER_MODIFIER;
    if (value == "support_blocker") return ModelVolumeType::SUPPORT_BLOCKER;
    if (value == "support_enforcer") return ModelVolumeType::SUPPORT_ENFORCER;
    return std::nullopt;
}
json model_structure_json() {
    json objects = json::array();
    for (size_t oi = 0; oi < state().model.objects.size(); ++oi) {
        const auto& object = state().model.objects[oi];
        json volumes = json::array();
        for (size_t vi = 0; vi < object->volumes.size(); ++vi) {
            const auto& volume = object->volumes[vi];
            volumes.push_back(json{{"id", volume->id().id}, {"index", vi}, {"name", volume->name},
                {"type", volume_type_string(volume->type())}, {"isSplittable", volume->is_splittable()}});
        }
        json instances = json::array();
        for (size_t ii = 0; ii < object->instances.size(); ++ii) {
            const auto& instance = object->instances[ii];
            instances.push_back(json{{"id", instance->id().id}, {"index", ii}, {"printable", instance->printable}});
        }
        objects.push_back(json{{"id", object->id().id}, {"index", oi}, {"name", object->name},
            {"printable", object->printable}, {"instanceCount", object->instances.size()},
            {"volumes", std::move(volumes)}, {"instances", std::move(instances)}});
    }
    return objects;
}
}

extern "C" {

// Model bytes arrive in the WASM heap (JS: _malloc + HEAPU8 + _free).
// Stage them to a MEMFS file so the format loaders can open a real path.
EMSCRIPTEN_KEEPALIVE const char* orc_add_model(const char* data, int len, const char* ext, const char* filename) {
    try {
        invalidate_transform_delta_candidate();
        if (!data || len <= 0) return error_json("no model bytes");
        const std::string path = "/tmp/" + sanitized_model_basename(filename, ext);
        std::FILE* f = std::fopen(path.c_str(), "wb");
        if (!f) return error_json("cannot open /tmp for model upload");
        std::fwrite(data, 1, size_t(len), f);
        std::fclose(f);

        DynamicPrintConfig dummy;
        LoadStrategy model_strategy = LoadStrategy::AddDefaultInstances;
        std::string lower_ext = ext ? ext : "";
        std::transform(lower_ext.begin(), lower_ext.end(), lower_ext.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        // Model::read_from_file delegates .3mf to load_bbs_3mf.  The BBS
        // importer deliberately does nothing unless LoadModel is present;
        // Add Model remains geometry-only, but it must still request model
        // resources explicitly.
        if (lower_ext == "3mf")
            model_strategy = model_strategy | LoadStrategy::LoadModel;
        const bool is_step_file = lower_ext == "step" || lower_ext == "stp";
        Model imported;
        if (is_step_file) {
            // STEP is intentionally routed through the upstream OCCT reader.
            // Keep these defaults in the bridge contract: source units are
            // resolved by OCCT, meshing uses millimetre linear deflection and
            // the upstream angular value, and compounds remain atomic.
            imported = Model::read_from_step(path, model_strategy, nullptr,
                                              nullptr, {}, 0.003, 0.5, false);
            // read_from_step can return an empty model after cancellation and
            // the mesher can otherwise leave an object with no valid volume.
            // Treat either result as a failed transaction before touching the
            // live scene, preserving append and failure atomicity.
            if (imported.objects.empty() || std::any_of(imported.objects.begin(), imported.objects.end(),
                    [](const ModelObject* object) {
                        return object->volumes.empty() || std::any_of(object->volumes.begin(), object->volumes.end(),
                            [](const ModelVolume* volume) { return volume->mesh().empty(); });
                    }))
                throw Slic3r::RuntimeError("Loading of a model file failed.");
        } else if (lower_ext == "3mf") {
            // Keep Add Model on the native BBS reader, but avoid
            // Model::read_from_file's silent fallback context.  The latter
            // takes a different importer path in threaded wasm and can spin
            // while resolving a BBS archive; this explicit geometry-only
            // invocation is the same seam used by project loads.
            ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Enable};
            std::vector<PlateData*> plate_data_storage;
            std::vector<Preset*> project_presets;
            bool is_bbl_3mf = false;
            bool is_orca_3mf = false;
            Semver file_version;
            if (!load_bbs_3mf(path.c_str(), &dummy, &substitutions, &imported,
                              &plate_data_storage, &project_presets, &is_bbl_3mf,
                              &is_orca_3mf, &file_version, nullptr, model_strategy,
                              nullptr, 0))
                throw Slic3r::RuntimeError("Loading of a model file failed.");
            imported.add_default_instances();
            release_PlateData_list(plate_data_storage);
            for (Preset* preset : project_presets) delete preset;
        } else {
            imported = Model::read_from_file(path, &dummy, nullptr,
                                              model_strategy);
        }
        // The wxWidgets GUI is not compiled into the WASM build, so replicate
        // the Plater's post-load steps for non-project files (Plater.cpp
        // _load_files: per object center_around_origin(false) + ensure_on_bed
        // before the objects enter the plate): center each object's mesh
        // around the origin and rest it on the bed (min Z = 0). Without this
        // a model keeps its raw STL coordinates and its bbox center lands
        // wherever the file's own origin is — off the viewport origin. Like
        // the GUI, project files (3MF/AMF) keep their stored positions and
        // are NOT re-centered. center_around_origin shifts the volumes;
        // ensure_on_bed carries the Z drop in the instance offset
        // (auto_drop), which orc_get_model_mesh reports and the renderer
        // applies as the group position.
        {
            const bool is_project_file = lower_ext == "3mf" || lower_ext == "amf";
            if (!is_project_file) {
                for (ModelObject* o : imported.objects) {
                    o->center_around_origin(false);
                    o->ensure_on_bed(false);
                }
            }
        }
        // Preserve the current scene: only after parsing and preparing the
        // complete incoming file succeeds do we copy its objects into the
        // live Model. Model::add_object clones the object and rebinds it to
        // the destination model, so the temporary can be destroyed safely.
        const auto* current_plate = find_plate(state().current_plate_id);
        const PlateBounds placement_bounds = selected_plate_bounds();
        const Vec3d placement_center = current_plate
            ? Vec3d(current_plate->origin.x() + (placement_bounds.min_x + placement_bounds.max_x) * 0.5,
                    current_plate->origin.y() + (placement_bounds.min_y + placement_bounds.max_y) * 0.5,
                    current_plate->origin.z())
            : Vec3d::Zero();
        std::map<std::size_t, Vec3d> added_instances;
        for (const ModelObject* o : imported.objects) {
            if (lower_ext == "3mf")
                {
                    ModelObject* added = append_model_object_geometry(state().model, *o);
                    for (ModelInstance* instance : added->instances) {
                        const auto offset = instance->get_offset();
                        instance->set_offset(Vec3d(placement_center.x(), placement_center.y(), offset.z()));
                        added_instances[instance->id().id] = Vec3d::Zero();
                    }
                }
            else
                {
                    ModelObject* added = state().model.add_object(*o);
                    for (ModelInstance* instance : added->instances) {
                        const auto offset = instance->get_offset();
                        instance->set_offset(Vec3d(placement_center.x(), placement_center.y(), offset.z()));
                        added_instances[instance->id().id] = Vec3d::Zero();
                    }
                }
        }
        rebuild_plate_membership(true);
        // A model mutation makes any existing Print/G-code result stale.
        state().print.clear();
        invalidate_preview_source();
        // Drift at the pinned SHA: Model has no instance accessor — instances
        // live per-object (ModelObject::instances, Model.hpp:385; Model itself
        // only has the objects list, Model.hpp:1553-1560). Sum per object.
        size_t instance_count = 0;
        for (const ModelObject* o : state().model.objects)
            instance_count += o->instances.size();
        std::set<std::size_t> added_instance_ids;
        for (const auto& [instance_id, _] : added_instances) added_instance_ids.insert(instance_id);
        const auto mutation = plate_mutation_snapshot({}, {"model-import"},
                                                       reflow_instance_transforms(added_instances),
                                                       &added_instance_ids);
        return dup_json(attach_plate_mutation(json{{"ok", true},
                             {"objects",   state().model.objects.size()},
                             {"instances", instance_count}}, mutation).dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}


// OrcaSlicer primitives are created in the engine and added to the model
// directly (ObjectList::load_shape_object → create_mesh → load_mesh_object),
// never through a file: no staging, no basename-derived names, no extension.
// Mirror that here: the mesh is built with the same libslic3r builders and
// the same step angles as Orca's create_mesh (GUI_ObjectList.cpp), and the
// object and its single part are named after the primitive label — the six
// shapes the scene menu's "Add Primitive" submenu offers. The GUI canvas
// helpers (nearest-empty-cell placement, cooling orientation, snapshot) are
// not compiled into the WASM build, so the shape lands at the current scene
// origin, resting on the bed — the same result the staged STL import used
// to produce.
EMSCRIPTEN_KEEPALIVE const char* orc_add_shape(const char* type, const char* name) {
    try {
        invalidate_transform_delta_candidate();
        const auto* current_plate = find_plate(state().current_plate_id);
        const PlateBounds placement_bounds = selected_plate_bounds();
        const Vec3d placement_center = current_plate
            ? Vec3d(current_plate->origin.x() + (placement_bounds.min_x + placement_bounds.max_x) * 0.5,
                    current_plate->origin.y() + (placement_bounds.min_y + placement_bounds.max_y) * 0.5,
                    current_plate->origin.z())
            : Vec3d::Zero();
        const std::string type_str = type ? type : "";
        const std::string object_name = (name && *name) ? name : type_str;
        // App-sized primitive: OrcaSlicer sizes shapes at 10% of the max bed
        // size (get_size_proportional_to_max_bed_size); keep the app's
        // established 20 mm so primitives render like the well-tested cube
        // path. Orca's create_mesh proportions from `side` are preserved.
        const double side = 20.0;
        TriangleMesh mesh;
        if (type_str == "Cube")
            mesh = TriangleMesh(its_make_cube(side, side, side));
        else if (type_str == "Cylinder")
            mesh = TriangleMesh(its_make_cylinder(0.5 * side, side));
        else if (type_str == "Sphere")
            mesh = TriangleMesh(its_make_sphere(0.5 * side, PI / 90));
        else if (type_str == "Cone")
            mesh = TriangleMesh(its_make_cone(0.5 * side, side));
        else if (type_str == "Disc")
            mesh = TriangleMesh(its_make_cylinder(0.5 * side, 0.2f));
        else if (type_str == "Torus")
            mesh = TriangleMesh(its_make_torus(0.5 * side, 0.125 * side, PI / 60));
        else
            return error_json("unsupported primitive type: " + type_str);
        const BoundingBoxf3 bb = mesh.bounding_box();

        ModelObject* new_object = state().model.add_object();
        new_object->name = object_name;
        new_object->add_instance(); // each object should have at least one instance
        ModelVolume* new_volume = new_object->add_volume(mesh);
        new_object->sort_volumes(true);
        new_volume->name = object_name;
        // The primitive has no per-object settings: default the extruder so
        // slicing assigns it without a provider (load_mesh_object does this
        // for the same reason).
        new_object->config.set_key_value("extruder", new ConfigOptionInt(1));
        new_object->invalidate_bounding_box();
        // load_mesh_object centers the freshly built 0..side mesh (its
        // add_volume already centered the volume mesh and re-offset the
        // volume; the object translate cancels that offset), then rests the
        // object on the bed. The empty-cell step is a canvas helper
        // (get_nearest_empty_cell at the build-volume center) — the shared
        // renderer's scene origin plays the same role here.
        new_object->translate(-bb.center());
        new_object->instances[0]->set_offset(Slic3r::Vec3d(placement_center.x(), placement_center.y(),
                                                            -new_object->origin_translation.z()));
        new_object->ensure_on_bed();
        // A model mutation makes any existing Print/G-code result stale.
        state().print.clear();
        invalidate_preview_source();
        size_t instance_count = 0;
        for (const ModelObject* o : state().model.objects)
            instance_count += o->instances.size();
        rebuild_plate_membership(true);
        const std::set<std::size_t> added_instances{new_object->instances[0]->id().id};
        const auto mutation = plate_mutation_snapshot({}, {"model-import"},
            reflow_instance_transforms({{new_object->instances[0]->id().id, Vec3d::Zero()}}), &added_instances);
        return dup_json(attach_plate_mutation(json{{"ok", true},
                             {"objects",   state().model.objects.size()},
                             {"instances", instance_count}}, mutation).dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

// Explicit scene reset for the renderer's Clear Scene action. Resetting the
// model rather than merely hiding meshes guarantees that the next slice and
// export operate on an empty plate.
EMSCRIPTEN_KEEPALIVE const char* orc_clear_model() {
    try {
        invalidate_transform_delta_candidate();
        const auto affected_before = member_plate_ids();
        state().print.clear();
        invalidate_preview_source();
        state().mesh_capture_cache.clear();
        state().mutable_object_capture_cache.clear();
        state().model = Model{};
        reset_plate_session_state();
        const auto mutation = plate_mutation_snapshot(affected_before, {"model-clear"});
        return dup_json(attach_plate_mutation(json{{"ok", true}}, mutation).dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Delete whole objects by their stable ObjectIDs (spec §9.2). The renderer
// selection and object list use IDs, not positional indices — a structural
// mutation elsewhere cannot silently shift the target. All IDs are validated
// before any mutation so a bad request leaves the scene intact.
EMSCRIPTEN_KEEPALIVE const char* orc_delete_objects(const char* object_ids_json) {
    try {
        invalidate_transform_delta_candidate();
        const json j = json::parse(object_ids_json ? object_ids_json : "");
        const auto ids = parse_positive_id_array(j);
        if (!ids) return error_json("no object ids");
        // Validate every ID resolves, so a malformed request does not partially delete.
        for (const std::size_t id : *ids)
            if (find_object_by_id(id) == nullptr)
                return error_json("object not found");
        std::set<std::size_t> affected_instances;
        for (const std::size_t id : *ids) {
            const auto* object = find_object_by_id(id);
            for (const auto* instance : object->instances) affected_instances.insert(instance->id().id);
        }
        const auto affected_before = member_plate_ids_for_instances(affected_instances);
        for (const std::size_t id : *ids)
            state().model.delete_object(ObjectID(id));
        rebuild_plate_membership(true);
        state().print.clear();
        invalidate_preview_source();
        const auto mutation = plate_mutation_snapshot(affected_before, {"model-delete"},
                                                       json::array(), &affected_instances);
        return dup_json(attach_plate_mutation(json{{"ok", true},
                             {"objects", state().model.objects.size()},
                             {"deleted", ids->size()}}, mutation).dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

// Delete specific parts (volumes) by their stable ObjectIDs. Enforces the
// upstream last-solid-part guard: a volume that is the only MODEL_PART of its
// object cannot be deleted. All IDs are resolved and guarded before any
// mutation, so a bad request leaves the scene intact.
EMSCRIPTEN_KEEPALIVE const char* orc_delete_volumes(const char* volume_ids_json) {
    try {
        invalidate_transform_delta_candidate();
        const json j = json::parse(volume_ids_json ? volume_ids_json : "");
        const auto ids = parse_positive_id_array(j);
        if (!ids) return error_json("no volume ids");
        std::vector<std::pair<ModelObject*, ModelVolume*>> targets;
        for (const std::size_t id : *ids) {
            ModelVolume* vol = find_volume_by_id(id);
            if (vol == nullptr) return error_json("volume not found");
            if (vol->is_the_only_one_part())
                return error_json("deleting the last solid part is not allowed");
            targets.emplace_back(vol->get_object(), vol);
        }
        std::set<std::size_t> affected_instances;
        for (const auto& [object, _] : targets)
            for (const auto* instance : object->instances) affected_instances.insert(instance->id().id);
        const auto affected_before = member_plate_ids_for_instances(affected_instances);
        // delete_volume(idx) shifts the object's own volume indices, so group
        // by object and remove in descending index order within each object.
        std::map<ModelObject*, std::vector<std::size_t>> by_object;
        for (const auto& [obj, vol] : targets) {
            for (std::size_t vi = 0; vi < obj->volumes.size(); ++vi)
                if (obj->volumes[vi] == vol) { by_object[obj].push_back(vi); break; }
        }
        for (auto& [obj, indexes] : by_object) {
            std::sort(indexes.rbegin(), indexes.rend());
            for (const std::size_t idx : indexes)
                obj->delete_volume(idx);
            obj->config.touch();
        }
        rebuild_plate_membership(true);
        state().print.clear();
        invalidate_preview_source();
        const auto mutation = plate_mutation_snapshot(affected_before, {"model-delete"},
                                                       json::array(), &affected_instances);
        return dup_json(attach_plate_mutation(json{{"ok", true},
                             {"objects", state().model.objects.size()},
                             {"deleted", ids->size()}}, mutation).dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Clone whole objects by stable ObjectIDs. libslic3r's add_object(const
// ModelObject&) performs ModelObject::new_clone, assigning fresh recursive IDs
// to the clone. The new stable IDs are returned so the renderer can restore
// selection to the cloned objects (spec §9.2).
EMSCRIPTEN_KEEPALIVE const char* orc_clone_objects(const char* object_ids_json) {
    try {
        invalidate_transform_delta_candidate();
        const json j = json::parse(object_ids_json ? object_ids_json : "");
        const auto ids = parse_positive_id_array(j);
        if (!ids) return error_json("no object ids");
        std::vector<std::size_t> new_object_ids;
        for (const std::size_t id : *ids) {
            ModelObject* obj = find_object_by_id(id);
            if (obj == nullptr) return error_json("object not found");
            ModelObject* clone = state().model.add_object(*obj);
            new_object_ids.push_back(clone->id().id);
        }
        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true},
                             {"newObjectIds", new_object_ids},
                             {"objects", state().model.objects.size()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Reorder the plate/list by a stable ObjectID and a DESTINATION INDEX. The
// object with `from_obj_id` is moved so it sits at `to_index` (0-based) in the
// final list; `to_index == object_count` (or anything >= count) appends it at
// the end. Returns the current structure for a single refresh round-trip.
EMSCRIPTEN_KEEPALIVE const char* orc_reorder_objects(double from_obj_id, double to_index) {
    try {
        invalidate_transform_delta_candidate();
        const auto from_id = to_object_id(from_obj_id);
        if (!from_id) return error_json("object id must be a positive integer");
        if (to_index < 0) return error_json("target index must be >= 0");
        auto& objs = state().model.objects;
        const std::size_t count = objs.size();
        std::size_t from_idx = count;
        for (std::size_t i = 0; i < count; ++i)
            if (objs[i]->id().id == *from_id) { from_idx = i; break; }
        if (from_idx == count) return error_json("object not found");
        const std::size_t dest = static_cast<std::size_t>(to_index);
        // Destination final index; to_index == count (or beyond) appends last.
        const std::size_t target = dest >= count ? count - 1 : dest;
        if (from_idx != target) {
            ModelObject* from_obj = objs[from_idx];
            objs.erase(objs.begin() + static_cast<std::ptrdiff_t>(from_idx));
            objs.insert(objs.begin() + static_cast<std::ptrdiff_t>(target), from_obj);
        }
        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true}, {"objects", model_structure_json()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Reorder parts within an object by a stable volume ID and a DESTINATION INDEX.
// `to_index == volume_count` (or beyond) appends the part at the end; otherwise
// it is moved so it sits at `to_index` in the final list.
EMSCRIPTEN_KEEPALIVE const char* orc_reorder_volumes(double object_id, double from_volume_id, double to_index) {
    try {
        invalidate_transform_delta_candidate();
        const auto obj_id = to_object_id(object_id);
        const auto from_id = to_object_id(from_volume_id);
        if (!obj_id || !from_id) return error_json("id must be a positive integer");
        if (to_index < 0) return error_json("target index must be >= 0");
        ModelObject* obj = find_object_by_id(*obj_id);
        if (obj == nullptr) return error_json("object not found");
        auto& vols = obj->volumes;
        const std::size_t count = vols.size();
        std::size_t from_idx = count;
        for (std::size_t i = 0; i < count; ++i)
            if (vols[i]->id().id == *from_id) { from_idx = i; break; }
        if (from_idx == count) return error_json("volume not found");
        const std::size_t dest = static_cast<std::size_t>(to_index);
        const std::size_t target = dest >= count ? count - 1 : dest;
        if (from_idx != target) {
            ModelVolume* from_vol = vols[from_idx];
            vols.erase(vols.begin() + static_cast<std::ptrdiff_t>(from_idx));
            vols.insert(vols.begin() + static_cast<std::ptrdiff_t>(target), from_vol);
            obj->config.touch();
        }
        obj->invalidate_bounding_box();
        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true}, {"objects", model_structure_json()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Split a volume into its disconnected parts (upstream ModelVolume::split).
// libslic3r assigns a NEW unique ID to the original volume and creates new
// volume(s) for the remaining shells, so the caller's volumeId is now stale.
// Return the freshly generated volume IDs plus the current structure so the
// renderer can clear stale selection and re-read (spec §8 mutation flow).
EMSCRIPTEN_KEEPALIVE const char* orc_split_volume_to_parts(double volume_id, double max_extruders, double remap_paint) {
    try {
        invalidate_transform_delta_candidate();
        const auto id = to_object_id(volume_id);
        if (!id) return error_json("volume id must be a positive integer");
        ModelVolume* vol = find_volume_by_id(*id);
        if (vol == nullptr) return error_json("volume not found");
        if (!vol->is_splittable()) return error_json("volume is not splittable");

        ModelObject* obj = vol->get_object();
        // Capture the object's current volume IDs so the generated part IDs can
        // be computed after the split (the original is re-IDed, so it is "new").
        std::vector<std::size_t> before_ids;
        for (const ModelVolume* v : obj->volumes)
            before_ids.push_back(v->id().id);

        const unsigned int max_ext = max_extruders > 0.0
            ? static_cast<unsigned int>(max_extruders) : 1u;
        const std::size_t parts = vol->split(max_ext, remap_paint != 0.0);
        obj->config.touch();

        std::vector<std::size_t> new_volume_ids;
        for (const ModelVolume* v : obj->volumes)
            if (std::find(before_ids.begin(), before_ids.end(), v->id().id) == before_ids.end())
                new_volume_ids.push_back(v->id().id);

        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true},
                             {"parts", parts},
                             {"newVolumeIds", new_volume_ids},
                             {"objects", model_structure_json()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Split an object into one object per disconnected shell (upstream
// ObjectList::split_to_objects). ModelObject::split adds the new objects to the
// live model and fills new_objects; the bridge then removes the source object.
// Returns the freshly generated object IDs plus the current structure so the
// renderer can restore selection to the new objects. autoDrop is accepted for
// signature parity (the spec exposes it) but the auto_drop bed-drop has no
// first-version UI and is left to the host callers.
EMSCRIPTEN_KEEPALIVE const char* orc_split_object_to_objects(double object_id, double auto_drop) {
    try {
        invalidate_transform_delta_candidate();
        const auto id = to_object_id(object_id);
        if (!id) return error_json("object id must be a positive integer");
        ModelObject* obj = find_object_by_id(*id);
        if (obj == nullptr) return error_json("object not found");
        const bool splittable = obj->volumes.size() > 1
            || (obj->volumes.size() == 1 && obj->volumes[0]->is_splittable());
        if (!splittable) return error_json("object is not splittable");

        ModelObjectPtrs new_objects;
        obj->split(&new_objects, /*remap_paint=*/false);
        // Remove the source; the split objects now own the geometry.
        state().model.delete_object(ObjectID(*id));

        std::vector<std::size_t> new_object_ids;
        for (const ModelObject* o : new_objects)
            new_object_ids.push_back(o->id().id);

        if (auto_drop != 0.0)
            state().model.adjust_min_z();

        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true},
                             {"newObjectIds", new_object_ids},
                             {"objects", state().model.objects.size()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Assemble objects into a single multipart object (upstream ObjectList::merge
// "Assemble"). Each source object's volumes are copied into a new object, with
// the source's first-instance transform composed into each volume transform; the
// new object carries one instance. Returns the new object's stable ID.
EMSCRIPTEN_KEEPALIVE const char* orc_merge_objects_to_multipart(const char* object_ids_json, const char* name_cstr) {
    try {
        invalidate_transform_delta_candidate();
        const json j = json::parse(object_ids_json ? object_ids_json : "");
        const auto ids = parse_positive_id_array(j);
        if (!ids) return error_json("no object ids");
        std::vector<ModelObject*> sources;
        for (const std::size_t id : *ids) {
            ModelObject* obj = find_object_by_id(id);
            if (obj == nullptr) return error_json("object not found");
            sources.push_back(obj);
        }

        auto& model = state().model;
        ModelObject* new_obj = model.add_object();
        new_obj->name = (name_cstr && *name_cstr) ? name_cstr : "Assembly";

        bool first_instance = true;
        for (ModelObject* src : sources) {
            if (first_instance) {
                // A single instance whose (identity) transform is combined into
                // each volume's matrix below.
                new_obj->add_instance();
                first_instance = false;
            }
            const Transform3d src_matrix =
                src->instances.empty() ? Transform3d::Identity()
                                       : src->instances[0]->get_transformation().get_matrix();
            for (const ModelVolume* vol : src->volumes) {
                ModelVolume* new_vol = new_obj->add_volume(*vol);
                new_vol->set_transformation(src_matrix * new_vol->get_matrix());
            }
        }
        if (first_instance) {
            // No source volume/instance path executed (all sources had no volumes);
            // give the assembly a single default instance so it is renderable.
            new_obj->add_instance();
        }
        new_obj->sort_volumes(true);

        // Remove the source objects from the live model.
        std::sort(sources.begin(), sources.end());
        sources.erase(std::unique(sources.begin(), sources.end()), sources.end());
        for (ModelObject* src : sources)
            model.delete_object(src);

        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true},
                             {"objectId", new_obj->id().id},
                             {"objects", model.objects.size()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Separate selected instances into individual objects (upstream
// ObjectList::instances_to_separated_objects for the selected instances). Each
// selected instance becomes a new object carrying a copy of the source volumes
// and a single copied instance (preserving the instance transform). The selected
// instances are then removed from the source object.
EMSCRIPTEN_KEEPALIVE const char* orc_instances_to_separate_objects(double object_id, const char* instance_ids_json) {
    try {
        invalidate_transform_delta_candidate();
        const auto id = to_object_id(object_id);
        if (!id) return error_json("object id must be a positive integer");
        ModelObject* obj = find_object_by_id(*id);
        if (obj == nullptr) return error_json("object not found");
        const auto ids = parse_positive_id_array(json::parse(instance_ids_json ? instance_ids_json : ""));
        if (!ids || ids->empty()) return error_json("no instance ids");

        // Validate every instance ID resolves before mutating.
        std::vector<std::size_t> to_remove;
        to_remove.reserve(ids->size());
        for (const std::size_t iid : *ids) {
            bool found = false;
            for (std::size_t i = 0; i < obj->instances.size(); ++i)
                if (obj->instances[i]->id().id == iid) { to_remove.push_back(i); found = true; break; }
            if (!found) return error_json("instance not found");
        }

        std::vector<std::size_t> new_object_ids;
        for (const std::size_t iid : *ids) {
            ModelInstance* src_inst = nullptr;
            for (ModelInstance* inst : obj->instances)
                if (inst->id().id == iid) { src_inst = inst; break; }
            ModelObject* clone = state().model.add_object();
            clone->name = obj->name;
            for (const ModelVolume* vol : obj->volumes)
                clone->add_volume(*vol);
            clone->add_instance(*src_inst);
            new_object_ids.push_back(clone->id().id);
        }

        // Remove the selected instances from the source (descending index).
        std::sort(to_remove.rbegin(), to_remove.rend());
        for (const std::size_t i : to_remove)
            obj->delete_instance(i);
        obj->config.touch();

        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true},
                             {"newObjectIds", new_object_ids},
                             {"objects", state().model.objects.size()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Add a new instance to an object. libslic3r's add_instance() (no args) stacks
// it at the object origin (identity), overlapping instance 0 — which reads as
// "nothing happened". Place it visibly to the right of the existing instances
// (object width + a gap, along X) so the copy is immediately visible and can be
// moved. Returns the new stable instance ID.
EMSCRIPTEN_KEEPALIVE const char* orc_add_instance(double object_id) {
    try {
        invalidate_transform_delta_candidate();
        const auto id = to_object_id(object_id);
        if (!id) return error_json("object id must be a positive integer");
        ModelObject* obj = find_object_by_id(*id);
        if (obj == nullptr) return error_json("object not found");
        const BoundingBoxf3& bbox = obj->bounding_box_exact();
        const double width = static_cast<double>(bbox.size().x());
        const double step = width > 0.0 ? width + 30.0 : 30.0;
        const Slic3r::Vec3d base = obj->instances.empty()
            ? Slic3r::Vec3d(0, 0, 0)
            : obj->instances.back()->get_offset();
        ModelInstance* inst = obj->add_instance();
        inst->set_offset(Slic3r::Vec3d(base.x() + step, base.y(), base.z()));
        obj->config.touch();
        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true},
                             {"objectId", obj->id().id},
                             {"instanceId", inst->id().id}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Remove a specific instance from an object by stable ID. The last remaining
// instance cannot be removed (an object must keep at least one instance).
EMSCRIPTEN_KEEPALIVE const char* orc_remove_instance(double object_id, double instance_id) {
    try {
        invalidate_transform_delta_candidate();
        const auto id = to_object_id(object_id);
        const auto iid = to_object_id(instance_id);
        if (!id || !iid) return error_json("id must be a positive integer");
        ModelObject* obj = find_object_by_id(*id);
        if (obj == nullptr) return error_json("object not found");
        if (obj->instances.size() <= 1) return error_json("cannot remove the last instance");
        for (std::size_t i = 0; i < obj->instances.size(); ++i) {
            if (obj->instances[i]->id().id == *iid) {
                obj->delete_instance(i);
                obj->config.touch();
                state().print.clear();
                invalidate_preview_source();
                return dup_json(json{{"ok", true}}.dump());
            }
        }
        return error_json("instance not found");
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}


// ---- model triangle meshes + GUI transform synchronization ----

static json transform_json(const Slic3r::Geometry::Transformation& t) {
    const auto offset = t.get_offset();
    const auto rotation = t.get_rotation();
    const auto scale = t.get_scaling_factor();
    const auto mirror = t.get_mirror();
    const Slic3r::Matrix4d m = t.get_matrix().matrix();
    json j = {{"offset", {offset.x(), offset.y(), offset.z()}},
            {"rotation", {rotation.x(), rotation.y(), rotation.z()}},
            {"scale", {scale.x(), scale.y(), scale.z()}},
            {"mirror", {mirror.x(), mirror.y(), mirror.z()}}};
    // Emit the full affine matrix (column-major, three.js layout) so a
    // sheared transform survives a JS-side load/reload round-trip. The TRS
    // fields remain for clean transforms and the gizmo/panel display.
    j["matrix"] = {m(0,0), m(1,0), m(2,0), m(3,0),
                   m(0,1), m(1,1), m(2,1), m(3,1),
                   m(0,2), m(1,2), m(2,2), m(3,2),
                   m(0,3), m(1,3), m(2,3), m(3,3)};
    return j;
}

static Slic3r::Vec3d transform_vec3(const json& transform, const char* key) {
    const auto& v = transform.at(key);
    if (!v.is_array() || v.size() != 3)
        throw std::runtime_error(std::string("transform.") + key + " must be a 3-vector");
    return Slic3r::Vec3d(v[0].get<double>(), v[1].get<double>(), v[2].get<double>());
}

static void set_transform(Slic3r::Geometry::Transformation& target, const json& transform) {
    // A full matrix is authoritative — it can carry shear that T·R·S cannot.
    // set_matrix stores the matrix verbatim; get_rotation/get_scaling_factor
    // below decompose it for display, and the slicer consumes get_matrix().
    if (transform.contains("matrix") && transform["matrix"].is_array()) {
        const auto& a = transform["matrix"];
        if (a.size() != 16)
            throw std::runtime_error("transform.matrix must be 16 numbers");
        Slic3r::Matrix4d m;
        for (int col = 0; col < 4; ++col)
            for (int row = 0; row < 4; ++row)
                m(row, col) = a[col * 4 + row].get<double>();
        target.set_matrix(Slic3r::Transform3d(m));
        return;
    }
    target.set_offset(transform_vec3(transform, "offset"));
    target.set_rotation(transform_vec3(transform, "rotation"));
    target.set_scaling_factor(transform_vec3(transform, "scale"));
    target.set_mirror(transform_vec3(transform, "mirror"));
}

// Translation changes plate membership, which is handled by the plate
// mutation snapshot. The Prime Tower estimate also depends on the object's
// shape, so invalidate a same-plate projection only when the affine linear
// part changes (rotation, scale, mirror, or shear).
static bool transform_geometry_changed(const Slic3r::Geometry::Transformation& before,
                                       const Slic3r::Geometry::Transformation& after)
{
    const auto before_matrix = before.get_matrix().matrix();
    const auto after_matrix = after.get_matrix().matrix();
    for (int column = 0; column < 3; ++column)
        for (int row = 0; row < 3; ++row)
            if (before_matrix(row, column) != after_matrix(row, column)) return true;
    // XY translation is invariant for the plate-local tower dimensions and
    // footprint offsets. Z translation is not: the model height used by the
    // estimate can change, so keep it in the invalidation proof.
    return before_matrix(2, 3) != after_matrix(2, 3);
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_instance_offset(int object_idx, int instance_idx, double x, double y, double z) {
    try {
        invalidate_transform_delta_candidate();
        auto& model = state().model;
        if (object_idx < 0 || object_idx >= static_cast<int>(model.objects.size()))
            return error_json("object index out of range");
        auto& obj = model.objects[static_cast<size_t>(object_idx)];
        if (instance_idx < 0 || instance_idx >= static_cast<int>(obj->instances.size()))
            return error_json("instance index out of range");
        // Drift surface: ModelInstance::set_offset(Vec3d) — confirm at SHA.
        auto* instance = obj->instances[static_cast<size_t>(instance_idx)];
        const auto previous = instance->get_offset();
        const auto affected_before = member_plate_ids_for_instances({instance->id().id});
        instance->set_offset(Slic3r::Vec3d(x, y, z));
        if (previous != instance->get_offset()) obj->config.touch();
        if (previous.z() != instance->get_offset().z())
            Neo::Bridge::PrimeTower::invalidate_projection_cache(affected_before);
        state().pending_membership_instance_ids.insert(instance->id().id);
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_model_transform(
    int object_idx, int volume_idx, int instance_idx,
    const char* instance_transform_json, const char* volume_transform_json) {
    try {
        auto& model = state().model;
        if (object_idx < 0 || object_idx >= static_cast<int>(model.objects.size()))
            return error_json("object index out of range");
        auto& object = model.objects[static_cast<size_t>(object_idx)];
        if (volume_idx < 0 || volume_idx >= static_cast<int>(object->volumes.size()))
            return error_json("volume index out of range");
        if (instance_idx < 0 || instance_idx >= static_cast<int>(object->instances.size()))
            return error_json("instance index out of range");
        auto instance_transform = json::parse(instance_transform_json ? instance_transform_json : "");
        auto volume_transform = json::parse(volume_transform_json ? volume_transform_json : "");
        auto instance = object->instances[static_cast<size_t>(instance_idx)]->get_transformation();
        auto volume = object->volumes[static_cast<size_t>(volume_idx)]->get_transformation();
        const auto previous_instance = instance;
        const auto previous_volume = volume;
        const auto affected_before = member_plate_ids_for_instances({
            object->instances[static_cast<size_t>(instance_idx)]->id().id});
        set_transform(instance, instance_transform);
        set_transform(volume, volume_transform);
        object->instances[static_cast<size_t>(instance_idx)]->set_transformation(instance);
        object->volumes[static_cast<size_t>(volume_idx)]->set_transformation(volume);
        if (instance != previous_instance || volume != previous_volume) object->config.touch();
        object->invalidate_bounding_box();
        if (transform_geometry_changed(previous_instance, instance) ||
            transform_geometry_changed(previous_volume, volume))
            Neo::Bridge::PrimeTower::invalidate_projection_cache(affected_before);
        // Slicing synchronizes every rendered composite before starting the
        // job. Re-emitting an identical transform is not an editing
        // transaction and must not advance a plate's input revision; doing
        // so would make retained results on other plates look stale merely
        // because Preview switched plates and started its target slice.
        if (instance != previous_instance || volume != previous_volume)
            state().pending_membership_instance_ids.insert(
                object->instances[static_cast<size_t>(instance_idx)]->id().id);
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Apply a complete renderer gesture as one Worker mutation.  The application
// intentionally sends every affected CompositeID together: validate the full
// request and the transaction revision first, then publish all transforms and
// one plate-session receipt, or leave the live model untouched.
EMSCRIPTEN_KEEPALIVE const char* orc_set_model_transforms(
    const char* transaction_id_cstr, const char* transforms_json)
{
    struct StagedTransform {
        ModelObject* object;
        ModelInstance* instance;
        ModelVolume* volume;
        Slic3r::Geometry::Transformation next_instance;
        Slic3r::Geometry::Transformation next_volume;
        Slic3r::Geometry::Transformation previous_instance;
        Slic3r::Geometry::Transformation previous_volume;
    };
    try {
        const double profile_started_at = Neo::Bridge::Performance::now_ms();
        const std::string transaction_id = transaction_id_cstr ? transaction_id_cstr : "";
        auto& active = state().active_history_transaction;
        if (!active || active->id != transaction_id)
            return error_json("history transaction is stale or belongs to another writer");
        if (active->base_history_revision != state().history_revision)
            return error_json("history transaction revision is stale");

        const double input_decode_started_at = Neo::Bridge::Performance::now_ms();
        const json requests = json::parse(transforms_json ? transforms_json : "");
        const double input_decode_finished_at = Neo::Bridge::Performance::now_ms();
        if (!requests.is_array() || requests.empty())
            return error_json("transforms must be a non-empty array");

        const double validation_started_at = Neo::Bridge::Performance::now_ms();
        std::vector<StagedTransform> staged;
        staged.reserve(requests.size());
        std::set<std::tuple<int, int, int>> identities;
        for (const auto& request : requests) {
            if (!request.is_object()) return error_json("transform request must be an object");
            const int object_idx = request.at("objectIdx").get<int>();
            const int volume_idx = request.at("volumeIdx").get<int>();
            const int instance_idx = request.at("instanceIdx").get<int>();
            if (!identities.emplace(object_idx, volume_idx, instance_idx).second)
                return error_json("transform request contains a duplicate composite id");
            auto& model = state().model;
            if (object_idx < 0 || object_idx >= static_cast<int>(model.objects.size()))
                return error_json("object index out of range");
            auto* object = model.objects[static_cast<size_t>(object_idx)];
            if (volume_idx < 0 || volume_idx >= static_cast<int>(object->volumes.size()))
                return error_json("volume index out of range");
            if (instance_idx < 0 || instance_idx >= static_cast<int>(object->instances.size()))
                return error_json("instance index out of range");
            auto next_instance = object->instances[static_cast<size_t>(instance_idx)]->get_transformation();
            auto next_volume = object->volumes[static_cast<size_t>(volume_idx)]->get_transformation();
            set_transform(next_instance, request.at("instanceTransform"));
            set_transform(next_volume, request.at("volumeTransform"));
            staged.push_back({object, object->instances[static_cast<size_t>(instance_idx)],
                object->volumes[static_cast<size_t>(volume_idx)], next_instance, next_volume,
                object->instances[static_cast<size_t>(instance_idx)]->get_transformation(),
                object->volumes[static_cast<size_t>(volume_idx)]->get_transformation()});
        }
        std::set<std::size_t> affected_instances;
        for (const auto& item : staged) {
            if (item.next_instance != item.previous_instance || item.next_volume != item.previous_volume)
                affected_instances.insert(item.instance->id().id);
        }
        const double validation_finished_at = Neo::Bridge::Performance::now_ms();

        const double membership_lookup_started_at = Neo::Bridge::Performance::now_ms();
        const auto before_out_of_bounds = state().plate_out_of_bounds_ids;
        const auto affected_before = affected_instances.empty()
            ? std::set<std::string>{} : member_plate_ids_for_instances(affected_instances);
        const bool projection_geometry_changed = std::any_of(staged.begin(), staged.end(),
            [](const StagedTransform& item) {
                return transform_geometry_changed(item.previous_instance, item.next_instance) ||
                    transform_geometry_changed(item.previous_volume, item.next_volume);
            });
        const double membership_lookup_finished_at = Neo::Bridge::Performance::now_ms();
        const double mutation_started_at = Neo::Bridge::Performance::now_ms();
        const std::size_t transform_record_count_before = active->transform_records.size();
        const bool transform_delta_mutated_before = active->transform_delta_mutated;
        try {
            for (const auto& item : staged) {
                item.instance->set_transformation(item.next_instance);
                item.volume->set_transformation(item.next_volume);
                item.object->invalidate_bounding_box();
                if (item.next_instance != item.previous_instance || item.next_volume != item.previous_volume)
                    item.object->config.touch();
            }
            if (projection_geometry_changed)
                Neo::Bridge::PrimeTower::invalidate_projection_cache(affected_before);
            const double mutation_finished_at = Neo::Bridge::Performance::now_ms();
            const double membership_reflow_started_at = Neo::Bridge::Performance::now_ms();
            rebuild_plate_membership(true);
            if (active->transform_delta_candidate) {
                for (const auto& item : staged) {
                    if (item.next_instance == item.previous_instance && item.next_volume == item.previous_volume)
                        continue;
                    const auto object_id = item.object->id().id;
                    const auto volume_id = item.volume->id().id;
                    const auto instance_id = item.instance->id().id;
                    auto it = std::find_if(active->transform_records.begin(), active->transform_records.end(),
                        [&](const TransformHistoryRecord& record) {
                            return record.object_id == object_id && record.volume_id == volume_id &&
                                record.instance_id == instance_id;
                    });
                    if (it == active->transform_records.end()) {
                        const auto object_index = static_cast<std::size_t>(std::distance(
                            state().model.objects.begin(),
                            std::find(state().model.objects.begin(), state().model.objects.end(), item.object)));
                        const auto volume_index = static_cast<std::size_t>(std::distance(
                            item.object->volumes.begin(),
                            std::find(item.object->volumes.begin(), item.object->volumes.end(), item.volume)));
                        const auto instance_index = static_cast<std::size_t>(std::distance(
                            item.object->instances.begin(),
                            std::find(item.object->instances.begin(), item.object->instances.end(), item.instance)));
                        active->transform_records.push_back({
                            object_index, volume_index, instance_index,
                            object_id, volume_id, instance_id,
                            item.previous_instance, item.next_instance,
                            item.previous_volume, item.next_volume});
                    } else {
                        it->after_instance = item.next_instance;
                        it->after_volume = item.next_volume;
                        if (it->after_instance == it->before_instance && it->after_volume == it->before_volume)
                            active->transform_records.erase(it);
                    }
                }
                active->transform_delta_mutated = !active->transform_records.empty();
            }
            const auto mutation = plate_mutation_snapshot(affected_before, {"model-transform"},
                                                           json::array(), &affected_instances, &before_out_of_bounds);
            const double membership_reflow_finished_at = Neo::Bridge::Performance::now_ms();
            const double response_started_at = Neo::Bridge::Performance::now_ms();
            const std::string response = mutation.dump();
            char* result = dup_json(response);
            const double response_finished_at = Neo::Bridge::Performance::now_ms();
            Neo::Bridge::Performance::record("set_model_transforms", {
                {"input_json_decode", input_decode_finished_at - input_decode_started_at},
                {"request_validation_target_resolution", validation_finished_at - validation_started_at},
                {"transform_mutation", mutation_finished_at - mutation_started_at},
                {"plate_membership_reflow", (membership_lookup_finished_at - membership_lookup_started_at) +
                    (membership_reflow_finished_at - membership_reflow_started_at)},
                {"response_json_serialization", response_finished_at - response_started_at},
                {"total", Neo::Bridge::Performance::now_ms() - profile_started_at},
            });
            return result;
        } catch (...) {
            for (const auto& item : staged) {
                item.instance->set_transformation(item.previous_instance);
                item.volume->set_transformation(item.previous_volume);
                item.object->invalidate_bounding_box();
                if (item.next_instance != item.previous_instance || item.next_volume != item.previous_volume)
                    item.object->config.touch();
            }
            if (active->transform_delta_candidate) {
                active->transform_records.resize(transform_record_count_before);
                active->transform_delta_mutated = transform_delta_mutated_before;
            }
            throw;
        }
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Read-only model structure: objects, their parts (volumes), and instances.
// Returns stable ObjectIDs (for React keys and selection restoration) plus
// current positional indices (for operation dispatch and display). Read-only,
// so it does not invalidate the current Print.
EMSCRIPTEN_KEEPALIVE const char* orc_get_model_structure() {
    try {
        return dup_json(json{{"ok", true}, {"objects", model_structure_json()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// -------------------------------------------------------------------------
// Step 2: non-destructive model metadata operations (stable ObjectID input).
// Every successful mutation invalidates the current Print/G-code result so
// the renderer cannot continue to display a stale slice. Resolving by stable
// IDs (rather than positional indices) means a structural mutation elsewhere
// cannot silently target the wrong entity — see spec/ObjectList-and-Parts.md §7.
// -------------------------------------------------------------------------

EMSCRIPTEN_KEEPALIVE const char* orc_rename_object(double object_id, const char* name_cstr) {
    try {
        invalidate_transform_delta_candidate();
        const auto id = to_object_id(object_id);
        if (!id) return error_json("object id must be a positive integer");
        if (name_cstr == nullptr) return error_json("name is required");
        ModelObject* obj = find_object_by_id(*id);
        if (obj == nullptr) return error_json("object not found");
        obj->name = name_cstr;
        obj->config.touch();
        // A rename does not change geometry, but it does change the object's
        // reported name; the existing Print/G-code is still considered stale.
        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_rename_volume(double volume_id, const char* name_cstr) {
    try {
        invalidate_transform_delta_candidate();
        const auto id = to_object_id(volume_id);
        if (!id) return error_json("volume id must be a positive integer");
        if (name_cstr == nullptr) return error_json("name is required");
        ModelVolume* vol = find_volume_by_id(*id);
        if (vol == nullptr) return error_json("volume not found");
        vol->name = name_cstr;
        vol->get_object()->config.touch();
        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_volume_type(double volume_id, const char* type_cstr) {
    try {
        invalidate_transform_delta_candidate();
        const auto id = to_object_id(volume_id);
        if (!id) return error_json("volume id must be a positive integer");
        if (type_cstr == nullptr) return error_json("type is required");
        const auto new_type = volume_type_from_string(type_cstr);
        if (!new_type) return error_json("invalid volume type");
        ModelVolume* vol = find_volume_by_id(*id);
        if (vol == nullptr) return error_json("volume not found");
        // Upstream last-solid-part guard (GUI_ObjectList): refuse to turn the
        // only MODEL_PART into a non-print volume.
        if (*new_type != ModelVolumeType::MODEL_PART && vol->is_the_only_one_part())
            return error_json("changing the last solid part is not allowed");
        vol->set_type(*new_type);
        vol->get_object()->config.touch();
        // The type changes which volumes compose the print mesh; drop the cached
        // object bounds so a later getModelMesh / slice recomputes them.
        vol->get_object()->invalidate_bounding_box();
        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_object_printable(double object_id, double printable) {
    try {
        invalidate_transform_delta_candidate();
        const auto id = to_object_id(object_id);
        if (!id) return error_json("object id must be a positive integer");
        ModelObject* obj = find_object_by_id(*id);
        if (obj == nullptr) return error_json("object not found");
        // Object row toggles are an aggregate: set the object-level gate AND
        // every instance so the per-instance rows and ModelInstance::is_printable()
        // stay consistent (model_object->printable is an extra gate that would
        // otherwise disagree with the per-instance flags).
        const bool value = printable != 0.0;
        obj->printable = value;
        for (auto& inst : obj->instances)
            inst->printable = value;
        obj->config.touch();
        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_instance_printable(double instance_id, double printable) {
    try {
        invalidate_transform_delta_candidate();
        const auto id = to_object_id(instance_id);
        if (!id) return error_json("instance id must be a positive integer");
        ModelInstance* inst = find_instance_by_id(*id);
        if (inst == nullptr) return error_json("instance not found");
        inst->printable = printable != 0.0;
        inst->get_object()->config.touch();
        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_model_mesh() {
    try {
        auto& model = state().model;
        json arr = json::array();
        for (size_t oi = 0; oi < model.objects.size(); ++oi) {
            const auto& obj = model.objects[oi];
            // LOCAL (volume-transformed, instance-untouched) vertices: the
            // instance offset is reported separately below and the renderer
            // applies it as the group position. Baking instance transforms
            // here (ModelObject::mesh()) double-offsets the model after any
            // committed move + reload — a zero offset hid it at load time
            // (see the mock-module contract comment).
            for (size_t vi = 0; vi < obj->volumes.size(); ++vi) {
                const auto& its = obj->volumes[vi]->mesh().its;
                for (size_t ii = 0; ii < obj->instances.size(); ++ii) {
                    MallocBuffer vbuf;
                    MallocBuffer ibuf;
                    for (const auto& v : its.vertices) {
                        vbuf.appendF32(v.x()); vbuf.appendF32(v.y()); vbuf.appendF32(v.z());
                    }
                    for (const auto& tri : its.indices) {
                        ibuf.appendU32(static_cast<std::uint32_t>(tri[0]));
                        ibuf.appendU32(static_cast<std::uint32_t>(tri[1]));
                        ibuf.appendU32(static_cast<std::uint32_t>(tri[2]));
                    }
                    const std::uintptr_t vptr = reinterpret_cast<std::uintptr_t>(vbuf.data);
                    const std::uintptr_t iptr = reinterpret_cast<std::uintptr_t>(ibuf.data);
                    vbuf.release(); ibuf.release();
                    const auto& instance = obj->instances[ii]->get_transformation();
                    const auto& volume = obj->volumes[vi]->get_transformation();
                    arr.push_back(json{{"object_idx", oi}, {"volume_idx", vi}, {"instance_idx", ii},
                        {"vertex_ptr", vptr}, {"vertex_count", its.vertices.size()},
                        {"index_ptr", iptr}, {"index_count", its.indices.size() * 3},
                        {"offset", {instance.get_offset().x(), instance.get_offset().y(), instance.get_offset().z()}},
                        {"instance_transform", transform_json(instance)},
                        {"volume_transform", transform_json(volume)}});
                }
            }
        }
        return dup_json(json{{"ok", true}, {"objects", std::move(arr)}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

} // extern "C"
