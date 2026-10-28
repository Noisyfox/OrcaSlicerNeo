#pragma once
#include "library.hpp"
#include "plugin_api.hpp"
#include <mutex>
#include <variant>
#include <atomic>

using Input = std::variant<std::string, bool, int, std::map<std::string, std::string>>;
using EventArgument = std::variant<std::string, bool, int>;
struct HttpResult { int result; unsigned http_code; std::string body; };
struct PrintResult { int code; bool may_have_started; bool cancel_requested; };
struct PrintState {
    std::atomic<bool> cancel{false};
    std::atomic<bool> may_have_started{false};
};
using Output = std::variant<int, bool, std::string, HttpResult, PrintResult>;
struct PluginEvent {
    // Keep the library loaded until captured plugin functions have been destroyed.
    std::shared_ptr<Library> library;
    std::string type;
    std::vector<EventArgument> arguments;
    std::function<void()> queued;
};
using EventSink = std::function<void(PluginEvent)>;

class PluginAgent {
public:
    explicit PluginAgent(const std::string& path);
    ~PluginAgent();
    Output call(const std::string& method, const std::vector<Input>& arguments);
    void install_callbacks(EventSink sink);
    void install_discovery_callbacks(EventSink sink);
    void clear_callbacks();
    void destroy();
    PrintResult print(const std::string& route, Slic3r::PrintParams params,
        const std::shared_ptr<PrintState>& state, EventSink sink);
    bool has_agent() const { return agent_ != nullptr; }
    std::shared_ptr<Library> library() const { return library_; }
private:
    std::shared_ptr<Library> library_;
    void* agent_ = nullptr;
    std::mutex country_mutex_;
    std::string country_ = "Others";
#define DECLARE(name) Slic3r::func_##name name##_;
    NEO_BAMBU_EXPORTS(DECLARE)
#undef DECLARE
};
