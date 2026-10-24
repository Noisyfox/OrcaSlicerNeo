#define BAMBU_EXPORTS
#include "../../slicer-wasm/cpp/src/slic3r/GUI/Printer/BambuTunnel.h"
#include <chrono>
#include <string>
#include <thread>
struct FixtureCamera {
    std::string mode;
    int index = 0;
    unsigned char bytes[5] = {255, 216, 0, 255, 217};
    std::chrono::steady_clock::time_point next{};
};
extern "C" {
int Bambu_Create(Bambu_Tunnel* tunnel, const char* path) { *tunnel = new FixtureCamera{path}; return 0; }
int Bambu_Open(Bambu_Tunnel tunnel) {
    auto& camera = *static_cast<FixtureCamera*>(tunnel);
    if (camera.mode.find("slow") != std::string::npos) std::this_thread::sleep_for(std::chrono::milliseconds(200));
    return camera.mode.find("error") != std::string::npos ? -1 : 0;
}
int Bambu_StartStream(Bambu_Tunnel, bool) { return 0; }
int Bambu_GetStreamInfo(Bambu_Tunnel, int, Bambu_StreamInfo* info) {
    *info = {}; info->type = VIDE; info->sub_type = MJPG; info->format_type = video_jpeg;
    info->format.video.width = 320; info->format.video.height = 180; return 0;
}
int Bambu_ReadSample(Bambu_Tunnel tunnel, Bambu_Sample* sample) {
    auto& camera = *static_cast<FixtureCamera*>(tunnel);
    const auto now = std::chrono::steady_clock::now();
    if (camera.mode.find("burst") == std::string::npos && now < camera.next) return Bambu_would_block;
    camera.next = now + std::chrono::milliseconds(10); camera.bytes[2] = static_cast<unsigned char>(++camera.index);
    *sample = {}; sample->buffer = camera.bytes; sample->size = sizeof(camera.bytes); sample->flags = 1;
    sample->decode_time = static_cast<unsigned long long>(camera.index) * 100000; return 0;
}
void Bambu_Close(Bambu_Tunnel) {}
void Bambu_Destroy(Bambu_Tunnel tunnel) { delete static_cast<FixtureCamera*>(tunnel); }
}
