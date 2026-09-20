#define CEREAL_FUTURE_EXPERIMENTAL

#include "InstanceIdentity.hpp"

#include <iostream>
#include <map>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include <cereal/archives/adapters.hpp>
#include <cereal/archives/binary.hpp>
#include <cereal/types/base_class.hpp>
#include <cereal/types/map.hpp>
#include <cereal/types/memory.hpp>
#include <cereal/types/optional.hpp>
#include <cereal/types/polymorphic.hpp>
#include <cereal/types/string.hpp>
#include <cereal/types/vector.hpp>

#include "libslic3r/Model.hpp"
#include "libslic3r/TriangleMesh.hpp"

#define CHECK(condition) do { \
    if (!(condition)) { \
        std::cerr << "Instance identity test failed: " #condition << "\n"; \
        return 1; \
    } \
} while (false)

#define CHECK_THROWS(statement) do { \
    bool threw = false; \
    try { statement; } catch (const std::runtime_error&) { threw = true; } \
    CHECK(threw); \
} while (false)

namespace {

struct ArchiveContext {
    std::map<const Slic3r::TriangleMesh*, std::string> output_mesh_keys;
    std::map<std::string, std::shared_ptr<const Slic3r::TriangleMesh>> input_meshes;
};

using OutputArchive = cereal::UserDataAdapter<ArchiveContext, cereal::BinaryOutputArchive>;
using InputArchive = cereal::UserDataAdapter<ArchiveContext, cereal::BinaryInputArchive>;

} // namespace

namespace cereal {

inline void save(BinaryOutputArchive& archive,
                 const std::shared_ptr<const Slic3r::TriangleMesh>& mesh)
{
    if (!mesh) {
        archive(std::string{});
        return;
    }
    const auto& keys = cereal::get_user_data<ArchiveContext>(archive).output_mesh_keys;
    const auto it = keys.find(mesh.get());
    if (it == keys.end()) throw std::runtime_error("test mesh reference is unavailable");
    archive(it->second);
}

inline void load(BinaryInputArchive& archive,
                 std::shared_ptr<const Slic3r::TriangleMesh>& mesh)
{
    std::string key;
    archive(key);
    if (key.empty()) {
        mesh.reset();
        return;
    }
    const auto& meshes = cereal::get_user_data<ArchiveContext>(archive).input_meshes;
    const auto it = meshes.find(key);
    if (it == meshes.end()) throw std::runtime_error("test mesh data is unavailable");
    mesh = it->second;
}

template<class T>
inline void save(BinaryOutputArchive& archive, T* const& object)
{
    const bool present = object != nullptr;
    archive(present);
    if (present) archive(*object);
}

template<class T>
inline void load(BinaryInputArchive& archive, T*& object)
{
    bool present = false;
    archive(present);
    object = present ? cereal::access::construct<T>() : nullptr;
    if (object) archive(*object);
}

template<class T>
inline void save_by_value(BinaryOutputArchive& archive, const T& value)
{
    archive(value);
}

template<class T>
inline void load_by_value(BinaryInputArchive& archive, T& value)
{
    archive(value);
}

template<class T>
inline void save_optional(BinaryOutputArchive& archive, const std::shared_ptr<const T>&)
{
    archive(false);
}

template<class T>
inline void load_optional(BinaryInputArchive& archive, std::shared_ptr<const T>& value)
{
    bool present = false;
    archive(present);
    if (present) archive(value);
    else value.reset();
}

template <class Archive> struct specialize<Archive, Slic3r::ModelInstance*, specialization::non_member_load_save> {};
template <class Archive> struct specialize<Archive, Slic3r::ModelVolume*, specialization::non_member_load_save> {};
template <class Archive> struct specialize<Archive, std::shared_ptr<const Slic3r::TriangleMesh>, specialization::non_member_load_save> {};

} // namespace cereal

namespace {

using Slic3r::ModelObject;
using Slic3r::ModelVolume;
using Slic3r::ObjectBase;
using Slic3r::ObjectID;
using Slic3r::TriangleMesh;
using Slic3r::Neo::History::InstanceIDs;

template<class T>
void restore_object_base_id(T& object, const ObjectID id)
{
    std::ostringstream output(std::ios::binary | std::ios::out);
    cereal::BinaryOutputArchive writer(output);
    writer(id);
    const std::string bytes = output.str();
    std::istringstream input(bytes, std::ios::binary | std::ios::in);
    cereal::BinaryInputArchive reader(input);
    reader(cereal::base_class<ObjectBase>(&object));
}

void materialize_volumes(ModelObject& object, const std::vector<ObjectID>& ids,
                         ArchiveContext& context)
{
    if (ids.size() != object.volumes.size())
        throw std::runtime_error("test volume identity count does not match object");

    std::vector<std::string> payloads;
    payloads.reserve(object.volumes.size());
    for (const ModelVolume* volume : object.volumes) {
        std::ostringstream output(std::ios::binary | std::ios::out);
        OutputArchive archive(context, output);
        archive(*volume);
        payloads.push_back(output.str());
    }

    const std::size_t decoded_count = object.volumes.size();
    for (std::size_t index = 0; index < decoded_count; ++index)
        object.delete_volume(0);
    for (std::size_t index = 0; index < decoded_count; ++index) {
        ModelVolume* materialized = object.add_volume(
            TriangleMesh(), Slic3r::ModelVolumeType::MODEL_PART, false);
        std::istringstream input(payloads[index], std::ios::binary | std::ios::in);
        InputArchive archive(context, input);
        archive(*materialized);
        restore_object_base_id(*materialized, ids[index]);
    }
}

} // namespace

int main()
{
    using namespace Slic3r;
    using Slic3r::Neo::History::InstanceIdentityGraph;

    Model source;
    ModelObject* object = source.add_object();
    ModelVolume* volume = object->add_volume(
        TriangleMesh(its_make_cube(20.0, 20.0, 20.0)));
    volume->supported_facets.set_triangle_from_string(0, "1C");
    volume->seam_facets.set_triangle_from_string(1, "2");
    volume->mmu_segmentation_facets.set_triangle_from_string(2, "3A");
    volume->fuzzy_skin_facets.set_triangle_from_string(3, "4");

    ModelInstance* first = object->add_instance();
    Geometry::Transformation first_transform;
    first_transform.set_offset(Vec3d(11.0, 12.0, 13.0));
    first_transform.set_rotation(Vec3d(0.1, 0.2, 0.3));
    first_transform.set_scaling_factor(Vec3d(1.1, 1.2, 1.3));
    first_transform.set_mirror(Vec3d(-1.0, 1.0, 1.0));
    first->set_transformation(first_transform);
    Geometry::Transformation assembly_transform;
    assembly_transform.set_offset(Vec3d(21.0, 22.0, 23.0));
    assembly_transform.set_rotation(Vec3d(0.4, 0.5, 0.6));
    first->set_assemble_transformation(assembly_transform);
    first->set_offset_to_assembly(Vec3d(31.0, 32.0, 33.0));
    first->print_volume_state = ModelInstancePVS_Partly_Outside;
    first->printable = false;
    first->auto_drop = false;

    ModelInstance* second = object->add_instance();
    Geometry::Transformation second_transform;
    second_transform.set_offset(Vec3d(-4.0, -5.0, 6.0));
    second_transform.set_rotation(Vec3d(0.7, 0.8, 0.9));
    second->set_transformation(second_transform);
    second->print_volume_state = ModelInstancePVS_Limited;

    const ObjectID object_id = object->id();
    const std::vector<ObjectID> volume_ids { volume->id() };
    InstanceIdentityGraph capture_graph;
    const InstanceIDs instance_ids = capture_graph.capture(*object);
    CHECK(instance_ids.size() == 2);
    CHECK(capture_graph.size() == 2);

    ArchiveContext context;
    const auto mesh = volume->get_mesh_shared_ptr();
    context.output_mesh_keys.emplace(mesh.get(), "mesh-0");
    context.input_meshes.emplace("mesh-0", mesh);

    std::ostringstream output(std::ios::binary | std::ios::out);
    OutputArchive output_archive(context, output);
    output_archive(*object);

    Model restored;
    ModelObject* restored_object = restored.add_object();
    const std::string bytes = output.str();
    std::istringstream input(bytes, std::ios::binary | std::ios::in);
    InputArchive input_archive(context, input);
    input_archive(*restored_object);

    CHECK(restored_object->id() == object_id);
    CHECK(restored_object->volumes.size() == 1);
    CHECK(restored_object->instances.size() == 2);
    CHECK(restored_object->volumes.front()->id().invalid());
    CHECK(restored_object->instances[0]->id().invalid());
    CHECK(restored_object->instances[1]->id().invalid());

    for (const auto& [key, retained_mesh] : context.input_meshes)
        context.output_mesh_keys.emplace(retained_mesh.get(), key);
    materialize_volumes(*restored_object, volume_ids, context);

    InstanceIDs invalid_ids = instance_ids;
    invalid_ids[0] = ObjectID(0);
    InstanceIdentityGraph restore_graph;
    CHECK_THROWS(restore_graph.restore(*restored_object, invalid_ids));
    CHECK(restore_graph.size() == 0);
    CHECK(restored_object->instances[0]->id().invalid());

    InstanceIDs duplicate_ids = instance_ids;
    duplicate_ids[1] = duplicate_ids[0];
    CHECK_THROWS(restore_graph.restore(*restored_object, duplicate_ids));
    CHECK(restore_graph.size() == 0);
    CHECK(restored_object->instances[1]->id().invalid());

    restore_graph.restore(*restored_object, instance_ids);
    CHECK(restore_graph.size() == 2);
    CHECK(restored_object->id() == object_id);
    CHECK(restored_object->volumes.front()->id() == volume_ids.front());
    CHECK(restored_object->instances[0]->id() == instance_ids[0]);
    CHECK(restored_object->instances[1]->id() == instance_ids[1]);

    const ModelInstance* restored_first = restored_object->instances[0];
    const ModelInstance* restored_second = restored_object->instances[1];
    CHECK(restored_first->get_transformation().get_matrix().isApprox(
        first->get_transformation().get_matrix()));
    CHECK(restored_first->get_assemble_transformation().get_matrix().isApprox(
        first->get_assemble_transformation().get_matrix()));
    CHECK(restored_first->get_offset_to_assembly().isApprox(first->get_offset_to_assembly()));
    CHECK(restored_object->instances[0]->is_assemble_initialized());
    CHECK(restored_first->print_volume_state == first->print_volume_state);
    CHECK(restored_first->printable == first->printable);
    CHECK(restored_first->auto_drop == first->auto_drop);
    CHECK(restored_second->get_transformation().get_matrix().isApprox(
        second->get_transformation().get_matrix()));
    CHECK(!restored_object->instances[1]->is_assemble_initialized());
    CHECK(restored_second->print_volume_state == second->print_volume_state);

    const ModelVolume* restored_volume = restored_object->volumes.front();
    CHECK(restored_volume->supported_facets.equals(volume->supported_facets));
    CHECK(restored_volume->seam_facets.equals(volume->seam_facets));
    CHECK(restored_volume->mmu_segmentation_facets.equals(volume->mmu_segmentation_facets));
    CHECK(restored_volume->fuzzy_skin_facets.equals(volume->fuzzy_skin_facets));

    Model collision_model;
    ModelObject* collision_object = collision_model.add_object();
    collision_object->add_instance();
    CHECK_THROWS(restore_graph.restore(
        *collision_object, InstanceIDs { instance_ids.front() }));
    CHECK(restore_graph.size() == 2);
    return 0;
}
