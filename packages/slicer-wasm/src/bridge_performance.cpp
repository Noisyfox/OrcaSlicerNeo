#include "bridge_performance.hpp"

#include <chrono>
#include <utility>

namespace Slic3r::Neo::Bridge::Performance {
namespace {
constexpr std::size_t kMaxSamples = 16;
std::vector<nlohmann::json> samples;
}

double now_ms()
{
    using clock = std::chrono::steady_clock;
    return std::chrono::duration<double, std::milli>(clock::now().time_since_epoch()).count();
}

void record(std::string operation, Timings timings, PerPlateTimings per_plate)
{
    nlohmann::json stages = nlohmann::json::object();
    for (const auto& [name, duration_ms] : timings)
        stages[name] = duration_ms < 0.0 ? 0.0 : duration_ms;
    nlohmann::json sample{{"operation", std::move(operation)}, {"stages_ms", std::move(stages)}};
    if (!per_plate.empty()) {
        nlohmann::json plates = nlohmann::json::array();
        for (const auto& plate_timings : per_plate) {
            nlohmann::json plate = nlohmann::json::object();
            for (const auto& [name, duration_ms] : plate_timings)
                plate[name] = duration_ms < 0.0 ? 0.0 : duration_ms;
            plates.push_back(std::move(plate));
        }
        sample["per_plate_stages_ms"] = std::move(plates);
    }
    samples.push_back(std::move(sample));
    if (samples.size() > kMaxSamples) samples.erase(samples.begin());
}

nlohmann::json take()
{
    nlohmann::json result{{"version", 1}, {"samples", std::move(samples)}};
    samples.clear();
    return result;
}

} // namespace Slic3r::Neo::Bridge::Performance
