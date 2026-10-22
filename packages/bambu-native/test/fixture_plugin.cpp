// Deterministic exported-interface fixture, not a replacement networking implementation.
#include "../native/plugin_api.hpp"
#include <fstream>
#include <mutex>
#include <thread>
#include <type_traits>
#ifdef _WIN32
#define EXPORT extern "C" __declspec(dllexport)
#else
#define EXPORT extern "C" __attribute__((visibility("default")))
#endif
using namespace Slic3r;
struct Fixture {
    std::string trace, user, country, selected;
    std::mutex mutex;
    OnMsgArrivedFn ssdp;
    OnPrinterConnectedFn printer;
    OnServerConnectedFn server;
    OnHttpErrorFn http;
    GetCountryCodeFn get_country;
    GetSubscribeFailureFn subscribe;
    OnMessageFn message, user_message, local_message;
    OnLocalConnectedFn local;
    QueueOnMainFn queue;
    OnServerErrFn error;
    void record(const std::string& text) { std::ofstream(trace, std::ios::app) << text << '\n'; }
};
static Fixture& fixture(void* handle) { return *static_cast<Fixture*>(handle); }
EXPORT bool bambu_network_check_debug_consistent(bool debug) { return !debug; }
EXPORT std::string bambu_network_get_version() { return "fixture-1"; }
EXPORT void* bambu_network_create_agent(std::string path) { auto f = new Fixture; f->trace = path; f->record("create"); return f; }
EXPORT int bambu_network_destroy_agent(void* handle) { fixture(handle).record("destroy"); delete static_cast<Fixture*>(handle); return 0; }
EXPORT int bambu_network_init_log(void* handle) { fixture(handle).record("init-log"); return 0; }
EXPORT int bambu_network_set_config_dir(void* handle, std::string path) { fixture(handle).record("config:" + path); return 0; }
EXPORT int bambu_network_set_cert_file(void* handle, std::string folder, std::string name) { fixture(handle).record("cert:" + folder + "/" + name); return 0; }
EXPORT int bambu_network_set_country_code(void* handle, std::string country) { fixture(handle).country = country; return 0; }
#define SETTER(name, member, type) EXPORT int bambu_network_##name(void* handle, type fn) { auto& f = fixture(handle); std::lock_guard<std::mutex> lock(f.mutex); f.member = fn; if (!fn) f.record("clear:" #member); return 0; }
SETTER(set_on_ssdp_msg_fn, ssdp, OnMsgArrivedFn)
SETTER(set_on_printer_connected_fn, printer, OnPrinterConnectedFn)
SETTER(set_on_server_connected_fn, server, OnServerConnectedFn)
SETTER(set_on_http_error_fn, http, OnHttpErrorFn)
SETTER(set_get_country_code_fn, get_country, GetCountryCodeFn)
SETTER(set_on_subscribe_failure_fn, subscribe, GetSubscribeFailureFn)
SETTER(set_on_message_fn, message, OnMessageFn)
SETTER(set_on_user_message_fn, user_message, OnMessageFn)
SETTER(set_on_local_connect_fn, local, OnLocalConnectedFn)
SETTER(set_on_local_message_fn, local_message, OnMessageFn)
SETTER(set_queue_on_main_fn, queue, QueueOnMainFn)
SETTER(set_server_callback, error, OnServerErrFn)
#undef SETTER
EXPORT int bambu_network_start(void* handle) {
    auto& f = fixture(handle); f.record("start");
    std::thread thread([&f] {
        std::lock_guard<std::mutex> lock(f.mutex);
        if (f.ssdp) f.ssdp("{\"dev_id\":\"fixture-device\"}");
        if (f.server) f.server(0, 0);
        if (f.local) f.local(0, "fixture-device", "connected");
        if (f.http) f.http(401, "fixture-body");
        if (f.get_country) f.record("country:" + f.get_country());
        if (f.queue) f.queue([&f] { f.record("queued-on-main"); });
    });
    thread.join(); return 0;
}
EXPORT int bambu_network_set_extra_http_header(void* handle, std::map<std::string, std::string> headers) { fixture(handle).record("headers:" + std::to_string(headers.size())); return 0; }
EXPORT int bambu_network_track_enable(void* handle, bool enable) { fixture(handle).record(enable ? "track:true" : "track:false"); return 0; }
EXPORT int bambu_network_track_remove_files(void* handle) { fixture(handle).record("track-remove-files"); return 0; }
EXPORT int bambu_network_connect_server(void*) { return 0; }
EXPORT bool bambu_network_is_server_connected(void*) { return true; }
EXPORT int bambu_network_refresh_connection(void*) { return 0; }
EXPORT bool bambu_network_start_discovery(void* handle, bool start, bool sending) { fixture(handle).record(std::string("discovery:") + (start ? "true" : "false") + ":" + (sending ? "true" : "false")); return start; }
EXPORT int bambu_network_change_user(void* handle, std::string user) { fixture(handle).user = user; return 0; }
EXPORT bool bambu_network_is_user_login(void* handle) { return !fixture(handle).user.empty(); }
EXPORT int bambu_network_user_logout(void* handle, bool request) { fixture(handle).user.clear(); fixture(handle).record(request ? "logout:true" : "logout:false"); return 0; }
EXPORT std::string bambu_network_get_user_id(void* handle) { return fixture(handle).user; }
EXPORT std::string bambu_network_get_user_name(void*) { return "账户名"; }
EXPORT std::string bambu_network_get_user_avatar(void*) { return "https://example.invalid/avatar"; }
EXPORT std::string bambu_network_get_user_nickanme(void*) { return "Nickname"; }
EXPORT std::string bambu_network_build_login_cmd(void*) { return "login"; }
EXPORT std::string bambu_network_build_logout_cmd(void*) { return "logout"; }
EXPORT std::string bambu_network_build_login_info(void*) { return "{}"; }
EXPORT std::string bambu_network_get_bambulab_host(void*) { return "https://example.invalid"; }
EXPORT int bambu_network_get_user_print_info(void*, unsigned* code, std::string* body) { *code = 200; *body = "{\"devices\":[]}"; return 0; }
EXPORT int bambu_network_get_my_token(void*, std::string ticket, unsigned* code, std::string* body) { *code = 201; *body = ticket; return -19; }
EXPORT int bambu_network_get_my_profile(void*, std::string token, unsigned* code, std::string* body) { *code = 200; *body = token; return 0; }
EXPORT int bambu_network_connect_printer(void* handle, std::string id, std::string ip, std::string username, std::string password, bool ssl) {
    fixture(handle).record("connect:" + id + ":" + ip + ":" + username + ":" + password + ":" + (ssl ? "true" : "false")); return 0;
}
EXPORT int bambu_network_disconnect_printer(void* handle) { fixture(handle).record("disconnect"); return 0; }
EXPORT std::string bambu_network_get_user_selected_machine(void* handle) { return fixture(handle).selected; }
EXPORT int bambu_network_set_user_selected_machine(void* handle, std::string id) { fixture(handle).selected = id; return 0; }
#define CHECK(name) static_assert(std::is_same_v<decltype(&bambu_network_##name), Slic3r::func_##name>);
NEO_BAMBU_EXPORTS(CHECK)
#undef CHECK
