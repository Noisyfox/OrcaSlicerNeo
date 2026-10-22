#include "plugin_agent.hpp"
#include <stdexcept>

PluginAgent::PluginAgent(const std::string& path) : library_(std::make_shared<Library>(path)) {
#define LOAD(name) name##_ = library_->symbol<Slic3r::func_##name>("bambu_network_" #name);
    NEO_BAMBU_EXPORTS(LOAD)
#undef LOAD
    if (!check_debug_consistent_(false)) throw std::runtime_error("Plugin build mode mismatch");
}
PluginAgent::~PluginAgent() {
    // Explicit close drains queued callbacks first; this is a final ownership guard.
    try { clear_callbacks(); destroy(); } catch (...) {}
}
void PluginAgent::destroy() {
    if (agent_) { auto agent = agent_; agent_ = nullptr; destroy_agent_(agent); }
}
void PluginAgent::clear_callbacks() {
    if (!agent_) return;
    set_on_ssdp_msg_fn_(agent_, nullptr);
    set_on_printer_connected_fn_(agent_, nullptr);
    set_on_server_connected_fn_(agent_, nullptr);
    set_on_http_error_fn_(agent_, nullptr);
    set_get_country_code_fn_(agent_, nullptr);
    set_on_subscribe_failure_fn_(agent_, nullptr);
    set_on_message_fn_(agent_, nullptr);
    set_on_user_message_fn_(agent_, nullptr);
    set_on_local_connect_fn_(agent_, nullptr);
    set_on_local_message_fn_(agent_, nullptr);
    set_queue_on_main_fn_(agent_, nullptr);
    set_server_callback_(agent_, nullptr);
}
void PluginAgent::install_callbacks(EventSink sink) {
    if (!agent_) throw std::runtime_error("Agent not created");
    const auto emit = [sink, lib = library_](const std::string& name, std::vector<EventArgument> args) {
        sink({lib, name, std::move(args), {}});
    };
    auto check = [](int result) { if (result != 0) throw std::runtime_error("Plugin callback registration failed"); };
    check(set_server_callback_(agent_, [emit](std::string url, int status) { emit("server-error", {url, status}); }));
    check(set_on_server_connected_fn_(agent_, [emit](int result, int reason) { emit("server-connected", {result, reason}); }));
    check(set_on_printer_connected_fn_(agent_, [emit](std::string device) { emit("printer-connected", {device}); }));
    check(set_get_country_code_fn_(agent_, [this]() { std::lock_guard<std::mutex> lock(country_mutex_); return country_; }));
    check(set_on_subscribe_failure_fn_(agent_, [emit](std::string topic) { emit("subscribe-failure", {topic}); }));
    check(set_on_local_connect_fn_(agent_, [emit](int result, std::string device, std::string message) { emit("local-connect", {result, device, message}); }));
    check(set_on_message_fn_(agent_, [emit](std::string device, std::string message) { emit("message", {device, message}); }));
    check(set_on_user_message_fn_(agent_, [emit](std::string device, std::string message) { emit("user-message", {device, message}); }));
    check(set_on_local_message_fn_(agent_, [emit](std::string device, std::string message) { emit("local-message", {device, message}); }));
    check(set_queue_on_main_fn_(agent_, [sink, lib = library_](std::function<void()> callback) {
        sink({lib, "queue", {}, std::move(callback)});
    }));
}

void PluginAgent::install_discovery_callbacks(EventSink sink) {
    if (!agent_) throw std::runtime_error("Agent not created");
    const auto emit = [sink, lib = library_](const std::string& name, std::vector<EventArgument> args) {
        sink({lib, name, std::move(args), {}});
    };
    if (set_on_ssdp_msg_fn_(agent_, [emit](std::string value) { emit("ssdp", {value}); }) != 0)
        throw std::runtime_error("Plugin discovery callback registration failed");
    if (set_on_http_error_fn_(agent_, [emit](unsigned code, std::string body) { emit("http-error", {static_cast<int>(code), body}); }) != 0)
        throw std::runtime_error("Plugin HTTP callback registration failed");
}

Output PluginAgent::call(const std::string& method, const std::vector<Input>& arguments) {
    const auto string = [&](size_t index) { return std::get<std::string>(arguments.at(index)); };
    const auto boolean = [&](size_t index) { return std::get<bool>(arguments.at(index)); };
    if (method == "get_version") return get_version_();
    if (method == "create_agent") {
        if (agent_) throw std::runtime_error("Agent already created");
        agent_ = create_agent_(string(0));
        if (!agent_) throw std::runtime_error("Plugin agent creation failed");
        return 0;
    }
    if (method == "destroy_agent") { destroy(); return 0; }
    if (method == "clear_callbacks") { clear_callbacks(); return 0; }
    if (!agent_) throw std::runtime_error("Agent not created");
#define NO_ARGUMENT(name) if (method == #name) return name##_(agent_);
    NO_ARGUMENT(init_log)
    NO_ARGUMENT(start)
    NO_ARGUMENT(track_remove_files)
    NO_ARGUMENT(connect_server)
    NO_ARGUMENT(is_server_connected)
    NO_ARGUMENT(refresh_connection)
    NO_ARGUMENT(is_user_login)
    NO_ARGUMENT(get_user_id)
    NO_ARGUMENT(get_user_name)
    NO_ARGUMENT(get_user_avatar)
    NO_ARGUMENT(get_user_nickanme)
    NO_ARGUMENT(build_login_cmd)
    NO_ARGUMENT(build_logout_cmd)
    NO_ARGUMENT(build_login_info)
    NO_ARGUMENT(get_bambulab_host)
    NO_ARGUMENT(disconnect_printer)
    NO_ARGUMENT(get_user_selected_machine)
#undef NO_ARGUMENT
#define STRING_ARGUMENT(name) if (method == #name) return name##_(agent_, string(0));
    STRING_ARGUMENT(set_config_dir)
    STRING_ARGUMENT(change_user)
    STRING_ARGUMENT(set_user_selected_machine)
#undef STRING_ARGUMENT
    if (method == "set_cert_file") return set_cert_file_(agent_, string(0), string(1));
    if (method == "set_country_code") {
        { std::lock_guard<std::mutex> lock(country_mutex_); country_ = string(0); }
        return set_country_code_(agent_, string(0));
    }
    if (method == "set_extra_http_header") return set_extra_http_header_(agent_, std::get<std::map<std::string, std::string>>(arguments.at(0)));
    if (method == "track_enable") return track_enable_(agent_, boolean(0));
    if (method == "user_logout") return user_logout_(agent_, boolean(0));
    if (method == "start_discovery") return start_discovery_(agent_, boolean(0), boolean(1));
    if (method == "connect_printer") return connect_printer_(agent_, string(0), string(1), string(2), string(3), boolean(4));
    HttpResult response{0, 0, {}};
    if (method == "get_user_print_info") response.result = get_user_print_info_(agent_, &response.http_code, &response.body);
    else if (method == "get_my_token") response.result = get_my_token_(agent_, string(0), &response.http_code, &response.body);
    else if (method == "get_my_profile") response.result = get_my_profile_(agent_, string(0), &response.http_code, &response.body);
    else throw std::runtime_error("Unsupported native method");
    return response;
}
