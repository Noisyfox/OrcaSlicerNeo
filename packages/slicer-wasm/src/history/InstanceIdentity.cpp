#include "InstanceIdentity.hpp"

#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>

#include <cereal/archives/binary.hpp>
#include <cereal/types/base_class.hpp>
#include <cereal/types/polymorphic.hpp>

#include "libslic3r/Model.hpp"

namespace Slic3r::Neo::History {
namespace {

std::set<std::size_t> validate_ids(const InstanceIDs& ids,
                                   const std::set<std::size_t>& existing)
{
    std::set<std::size_t> validated = existing;
    for (const ::Slic3r::ObjectID id : ids) {
        if (!id.valid())
            throw std::runtime_error("history instance identity is unavailable");
        if (!validated.insert(id.id).second)
            throw std::runtime_error("history instance identities are not unique");
    }
    return validated;
}

std::string serialize_instance(const ModelInstance& instance)
{
    std::ostringstream stream(std::ios::binary | std::ios::out);
    cereal::BinaryOutputArchive archive(stream);
    archive(instance);
    return stream.str();
}

void restore_instance_payload(ModelInstance& instance, const std::string& payload)
{
    std::istringstream stream(payload, std::ios::binary | std::ios::in);
    cereal::BinaryInputArchive archive(stream);
    archive(instance);
}

void restore_object_base_id(ModelInstance& instance, const ::Slic3r::ObjectID id)
{
    // ModelInstance's native archive intentionally omits ObjectBase. Feed the
    // retained native identity through ObjectBase's cereal serializer after
    // add_instance() has constructed a valid, correctly linked instance.
    std::ostringstream output(std::ios::binary | std::ios::out);
    cereal::BinaryOutputArchive writer(output);
    writer(id);

    const std::string bytes = output.str();
    std::istringstream input(bytes, std::ios::binary | std::ios::in);
    cereal::BinaryInputArchive reader(input);
    reader(cereal::base_class<ObjectBase>(&instance));
}

} // namespace

InstanceIDs InstanceIdentityGraph::capture(const ModelObject& object)
{
    InstanceIDs result;
    result.reserve(object.instances.size());
    for (const ModelInstance* instance : object.instances) {
        if (instance == nullptr)
            throw std::runtime_error("history instance is unavailable");
        result.push_back(instance->id());
    }

    auto validated = validate_ids(result, m_ids);
    m_ids = std::move(validated);
    return result;
}

void InstanceIdentityGraph::restore(ModelObject& object, const InstanceIDs& ids)
{
    if (ids.size() != object.instances.size())
        throw std::runtime_error("history instance identity count does not match object");

    auto validated = validate_ids(ids, m_ids);
    std::vector<std::string> payloads;
    payloads.reserve(object.instances.size());
    for (const ModelInstance* instance : object.instances) {
        if (instance == nullptr)
            throw std::runtime_error("history instance is unavailable");
        // Copy through ModelInstance's cereal contract so every serializable
        // field follows the pinned native definition without a parallel list.
        payloads.push_back(serialize_instance(*instance));
    }

    const std::size_t decoded_count = object.instances.size();
    for (std::size_t index = 0; index < decoded_count; ++index) {
        ModelInstance* materialized = object.add_instance();
        restore_instance_payload(*materialized, payloads[index]);
        restore_object_base_id(*materialized, ids[index]);
    }
    for (std::size_t index = 0; index < decoded_count; ++index)
        object.delete_instance(0);

    m_ids = std::move(validated);
}

} // namespace Slic3r::Neo::History
