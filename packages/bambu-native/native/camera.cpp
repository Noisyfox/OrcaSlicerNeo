// Dedicated BambuSource reader. No networking-agent queue or JS callbacks on its thread.
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

struct CameraSample { std::vector<unsigned char> bytes; uint64_t time; int flags; };
struct CameraState {
    std::atomic<bool> stop{false};
    std::mutex mutex;
    std::deque<CameraSample> samples;
    size_t bytes = 0;
    bool ready = false;
    int width = 0, height = 0;
    std::string format, error;
    std::thread thread;
    ~CameraState() { stop = true; if (thread.joinable()) thread.join(); }
    void fail(const char* message) { std::lock_guard<std::mutex> lock(mutex); error = message; samples.clear(); bytes = 0; }
    void run(const std::string& path, const std::string& url) {
        try {
            Library library(path);
            BambuLib api{};
#define LOAD(name) api.name = library.symbol<decltype(api.name)>(#name)
            LOAD(Bambu_Create); LOAD(Bambu_Open); LOAD(Bambu_StartStream); LOAD(Bambu_GetStreamInfo);
            LOAD(Bambu_ReadSample); LOAD(Bambu_Close); LOAD(Bambu_Destroy);
#undef LOAD
            Bambu_Tunnel tunnel = nullptr;
            if (api.Bambu_Create(&tunnel, url.c_str()) != 0 || !tunnel) throw std::runtime_error("create");
            struct Guard { BambuLib& api; Bambu_Tunnel tunnel; ~Guard() { api.Bambu_Close(tunnel); api.Bambu_Destroy(tunnel); } } guard{api, tunnel};
            if (stop) return;
            if (api.Bambu_Open(tunnel) != 0) { fail("Camera connection failed"); return; }
            auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
            while (!stop) {
                int result = api.Bambu_StartStream(tunnel, true);
                if (result == Bambu_success) break;
                if (result != Bambu_would_block || std::chrono::steady_clock::now() >= deadline) { fail("Camera stream unavailable"); return; }
                std::this_thread::sleep_for(std::chrono::milliseconds(2));
            }
            if (stop) return;
            Bambu_StreamInfo info{};
            if (api.Bambu_GetStreamInfo(tunnel, 0, &info) != 0 || info.type != VIDE) { fail("Camera format unavailable"); return; }
            {
                std::lock_guard<std::mutex> lock(mutex);
                if (info.sub_type == AVC1 && info.format_type == video_avc_byte_stream) format = "h264";
                else if (info.sub_type == MJPG && info.format_type == video_jpeg) format = "jpeg";
                else { error = "Unsupported camera format"; return; }
                width = info.format.video.width; height = info.format.video.height; ready = true;
            }
            deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
            while (!stop) {
                Bambu_Sample sample{};
                int result = api.Bambu_ReadSample(tunnel, &sample);
                if (result == Bambu_would_block) {
                    if (std::chrono::steady_clock::now() >= deadline) { fail("Camera stopped sending frames"); return; }
                    std::this_thread::sleep_for(std::chrono::milliseconds(2)); continue;
                }
                if (result != Bambu_success || sample.itrack != 0 || !sample.buffer || sample.size <= 0 || sample.size > 4 * 1024 * 1024) { fail("Camera sample unavailable"); return; }
                deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
                // Borrowed memory is copied before the next read, even if JS is busy.
                CameraSample owned{{sample.buffer, sample.buffer + sample.size}, sample.decode_time, sample.flags};
                std::lock_guard<std::mutex> lock(mutex);
                if (samples.size() >= 64 || bytes + owned.bytes.size() > 8 * 1024 * 1024) {
                    error = "Camera reader overflow"; samples.clear(); bytes = 0; return;
                }
                bytes += owned.bytes.size(); samples.push_back(std::move(owned));
            }
        } catch (...) { fail("Camera native reader failed"); }
    }
};

class CameraWrap : public Napi::ObjectWrap<CameraWrap> {
    std::shared_ptr<CameraState> state_;
    Napi::Reference<Napi::Promise> close_;
    class CloseWorker : public Napi::AsyncWorker {
        std::shared_ptr<CameraState> state_;
        Napi::Promise::Deferred deferred_;
    public:
        CloseWorker(Napi::Env env, std::shared_ptr<CameraState> state) : Napi::AsyncWorker(env), state_(state), deferred_(Napi::Promise::Deferred::New(env)) {}
        void Execute() override { if (state_->thread.joinable()) state_->thread.join(); }
        void OnOK() override { deferred_.Resolve(Env().Undefined()); }
        Napi::Promise promise() { return deferred_.Promise(); }
    };
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports) {
        exports.Set("Camera", DefineClass(env, "Camera", { InstanceMethod("poll", &CameraWrap::Poll), InstanceMethod("close", &CameraWrap::Close) }));
        return exports;
    }
    CameraWrap(const Napi::CallbackInfo& info) : Napi::ObjectWrap<CameraWrap>(info) {
        if (info.Length() != 2 || !info[0].IsString() || !info[1].IsString()) throw Napi::TypeError::New(info.Env(), "Expected camera library and private URL");
        const auto path = info[0].As<Napi::String>().Utf8Value(), url = info[1].As<Napi::String>().Utf8Value();
        if (path.empty() || path.find('\0') != std::string::npos || url.find('\0') != std::string::npos || url.size() > 8192
            || (url.rfind("bambu:///rtsps___", 0) != 0 && url.rfind("bambu:///local/", 0) != 0)) throw Napi::TypeError::New(info.Env(), "Unsupported LAN camera URL");
        state_ = std::make_shared<CameraState>();
        auto state = state_;
        state_->thread = std::thread([state, path, url] { state->run(path, url); });
    }
    ~CameraWrap() override { if (state_) { state_->stop = true; if (close_.IsEmpty() && state_->thread.joinable()) state_->thread.join(); } }
    Napi::Value Poll(const Napi::CallbackInfo& info) {
        if (!state_ || state_->stop) throw Napi::Error::New(info.Env(), "Camera closed");
        std::lock_guard<std::mutex> lock(state_->mutex);
        if (!state_->error.empty()) throw Napi::Error::New(info.Env(), state_->error);
        auto result = Napi::Object::New(info.Env()); result.Set("ready", state_->ready);
        result.Set("format", state_->format); result.Set("width", state_->width); result.Set("height", state_->height);
        auto samples = Napi::Array::New(info.Env(), state_->samples.size()); uint32_t i = 0;
        for (const auto& sample : state_->samples) {
            auto value = Napi::Object::New(info.Env());
            value.Set("bytes", Napi::Buffer<unsigned char>::Copy(info.Env(), sample.bytes.data(), sample.bytes.size()));
            value.Set("time100ns", Napi::BigInt::New(info.Env(), sample.time)); value.Set("flags", sample.flags); samples.Set(i++, value);
        }
        state_->samples.clear(); state_->bytes = 0; result.Set("samples", samples); return result;
    }
    Napi::Value Close(const Napi::CallbackInfo& info) {
        if (!close_.IsEmpty()) return close_.Value();
        state_->stop = true;
        auto worker = new CloseWorker(info.Env(), state_); auto promise = worker->promise();
        close_ = Napi::Persistent(promise); worker->Queue(); return promise;
    }
};
Napi::Object InitCamera(Napi::Env env, Napi::Object exports) { return CameraWrap::Init(env, exports); }
