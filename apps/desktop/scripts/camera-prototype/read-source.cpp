// AGPL-3.0. Standalone probe only; never linked into the application.
// Use the checked-in Orca ABI and the same loader as the production addon.
#define BAMBU_DYNAMIC
#include "BambuTunnel.h"
#include "library.hpp"
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <thread>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

static void write_le(std::uint64_t value, int bytes) {
    for (int i = 0; i < bytes; ++i) std::putchar(static_cast<unsigned char>(value >> (i * 8)));
}

int main(int argc, char** argv) {
    if (argc != 4) { std::cerr << "Expected library, loopback RTSP URL, sample count\n"; return 2; }
    // This probe must never accidentally connect to a real printer/account.
    if (std::string(argv[2]).find("bambu:///rtsps___127.0.0.1:") != 0) return 2;
#ifdef _WIN32
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    try {
        Library library(argv[1]);
        BambuLib api{};
#define LOAD(name) api.name = library.symbol<decltype(api.name)>(#name)
        LOAD(Bambu_Create); LOAD(Bambu_Open); LOAD(Bambu_StartStream);
        LOAD(Bambu_GetStreamInfo); LOAD(Bambu_ReadSample); LOAD(Bambu_Close); LOAD(Bambu_Destroy);
        LOAD(Bambu_GetLastErrorMsg);
#undef LOAD
        Bambu_Tunnel tunnel = nullptr;
        if (api.Bambu_Create(&tunnel, argv[2]) != 0 || !tunnel) throw std::runtime_error("Create failed");
        struct Guard {
            BambuLib& api; Bambu_Tunnel tunnel;
            ~Guard() { api.Bambu_Close(tunnel); api.Bambu_Destroy(tunnel); }
        } guard{api, tunnel};
        if (api.Bambu_Open(tunnel) != 0) {
            const char* error = api.Bambu_GetLastErrorMsg();
            throw std::runtime_error(std::string("Open failed: ") + (error ? error : "unknown"));
        }
        const auto begin = std::chrono::steady_clock::now();
        const auto deadline = begin + std::chrono::seconds(30);
        auto pause = [&] {
            if (std::chrono::steady_clock::now() > deadline) throw std::runtime_error("Probe deadline exceeded");
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        };
        int rc;
        while ((rc = api.Bambu_StartStream(tunnel, true)) == Bambu_would_block) pause();
        if (rc != 0) throw std::runtime_error("StartStream failed");
        Bambu_StreamInfo info{};
        if (api.Bambu_GetStreamInfo(tunnel, 0, &info) != 0 || info.sub_type != AVC1
            || info.format_type != video_avc_byte_stream) throw std::runtime_error("Expected Annex-B AVC");
        std::cerr << "{\"width\":" << info.format.video.width << ",\"height\":" << info.format.video.height
                  << ",\"advisoryFps\":" << info.format.video.frame_rate << "}\n";
        const int count = std::stoi(argv[3]);
        for (int i = 0; i < count;) {
            Bambu_Sample sample{};
            rc = api.Bambu_ReadSample(tunnel, &sample);
            if (rc == Bambu_would_block) { pause(); continue; }
            if (rc != 0 || sample.size <= 0 || sample.size > 4 * 1024 * 1024 || !sample.buffer)
                throw std::runtime_error("Invalid or missing sample");
            const auto read_us = std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::steady_clock::now() - begin).count();
            // Fixed 24-byte LE header, followed by a copy of the borrowed payload.
            write_le(sample.size, 4); write_le(sample.flags, 4);
            write_le(sample.decode_time, 8); write_le(read_us, 8);
            if (std::fwrite(sample.buffer, 1, sample.size, stdout) != static_cast<size_t>(sample.size)
                || std::fflush(stdout) != 0) throw std::runtime_error("Sample output failed");
            ++i;
        }
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
