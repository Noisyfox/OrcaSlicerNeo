#define BAMBU_EXPORTS
#include "../../slicer-wasm/cpp/src/slic3r/GUI/Printer/BambuTunnel.h"
#include <chrono>
#include <deque>
#include <string>
#include <thread>
struct FixtureControl {
    std::string mode, buffer;
    std::deque<std::string> replies;
    int storage_sent = -1;
    std::chrono::steady_clock::time_point next_packet;
};
extern "C" {
int Bambu_Create(Bambu_Tunnel* tunnel, const char* path) { auto fixture = new FixtureControl; fixture->mode = path; *tunnel = fixture; return 0; }
int Bambu_Open(Bambu_Tunnel tunnel) {
    auto& s = *static_cast<FixtureControl*>(tunnel);
    if (s.mode.find("slow") != std::string::npos) std::this_thread::sleep_for(std::chrono::milliseconds(200));
    return s.mode.find("error") != std::string::npos ? -1 : 0;
}
int Bambu_StartStreamEx(Bambu_Tunnel, int type) { return type == 0x3001 ? 0 : -1; }
int Bambu_SendMessage(Bambu_Tunnel tunnel, int type, const char* bytes, int size) {
    auto& s = *static_cast<FixtureControl*>(tunnel);
    const std::string message(bytes, size);
    if (message.find("\"cmdtype\":7") != std::string::npos) {
        s.replies.push_back("{\"result\":0,\"sequence\":1,\"reply\":{\"storage\":[\"sdcard\",\"internal\"]}}"); return 0;
    }
    if (message.find("\"cmdtype\":1,") != std::string::npos) {
        if (s.mode.find("selector-") != std::string::npos) {
            const bool expected = s.mode.find("selector-external") != std::string::npos
                ? message.find("\"storage\"") == std::string::npos
                : message.find("\"storage\":\"internal\"") != std::string::npos;
            if (!expected || message.find("\"notify\":\"DETAIL\"") == std::string::npos) {
                s.replies.push_back("{\"result\":17,\"sequence\":1,\"reply\":{}}"); return 0;
            }
        }
        if (s.mode.find("silent") != std::string::npos) return 0;
        if (s.mode.find("continued-empty") != std::string::npos) {
            s.replies.push_back("{\"result\":1,\"sequence\":1,\"reply\":{\"file_lists\":[]}}"); return 0;
        }
        if (s.mode.find("largeheader") != std::string::npos) {
            std::string files;
            for (int i = 0; i < 1000; ++i) {
                if (i) files += ',';
                const auto name = std::string(80, 'a') + std::to_string(i) + ".3mf";
                files += "{\"name\":\"" + name + "\",\"path\":\"/" + name + "\",\"size\":3}";
            }
            s.replies.push_back("{\"result\":0,\"sequence\":1,\"reply\":{\"file_lists\":[" + files + "]}}"); return 0;
        }
        s.replies.push_back("{\"result\":1,\"sequence\":1,\"reply\":{\"file_lists\":[{\"name\":\"b.3mf\",\"path\":\"/b.3mf\",\"size\":3,\"time\":10}]}}");
        const std::string name = s.mode.find("duplicate") != std::string::npos ? "b.3mf" : "a.3mf";
        const std::string path = s.mode.find("legacy") != std::string::npos ? "" : "/" + name;
        s.replies.push_back("{\"result\":0,\"sequence\":1,\"reply\":{\"file_lists\":[{\"name\":\"" + name + "\",\"path\":\"" + path + "\",\"size\":4,\"time\":10}]}}"); return 0;
    }
    if (message.find("\"cmdtype\":3") != std::string::npos) {
        if (s.mode.find("silent") != std::string::npos) return 0;
        if (s.mode.find("rejected") != std::string::npos) s.replies.push_back("{\"result\":10,\"sequence\":1}");
        else if (s.mode.find("uncertain") != std::string::npos) s.replies.push_back("{\"result\":0,\"sequence\":1,\"reply\":{\"paths\":[]}}");
        else s.replies.push_back("{\"result\":0,\"sequence\":1,\"reply\":{\"paths\":[\"/storage-file\"]}}");
        return 0;
    }
    if (message.find("\"cmdtype\":2") != std::string::npos) {
        if (s.mode.find("resource-reuse") != std::string::npos) {
            const auto at = message.find("\"sequence\":");
            const int seq = std::stoi(message.substr(at + 11));
            auto reply = [&](int result, const char* path, const char* body) {
                const std::string data(body);
                s.replies.push_back("{\"result\":" + std::to_string(result) + ",\"sequence\":" + std::to_string(seq) +
                    ",\"reply\":{\"path\":\"" + path + "\",\"size\":" + std::to_string(data.size()) + "}}" + (data.empty() ? "" : "\n\n" + data));
            };
            if (message.find("/missing.3mf") != std::string::npos) {
                reply(1, "/one.3mf#thumbnail", "a"); reply(14, "/missing.3mf#thumbnail", "");
            } else if (message.find("/two.3mf") != std::string::npos) reply(0, "/two.3mf#thumbnail", "b");
            else reply(0, "/one.3mf#thumbnail", "a");
            return 0;
        }
        if (s.mode.find("resource-batch") != std::string::npos) {
            s.replies.push_back(std::string(R"({"result":1,"sequence":1,"reply":{"path":"/resource.3mf#_rels/.rels","size":1,"offset":0,"total":3,"continue":true}})") + "\n\na");
            if (s.mode.find("missing") == std::string::npos)
                s.replies.push_back(std::string(R"({"result":1,"sequence":1,"reply":{"path":"/resource.3mf#thumbnail","size":3,"offset":0,"total":3,"continue":false}})") + "\n\nxyz");
            s.replies.push_back(std::string(R"({"result":0,"sequence":1,"reply":{"path":"/resource.3mf#_rels/.rels","size":2,"offset":1,"total":3,"continue":false}})") + "\n\nbc");
            return 0;
        }
        if (message.find("/resource.3mf#_rels/.rels") == std::string::npos) return -1;
        if (s.mode.find("silent") != std::string::npos) return 0;
        if (s.mode.find("empty") != std::string::npos) {
            s.replies.push_back(R"({"result":0,"sequence":1,"reply":{"path":"/resource.3mf#_rels/.rels","size":0,"total":0}})"); return 0;
        }
        s.replies.push_back(std::string(R"({"result":1,"sequence":1,"reply":{"path":"/resource.3mf#_rels/.rels","size":1,"offset":0,"total":3,"continue":true}})") + "\n\na");
        if (s.mode.find("mismatch") != std::string::npos)
            s.replies.push_back(std::string(R"({"result":0,"sequence":1,"reply":{"path":"/other.3mf#_rels/.rels","size":2,"offset":1,"total":3,"continue":false}})") + "\n\nbc");
        else s.replies.push_back(std::string(R"({"result":0,"sequence":1,"reply":{"path":"/resource.3mf#_rels/.rels","size":2,"offset":1,"total":3,"continue":false}})") + "\n\nbc");
        return 0;
    }
    if (message.find("/storage-file") != std::string::npos) {
        if (s.mode.find("silent") != std::string::npos) return 0;
        if (s.mode.find("long-progress") != std::string::npos) {
            s.storage_sent = 0; s.next_packet = std::chrono::steady_clock::now(); return 0;
        }
        if (s.mode.find("empty") != std::string::npos) {
            s.replies.push_back("{\"result\":0,\"sequence\":1,\"reply\":{\"offset\":0,\"total\":0,\"size\":0,\"file_md5\":\"d41d8cd98f00b204e9800998ecf8427e\"}}"); return 0;
        }
        if (s.mode.find("rejected") != std::string::npos) { s.replies.push_back("{\"result\":10,\"sequence\":1}"); return 0; }
        const std::string offset = s.mode.find("offset") != std::string::npos ? "2" : "1";
        const std::string md5 = s.mode.find("checksum") != std::string::npos ? "00000000000000000000000000000000" : "900150983cd24fb0d6963f7d28e17f72";
        s.replies.push_back("{\"result\":1,\"sequence\":1,\"reply\":{\"offset\":0,\"total\":3,\"size\":1}}\n\na");
        s.replies.push_back("{\"result\":0,\"sequence\":1,\"reply\":{\"offset\":" + offset + ",\"total\":3,\"size\":2,\"file_md5\":\"" + md5 + "\"}}\n\nbc");
        return 0;
    }
    if (type != 0x3001 || message.find("\"cmdtype\":4") == std::string::npos || message.find("mem:/16") == std::string::npos
        || message.find("get_project_file") == std::string::npos || message.find("Metadata/") == std::string::npos) return -1;
    if (s.mode.find("silent") != std::string::npos) return 0;
    if (s.mode.find("malformed") != std::string::npos) { s.replies.push_back("not-json"); return 0; }
    s.replies.push_back("{\"result\":0,\"sequence\":99,\"reply\":{}}");
    const std::string metadata = s.mode.find("oversize") != std::string::npos ? "{\"result\":0,\"size\":999999999}" : "{\"result\":0,\"size\":3}";
    s.replies.push_back("{\"result\":1,\"sequence\":1,\"reply\":{\"mem_dl_param_size\":" + std::to_string(metadata.size()) + "}}\n\n" + metadata);
    s.replies.push_back("{\"result\":1,\"sequence\":1,\"reply\":{\"offset\":0,\"total\":3,\"size\":1}}\n\na");
    const std::string offset = s.mode.find("offset") != std::string::npos ? "2" : "1";
    const std::string total = s.mode.find("oversize") != std::string::npos ? "999999999" : "3";
    const std::string md5 = s.mode.find("checksum") != std::string::npos ? "00000000000000000000000000000000" : "900150983cd24fb0d6963f7d28e17f72";
    s.replies.push_back("{\"result\":0,\"sequence\":1,\"reply\":{\"offset\":" + offset + ",\"total\":" + total + ",\"size\":2,\"file_md5\":\"" + md5 + "\"}}\n\nbc");
    return 0;
}
int Bambu_ReadSample(Bambu_Tunnel tunnel, Bambu_Sample* sample) {
    auto& s = *static_cast<FixtureControl*>(tunnel);
    if (s.storage_sent >= 0) {
        if (s.storage_sent >= 22 || std::chrono::steady_clock::now() < s.next_packet) return Bambu_would_block;
        const bool last = s.storage_sent == 21;
        s.buffer = "{\"result\":" + std::to_string(last ? 0 : 1) + ",\"sequence\":1,\"reply\":{\"offset\":" + std::to_string(s.storage_sent) + ",\"total\":22,\"size\":1";
        if (last) s.buffer += ",\"file_md5\":\"ff49cfac3968dbce26ebe7d4823e58bd\"";
        s.buffer += "}}\n\na";
        s.storage_sent++; s.next_packet = std::chrono::steady_clock::now() + std::chrono::milliseconds(1000);
    }
    else if (s.mode.find("burst") != std::string::npos) s.buffer.assign(1024 * 1024, 'x');
    else {
        if (s.replies.empty()) return Bambu_would_block;
        s.buffer = std::move(s.replies.front()); s.replies.pop_front();
    }
    *sample = {}; sample->buffer = reinterpret_cast<const unsigned char*>(s.buffer.data()); sample->size = static_cast<int>(s.buffer.size());
    return 0;
}
void Bambu_Close(Bambu_Tunnel) {}
void Bambu_Destroy(Bambu_Tunnel tunnel) { delete static_cast<FixtureControl*>(tunnel); }
}
