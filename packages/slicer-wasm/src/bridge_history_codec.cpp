#define CEREAL_FUTURE_EXPERIMENTAL

#include "bridge_history_codec.hpp"

#include <cereal/archives/adapters.hpp>
#include <cereal/archives/binary.hpp>
#include <cereal/types/map.hpp>
#include <cereal/types/memory.hpp>
#include <cereal/types/optional.hpp>
#include <cereal/types/string.hpp>
#include <cereal/types/vector.hpp>

#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>

namespace {

// The native adapter uses the same archive boundary as Orca's object history:
// mutable ModelObject records contain references to immutable meshes, while
// mesh bytes are retained once by ProjectHistory's immutable data store.
struct NeoHistoryArchiveContext {
    std::map<const Slic3r::TriangleMesh*, std::string> output_mesh_keys;
    std::map<std::string, std::shared_ptr<const Slic3r::TriangleMesh>> input_meshes;
};
using NeoHistoryOutputArchive = cereal::UserDataAdapter<NeoHistoryArchiveContext, cereal::BinaryOutputArchive>;
using NeoHistoryInputArchive = cereal::UserDataAdapter<NeoHistoryArchiveContext, cereal::BinaryInputArchive>;

} // namespace

namespace cereal {

inline void save(BinaryOutputArchive& archive,
                 const std::shared_ptr<const Slic3r::TriangleMesh>& mesh)
{
    if (!mesh) {
        archive(std::string{});
        return;
    }
    const auto& keys = cereal::get_user_data<NeoHistoryArchiveContext>(archive).output_mesh_keys;
    const auto it = keys.find(mesh.get());
    if (it == keys.end()) throw std::runtime_error("history mesh reference is unavailable");
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
    const auto& meshes = cereal::get_user_data<NeoHistoryArchiveContext>(archive).input_meshes;
    const auto it = meshes.find(key);
    if (it == meshes.end()) throw std::runtime_error("history mesh data is unavailable");
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
    // Optional native caches such as convex hulls are deliberately omitted;
    // ModelVolume::load() reconstructs them from the retained mesh.
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

namespace Slic3r::Neo::History::Codec {
namespace {

Bytes mesh_bytes(const TriangleMesh& mesh)
{
    std::ostringstream stream(std::ios::binary | std::ios::out);
    cereal::BinaryOutputArchive archive(stream);
    archive(mesh);
    const std::string encoded = stream.str();
    return Bytes(encoded.begin(), encoded.end());
}

std::string mesh_key(const Bytes& bytes)
{
    std::uint64_t hash = 1469598103934665603ULL;
    for (const auto byte : bytes) {
        hash ^= byte;
        hash *= 1099511628211ULL;
    }
    return std::string("mesh-") + std::to_string(hash) + "-" + std::to_string(bytes.size());
}

} // namespace

ModelState capture_model_state(const Model& model)
{
    NeoHistoryArchiveContext archive_context;
    std::map<std::string, Bytes> mesh_bytes_by_key;
    for (const auto* object : model.objects) {
        for (const auto* volume : object->volumes) {
            const auto mesh = volume->get_mesh_shared_ptr();
            if (!mesh) continue;
            if (archive_context.output_mesh_keys.count(mesh.get())) continue;
            auto bytes = mesh_bytes(*mesh);
            const auto key = mesh_key(bytes);
            archive_context.output_mesh_keys.emplace(mesh.get(), key);
            mesh_bytes_by_key.emplace(key, std::move(bytes));
        }
    }

    ModelState result;
    // Restoration is driven entirely by ObjectID-keyed mutable records and
    // shared immutable mesh records. No complete-model archive is retained as
    // a per-entry equality or restore payload.
    result.mutable_objects.reserve(model.objects.size());
    for (const auto* object : model.objects) {
        std::ostringstream stream(std::ios::binary | std::ios::out);
        NeoHistoryOutputArchive archive(archive_context, stream);
        archive(*object);
        const std::string encoded = stream.str();
        result.mutable_objects.push_back({
            object->id().id, object->timestamp(),
            Bytes(encoded.begin(), encoded.end())});
    }
    result.immutable_meshes.reserve(mesh_bytes_by_key.size());
    for (auto& [key, bytes] : mesh_bytes_by_key)
        result.immutable_meshes.push_back({std::move(key), std::make_shared<const Bytes>(std::move(bytes)), {}, false});
    return result;
}

Model stage_model(const Model& model_template, const RestoreState& restored)
{
    NeoHistoryArchiveContext archive_context;
    for (const auto& mesh : restored.model.immutable_meshes) {
        const auto& encoded = mesh.resident ? *mesh.resident : (mesh.deferred ? *mesh.deferred : Bytes{});
        if (encoded.empty()) throw std::runtime_error("history mesh data is unavailable");
        std::string bytes(encoded.begin(), encoded.end());
        std::istringstream stream(bytes, std::ios::binary | std::ios::in);
        auto native_mesh = std::make_shared<TriangleMesh>();
        cereal::BinaryInputArchive archive(stream);
        archive(*native_mesh);
        archive_context.input_meshes.emplace(mesh.key, std::move(native_mesh));
    }

    // Deserialize into a transient model and let Model's copy assignment
    // rebuild ModelObject-owned volume/instance links. The transient is not
    // retained by history; ProjectHistory owns only the keyed byte versions.
    Model rebuilt_model = model_template;
    rebuilt_model.clear_objects();
    for (const auto& object : restored.model.mutable_objects) {
        if (object.data.empty()) throw std::runtime_error("history object data is unavailable");
        std::string bytes(object.data.begin(), object.data.end());
        std::istringstream stream(bytes, std::ios::binary | std::ios::in);
        ModelObject* native_object = rebuilt_model.add_object();
        NeoHistoryInputArchive archive(archive_context, stream);
        archive(*native_object);

        // Native ModelInstance deserialization intentionally constructs with
        // an invalid ObjectID because Orca restores into an existing object
        // graph. Neo stages a fresh Model instead, so materialize each decoded
        // instance through ModelObject::add_instance() to allocate a valid
        // runtime identity before the plate-session membership map is applied.
        const std::size_t decoded_instance_count = native_object->instances.size();
        for (std::size_t index = 0; index < decoded_instance_count; ++index) {
            ModelInstance* decoded = native_object->instances[index];
            ModelInstance* materialized = native_object->add_instance();
            materialized->set_transformation(decoded->get_transformation());
            if (decoded->is_assemble_initialized())
                materialized->set_assemble_transformation(decoded->get_assemble_transformation());
            materialized->set_offset_to_assembly(decoded->get_offset_to_assembly());
            materialized->print_volume_state = decoded->print_volume_state;
            materialized->printable = decoded->printable;
            materialized->auto_drop = decoded->auto_drop;
            materialized->use_loaded_id_for_label = decoded->use_loaded_id_for_label;
            materialized->arrange_order = decoded->arrange_order;
            materialized->loaded_id = decoded->loaded_id;
        }
        for (std::size_t index = 0; index < decoded_instance_count; ++index)
            native_object->delete_instance(0);
    }
    return rebuilt_model;
}

bool model_state_equal(const ModelState& lhs, const ModelState& rhs)
{
    if (lhs.serialized != rhs.serialized || lhs.mutable_objects.size() != rhs.mutable_objects.size() ||
        lhs.immutable_meshes.size() != rhs.immutable_meshes.size())
        return false;
    for (std::size_t index = 0; index < lhs.mutable_objects.size(); ++index) {
        const auto& left = lhs.mutable_objects[index];
        const auto& right = rhs.mutable_objects[index];
        if (left.id != right.id || left.timestamp != right.timestamp || left.data != right.data)
            return false;
    }
    for (std::size_t index = 0; index < lhs.immutable_meshes.size(); ++index) {
        const auto& left = lhs.immutable_meshes[index];
        const auto& right = rhs.immutable_meshes[index];
        const auto bytes_equal = [](const auto& a, const auto& b) {
            return (!a && !b) || (a && b && *a == *b);
        };
        if (left.key != right.key || left.optional != right.optional ||
            !bytes_equal(left.resident, right.resident) || !bytes_equal(left.deferred, right.deferred))
            return false;
    }
    return true;
}

} // namespace Slic3r::Neo::History::Codec
