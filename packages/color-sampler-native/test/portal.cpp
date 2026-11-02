// Private-bus contract test for the real Linux backend; no desktop or screenshot is used.
#include "../native/sampler.h"
#include <gio/gio.h>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <future>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>

using namespace std::chrono_literals;
namespace {
std::string mode;
std::mutex mutex;
std::condition_variable condition;
bool called = false, closed = false;
GMainLoop* service_loop;
GDBusConnection* service;
const char* xml = R"(<node><interface name="org.freedesktop.portal.Screenshot"><method name="PickColor"><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method></interface><interface name="org.freedesktop.portal.Request"><method name="Close"/></interface></node>)";
GDBusNodeInfo* info;
void Require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
void Method(GDBusConnection* bus, const gchar* sender, const gchar*, const gchar*, const gchar* method,
            GVariant* parameters, GDBusMethodInvocation* invocation, gpointer) {
    if (std::string(method) == "Close") {
        { std::lock_guard<std::mutex> lock(mutex); closed = true; }
        condition.notify_all();
        g_dbus_method_invocation_return_value(invocation, nullptr); return;
    }
    std::string operation;
    { std::lock_guard<std::mutex> lock(mutex); called = true; operation = mode; }
    condition.notify_all();
    if (operation == "error") { g_dbus_method_invocation_return_dbus_error(invocation, "org.freedesktop.DBus.Error.NotSupported", "No picker"); return; }
    const gchar *parent, *token = nullptr; GVariant* options;
    g_variant_get(parameters, "(&s@a{sv})", &parent, &options);
    g_variant_lookup(options, "handle_token", "&s", &token);
    std::string name = sender + 1;
    for (auto& c : name) if (c == '.') c = '_';
    const auto path = "/org/freedesktop/portal/desktop/request/" + name + "/" + token;
    g_variant_unref(options);
    static const GDBusInterfaceVTable table{Method, nullptr, nullptr, {0}};
    g_dbus_connection_register_object(bus, path.c_str(), info->interfaces[1], &table, nullptr, nullptr, nullptr);
    g_dbus_method_invocation_return_value(invocation, g_variant_new("(o)", path.c_str()));
    if (operation == "vanish") { g_dbus_connection_close_sync(bus, nullptr, nullptr); return; }
    if (operation == "hold") return;
    GVariantBuilder results; g_variant_builder_init(&results, G_VARIANT_TYPE_VARDICT);
    if (operation == "picked") g_variant_builder_add(&results, "{sv}", "color", g_variant_new("(ddd)", 18. / 255, 171. / 255, 239. / 255));
    if (operation == "malformed") g_variant_builder_add(&results, "{sv}", "color", g_variant_new_string("bad"));
    g_dbus_connection_emit_signal(bus, sender, path.c_str(), "org.freedesktop.portal.Request", "Response",
        g_variant_new("(ua{sv})", operation == "cancelled" ? 1u : 0u, &results), nullptr);
}
}
int main() {
    GTestDBus* dbus = g_test_dbus_new(G_TEST_DBUS_NONE);
    g_test_dbus_up(dbus);
    std::promise<void> ready;
    std::thread server([&] {
        auto* context = g_main_context_new(); g_main_context_push_thread_default(context);
        service_loop = g_main_loop_new(context, FALSE);
        service = g_dbus_connection_new_for_address_sync(g_test_dbus_get_bus_address(dbus),
            GDBusConnectionFlags(G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT | G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION), nullptr, nullptr, nullptr);
        info = g_dbus_node_info_new_for_xml(xml, nullptr);
        static const GDBusInterfaceVTable table{Method, nullptr, nullptr, {0}};
        g_dbus_connection_register_object(service, "/org/freedesktop/portal/desktop", info->interfaces[0], &table, nullptr, nullptr, nullptr);
        auto* reply = g_dbus_connection_call_sync(service, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
            g_variant_new("(su)", "org.freedesktop.portal.Desktop", 0u), G_VARIANT_TYPE("(u)"), G_DBUS_CALL_FLAGS_NONE, 5000, nullptr, nullptr);
        if (reply) g_variant_unref(reply);
        ready.set_value(); g_main_loop_run(service_loop);
        g_dbus_connection_close_sync(service, nullptr, nullptr);
        g_object_unref(service); g_dbus_node_info_unref(info); g_main_loop_unref(service_loop);
        g_main_context_pop_thread_default(context); g_main_context_unref(context);
    });
    ready.get_future().wait();
    int exit_code = 0;
    try {
        for (const std::string operation : {"picked", "cancelled", "error", "malformed", "hold", "vanish"}) {
            { std::lock_guard<std::mutex> lock(mutex); mode = operation; called = closed = false; }
            std::promise<screen_color::Result> completion;
            auto future = completion.get_future();
            screen_color::Start([&](screen_color::Result value) { completion.set_value(value); });
            if (operation == "hold") {
                std::unique_lock<std::mutex> lock(mutex);
                Require(condition.wait_for(lock, 5s, [] { return called; }), "PickColor did not reach the portal");
                lock.unlock(); screen_color::Cancel();
            }
            Require(future.wait_for(5s) == std::future_status::ready, "Portal operation hung");
            const auto result = future.get();
            const auto expected = operation == "picked" ? screen_color::Status::Picked : operation == "cancelled" || operation == "hold" ? screen_color::Status::Cancelled : screen_color::Status::Failed;
            Require(result.status == expected, "Unexpected portal result");
            if (operation == "picked") Require(result.rgb == 0x12ABEF, "Portal RGB conversion changed");
            if (operation == "hold") {
                std::unique_lock<std::mutex> lock(mutex);
                Require(condition.wait_for(lock, 5s, [] { return closed; }), "Cancelled portal request was not closed");
            }
            std::cout << "passed: " << operation << std::endl;
        }
    } catch (const std::exception& error) { std::cerr << error.what() << std::endl; exit_code = 1; }
    g_main_loop_quit(service_loop); server.join();
    g_test_dbus_down(dbus); g_object_unref(dbus);
    return exit_code;
}
