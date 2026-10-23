// AGPL-3.0. Public declarations copied verbatim from OrcaSlicer
// src/slic3r/Utils/{bambu_networking,BBLNetworkPlugin}.hpp.
// Revision and upstream binary pins are recorded in artifacts.json.
#pragma once
#include <string>
#include <functional>
#include <map>
#include <vector>

namespace Slic3r {
typedef std::function<void(std::string topic_str)>  OnPrinterConnectedFn;
typedef std::function<void(int status, std::string dev_id, std::string msg)> OnLocalConnectedFn;
typedef std::function<void(int return_code, int reason_code)>                OnServerConnectedFn;
typedef std::function<void(std::string dev_id, std::string msg)> OnMessageFn;
typedef std::function<void(unsigned http_code, std::string http_body)> OnHttpErrorFn;
typedef std::function<std::string()>                GetCountryCodeFn;
typedef std::function<void(std::string topic)>      GetSubscribeFailureFn;
typedef std::function<void(std::string dev_info_json_str)> OnMsgArrivedFn;
typedef std::function<void(std::function<void()>)> QueueOnMainFn;
typedef std::function<void(std::string url, int status)> OnServerErrFn;
typedef bool (*func_check_debug_consistent)(bool is_debug);
typedef std::string (*func_get_version)(void);
typedef void* (*func_create_agent)(std::string log_dir);
typedef int (*func_destroy_agent)(void *agent);
typedef int (*func_init_log)(void *agent);
typedef int (*func_set_config_dir)(void *agent, std::string config_dir);
typedef int (*func_set_cert_file)(void *agent, std::string folder, std::string filename);
typedef int (*func_set_country_code)(void *agent, std::string country_code);
typedef int (*func_start)(void *agent);
typedef int (*func_set_on_ssdp_msg_fn)(void *agent, OnMsgArrivedFn fn);
typedef int (*func_set_on_printer_connected_fn)(void *agent, OnPrinterConnectedFn fn);
typedef int (*func_set_on_server_connected_fn)(void *agent, OnServerConnectedFn fn);
typedef int (*func_set_on_http_error_fn)(void *agent, OnHttpErrorFn fn);
typedef int (*func_set_get_country_code_fn)(void *agent, GetCountryCodeFn fn);
typedef int (*func_set_on_subscribe_failure_fn)(void *agent, GetSubscribeFailureFn fn);
typedef int (*func_set_on_message_fn)(void *agent, OnMessageFn fn);
typedef int (*func_set_on_user_message_fn)(void *agent, OnMessageFn fn);
typedef int (*func_set_on_local_connect_fn)(void *agent, OnLocalConnectedFn fn);
typedef int (*func_set_on_local_message_fn)(void *agent, OnMessageFn fn);
typedef int (*func_set_queue_on_main_fn)(void *agent, QueueOnMainFn fn);
typedef int (*func_set_server_callback)(void *agent, OnServerErrFn fn);
typedef int (*func_set_extra_http_header)(void *agent, std::map<std::string, std::string> extra_headers);
typedef int (*func_track_enable)(void *agent, bool enable);
typedef int (*func_connect_server)(void *agent);
typedef bool (*func_is_server_connected)(void *agent);
typedef int (*func_refresh_connection)(void *agent);
typedef bool (*func_start_discovery)(void *agent, bool start, bool sending);
typedef int (*func_change_user)(void *agent, std::string user_info);
typedef bool (*func_is_user_login)(void *agent);
typedef int (*func_user_logout)(void *agent, bool request);
typedef std::string (*func_get_user_id)(void *agent);
typedef std::string (*func_get_user_name)(void *agent);
typedef std::string (*func_get_user_avatar)(void *agent);
typedef std::string (*func_get_user_nickanme)(void *agent);
typedef std::string (*func_build_login_cmd)(void *agent);
typedef std::string (*func_build_logout_cmd)(void *agent);
typedef std::string (*func_build_login_info)(void *agent);
typedef std::string (*func_get_bambulab_host)(void *agent);
typedef int (*func_get_user_print_info)(void *agent, unsigned int* http_code, std::string* http_body);
typedef int (*func_get_my_token)(void *agent, std::string ticket, unsigned int *http_code, std::string *http_body);
typedef int (*func_get_my_profile)(void *agent, std::string token, unsigned int *http_code, std::string *http_body);
typedef int (*func_connect_printer)(void *agent, std::string dev_id, std::string dev_ip, std::string username, std::string password, bool use_ssl);
typedef int (*func_disconnect_printer)(void *agent);
typedef std::string (*func_get_user_selected_machine)(void *agent);
typedef int (*func_set_user_selected_machine)(void *agent, std::string dev_id);
typedef int (*func_track_remove_files)(void *agent);
typedef int (*func_start_subscribe)(void *agent, std::string module);
typedef int (*func_stop_subscribe)(void *agent, std::string module);
typedef int (*func_send_message)(void *agent, std::string dev_id, std::string json_str, int qos, int flag);
typedef int (*func_send_message_to_printer)(void *agent, std::string dev_id, std::string json_str, int qos, int flag);
typedef void (*func_install_device_cert)(void* agent, std::string dev_id, bool lan_only);

}

#define NEO_BAMBU_EXPORTS(X) \
    X(check_debug_consistent) \
    X(get_version) \
    X(create_agent) \
    X(destroy_agent) \
    X(init_log) \
    X(set_config_dir) \
    X(set_cert_file) \
    X(set_country_code) \
    X(start) \
    X(set_on_ssdp_msg_fn) \
    X(set_on_printer_connected_fn) \
    X(set_on_server_connected_fn) \
    X(set_on_http_error_fn) \
    X(set_get_country_code_fn) \
    X(set_on_subscribe_failure_fn) \
    X(set_on_message_fn) \
    X(set_on_user_message_fn) \
    X(set_on_local_connect_fn) \
    X(set_on_local_message_fn) \
    X(set_queue_on_main_fn) \
    X(set_server_callback) \
    X(set_extra_http_header) \
    X(track_enable) \
    X(track_remove_files) \
    X(connect_server) \
    X(is_server_connected) \
    X(refresh_connection) \
    X(start_discovery) \
    X(change_user) \
    X(is_user_login) \
    X(user_logout) \
    X(get_user_id) \
    X(get_user_name) \
    X(get_user_avatar) \
    X(get_user_nickanme) \
    X(build_login_cmd) \
    X(build_logout_cmd) \
    X(build_login_info) \
    X(get_bambulab_host) \
    X(get_user_print_info) \
    X(get_my_token) \
    X(get_my_profile) \
    X(start_subscribe) \
    X(stop_subscribe) \
    X(send_message) \
    X(send_message_to_printer) \
    X(install_device_cert) \
    X(connect_printer) \
    X(disconnect_printer) \
    X(get_user_selected_machine) \
    X(set_user_selected_machine)
