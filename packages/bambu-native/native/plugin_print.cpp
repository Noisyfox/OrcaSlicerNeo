#include "plugin_agent.hpp"
#include <stdexcept>

PrintResult PluginAgent::print(const std::string& route, Slic3r::PrintParams params,
    const std::shared_ptr<PrintState>& state, EventSink sink)
{
    if (!agent_) throw std::runtime_error("Agent not created");
    // A by-value layout mismatch corrupts memory. Only the pinned ABI is callable.
    if (get_version_().rfind("02.08.01.", 0) != 0)
        throw std::runtime_error("Unsupported print plugin ABI");
    auto update = [state, sink, route, library = library_](int stage, int code, std::string) {
        // Pinned v2.2.0: LAN publishes after Waiting; Cloud POSTs after Sending.
        // This flag is conservative, including cancellation racing the final check.
        if ((route == "lan" && stage == 2) || stage == 3 || stage == 5 || stage == 6)
            state->may_have_started = true;
        // Plugin messages may contain private paths/URLs. Keep progress numeric.
        sink({library, "print-progress", {stage, code, state->may_have_started.load()}, {}});
    };
    auto cancelled = [state] { return state->cancel.load(); };
    // Native success remains unconfirmed; the agent observes the matching device task.
    auto wait = [](int, std::string) { return true; };
    int code;
    if (cancelled()) return {-18, false, true};
    if (route == "lan") code = start_local_print_(agent_, std::move(params), update, cancelled);
    else if (route == "cloud") code = start_print_(agent_, std::move(params), update, cancelled, wait);
    else throw std::runtime_error("Invalid print route");
    return {code, state->may_have_started.load() || code == 0, state->cancel.load()};
}
