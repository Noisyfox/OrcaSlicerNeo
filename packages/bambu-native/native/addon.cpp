#include <napi.h>
#include "plugin_agent.hpp"
#include <atomic>
#include <cmath>
#include <limits>
#include <memory>
#include <mutex>

static Napi::Value output_value(Napi::Env env, const Output& output) {
    return std::visit([env](const auto& value) -> Napi::Value {
        using T = std::decay_t<decltype(value)>;
        if constexpr (std::is_same_v<T, HttpResult>) {
            auto result = Napi::Object::New(env);
            result.Set("result", value.result); result.Set("httpCode", value.http_code); result.Set("body", value.body);
            return result;
        } else return Napi::Value::From(env, value);
    }, output);
}

class EventHub : public std::enable_shared_from_this<EventHub> {
    struct Item { std::shared_ptr<EventHub> hub; PluginEvent event; napi_deferred barrier = nullptr; };
    napi_threadsafe_function function_ = nullptr;
    std::mutex mutex_;
    bool accepting_ = true;
    std::atomic<bool> discard_{false};
    static void deliver(napi_env raw_env, napi_value callback, void*, void* data) {
        std::unique_ptr<Item> item(static_cast<Item*>(data));
        if (!raw_env) return; // Node teardown still destroys queued native closures.
        Napi::Env env(raw_env);
        if (item->barrier) {
            napi_unref_threadsafe_function(env, item->hub->function_);
            napi_resolve_deferred(env, item->barrier, env.Undefined());
            return;
        }
        if (item->hub->discard_) return;
        if (item->event.queued) {
            try { item->event.queued(); } catch (...) { napi_throw_error(env, nullptr, "Bambu queued callback failed"); }
            return;
        }
        auto event = Napi::Object::New(env);
        event.Set("type", item->event.type);
        auto args = Napi::Array::New(env, item->event.arguments.size());
        for (size_t i = 0; i < item->event.arguments.size(); ++i) {
            std::visit([&](const auto& value) { args.Set(static_cast<uint32_t>(i), Napi::Value::From(env, value)); }, item->event.arguments[i]);
        }
        event.Set("args", args);
        napi_value argument = event;
        napi_call_function(env, env.Undefined(), callback, 1, &argument, nullptr);
    }
public:
    EventHub(Napi::Env env, Napi::Function callback) {
        auto status = napi_create_threadsafe_function(env, callback, nullptr, Napi::String::New(env, "Bambu callbacks"), 0, 1, nullptr, nullptr, nullptr, deliver, &function_);
        if (status != napi_ok) throw std::runtime_error("Cannot create callback dispatcher");
        napi_unref_threadsafe_function(env, function_);
    }
    void send(PluginEvent event) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!accepting_ || !function_) return;
        auto item = new Item{shared_from_this(), std::move(event)};
        if (napi_call_threadsafe_function(function_, item, napi_tsfn_nonblocking) != napi_ok) delete item;
    }
    void pause() { std::lock_guard<std::mutex> lock(mutex_); accepting_ = false; }
    Napi::Value drain(Napi::Env env) {
        std::lock_guard<std::mutex> lock(mutex_);
        napi_deferred deferred; napi_value promise;
        napi_create_promise(env, &deferred, &promise);
        if (function_) napi_ref_threadsafe_function(env, function_);
        auto item = new Item{shared_from_this(), {}, deferred};
        if (!function_ || napi_call_threadsafe_function(function_, item, napi_tsfn_nonblocking) != napi_ok) {
            delete item;
            if (function_) napi_unref_threadsafe_function(env, function_);
            napi_reject_deferred(env, deferred, Napi::Error::New(env, "Callback dispatcher closed").Value());
        }
        return Napi::Value(env, promise);
    }
    void release(bool discard = false) {
        std::lock_guard<std::mutex> lock(mutex_);
        accepting_ = false; discard_ = discard;
        if (function_) { napi_release_threadsafe_function(function_, napi_tsfn_release); function_ = nullptr; }
    }
};

class AgentWrap;
class CallWorker : public Napi::AsyncWorker {
public:
    CallWorker(Napi::Env env, AgentWrap* owner, std::function<Output()> work);
    void Execute() override { try { result_ = work_(); } catch (...) { SetError("Bambu native call failed"); } }
    void OnOK() override;
    void OnError(const Napi::Error& error) override;
    Napi::Promise promise() { return deferred_.Promise(); }
private:
    AgentWrap* owner_;
    Napi::Promise::Deferred deferred_;
    std::function<Output()> work_;
    Output result_ = 0;
};

class AgentWrap : public Napi::ObjectWrap<AgentWrap> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports) {
        exports.Set("Agent", DefineClass(env, "Agent", {
            InstanceMethod("invoke", &AgentWrap::Invoke), InstanceMethod("drain", &AgentWrap::Drain), InstanceMethod("dispose", &AgentWrap::Dispose),
        }));
        return exports;
    }
    AgentWrap(const Napi::CallbackInfo& info) : Napi::ObjectWrap<AgentWrap>(info) {
        if (info.Length() != 2 || !info[0].IsString() || !info[1].IsFunction()) throw Napi::TypeError::New(info.Env(), "Expected plugin path and callback");
        try {
            agent_ = std::make_shared<PluginAgent>(info[0].As<Napi::String>().Utf8Value());
            hub_ = std::make_shared<EventHub>(info.Env(), info[1].As<Napi::Function>());
        } catch (const std::exception& error) { throw Napi::Error::New(info.Env(), error.what()); }
    }
    ~AgentWrap() override {
        if (hub_) hub_->release(true);
        if (agent_) { try { agent_->clear_callbacks(); agent_->destroy(); } catch (...) {} }
    }
    void Complete() { busy_ = false; Unref(); }
private:
    std::shared_ptr<PluginAgent> agent_;
    std::shared_ptr<EventHub> hub_;
    bool busy_ = false;
    Napi::Value Invoke(const Napi::CallbackInfo& info) {
        if (!agent_ || busy_) throw Napi::Error::New(info.Env(), "Native agent closed or busy");
        if (info.Length() != 2 || !info[0].IsString() || !info[1].IsArray()) throw Napi::TypeError::New(info.Env(), "Invalid native request");
        const auto method = info[0].As<Napi::String>().Utf8Value();
        std::vector<Input> arguments;
        auto array = info[1].As<Napi::Array>();
        for (uint32_t i = 0; i < array.Length(); ++i) {
            auto value = array.Get(i);
            if (value.IsString()) arguments.emplace_back(value.As<Napi::String>().Utf8Value());
            else if (value.IsBoolean()) arguments.emplace_back(value.As<Napi::Boolean>().Value());
            else if (value.IsNumber()) {
                if (method != "send_message_to_printer" || (i != 2 && i != 3)) throw Napi::TypeError::New(info.Env(), "Invalid native argument");
                const double number = value.As<Napi::Number>().DoubleValue();
                if (!std::isfinite(number) || std::trunc(number) != number || number < std::numeric_limits<int>::min() || number > std::numeric_limits<int>::max())
                    throw Napi::TypeError::New(info.Env(), "Native integer argument required");
                arguments.emplace_back(static_cast<int>(number));
            }
            else if (value.IsObject() && !value.IsArray()) {
                std::map<std::string, std::string> headers;
                auto object = value.As<Napi::Object>(); auto keys = object.GetPropertyNames();
                for (uint32_t j = 0; j < keys.Length(); ++j) {
                    auto key = keys.Get(j).As<Napi::String>(); auto field = object.Get(key);
                    if (!field.IsString()) throw Napi::TypeError::New(info.Env(), "Header values must be strings");
                    headers[key.Utf8Value()] = field.As<Napi::String>().Utf8Value();
                }
                arguments.emplace_back(std::move(headers));
            } else throw Napi::TypeError::New(info.Env(), "Invalid native argument");
        }
        auto agent = agent_; auto hub = hub_;
        auto work = [agent, hub, method, arguments]() -> Output {
            if (method == "install_callbacks") { agent->install_callbacks([hub](PluginEvent event) { hub->send(std::move(event)); }); return 0; }
            if (method == "install_discovery_callbacks") { agent->install_discovery_callbacks([hub](PluginEvent event) { hub->send(std::move(event)); }); return 0; }
            if (method == "clear_callbacks") {
                try { auto result = agent->call(method, arguments); hub->pause(); return result; }
                catch (...) { hub->pause(); throw; }
            }
            return agent->call(method, arguments);
        };
        busy_ = true; Ref();
        auto worker = new CallWorker(info.Env(), this, work);
        auto promise = worker->promise(); worker->Queue(); return promise;
    }
    Napi::Value Drain(const Napi::CallbackInfo& info) {
        if (!hub_ || busy_) throw Napi::Error::New(info.Env(), "Native agent closed or busy");
        return hub_->drain(info.Env());
    }
    Napi::Value Dispose(const Napi::CallbackInfo& info) {
        if (busy_ || (agent_ && agent_->has_agent())) throw Napi::Error::New(info.Env(), "Destroy agent before unloading");
        if (hub_) hub_->release();
        hub_.reset(); agent_.reset(); return info.Env().Undefined();
    }
};
CallWorker::CallWorker(Napi::Env env, AgentWrap* owner, std::function<Output()> work)
    : Napi::AsyncWorker(env), owner_(owner), deferred_(Napi::Promise::Deferred::New(env)), work_(std::move(work)) {}
void CallWorker::OnOK() { owner_->Complete(); deferred_.Resolve(output_value(Env(), result_)); }
void CallWorker::OnError(const Napi::Error& error) { owner_->Complete(); deferred_.Reject(error.Value()); }
static Napi::Object Init(Napi::Env env, Napi::Object exports) { return AgentWrap::Init(env, exports); }
NODE_API_MODULE(bambu, Init)
