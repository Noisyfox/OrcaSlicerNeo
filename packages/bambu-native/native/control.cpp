// Independent BambuSource CTRL reader. Credentials and protocol messages stay in the utility host.
#include <napi.h>
#include "library.hpp"
#define BAMBU_DYNAMIC
#include "../../slicer-wasm/cpp/src/slic3r/GUI/Printer/BambuTunnel.h"
#include <atomic>
#include <chrono>
#include <deque>
#include <mutex>
#include <thread>
#include <vector>

namespace {
constexpr int ctrl_type = 0x3001;
struct ControlState {
    std::atomic<bool> stop{false};
    std::mutex mutex;
    std::thread thread;
    std::deque<std::string> outgoing;
    std::deque<std::vector<unsigned char>> incoming;
    std::size_t bytes = 0;
    bool ready = false;
    std::string error;
    ~ControlState() { stop = true; if (thread.joinable()) thread.join(); }
    void fail(const char* message) { std::lock_guard<std::mutex> lock(mutex); error = message; incoming.clear(); bytes = 0; }
    void run(const std::string& path, const std::string& url) {
        try {
            Library library(path);
            BambuLib api{};
#define LOAD(name) api.name = library.symbol<decltype(api.name)>(#name)
            LOAD(Bambu_Create); LOAD(Bambu_Open); LOAD(Bambu_StartStreamEx); LOAD(Bambu_SendMessage);
            LOAD(Bambu_ReadSample); LOAD(Bambu_Close); LOAD(Bambu_Destroy);
#undef LOAD
            Bambu_Tunnel tunnel = nullptr;
            const int created = api.Bambu_Create(&tunnel, url.c_str());
            if (!tunnel) throw std::runtime_error("create");
            struct Guard { BambuLib& api; Bambu_Tunnel tunnel; ~Guard() { api.Bambu_Close(tunnel); api.Bambu_Destroy(tunnel); } } guard{api, tunnel};
            if (created != 0) throw std::runtime_error("create");
            if (stop) return;
            if (api.Bambu_Open(tunnel) != 0) { fail("Task resource connection failed"); return; }
            auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(20);
            while (!stop) {
                const int result = api.Bambu_StartStreamEx(tunnel, ctrl_type);
                if (result == Bambu_success) break;
                if (result != Bambu_would_block || std::chrono::steady_clock::now() >= deadline) { fail("Task resource stream unavailable"); return; }
                std::this_thread::sleep_for(std::chrono::milliseconds(2));
            }
            if (stop) return;
            { std::lock_guard<std::mutex> lock(mutex); ready = true; }
            while (!stop) {
                if (std::chrono::steady_clock::now() >= deadline) { fail("Task resource stream timed out"); return; }
                std::string message;
                { std::lock_guard<std::mutex> lock(mutex); if (!outgoing.empty()) message = outgoing.front(); }
                if (!message.empty()) {
                    const int result = api.Bambu_SendMessage(tunnel, ctrl_type, message.data(), static_cast<int>(message.size()));
                    if (result == Bambu_success) { std::lock_guard<std::mutex> lock(mutex); outgoing.pop_front(); }
                    else if (result != Bambu_would_block) { fail("Task resource request failed"); return; }
                }
                Bambu_Sample sample{};
                const int result = api.Bambu_ReadSample(tunnel, &sample);
                if (result == Bambu_would_block) { std::this_thread::sleep_for(std::chrono::milliseconds(2)); continue; }
                if (result != Bambu_success || !sample.buffer || sample.size <= 0 || sample.size > 4 * 1024 * 1024) { fail("Task resource packet unavailable"); return; }
                std::vector<unsigned char> owned(sample.buffer, sample.buffer + sample.size);
                std::lock_guard<std::mutex> lock(mutex);
                if (incoming.size() >= 32 || bytes + owned.size() > 8 * 1024 * 1024) { error = "Task resource reader overflow"; incoming.clear(); bytes = 0; return; }
                bytes += owned.size(); incoming.push_back(std::move(owned));
            }
        } catch (...) { fail("Task resource native reader failed"); }
    }
};

class ControlWrap : public Napi::ObjectWrap<ControlWrap> {
    std::shared_ptr<ControlState> state_;
    Napi::Reference<Napi::Promise> close_;
    class CloseWorker : public Napi::AsyncWorker {
        std::shared_ptr<ControlState> state_;
        Napi::Promise::Deferred deferred_;
    public:
        CloseWorker(Napi::Env env, std::shared_ptr<ControlState> state) : Napi::AsyncWorker(env), state_(state), deferred_(Napi::Promise::Deferred::New(env)) {}
        void Execute() override { if (state_->thread.joinable()) state_->thread.join(); }
        void OnOK() override { deferred_.Resolve(Env().Undefined()); }
        Napi::Promise promise() { return deferred_.Promise(); }
    };
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports) {
        exports.Set("ControlStream", DefineClass(env, "ControlStream", { InstanceMethod("poll", &ControlWrap::Poll), InstanceMethod("send", &ControlWrap::Send), InstanceMethod("close", &ControlWrap::Close) }));
        return exports;
    }
    ControlWrap(const Napi::CallbackInfo& info) : Napi::ObjectWrap<ControlWrap>(info) {
        if (info.Length() != 2 || !info[0].IsString() || !info[1].IsString()) throw Napi::TypeError::New(info.Env(), "Expected control library and private URL");
        const auto path = info[0].As<Napi::String>().Utf8Value(), url = info[1].As<Napi::String>().Utf8Value();
        const bool allowed = url.rfind("bambu:///local/", 0) == 0 || url.rfind("bambu:///tutk?", 0) == 0 || url.rfind("bambu:///tutk/", 0) == 0
            || url.rfind("bambu:///agora?", 0) == 0 || url.rfind("bambu:///agora/", 0) == 0;
        if (path.empty() || path.find('\0') != std::string::npos || url.find('\0') != std::string::npos || url.size() > 8192 || !allowed)
            throw Napi::TypeError::New(info.Env(), "Unsupported task resource URL");
        state_ = std::make_shared<ControlState>(); auto state = state_;
        state_->thread = std::thread([state, path, url] { state->run(path, url); });
    }
    ~ControlWrap() override { if (state_) { state_->stop = true; if (close_.IsEmpty() && state_->thread.joinable()) state_->thread.join(); } }
    Napi::Value Send(const Napi::CallbackInfo& info) {
        if (!state_ || state_->stop) throw Napi::Error::New(info.Env(), "Task resource stream closed");
        if (info.Length() != 1 || !info[0].IsString()) throw Napi::TypeError::New(info.Env(), "Expected a control message");
        auto message = info[0].As<Napi::String>().Utf8Value();
        if (message.empty() || message.size() > 65536 || message.find('\0') != std::string::npos) throw Napi::TypeError::New(info.Env(), "Invalid control message");
        std::lock_guard<std::mutex> lock(state_->mutex);
        if (!state_->error.empty()) throw Napi::Error::New(info.Env(), state_->error);
        if (state_->outgoing.size() >= 16) throw Napi::Error::New(info.Env(), "Task resource request queue full");
        state_->outgoing.push_back(std::move(message)); return info.Env().Undefined();
    }
    Napi::Value Poll(const Napi::CallbackInfo& info) {
        if (!state_ || state_->stop) throw Napi::Error::New(info.Env(), "Task resource stream closed");
        std::lock_guard<std::mutex> lock(state_->mutex);
        if (!state_->error.empty()) throw Napi::Error::New(info.Env(), state_->error);
        auto result = Napi::Object::New(info.Env()); result.Set("ready", state_->ready);
        auto messages = Napi::Array::New(info.Env(), state_->incoming.size()); uint32_t i = 0;
        for (const auto& packet : state_->incoming) messages.Set(i++, Napi::Buffer<unsigned char>::Copy(info.Env(), packet.data(), packet.size()));
        state_->incoming.clear(); state_->bytes = 0; result.Set("messages", messages); return result;
    }
    Napi::Value Close(const Napi::CallbackInfo& info) {
        if (!close_.IsEmpty()) return close_.Value();
        state_->stop = true;
        auto worker = new CloseWorker(info.Env(), state_); auto promise = worker->promise();
        close_ = Napi::Persistent(promise); worker->Queue(); return promise;
    }
};
}
Napi::Object InitControlStream(Napi::Env env, Napi::Object exports) { return ControlWrap::Init(env, exports); }
