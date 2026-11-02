// AGPL-3.0. XDG PickColor follows OrcaSlicer PR #16587; no GTK or renderer dependency.
#include "sampler.h"
#include <gio/gio.h>
#include <atomic>
#include <cmath>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

namespace screen_color {
namespace {
struct Request;
std::mutex current_mutex;
std::shared_ptr<Request> current;
std::atomic<unsigned> counter{0};

struct Request {
    Callback done;
    GMainContext* context = g_main_context_new();
    GMainLoop* loop = g_main_loop_new(context, FALSE);
    GCancellable* cancellable = g_cancellable_new();
    GSource* cancel_source = g_cancellable_source_new(cancellable);
    GDBusConnection* bus = nullptr;
    guint response_subscription = 0, owner_subscription = 0;
    gulong closed_handler = 0;
    std::string path;
    Result result{Status::Failed};
    bool finished = false;

    explicit Request(Callback callback) : done(std::move(callback)) {
        g_source_set_callback(cancel_source, G_SOURCE_FUNC(+[](GCancellable*, gpointer data) -> gboolean {
            static_cast<Request*>(data)->Finish({Status::Cancelled});
            return G_SOURCE_REMOVE;
        }), this, nullptr);
        g_source_attach(cancel_source, context);
    }
    ~Request() {
        g_source_destroy(cancel_source); g_source_unref(cancel_source);
        g_object_unref(cancellable); g_main_loop_unref(loop); g_main_context_unref(context);
    }
    void Finish(Result value) {
        if (finished) return;
        finished = true; result = value; g_main_loop_quit(loop);
    }
    static void Response(GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar*, GVariant* parameters, gpointer data) {
        auto* request = static_cast<Request*>(data);
        if (!g_variant_is_of_type(parameters, G_VARIANT_TYPE("(ua{sv})"))) {
            request->Finish({Status::Failed}); return;
        }
        guint32 response; GVariant* values;
        g_variant_get(parameters, "(u@a{sv})", &response, &values);
        Result result{response == 1 ? Status::Cancelled : Status::Failed};
        double r, g, b;
        if (response == 0 && g_variant_lookup(values, "color", "(ddd)", &r, &g, &b)
            && std::isfinite(r) && std::isfinite(g) && std::isfinite(b)
            && r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1) {
            const auto byte = [](double value) { return static_cast<std::uint32_t>(std::lround(value * 255.)); };
            result = {Status::Picked, (byte(r) << 16) | (byte(g) << 8) | byte(b)};
        }
        g_variant_unref(values);
        request->Finish(result);
    }
    void Run() {
        g_main_context_push_thread_default(context);
        GError* error = nullptr;
        gchar* address = g_dbus_address_get_for_bus_sync(G_BUS_TYPE_SESSION, cancellable, &error);
        if (address) {
            bus = g_dbus_connection_new_for_address_sync(address,
                GDBusConnectionFlags(G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT | G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION),
                nullptr, cancellable, &error);
            g_free(address);
        }
        const char* unique = bus ? g_dbus_connection_get_unique_name(bus) : nullptr;
        if (unique) {
            std::string sender = unique + 1;
            for (auto& character : sender) if (character == '.') character = '_';
            const auto token = "neo_pick_" + std::to_string(++counter);
            path = "/org/freedesktop/portal/desktop/request/" + sender + "/" + token;
            response_subscription = g_dbus_connection_signal_subscribe(bus, "org.freedesktop.portal.Desktop",
                "org.freedesktop.portal.Request", "Response", path.c_str(), nullptr, G_DBUS_SIGNAL_FLAGS_NONE, Response, this, nullptr);
            // Subscribe before calling: an auto-started portal can exit during the request.
            owner_subscription = g_dbus_connection_signal_subscribe(bus, "org.freedesktop.DBus", "org.freedesktop.DBus",
                "NameOwnerChanged", "/org/freedesktop/DBus", "org.freedesktop.portal.Desktop", G_DBUS_SIGNAL_FLAGS_NONE,
                [](GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar*, GVariant* parameters, gpointer data) {
                    const char *name, *old_owner, *new_owner;
                    g_variant_get(parameters, "(&s&s&s)", &name, &old_owner, &new_owner);
                    if (*old_owner && !*new_owner) static_cast<Request*>(data)->Finish({Status::Failed});
                }, this, nullptr);
            closed_handler = g_signal_connect(bus, "closed", G_CALLBACK(+[](GDBusConnection*, gboolean, GError*, gpointer data) {
                static_cast<Request*>(data)->Finish({Status::Failed});
            }), this);
            GVariantBuilder options; g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
            g_variant_builder_add(&options, "{sv}", "handle_token", g_variant_new_string(token.c_str()));
            // This bounded synchronous call runs on our private native thread, never Electron main.
            // The interactive result is delivered later by Response on this thread's GLib context.
            GVariant* reply = g_dbus_connection_call_sync(bus, "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
                "org.freedesktop.portal.Screenshot", "PickColor", g_variant_new("(sa{sv})", "", &options),
                G_VARIANT_TYPE("(o)"), G_DBUS_CALL_FLAGS_NONE, 30000, cancellable, &error);
            if (reply) {
                const char* returned_path; g_variant_get(reply, "(&o)", &returned_path);
                const bool expected_path = path == returned_path;
                g_variant_unref(reply);
                if (expected_path && !finished) g_main_loop_run(loop);
            }
        }
        if (g_cancellable_is_cancelled(cancellable)) result = {Status::Cancelled};
        if (error) g_error_free(error);
        if (bus) {
            if (g_cancellable_is_cancelled(cancellable) && !path.empty() && !g_dbus_connection_is_closed(bus)) {
                // Deliver Close before releasing this private connection/context.
                auto* reply = g_dbus_connection_call_sync(bus, "org.freedesktop.portal.Desktop", path.c_str(),
                    "org.freedesktop.portal.Request", "Close", nullptr, nullptr, G_DBUS_CALL_FLAGS_NONE, 1000, nullptr, nullptr);
                if (reply) g_variant_unref(reply);
            }
            if (response_subscription) g_dbus_connection_signal_unsubscribe(bus, response_subscription);
            if (owner_subscription) g_dbus_connection_signal_unsubscribe(bus, owner_subscription);
            if (closed_handler) g_signal_handler_disconnect(bus, closed_handler);
            g_object_unref(bus); bus = nullptr;
        }
        g_main_context_pop_thread_default(context);
        {
            std::lock_guard<std::mutex> lock(current_mutex);
            if (current.get() == this) current.reset();
        }
        auto callback = std::move(done);
        callback(result);
    }
};
}
bool Available() { return true; } // Loading GIO succeeds locally; portal availability is never pre-probed.
void Start(Callback done) {
    std::shared_ptr<Request> request;
    {
        std::lock_guard<std::mutex> lock(current_mutex);
        if (!current) { request = std::make_shared<Request>(done); current = request; }
    }
    if (!request) { done({Status::Failed}); return; }
    try { std::thread([request] { request->Run(); }).detach(); }
    catch (...) {
        { std::lock_guard<std::mutex> lock(current_mutex); current.reset(); }
        done({Status::Failed});
    }
}
void Cancel() {
    std::lock_guard<std::mutex> lock(current_mutex);
    if (current) g_cancellable_cancel(current->cancellable);
}
}
