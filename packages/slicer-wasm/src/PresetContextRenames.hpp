#pragma once

#include "history/TimestampedHistory.hpp"
#include "nlohmann/json.hpp"
#include <map>
#include <string>

namespace Slic3r::Neo::Bridge::UserPresets {

struct JsonContextCodec {
    static nlohmann::json decode(const History::Bytes& bytes) {
        return nlohmann::json::parse(std::string(bytes.begin(), bytes.end()));
    }
    static History::Bytes encode(const nlohmann::json& value) {
        const auto text = value.dump();
        return {text.begin(), text.end()};
    }
};

// Compose sequential renames before visiting contexts. In particular A -> B,
// B -> C maps both original A and B to C; repeated sources and cycles keep the
// same semantics as applying each rename to the JSON in order.
class PresetContextRenames {
public:
    void add(const std::string& kind, const std::string& from, const std::string& to) {
        auto& names = m_names[kind];
        names.emplace(from, from);
        for (auto& [original, destination] : names)
            if (destination == from) destination = to;
    }

    void rewrite(nlohmann::json& context) const {
        auto replace = [&](nlohmann::json& value, const std::string& kind) {
            if (!value.is_string()) return;
            const auto names = m_names.find(kind);
            if (names == m_names.end()) return;
            const auto found = names->second.find(value.get_ref<const std::string&>());
            if (found != names->second.end()) value = found->second;
        };
        if (context.contains("nativePrinterPreset")) replace(context["nativePrinterPreset"]["selected"], "printer");
        if (context.contains("filamentState"))
            for (auto& name : context["filamentState"]["filament_presets"]) replace(name, "filament");
        if (context.contains("nativePrintPreset")) {
            replace(context["nativePrintPreset"]["selected"], "print");
            for (auto& preset : context["nativePrintPreset"]["project_embedded_presets"]) replace(preset["inherits"], "print");
        }
        if (context.contains("presetDraftRegistry"))
            for (auto& entry : context["presetDraftRegistry"]["entries"])
                replace(entry["canonical_name"], entry["kind"].get<std::string>());
    }

    // Codec policy keeps serialization separate and lets native tests count
    // actual decode/encode work without a production diagnostic ABI or hook.
    template<class Codec = JsonContextCodec>
    void publish(History::TimestampedHistory& history, const History::Bytes* current_context = nullptr) const {
        if (m_names.empty() && !current_context) return;
        history.rewrite_contexts([&](const History::Bytes& bytes) {
            if (m_names.empty()) return bytes;
            auto value = Codec::decode(bytes);
            rewrite(value);
            return Codec::encode(value);
        }, current_context);
    }

private:
    std::map<std::string, std::map<std::string, std::string>> m_names;
};

} // namespace Slic3r::Neo::Bridge::UserPresets
