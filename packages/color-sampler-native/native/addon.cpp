// AGPL-3.0. Node-API only: native UI never accesses the renderer or its draft.
#include <napi.h>
#include <atomic>
#include <cstdio>
#include <memory>
#include "sampler.h"

namespace {
struct Request {
    std::uint32_t id;
    napi_threadsafe_function callback = nullptr;
    std::atomic<bool> finished{false};

    void Complete(screen_color::Result result) {
        if (finished.exchange(true)) return;
        auto* value = new screen_color::Result(result);
        const auto status = napi_call_threadsafe_function(callback, value, napi_tsfn_nonblocking);
        if (status != napi_ok) delete value;
        napi_release_threadsafe_function(callback, napi_tsfn_release);
    }
    void Shutdown() {
        if (!finished.exchange(true)) napi_release_threadsafe_function(callback, napi_tsfn_abort);
    }
};
// Cleanup can drain queued callbacks after JavaScript execution is disabled.
// Use the non-throwing C API here; always free the payload, even with no env.
void Deliver(napi_env env, napi_value fn, void*, void* data) {
    std::unique_ptr<screen_color::Result> result(static_cast<screen_color::Result*>(data));
    if (!env || !fn || !result) return;
    napi_value object, status, color, receiver;
    const char* name = result->status == screen_color::Status::Picked ? "picked" : result->status == screen_color::Status::Cancelled ? "cancelled" : "failed";
    if (napi_create_object(env, &object) != napi_ok
        || napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &status) != napi_ok
        || napi_set_named_property(env, object, "status", status) != napi_ok) return;
    if (result->status == screen_color::Status::Picked) {
        char hex[8]; std::snprintf(hex, sizeof(hex), "#%06X", result->rgb & 0xFFFFFF);
        if (napi_create_string_utf8(env, hex, NAPI_AUTO_LENGTH, &color) != napi_ok
            || napi_set_named_property(env, object, "color", color) != napi_ok) return;
    }
    if (napi_get_undefined(env, &receiver) == napi_ok)
        napi_call_function(env, receiver, fn, 1, &object, nullptr);
}
struct Binding { std::shared_ptr<Request> active; };

Napi::Value Start(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() != 2 || !info[0].IsNumber() || !info[1].IsFunction())
        throw Napi::TypeError::New(env, "Expected request id and callback");
    const double raw = info[0].As<Napi::Number>().DoubleValue();
    const auto id = info[0].As<Napi::Number>().Uint32Value();
    if (!id || raw != id) throw Napi::TypeError::New(env, "Invalid request id");
    auto* binding = static_cast<Binding*>(info.Data());
    if (binding->active && !binding->active->finished) return Napi::Boolean::New(env, false);
    auto request = std::make_shared<Request>();
    request->id = id;
    napi_value resource = Napi::String::New(env, "screen color selection");
    if (napi_create_threadsafe_function(env, info[1], nullptr, resource, 1, 1, nullptr, nullptr, nullptr, Deliver, &request->callback) != napi_ok)
        throw Napi::Error::New(env, "Could not create screen color callback");
    napi_unref_threadsafe_function(env, request->callback); // An abandoned picker must never keep a process alive.
    binding->active = request;
    try {
        screen_color::Start([request](screen_color::Result result) { request->Complete(result); });
    } catch (...) {
        request->Complete({screen_color::Status::Failed});
    }
    return Napi::Boolean::New(env, true);
}
Napi::Value Cancel(const Napi::CallbackInfo& info) {
    if (info.Length() != 1 || !info[0].IsNumber()) throw Napi::TypeError::New(info.Env(), "Expected request id");
    auto* binding = static_cast<Binding*>(info.Data());
    const auto request = binding->active;
    if (request && request->id == info[0].As<Napi::Number>().Uint32Value() && !request->finished) {
        screen_color::Cancel();
        request->Complete({screen_color::Status::Cancelled});
    }
    return info.Env().Undefined();
}
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    auto* binding = new Binding;
    env.AddCleanupHook([](Binding* state) {
        if (state->active) state->active->Shutdown();
        screen_color::Cancel();
        delete state;
    }, binding);
    exports.Set("apiVersion", 1);
    exports.Set("available", screen_color::Available());
    exports.Set("start", Napi::Function::New(env, Start, "start", binding));
    exports.Set("cancel", Napi::Function::New(env, Cancel, "cancel", binding));
#ifdef SCREEN_COLOR_FIXTURE
    exports.Set("completeFixture", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
        auto status = info[0].As<Napi::String>().Utf8Value();
        screen_color::CompleteFixture({status == "picked" ? screen_color::Status::Picked : status == "cancelled" ? screen_color::Status::Cancelled : screen_color::Status::Failed, 0x12ABEF});
    }));
#endif
    return exports;
}
}
NODE_API_MODULE(screen_color, Init)
