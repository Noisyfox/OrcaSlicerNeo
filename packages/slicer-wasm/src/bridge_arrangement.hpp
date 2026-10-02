#pragma once
#include "arrangement/HeadlessArrangement.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::Arrangement {
using json = nlohmann::json;
struct Operation {
    Neo::Arrangement::Prepared prepared;
    json context;
    json predecessor;
    std::uint64_t revision = 0;
    bool inject_failure = false;
};
Operation prepare_operation(const json& request);
json apply_result(const Operation& operation, const Neo::Arrangement::Result& result);
}
