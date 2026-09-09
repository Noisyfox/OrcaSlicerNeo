// ----------------------------------------------------------------
// ------------ extern "C" JSON-in/JSON-out bridge ----------------
// ----------------------------------------------------------------
// The only C++<->JS seam (design §Bridge API). Every function runs
// synchronously on the worker thread. JSON strings are returned as malloc'd
// C strings; the JS side reads them with UTF8ToString and _free()s. Binary
// buffers cross via the WASM heap (_malloc/_free + HEAPU8).
//
// Version-sensitive libslic3r APIs are the documented drift surface
// (AGENTS.md): if a signature below mismatches the pinned submodule, adjust
// here — never in the submodule.
#include <emscripten/emscripten.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "libslic3r/AppConfig.hpp"
#include "libslic3r/BuildVolume.hpp"
#include "libslic3r/Color.hpp"
#include "libslic3r/Exception.hpp"
#include "libslic3r/FlushVolCalc.hpp"
#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/miniz_extension.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/PresetBundle.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/TriangleMesh.hpp"
#include "libslic3r/Utils.hpp"

#include "bridge_buffers.hpp"
#include "bridge_filament_state.hpp"
#include "bridge_history_codec.hpp"
#include "bridge_history_metadata.hpp"
#include "bridge_state.hpp"
#include "history/ProjectHistory.hpp"
// Drift at the pinned SHA: GCodeProcessor.hpp lives under GCode/; the brief's
// PrintObject.hpp does not exist (class PrintObject is in Print.hpp, already
// included above).
#include "libslic3r/GCode/GCodeProcessor.hpp"

#include <boost/log/trivial.hpp>

#include "wasm_log.hpp"

#ifdef ORCA_WASM_THREADING
#include <tbb/global_control.h>
#include <tbb/task_arena.h>
#endif

#include "nlohmann/json.hpp"

using namespace Slic3r;
using nlohmann::json;

// ColorSpaceConvert.cpp belongs to the desktop-only slic3r utility source
// list and is intentionally not linked into the headless WASM target.  The
// native FlushVolCalculator object nevertheless uses this tiny primitive;
// keep the exact upstream symbol at the bridge boundary rather than editing
// the pinned submodule/build source list.
void RGB2HSV(float r, float g, float b, float* h, float* s, float* v)
{
    const float cmax = std::max(std::max(r, g), b);
    const float cmin = std::min(std::min(r, g), b);
    const float delta = cmax - cmin;
    if (std::abs(delta) < 0.001f) *h = 0.f;
    else if (cmax == r) *h = 60.f * std::fmod((g - b) / delta, 6.f);
    else if (cmax == g) *h = 60.f * ((b - r) / delta + 2.f);
    else *h = 60.f * ((r - g) / delta + 4.f);
    *s = std::abs(cmax) < 0.001f ? 0.f : delta / cmax;
    *v = cmax;
}

namespace {

// Bridge business helpers keep the C ABI and command transactions in this
// translation unit; filament projections and field-level history state live
// in bridge_filament_state.cpp.
using Neo::Bridge::BridgeState;
using Neo::Bridge::state;
using Neo::Bridge::FilamentState::config_metadata_json;
using Neo::Bridge::FilamentState::history_state_json;
using Neo::Bridge::FilamentState::DirectHistoryFrame;
using Neo::Bridge::FilamentState::StagedMutableState;
using Neo::Bridge::FilamentState::apply_mutable;
using Neo::Bridge::FilamentState::apply_project_sidecar;
using Neo::Bridge::FilamentState::current_direct_frame_model;
using Neo::Bridge::FilamentState::make_direct_frame;
using Neo::Bridge::FilamentState::stage_mutable;
using DirectFilamentHistoryFrame = Neo::Bridge::FilamentState::DirectHistoryFrame;
using Neo::Bridge::HistoryMetadata::history_entry_id;
using Neo::Bridge::HistoryMetadata::parse_history_context;
using Neo::Bridge::HistoryMetadata::parse_history_entry_id;
using Neo::Bridge::HistoryMetadata::parse_history_jump_direction;

std::atomic<std::uint64_t> g_plate_session_sequence{0};
std::atomic<std::uint64_t> g_plate_id_sequence{0};

static constexpr int kMaxPlateCount = 36;
static constexpr double kPlateGap = 1. / 5.;

struct PlateBounds {
    double min_x = 0.0;
    double max_x = 200.0;
    double min_y = 0.0;
    double max_y = 200.0;
    double max_z = 300.0;
};

json session_transform_json(const Slic3r::Geometry::Transformation& t)
{
    const auto offset = t.get_offset();
    const auto rotation = t.get_rotation();
    const auto scale = t.get_scaling_factor();
    const auto mirror = t.get_mirror();
    const Slic3r::Matrix4d m = t.get_matrix().matrix();
    json j = {{"offset", {offset.x(), offset.y(), offset.z()}},
              {"rotation", {rotation.x(), rotation.y(), rotation.z()}},
              {"scale", {scale.x(), scale.y(), scale.z()}},
              {"mirror", {mirror.x(), mirror.y(), mirror.z()}}};
    j["matrix"] = {m(0,0), m(1,0), m(2,0), m(3,0),
                    m(0,1), m(1,1), m(2,1), m(3,1),
                    m(0,2), m(1,2), m(2,2), m(3,2),
                    m(0,3), m(1,3), m(2,3), m(3,3)};
    return j;
}

PlateBounds selected_plate_bounds()
{
    PlateBounds bounds;
    try {
        const Preset& printer = state().presets.printers.get_selected_preset();
        if (const auto* area = printer.config.opt<ConfigOptionPoints>("printable_area");
            area != nullptr && area->values.size() >= 3) {
            bounds.min_x = bounds.max_x = area->values.front().x();
            bounds.min_y = bounds.max_y = area->values.front().y();
            for (const Vec2d& point : area->values) {
                bounds.min_x = std::min(bounds.min_x, point.x());
                bounds.max_x = std::max(bounds.max_x, point.x());
                bounds.min_y = std::min(bounds.min_y, point.y());
                bounds.max_y = std::max(bounds.max_y, point.y());
            }
        }
        if (const auto* height = printer.config.opt<ConfigOptionFloat>("printable_height");
            height != nullptr && std::isfinite(height->value) && height->value > 0.)
            bounds.max_z = height->value;
    } catch (...) {
        // A bridge snapshot must remain usable even before profile setup. The
        // deterministic fallback is the historical 200 mm square bed.
    }
    return bounds;
}

int plate_column_count(const int count)
{
    if (count <= 1) return 1;
    const double root = std::sqrt(static_cast<double>(count));
    const int rounded = static_cast<int>(std::round(root));
    return root > static_cast<double>(rounded) ? rounded + 1 : rounded;
}

Vec3d plate_origin_for_index(const int index, const int count, const PlateBounds& bounds)
{
    const int cols = plate_column_count(count);
    const int row = index / cols;
    const int col = index % cols;
    const double stride_x = (bounds.max_x - bounds.min_x) * (1. + kPlateGap);
    const double stride_y = (bounds.max_y - bounds.min_y) * (1. + kPlateGap);
    return Vec3d(col * stride_x, -row * stride_y, 0.);
}

Vec3d parked_origin_for_count(const int count, const PlateBounds& bounds)
{
    const int cols = plate_column_count(count);
    const int max_count = cols * cols;
    const int index = count == max_count ? max_count + cols - 1 : count;
    const int parked_cols = count == max_count ? cols + 1 : cols;
    const int row = index / parked_cols;
    const int col = index % parked_cols;
    const double stride_x = (bounds.max_x - bounds.min_x) * (1. + kPlateGap);
    const double stride_y = (bounds.max_y - bounds.min_y) * (1. + kPlateGap);
    return Vec3d(col * stride_x, -row * stride_y, 0.);
}

constexpr const char* kNeoPlateMetadataEntry = "Metadata/orca_neo_plate_session_v1.json";
constexpr const char* kNeoPlateMetadataSchema = "org.orcaslicerneo.plate-session";
constexpr const char* kNeoConfigOverlayEntry = "Metadata/orca_neo_config_overlay_v1.json";
constexpr const char* kNeoConfigOverlaySchema = "org.orcaslicerneo.config-overlay";
constexpr const char* kNeoFilamentStateEntry = "Metadata/orca_neo_filament_state_v1.json";
constexpr const char* kNeoFilamentStateSchema = "org.orcaslicerneo.filament-state";

json empty_project_config_overlay()
{
    return json{{"project", json::object()}, {"objects", json::object()},
                {"parts", json::object()}, {"plates", json::object()}};
}

bool valid_project_config_overlay(const json& overlay)
{
    if (!overlay.is_object()) return false;
    for (const char* scope : {"project", "objects", "parts", "plates"})
        if (!overlay.contains(scope) || !overlay[scope].is_object()) return false;
    for (const char* scope : {"project", "objects", "parts", "plates"}) {
        for (auto it = overlay[scope].begin(); it != overlay[scope].end(); ++it) {
            if (scope == std::string("project")) {
                if (!it.value().is_string()) return false;
                continue;
            }
            if (!it.value().is_object()) return false;
            for (auto option = it.value().begin(); option != it.value().end(); ++option)
                if (!option.value().is_string()) return false;
        }
    }
    return true;
}

std::string xml_unescape_value(std::string value)
{
    const std::pair<const char*, const char*> replacements[] = {
        {"&quot;", "\""}, {"&apos;", "'"}, {"&lt;", "<"},
        {"&gt;", ">"}, {"&amp;", "&"},
    };
    for (const auto& [from, to] : replacements) {
        size_t pos = 0;
        while ((pos = value.find(from, pos)) != std::string::npos) {
            value.replace(pos, std::strlen(from), to);
            pos += std::strlen(to);
        }
    }
    return value;
}

std::optional<std::string> xml_attribute(const std::string& xml, const size_t start,
                                         const size_t end, const std::string& key)
{
    const std::string needle = key + "=\"";
    const size_t at = xml.find(needle, start);
    if (at == std::string::npos || at >= end) return std::nullopt;
    const size_t value_start = at + needle.size();
    const size_t value_end = xml.find('\"', value_start);
    if (value_end == std::string::npos || value_end > end) return std::nullopt;
    return xml_unescape_value(xml.substr(value_start, value_end - value_start));
}

struct ImportedPlateRecord {
    int source_index = 0;
    bool invalid_index = false;
    std::string name;
    bool locked = false;
    json settings = json::object();
    json opaque_metadata = json::array();
    json future_metadata = json::object();
    std::vector<std::pair<int, int>> instances;
};

std::vector<BridgeState::PlateSessionPlate> build_plate_session_from_records(
    const std::vector<PlateData*>& native_data,
    const std::vector<ImportedPlateRecord>& raw_records,
    const std::optional<json>& neo_metadata,
    std::uint64_t sequence,
    std::string& current_plate_id);

bool is_native_plate_metadata_key(const std::string& key)
{
    static const std::set<std::string> keys = {
        "plater_id", "plater_name", "lock", "curr_bed_type", "print_sequence", "index",
        "first_layer_print_sequence", "other_layers_print_sequence",
        "other_layers_print_sequence_nums", "spiral_mode", "filament_map_mode",
        "filament_maps", "filament_volume_maps", "limit_filament_maps", "gcode_file", "thumbnail_file",
        "thumbnail_no_light_file", "top_file", "pick_file", "pattern_file", "pattern_bbox_file",
        "prediction", "weight", "first_layer_time", "timelapse_type", "outside", "support_used", "label_object_enabled",
        "enable_filament_dynamic_map", "has_filament_switcher", "printer_model_id",
        "extruder_type", "nozzle_volume_type", "nozzle_types", "nozzle_diameters", "instance_id", "identify_id",
        "object_id", "skipped",
    };
    return keys.find(key) != keys.end();
}

std::vector<ImportedPlateRecord> parse_plate_records(const std::string& xml)
{
    std::vector<ImportedPlateRecord> records;
    size_t cursor = 0;
    while ((cursor = xml.find("<plate", cursor)) != std::string::npos) {
        const size_t open_end = xml.find('>', cursor);
        const size_t close = xml.find("</plate>", open_end == std::string::npos ? cursor : open_end);
        if (open_end == std::string::npos || close == std::string::npos)
            throw Slic3r::RuntimeError("corrupt project plate metadata");
        ImportedPlateRecord record;
        const size_t record_end = close + std::strlen("</plate>");
        size_t metadata = cursor;
        while ((metadata = xml.find("<metadata", metadata)) != std::string::npos && metadata < close) {
            const size_t metadata_end = xml.find("/>", metadata);
            if (metadata_end == std::string::npos || metadata_end > close) break;
            const auto key = xml_attribute(xml, metadata, metadata_end, "key");
            const auto value = xml_attribute(xml, metadata, metadata_end, "value");
            if (key && value) {
                if (*key == "plater_id") {
                    try {
                        size_t consumed = 0;
                        record.source_index = std::stoi(*value, &consumed);
                        record.invalid_index = consumed != value->size() || record.source_index < 1;
                    } catch (...) { record.invalid_index = true; }
                } else if (*key == "plater_name") record.name = *value;
                else if (*key == "lock") {
                    record.locked = *value == "true" || *value == "1";
                } else if (!is_native_plate_metadata_key(*key)) {
                    record.opaque_metadata.push_back({{"key", *key}, {"value", *value}});
                }
            }
            metadata = metadata_end + 2;
        }
        size_t instance = cursor;
        while ((instance = xml.find("<instance", instance)) != std::string::npos && instance < close) {
            const size_t instance_end = xml.find("</instance>", instance);
            if (instance_end == std::string::npos || instance_end > close) break;
            int object_id = -1, instance_id = -1;
            size_t im = instance;
            while ((im = xml.find("<metadata", im)) != std::string::npos && im < instance_end) {
                const size_t im_end = xml.find("/>", im);
                if (im_end == std::string::npos || im_end > instance_end) break;
                const auto key = xml_attribute(xml, im, im_end, "key");
                const auto value = xml_attribute(xml, im, im_end, "value");
                if (key && value) {
                    try {
                        if (*key == "object_id") object_id = std::stoi(*value);
                        else if (*key == "instance_id") instance_id = std::stoi(*value);
                    } catch (...) { object_id = instance_id = -1; }
                }
                im = im_end + 2;
            }
            if (object_id >= 0 && instance_id >= 0) record.instances.emplace_back(object_id, instance_id);
            instance = instance_end + std::strlen("</instance>");
        }
        records.push_back(std::move(record));
        cursor = record_end;
    }
    if (std::any_of(records.begin(), records.end(), [](const ImportedPlateRecord& record) { return record.invalid_index; }))
        throw Slic3r::RuntimeError("corrupt project plate metadata");
    return records;
}

std::optional<std::string> read_archive_entry(const std::string& path, const std::string& name)
{
    Slic3r::MZ_Archive archive;
    if (!Slic3r::open_zip_reader(&archive.arch, path)) return std::nullopt;
    std::optional<std::string> result;
    const mz_uint count = mz_zip_reader_get_num_files(&archive.arch);
    for (mz_uint i = 0; i < count; ++i) {
        mz_zip_archive_file_stat stat;
        if (!mz_zip_reader_file_stat(&archive.arch, i, &stat)) continue;
        if (Slic3r::decode_archive_entry_path(&archive.arch, stat) != name) continue;
        if (stat.m_uncomp_size > static_cast<mz_uint64>(std::numeric_limits<size_t>::max())) continue;
        std::string bytes(static_cast<size_t>(stat.m_uncomp_size), '\0');
        if (!bytes.empty() && !mz_zip_reader_extract_to_mem(&archive.arch, i, bytes.data(), bytes.size(), 0)) {
            result.reset();
            continue;
        }
        result = std::move(bytes); // last entry wins after append-only saves
    }
    Slic3r::close_zip_reader(&archive.arch);
    return result;
}

bool append_archive_entry(const std::string& path, const std::string& name, const std::string& bytes)
{
    return mz_zip_add_mem_to_archive_file_in_place(path.c_str(), name.c_str(), bytes.data(), bytes.size(),
                                                    nullptr, 0, MZ_DEFAULT_COMPRESSION) != 0;
}

std::string normalize_model_config_indices(const std::string& xml, size_t* plate_count)
{
    std::string normalized = xml;
    size_t cursor = 0;
    size_t count = 0;
    while ((cursor = normalized.find("<plate", cursor)) != std::string::npos) {
        const size_t open_end = normalized.find('>', cursor);
        const size_t close = normalized.find("</plate>", open_end == std::string::npos ? cursor : open_end);
        if (open_end == std::string::npos || close == std::string::npos) break;
        const size_t metadata = normalized.find("key=\"plater_id\"", open_end, close - open_end);
        if (metadata != std::string::npos) {
            const size_t value = normalized.find("value=\"", metadata, close - metadata);
            if (value != std::string::npos) {
                const size_t value_start = value + std::strlen("value=\"");
                const size_t value_end = normalized.find('\"', value_start);
                if (value_end != std::string::npos && value_end < close) {
                    const std::string replacement = std::to_string(count + 1);
                    normalized.replace(value_start, value_end - value_start, replacement);
                }
            }
        }
        ++count;
        cursor = close + std::strlen("</plate>");
    }
    if (plate_count) *plate_count = count;
    return normalized;
}

bool rewrite_model_config_archive(const std::string& source, const std::string& destination,
                                  const std::string& model_config)
{
    Slic3r::MZ_Archive reader;
    if (!Slic3r::open_zip_reader(&reader.arch, source)) return false;
    Slic3r::MZ_Archive writer;
    if (!Slic3r::open_zip_writer(&writer.arch, destination)) {
        Slic3r::close_zip_reader(&reader.arch);
        return false;
    }
    bool ok = true;
    const mz_uint count = mz_zip_reader_get_num_files(&reader.arch);
    for (mz_uint i = 0; i < count && ok; ++i) {
        mz_zip_archive_file_stat stat;
        if (!mz_zip_reader_file_stat(&reader.arch, i, &stat)) { ok = false; break; }
        const std::string name = Slic3r::decode_archive_entry_path(&reader.arch, stat);
        if (name == "Metadata/model_settings.config")
            ok = mz_zip_writer_add_mem(&writer.arch, name.c_str(), model_config.data(), model_config.size(), MZ_DEFAULT_COMPRESSION) != 0;
        else
            ok = mz_zip_writer_add_from_zip_reader(&writer.arch, &reader.arch, i) != 0;
    }
    if (ok) ok = mz_zip_writer_finalize_archive(&writer.arch) != 0;
    Slic3r::close_zip_writer(&writer.arch);
    Slic3r::close_zip_reader(&reader.arch);
    return ok;
}

bool validate_opaque_metadata(const json& value)
{
    if (!value.is_array()) return false;
    for (const auto& entry : value) {
        if (!entry.is_object() || !entry.contains("key") || !entry.contains("value") ||
            !entry["key"].is_string() || !entry["value"].is_string()) return false;
    }
    return true;
}

bool is_neo_plate_metadata_key(const std::string& key)
{
    static const std::set<std::string> keys = {
        "plate_index", "origin", "name", "locked", "settings", "opaque_metadata", "instances",
    };
    return keys.find(key) != keys.end();
}

std::optional<json> parse_neo_plate_metadata(const std::string& bytes)
{
    try {
        const json payload = json::parse(bytes);
        if (!payload.is_object() || payload.value("schema", "") != kNeoPlateMetadataSchema ||
            payload.value("version", 0) != 1 || !payload.contains("plates") || !payload["plates"].is_array())
            throw Slic3r::RuntimeError("unsupported Neo plate metadata version");
        if (payload["plates"].empty() || payload["plates"].size() > static_cast<size_t>(kMaxPlateCount))
            throw Slic3r::RuntimeError("project contains more than 36 plates");
        for (size_t plate_index = 0; plate_index < payload["plates"].size(); ++plate_index) {
            const auto& plate = payload["plates"][plate_index];
            if (!plate.is_object() || !plate.contains("plate_index") || !plate["plate_index"].is_number_integer() ||
                plate["plate_index"].get<int>() != static_cast<int>(plate_index) ||
                !plate.contains("origin") || !plate["origin"].is_array() || plate["origin"].size() != 3 ||
                !std::all_of(plate["origin"].begin(), plate["origin"].end(), [](const json& coordinate) {
                    return coordinate.is_number() && std::isfinite(coordinate.get<double>());
                }) ||
                !plate.contains("name") || !plate["name"].is_string() ||
                !plate.contains("locked") || !plate["locked"].is_boolean() ||
                !plate.contains("settings") || !plate["settings"].is_object() ||
                !plate.contains("opaque_metadata") || !validate_opaque_metadata(plate["opaque_metadata"]))
                throw Slic3r::RuntimeError("corrupt Neo plate metadata");
        }
        if (!payload.contains("current_plate_index") || !payload["current_plate_index"].is_number_integer() ||
            payload["current_plate_index"].get<int>() < 0 ||
            payload["current_plate_index"].get<size_t>() >= payload["plates"].size())
            throw Slic3r::RuntimeError("corrupt Neo current plate metadata");
        return std::optional<json>{payload};
    } catch (const std::exception& e) {
        throw Slic3r::RuntimeError(e.what());
    }
}

void initialize_plate_session_from_records(const std::vector<PlateData*>& native_data,
                                            const std::vector<ImportedPlateRecord>& raw_records,
                                            const std::optional<json>& neo_metadata)
{
    auto& s = state();
    const auto sequence = g_plate_session_sequence.fetch_add(1, std::memory_order_relaxed) + 1;
    s.plate_session_plates = build_plate_session_from_records(native_data, raw_records, neo_metadata,
                                                               sequence, s.current_plate_id);
    s.instance_plate_ids.clear();
    s.plate_out_of_bounds_ids.clear();
    s.parked_instance_ids.clear();
    s.pending_membership_instance_ids.clear();
    s.plate_input_revisions.clear();
    for (const auto& plate : s.plate_session_plates) s.plate_input_revisions[plate.id] = 0;
}

std::vector<BridgeState::PlateSessionPlate> build_plate_session_from_records(
    const std::vector<PlateData*>& native_data,
    const std::vector<ImportedPlateRecord>& raw_records,
    const std::optional<json>& neo_metadata,
    const std::uint64_t sequence,
    std::string& current_plate_id)
{
    std::vector<BridgeState::PlateSessionPlate> result;
    const size_t count = std::max<size_t>(1, raw_records.empty() ? native_data.size() : raw_records.size());
    const PlateBounds bounds = selected_plate_bounds();
    result.reserve(count);
    for (size_t i = 0; i < count; ++i) {
        const ImportedPlateRecord* raw = i < raw_records.size() ? &raw_records[i] : nullptr;
        const PlateData* native = i < native_data.size() ? native_data[i] : nullptr;
        BridgeState::PlateSessionPlate plate;
        plate.id = "plate-session-" + std::to_string(sequence) + "-plate-" + std::to_string(i + 1);
        plate.name = raw && !raw->name.empty() ? raw->name : (native && !native->plate_name.empty() ? native->plate_name : "Plate " + std::to_string(i + 1));
        plate.display_index = static_cast<int>(i);
        plate.origin = plate_origin_for_index(static_cast<int>(i), static_cast<int>(count), bounds);
        plate.locked = native ? native->locked : (raw ? raw->locked : false);
        if (native) plate.settings = native->config;
        plate.settings_metadata = native ? config_metadata_json(native->config) : json::object();
        if (raw) plate.opaque_metadata = raw->opaque_metadata;
        result.push_back(std::move(plate));
    }
    if (neo_metadata) {
        const auto& records = (*neo_metadata)["plates"];
        for (size_t i = 0; i < records.size() && i < result.size(); ++i) {
            auto& plate = result[i];
            const auto& record = records[i];
            const auto& origin = record["origin"];
            plate.origin = Vec3d(origin[0].get<double>(), origin[1].get<double>(), origin[2].get<double>());
            plate.name = record["name"].get<std::string>();
            plate.locked = record["locked"].get<bool>();
            plate.settings_metadata = record["settings"];
            plate.opaque_metadata = record["opaque_metadata"];
            plate.future_metadata = json::object();
            for (auto it = record.begin(); it != record.end(); ++it)
                if (!is_neo_plate_metadata_key(it.key())) plate.future_metadata[it.key()] = it.value();
        }
    }
    const size_t current_index = neo_metadata ? (*neo_metadata)["current_plate_index"].get<size_t>() : 0;
    current_plate_id = result[current_index].id;
    return result;
}

void reset_plate_session_state()
{
    auto& s = state();
    const auto sequence = g_plate_session_sequence.fetch_add(1, std::memory_order_relaxed) + 1;
    s.plate_session_plates.clear();
    s.instance_plate_ids.clear();
    s.plate_out_of_bounds_ids.clear();
    s.parked_instance_ids.clear();
    s.pending_membership_instance_ids.clear();
    s.plate_input_revisions.clear();
    const auto plate_id = "plate-session-" + std::to_string(sequence) + "-plate-1";
    s.plate_session_plates.push_back({plate_id, "Plate 1", 0, Vec3d::Zero()});
    s.plate_input_revisions[plate_id] = 0;
    s.current_plate_id = plate_id;
}

void ensure_plate_session_state()
{
    if (state().plate_session_plates.empty() || state().current_plate_id.empty()) reset_plate_session_state();
}

const BridgeState::PlateSessionPlate* find_plate(const std::string& id)
{
    ensure_plate_session_state();
    const auto& plates = state().plate_session_plates;
    const auto it = std::find_if(plates.begin(), plates.end(), [&](const auto& plate) { return plate.id == id; });
    return it == plates.end() ? nullptr : &*it;
}

BridgeState::PlateSessionPlate* find_plate_mutable(const std::string& id)
{
    ensure_plate_session_state();
    auto& plates = state().plate_session_plates;
    const auto it = std::find_if(plates.begin(), plates.end(), [&](const auto& plate) { return plate.id == id; });
    return it == plates.end() ? nullptr : &*it;
}

json instance_membership_json()
{
    json instances = json::array();
    for (size_t object_index = 0; object_index < state().model.objects.size(); ++object_index) {
        const ModelObject* object = state().model.objects[object_index];
        for (size_t instance_index = 0; instance_index < object->instances.size(); ++instance_index) {
            const ModelInstance* instance = object->instances[instance_index];
            const std::size_t id = instance->id().id;
            const auto membership = state().instance_plate_ids.find(id);
            const std::string plate_id = membership == state().instance_plate_ids.end() ? "" : membership->second;
            const bool parked = state().parked_instance_ids.find(id) != state().parked_instance_ids.end();
            const bool out_of_bounds = !plate_id.empty() &&
                state().plate_out_of_bounds_ids[plate_id].find(id) != state().plate_out_of_bounds_ids[plate_id].end();
            instances.push_back({
                {"instance_id", id}, {"object_id", object->id().id},
                {"object_index", object_index}, {"instance_index", instance_index},
                {"plate_id", plate_id}, {"member", !plate_id.empty()},
                {"parked", parked}, {"unprintable", parked || plate_id.empty()},
                {"out_of_bounds", out_of_bounds},
            });
        }
    }
    return instances;
}

json plate_revisions_json();

json plate_session_snapshot_json(const json& instance_transforms = json::array(), bool include_membership = true)
{
    ensure_plate_session_state();
    json plates = json::array();
    for (const auto& plate : state().plate_session_plates) {
        json out_of_bounds = json::array();
        json members = json::array();
        for (const auto& [instance_id, plate_id] : state().instance_plate_ids) {
            if (plate_id == plate.id) members.push_back(instance_id);
        }
        const auto out_it = state().plate_out_of_bounds_ids.find(plate.id);
        if (out_it != state().plate_out_of_bounds_ids.end())
            for (const auto instance_id : out_it->second) out_of_bounds.push_back(instance_id);
        const bool plate_valid = out_of_bounds.empty();
        plates.push_back(json{
            {"plate_id", plate.id}, {"display_index", plate.display_index},
            {"origin", {plate.origin.x(), plate.origin.y(), plate.origin.z()}},
            {"name", plate.name}, {"instance_ids", std::move(members)},
            {"out_of_bounds_instance_ids", std::move(out_of_bounds)},
            {"valid", plate_valid}, {"locked", plate.locked},
            {"settings", plate.settings_metadata},
            {"opaque_metadata", plate.opaque_metadata},
            {"future_metadata", plate.future_metadata},
        });
    }
    json result{
        {"ok", true},
        {"version", 1},
        {"current_plate_id", state().current_plate_id},
        {"plates", std::move(plates)},
        {"instance_transforms", instance_transforms},
        {"input_revisions", plate_revisions_json()},
    };
    if (include_membership) result["instances"] = instance_membership_json();
    return result;
}

struct PlateInstanceRef {
    std::size_t object_index = 0;
    std::size_t instance_index = 0;
    std::size_t instance_id = 0;
    ModelObject* object = nullptr;
    ModelInstance* instance = nullptr;
};

std::vector<PlateInstanceRef> plate_instance_refs()
{
    std::vector<PlateInstanceRef> refs;
    for (size_t oi = 0; oi < state().model.objects.size(); ++oi) {
        ModelObject* object = state().model.objects[oi];
        for (size_t ii = 0; ii < object->instances.size(); ++ii) {
            ModelInstance* instance = object->instances[ii];
            refs.push_back({oi, ii, instance->id().id, object, instance});
        }
    }
    return refs;
}

// Build the print input for one plate without touching the authoritative
// editing model.  Model::add_object performs a deep copy of each selected
// object; non-member instances are removed from that copy and every retained
// instance is translated back into the printer's local coordinate system.
// This is intentionally temporary data: the global model continues to carry
// world-space coordinates for rendering, editing, and persistence.
std::optional<Model> make_current_plate_model(const BridgeState::PlateSessionPlate& plate,
                                              std::string& error)
{
    Model local_model;
    const Vec3d local_origin = plate.origin;
    std::size_t selected_instances = 0;
    for (ModelObject* source : state().model.objects) {
        std::vector<std::size_t> selected_indices;
        for (std::size_t index = 0; index < source->instances.size(); ++index) {
            const auto instance_id = source->instances[index]->id().id;
            const auto membership = state().instance_plate_ids.find(instance_id);
            if (membership != state().instance_plate_ids.end() && membership->second == plate.id)
                selected_indices.push_back(index);
        }
        if (selected_indices.empty()) continue;

        ModelObject* copy = local_model.add_object(*source);
        const std::set<std::size_t> selected_index_set(selected_indices.begin(), selected_indices.end());
        for (std::size_t index = copy->instances.size(); index-- > 0;) {
            if (selected_index_set.find(index) == selected_index_set.end())
                copy->delete_instance(index);
        }
        for (ModelInstance* instance : copy->instances) {
            auto transform = instance->get_transformation();
            transform.set_offset(transform.get_offset() - local_origin);
            instance->set_transformation(transform);
        }
        copy->invalidate_bounding_box();
        selected_instances += copy->instances.size();
    }
    if (selected_instances == 0) {
        error = "current plate is empty";
        return std::nullopt;
    }
    return local_model;
}

bool validate_plate_operation_target(const std::string& plate_id,
                                     const std::uint64_t revision,
                                     std::string& error)
{
    ensure_plate_session_state();
    if (plate_id.empty() || plate_id != state().current_plate_id) {
        error = "plate operation target is not the current plate";
        return false;
    }
    const auto* plate = find_plate(plate_id);
    if (plate == nullptr) {
        error = "plate operation target was not found";
        return false;
    }
    const auto current_revision = state().plate_input_revisions[plate_id];
    if (revision != current_revision) {
        error = "plate operation target is stale";
        return false;
    }
    const auto out_of_bounds = state().plate_out_of_bounds_ids.find(plate_id);
    if (out_of_bounds != state().plate_out_of_bounds_ids.end() && !out_of_bounds->second.empty()) {
        error = "current plate contains an out-of-bounds instance";
        return false;
    }
    bool has_member = false;
    for (const auto& [instance_id, member_plate_id] : state().instance_plate_ids) {
        (void)instance_id;
        if (member_plate_id == plate_id) { has_member = true; break; }
    }
    if (!has_member) {
        error = "current plate is empty";
        return false;
    }
    return true;
}

BoundingBoxf3 instance_hull_box(const PlateInstanceRef& ref)
{
    for (ModelVolume* volume : ref.object->volumes) {
        if (volume->is_model_part() && !volume->get_convex_hull_shared_ptr())
            volume->calculate_convex_hull();
    }
    return ref.object->instance_convex_hull_bounding_box(ref.instance);
}

bool box_intersects_plate(const BoundingBoxf3& box, const BridgeState::PlateSessionPlate& plate,
                          const PlateBounds& bounds)
{
    if (!box.defined) return false;
    const double min_x = plate.origin.x() + bounds.min_x;
    const double max_x = plate.origin.x() + bounds.max_x;
    const double min_y = plate.origin.y() + bounds.min_y;
    const double max_y = plate.origin.y() + bounds.max_y;
    return box.max.x() >= min_x && box.min.x() <= max_x &&
           box.max.y() >= min_y && box.min.y() <= max_y &&
           box.max.z() >= 0. && box.min.z() <= bounds.max_z;
}

std::vector<Vec2d> selected_printable_area(const PlateBounds& bounds,
                                           const BridgeState::PlateSessionPlate& plate)
{
    std::vector<Vec2d> area;
    try {
        const Preset& printer = state().presets.printers.get_selected_preset();
        if (const auto* configured = printer.config.opt<ConfigOptionPoints>("printable_area");
            configured != nullptr && configured->values.size() >= 3) {
            area.reserve(configured->values.size());
            for (const Vec2d& point : configured->values)
                area.emplace_back(point.x() + plate.origin.x(), point.y() + plate.origin.y());
        }
    } catch (...) {
        // Keep the deterministic fallback in sync with selected_plate_bounds().
    }
    if (area.size() < 3) {
        area = {{plate.origin.x() + bounds.min_x, plate.origin.y() + bounds.min_y},
                {plate.origin.x() + bounds.max_x, plate.origin.y() + bounds.min_y},
                {plate.origin.x() + bounds.max_x, plate.origin.y() + bounds.max_y},
                {plate.origin.x() + bounds.min_x, plate.origin.y() + bounds.max_y}};
    }
    return area;
}

// Match Orca's PartPlate::check_outside semantics.  In particular, Orca
// treats a model that is slightly sunk into the bed specially: it evaluates
// the convex hull with BuildVolume instead of requiring bbox.min.z() >= 0.
// Support-bearing projects commonly contain this legitimate small negative Z
// offset, and the old bridge-side AABB check incorrectly marked those plates
// out of bounds.
bool box_fully_inside_plate(const PlateInstanceRef& ref, const BoundingBoxf3& box,
                            const BridgeState::PlateSessionPlate& plate, const PlateBounds& bounds)
{
    if (!box.defined) return false;
    const double eps = BuildVolume::SceneEpsilon;
    BoundingBoxf3 plate_box(
        Vec3d(plate.origin.x() + bounds.min_x - eps,
              plate.origin.y() + bounds.min_y - eps,
              plate.origin.z() - eps),
        Vec3d(plate.origin.x() + bounds.max_x + eps,
              plate.origin.y() + bounds.max_y + eps,
              plate.origin.z() + bounds.max_z + eps));

    // This is the same lower-Z adjustment used by PartPlate::check_outside:
    // a model that rests below the mathematical bed plane is not rejected
    // merely because of its sinking offset.
    if (box.max.z() > plate_box.min.z())
        plate_box.min.z() += box.min.z();

    if (box.min.z() < SINKING_Z_THRESHOLD) {
        if (!plate_box.intersects(box)) return false;
        const BuildVolume build_volume(selected_printable_area(bounds, plate), bounds.max_z, {}, {});
        return ref.instance->calc_print_volume_state(build_volume) != ModelInstancePVS_Partly_Outside;
    }

    return plate_box.contains(box);
}

json instance_transform_record(const PlateInstanceRef& ref)
{
    return json{{"instance_id", ref.instance_id}, {"object_id", ref.object->id().id},
                {"object_index", ref.object_index}, {"instance_index", ref.instance_index},
                {"world_transform", session_transform_json(ref.instance->get_transformation())},
                // The short alias is useful to clients that already call all
                // transform payloads simply "transform".
                {"transform", session_transform_json(ref.instance->get_transformation())}};
}

void translate_instance(const PlateInstanceRef& ref, const Vec3d& delta)
{
    if (delta == Vec3d::Zero()) return;
    auto transform = ref.instance->get_transformation();
    transform.set_offset(transform.get_offset() + delta);
    ref.instance->set_transformation(transform);
    ref.object->invalidate_bounding_box();
}

void rebuild_plate_membership(bool clear_parked)
{
    ensure_plate_session_state();
    const PlateBounds bounds = selected_plate_bounds();
    if (clear_parked) state().parked_instance_ids.clear();
    state().instance_plate_ids.clear();
    state().plate_out_of_bounds_ids.clear();
    for (const auto& ref : plate_instance_refs()) {
        if (!clear_parked && state().parked_instance_ids.find(ref.instance_id) != state().parked_instance_ids.end())
            continue;
        const BoundingBoxf3 box = instance_hull_box(ref);
        for (const auto& plate : state().plate_session_plates) {
            if (!box_intersects_plate(box, plate, bounds)) continue;
            state().instance_plate_ids[ref.instance_id] = plate.id;
            if (!box_fully_inside_plate(ref, box, plate, bounds))
                state().plate_out_of_bounds_ids[plate.id].insert(ref.instance_id);
            break; // lowest display-index plate wins ties, matching Orca.
        }
    }
}

json reflow_instance_transforms(const std::map<std::size_t, Vec3d>& changed)
{
    json transforms = json::array();
    for (const auto& ref : plate_instance_refs()) {
        if (changed.find(ref.instance_id) != changed.end())
            transforms.push_back(instance_transform_record(ref));
    }
    return transforms;
}

std::set<std::string> member_plate_ids()
{
    std::set<std::string> ids;
    for (const auto& [instance_id, plate_id] : state().instance_plate_ids) {
        (void)instance_id;
        if (!plate_id.empty()) ids.insert(plate_id);
    }
    return ids;
}

std::set<std::string> all_plate_ids()
{
    std::set<std::string> ids;
    for (const auto& plate : state().plate_session_plates) ids.insert(plate.id);
    return ids;
}

std::set<std::string> member_plate_ids_for_instances(const std::set<std::size_t>& instance_ids)
{
    std::set<std::string> ids;
    for (const auto instance_id : instance_ids) {
        const auto it = state().instance_plate_ids.find(instance_id);
        if (it != state().instance_plate_ids.end() && !it->second.empty()) ids.insert(it->second);
    }
    return ids;
}

json plate_id_array(const std::set<std::string>& ids)
{
    json out = json::array();
    for (const auto& id : ids) out.push_back(id);
    return out;
}

json plate_revisions_json()
{
    json out = json::object();
    for (const auto& plate : state().plate_session_plates) {
        const auto it = state().plate_input_revisions.find(plate.id);
        out[plate.id] = it == state().plate_input_revisions.end() ? 0 : it->second;
    }
    return out;
}

// Finish a committed model mutation.  The membership snapshot is captured
// before callers mutate the Model, then rebuilt exactly once after all selected
// transforms/deletes/imports have been applied.  This gives the renderer one
// atomic response and makes cross-plate edits a single invalidation event.
json plate_mutation_snapshot(const std::set<std::string>& before,
                             const std::vector<std::string>& dirty_reasons,
                             const json& instance_transforms = json::array(),
                             const std::set<std::size_t>* affected_instances = nullptr)
{
    const auto after = affected_instances == nullptr ? member_plate_ids()
                                                       : member_plate_ids_for_instances(*affected_instances);
    std::set<std::string> affected = before;
    affected.insert(after.begin(), after.end());
    for (const auto& id : affected)
        if (find_plate(id) != nullptr) ++state().plate_input_revisions[id];
    json result = plate_session_snapshot_json(instance_transforms);
    result["input_revisions"] = plate_revisions_json();
    result["affected_plate_ids_before"] = plate_id_array(before);
    result["affected_plate_ids_after"] = plate_id_array(after);
    result["affected_plate_ids"] = plate_id_array(affected);
    result["dirty_reasons"] = dirty_reasons;
    // A completed transaction consumes any deferred transform markers. This
    // is important when a structural command (for example Add plate) follows
    // a transform write before the normal recompute call.
    state().pending_membership_instance_ids.clear();
    return result;
}

// Reflow the display grid after a shared configuration change (most notably a
// printer preset changing printable_area).  Plate membership is deliberately
// not recomputed here: every member keeps the same plate-local coordinates,
// while parked/unassigned instances remain untouched.  The returned IDs are
// resolved into authoritative world transforms after all origins have moved.
std::map<std::size_t, Vec3d> reflow_plate_origins_for_bounds(const PlateBounds& bounds)
{
    ensure_plate_session_state();
    const auto old_plates = state().plate_session_plates;
    std::map<std::size_t, Vec3d> changed;
    const int count = static_cast<int>(old_plates.size());
    for (size_t index = 0; index < old_plates.size(); ++index) {
        const Vec3d new_origin = plate_origin_for_index(static_cast<int>(index), count, bounds);
        const Vec3d delta = new_origin - old_plates[index].origin;
        if (delta != Vec3d::Zero()) {
            for (const auto& [instance_id, plate_id] : state().instance_plate_ids) {
                if (plate_id != old_plates[index].id) continue;
                for (const auto& ref : plate_instance_refs()) {
                    if (ref.instance_id == instance_id) {
                        translate_instance(ref, delta);
                        changed[instance_id] = delta;
                        break;
                    }
                }
            }
        }
        state().plate_session_plates[index].origin = new_origin;
    }
    return changed;
}

// A printer change must not move an instance to a different plate, but it can
// change whether that existing member fits its newly sized bed. Refresh only
// the validity map against the new origins/bounds; parked and unassigned
// instances remain outside the map and are never reconsidered here.
void refresh_existing_plate_validity(const PlateBounds& bounds)
{
    state().plate_out_of_bounds_ids.clear();
    for (const auto& membership : state().instance_plate_ids) {
        const auto instance_id = membership.first;
        const auto& plate_id = membership.second;
        if (plate_id.empty() || state().parked_instance_ids.find(instance_id) != state().parked_instance_ids.end())
            continue;
        const auto* plate = find_plate(plate_id);
        if (plate == nullptr) continue;
        const auto refs = plate_instance_refs();
        const auto ref = std::find_if(refs.begin(), refs.end(),
                                      [&](const auto& candidate) { return candidate.instance_id == instance_id; });
        if (ref == refs.end()) continue;
        if (!box_fully_inside_plate(*ref, instance_hull_box(*ref), *plate, bounds))
            state().plate_out_of_bounds_ids[plate_id].insert(instance_id);
    }
}

// Shared printer/process/filament configuration affects every existing plate,
// including empty plates. Keep this transaction in the bridge so the complete
// plate set and its revisions remain authoritative rather than relying on a
// renderer-side list that may be stale.
json shared_configuration_mutation_snapshot()
{
    const auto bounds = selected_plate_bounds();
    const auto changed = reflow_plate_origins_for_bounds(bounds);
    refresh_existing_plate_validity(bounds);
    const auto affected = all_plate_ids();
    for (const auto& id : affected) ++state().plate_input_revisions[id];
    json result = plate_session_snapshot_json(reflow_instance_transforms(changed));
    result["input_revisions"] = plate_revisions_json();
    result["affected_plate_ids_before"] = plate_id_array(affected);
    result["affected_plate_ids_after"] = plate_id_array(affected);
    result["affected_plate_ids"] = plate_id_array(affected);
    result["dirty_reasons"] = {"shared-configuration"};
    state().pending_membership_instance_ids.clear();
    return result;
}

json attach_plate_mutation(json result, const json& mutation)
{
    // Keep the historical result fields stable while exposing the richer
    // session transaction to new clients.  Top-level aliases are intentional:
    // direct bridge harnesses can inspect the contract without knowing the
    // nested client representation.
    result["plate_session"] = mutation;
    for (const char* key : {"plates", "current_plate_id", "instances", "instance_transforms",
                            "input_revisions", "affected_plate_ids_before",
                            "affected_plate_ids_after", "affected_plate_ids", "dirty_reasons"}) {
        // Some structural results already expose a legacy top-level field
        // with the same name (notably numeric `instances` counts for model
        // imports/shapes). Preserve that caller-owned contract; the complete
        // membership array remains available under plate_session.
        if (mutation.contains(key) && !result.contains(key)) result[key] = mutation.at(key);
    }
    return result;
}

// Project archives are staged under a fresh name for every request.  Besides
// preventing concurrent calls from clobbering one another, this keeps the
// source path private to the bridge and avoids leaking host filenames into
// the native reader's temporary files.
std::atomic<std::uint64_t> g_project_temp_sequence{0};

std::string next_project_temp_path(const char* suffix)
{
    const auto sequence = g_project_temp_sequence.fetch_add(1, std::memory_order_relaxed) + 1;
    return "/tmp/orca-project-" + std::to_string(sequence) + (suffix ? suffix : "");
}

void remove_project_temp_path(const std::string& path)
{
    std::remove(path.c_str());
    std::remove((path + ".tmp").c_str());
}

std::size_t model_instance_count(const Model& model)
{
    std::size_t count = 0;
    for (const ModelObject* object : model.objects)
        count += object->instances.size();
    return count;
}

// Model::add_object(const ModelObject&) uses the full clone machinery.  BBS
// project objects can contain archive-backed metadata that makes that clone
// path re-enter the threaded pool, so geometry imports copy the public model
// hierarchy through the normal add-volume/add-instance constructors instead.
ModelObject* append_model_object_geometry(Model& destination, const ModelObject& source)
{
    ModelObject* object = destination.add_object();
    object->name = source.name;
    object->module_name = source.module_name;
    object->input_file = source.input_file;
    object->printable = source.printable;
    object->origin_translation = source.origin_translation;
    if (const auto* extruder = dynamic_cast<const ConfigOptionInt*>(source.config.option("extruder"));
        extruder != nullptr && extruder->value > 0)
        object->config.set_key_value("extruder", new ConfigOptionInt(extruder->value));
    for (const ModelVolume* volume : source.volumes) {
        // Do not use add_volume(const ModelVolume&): that constructor copies
        // the volume's model config. Geometry-only imports intentionally keep
        // only mesh, source, material identity, and transforms.
        TriangleMesh empty_mesh;
        ModelVolume* added = object->add_volume(std::move(empty_mesh), volume->type());
        std::shared_ptr<const TriangleMesh> shared_mesh = volume->get_mesh_shared_ptr();
        added->set_mesh(shared_mesh);
        added->name = volume->name;
        added->source = volume->source;
        added->set_material_id(volume->material_id());
        added->set_transformation(volume->get_transformation());
    }
    for (const ModelInstance* instance : source.instances)
        object->add_instance(*instance);
    return object;
}

struct ProjectPresetWarningDetails {
    bool modified_printer_gcode = false;
    bool modified_filament_gcode = false;
    bool missing_system_preset = false;
    std::set<std::string> modified_gcode_keys;
    json missing_system_preset_types = json::array();
    json preset_evidence = json::array();
};

// Keep this classification in the bridge because PresetBundle's upstream
// validate_presets() returns one mixed set of g-code keys.  The project
// warning contract needs to tell the shared layer whether the modified code
// came from the printer or filament profile.  The sets mirror Orca's
// PresetBundle::gcodes_key_set at the pinned upstream revision.
ProjectPresetWarningDetails inspect_project_preset_warnings(
    PresetBundle& bundle, DynamicPrintConfig& config,
    const std::vector<Preset*>& project_presets, const std::string& path)
{
    ProjectPresetWarningDetails details;
    if (project_presets.empty())
        return details;

    // Run the same upstream validation used by Plater.  We still inspect each
    // embedded preset below so the result can distinguish printer and
    // filament g-code and expose evidence to callers.
    std::set<std::string> upstream_different_gcodes;
    try {
        bundle.validate_presets(path, config, upstream_different_gcodes);
    } catch (...) {
        // Warning extraction must never turn a valid project load into a
        // failed load when an older/generic project omits optional config.
    }

    const std::set<std::string> printer_gcode_keys = {
        "layer_change_gcode", "machine_end_gcode", "machine_pause_gcode",
        "machine_start_gcode", "template_custom_gcode",
        "printing_by_object_gcode", "before_layer_change_gcode",
        "time_lapse_gcode", "wrapping_detection_gcode"
    };
    const std::set<std::string> filament_gcode_keys = {
        "filament_end_gcode", "filament_start_gcode", "change_filament_gcode"
    };
    auto trusted = [](const Preset* preset) {
        return preset != nullptr &&
            (preset->is_system || preset->is_default || preset->is_from_bundle());
    };

    auto inspect_collection = [&](Preset::Type type, PresetCollection& collection,
                                  const char* type_name,
                                  const std::set<std::string>& gcode_keys) {
        for (const Preset* embedded : project_presets) {
            if (!embedded || embedded->type != type)
                continue;

            std::string inherits = embedded->inherits();
            const Preset* parent = inherits.empty() ? nullptr :
                collection.find_preset(inherits, false);
            bool has_matching_system_preset = trusted(parent);
            if (!has_matching_system_preset) {
                // This also honors Orca's renamed-system-preset lookup and is
                // the authoritative missing-preset condition from upstream.
                std::string validation_inherits = inherits;
                has_matching_system_preset =
                    collection.validate_preset(embedded->name, validation_inherits);
                if (has_matching_system_preset && !trusted(parent))
                    parent = collection.find_preset(validation_inherits, false);
            }

            std::vector<std::string> modified_keys;
            if (trusted(parent)) {
                for (const std::string& key : embedded->config.diff(parent->config)) {
                    if (gcode_keys.find(key) != gcode_keys.end()) {
                        modified_keys.push_back(key);
                        details.modified_gcode_keys.insert(key);
                        if (type == Preset::TYPE_PRINTER)
                            details.modified_printer_gcode = true;
                        else if (type == Preset::TYPE_FILAMENT)
                            details.modified_filament_gcode = true;
                    }
                }
            }
            if (!has_matching_system_preset &&
                (type == Preset::TYPE_PRINTER || type == Preset::TYPE_FILAMENT)) {
                details.missing_system_preset = true;
                details.missing_system_preset_types.push_back(type_name);
            }

            details.preset_evidence.push_back({
                {"type", type_name},
                {"name", embedded->name},
                {"inherits", inherits},
                {"has_matching_system_preset", has_matching_system_preset},
                {"modified_gcode_keys", modified_keys},
            });
        }
    };

    inspect_collection(Preset::TYPE_PRINTER, bundle.printers, "printer", printer_gcode_keys);
    inspect_collection(Preset::TYPE_FILAMENT, bundle.filaments, "filament", filament_gcode_keys);

    // Preserve any upstream g-code evidence that was present in the project
    // config even when the corresponding embedded preset was omitted.  The
    // final printer slot is emitted by PresetBundle::full_fff_config(), while
    // filament slots precede it; this is intentionally supplemental to the
    // per-preset comparison above.
    for (const std::string& key : upstream_different_gcodes) {
        if (printer_gcode_keys.find(key) != printer_gcode_keys.end())
            details.modified_printer_gcode = true;
        if (filament_gcode_keys.find(key) != filament_gcode_keys.end())
            details.modified_filament_gcode = true;
        if (printer_gcode_keys.find(key) != printer_gcode_keys.end() ||
            filament_gcode_keys.find(key) != filament_gcode_keys.end())
            details.modified_gcode_keys.insert(key);
    }
    return details;
}

void invalidate_preview_source()
{
    auto& bridge_state = state();
    bridge_state.preview_result_id = 0;
    bridge_state.preview_gcode_path.clear();
    bridge_state.preview_gcode_size = 0;
    bridge_state.preview_gcode_line_ends.clear();
    bridge_state.preview_text_available = false;
    bridge_state.preview_plate_id.clear();
    bridge_state.preview_plate_revision = 0;
}

// Copy a string into a malloc'd C string the JS side can read then _free().
const char* dup_json(const std::string& s) {
    char* out = static_cast<char*>(std::malloc(s.size() + 1));
    std::memcpy(out, s.data(), s.size());
    out[s.size()] = '\0';
    return out;
}

const char* error_json(const std::string& msg) {
    return dup_json(json{{"error", msg}}.dump());
}

std::string sanitized_model_basename(const char* filename, const char* ext) {
    std::string name = filename ? filename : "";
    const auto slash = name.find_last_of("\\/");
    if (slash != std::string::npos) name.erase(0, slash + 1);
    for (char& c : name) {
        const unsigned char uc = static_cast<unsigned char>(c);
        if (!(std::isalnum(uc) || c == '.' || c == '_' || c == '-')) c = '_';
    }
    std::string fallback_ext = ext && *ext ? ext : "stl";
    if (name.empty() || name == "." || name == "..") name = "uploaded_model." + fallback_ext;
    if (name.find_last_of('.') == std::string::npos) name += "." + fallback_ext;
    return name;
}

// SlicingErrors' what() is just the category "Errors" (Exception.hpp:44) —
// the real per-object messages live in its errors_ vector (GCode.cpp:
// collect_layers_to_print aggregates per-object SlicingErrors and rethrows).
// Returning e.what() alone made the renderer show only "Errors" with no
// way to see what actually failed; join the underlying messages instead.
const char* error_json_from_exception(const std::exception& e) {
    if (const auto* se = dynamic_cast<const SlicingErrors*>(&e); se != nullptr) {
        std::string joined;
        for (const auto& err : se->errors_) {
            if (!joined.empty()) joined += "\n";
            joined += err.what();
        }
        if (!joined.empty()) return error_json(joined);
    }
    return error_json(e.what());
}

std::string option_type_name(const ConfigOptionDef& def) {
    switch (def.type) {
        case coFloat:            return "float";
        case coInt:              return "int";
        case coString:           return "string";
        case coBool:             return "bool";
        case coPercent:          return "percent";
        case coFloats:           return "floats";
        case coInts:             return "ints";
        case coStrings:          return "strings";
        case coBools:            return "bools";
        case coEnum:             return "enum";
        case coFloatOrPercent:   return "float_or_percent";
        case coPercents:         return "percents";
        case coPoint:            return "point";
        case coPoints:           return "points";
        case coPoint3:           return "point3";
        // Drift at the pinned SHA: ConfigOptionType has no coVec3d (the enum
        // ends at coPointsGroups/coIntsGroups, Config.hpp:166-203), so the
        // planned coVec3d case is dropped; such types hit default: "unknown".
        default:                 return "unknown";
    }
}

json option_def_to_json(const ConfigOptionDef& def) {
    json j;
    j["type"] = option_type_name(def);
    if (!def.label.empty()) j["label"] = def.label;
    if (!def.full_label.empty()) j["full_label"] = def.full_label;
    if (!def.tooltip.empty()) j["tooltip"] = def.tooltip;
    if (!def.category.empty()) j["category"] = def.category;
    j["mode"] = int(def.mode);
    if (!def.enum_values.empty()) j["enum_values"] = def.enum_values;
    if (!def.enum_labels.empty()) j["enum_labels"] = def.enum_labels;
    if (def.min != 0.0 || def.max != 0.0) {
        j["min"] = def.min;
        j["max"] = def.max;
    }
    if (def.default_value) j["default"] = def.default_value->serialize();
    return j;
}

// Internal profile visibility bootstrap; preferences remain host-owned.
// The app config JSON (the fork's USE_JSON_CONFIG schema) is the single
// source of truth for installed printers + selections; the renderer owns
// it and persists it (see doc/2026-08-15-m4-preset-management-design.md).
// AppConfig::load() is file-based (loading_path()), so the bridge
// populates the live instance through the public setters instead —
// set_variant (models), set/set_section (presets/filaments). The loader's
// JSON keys: "models" (vendor/model/nozzle_diameter objects),
// "presets" (machine/process/filament + multi-material filament_*),
// "filaments" (array of installed filament names).

// Returns true when the JSON carried a "models" section (installed-state
// is authoritative); false means "fresh config" → install everything.
bool apply_app_config(const json& j) {
    AppConfig& cfg = state().profile_config;
    bool has_models = false;
    for (auto it = j.begin(); it != j.end(); ++it) {
        if (it.key() == "models" && it.value().is_array()) {
            has_models = true;
            for (const auto& j_model : it.value()) {
                if (!j_model.is_object()) continue;
                std::string vendor, model;
                if (j_model.contains("vendor") && j_model["vendor"].is_string())
                    vendor = j_model["vendor"].get<std::string>();
                if (j_model.contains("model") && j_model["model"].is_string())
                    model = j_model["model"].get<std::string>();
                std::vector<std::string> variants;
                if (vendor.empty() || model.empty() ||
                    !j_model.contains("nozzle_diameter"))
                    continue;
                // The fork's on-disk form is an escaped string
                // (escape_strings_cstyle, see serialize_app_config); accept
                // a plain array too (hand-written configs, probe fixtures).
                if (j_model["nozzle_diameter"].is_array()) {
                    for (const auto& v : j_model["nozzle_diameter"])
                        if (v.is_string())
                            variants.push_back(v.get<std::string>());
                } else if (j_model["nozzle_diameter"].is_string()) {
                    if (!unescape_strings_cstyle(
                            j_model["nozzle_diameter"].get<std::string>(), variants))
                        continue;
                } else {
                    continue;
                }
                if (variants.empty()) continue;
                for (const auto& v : variants)
                    cfg.set_variant(vendor, model, v, true);
            }
        } else if (it.key() == "presets" && it.value().is_object()) {
            for (auto pk = it.value().begin(); pk != it.value().end(); ++pk)
                if (pk.value().is_string())
                    cfg.set("presets", pk.key(), pk.value().get<std::string>());
        } else if (it.key() == "filaments" && it.value().is_array()) {
            std::map<std::string, std::string> installed;
            for (const auto& el : it.value())
                if (el.is_string()) installed[el.get<std::string>()] = "true";
            cfg.set_section("filaments", installed);
        }
    }
    return has_models;
}

// The shared application installs every shipped profile package before calling
// orc_init(). Preserve that delivery decision in the native visibility gate:
// the legacy AppConfig fields are an implementation detail here, not a second
// record of which profiles the user installed.
void install_all_filaments() {
    AppConfig& cfg = state().profile_config;
    for (const Preset& p : state().presets.filaments) {
        if (p.is_system)
            cfg.set(AppConfig::SECTION_FILAMENTS, p.name, "true");
    }
}

// Fresh-config default: install every printer and filament the bundle ships.
// The vendor/model/variant triple only exists in the preset configs, so this
// runs after load_presets (chicken-and-egg with set_visible_from_appconfig
// otherwise). Visibility is then recomputed through the native AppConfig
// path; compatibility, including OrcaFilamentLibrary generic supersession,
// remains wholly owned by PresetBundle.
void install_all_printers() {
    AppConfig& cfg = state().profile_config;
    for (const Preset& p : state().presets.printers) {  // begin()/end(): skips generated defaults
        if (p.vendor == nullptr) continue;
        const std::string model   = p.config.opt_string("printer_model");
        const std::string variant = p.config.opt_string("printer_variant");
        if (model.empty() || variant.empty()) continue;
        cfg.set_variant(p.vendor->id, model, variant, true);
    }
    install_all_filaments();
    // load_selections is the public entry that recomputes visibility and
    // compatibility from the now-complete package-derived installed state.
    // With no saved selection, reselect_after_app_config establishes the
    // baseline selection next.
    state().presets.load_selections(cfg);
}

// Re-apply the selection after installed-state changed: presets.machine
// wins; on a fresh config (no name yet) keep the round-5 baseline — first
// non-default preset — but now over an all-visible collection. The
// load_selections tail (update_compatible + multi-material) then fixes
// print/filament for the active machine.
void reselect_after_app_config() {
    const std::string initial = state().profile_config.get("presets", PRESET_PRINTER_NAME);
    bool selected = !initial.empty() &&
                    state().presets.printers.select_preset_by_name(initial, true);
    if (!selected) {
        size_t sel_idx = 0;
        for (auto it = state().presets.printers.lbegin();
             it != state().presets.printers.end(); ++it, ++sel_idx) {
            if (it->is_default) continue;
            state().presets.printers.select_preset(sel_idx);
            break;
        }
    }
    state().presets.update_compatible(PresetSelectCompatibleType::Always);
    state().presets.update_multi_material_filament_presets();
}

// Rebuild the app config JSON the renderer persists — same schema and code
// paths as AppConfig::save() (models from the public vendors() map,
// filaments as an array, presets key/values).
json serialize_app_config() {
    const AppConfig& cfg = state().profile_config;
    json j = json::object();
    if (cfg.has_section("presets"))
        for (const auto& kvp : cfg.get_section("presets"))
            j["presets"][kvp.first] = kvp.second;
    if (cfg.has_section("filaments")) {
        json arr = json::array();
        for (const auto& kvp : cfg.get_section("filaments"))
            arr.push_back(kvp.first);
        j["filaments"] = std::move(arr);
    }
    for (const auto& vendor : cfg.vendors()) {
        for (const auto& model : vendor.second) {
            if (model.second.empty()) continue;
            const std::vector<std::string> variants(model.second.begin(), model.second.end());
            j["models"].push_back(json{
                {"vendor", vendor.first},
                {"model", model.first},
                {"nozzle_diameter", escape_strings_cstyle(variants)},
            });
        }
    }
    return j;
}

// Build the one coherent preset view consumed by the picker UI.  The
// compatibility state belongs to PresetBundle: the bridge deliberately does
// not interpret compatible_printers / compatible_prints itself because that
// would duplicate the upstream condition, inheritance, library-exclusion and
// parent-preset rules.
json preset_entry_json(const Preset& preset, const PresetCollection& collection,
                       bool include_selection = true) {
    json entry{{"name", preset.name},
               {"is_visible", preset.is_visible},
               {"is_default", preset.is_default}};
    if (include_selection)
        entry["selected"] = preset.name == collection.get_selected_preset_name();
    entry["vendor_id"] = preset.vendor ? preset.vendor->id : "";
    entry["model"]     = preset.config.opt_string("printer_model");
    entry["variant"]   = preset.config.opt_string("printer_variant");
    return entry;
}

json preset_candidates_json(const PresetCollection& collection, bool require_compatible,
                            bool include_selection = true) {
    json candidates = json::array();
    // begin()/end() intentionally omit generated "- default -" presets.
    // Keep the collection order: it is the engine's candidate ordering and
    // must not be re-sorted by an application-layer policy.
    for (auto it = collection.begin(); it != collection.end(); ++it) {
        if (!it->is_visible || (require_compatible && !it->is_compatible))
            continue;
        candidates.push_back(preset_entry_json(*it, collection, include_selection));
    }
    return candidates;
}

json preset_selection_json(const PresetCollection& collection) {
    return json{{"name", collection.get_selected_preset_name()},
                {"idx", collection.get_selected_idx()}};
}

json selected_printer_printable_area_json() {
    json points = json::array();
    const Preset& printer = state().presets.printers.get_selected_preset();
    const ConfigOptionPoints* area = printer.config.opt<ConfigOptionPoints>("printable_area");
    if (area == nullptr || area->values.size() < 3)
        return points;
    for (const Vec2d& point : area->values) {
        if (!std::isfinite(point.x()) || !std::isfinite(point.y()))
            return json::array();
        points.push_back({point.x(), point.y()});
    }
    return points;
}

// This is emitted only after the caller has completed any native compatibility
// recalculation and fallback. It is intentionally the only picker-state read:
// callers must not compose a UI state from separate collection reads.
json preset_snapshot_json() {
    return json{{"ok", true},
                {"printers", preset_candidates_json(state().presets.printers, false)},
                {"prints", preset_candidates_json(state().presets.prints, true)},
                {"filament_catalog", preset_candidates_json(state().presets.filaments, true, false)},
                {"printer", preset_selection_json(state().presets.printers)},
                {"print", preset_selection_json(state().presets.prints)},
                {"printable_area", selected_printer_printable_area_json()}};
}

// Step 1 filament-session projection.  This is deliberately a read-only
// native projection: slot numbering, maps, colours, assignments, and
// capability limits are all read from the active PresetBundle/Model session.
// The wire keys stay snake_case at the C ABI, just like the other bridge
// snapshots; client.ts owns the only normalization to application types.
std::vector<std::string> config_strings(const DynamicPrintConfig& config, const char* key)
{
    if (const auto* option = config.opt<ConfigOptionStrings>(key)) return option->values;
    return {};
}

// Keep the requested slot order from the imported project before
// load_config_model performs native preset selection/fallback.  The latter is
// the effective state; it is not provenance for the compatibility report.
std::vector<std::string> requested_filament_slots_from_import(
    const DynamicPrintConfig& config, const std::vector<std::string>& fallback)
{
    const auto requested = config_strings(config, "filament_settings_id");
    return requested.empty() ? fallback : requested;
}

// load_bbs_3mf may already normalize the DynamicPrintConfig before the
// candidate's load_config_model call.  BBS/Orca JSON is therefore retained as
// the provenance source for the compatibility report when it is available.
std::vector<std::string> requested_filament_slots_from_project_settings(
    const std::optional<std::string>& bytes, const std::vector<std::string>& fallback)
{
    if (bytes) {
        const json parsed = json::parse(*bytes, nullptr, false);
        if (parsed.is_object() && parsed.contains("filament_settings_id")) {
            const auto& value = parsed["filament_settings_id"];
            std::vector<std::string> result;
            if (value.is_array()) {
                for (const auto& item : value)
                    if (!item.is_string()) return fallback;
                    else result.push_back(item.get<std::string>());
            } else if (value.is_string()) {
                result.push_back(value.get<std::string>());
            } else {
                return fallback;
            }
            if (!result.empty()) return result;
        }
    }
    return fallback;
}
std::vector<int> config_ints(const DynamicPrintConfig& config, const char* key)
{
    if (const auto* option = config.opt<ConfigOptionInts>(key)) return option->values;
    return {};
}
std::vector<double> config_floats(const DynamicPrintConfig& config, const char* key)
{
    if (const auto* option = config.opt<ConfigOptionFloats>(key)) return option->values;
    return {};
}

json filament_session_error_json(const char* code, const char* message)
{
    return { {"ok", false}, {"version", 1}, {"error", message}, {"error_code", code},
             {"status", {{"state", "error"}, {"error", message}}} };
}

bool effective_filament_int_map(const DynamicPrintConfig& primary, const char* key,
                                const DynamicPrintConfig& fallback, size_t slot_count,
                                int default_value, std::vector<int>& out)
{
    out = config_ints(primary, key);
    if (out.empty()) out = config_ints(fallback, key);
    if (out.size() > slot_count) return false;
    out.resize(slot_count, default_value);
    return true;
}

json filament_session_snapshot_json()
{
    PresetBundle& bundle = state().presets;
    const DynamicPrintConfig& project = bundle.project_config;
    const DynamicPrintConfig& printer = bundle.printers.get_edited_preset().config;
    const DynamicPrintConfig& filament = bundle.filaments.get_edited_preset().config;

    std::vector<std::string> preset_names = bundle.filament_presets;
    std::vector<std::string> colours = config_strings(project, "filament_colour");
    if (colours.empty()) colours = config_strings(filament, "filament_colour");
    if (preset_names.empty())
        return filament_session_error_json("filament_slots_missing", "filament rack has no slots");
    const size_t slot_count = std::max<size_t>(1, std::max(preset_names.size(), colours.size()));
    if (preset_names.size() < slot_count) {
        return filament_session_error_json("filament_slots_mismatched", "filament rack slots and colours differ");
    }
    std::vector<std::string> preset_colours(slot_count);
    const auto native_default_colours = state().profile_config.get_filament_colors();
    // PresetBundle materializes this same native fallback when a selected
    // filament preset has no explicit filament_colour (the common Generic
    // PLA/default session). Keep the projection aligned with that native
    // effective colour rather than treating the materialized project value as
    // a user edit.
    constexpr const char* native_filament_colour_fallback = "#26A69A";
    for (size_t i = 0; i < slot_count; ++i) {
        if (const Preset* real_preset = bundle.filaments.find_preset(preset_names[i], false, true)) {
            const auto native_colours = config_strings(real_preset->config, "filament_colour");
            if (!native_colours.empty()) preset_colours[i] = native_colours.front();
            else {
                const auto default_colours = config_strings(real_preset->config, "default_filament_colour");
                if (!default_colours.empty()) preset_colours[i] = default_colours.front();
            }
        }
        if (preset_colours[i].empty() && i < native_default_colours.size())
            preset_colours[i] = native_default_colours[i];
        if (preset_colours[i].empty())
            preset_colours[i] = native_filament_colour_fallback;
    }
    if (colours.size() < slot_count) {
        const auto defaults = state().profile_config.get_filament_colors();
        for (size_t i = colours.size(); i < slot_count; ++i)
            colours.push_back(!preset_colours[i].empty() ? preset_colours[i] :
                              (i < defaults.size() ? defaults[i] : std::string("#000000")));
    }

    json slots = json::array();
    for (size_t i = 0; i < slot_count; ++i) {
        const std::string& name = preset_names[i];
        // project_config.filament_colour is materialized during init even for
        // pristine sessions. Provenance therefore uses effective equivalence
        // with the real selected preset colour. An explicit override equal to
        // that colour is intentionally reported as preset-equivalent because a
        // read-only native projection cannot recover edit history.
        const bool preset_equivalent = !preset_colours[i].empty() && colours[i] == preset_colours[i];
        slots.push_back({
            {"slot", i + 1},
            {"preset", {{"id", name}, {"name", name}}},
            {"colour", {{"effective", colours[i]}, {"provenance", preset_equivalent ? "preset" : "user"}}},
        });
    }

    std::vector<int> filament_map;
    std::vector<int> volume_map;
    std::vector<int> nozzle_map;
    std::vector<int> filament_map_2;
    if (!effective_filament_int_map(project, "filament_map", printer, slot_count, 1, filament_map))
        return filament_session_error_json("filament_map_too_long", "filament_map exceeds slot count");
    if (!effective_filament_int_map(project, "filament_volume_map", printer, slot_count, 0, volume_map))
        return filament_session_error_json("filament_volume_map_too_long", "filament_volume_map exceeds slot count");
    if (!effective_filament_int_map(project, "filament_nozzle_map", printer, slot_count, 1, nozzle_map))
        return filament_session_error_json("filament_nozzle_map_too_long", "filament_nozzle_map exceeds slot count");
    if (!effective_filament_int_map(project, "filament_map_2", printer, slot_count, 1, filament_map_2))
        return filament_session_error_json("filament_map_2_too_long", "filament_map_2 exceeds slot count");

    const int printer_nozzles = std::max(1, bundle.get_printer_extruder_count());
    std::vector<int> physical_map;
    if (!effective_filament_int_map(printer, "physical_extruder_map", printer,
                                    static_cast<size_t>(printer_nozzles), 0, physical_map))
        return filament_session_error_json("physical_extruder_map_too_long", "physical_extruder_map exceeds nozzle count");
    json mappings = {
        {"filament", filament_map}, {"volume", volume_map}, {"nozzle", nozzle_map},
        {"filament2", filament_map_2}, {"physical_extruder", physical_map},
    };

    auto matrix = config_floats(project, "flush_volumes_matrix");
    if (matrix.empty()) matrix = config_floats(printer, "flush_volumes_matrix");
    const bool matrix_is_native = !matrix.empty();
    size_t matrix_dimension = slot_count;
    size_t matrix_plane_count = 1;
    if (matrix.empty()) {
        matrix_plane_count = static_cast<size_t>(printer_nozzles);
        matrix.assign(matrix_dimension * matrix_dimension * matrix_plane_count, 0.0);
    } else {
        const size_t plane_size = matrix_dimension * matrix_dimension;
        if (plane_size == 0 || matrix.size() % plane_size != 0)
            return filament_session_error_json("flush_matrix_malformed", "flush_volumes_matrix is not a whole native plane");
        matrix_plane_count = matrix.size() / plane_size;
        // Native get_flush_volumes_matrix() treats the raw vector as one
        // complete slot matrix per physical nozzle. Preserve every plane;
        // reject a count that cannot be selected by that native API.
        if (matrix_plane_count == 0 || matrix_plane_count != static_cast<size_t>(printer_nozzles))
            return filament_session_error_json("flush_matrix_plane_count_mismatch", "flush_volumes_matrix plane count does not match nozzle count");
        if (std::any_of(matrix.begin(), matrix.end(), [](double value) { return !std::isfinite(value); }))
            return filament_session_error_json("flush_matrix_malformed", "flush_volumes_matrix contains invalid values");
    }
    auto flush_vector = config_floats(project, "flush_volumes_vector");
    if (flush_vector.empty()) flush_vector = config_floats(printer, "flush_volumes_vector");
    json flushing = {{"matrix", matrix}, {"vector", flush_vector},
                     {"matrix_dimension", matrix_dimension}, {"plane_count", matrix_plane_count},
                     {"source", matrix_is_native ? "native" : "default"}};

    const bool flexible_slots = printer.opt_bool("single_extruder_multi_material") || bundle.is_bbl_vendor();
    const int min_slots = flexible_slots ? 1 : printer_nozzles;
    json capabilities = {
        {"min_slots", min_slots}, {"max_slots", 64}, {"nozzle_count", printer_nozzles},
        {"flexible", flexible_slots},
        {"can_add", flexible_slots && slot_count < 64},
        {"can_delete", flexible_slots && slot_count > 1},
        {"can_merge", flexible_slots && slot_count > 1},
    };

    struct Assignment { std::string target; uint32_t id; uint32_t object_id; int explicit_slot; int effective_slot; bool inherited; };
    std::vector<Assignment> objects;
    std::vector<Assignment> parts;
    std::vector<Assignment> modifiers;
    auto explicit_extruder = [](const auto& config) {
        if (const auto* option = dynamic_cast<const ConfigOptionInt*>(config.option("extruder")))
            return std::max(0, option->value);
        return 0;
    };
    for (const ModelObject* object : state().model.objects) {
        if (object == nullptr) continue;
        const int object_explicit = std::max(1, explicit_extruder(object->config));
        const int object_effective = object_explicit;
        if (object_effective > static_cast<int>(slot_count))
            return filament_session_error_json("assignment_slot_out_of_range", "object assignment exceeds slot count");
        objects.push_back({"object", static_cast<uint32_t>(object->id().id), static_cast<uint32_t>(object->id().id), object_explicit, object_effective, false});
        for (const ModelVolume* volume : object->volumes) {
            if (volume == nullptr) continue;
            const auto type = volume->type();
            if (type != ModelVolumeType::MODEL_PART && type != ModelVolumeType::PARAMETER_MODIFIER) continue;
            const int explicit_slot = explicit_extruder(volume->config);
            // Restored history models are materialized from the archive and
            // intentionally do not rely on ModelVolume's parent back-pointer.
            // Resolve inheritance from the serialized configs directly.
            const int effective_slot = std::max(1, explicit_slot == 0 ? object_explicit : explicit_slot);
            const bool inherited = explicit_slot == 0;
            if (explicit_slot > static_cast<int>(slot_count) || effective_slot > static_cast<int>(slot_count) ||
                (!inherited && effective_slot != explicit_slot))
                return filament_session_error_json("assignment_slot_out_of_range", "volume assignment exceeds slot count");
            Assignment item{type == ModelVolumeType::MODEL_PART ? "model-part" : "parameter-modifier",
                            static_cast<uint32_t>(volume->id().id), static_cast<uint32_t>(object->id().id), explicit_slot, effective_slot, inherited};
            (type == ModelVolumeType::MODEL_PART ? parts : modifiers).push_back(item);
        }
    }
    auto assignment_json = [](const std::vector<Assignment>& values) {
        json out = json::array();
        for (const Assignment& item : values)
            out.push_back({{"target", item.target}, {"id", item.id}, {"object_id", item.object_id},
                           {"explicit_slot", item.explicit_slot}, {"effective_slot", item.effective_slot},
                           {"inherited", item.inherited}});
        return out;
    };
    std::sort(objects.begin(), objects.end(), [](const Assignment& a, const Assignment& b) { return a.id < b.id; });
    std::sort(parts.begin(), parts.end(), [](const Assignment& a, const Assignment& b) { return a.id < b.id; });
    std::sort(modifiers.begin(), modifiers.end(), [](const Assignment& a, const Assignment& b) { return a.id < b.id; });

    json revisions = {{"session", state().history_revision}, {"project", state().history_revision},
                      {"result", state().preview_result_id}, {"plates", plate_revisions_json()}};
    json routing = json::array();
    const std::array<std::pair<const char *, const char *>, 8> routing_keys = {{
        {"support-base", "support_filament"}, {"support-interface", "support_interface_filament"},
        {"outer-wall", "outer_wall_filament_id"}, {"inner-wall", "inner_wall_filament_id"},
        {"sparse-infill", "sparse_infill_filament_id"}, {"internal-solid-infill", "internal_solid_filament_id"},
        {"top-surface", "top_surface_filament_id"}, {"bottom-surface", "bottom_surface_filament_id"},
    }};
    auto option_value = [](const auto& config, const char* key) {
        if (const auto* option = dynamic_cast<const ConfigOptionInt*>(config.option(key))) return option->value;
        return 0;
    };
    auto routing_values = [&](const auto& config) {
        std::vector<int> values;
        values.reserve(routing_keys.size());
        for (const auto& [selector, key] : routing_keys) values.push_back(option_value(config, key));
        return values;
    };
    auto append_routing = [&](const char* target, std::size_t id, std::size_t object_id,
                              const auto& config, const std::vector<int>& parent_values,
                              int assignment_slot, const bool support_only, const bool feature_only) {
        const auto own_values = routing_values(config);
        for (std::size_t index = 0; index < routing_keys.size(); ++index) {
            const auto& [selector, key] = routing_keys[index];
            const bool feature = std::string(selector) != "support-base" && std::string(selector) != "support-interface";
            if ((support_only && feature) || (feature_only && !feature)) continue;
            const int own = own_values[index];
            const int parent = parent_values.empty() ? 0 : parent_values[index];
            const int effective = own > 0 ? own : (parent > 0 ? parent : (feature ? assignment_slot : 0));
            const bool inherited = own == 0 && !parent_values.empty();
            // `defaulted` describes an effective native zero, not the fact that
            // an object inherits.  An object inheriting an explicit project
            // support route is therefore inherited=true, defaulted=false.
            const bool defaulted = effective == 0;
            routing.push_back({{"target", target}, {"id", id}, {"object_id", object_id},
                               {"selector", selector}, {"explicit_slot", own},
                               {"effective_slot", effective}, {"inherited", inherited},
                               {"defaulted", defaulted}});
        }
    };
    append_routing("project", 0, 0, bundle.project_config, {}, 0, true, false);
    for (const ModelObject* object : state().model.objects) {
        if (object == nullptr) continue;
        const int object_slot = std::max(1, explicit_extruder(object->config));
        append_routing("object", object->id().id, object->id().id, object->config,
                       routing_values(bundle.project_config), object_slot, false, false);
        for (const ModelVolume* volume : object->volumes) {
            if (volume == nullptr || volume->type() != ModelVolumeType::MODEL_PART) continue;
            const int explicit_slot = explicit_extruder(volume->config);
            const int assignment_slot = std::max(1, explicit_slot == 0 ? object_slot : explicit_slot);
            append_routing("model-part", volume->id().id, object->id().id, volume->config,
                           routing_values(object->config), assignment_slot, false, true);
        }
    }
    return {{"ok", true}, {"version", 1}, {"slots", slots}, {"mappings", mappings},
            {"flushing", flushing}, {"capabilities", capabilities}, {"routing", routing},
            {"assignments", {{"objects", assignment_json(objects)}, {"parts", assignment_json(parts)},
                             {"modifiers", assignment_json(modifiers)}}},
            {"revisions", revisions}, {"status", {{"state", "ready"}, {"error", nullptr}}}};
}

// Step 2 filament commands.  Requests are intentionally versioned and carry
// the snapshot session revision.  All edits are made against temporary native
// copies and are published only after the complete projection validates.
json filament_command_error(const char* code, const std::string& message)
{
    return { {"ok", false}, {"version", 1}, {"error", message}, {"error_code", code},
             {"status", {{"state", "error"}, {"error", message}}} };
}

struct FilamentCommandFailure : std::runtime_error {
    const char* code;
    FilamentCommandFailure(const char* failure_code, const std::string& message)
        : std::runtime_error(message), code(failure_code) {}
};

std::optional<std::size_t> filament_command_slot(const json& request, const char* key,
                                                  std::size_t count, std::string& error)
{
    if (!request.contains(key) || !request[key].is_number_integer()) {
        error = std::string(key) + " is required";
        return std::nullopt;
    }
    const auto one_based = request[key].get<std::int64_t>();
    if (one_based < 1 || static_cast<std::uint64_t>(one_based) > count) {
        error = std::string(key) + " is outside the ordered filament slots";
        return std::nullopt;
    }
    return static_cast<std::size_t>(one_based - 1);
}

bool valid_filament_colour(const std::string& colour)
{
    if (colour.size() != 7 && colour.size() != 9 || colour.front() != '#') return false;
    return std::all_of(colour.begin() + 1, colour.end(), [](const char value) {
        return std::isxdigit(static_cast<unsigned char>(value)) != 0;
    });
}

std::string filament_preset_colour(const PresetBundle& bundle, const std::size_t slot)
{
    if (slot >= bundle.filament_presets.size()) return "#26A69A";
    const Preset* preset = bundle.filaments.find_preset(bundle.filament_presets[slot], false);
    if (preset != nullptr) {
        if (const auto* colours = preset->config.opt<ConfigOptionStrings>("filament_colour");
            colours != nullptr && !colours->values.empty()) return colours->values.front();
        if (const auto* colours = preset->config.opt<ConfigOptionStrings>("default_filament_colour");
            colours != nullptr && !colours->values.empty()) return colours->values.front();
    }
    return "#26A69A";
}

std::optional<std::string> user_filament_colour_override(const PresetBundle& bundle, const std::size_t slot)
{
    const auto* colours = bundle.project_config.option<ConfigOptionStrings>("filament_colour");
    if (colours == nullptr || slot >= colours->values.size() || !valid_filament_colour(colours->values[slot]))
        return std::nullopt;
    const std::string native = filament_preset_colour(bundle, slot);
    return colours->values[slot] == native ? std::nullopt : std::optional<std::string>(colours->values[slot]);
}

int remap_filament_reference(const int value, const std::size_t removed,
                             const std::optional<std::size_t>& replacement)
{
    if (value <= 0) return value;
    const std::size_t current = static_cast<std::size_t>(value - 1);
    if (current == removed)
        return replacement.has_value() ? static_cast<int>(*replacement + 1) : 1;
    return static_cast<int>((current > removed ? current - 1 : current) + 1);
}

bool is_filament_slot_reference_key(const std::string& key)
{
    // Audited one-based slot references.  Do not infer references from a
    // substring: filament temperatures, purge settings, shrinkage, and other
    // numeric material properties must survive slot deletion unchanged.
    static const std::set<std::string> keys = {
        "extruder", "support_filament", "support_interface_filament", "wipe_tower_filament",
        "outer_wall_filament_id", "inner_wall_filament_id", "sparse_infill_filament_id",
        "internal_solid_filament_id", "top_surface_filament_id", "bottom_surface_filament_id",
    };
    return keys.find(key) != keys.end();
}

int remap_filament_config_reference(const std::string& key, const int value,
                                    const std::size_t removed,
                                    const std::optional<std::size_t>& replacement)
{
    // Support/raft and feature routing use native zero as Default.  A plain
    // slot Delete therefore clears a deleted explicit route to Default, while
    // ordinary object/part assignments retain Orca's slot-1 fallback.
    if (!replacement.has_value() && value == static_cast<int>(removed + 1) &&
        (key == "support_filament" || key == "support_interface_filament" ||
         key == "outer_wall_filament_id" || key == "inner_wall_filament_id" ||
         key == "sparse_infill_filament_id" || key == "internal_solid_filament_id" ||
         key == "top_surface_filament_id" || key == "bottom_surface_filament_id"))
        return 0;
    return remap_filament_reference(value, removed, replacement);
}

template <typename Config>
void remap_config_filament_references(Config& config, const std::size_t removed,
                                      const std::optional<std::size_t>& replacement)
{
    const auto keys = config.keys();
    for (const std::string& key : keys) {
        if (!is_filament_slot_reference_key(key)) continue;
        const auto* option = dynamic_cast<const ConfigOptionInt*>(config.option(key));
        if (option == nullptr) continue;
        config.set_key_value(key, new ConfigOptionInt(remap_filament_config_reference(key, option->value, removed, replacement)));
    }
}

void remap_overlay_filament_references(json& overlay, const std::size_t removed,
                                       const std::optional<std::size_t>& replacement)
{
    if (!valid_project_config_overlay(overlay))
        throw FilamentCommandFailure("unsupported_reference", "invalid project configuration overlay");
    auto remap_values = [&](json& values) {
        if (!values.is_object()) return;
        for (auto option = values.begin(); option != values.end(); ++option) {
            if (!is_filament_slot_reference_key(option.key()) || !option.value().is_string()) continue;
            try {
                const int old_value = std::stoi(option.value().get<std::string>());
                option.value() = std::to_string(remap_filament_config_reference(option.key(), old_value, removed, replacement));
            } catch (...) {
                throw FilamentCommandFailure("unsupported_reference", "invalid filament reference in project overlay");
            }
        }
    };
    remap_values(overlay["project"]);
    for (const char* scope : {"objects", "parts", "plates"})
        for (auto it = overlay[scope].begin(); it != overlay[scope].end(); ++it)
            remap_values(it.value());
}

void remap_plate_filament_references(std::vector<BridgeState::PlateSessionPlate>& plates,
                                     const std::size_t removed,
                                     const std::optional<std::size_t>& replacement,
                                     const std::size_t old_count)
{
    for (auto& plate : plates) {
        remap_config_filament_references(plate.settings, removed, replacement);

        // PartPlate stores these arrays as per-filament values.  They are not
        // slot references: deletion removes the selected element, while a
        // merge first redirects the selected element's sequence users to the
        // (post-delete) destination.  Keep this equivalent to
        // PartPlate::on_filament_deleted instead of treating every integer
        // containing "filament" as a reference.
        for (const char* key : {"filament_map", "filament_nozzle_map", "filament_volume_map"}) {
            if (auto* values = plate.settings.option<ConfigOptionInts>(key)) {
                if (values->values.size() != old_count)
                    throw FilamentCommandFailure("unsupported_reference", "malformed per-plate filament map");
                values->values.erase(values->values.begin() + static_cast<std::ptrdiff_t>(removed));
            }
        }

        if (auto* first = plate.settings.option<ConfigOptionInts>("first_layer_print_sequence")) {
            if (!first->values.empty() && first->values.front() != 0) {
                for (const int value : first->values)
                    if (value < 1 || value > static_cast<int>(old_count))
                        throw FilamentCommandFailure("unsupported_reference", "malformed first-layer filament sequence");
                first->values.erase(std::remove(first->values.begin(), first->values.end(),
                                                static_cast<int>(removed + 1)), first->values.end());
                for (int& value : first->values)
                    if (value > static_cast<int>(removed + 1)) --value;
            }
        }

        auto* other = plate.settings.option<ConfigOptionInts>("other_layers_print_sequence");
        auto* other_count = plate.settings.option<ConfigOptionInt>("other_layers_print_sequence_nums");
        if ((other == nullptr) != (other_count == nullptr))
            throw FilamentCommandFailure("unsupported_reference", "incomplete per-plate layer sequence");
        if (other != nullptr) {
            if (other_count->value <= 0 || other->values.empty() ||
                other->values.size() % static_cast<std::size_t>(other_count->value) != 0)
                throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
            const std::size_t width = other->values.size() / static_cast<std::size_t>(other_count->value);
            if (width < 3) throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
            for (std::size_t sequence = 0; sequence < static_cast<std::size_t>(other_count->value); ++sequence) {
                for (std::size_t offset = 2; offset < width; ++offset) {
                    int& value = other->values[sequence * width + offset];
                    if (value < 1 || value > static_cast<int>(old_count))
                        throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
                    if (value == static_cast<int>(removed + 1)) {
                        value = replacement ? static_cast<int>(*replacement + 1) : 1;
                    } else if (value > static_cast<int>(removed + 1)) {
                        --value;
                    }
                }
            }
        }
        plate.settings_metadata = config_metadata_json(plate.settings);
    }
}

void validate_plate_filament_state(const BridgeState::PlateSessionPlate& plate,
                                   const std::size_t count,
                                   const int nozzle_count)
{
    for (const char* key : {"filament_map", "filament_nozzle_map", "filament_volume_map"}) {
        if (const auto* values = plate.settings.opt<ConfigOptionInts>(key)) {
            if (values->values.size() != count)
                throw FilamentCommandFailure("unsupported_reference", "malformed per-plate filament map");
            for (const int value : values->values)
                if (value < 0 || value > nozzle_count)
                    throw FilamentCommandFailure("unsupported_reference", "per-plate filament map is out of range");
        }
    }
    if (const auto* first = plate.settings.opt<ConfigOptionInts>("first_layer_print_sequence")) {
        if (!first->values.empty() && first->values.front() != 0)
            for (const int value : first->values)
                if (value < 1 || value > static_cast<int>(count))
                    throw FilamentCommandFailure("unsupported_reference", "malformed first-layer filament sequence");
    }
    const auto* other = plate.settings.opt<ConfigOptionInts>("other_layers_print_sequence");
    const auto* other_count = plate.settings.opt<ConfigOptionInt>("other_layers_print_sequence_nums");
    if ((other == nullptr) != (other_count == nullptr))
        throw FilamentCommandFailure("unsupported_reference", "incomplete per-plate layer sequence");
    if (other != nullptr) {
        if (other_count->value <= 0 || other->values.empty() ||
            other->values.size() % static_cast<std::size_t>(other_count->value) != 0)
            throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
        const std::size_t width = other->values.size() / static_cast<std::size_t>(other_count->value);
        if (width < 3) throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
        for (std::size_t sequence = 0; sequence < static_cast<std::size_t>(other_count->value); ++sequence)
            for (std::size_t offset = 2; offset < width; ++offset) {
                const int value = other->values[sequence * width + offset];
                if (value < 1 || value > static_cast<int>(count))
                    throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
            }
    }
}

void add_plate_filament_references(std::vector<BridgeState::PlateSessionPlate>& plates,
                                   const PresetBundle& bundle,
                                   const std::size_t old_count)
{
    int volume_type = 0;
    if (const auto* volumes = bundle.project_config.opt<ConfigOptionEnumsGeneric>("nozzle_volume_type");
        volumes != nullptr && !volumes->values.empty())
        volume_type = volumes->values.front() == 2 ? 0 : volumes->values.front(); // Hybrid is stored as Standard.
    for (auto& plate : plates) {
        if (auto* values = plate.settings.option<ConfigOptionInts>("filament_map")) {
            if (values->values.size() != old_count)
                throw FilamentCommandFailure("unsupported_reference", "malformed per-plate filament map");
            values->values.push_back(1);
        }
        if (auto* values = plate.settings.option<ConfigOptionInts>("filament_nozzle_map")) {
            if (values->values.size() != old_count)
                throw FilamentCommandFailure("unsupported_reference", "malformed per-plate filament map");
            values->values.push_back(0);
        }
        if (auto* values = plate.settings.option<ConfigOptionInts>("filament_volume_map")) {
            if (values->values.size() != old_count)
                throw FilamentCommandFailure("unsupported_reference", "malformed per-plate filament map");
            values->values.push_back(volume_type);
        }

        // Native Plater::on_filament_count_change calls
        // PartPlate::update_first_layer_print_sequence after on_filament_added.
        if (auto* first = plate.settings.option<ConfigOptionInts>("first_layer_print_sequence")) {
            if (!first->values.empty() && first->values.front() != 0) {
                for (const int value : first->values)
                    if (value < 1 || value > static_cast<int>(old_count))
                        throw FilamentCommandFailure("unsupported_reference", "malformed first-layer filament sequence");
                for (std::size_t slot = first->values.size(); slot < old_count + 1; ++slot)
                    first->values.push_back(static_cast<int>(slot + 1));
            }
        }
        auto* other = plate.settings.option<ConfigOptionInts>("other_layers_print_sequence");
        auto* other_count = plate.settings.option<ConfigOptionInt>("other_layers_print_sequence_nums");
        if ((other == nullptr) != (other_count == nullptr))
            throw FilamentCommandFailure("unsupported_reference", "incomplete per-plate layer sequence");
        if (other != nullptr) {
            if (other_count->value <= 0 || other->values.empty() ||
                other->values.size() % static_cast<std::size_t>(other_count->value) != 0)
                throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
            const std::size_t width = other->values.size() / static_cast<std::size_t>(other_count->value);
            if (width < 3) throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
            std::vector<int> rebuilt;
            rebuilt.reserve(other->values.size() + static_cast<std::size_t>(other_count->value));
            for (std::size_t sequence = 0; sequence < static_cast<std::size_t>(other_count->value); ++sequence) {
                const auto begin = other->values.begin() + static_cast<std::ptrdiff_t>(sequence * width);
                rebuilt.insert(rebuilt.end(), begin, begin + 2);
                for (std::size_t offset = 2; offset < width; ++offset) {
                    const int value = *(begin + static_cast<std::ptrdiff_t>(offset));
                    if (value < 1 || value > static_cast<int>(old_count))
                        throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
                    rebuilt.push_back(value);
                }
                const std::size_t orders = width - 2;
                for (std::size_t slot = orders; slot < old_count + 1; ++slot)
                    rebuilt.push_back(static_cast<int>(slot + 1));
            }
            other->values = std::move(rebuilt);
        }
        plate.settings_metadata = config_metadata_json(plate.settings);
    }
}

void remap_model_filament_references(Model& model, const std::size_t removed,
                                     const std::optional<std::size_t>& replacement,
                                     const std::size_t new_count)
{
    for (ModelObject* object : model.objects) {
        remap_config_filament_references(object->config, removed, replacement);
        for (ModelVolume* volume : object->volumes) {
            remap_config_filament_references(volume->config, removed, replacement);
            // The native MM painting selector stores 1-based enforcer IDs and
            // has its own deletion/remap operation.  Keep it in the staged
            // model so imported painting cannot retain a dangling reference.
            volume->update_extruder_count_when_delete_filament(
                new_count, removed + 1,
                replacement.has_value() ? static_cast<int>(*replacement + 1) : 0);
        }
    }
    for (auto& [plate, info] : model.plates_custom_gcodes) {
        (void)plate;
        auto& gcodes = info.gcodes;
        for (auto it = gcodes.begin(); it != gcodes.end();) {
            if (it->extruder <= 0) { ++it; continue; }
            if (static_cast<std::size_t>(it->extruder - 1) == removed && !replacement.has_value()) {
                it = gcodes.erase(it);
                continue;
            }
            it->extruder = remap_filament_reference(it->extruder, removed, replacement);
            ++it;
        }
    }
}

static json default_history_context()
{
    return Neo::Bridge::HistoryMetadata::default_history_context(
        state(), plate_session_snapshot_json(), history_state_json(state().presets));
}

static json canonical_history_context(json context)
{
    return Neo::Bridge::HistoryMetadata::canonical_history_context(
        state(), std::move(context), plate_session_snapshot_json(), history_state_json(state().presets));
}

static Neo::History::ModelState history_model_state_for_context()
{
    return Neo::History::Codec::capture_model_state(state().model);
}

static void record_history_context(const std::string& label, const json& requested)
{
    const auto model_state = history_model_state_for_context();
    Neo::Bridge::HistoryMetadata::record_history_context(
        state(), label, requested, plate_session_snapshot_json(),
        history_state_json(state().presets), model_state);
}

static void record_active_plate_context()
{
    const auto model_state = history_model_state_for_context();
    Neo::Bridge::HistoryMetadata::record_active_plate_context(
        state(), plate_session_snapshot_json(), history_state_json(state().presets), model_state);
}

static json history_status_json()
{
    return Neo::Bridge::HistoryMetadata::history_status_json(state());
}

struct FlushColour { unsigned char a = 255, r = 0, g = 0, b = 0; };

std::optional<FlushColour> parse_flush_colour(const std::string& value)
{
    if (!valid_filament_colour(value)) return std::nullopt;
    auto hex = [](const char c) -> unsigned char {
        if (c >= '0' && c <= '9') return static_cast<unsigned char>(c - '0');
        if (c >= 'a' && c <= 'f') return static_cast<unsigned char>(c - 'a' + 10);
        return static_cast<unsigned char>(c - 'A' + 10);
    };
    auto byte = [&](const std::size_t offset) -> unsigned char {
        return static_cast<unsigned char>((hex(value[offset]) << 4) | hex(value[offset + 1]));
    };
    FlushColour colour;
    if (value.size() == 9) {
        colour.a = byte(1); colour.r = byte(3); colour.g = byte(5); colour.b = byte(7);
    } else {
        colour.r = byte(1); colour.g = byte(3); colour.b = byte(5);
    }
    return colour;
}

std::vector<FlushColour> flush_colours_for_slot(const std::string& base,
                                                const std::string& multi)
{
    std::vector<FlushColour> result;
    std::istringstream stream(multi.empty() ? base : multi);
    std::string item;
    while (stream >> item)
        if (const auto colour = parse_flush_colour(item)) result.push_back(*colour);
    if (result.empty())
        if (const auto colour = parse_flush_colour(base)) result.push_back(*colour);
    if (result.empty()) result.push_back({});
    return result;
}

// A plate-local process setting (currently the prime-tower X/Y position) must
// not invalidate the complete project.  Keep this transaction in the bridge,
// beside the shared variant, so the response carries the authoritative
// revision and affected plate set used by both hosts.
json plate_configuration_mutation_snapshot(const std::string& plate_id,
                                            const char* reason)
{
    ensure_plate_session_state();
    if (find_plate(plate_id) == nullptr)
        throw std::runtime_error("plate not found");
    ++state().plate_input_revisions[plate_id];
    const std::set<std::string> affected{plate_id};
    json result = plate_session_snapshot_json();
    result["input_revisions"] = plate_revisions_json();
    result["affected_plate_ids_before"] = plate_id_array(affected);
    result["affected_plate_ids_after"] = plate_id_array(affected);
    result["affected_plate_ids"] = plate_id_array(affected);
    result["dirty_reasons"] = {reason};
    return result;
}

std::vector<std::vector<int>> min_flush_volumes_for_config(const DynamicPrintConfig& full,
                                                           const std::size_t filament_count,
                                                           const std::size_t nozzle_count)
{
    std::vector<std::vector<int>> result(nozzle_count, std::vector<int>(filament_count, 0));
    const auto* nozzle_volume = full.opt<ConfigOptionFloatsNullable>("nozzle_volume");
    const auto* machine_level = full.opt<ConfigOptionInt>("enable_long_retraction_when_cut");
    const auto* machine_active = full.opt<ConfigOptionBools>("long_retractions_when_cut");
    const auto* filament_diameter = full.opt<ConfigOptionFloats>("filament_diameter");
    const auto* filament_retraction = full.opt<ConfigOptionFloats>("filament_retraction_distances_when_cut");
    const auto* filament_retraction_nullable = full.opt<ConfigOptionFloatsNullable>("filament_retraction_distances_when_cut");
    const auto* printer_retraction = full.opt<ConfigOptionFloats>("retraction_distances_when_cut");
    const auto* filament_active = full.opt<ConfigOptionBools>("filament_long_retractions_when_cut");
    const auto* filament_active_nullable = full.opt<ConfigOptionBoolsNullable>("filament_long_retractions_when_cut");
    const std::size_t filament_size = std::max(filament_count,
        filament_diameter == nullptr ? std::size_t{0} : filament_diameter->values.size());
    const auto at_or = [](const auto* option, const std::size_t index, const auto fallback) {
        return option != nullptr && index < option->values.size() ? option->values[index] : fallback;
    };
    const auto filament_retraction_at = [&](const std::size_t index, const double fallback) {
        if (filament_retraction != nullptr && index < filament_retraction->values.size())
            return filament_retraction->values[index];
        return filament_retraction_nullable != nullptr && index < filament_retraction_nullable->values.size()
            ? filament_retraction_nullable->values[index] : fallback;
    };
    const auto filament_active_at = [&](const std::size_t index, const unsigned char fallback) {
        if (filament_active != nullptr && index < filament_active->values.size())
            return filament_active->values[index];
        return filament_active_nullable != nullptr && index < filament_active_nullable->values.size()
            ? filament_active_nullable->values[index] : fallback;
    };
    constexpr double default_retraction = 18.0;
    constexpr double filament_area = M_PI * 1.75 * 1.75 / 4.0;
    for (std::size_t nozzle = 0; nozzle < nozzle_count; ++nozzle) {
        const double nozzle_value = nozzle_volume != nullptr && nozzle < nozzle_volume->values.size()
            ? nozzle_volume->values[nozzle] : 0.0;
        const int nozzle_volume_value = std::isfinite(nozzle_value) ? static_cast<int>(nozzle_value) : 0;
        const int machine_enabled_level = machine_level == nullptr ? 0 : machine_level->value;
        const bool machine_activated = machine_active != nullptr && nozzle < machine_active->values.size() &&
            machine_active->values[nozzle];
        const double printer_distance = at_or(printer_retraction, nozzle, default_retraction);
        for (std::size_t filament = 0; filament < filament_count; ++filament) {
            int retract_length = machine_enabled_level && machine_activated
                ? static_cast<int>(printer_distance) : 0;
            const unsigned char filament_enabled = filament_active_at(filament, static_cast<unsigned char>(0));
            const double filament_distance = filament_retraction_at(filament, default_retraction);
            if (filament_enabled == 0) {
                retract_length = 0;
            } else if (filament_enabled == 1 && machine_enabled_level == LongRectrationLevel::EnableFilament) {
                retract_length = std::isnan(filament_distance)
                    ? static_cast<int>(printer_distance) : static_cast<int>(filament_distance);
            }
            // Match Plater.cpp's compound assignment: subtract in double precision,
            // then convert the complete result to int. Converting the product first
            // rounds the value in the wrong direction at fractional boundaries.
            result[nozzle][filament] = static_cast<int>(
                static_cast<double>(nozzle_volume_value) - filament_area * retract_length);
        }
    }
    return result;
}

std::vector<std::vector<int>> min_flush_volumes_for_bundle(const PresetBundle& bundle,
                                                           const std::size_t filament_count,
                                                           const std::size_t nozzle_count)
{
    return min_flush_volumes_for_config(bundle.full_config(), filament_count, nozzle_count);
}

void recalculate_filament_flush(PresetBundle& bundle)
{
    auto* matrix = bundle.project_config.option<ConfigOptionFloats>("flush_volumes_matrix", true);
    if (matrix == nullptr) throw FilamentCommandFailure("native_validation_failure", "native flush matrix is unavailable");
    const std::size_t count = bundle.filament_presets.size();
    const std::size_t nozzles = std::max(1, bundle.get_printer_extruder_count());
    const auto* colours = bundle.project_config.opt<ConfigOptionStrings>("filament_colour");
    if (colours == nullptr || colours->values.size() != count)
        throw FilamentCommandFailure("native_validation_failure", "native filament colours are unavailable");
    const auto* multi = bundle.project_config.opt<ConfigOptionStrings>("filament_multi_colour");
    const auto* support = bundle.project_config.opt<ConfigOptionBools>("filament_is_support");
    const auto* datasets = bundle.project_config.opt<ConfigOptionIntsNullable>("nozzle_flush_dataset");
    const auto min_flush = min_flush_volumes_for_bundle(bundle, count, nozzles);
    const auto colour_sets = [&]() {
        std::vector<std::vector<FlushColour>> sets;
        sets.reserve(count);
        for (std::size_t index = 0; index < count; ++index) {
            const std::string multi_value = multi != nullptr && index < multi->values.size()
                ? multi->values[index] : std::string{};
            sets.push_back(flush_colours_for_slot(colours->values[index], multi_value));
        }
        return sets;
    }();

    matrix->values.assign(count * count * nozzles, 0.0);
    for (std::size_t nozzle = 0; nozzle < nozzles; ++nozzle) {
        const int dataset = datasets != nullptr && !datasets->values.empty()
            ? datasets->get_at(nozzle) : 0;
        const bool has_support = support != nullptr && support->values.size() == count;
        for (std::size_t from = 0; from < count; ++from) {
            for (std::size_t to = 0; to < count; ++to) {
                if (from == to) continue;
                int flushing = 0;
                const bool from_support = has_support && support->get_at(from);
                const bool to_support = has_support && support->get_at(to);
                if (to_support) {
                    flushing = Slic3r::g_flush_volume_to_support;
                } else {
                    FlushVolCalculator calculator(min_flush[nozzle][from], Slic3r::g_max_flush_volume, dataset);
                    for (const auto& source : colour_sets[from])
                        for (const auto& destination : colour_sets[to])
                            flushing = std::max(flushing, calculator.calc_flush_vol(
                                source.a, source.r, source.g, source.b,
                                destination.a, destination.r, destination.g, destination.b));
                    if (from_support)
                        flushing = std::max(flushing, Slic3r::g_min_flush_volume_from_support);
                }
                matrix->values[nozzle * count * count + from * count + to] = flushing;
            }
        }
    }
}

void validate_filament_candidate_components(const std::vector<std::string>& filament_presets,
                                            const DynamicPrintConfig& project,
                                            const DynamicPrintConfig& printer,
                                            const int nozzle_count,
                                            const bool flexible_slots,
                                            Model& model,
                                            const std::vector<BridgeState::PlateSessionPlate>& plates,
                                            const json& overlay,
                                            const bool strict_slot_arrays = true,
                                            const bool require_all_slot_arrays = false)
{
    if (filament_presets.empty() || filament_presets.size() > 64)
        throw std::runtime_error("native filament slot count is invalid");
    for (const char* key : {"filament_colour", "filament_multi_colour", "filament_colour_type",
                            "filament_map", "filament_volume_map", "filament_nozzle_map",
                            "filament_map_2", "filament_self_index", "filament_extruder_variant"}) {
        if (strict_slot_arrays || require_all_slot_arrays) if (const auto* option = project.option(key)) {
            const auto* vector_option = dynamic_cast<const ConfigOptionVectorBase*>(option);
            if (vector_option == nullptr) continue;
            const auto size = vector_option->size();
            const bool invalid_size = require_all_slot_arrays
                ? size != filament_presets.size()
                : (flexible_slots && size != 0 && size != filament_presets.size());
            if (invalid_size)
                throw std::runtime_error(std::string("native filament array has invalid length: ") + key);
        }
    }
    if (require_all_slot_arrays) {
        const auto validate_matrix = [&](const DynamicPrintConfig& config) {
            const auto* option = config.option("flush_volumes_matrix");
            if (option == nullptr) return;
            const auto values = config_floats(config, "flush_volumes_matrix");
            const std::size_t plane_size = filament_presets.size() * filament_presets.size();
            if (plane_size == 0 || values.empty() || values.size() % plane_size != 0 ||
                values.size() / plane_size != static_cast<std::size_t>(nozzle_count))
                throw std::runtime_error("native flush matrix has invalid slot dimensions");
            if (std::any_of(values.begin(), values.end(), [](double value) { return !std::isfinite(value); }))
                throw std::runtime_error("native flush matrix contains invalid values");
        };
        validate_matrix(project);
        if (project.option("flush_volumes_matrix") == nullptr)
            validate_matrix(printer);
    }
    const auto validate_config_references = [&](const auto& config) {
        for (const auto& key : config.keys()) {
            if (!is_filament_slot_reference_key(key)) continue;
            const auto* option = dynamic_cast<const ConfigOptionInt*>(config.option(key));
            if (option != nullptr && (option->value < 0 || option->value > static_cast<int>(filament_presets.size())))
                throw FilamentCommandFailure("unsupported_reference", "model filament reference exceeds slots");
        }
    };
    for (const ModelObject* object : model.objects) {
        validate_config_references(object->config);
        for (const ModelVolume* volume : object->volumes) {
            validate_config_references(volume->config);
            const ConfigOption* extruder = volume->config.option("extruder");
            if (extruder == nullptr || extruder->getInt() == 0)
                extruder = object->config.option("extruder");
            const int effective_extruder = extruder == nullptr ? 1 : extruder->getInt();
            if (effective_extruder > static_cast<int>(filament_presets.size()))
                throw FilamentCommandFailure("unsupported_reference", "model effective filament reference exceeds slots");
        }
    }
    if (!valid_project_config_overlay(overlay))
        throw FilamentCommandFailure("unsupported_reference", "invalid staged project configuration overlay");
    const auto validate_overlay_values = [&](const json& values) {
        if (!values.is_object()) return;
        for (const auto& [key, value] : values.items()) {
            if (!is_filament_slot_reference_key(key)) continue;
            if (!value.is_string())
                throw FilamentCommandFailure("unsupported_reference", "invalid filament reference in project overlay");
            try {
                const int reference = std::stoi(value.get<std::string>());
                if (reference < 0 || reference > static_cast<int>(filament_presets.size()))
                    throw FilamentCommandFailure("unsupported_reference", "project overlay reference exceeds slots");
            } catch (const FilamentCommandFailure&) { throw; }
            catch (...) {
                throw FilamentCommandFailure("unsupported_reference", "invalid filament reference in project overlay");
            }
        }
    };
    validate_overlay_values(overlay["project"]);
    for (const char* scope : {"objects", "parts", "plates"})
        for (const auto& [id, values] : overlay[scope].items()) validate_overlay_values(values);
    for (const auto& plate : plates) {
        validate_plate_filament_state(plate, filament_presets.size(), nozzle_count);
        for (const auto& key : plate.settings.keys()) {
            if (!is_filament_slot_reference_key(key)) continue;
            const auto* option = dynamic_cast<const ConfigOptionInt*>(plate.settings.option(key));
            if (option != nullptr && (option->value < 0 || option->value > static_cast<int>(filament_presets.size())))
                throw FilamentCommandFailure("unsupported_reference", "staged plate reference exceeds filament slots");
        }
    }
    (void)nozzle_count;
}

void validate_filament_candidate(PresetBundle& bundle, Model& model,
                                 const std::vector<BridgeState::PlateSessionPlate>& plates,
                                 const json& overlay,
                                 const bool strict_slot_arrays = true,
                                 const bool require_all_slot_arrays = false)
{
    const auto& printer = bundle.printers.get_edited_preset().config;
    validate_filament_candidate_components(bundle.filament_presets, bundle.project_config, printer,
        std::max(1, bundle.get_printer_extruder_count()),
        printer.opt_bool("single_extruder_multi_material") || bundle.is_bbl_vendor(),
        model, plates, overlay, strict_slot_arrays, require_all_slot_arrays);
}

json filament_mutation_result(const json& mutation)
{
    return { {"ok", true}, {"version", 1},
             {"result", {{"snapshot", filament_session_snapshot_json()}, {"mutation", mutation}}} };
}

template <typename Mutator>
json run_filament_mutation(const json& request, const char* label, Mutator mutator)
{
    const auto before_next_filament_colour_index = state().next_filament_colour_index;
    try {
        if (!request.is_object() || !request.contains("version") ||
            !request["version"].is_number_unsigned() || request["version"].get<unsigned>() != 1)
            return filament_command_error("invalid_command", "unsupported filament command version");
        if (state().active_history_transaction)
            return filament_command_error("history_transaction_active", "filament command cannot run inside another history transaction");
        const auto before_snapshot = filament_session_snapshot_json();
        if (!before_snapshot.value("ok", false)) return before_snapshot;
        const auto before_context = default_history_context();
        // The retained current entry is the authoritative pre-command model.
        // Reusing its immutable history representation avoids serializing the
        // entire native model again for every small filament edit; the post-
        // command frame below is still serialized before it is committed.
        const auto before_history_model = state().history.entries().empty()
            ? Neo::History::Codec::capture_model_state(state().model) : state().history.current().model;
        const bool needs_predecessor_direct = state().history.entries().empty() ||
            !state().history.current().direct_frame.has_value();
        std::shared_ptr<const Model> direct_before_model = current_direct_frame_model(state());
        if (!direct_before_model) direct_before_model = std::make_shared<Model>(state().model);
        const auto predecessor_direct = needs_predecessor_direct
            ? make_direct_frame(state(), direct_before_model, before_history_model)
            : std::optional<Neo::History::RestoreState::DirectFrame>{};
        if (!request.contains("revision") || !request["revision"].is_number_unsigned())
            return filament_command_error("stale_revision", "filament session revision is required");
        const auto expected = request["revision"].get<std::uint64_t>();
        if (expected != before_snapshot["revisions"]["session"].get<std::uint64_t>())
            return filament_command_error("stale_revision", "filament session revision is stale");

        // The preset catalogue is immutable during a project session.  Never
        // copy PresetBundle in a history-producing mutation: retain only the
        // exact mutable filament fields which may need atomic rollback.
        const auto before_filament_presets = state().presets.filament_presets;
        const auto before_project_config = state().presets.project_config;
        const auto before_ams_colours = state().presets.ams_multi_color_filment;
        const auto before_edited_filament = state().presets.filaments.get_edited_preset();
        Model before_model = state().model;
        const auto before_plates = state().plate_session_plates;
        const auto before_overlay = state().project_config_overlay;
        const auto before_plate_revisions = state().plate_input_revisions;
        const auto before_membership = state().instance_plate_ids;
        const auto before_out_of_bounds = state().plate_out_of_bounds_ids;
        const auto before_parked = state().parked_instance_ids;
        const auto before_pending = state().pending_membership_instance_ids;
        const auto before_current_plate = state().current_plate_id;
        const auto old_count = state().presets.filament_presets.size();
        bool mutated = false;
        bool history_committed = false;
        const auto rollback_published = [&]() {
            if (!mutated || history_committed) return;
            state().presets.filament_presets = before_filament_presets;
            state().presets.project_config = before_project_config;
            state().presets.ams_multi_color_filment = before_ams_colours;
            state().presets.filaments.get_edited_preset() = before_edited_filament;
            state().model = before_model;
            state().plate_session_plates = before_plates;
            state().project_config_overlay = before_overlay;
            state().plate_input_revisions = before_plate_revisions;
            state().instance_plate_ids = before_membership;
            state().plate_out_of_bounds_ids = before_out_of_bounds;
            state().parked_instance_ids = before_parked;
            state().pending_membership_instance_ids = before_pending;
            state().current_plate_id = before_current_plate;
            state().next_filament_colour_index = before_next_filament_colour_index;
        };
        json mutation;
        try {
            mutated = true;
            mutation = mutator(state().presets, state().model, state().plate_session_plates,
                               state().project_config_overlay, old_count);
            if (request.value("inject_failure", false)) {
                rollback_published();
                return filament_command_error("native_validation_failure", "injected native validation failure");
            }
            validate_filament_candidate(state().presets, state().model, state().plate_session_plates,
                                        state().project_config_overlay);
            // Commit the fieldwise staged native session as one Worker
            // operation. The projection is the final validation, so malformed
            // native arrays can never be published to the client.
            // Filament configuration is shared by every plate.  Invalidate all
            // plate results in the authoritative Worker state before publishing
            // the post-command snapshot; the renderer must not infer this from
            // whichever plate happens to be selected.
            ensure_plate_session_state();
            for (const auto& plate_id : all_plate_ids()) ++state().plate_input_revisions[plate_id];
            const auto final_snapshot = filament_session_snapshot_json();
            if (!final_snapshot.value("ok", false)) {
                rollback_published();
                return final_snapshot;
            }
            auto context = default_history_context();
            // The model may be unchanged for a pure slot edit.  Include the
            // authoritative filament revision in the history context so ProjectHistory
            // records exactly one semantic project mutation instead of coalescing
            // the command away as an identical model/context snapshot.
            context["filamentSessionRevision"] = state().history_revision + 1;
            const auto encoded = context.dump();
            const Neo::History::Bytes bytes(encoded.begin(), encoded.end());
            const auto failure_stage = request.value("inject_failure_stage", "");
            if (failure_stage == "before-history") {
                rollback_published();
                return filament_command_error("native_validation_failure", "injected late native validation failure");
            }
            if (failure_stage == "during-history")
                throw std::runtime_error("injected history commit failure");
            const auto after_history_model = Neo::History::Codec::capture_model_state(state().model);
            const auto direct_frame = make_direct_frame(
                state(), std::make_shared<Model>(state().model), after_history_model);
            const bool committed = [&]() {
                if (!state().history.entries().empty())
                    return state().history.commit(label, Neo::History::Category::Project,
                                                  after_history_model, bytes, direct_frame,
                                                  predecessor_direct);
                const auto baseline_encoded = before_context.dump();
                const Neo::History::Bytes baseline_bytes(baseline_encoded.begin(), baseline_encoded.end());
                return state().history.commit_with_baseline(
                    label, Neo::History::Category::Project,
                    before_history_model, baseline_bytes, after_history_model, bytes,
                    predecessor_direct, direct_frame);
            }();
            if (!committed) {
                rollback_published();
                return filament_command_error("native_validation_failure", "history commit rejected filament mutation");
            }
            history_committed = true;
        } catch (...) {
            if (!history_committed) rollback_published();
            throw;
        }
        state().history_revision++;
        state().print.clear();
        invalidate_preview_source();
        mutation["history_entry_delta"] = 1;
        mutation["revision_before"] = expected;
        mutation["revision_after"] = state().history_revision;
        mutation["dirty"] = state().history.project_modified();
        mutation["all_plate_results_invalidated"] = true;
        return filament_mutation_result(mutation);
    } catch (const FilamentCommandFailure& e) {
        state().next_filament_colour_index = before_next_filament_colour_index;
        return filament_command_error(e.code, e.what());
    } catch (const std::exception& e) {
        state().next_filament_colour_index = before_next_filament_colour_index;
        return filament_command_error("native_validation_failure", e.what());
    } catch (...) {
        state().next_filament_colour_index = before_next_filament_colour_index;
        return filament_command_error("native_validation_failure", "unknown native validation failure");
    }
}

// Add/delete only touch a small, well-defined part of PresetBundle.  The
// generic transaction above intentionally stages the complete installed
// preset graph, which is the right safety boundary for arbitrary commands but
// makes a single slot edit pay for several deep copies.  Keep the same
// validation, snapshot, history, and rollback protocol while applying these
// two mutations in place and retaining only the fields they can change.
template <typename Mutator>
json run_filament_slot_mutation(const json& request, const char* label, const bool model_changes, Mutator mutator)
{
    const auto before_next_filament_colour_index = state().next_filament_colour_index;
    try {
        if (!request.is_object() || !request.contains("version") ||
            !request["version"].is_number_unsigned() || request["version"].get<unsigned>() != 1)
            return filament_command_error("invalid_command", "unsupported filament command version");
        if (state().active_history_transaction)
            return filament_command_error("history_transaction_active", "filament command cannot run inside another history transaction");
        const auto before_snapshot = filament_session_snapshot_json();
        if (!before_snapshot.value("ok", false)) return before_snapshot;
        const auto before_context = default_history_context();
        const auto before_history_model = state().history.entries().empty()
            ? Neo::History::Codec::capture_model_state(state().model) : state().history.current().model;
        if (!request.contains("revision") || !request["revision"].is_number_unsigned())
            return filament_command_error("stale_revision", "filament session revision is required");
        const auto expected = request["revision"].get<std::uint64_t>();
        if (expected != before_snapshot["revisions"]["session"].get<std::uint64_t>())
            return filament_command_error("stale_revision", "filament session revision is stale");

        const auto before_filament_presets = state().presets.filament_presets;
        const auto before_project_config = state().presets.project_config;
        const auto before_ams_colours = state().presets.ams_multi_color_filment;
        const auto before_edited_filament = state().presets.filaments.get_edited_preset();
        std::shared_ptr<const Model> before_model;
        if (model_changes) before_model = std::make_shared<Model>(state().model);
        const auto before_plates = state().plate_session_plates;
        const auto before_overlay = state().project_config_overlay;
        const auto before_plate_revisions = state().plate_input_revisions;
        const auto before_membership = state().instance_plate_ids;
        const auto before_out_of_bounds = state().plate_out_of_bounds_ids;
        const auto before_parked = state().parked_instance_ids;
        const auto before_pending = state().pending_membership_instance_ids;
        const auto before_current_plate = state().current_plate_id;
        const auto& current_history = state().history.current();
        const bool needs_predecessor_direct = state().history.entries().empty() ||
            !current_history.direct_frame.has_value();
        std::shared_ptr<const Model> direct_before_model = current_direct_frame_model(state());
        if (!direct_before_model)
            direct_before_model = before_model ? before_model : std::make_shared<Model>(state().model);
        const auto predecessor_direct = needs_predecessor_direct
            ? make_direct_frame(state(), direct_before_model, before_history_model)
            : std::optional<Neo::History::RestoreState::DirectFrame>{};

        bool mutated = false;
        bool history_committed = false;
        const auto rollback = [&]() {
            if (!mutated || history_committed) return;
            state().presets.filament_presets = before_filament_presets;
            state().presets.project_config = before_project_config;
            state().presets.ams_multi_color_filment = before_ams_colours;
            state().presets.filaments.get_edited_preset() = before_edited_filament;
            if (before_model) state().model = *before_model;
            state().plate_session_plates = before_plates;
            state().project_config_overlay = before_overlay;
            state().plate_input_revisions = before_plate_revisions;
            state().instance_plate_ids = before_membership;
            state().plate_out_of_bounds_ids = before_out_of_bounds;
            state().parked_instance_ids = before_parked;
            state().pending_membership_instance_ids = before_pending;
            state().current_plate_id = before_current_plate;
            state().next_filament_colour_index = before_next_filament_colour_index;
        };

        try {
            mutated = true;
            const auto old_count = state().presets.filament_presets.size();
            json mutation = mutator(state().presets, state().model, state().plate_session_plates,
                                     state().project_config_overlay, old_count);
            if (request.value("inject_failure", false)) {
                rollback();
                return filament_command_error("native_validation_failure", "injected native validation failure");
            }
            validate_filament_candidate(state().presets, state().model, state().plate_session_plates,
                                        state().project_config_overlay);
            ensure_plate_session_state();
            for (const auto& plate_id : all_plate_ids()) ++state().plate_input_revisions[plate_id];
            const auto final_snapshot = filament_session_snapshot_json();
            if (!final_snapshot.value("ok", false)) {
                rollback();
                return final_snapshot;
            }
            auto context = default_history_context();
            context["filamentSessionRevision"] = state().history_revision + 1;
            const auto encoded = context.dump();
            const Neo::History::Bytes bytes(encoded.begin(), encoded.end());
            const auto failure_stage = request.value("inject_failure_stage", "");
            if (failure_stage == "before-history") {
                rollback();
                return filament_command_error("native_validation_failure", "injected late native validation failure");
            }
            if (failure_stage == "during-history")
                throw std::runtime_error("injected history commit failure");
            const auto after_history_model = Neo::History::Codec::capture_model_state(state().model);
            const auto direct_after_model = model_changes
                ? std::make_shared<Model>(state().model) : direct_before_model;
            const auto direct_frame = make_direct_frame(state(), direct_after_model,
                                                        after_history_model);
            const bool committed = [&]() {
                if (!state().history.entries().empty())
                    return state().history.commit(label, Neo::History::Category::Project,
                                                  after_history_model, bytes, direct_frame,
                                                  predecessor_direct);
                const auto baseline_encoded = before_context.dump();
                const Neo::History::Bytes baseline_bytes(baseline_encoded.begin(), baseline_encoded.end());
                return state().history.commit_with_baseline(
                    label, Neo::History::Category::Project,
                    before_history_model, baseline_bytes, after_history_model, bytes,
                    predecessor_direct, direct_frame);
            }();
            if (!committed) {
                rollback();
                return filament_command_error("native_validation_failure", "history commit rejected filament mutation");
            }
            history_committed = true;
            state().history_revision++;
            state().print.clear();
            invalidate_preview_source();
            mutation["history_entry_delta"] = 1;
            mutation["revision_before"] = expected;
            mutation["revision_after"] = state().history_revision;
            mutation["dirty"] = state().history.project_modified();
            mutation["all_plate_results_invalidated"] = true;
            return filament_mutation_result(mutation);
        } catch (...) {
            rollback();
            throw;
        }
    } catch (const FilamentCommandFailure& e) {
        state().next_filament_colour_index = before_next_filament_colour_index;
        return filament_command_error(e.code, e.what());
    } catch (const std::exception& e) {
        state().next_filament_colour_index = before_next_filament_colour_index;
        return filament_command_error("native_validation_failure", e.what());
    } catch (...) {
        state().next_filament_colour_index = before_next_filament_colour_index;
        return filament_command_error("native_validation_failure", "unknown native validation failure");
    }
}

const char* restore_filament_rack_command(const char* request_cstr)
{
    try {
        const json request = request_cstr && *request_cstr ? json::parse(request_cstr) : json::object();
        if (!request.is_object() || request.value("version", 0) != 1 || !request.contains("revision") ||
            !request["revision"].is_number_unsigned() || !request.contains("slots") ||
            !request["slots"].is_array() || request["slots"].empty() || request["slots"].size() > 64)
            return dup_json(filament_command_error("invalid_command", "invalid remembered filament rack").dump());
        return dup_json(run_filament_mutation(request, "Restore remembered filament rack",
            [&](PresetBundle& bundle, Model&, std::vector<BridgeState::PlateSessionPlate>&,
                json&, std::size_t) -> json {
                std::vector<std::string> colours;
                colours.reserve(request["slots"].size());
                bundle.set_num_filaments(static_cast<unsigned int>(request["slots"].size()));
                for (std::size_t index = 0; index < request["slots"].size(); ++index) {
                    const auto& slot = request["slots"][index];
                    if (!slot.is_object() || !slot.contains("preset") || !slot["preset"].is_string() ||
                        slot["preset"].get<std::string>().empty() || !slot.contains("colour") || !slot["colour"].is_string())
                        throw FilamentCommandFailure("invalid_command", "invalid remembered filament slot");
                    const std::string preset = slot["preset"].get<std::string>();
                    if (bundle.filaments.find_preset(preset, false, true) == nullptr)
                        throw FilamentCommandFailure("incompatible_preset", "remembered filament preset is unavailable: " + preset);
                    bundle.set_filament_preset(index, preset);
                    colours.push_back(slot["colour"].get<std::string>());
                }
                bundle.project_config.set_key_value("filament_colour", new ConfigOptionStrings(colours));
                return json{{"restored_slots", colours.size()}, {"atomic", true}};
            }).dump());
    } catch (const std::exception& e) {
        return dup_json(filament_command_error("invalid_command", e.what()).dump());
    } catch (...) {
        return dup_json(filament_command_error("invalid_command", "invalid remembered filament rack").dump());
    }
}

struct FilamentAssignmentTarget {
    std::string kind;
    std::size_t id = 0;
};

static std::vector<FilamentAssignmentTarget> parse_assignment_targets(const json& request)
{
    const json* values = request.contains("targets") ? &request["targets"] : &request["target"];
    if (values == nullptr || (!values->is_array() && !values->is_object()))
        throw FilamentCommandFailure("invalid_command", "assignment targets are required");
    json array = values->is_array() ? *values : json::array({*values});
    std::vector<FilamentAssignmentTarget> result;
    std::set<std::pair<std::string, std::size_t>> seen;
    for (const auto& value : array) {
        if (!value.is_object() || !value.contains("kind") || !value["kind"].is_string() ||
            !value.contains("id") || !value["id"].is_number_unsigned() ||
            value["id"].get<std::uint64_t>() == 0 ||
            value["id"].get<std::uint64_t>() > std::numeric_limits<std::size_t>::max())
            throw FilamentCommandFailure("invalid_command", "invalid assignment target");
        const std::string kind = value["kind"].get<std::string>();
        const std::size_t id = value["id"].get<std::size_t>();
        if (!seen.emplace(kind, id).second) continue;
        result.push_back({kind, id});
    }
    if (result.empty()) throw FilamentCommandFailure("invalid_command", "assignment targets are empty");
    return result;
}

static ModelObject* find_object_by_id_in(Model& model, const std::size_t id)
{
    for (auto& object : model.objects) if (object->id().id == id) return object;
    return nullptr;
}

static ModelVolume* find_volume_by_id_in(Model& model, const std::size_t id)
{
    for (auto& object : model.objects)
        for (auto& volume : object->volumes)
            if (volume->id().id == id) return volume;
    return nullptr;
}

static ModelObject* owner_of_volume_in(Model& model, const std::size_t id)
{
    for (auto& object : model.objects)
        for (auto& volume : object->volumes)
            if (volume->id().id == id) return object;
    return nullptr;
}

static ModelObject* owner_of_instance_in(Model& model, const std::size_t id)
{
    for (auto& object : model.objects)
        for (auto& instance : object->instances)
            if (instance->id().id == id) return object;
    return nullptr;
}

static void collect_object_instance_ids(const Model& model, const std::set<std::size_t>& object_ids,
                                        std::set<std::size_t>& instance_ids)
{
    for (const auto* object : model.objects) {
        if (object_ids.find(object->id().id) == object_ids.end()) continue;
        for (const auto* instance : object->instances) instance_ids.insert(instance->id().id);
    }
}

template <typename Mutator>
json run_filament_assignment_mutation(const json& request, const char* label, Mutator mutator,
                                      const bool model_only = false)
{
    try {
        if (!request.is_object() || request.value("version", 0) != 1)
            return filament_command_error("invalid_command", "unsupported filament assignment command version");
        if (state().active_history_transaction)
            return filament_command_error("history_transaction_active", "filament assignment cannot run inside another history transaction");
        const auto before_snapshot = filament_session_snapshot_json();
        if (!before_snapshot.value("ok", false)) return before_snapshot;
        if (!request.contains("revision") || !request["revision"].is_number_unsigned() ||
            request["revision"].get<std::uint64_t>() != before_snapshot["revisions"]["session"].get<std::uint64_t>())
            return filament_command_error("stale_revision", "filament session revision is stale");
        const auto before_context = default_history_context();
        const auto before_history_model = state().history.entries().empty()
            ? Neo::History::Codec::capture_model_state(state().model) : state().history.current().model;
        // Assignment and routing must use the live immutable profile
        // catalogue.  Support routing changes only project_config; preserve
        // that narrow mutable surface rather than cloning PresetBundle.
        const auto before_filament_presets = state().presets.filament_presets;
        const auto before_project_config = state().presets.project_config;
        const auto before_ams_colours = state().presets.ams_multi_color_filment;
        const auto before_edited_filament = state().presets.filaments.get_edited_preset();
        const auto restore_mutable_bundle = [&]() {
            state().presets.filament_presets = before_filament_presets;
            state().presets.project_config = before_project_config;
            state().presets.ams_multi_color_filment = before_ams_colours;
            state().presets.filaments.get_edited_preset() = before_edited_filament;
        };
        Model staged_model = state().model;
        auto staged_plates = state().plate_session_plates;
        auto staged_overlay = state().project_config_overlay;
        std::set<std::size_t> affected_objects;
        json mutation;
        try {
            mutation = mutator(state().presets, staged_model, staged_plates, staged_overlay, affected_objects);
            if (request.value("inject_failure", false) || request.value("inject_failure_stage", "") == "before-history") {
                restore_mutable_bundle();
                return filament_command_error("native_validation_failure", "injected native validation failure");
            }
            validate_filament_candidate(state().presets, staged_model, staged_plates, staged_overlay);
        } catch (...) {
            restore_mutable_bundle();
            throw;
        }

        std::set<std::size_t> affected_instances;
        collect_object_instance_ids(state().model, affected_objects, affected_instances);
        const bool invalidate_all = mutation.value("invalidate_all_plates", false);
        const auto affected_plates = invalidate_all ? all_plate_ids() : member_plate_ids_for_instances(affected_instances);
        Model before_model = state().model;
        const auto before_plates = state().plate_session_plates;
        const auto before_overlay = state().project_config_overlay;
        const auto before_plate_revisions = state().plate_input_revisions;
        const auto before_membership = state().instance_plate_ids;
        const auto before_out_of_bounds = state().plate_out_of_bounds_ids;
        const auto before_parked = state().parked_instance_ids;
        const auto before_pending = state().pending_membership_instance_ids;
        const auto before_current_plate = state().current_plate_id;
        bool history_committed = false;
        const auto rollback = [&]() {
            if (history_committed) return;
            restore_mutable_bundle();
            state().model = before_model;
            state().plate_session_plates = before_plates;
            state().project_config_overlay = before_overlay;
            state().plate_input_revisions = before_plate_revisions;
            state().instance_plate_ids = before_membership;
            state().plate_out_of_bounds_ids = before_out_of_bounds;
            state().parked_instance_ids = before_parked;
            state().pending_membership_instance_ids = before_pending;
            state().current_plate_id = before_current_plate;
        };
        const bool needs_predecessor_direct = state().history.entries().empty() ||
            !state().history.current().direct_frame.has_value();
        std::shared_ptr<const Model> direct_before_model = current_direct_frame_model(state());
        if (!direct_before_model) direct_before_model = std::make_shared<Model>(state().model);
        const auto predecessor_direct = needs_predecessor_direct
            ? make_direct_frame(state(), direct_before_model, before_history_model)
            : std::optional<Neo::History::RestoreState::DirectFrame>{};
        try {
            state().model = std::move(staged_model);
            state().plate_session_plates = std::move(staged_plates);
            state().project_config_overlay = std::move(staged_overlay);
            ensure_plate_session_state();
            for (const auto& plate_id : affected_plates) ++state().plate_input_revisions[plate_id];
            auto context = default_history_context();
            context["filamentSessionRevision"] = state().history_revision + 1;
            const auto encoded = context.dump();
            const Neo::History::Bytes bytes(encoded.begin(), encoded.end());
            if (request.value("inject_failure_stage", "") == "during-history")
                throw std::runtime_error("injected history commit failure");
            const auto after_history_model = Neo::History::Codec::capture_model_state(state().model);
            const auto direct_frame = make_direct_frame(
                state(), std::make_shared<Model>(state().model), after_history_model);
            const bool committed = [&]() {
                if (!state().history.entries().empty())
                    return state().history.commit(label, Neo::History::Category::Project,
                                                  after_history_model, bytes, direct_frame,
                                                  predecessor_direct);
                const auto baseline_encoded = before_context.dump();
                const Neo::History::Bytes baseline_bytes(baseline_encoded.begin(), baseline_encoded.end());
                return state().history.commit_with_baseline(label, Neo::History::Category::Project,
                    before_history_model, baseline_bytes, after_history_model, bytes,
                    predecessor_direct, direct_frame);
            }();
            if (!committed) throw std::runtime_error("history commit rejected filament assignment");
            history_committed = true;
        } catch (...) {
            if (!history_committed) rollback();
            throw;
        }
        state().history_revision++;
        if (affected_plates.find(state().current_plate_id) != affected_plates.end()) {
            state().print.clear();
            invalidate_preview_source();
        }
        mutation["history_entry_delta"] = 1;
        mutation["revision_before"] = request["revision"];
        mutation["revision_after"] = state().history_revision;
        mutation["dirty"] = state().history.project_modified();
        mutation["affected_plate_ids"] = affected_plates;
        mutation["all_plate_results_invalidated"] = invalidate_all;
        mutation.erase("invalidate_all_plates");
        return filament_mutation_result(mutation);
    } catch (const FilamentCommandFailure& e) {
        return filament_command_error(e.code, e.what());
    } catch (const std::exception& e) {
        return filament_command_error("native_validation_failure", e.what());
    } catch (...) {
        return filament_command_error("native_validation_failure", "unknown filament assignment failure");
    }
}

static int requested_assignment_slot(const json& request, const std::size_t slot_count, const bool allow_inherit)
{
    if (!request.contains("slot") || !request["slot"].is_number_integer())
        throw FilamentCommandFailure("invalid_command", "slot is required");
    const int slot = request["slot"].get<int>();
    if (slot == 0 && allow_inherit) return 0;
    if (slot < 1 || slot > static_cast<int>(slot_count))
        throw FilamentCommandFailure("unsupported_reference", "assignment slot is outside the ordered filament slots");
    return slot;
}

json filament_assign_command(const json& request)
{
    return run_filament_assignment_mutation(request, "Assign Filament", [&request](PresetBundle& bundle, Model& model,
        auto&, auto&, std::set<std::size_t>& affected_objects) {
        const auto targets = parse_assignment_targets(request);
        const int slot = requested_assignment_slot(request, bundle.filament_presets.size(), true);
        std::vector<FilamentAssignmentTarget> normalized;
        std::set<std::pair<std::string, std::size_t>> seen;
        for (const auto& target : targets) {
            ModelObject* object = nullptr;
            if (target.kind == "object") object = find_object_by_id_in(model, target.id);
            else if (target.kind == "instance" || target.kind == "instance-as-object") object = owner_of_instance_in(model, target.id);
            else if (target.kind == "model-part" || target.kind == "model_part" ||
                     target.kind == "parameter-modifier" || target.kind == "parameter_modifier") {
                const bool model_part_target = target.kind == "model-part" || target.kind == "model_part";
                auto* volume = find_volume_by_id_in(model, target.id);
                if (volume == nullptr || (model_part_target && volume->type() != ModelVolumeType::MODEL_PART) ||
                    (!model_part_target && volume->type() != ModelVolumeType::PARAMETER_MODIFIER))
                    throw FilamentCommandFailure("ineligible_target", "target volume is not eligible for filament assignment");
                object = owner_of_volume_in(model, target.id);
            } else {
                throw FilamentCommandFailure("ineligible_target", "target kind is not eligible for filament assignment");
            }
            if (object == nullptr) throw FilamentCommandFailure("ineligible_target", "assignment target was not found");
            if ((target.kind == "object" || target.kind == "instance" || target.kind == "instance-as-object") && slot == 0)
                throw FilamentCommandFailure("invalid_command", "object assignment cannot inherit");
            const std::string normalized_kind = (target.kind == "instance" || target.kind == "instance-as-object") ? "object" :
                (target.kind == "model_part" ? "model-part" : target.kind == "parameter_modifier" ? "parameter-modifier" : target.kind);
            const std::size_t normalized_id = normalized_kind == "object" ? object->id().id : target.id;
            if (seen.emplace(normalized_kind, normalized_id).second) {
                normalized.push_back({normalized_kind, normalized_id});
                affected_objects.insert(object->id().id);
            }
        }
        // Normalize ownership before mutating.  An owning object (including an
        // instance normalized to that object) dominates all descendant model
        // parts regardless of request order; parameter modifiers remain
        // independent and are preserved unless explicitly targeted.
        std::set<std::size_t> owning_objects;
        for (const auto& target : normalized)
            if (target.kind == "object") owning_objects.insert(target.id);
        std::vector<FilamentAssignmentTarget> effective_targets;
        for (const auto& target : normalized) {
            if (target.kind == "model-part") {
                const auto* owner = owner_of_volume_in(model, target.id);
                if (owner != nullptr && owning_objects.find(owner->id().id) != owning_objects.end()) continue;
            }
            effective_targets.push_back(target);
        }
        std::stable_sort(effective_targets.begin(), effective_targets.end(), [](const auto& left, const auto& right) {
            const auto rank = [](const std::string& kind) { return kind == "object" ? 0 : kind == "model-part" ? 1 : 2; };
            return rank(left.kind) < rank(right.kind);
        });
        json accepted = json::array();
        for (const auto& target : effective_targets) {
            const auto* owner = target.kind == "object" ? find_object_by_id_in(model, target.id) : owner_of_volume_in(model, target.id);
            accepted.push_back({{"kind", target.kind}, {"id", target.id}, {"object_id", owner->id().id}});
            if (target.kind == "object") {
                auto* object = find_object_by_id_in(model, target.id);
                object->config.set_key_value("extruder", new ConfigOptionInt(slot));
                for (auto* volume : object->volumes)
                    if (volume->type() == ModelVolumeType::MODEL_PART) volume->config.erase("extruder");
            } else {
                auto* volume = find_volume_by_id_in(model, target.id);
                if (slot == 0) volume->config.erase("extruder");
                else volume->config.set_key_value("extruder", new ConfigOptionInt(slot));
            }
        }
        return json{{"kind", "assign"}, {"accepted_targets", accepted}, {"slot", slot}};
    });
}

static const char* routing_key_for_selector(const std::string& selector)
{
    static const std::map<std::string, const char*> keys = {
        {"support-base", "support_filament"}, {"support-interface", "support_interface_filament"},
        {"outer-wall", "outer_wall_filament_id"}, {"inner-wall", "inner_wall_filament_id"},
        {"sparse-infill", "sparse_infill_filament_id"}, {"internal-solid-infill", "internal_solid_filament_id"},
        {"top-surface", "top_surface_filament_id"}, {"bottom-surface", "bottom_surface_filament_id"},
    };
    const auto it = keys.find(selector);
    return it == keys.end() ? nullptr : it->second;
}

json filament_routing_command(const json& request)
{
    const std::string requested_selector = request.value("selector", "");
    const bool model_only = requested_selector != "support-base" && requested_selector != "support-interface";
    return run_filament_assignment_mutation(request, "Set Filament Routing", [&request](PresetBundle& bundle, Model& model,
        auto&, auto&, std::set<std::size_t>& affected_objects) {
        if (!request.contains("selector") || !request["selector"].is_string())
            throw FilamentCommandFailure("invalid_command", "routing selector is required");
        const std::string selector = request["selector"].get<std::string>();
        const char* key = routing_key_for_selector(selector);
        if (key == nullptr) throw FilamentCommandFailure("invalid_command", "unsupported filament routing selector");
        const bool feature_selector = selector != "support-base" && selector != "support-interface";
        const int slot = request.contains("slot") && request["slot"].is_number_integer() ? request["slot"].get<int>() : -1;
        if (slot < 0 || slot > static_cast<int>(bundle.filament_presets.size()))
            throw FilamentCommandFailure("unsupported_reference", "routing slot is outside the ordered filament slots");
        const auto targets = request.contains("targets") ? request["targets"] : request.value("target", json::object());
        const json array = targets.is_array() ? targets : json::array({targets});
        if (array.empty()) throw FilamentCommandFailure("invalid_command", "routing targets are required");
        json accepted = json::array();
        std::set<std::pair<std::string, std::size_t>> seen;
        bool invalidate_all = false;
        for (const auto& target : array) {
            if (!target.is_object() || !target.contains("kind") || !target["kind"].is_string())
                throw FilamentCommandFailure("invalid_command", "invalid routing target");
            const std::string kind = target["kind"].get<std::string>();
            const bool project_kind = kind == "project";
            if (project_kind) {
                if (target.contains("id") &&
                    (!target["id"].is_number_unsigned() || target["id"].get<std::uint64_t>() != 0))
                    throw FilamentCommandFailure("invalid_command", "project routing target id must be zero");
            } else if (!target.contains("id") || !target["id"].is_number_unsigned() ||
                       target["id"].get<std::uint64_t>() == 0 ||
                       target["id"].get<std::uint64_t>() > std::numeric_limits<std::size_t>::max()) {
                throw FilamentCommandFailure("invalid_command", "routing target id is invalid");
            }
            const std::size_t id = project_kind ? 0 : target["id"].get<std::size_t>();
            bool project_target = false;
            ModelVolume* volume = nullptr;
            ModelObject* owner = nullptr;
            const std::string normalized_kind = kind == "model_part" ? "model-part" : kind;
            if (normalized_kind == "project") {
                if (feature_selector) throw FilamentCommandFailure("ineligible_target", "feature routing does not support project scope");
                project_target = true;
            } else if (normalized_kind == "object") {
                owner = find_object_by_id_in(model, id);
            } else if (normalized_kind == "model-part") {
                if (!feature_selector) throw FilamentCommandFailure("ineligible_target", "support routing does not support model-part scope");
                volume = find_volume_by_id_in(model, id); owner = owner_of_volume_in(model, id);
            } else {
                throw FilamentCommandFailure("ineligible_target", "routing target is not eligible");
            }
            if (!project_target && normalized_kind == "object" && owner == nullptr) throw FilamentCommandFailure("ineligible_target", "routing target was not found");
            if (!project_target && normalized_kind == "model-part" && (owner == nullptr || volume == nullptr || volume->type() != ModelVolumeType::MODEL_PART))
                throw FilamentCommandFailure("ineligible_target", "routing target was not found");
            if (normalized_kind == "object" || normalized_kind == "model-part") affected_objects.insert(owner ? owner->id().id : id);
            if (seen.emplace(normalized_kind, id).second) {
                if (project_target) bundle.project_config.set_key_value(key, new ConfigOptionInt(slot));
                else if (normalized_kind == "object") owner->config.set_key_value(key, new ConfigOptionInt(slot));
                else volume->config.set_key_value(key, new ConfigOptionInt(slot));
                accepted.push_back({{"kind", normalized_kind}, {"id", id}, {"object_id", owner ? owner->id().id : 0}});
                invalidate_all = invalidate_all || project_target;
            }
        }
        // Native support/raft filament selection changes the flushing input.
        // Recalculate only after every target has been accepted into the
        // staged bundle; the assignment transaction then publishes the full
        // matrix atomically with the routing mutation.  Feature-path routing
        // does not affect flushing volumes.
        if (!feature_selector) recalculate_filament_flush(bundle);
        return json{{"kind", "routing"}, {"selector", selector}, {"slot", slot},
                    {"accepted_targets", accepted}, {"invalidate_all_plates", invalidate_all}};
    }, model_only);
}

json filament_select_slot_preset_command(const json& request)
{
    return run_filament_mutation(request, "Select Filament Preset", [&request](PresetBundle& bundle, Model&, auto&, auto&, std::size_t count) {
        std::string error;
        const auto slot = filament_command_slot(request, "slot", count, error);
        if (!slot) throw FilamentCommandFailure("unsupported_reference", error);
        if (!request.contains("preset") || !request["preset"].is_string()) throw FilamentCommandFailure("invalid_command", "preset is required");
        const std::string name = request["preset"].get<std::string>();
        const Preset* preset = bundle.filaments.find_preset(name, false, true);
        if (preset == nullptr || !preset->is_visible || !preset->is_compatible)
            throw FilamentCommandFailure("unsupported_reference", "unsupported filament preset reference");
        const auto user_override = user_filament_colour_override(bundle, *slot);
        bundle.set_filament_preset(*slot, name);
        auto* colours = bundle.project_config.option<ConfigOptionStrings>("filament_colour", true);
        colours->values.resize(count, "#26A69A");
        colours->values[*slot] = user_override.value_or(filament_preset_colour(bundle, *slot));
        if (auto* multi = bundle.project_config.option<ConfigOptionStrings>("filament_multi_colour", true)) {
            multi->values.resize(count, "#26A69A");
            multi->values[*slot] = colours->values[*slot];
        }
        recalculate_filament_flush(bundle);
        return json{{"kind", "select-preset"}, {"slot", *slot + 1}, {"preset", name}};
    });
}

json filament_set_colour_command(const json& request)
{
    return run_filament_mutation(request, "Edit Filament Colour", [&request](PresetBundle& bundle, Model&, auto&, auto&, std::size_t count) {
        std::string error;
        const auto slot = filament_command_slot(request, "slot", count, error);
        if (!slot) throw FilamentCommandFailure("unsupported_reference", error);
        if (!request.contains("colour") || !request["colour"].is_string() ||
            !valid_filament_colour(request["colour"].get<std::string>()))
            throw FilamentCommandFailure("native_validation_failure", "native filament colour validation failed");
        auto* colours = bundle.project_config.option<ConfigOptionStrings>("filament_colour", true);
        colours->values.resize(count, "#26A69A");
        colours->values[*slot] = request["colour"].get<std::string>();
        if (auto* multi = bundle.project_config.option<ConfigOptionStrings>("filament_multi_colour", true)) {
            multi->values.resize(count, "#26A69A");
            multi->values[*slot] = colours->values[*slot];
        }
        recalculate_filament_flush(bundle);
        return json{{"kind", "set-colour"}, {"slot", *slot + 1}, {"colour", colours->values[*slot]}};
    });
}

static constexpr std::array<const char*, 16> kNativeFilamentColours = {
    "#00C1AE", "#F4E2C1", "#ED1C24", "#00FF7F",
    "#F26722", "#FFEB31", "#7841CE", "#115877",
    "#ED1E79", "#2EBDEF", "#345B2F", "#800080",
    "#FA8173", "#800000", "#F7B763", "#A4C41E",
};

json filament_add_command(const json& request)
{
    return run_filament_slot_mutation(request, "Add Filament Slot", false,
        [](PresetBundle& bundle, Model&, auto& plates, auto&, std::size_t count) {
        const bool flexible = bundle.printers.get_edited_preset().config.opt_bool("single_extruder_multi_material") || bundle.is_bbl_vendor();
        if (!flexible || count >= 64) throw FilamentCommandFailure("capability_rejected", "filament slot capacity or capability rejected");
        const std::string colour = kNativeFilamentColours[state().next_filament_colour_index++ % kNativeFilamentColours.size()];
        bundle.set_num_filaments(static_cast<unsigned int>(count + 1), colour);
        auto* colours = bundle.project_config.option<ConfigOptionStrings>("filament_colour", true);
        colours->values.resize(count + 1, "#26A69A");
        colours->values[count] = colour;
        if (auto* multi = bundle.project_config.option<ConfigOptionStrings>("filament_multi_colour", true)) {
            multi->values.resize(count + 1, "#26A69A");
            multi->values[count] = colour;
        }
        add_plate_filament_references(plates, bundle, count);
        recalculate_filament_flush(bundle);
        return json{{"kind", "add"}, {"slot", count + 1}};
        });
}

json filament_delete_or_merge_command(const json& request, const bool merge)
{
    if (!merge)
        return run_filament_slot_mutation(request, "Delete Filament Slot", true,
            [request](PresetBundle& bundle, Model& model, auto& plates, auto& overlay, std::size_t count) {
            const bool flexible = bundle.printers.get_edited_preset().config.opt_bool("single_extruder_multi_material") || bundle.is_bbl_vendor();
            if (!flexible || count <= 1) throw FilamentCommandFailure("capability_rejected", "filament slot capability rejected");
            std::string error;
            const auto source = filament_command_slot(request, "slot", count, error);
            if (!source) throw FilamentCommandFailure("unsupported_reference", error);
            bundle.update_num_filaments(*source);
            remap_config_filament_references(bundle.project_config, *source, std::nullopt);
            remap_model_filament_references(model, *source, std::nullopt, count - 1);
            remap_plate_filament_references(plates, *source, std::nullopt, count);
            remap_overlay_filament_references(overlay, *source, std::nullopt);
            recalculate_filament_flush(bundle);
            return json{{"kind", "delete"}, {"source", *source + 1},
                        {"destination", nullptr}, {"slot_count", count - 1}};
        });
    return run_filament_mutation(request, merge ? "Merge Filament Slots" : "Delete Filament Slot",
        [request, merge](PresetBundle& bundle, Model& model, auto& plates, auto& overlay, std::size_t count) {
        const bool flexible = bundle.printers.get_edited_preset().config.opt_bool("single_extruder_multi_material") || bundle.is_bbl_vendor();
        if (!flexible || count <= 1) throw FilamentCommandFailure("capability_rejected", "filament slot capability rejected");
        std::string error;
        const auto source = filament_command_slot(request, merge ? "source" : "slot", count, error);
        if (!source) throw FilamentCommandFailure("unsupported_reference", error);
        std::optional<std::size_t> replacement;
        if (merge) {
            const auto destination = filament_command_slot(request, "destination", count, error);
            if (!destination || *destination == *source) throw FilamentCommandFailure("unsupported_reference", "unsupported filament reference");
            replacement = *destination > *source ? *destination - 1 : *destination;
        }
        bundle.update_num_filaments(*source);
        // Project-scoped support/feature routing lives in the native project
        // config rather than the renderer overlay.  Remap it before the
        // projection is rebuilt so Delete yields Default for zero-backed
        // routing and Merge points at the selected survivor.
        remap_config_filament_references(bundle.project_config, *source, replacement);
        remap_model_filament_references(model, *source, replacement, count - 1);
        remap_plate_filament_references(plates, *source, replacement, count);
        remap_overlay_filament_references(overlay, *source, replacement);
        recalculate_filament_flush(bundle);
        return json{{"kind", merge ? "merge" : "delete"}, {"source", *source + 1},
                    {"destination", replacement ? json(*replacement + 1) : json(nullptr)},
                    {"slot_count", count - 1}};
    });
}

// Shared initialization body. The incoming JSON is ignored legacy input.
// the renderer's whole config — REPLACE the previous state, never merge:
// a stale presets.machine from an earlier init could point at a printer that
// is invisible under the new models section, and install_all_printers'
// accumulated models would defeat a later partial install. (M4 probe:
// section 4 crashed on this — the second init inherited section 3's
// selection + the fresh-default's full vendor map.)
void reset_app_config() {
    AppConfig& cfg = state().profile_config;
    cfg.set_vendors({});            // installed-state (m_vendors)
    cfg.clear_section("presets");   // selections
    cfg.clear_section("filaments"); // installed filaments
}
const char* init_with_app_config(const json& j) {
    reset_app_config();
    const bool has_models = apply_app_config(j);
    set_data_dir("/");
    // resources_dir() is never set by the bridge; pointing it at "/" makes
    // the bundled /info/nozzle_info.json mountable and stops
    // get_hrc_by_nozzle_type's benign parse-error path (M3 carry-forward).
    set_resources_dir("/");
    state().presets.setup_directories();
    state().presets.load_presets(state().profile_config, ForwardCompatibilitySubstitutionRule::Enable);
    if (!has_models) {
        install_all_printers();
        reselect_after_app_config();
    }
    return dup_json(json{{"ok", true},
                         {"prints",    state().presets.prints.size()},
                         {"filaments", state().presets.filaments.size()},
                         {"printers",  state().presets.printers.size()}}.dump());
}

// ObjectID crosses the boundary as a JSON number. Wasm64 sizes are 64-bit, so
// the client passes a JS Number (double); validate it is a positive integer
// before narrowing to size_t. A valid ObjectID is strictly positive (ObjectID.hpp).
static std::optional<std::size_t> to_object_id(const double v) {
    if (!std::isfinite(v) || v < 1.0 || std::floor(v) != v)
        return std::nullopt;
    return static_cast<std::size_t>(v);
}

// Parse a JSON array of positive integral ObjectIDs. Deduplicates preserving
// input order (clone preserves the requested order; delete ignores order).
// Returns nullopt for any malformed entry or an empty array.
static std::optional<std::vector<std::size_t>> parse_positive_id_array(const json& j) {
    if (!j.is_array() || j.empty()) return std::nullopt;
    std::vector<std::size_t> out;
    out.reserve(j.size());
    for (const auto& item : j) {
        if (!item.is_number()) return std::nullopt;
        const double v = item.get<double>();
        if (!std::isfinite(v) || v < 1.0 || std::floor(v) != v) return std::nullopt;
        const std::size_t id = static_cast<std::size_t>(v);
        if (std::find(out.begin(), out.end(), id) == out.end())
            out.push_back(id);
    }
    return out;
}

// Stable-ID resolution against the live Model. IDs are globally unique across
// objects/volumes/instances (ObjectBase::generate_new_id), so each helper scans
// the whole model rather than assuming a particular ObjectID space ordering.
static ModelObject* find_object_by_id(const std::size_t id) {
    auto& model = state().model;
    for (auto& obj : model.objects)
        if (obj->id().id == id) return obj;
    return nullptr;
}

static ModelVolume* find_volume_by_id(const std::size_t id) {
    auto& model = state().model;
    for (auto& obj : model.objects)
        for (auto& vol : obj->volumes)
            if (vol->id().id == id) return vol;
    return nullptr;
}

static ModelInstance* find_instance_by_id(const std::size_t id) {
    auto& model = state().model;
    for (auto& obj : model.objects)
        for (auto& inst : obj->instances)
            if (inst->id().id == id) return inst;
    return nullptr;
}

// Volume types cross the boundary with the spec's stable snake_case strings
// (spec/ObjectList-and-Parts.md §9.1). ModelVolume::type_to_string uses the
// upstream BBS names ("normal_part"/"negative_part"/"modifier_part"), which
// differ from the bridge contract, so map explicitly here.
static const char* volume_type_string(const ModelVolumeType t) {
    switch (t) {
        case ModelVolumeType::MODEL_PART:         return "model_part";
        case ModelVolumeType::NEGATIVE_VOLUME:    return "negative_volume";
        case ModelVolumeType::PARAMETER_MODIFIER: return "parameter_modifier";
        case ModelVolumeType::SUPPORT_BLOCKER:    return "support_blocker";
        case ModelVolumeType::SUPPORT_ENFORCER:   return "support_enforcer";
        default:                                  return "model_part";
    }
}

// Reverse of volume_type_string: spec snake_case string -> ModelVolumeType.
// Returns nullopt for an unknown string so orc_set_volume_type can reject it.
static std::optional<ModelVolumeType> volume_type_from_string(const std::string& s) {
    if (s == "model_part")         return ModelVolumeType::MODEL_PART;
    if (s == "negative_volume")    return ModelVolumeType::NEGATIVE_VOLUME;
    if (s == "parameter_modifier") return ModelVolumeType::PARAMETER_MODIFIER;
    if (s == "support_blocker")    return ModelVolumeType::SUPPORT_BLOCKER;
    if (s == "support_enforcer")   return ModelVolumeType::SUPPORT_ENFORCER;
    return std::nullopt;
}

// Serialize the complete object/part/instance tree. Shared by
// orc_get_model_structure (read-only) and the reorder operations, which return
// the current structure after moving entities. Returns the "objects" array so
// callers wrap it with their own ok/error envelope.
static json model_structure_json() {
    auto& model = state().model;
    json objects = json::array();
    for (size_t oi = 0; oi < model.objects.size(); ++oi) {
        const auto& obj = model.objects[oi];
        json volumes = json::array();
        for (size_t vi = 0; vi < obj->volumes.size(); ++vi) {
            const auto& vol = obj->volumes[vi];
            volumes.push_back(json{
                {"id",            vol->id().id},
                {"index",         vi},
                {"name",          vol->name},
                {"type",          volume_type_string(vol->type())},
                {"isSplittable",  vol->is_splittable()},
            });
        }
        json instances = json::array();
        for (size_t ii = 0; ii < obj->instances.size(); ++ii) {
            const auto& inst = obj->instances[ii];
            instances.push_back(json{
                {"id",        inst->id().id},
                {"index",     ii},
                {"printable", inst->printable},
            });
        }
        objects.push_back(json{
            {"id",            obj->id().id},
            {"index",         oi},
            {"name",          obj->name},
            {"printable",     obj->printable},
            {"instanceCount", obj->instances.size()},
            {"volumes",       std::move(volumes)},
            {"instances",     std::move(instances)},
        });
    }
    return objects;
}

template <class Config>
void apply_overlay_to_config(Config& config, const json& values)
{
    if (!values.is_object()) return;
    ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
    for (auto it = values.begin(); it != values.end(); ++it) {
        if (!it.value().is_string()) continue;
        try { config.set_deserialize(it.key(), it.value().get<std::string>(), substitutions); }
        catch (...) { /* invalid retained values are ignored at slice time */ }
    }
}

json project_config_overlay_metadata()
{
    return json{{"schema", kNeoConfigOverlaySchema}, {"version", 1},
                {"overlay", state().project_config_overlay}};
}

json project_config_overlay_result()
{
    return json{{"ok", true}, {"overlay", state().project_config_overlay}};
}

// The native ConfigOption parser is the authority for prime-tower input.  A
// successful mutation returns the value after that parser, allowing hosts to
// display native normalization/corrections without reimplementing a second
// settings parser.  Warnings/errors remain native command status values.
template <typename Config>
json native_configuration_status(const Config& config,
                                 const std::string& key,
                                 const std::string& requested)
{
    json corrections = json::array();
    const ConfigOption* option = config.option(key);
    if (option != nullptr) {
        const std::string effective = option->serialize();
        if (effective != requested)
            corrections.push_back({{"key", key}, {"requested", requested}, {"effective", effective}});
    }
    return json{{"state", "ready"}, {"corrections", std::move(corrections)},
                {"warnings", json::array()}, {"errors", json::array()}};
}

const char* native_configuration_error_json(const std::string& code,
                                            const std::string& message)
{
    return dup_json(json{{"ok", false}, {"error", message}, {"error_code", code},
                         {"status", {{"state", "error"}, {"error", message}}}}.dump());
}

// Plate session state is deliberately kept beside the model version in the
// history context.  The model archive cannot carry the headless session's
// current plate, runtime plate IDs, membership, or input revisions, so
// restoring only Model leaves the renderer observing a different project than
// the Worker.  Validate the complete wire snapshot before replacing either
// live state.  Object/instance IDs are resolved by their saved structural
// position because libslic3r's deserialization constructors allocate fresh
// instance IDs; the immutable plate IDs themselves are restored verbatim.
static void validate_history_plate_session(const json& session, const Model& model)
{
    if (!session.is_object() || session.value("version", 0) != 1 ||
        !session.contains("current_plate_id") || !session["current_plate_id"].is_string() ||
        !session.contains("plates") || !session["plates"].is_array() || session["plates"].empty() ||
        session["plates"].size() > static_cast<std::size_t>(kMaxPlateCount) ||
        !session.contains("instances") || !session["instances"].is_array() ||
        !session.contains("input_revisions") || !session["input_revisions"].is_object())
        throw std::runtime_error("invalid history plate session");

    std::set<std::string> plate_ids;
    for (std::size_t index = 0; index < session["plates"].size(); ++index) {
        const auto& plate = session["plates"][index];
        if (!plate.is_object() || !plate.contains("plate_id") || !plate["plate_id"].is_string() ||
            plate["plate_id"].get<std::string>().empty() ||
            !plate_ids.insert(plate["plate_id"].get<std::string>()).second ||
            !plate.contains("display_index") || !plate["display_index"].is_number_integer() ||
            plate["display_index"].get<int>() != static_cast<int>(index) ||
            !plate.contains("origin") || !plate["origin"].is_array() || plate["origin"].size() != 3 ||
            !std::all_of(plate["origin"].begin(), plate["origin"].end(),
                         [](const json& coordinate) { return coordinate.is_number(); }) ||
            !plate.contains("name") || !plate["name"].is_string() ||
            !plate.contains("locked") || !plate["locked"].is_boolean() ||
            !plate.contains("settings") || !plate["settings"].is_object() ||
            !plate.contains("opaque_metadata") || !plate["opaque_metadata"].is_array() ||
            !plate.contains("future_metadata") || !plate["future_metadata"].is_object() ||
            !plate.contains("instance_ids") || !plate["instance_ids"].is_array() ||
            !plate.contains("out_of_bounds_instance_ids") || !plate["out_of_bounds_instance_ids"].is_array())
            throw std::runtime_error("invalid history plate record");
    }
    if (plate_ids.find(session["current_plate_id"].get<std::string>()) == plate_ids.end())
        throw std::runtime_error("history current plate is not present");

    std::set<std::size_t> model_instance_ids;
    for (const auto* object : model.objects)
        for (const auto* instance : object->instances)
            model_instance_ids.insert(instance->id().id);

    std::map<std::size_t, std::pair<std::size_t, std::size_t>> saved_instances;
    std::set<std::pair<std::size_t, std::size_t>> saved_positions;
    std::set<std::size_t> membership_ids;
    std::set<std::size_t> out_of_bounds_ids;
    for (const auto& instance : session["instances"]) {
        if (!instance.is_object() || !instance.contains("instance_id") ||
            !instance["instance_id"].is_number_integer() || instance["instance_id"].get<std::int64_t>() < 0 ||
            !instance.contains("object_index") || !instance["object_index"].is_number_integer() ||
            !instance.contains("instance_index") || !instance["instance_index"].is_number_integer() ||
            !instance.contains("plate_id") || !instance["plate_id"].is_string() ||
            !instance.contains("member") || !instance["member"].is_boolean() ||
            !instance.contains("parked") || !instance["parked"].is_boolean() ||
            !instance.contains("out_of_bounds") || !instance["out_of_bounds"].is_boolean())
            throw std::runtime_error("invalid history instance membership");
        const auto saved_id = instance["instance_id"].get<std::size_t>();
        const auto object_index = instance["object_index"].get<std::size_t>();
        const auto instance_index = instance["instance_index"].get<std::size_t>();
        if (!saved_instances.emplace(saved_id, std::make_pair(object_index, instance_index)).second ||
            !saved_positions.emplace(object_index, instance_index).second ||
            object_index >= model.objects.size() || instance_index >= model.objects[object_index]->instances.size())
            throw std::runtime_error("history instance membership does not match model");
        const std::string plate_id = instance["plate_id"].get<std::string>();
        if (plate_id.empty() != !instance["member"].get<bool>() ||
            (!plate_id.empty() && plate_ids.find(plate_id) == plate_ids.end()) ||
            (instance["parked"].get<bool>() && !plate_id.empty()) ||
            (instance["out_of_bounds"].get<bool>() && plate_id.empty()))
            throw std::runtime_error("inconsistent history instance membership");
        if (!plate_id.empty()) membership_ids.insert(saved_id);
        if (instance["out_of_bounds"].get<bool>()) out_of_bounds_ids.insert(saved_id);
    }
    if (saved_instances.size() != model_instance_ids.size())
        throw std::runtime_error("history plate session is missing model instances");

    std::set<std::size_t> listed_members;
    std::set<std::size_t> listed_out_of_bounds;
    for (const auto& plate : session["plates"]) {
        for (const auto& value : plate["instance_ids"]) {
            if (!value.is_number_integer() || value.get<std::int64_t>() < 0 ||
                !listed_members.insert(value.get<std::size_t>()).second)
                throw std::runtime_error("duplicate history plate membership");
            const auto instance = std::find_if(session["instances"].begin(), session["instances"].end(),
                                               [&](const json& candidate) {
                                                   return candidate["instance_id"] == value;
                                               });
            if (instance == session["instances"].end() || instance->at("plate_id") != plate["plate_id"])
                throw std::runtime_error("history plate membership does not match instances");
        }
        for (const auto& value : plate["out_of_bounds_instance_ids"]) {
            if (!value.is_number_integer() || value.get<std::int64_t>() < 0 ||
                !listed_out_of_bounds.insert(value.get<std::size_t>()).second)
                throw std::runtime_error("duplicate history out-of-bounds membership");
            const auto instance = std::find_if(session["instances"].begin(), session["instances"].end(),
                                               [&](const json& candidate) {
                                                   return candidate["instance_id"] == value;
                                               });
            if (instance == session["instances"].end() || instance->at("plate_id") != plate["plate_id"] ||
                !instance->at("out_of_bounds").get<bool>())
                throw std::runtime_error("history out-of-bounds membership does not match instances");
        }
    }
    if (listed_members != membership_ids || listed_out_of_bounds != out_of_bounds_ids)
        throw std::runtime_error("history plate membership is incomplete");

    for (const auto& [plate_id, revision] : session["input_revisions"].items()) {
        if (plate_ids.find(plate_id) == plate_ids.end() || !revision.is_number_unsigned())
            throw std::runtime_error("invalid history plate revision");
    }
    for (const auto& plate_id : plate_ids)
        if (!session["input_revisions"].contains(plate_id))
            throw std::runtime_error("history plate revision is missing");
}

static std::vector<BridgeState::PlateSessionPlate> build_history_plate_session(const json& session,
                                                                                 const Model& restored_model)
{
    validate_history_plate_session(session, restored_model);

    std::vector<BridgeState::PlateSessionPlate> restored_plates;
    restored_plates.reserve(session["plates"].size());
    for (const auto& record : session["plates"]) {
        BridgeState::PlateSessionPlate plate;
        plate.id = record["plate_id"].get<std::string>();
        plate.name = record["name"].get<std::string>();
        plate.display_index = record["display_index"].get<int>();
        const auto& origin = record["origin"];
        plate.origin = Vec3d(origin[0].get<double>(), origin[1].get<double>(), origin[2].get<double>());
        plate.locked = record["locked"].get<bool>();
        plate.settings_metadata = record["settings"];
        plate.opaque_metadata = record["opaque_metadata"];
        plate.future_metadata = record["future_metadata"];
        apply_overlay_to_config(plate.settings, plate.settings_metadata);
        restored_plates.push_back(std::move(plate));
    }

    return restored_plates;
}

static void restore_history_plate_session(const json& session, const Model& restored_model)
{
    auto restored_plates = build_history_plate_session(session, restored_model);

    state().plate_session_plates = std::move(restored_plates);
    state().current_plate_id = session["current_plate_id"].get<std::string>();
    state().instance_plate_ids.clear();
    state().plate_out_of_bounds_ids.clear();
    state().parked_instance_ids.clear();
    state().plate_input_revisions.clear();

    for (const auto& instance : session["instances"]) {
        const auto object_index = instance["object_index"].get<std::size_t>();
        const auto instance_index = instance["instance_index"].get<std::size_t>();
        const std::size_t restored_id = restored_model.objects[object_index]->instances[instance_index]->id().id;
        const std::string plate_id = instance["plate_id"].get<std::string>();
        if (!plate_id.empty()) state().instance_plate_ids[restored_id] = plate_id;
        if (instance["parked"].get<bool>()) state().parked_instance_ids.insert(restored_id);
        if (instance["out_of_bounds"].get<bool>()) state().plate_out_of_bounds_ids[plate_id].insert(restored_id);
    }
    for (const auto& [plate_id, revision] : session["input_revisions"].items())
        state().plate_input_revisions[plate_id] = revision.get<std::uint64_t>();
}

static void validate_filament_history_mutable_state(PresetBundle& catalog,
                                                     const StagedMutableState& staged,
                                                     Model& model,
                                                     const std::vector<BridgeState::PlateSessionPlate>& plates,
                                                     const json& overlay)
{
    const auto& printer = catalog.printers.get_edited_preset().config;
    validate_filament_candidate_components(staged.names, staged.project_config, printer,
        std::max(1, catalog.get_printer_extruder_count()),
        printer.opt_bool("single_extruder_multi_material") || catalog.is_bbl_vendor(),
        model, plates, overlay);
}

void apply_plate_metadata_to_configs(std::vector<BridgeState::PlateSessionPlate>& plates)
{
    for (auto& plate : plates) {
        apply_overlay_to_config(plate.settings, plate.settings_metadata);
        plate.settings_metadata = config_metadata_json(plate.settings);
    }
}

void apply_plate_overlay_to_configs(std::vector<BridgeState::PlateSessionPlate>& plates,
                                    const json& overlay)
{
    if (!overlay.is_object() || !overlay.contains("plates") || !overlay["plates"].is_object()) return;
    for (std::size_t index = 0; index < plates.size(); ++index) {
        auto& plate = plates[index];
        const json* values = nullptr;
        if (const auto exact = overlay["plates"].find(plate.id); exact != overlay["plates"].end()) {
            values = &exact.value();
        } else {
            // Plate session ids are runtime identities and are intentionally
            // regenerated on restore.  Preserve the saved overlay by its
            // stable one-based plate suffix when the identity changed.
            const std::string suffix = "-plate-" + std::to_string(index + 1);
            for (auto it = overlay["plates"].begin(); it != overlay["plates"].end(); ++it) {
                if (it.key().size() >= suffix.size() &&
                    it.key().compare(it.key().size() - suffix.size(), suffix.size(), suffix) == 0) {
                    values = &it.value();
                    break;
                }
            }
        }
        if (values != nullptr) {
            apply_overlay_to_config(plate.settings, *values);
            plate.settings_metadata = config_metadata_json(plate.settings);
        }
    }
}

static void restore_history_model(const Neo::History::RestoreState& restored)
{
    state().model = Neo::History::Codec::stage_model(state().model, restored);
}

// Abort is a transaction rollback, not merely a model rollback. Filament
// commands stage PresetBundle alongside ModelState; restoring only geometry
// here would leave colours/maps/routing and the history context disagreeing.
static void restore_history_transaction_state(const json& context,
                                              const Neo::History::ModelState& model)
{
    if (!context.contains("filamentState"))
        throw std::runtime_error("history transaction is missing filament state");
    auto staged_filament_state = stage_mutable(state().presets, context["filamentState"]);
    auto staged_model = Neo::History::Codec::model_state_equal(
        Neo::History::Codec::capture_model_state(state().model), model)
        ? Model(state().model) : Neo::History::Codec::stage_model(state().model, {model, {}, {}});
    auto staged_plates = state().plate_session_plates;
    if (context.contains("plateSession"))
        staged_plates = build_history_plate_session(context["plateSession"], staged_model);
    validate_filament_history_mutable_state(state().presets, staged_filament_state, staged_model, staged_plates,
                                            context.value("projectConfigOverlay", empty_project_config_overlay()));
    auto before_filament_state = stage_mutable(
        state().presets, history_state_json(state().presets));
    const auto before_model = state().model;
    const auto before_plates = state().plate_session_plates;
    const auto before_overlay = state().project_config_overlay;
    apply_mutable(state(), state().presets, std::move(staged_filament_state));
    state().model = std::move(staged_model);
    try {
        if (context.contains("plateSession"))
            restore_history_plate_session(context["plateSession"], state().model);
        if (valid_project_config_overlay(context["projectConfigOverlay"]))
            state().project_config_overlay = context["projectConfigOverlay"];
    } catch (...) {
        apply_mutable(state(), state().presets, std::move(before_filament_state));
        state().model = before_model;
        state().plate_session_plates = before_plates;
        state().project_config_overlay = before_overlay;
        throw;
    }
}

static void validate_direct_filament_history_frame(const DirectFilamentHistoryFrame& frame,
                                                   const json& context)
{
    if (!frame.model || frame.filament_presets.empty() || frame.filament_presets.size() > 64 ||
        frame.plates.empty())
        throw std::runtime_error("invalid direct filament history frame");
    for (const auto& name : frame.filament_presets)
        if (name.empty() || state().presets.filaments.find_preset(name, false, true) == nullptr)
            throw std::runtime_error("direct history filament preset is unavailable");
    // The JSON context remains the authoritative wire representation.  Check
    // it against the immutable direct Model before publishing any shortcut
    // state; this preserves the normal restore's all-or-nothing fence.
    if (!context.contains("plateSession"))
        throw std::runtime_error("direct history frame is missing plate session");
    validate_history_plate_session(context["plateSession"], *frame.model);
    if (!valid_project_config_overlay(frame.overlay))
        throw std::runtime_error("invalid direct history project configuration overlay");
    if (std::none_of(frame.plates.begin(), frame.plates.end(), [&](const auto& plate) {
            return plate.id == frame.current_plate_id;
        }))
        throw std::runtime_error("direct history current plate is unavailable");
}

static json restore_direct_filament_history_frame(const Neo::History::RestorePlan& plan,
                                                  const json& validated_context)
{
    if (!plan.state.direct_frame || !plan.state.direct_frame->payload ||
        plan.state.direct_frame->bytes == 0)
        throw std::runtime_error("direct history frame is unavailable");
    const auto frame = std::static_pointer_cast<const DirectFilamentHistoryFrame>(
        plan.state.direct_frame->payload);
    if (!frame) throw std::runtime_error("direct history frame is unavailable");
    validate_direct_filament_history_frame(*frame, validated_context);

    // Build every mutable replacement first.  The direct frame is internal,
    // immutable, and was captured only after the normal native candidate
    // validation; these temporary copies are the restore-side validation
    // boundary before any live field or history cursor is published.
    auto staged_filament_presets = frame->filament_presets;
    auto staged_project_config = frame->project_config;
    auto staged_ams_colours = frame->ams_multi_colour_filment;
    if (!frame->edited_filament)
        throw std::runtime_error("direct history edited filament preset is unavailable");
    auto staged_edited_filament = *frame->edited_filament;
    Model staged_model = *frame->model;
    auto staged_plates = frame->plates;
    auto staged_overlay = frame->overlay;
    auto staged_plate_revisions = frame->plate_input_revisions;
    auto staged_membership = frame->instance_plate_ids;
    auto staged_out_of_bounds = frame->plate_out_of_bounds_ids;
    auto staged_parked = frame->parked_instance_ids;
    auto staged_pending = frame->pending_membership_instance_ids;
    const auto staged_current_plate = frame->current_plate_id;
    const auto staged_colour_index = frame->next_filament_colour_index;
    if (!state().history.can_commit_restore(plan))
        throw std::runtime_error("history restore became stale");

    // Save the small ownership surface required to roll back an unexpected
    // native assignment failure.  The expensive preset install/rebuild path
    // is intentionally absent from the successful direct restore.
    const auto before_filament_presets = state().presets.filament_presets;
    const auto before_project_config = state().presets.project_config;
    const auto before_ams_colours = state().presets.ams_multi_color_filment;
    const auto before_edited = state().presets.filaments.get_edited_preset();
    Model before_model = state().model;
    const auto before_plates = state().plate_session_plates;
    const auto before_overlay = state().project_config_overlay;
    const auto before_plate_revisions = state().plate_input_revisions;
    const auto before_membership = state().instance_plate_ids;
    const auto before_out_of_bounds = state().plate_out_of_bounds_ids;
    const auto before_parked = state().parked_instance_ids;
    const auto before_pending = state().pending_membership_instance_ids;
    const auto before_current_plate = state().current_plate_id;
    const auto before_colour_index = state().next_filament_colour_index;
    try {
        state().presets.filament_presets = std::move(staged_filament_presets);
        state().presets.project_config = std::move(staged_project_config);
        state().presets.ams_multi_color_filment = std::move(staged_ams_colours);
        state().presets.filaments.get_edited_preset() = std::move(staged_edited_filament);
        state().model = std::move(staged_model);
        state().plate_session_plates = std::move(staged_plates);
        state().project_config_overlay = std::move(staged_overlay);
        state().plate_input_revisions = std::move(staged_plate_revisions);
        state().instance_plate_ids = std::move(staged_membership);
        state().plate_out_of_bounds_ids = std::move(staged_out_of_bounds);
        state().parked_instance_ids = std::move(staged_parked);
        state().pending_membership_instance_ids = std::move(staged_pending);
        state().current_plate_id = staged_current_plate;
        state().next_filament_colour_index = staged_colour_index;
        if (!state().history.commit_restore(plan))
            throw std::runtime_error("history restore became stale");
        ++state().history_minimal_mutable_restore_count;
    } catch (...) {
        state().presets.filament_presets = before_filament_presets;
        state().presets.project_config = before_project_config;
        state().presets.ams_multi_color_filment = before_ams_colours;
        state().presets.filaments.get_edited_preset() = before_edited;
        state().model = std::move(before_model);
        state().plate_session_plates = before_plates;
        state().project_config_overlay = before_overlay;
        state().plate_input_revisions = before_plate_revisions;
        state().instance_plate_ids = before_membership;
        state().plate_out_of_bounds_ids = before_out_of_bounds;
        state().parked_instance_ids = before_parked;
        state().pending_membership_instance_ids = before_pending;
        state().current_plate_id = before_current_plate;
        state().next_filament_colour_index = before_colour_index;
        throw;
    }
    state().print.clear();
    invalidate_preview_source();
    state().history_revision++;
    return json{{"ok", true}, {"context", validated_context}, {"status", history_status_json()},
                {"entryId", history_entry_id(plan.state.entry.id)}, {"direct", true}};
}

static json history_restore_result(const Neo::History::RestorePlan& plan)
{
    // Parse and rebuild into temporaries first.  Neither the live model nor
    // the history cursor is touched until both validations have succeeded.
    const auto context = json::parse(std::string(plan.state.context.begin(), plan.state.context.end()));
    const json validated_context = parse_history_context(context.dump().c_str());
    if (plan.state.direct_frame)
        return restore_direct_filament_history_frame(plan, validated_context);
    // A filament-only history restore has the same model bytes as the live
    // model.  Copying that live model preserves native object/volume IDs and
    // parent links; deserializing it again would intentionally construct
    // invalid ModelVolume IDs before materialization.
    const auto live_model_state = Neo::History::Codec::capture_model_state(state().model);
    Model staged_model = Neo::History::Codec::model_state_equal(live_model_state, plan.state.model)
        ? Model(state().model) : Neo::History::Codec::stage_model(state().model, plan.state);
    if (!validated_context.contains("filamentState"))
        throw std::runtime_error("history context is missing filament state");
    // Ordinary model/context entries carry project-mutable filament state.
    // Stage and validate that small state against the live immutable catalogue;
    // never clone PresetBundle's printer/process/filament collections on a
    // history path.
    const bool filament_state_changed =
        history_state_json(state().presets) != validated_context["filamentState"];
    std::optional<StagedMutableState> staged_filament_state;
    if (filament_state_changed) {
        staged_filament_state.emplace(stage_mutable(
            state().presets, validated_context["filamentState"]));
    }
    auto staged_plates = state().plate_session_plates;
    if (validated_context.contains("plateSession"))
        staged_plates = build_history_plate_session(validated_context["plateSession"], staged_model);
    if (staged_filament_state)
        validate_filament_history_mutable_state(state().presets, *staged_filament_state, staged_model,
            staged_plates, validated_context.value("projectConfigOverlay", empty_project_config_overlay()));
    else
        validate_filament_candidate(state().presets, staged_model, staged_plates,
                                    validated_context.value("projectConfigOverlay", empty_project_config_overlay()));
    // Check the cursor fence before replacing the live model.  The Worker is
    // serialized, but keeping this preflight makes a stale plan failure
    // atomic even if another writer is introduced later.
    if (!state().history.can_commit_restore(plan))
        throw std::runtime_error("history restore became stale");
    std::optional<StagedMutableState> before_filament_state;
    if (filament_state_changed)
        before_filament_state.emplace(stage_mutable(
            state().presets, history_state_json(state().presets)));
    Model before_model = state().model;
    const auto before_plates = state().plate_session_plates;
    const auto before_overlay = state().project_config_overlay;
    const auto before_plate_revisions = state().plate_input_revisions;
    const auto before_membership = state().instance_plate_ids;
    const auto before_out_of_bounds = state().plate_out_of_bounds_ids;
    const auto before_parked = state().parked_instance_ids;
    const auto before_pending = state().pending_membership_instance_ids;
    const auto before_current_plate = state().current_plate_id;
    if (staged_filament_state)
        apply_mutable(state(), state().presets, std::move(*staged_filament_state));
    state().model = std::move(staged_model);
    try {
        if (validated_context.contains("plateSession"))
            restore_history_plate_session(validated_context["plateSession"], state().model);
        if (valid_project_config_overlay(validated_context["projectConfigOverlay"]))
            state().project_config_overlay = validated_context["projectConfigOverlay"];
        if (!state().history.commit_restore(plan))
            throw std::runtime_error("history restore became stale");
    } catch (...) {
        if (before_filament_state)
            apply_mutable(state(), state().presets, std::move(*before_filament_state));
        state().model = std::move(before_model);
        state().plate_session_plates = before_plates;
        state().project_config_overlay = before_overlay;
        state().plate_input_revisions = before_plate_revisions;
        state().instance_plate_ids = before_membership;
        state().plate_out_of_bounds_ids = before_out_of_bounds;
        state().parked_instance_ids = before_parked;
        state().pending_membership_instance_ids = before_pending;
        state().current_plate_id = before_current_plate;
        throw;
    }
    state().print.clear();
    invalidate_preview_source();
    state().history_revision++;
    return json{{"ok", true}, {"context", validated_context}, {"status", history_status_json()},
                {"entryId", history_entry_id(plan.state.entry.id)}};
}

static const char* history_restore_failure(const std::string& message)
{
    return dup_json(json{
        {"ok", false},
        {"error", {{"code", "restore-failed"}, {"message", message}, {"retryable", true}}},
        {"status", history_status_json()},
    }.dump());
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_restore_filament_rack(const char* request_cstr)
{
    return restore_filament_rack_command(request_cstr);
}

EMSCRIPTEN_KEEPALIVE const char* orc_init(const char* options_json) {
    try {
        // The JSON is the options payload; only "log_level" is consumed today
        // (the rest is the legacy preferences slot, still ignored — the
        // renderer owns preferences and passes them through MEMFS profiles).
        // The client forwards globalThis.ORCA_LOG_LEVEL here so the boost::log
        // severity filter is controllable from JS (doc/2026-08-21-wasm-boost-log.md).
        json opts = json::object();
        if (options_json && *options_json) {
            try { opts = json::parse(options_json); }
            catch (...) { /* malformed options: keep defaults */ }
        }
        std::string log_level;
        if (opts.is_object() && opts.contains("log_level") &&
            opts["log_level"].is_string())
            log_level = opts["log_level"].get<std::string>();
        wasm_log::init_with_level(log_level);

        const char* result = init_with_app_config(json::object());
        reset_plate_session_state();
        state().project_config_overlay = empty_project_config_overlay();
        state().history.clear();
        state().active_history_transaction.reset();
        state().nested_history_transactions.clear();
        state().history_disabled = false;
        state().next_filament_colour_index = 0;
        state().history_revision++;
        // First bridge log record — proves the sink pipeline end-to-end
        // (console + /tmp/orca.log).
        BOOST_LOG_TRIVIAL(info) << "orc_init: bridge ready, log level "
            << (log_level.empty() ? "info (default)" : log_level);
        return result;
    } catch (const std::exception& e) {
        // Error-path diagnostics only: these catch blocks are compiled in
        // (target_compile_options -fexceptions on orca_slice; emcc's default
        // -fignore-exceptions would compile them out entirely) and fire only
        // when init genuinely failed — never on the happy path.
        fprintf(stderr, "orc_init caught std::exception: %s\n", e.what());
        return error_json(e.what());
    } catch (...) {
        // Non-std throw: never let a C++ exception cross the extern "C" seam
        // (it would surface in JS as an uncatchable CppException crash).
        fprintf(stderr, "orc_init caught (...) via catch-all\n");
        return error_json("unknown C++ exception");
    }
}

// ---- Worker-owned project history transaction protocol ------------------
// These calls are intentionally independent of 3MF persistence.  The core
// tracks compact fingerprints/context bytes and retains native restore state
// through the same budgeted ProjectHistory entries.
EMSCRIPTEN_KEEPALIVE const char* orc_history_begin(const char* label_cstr,
                                                   const char* category_cstr,
                                                   const char* before_context_cstr,
                                                   const char* options_cstr) {
    try {
        if (state().history_disabled) return error_json("history is disabled");
        const std::string label = label_cstr ? label_cstr : "";
        const std::string category = category_cstr ? category_cstr : "";
        if (label.empty()) return error_json("history label is required");
        if (category != "project" && category != "context")
            return error_json("history category must be project or context");
        const json before_context = canonical_history_context(parse_history_context(before_context_cstr));
        json options = json::object();
        if (options_cstr && *options_cstr) options = json::parse(options_cstr);
        const bool coalesce = options.is_object() && options.value("coalesce", false);
        const std::string parent_id = options.is_object() && options.contains("parentTransactionId") &&
            options["parentTransactionId"].is_string() ? options["parentTransactionId"].get<std::string>() : std::string{};
        if (state().active_history_transaction) {
            const std::string parent_target = state().nested_history_transactions.empty()
                ? state().active_history_transaction->id : state().nested_history_transactions.back().id;
            if (!coalesce || parent_id != parent_target)
                return error_json("history transaction is already active");
            const std::string id = std::string("tx-") + std::to_string(state().next_history_transaction_id++);
            state().nested_history_transactions.push_back({
                id, label, category == "project" ? Neo::History::Category::Project : Neo::History::Category::Context,
                before_context, Neo::History::Codec::capture_model_state(state().model), true,
                parent_target});
            return dup_json(json{{"ok", true}, {"transactionId", id}, {"status", history_status_json()}}.dump());
        }
        if (state().history.entries().empty()) {
            const std::string context_text = before_context.dump();
            state().history.commit("", Neo::History::Category::Project,
                                   Neo::History::Codec::capture_model_state(state().model),
                                   Neo::History::Bytes(context_text.begin(), context_text.end()));
        }
        const std::string id = std::string("tx-") + std::to_string(state().next_history_transaction_id++);
        state().active_history_transaction = BridgeState::HistoryTransaction{
            id, label, category == "project" ? Neo::History::Category::Project : Neo::History::Category::Context,
            before_context, Neo::History::Codec::capture_model_state(state().model), false, {}};
        return dup_json(json{{"ok", true}, {"transactionId", id}, {"status", history_status_json()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_commit(const char* transaction_id_cstr,
                                                    const char* after_context_cstr) {
    try {
        if (state().history_disabled) return error_json("history is disabled");
        const std::string requested = transaction_id_cstr ? transaction_id_cstr : "";
        if (!state().active_history_transaction)
            return error_json("history transaction is not active");
        if (!state().nested_history_transactions.empty()) {
            auto& nested = state().nested_history_transactions.back();
            if (requested != nested.id)
                return error_json("history transaction is stale or belongs to another writer");
            // A coalesced child intentionally publishes no independent entry;
            // its outer transaction owns the final semantic snapshot.
            state().nested_history_transactions.pop_back();
            return dup_json(history_status_json().dump());
        }
        if (requested != state().active_history_transaction->id)
            return error_json("history transaction is stale or belongs to another writer");
        const json after_context = canonical_history_context(parse_history_context(after_context_cstr));
        const auto tx = *state().active_history_transaction;
        const std::string context_text = after_context.dump();
        const Neo::History::Bytes context_bytes(context_text.begin(), context_text.end());
        const bool changed = state().history.commit(tx.label, tx.category,
                                                     Neo::History::Codec::capture_model_state(state().model), context_bytes);
        if (changed) state().history_revision++;
        state().active_history_transaction.reset();
        state().nested_history_transactions.clear();
        return dup_json(history_status_json().dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_abort(const char* transaction_id_cstr) {
    try {
        const std::string requested = transaction_id_cstr ? transaction_id_cstr : "";
        if (!state().active_history_transaction)
            return error_json("history transaction is not active");
        if (!state().nested_history_transactions.empty()) {
            auto tx = state().nested_history_transactions.back();
            if (requested != tx.id)
                return error_json("history transaction is stale or belongs to another writer");
            restore_history_transaction_state(tx.before_context, tx.before_model);
            state().nested_history_transactions.pop_back();
            state().print.clear();
            invalidate_preview_source();
            state().history_revision++;
            return dup_json(json{{"ok", true}, {"context", tx.before_context},
                                 {"status", history_status_json()}}.dump());
        }
        if (requested != state().active_history_transaction->id)
            return error_json("history transaction is stale or belongs to another writer");
        const auto tx = *state().active_history_transaction;
        restore_history_transaction_state(tx.before_context, tx.before_model);
        state().print.clear();
        invalidate_preview_source();
        state().active_history_transaction.reset();
        state().nested_history_transactions.clear();
        state().history_revision++;
        return dup_json(json{{"ok", true}, {"context", tx.before_context},
                             {"status", history_status_json()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_undo() {
    try {
        if (state().history_disabled) return error_json("history is disabled");
        if (state().active_history_transaction) return error_json("history transaction is active");
        Neo::History::RestorePlan plan;
        if (!state().history.prepare_undo(plan)) return error_json("no undo history");
        return dup_json(history_restore_result(plan).dump());
    } catch (const std::exception& e) { return history_restore_failure(e.what()); }
    catch (...) { return history_restore_failure("unknown C++ exception"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_redo() {
    try {
        if (state().history_disabled) return error_json("history is disabled");
        if (state().active_history_transaction) return error_json("history transaction is active");
        Neo::History::RestorePlan plan;
        if (!state().history.prepare_redo(plan)) return error_json("no redo history");
        return dup_json(history_restore_result(plan).dump());
    } catch (const std::exception& e) { return history_restore_failure(e.what()); }
    catch (...) { return history_restore_failure("unknown C++ exception"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_jump(const char* entry_id_cstr, const char* direction_cstr) {
    try {
        if (state().history_disabled) return error_json("history is disabled");
        if (state().active_history_transaction) return error_json("history transaction is active");
        std::uint64_t entry_id = 0;
        if (!parse_history_entry_id(entry_id_cstr, entry_id)) return error_json("invalid history entry id");
        Neo::History::JumpDirection direction;
        if (!parse_history_jump_direction(direction_cstr, direction)) return error_json("invalid history jump direction");
        Neo::History::RestorePlan plan;
        if (!state().history.prepare_jump(entry_id, direction, plan)) return error_json("history entry is stale, unavailable, or outside the requested direction");
        return dup_json(history_restore_result(plan).dump());
    } catch (const std::exception& e) { return history_restore_failure(e.what()); }
    catch (...) { return history_restore_failure("unknown C++ exception"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_status() {
    try { return dup_json(history_status_json().dump()); }
    catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
}

// Kept separate from history_status_json(): transaction rollback fixtures
// compare the public status byte-for-byte. This diagnostic is test-only
// evidence that history restores stay on the minimal mutable-state path.
EMSCRIPTEN_KEEPALIVE const char* orc_history_restore_diagnostics() {
    return dup_json(Neo::Bridge::HistoryMetadata::restore_diagnostics_json(state()).dump());
}

// Project replacement is a hard history boundary.  The caller supplies the
// freshly projected React context after the native model has been replaced;
// the new model becomes one clean baseline and the old stack/checkpoint are
// released together.  History metadata never enters the 3MF archive.
EMSCRIPTEN_KEEPALIVE const char* orc_history_reset(const char* context_cstr) {
    try {
        const json context = canonical_history_context(parse_history_context(context_cstr));
        state().history.clear();
        state().active_history_transaction.reset();
        state().history_disabled = false;
        const std::string context_text = context.dump();
        const Neo::History::Bytes context_bytes(context_text.begin(), context_text.end());
        if (!state().history.commit("", Neo::History::Category::Project,
                                    Neo::History::Codec::capture_model_state(state().model), context_bytes))
            return error_json("could not establish history baseline");
        state().history.mark_current_as_saved();
        state().history_revision++;
        return dup_json(history_status_json().dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
}

// Save and Save As only advance the checkpoint; they do not clear retained
// model/context entries, so Undo/Redo remains usable after a successful save.
EMSCRIPTEN_KEEPALIVE const char* orc_history_mark_saved(const char* context_cstr) {
    try {
        if (state().history.entries().empty() && context_cstr && *context_cstr) {
            const json context = canonical_history_context(parse_history_context(context_cstr));
            const std::string context_text = context.dump();
            const Neo::History::Bytes context_bytes(context_text.begin(), context_text.end());
            if (!state().history.commit("", Neo::History::Category::Project,
                                        Neo::History::Codec::capture_model_state(state().model), context_bytes))
                return error_json("could not establish history baseline");
        }
        state().history.mark_current_as_saved();
        return dup_json(history_status_json().dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_record_context(const char* label_cstr,
                                                            const char* context_cstr) {
    try {
        if (state().history_disabled) return error_json("history is disabled");
        if (state().active_history_transaction)
            return error_json("history transaction is active");
        const std::string label = label_cstr ? label_cstr : "";
        if (label.empty()) return error_json("history label is required");
        const json context = canonical_history_context(parse_history_context(context_cstr));
        record_history_context(label, context);
        return dup_json(history_status_json().dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
}

// Headless plate-session commands. Every successful mutation returns one
// coherent snapshot and the complete set of world transforms changed by grid
// reflow. The frontend never derives membership, origins, or reflow deltas.
EMSCRIPTEN_KEEPALIVE const char* orc_get_plate_session_snapshot() {
    try {
        return dup_json(plate_session_snapshot_json().dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Harness-only fixture seam.  This is intentionally not declared by
// SlicerClient: it injects imported per-plate vectors/sequences and custom
// events so the native command boundary can prove rejection/remapping without
// manufacturing a desktop 3MF archive.  It does not create history entries.
EMSCRIPTEN_KEEPALIVE const char* orc_test_set_filament_reference_fixture(const char* request_cstr) {
    try {
        const json request = request_cstr && *request_cstr ? json::parse(request_cstr) : json::object();
        ensure_plate_session_state();
        if (request.contains("plate_settings")) {
            if (!request["plate_settings"].is_object()) return error_json("invalid test plate settings");
            for (auto& plate : state().plate_session_plates) {
                auto it = request["plate_settings"].find(plate.id);
                if (it == request["plate_settings"].end()) continue;
                if (!it.value().is_object()) return error_json("invalid test plate settings");
                apply_overlay_to_config(plate.settings, it.value());
                plate.settings_metadata = config_metadata_json(plate.settings);
            }
        }
        if (request.contains("custom_gcodes")) {
            if (!request["custom_gcodes"].is_array()) return error_json("invalid test custom gcodes");
            state().model.plates_custom_gcodes.clear();
            for (const auto& record : request["custom_gcodes"]) {
                if (!record.is_object() || !record.contains("plate") || !record["plate"].is_number_integer() ||
                    !record.contains("mode") || !record["mode"].is_string() ||
                    !record.contains("items") || !record["items"].is_array())
                    return error_json("invalid test custom gcode record");
                CustomGCode::Info info;
                const std::string mode = record["mode"].get<std::string>();
                info.mode = mode == "MultiExtruder" ? CustomGCode::MultiExtruder
                    : mode == "MultiAsSingle" ? CustomGCode::MultiAsSingle : CustomGCode::SingleExtruder;
                for (const auto& item : record["items"]) {
                    if (!item.is_object() || !item.contains("print_z") || !item["print_z"].is_number() ||
                        !item.contains("extruder") || !item["extruder"].is_number_integer())
                        return error_json("invalid test custom gcode item");
                    CustomGCode::Item event;
                    event.print_z = item["print_z"].get<double>();
                    event.type = CustomGCode::ToolChange;
                    event.extruder = item["extruder"].get<int>();
                    event.color = item.value("color", std::string{});
                    event.extra = item.value("extra", std::string{});
                    info.gcodes.push_back(std::move(event));
                }
                state().model.plates_custom_gcodes[record["plate"].get<int>()] = std::move(info);
            }
        }
        json custom = json::array();
        for (const auto& [plate, info] : state().model.plates_custom_gcodes) {
            for (const auto& item : info.gcodes)
                custom.push_back({{"plate", plate}, {"extruder", item.extruder}, {"print_z", item.print_z}});
        }
        return dup_json(json{{"ok", true}, {"plate_session", plate_session_snapshot_json()}, {"custom_gcodes", custom}}.dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown test fixture failure"); }
}

// Harness-only flush fixture.  It exercises the native per-nozzle minimum
// flush calculation with explicit cutter/retraction inputs; this seam is not
// part of SlicerClient and is intentionally absent from the public ABI types.
EMSCRIPTEN_KEEPALIVE const char* orc_test_set_filament_flush_fixture(const char* request_cstr) {
    try {
        const json request = request_cstr && *request_cstr ? json::parse(request_cstr) : json::object();
        if (!request.is_object()) return error_json("invalid test flush fixture");
        state().presets.update_multi_material_filament_presets();
        auto& printer = state().presets.printers.get_edited_preset().config;
        auto& project = state().presets.project_config;
        const auto filament_count = state().presets.filament_presets.size();
        auto* fixture_colours = project.option<ConfigOptionStrings>("filament_colour", true);
        fixture_colours->values.resize(filament_count, "#26A69A");
        for (std::size_t index = 0; index < filament_count; ++index)
            fixture_colours->values[index] = index % 2 == 0 ? "#FF0000" : "#00FF00";
        if (auto* multi = project.option<ConfigOptionStrings>("filament_multi_colour", true))
            multi->values = fixture_colours->values;
        for (const auto& name : state().presets.filament_presets) {
            if (auto* preset = state().presets.filaments.find_preset(name, true, true)) {
                auto* colours = preset->config.option<ConfigOptionStrings>("filament_colour", true);
                colours->values.resize(filament_count, "#26A69A");
                for (std::size_t index = 0; index < filament_count; ++index)
                    colours->values[index] = index % 2 == 0 ? "#FF0000" : "#00FF00";
                if (auto* multi = preset->config.option<ConfigOptionStrings>("filament_multi_colour", true))
                    multi->values = colours->values;
            }
        }
        const auto read_floats = [](const json& value, const char* name) {
            if (!value.is_array()) throw std::runtime_error(std::string("invalid test flush ") + name);
            std::vector<double> result;
            result.reserve(value.size());
            for (const auto& item : value) {
                if (item.is_null()) result.push_back(std::numeric_limits<double>::quiet_NaN());
                else if (item.is_number()) result.push_back(item.get<double>());
                else throw std::runtime_error(std::string("invalid test flush ") + name);
            }
            return result;
        };
        const auto read_bools = [](const json& value, const char* name) {
            if (!value.is_array() || !std::all_of(value.begin(), value.end(), [](const json& item) {
                    return item.is_boolean() || item.is_number_integer(); }))
                throw std::runtime_error(std::string("invalid test flush ") + name);
            std::vector<unsigned char> result;
            result.reserve(value.size());
            for (const auto& item : value) result.push_back(static_cast<unsigned char>(item.get<int>() != 0));
            return result;
        };
        DynamicPrintConfig synthetic_full = state().presets.full_config();
        if (request.contains("nozzle_volume"))
            synthetic_full.option<ConfigOptionFloatsNullable>("nozzle_volume", true)->values = read_floats(request["nozzle_volume"], "nozzle_volume");
        if (request.contains("enable_long_retraction_when_cut"))
            synthetic_full.option<ConfigOptionInt>("enable_long_retraction_when_cut", true)->value = request["enable_long_retraction_when_cut"].get<int>();
        if (request.contains("long_retractions_when_cut"))
            synthetic_full.option<ConfigOptionBools>("long_retractions_when_cut", true)->values = read_bools(request["long_retractions_when_cut"], "long_retractions_when_cut");
        if (request.contains("retraction_distances_when_cut"))
            synthetic_full.option<ConfigOptionFloats>("retraction_distances_when_cut", true)->values = read_floats(request["retraction_distances_when_cut"], "retraction_distances_when_cut");
        if (request.contains("filament_diameter"))
            synthetic_full.option<ConfigOptionFloats>("filament_diameter", true)->values = read_floats(request["filament_diameter"], "filament_diameter");
        if (request.contains("filament_long_retractions_when_cut"))
            synthetic_full.option<ConfigOptionBoolsNullable>("filament_long_retractions_when_cut", true)->values = read_bools(request["filament_long_retractions_when_cut"], "filament_long_retractions_when_cut");
        if (request.contains("filament_retraction_distances_when_cut"))
            synthetic_full.option<ConfigOptionFloatsNullable>("filament_retraction_distances_when_cut", true)->values = read_floats(request["filament_retraction_distances_when_cut"], "filament_retraction_distances_when_cut");
        const auto set_floats = [&](const char* key, const std::vector<double>& values) {
            printer.option<ConfigOptionFloats>(key, true)->values = values;
            project.option<ConfigOptionFloats>(key, true)->values = values;
        };
        const auto set_nullable_floats = [&](const char* key, const std::vector<double>& values) {
            printer.option<ConfigOptionFloatsNullable>(key, true)->values = values;
            project.option<ConfigOptionFloatsNullable>(key, true)->values = values;
        };
        const auto set_bools = [&](const char* key, const std::vector<unsigned char>& values) {
            printer.option<ConfigOptionBools>(key, true)->values = values;
            project.option<ConfigOptionBools>(key, true)->values = values;
        };
        const auto set_int = [&](const char* key, const int value) {
            printer.option<ConfigOptionInt>(key, true)->value = value;
            project.option<ConfigOptionInt>(key, true)->value = value;
        };
        const auto set_filament_floats = [&](const char* key, const std::vector<double>& values) {
            for (const auto& name : state().presets.filament_presets)
                if (auto* preset = state().presets.filaments.find_preset(name, true, true))
                    preset->config.option<ConfigOptionFloatsNullable>(key, true)->values = values;
        };
        const auto set_filament_bools = [&](const char* key, const std::vector<unsigned char>& values) {
            for (const auto& name : state().presets.filament_presets)
                if (auto* preset = state().presets.filaments.find_preset(name, true, true))
                    preset->config.option<ConfigOptionBoolsNullable>(key, true)->values = values;
        };
        if (request.contains("nozzle_volume"))
            set_nullable_floats("nozzle_volume", read_floats(request["nozzle_volume"], "nozzle_volume"));
        if (request.contains("enable_long_retraction_when_cut"))
            set_int("enable_long_retraction_when_cut", request["enable_long_retraction_when_cut"].get<int>());
        if (request.contains("long_retractions_when_cut"))
            set_bools("long_retractions_when_cut", read_bools(request["long_retractions_when_cut"], "long_retractions_when_cut"));
        if (request.contains("retraction_distances_when_cut"))
            set_floats("retraction_distances_when_cut", read_floats(request["retraction_distances_when_cut"], "retraction_distances_when_cut"));
        if (request.contains("nozzle_flush_dataset"))
            printer.option<ConfigOptionIntsNullable>("nozzle_flush_dataset", true)->values = request["nozzle_flush_dataset"].get<std::vector<int>>();
        if (request.contains("flush_multiplier"))
            set_floats("flush_multiplier", read_floats(request["flush_multiplier"], "flush_multiplier"));
        if (request.contains("filament_diameter"))
            set_floats("filament_diameter", read_floats(request["filament_diameter"], "filament_diameter"));
        if (request.contains("filament_long_retractions_when_cut"))
            set_filament_bools("filament_long_retractions_when_cut", read_bools(request["filament_long_retractions_when_cut"], "filament_long_retractions_when_cut"));
        if (request.contains("filament_retraction_distances_when_cut"))
            set_filament_floats("filament_retraction_distances_when_cut", read_floats(request["filament_retraction_distances_when_cut"], "filament_retraction_distances_when_cut"));
        recalculate_filament_flush(state().presets);
        // Test-only imported-project seam: install a complete native matrix
        // after the native calculation so the next read proves load-time
        // preservation.  The first real flushing mutation must replace it.
        if (request.contains("imported_matrix")) {
            const auto imported = read_floats(request["imported_matrix"], "imported_matrix");
            const std::size_t count = state().presets.filament_presets.size();
            const std::size_t planes = static_cast<std::size_t>(std::max(1, state().presets.get_printer_extruder_count()));
            if (imported.size() != count * count * planes)
                return error_json("invalid imported flush matrix size");
            state().presets.project_config.option<ConfigOptionFloats>("flush_volumes_matrix", true)->values = imported;
        }
        return dup_json(json{{"ok", true}, {"snapshot", filament_session_snapshot_json()},
            {"min_flush_volumes", min_flush_volumes_for_config(synthetic_full,
                state().presets.filament_presets.size(),
                std::max(1, state().presets.get_printer_extruder_count()))}}.dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown test flush fixture failure"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_filament_session_snapshot() {
    try {
        return dup_json(filament_session_snapshot_json().dump());
    } catch (const std::exception& e) {
        return dup_json(filament_session_error_json("native_exception", e.what()).dump());
    } catch (...) {
        return dup_json(filament_session_error_json("unknown_exception", "unknown C++ exception").dump());
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_select_filament_slot_preset(const char* request_json) {
    try { return dup_json(filament_select_slot_preset_command(
        request_json && *request_json ? json::parse(request_json) : json::object()).dump()); }
    catch (const std::exception& e) { return dup_json(filament_command_error("invalid_command", e.what()).dump()); }
    catch (...) { return dup_json(filament_command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_filament_slot_colour(const char* request_json) {
    try { return dup_json(filament_set_colour_command(
        request_json && *request_json ? json::parse(request_json) : json::object()).dump()); }
    catch (const std::exception& e) { return dup_json(filament_command_error("invalid_command", e.what()).dump()); }
    catch (...) { return dup_json(filament_command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_add_filament_slot(const char* request_json) {
    try { return dup_json(filament_add_command(
        request_json && *request_json ? json::parse(request_json) : json::object()).dump()); }
    catch (const std::exception& e) { return dup_json(filament_command_error("invalid_command", e.what()).dump()); }
    catch (...) { return dup_json(filament_command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_delete_filament_slot(const char* request_json) {
    try { return dup_json(filament_delete_or_merge_command(
        request_json && *request_json ? json::parse(request_json) : json::object(), false).dump()); }
    catch (const std::exception& e) { return dup_json(filament_command_error("invalid_command", e.what()).dump()); }
    catch (...) { return dup_json(filament_command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_merge_filament_slots(const char* request_json) {
    try { return dup_json(filament_delete_or_merge_command(
        request_json && *request_json ? json::parse(request_json) : json::object(), true).dump()); }
    catch (const std::exception& e) { return dup_json(filament_command_error("invalid_command", e.what()).dump()); }
    catch (...) { return dup_json(filament_command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_assign_filament(const char* request_json) {
    try { return dup_json(filament_assign_command(
        request_json && *request_json ? json::parse(request_json) : json::object()).dump()); }
    catch (const std::exception& e) { return dup_json(filament_command_error("invalid_command", e.what()).dump()); }
    catch (...) { return dup_json(filament_command_error("invalid_command", "invalid filament assignment command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_filament_routing(const char* request_json) {
    try { return dup_json(filament_routing_command(
        request_json && *request_json ? json::parse(request_json) : json::object()).dump()); }
    catch (const std::exception& e) { return dup_json(filament_command_error("invalid_command", e.what()).dump()); }
    catch (...) { return dup_json(filament_command_error("invalid_command", "invalid filament routing command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_reset_plate_session() {
    try {
        reset_plate_session_state();
        return dup_json(plate_session_snapshot_json().dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_select_plate(const char* plate_id_cstr) {
    try {
        ensure_plate_session_state();
        const std::string requested = plate_id_cstr ? plate_id_cstr : "";
        if (requested.empty()) return error_json("plateId is required");
        if (find_plate(requested) == nullptr)
            return error_json("plate not found");
        state().current_plate_id = requested;
        record_active_plate_context();
        return dup_json(plate_session_snapshot_json().dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_add_plate() {
    try {
        ensure_plate_session_state();
        if (state().plate_session_plates.size() >= static_cast<size_t>(kMaxPlateCount))
            return error_json("maximum of 36 plates");
        // Editing commands may have changed instance transforms since the
        // last explicit membership read. Refresh from the live native model
        // before computing grid deltas; parked instances remain parked.
        rebuild_plate_membership(false);
        const auto affected_before = member_plate_ids();
        const PlateBounds bounds = selected_plate_bounds();
        const auto old_plates = state().plate_session_plates;
        const int new_count = static_cast<int>(old_plates.size()) + 1;
        std::map<std::size_t, Vec3d> changed;
        for (size_t index = 0; index < old_plates.size(); ++index) {
            const Vec3d delta = plate_origin_for_index(static_cast<int>(index), new_count, bounds) - old_plates[index].origin;
            if (delta == Vec3d::Zero()) continue;
            for (const auto& [instance_id, plate_id] : state().instance_plate_ids) {
                if (plate_id != old_plates[index].id) continue;
                for (const auto& ref : plate_instance_refs()) {
                    if (ref.instance_id == instance_id) {
                        translate_instance(ref, delta);
                        changed[instance_id] = delta;
                        break;
                    }
                }
            }
        }
        const auto sequence = g_plate_id_sequence.fetch_add(1, std::memory_order_relaxed) + 1;
        const std::string id = "plate-session-plate-" + std::to_string(sequence);
        state().plate_session_plates.push_back({id, "Plate " + std::to_string(new_count), new_count - 1,
                                                plate_origin_for_index(new_count - 1, new_count, bounds)});
        state().plate_input_revisions[id] = 0;
        for (size_t index = 0; index < state().plate_session_plates.size(); ++index) {
            auto& plate = state().plate_session_plates[index];
            plate.display_index = static_cast<int>(index);
            plate.origin = plate_origin_for_index(static_cast<int>(index), new_count, bounds);
        }
        state().current_plate_id = id;
        // Existing memberships remain valid because reflow preserves each
        // instance's local coordinates. New/previously unprintable instances
        // are intentionally not auto-arranged here.
        const auto mutation = plate_mutation_snapshot(affected_before, {"plate-structure"},
                                                       reflow_instance_transforms(changed));
        return dup_json(mutation.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_delete_plate(const char* plate_id_cstr) {
    try {
        ensure_plate_session_state();
        const std::string requested = plate_id_cstr ? plate_id_cstr : "";
        if (requested.empty()) return error_json("plateId is required");
        const auto it = std::find_if(state().plate_session_plates.begin(), state().plate_session_plates.end(),
                                     [&](const auto& plate) { return plate.id == requested; });
        if (it == state().plate_session_plates.end()) return error_json("plate not found");
        if (state().plate_session_plates.size() <= 1) return error_json("at least one plate must remain");
        // Resolve ownership from current convex hulls before moving or
        // parking objects. This covers transforms applied without an
        // intervening recompute command while retaining parked semantics.
        rebuild_plate_membership(false);
        const auto affected_before = member_plate_ids();
        const PlateBounds bounds = selected_plate_bounds();
        const size_t deleted_index = static_cast<size_t>(std::distance(state().plate_session_plates.begin(), it));
        const auto old_plates = state().plate_session_plates;
        const bool deleting_current = state().current_plate_id == requested;
        const int new_count = static_cast<int>(old_plates.size()) - 1;
        std::map<std::size_t, Vec3d> changed;
        const Vec3d parking_origin = parked_origin_for_count(new_count, bounds);
        const Vec3d deleted_delta = parking_origin - old_plates[deleted_index].origin;
        std::vector<std::size_t> deleted_instances;
        for (const auto& [instance_id, plate_id] : state().instance_plate_ids)
            if (plate_id == requested) deleted_instances.push_back(instance_id);
        for (const std::size_t instance_id : deleted_instances) {
            for (const auto& ref : plate_instance_refs()) {
                if (ref.instance_id == instance_id) {
                    translate_instance(ref, deleted_delta);
                    changed[instance_id] = deleted_delta;
                    state().instance_plate_ids.erase(instance_id);
                    state().parked_instance_ids.insert(instance_id);
                    break;
                }
            }
        }
        state().plate_session_plates.erase(state().plate_session_plates.begin() + static_cast<std::ptrdiff_t>(deleted_index));
        state().plate_input_revisions.erase(requested);
        for (size_t index = 0; index < state().plate_session_plates.size(); ++index) {
            auto& plate = state().plate_session_plates[index];
            const Vec3d new_origin = plate_origin_for_index(static_cast<int>(index), new_count, bounds);
            const Vec3d delta = new_origin - old_plates[index < deleted_index ? index : index + 1].origin;
            if (delta != Vec3d::Zero()) {
                for (const auto& [instance_id, plate_id] : state().instance_plate_ids) {
                    if (plate_id != plate.id) continue;
                    for (const auto& ref : plate_instance_refs()) {
                        if (ref.instance_id == instance_id) {
                            translate_instance(ref, delta);
                            changed[instance_id] = delta;
                            break;
                        }
                    }
                }
            }
            plate.display_index = static_cast<int>(index);
            plate.origin = new_origin;
        }
        if (deleting_current) {
            const size_t selected_index = std::min(deleted_index, state().plate_session_plates.size() - 1);
            state().current_plate_id = state().plate_session_plates[selected_index].id;
        }
        // Deletion deliberately does not recompute the parked objects: they
        // remain unprintable until a later editing/recompute operation.
        const auto mutation = plate_mutation_snapshot(affected_before, {"plate-structure"},
                                                       reflow_instance_transforms(changed));
        return dup_json(mutation.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_recompute_plate_membership() {
    try {
        const auto affected_instances = state().pending_membership_instance_ids;
        const auto affected_before = affected_instances.empty()
            ? std::set<std::string>{}
            : member_plate_ids_for_instances(affected_instances);
        rebuild_plate_membership(true);
        const auto mutation = plate_mutation_snapshot(affected_before, {"model-transform"},
                                                       json::array(), &affected_instances);
        state().pending_membership_instance_ids.clear();
        return dup_json(mutation.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_mark_shared_configuration_mutation() {
    try {
        ensure_plate_session_state();
        return dup_json(shared_configuration_mutation_snapshot().dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_project_config_overlay() {
    try {
        return dup_json(project_config_overlay_result().dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_project_config_override(const char* scope_cstr,
                                                                  const char* id_cstr,
                                                                  const char* option_key_cstr,
                                                                  const char* value_cstr) {
    try {
        ensure_plate_session_state();
        const std::string scope = scope_cstr ? scope_cstr : "";
        const std::string id = id_cstr ? id_cstr : "";
        const std::string key = option_key_cstr ? option_key_cstr : "";
        const std::string value = value_cstr ? value_cstr : "";
        const auto configuration_error = [](const std::string& code, const std::string& message) {
            return native_configuration_error_json(code, message);
        };
        if (scope != "project" && scope != "object" && scope != "part" && scope != "plate")
            return configuration_error("invalid_command", "invalid project configuration scope");
        if (key.empty()) return configuration_error("invalid_command", "option key is required");
        if (print_config_def.options.find(key) == print_config_def.options.end())
            return configuration_error("unsupported_reference", "unsupported project configuration option: " + key);
        if (scope != "project" && id.empty()) return configuration_error("invalid_command", "scope id is required");
        // The first-release prime-tower position is intentionally per plate;
        // exposing a plate override for any other option would make its
        // invalidation semantics ambiguous.  The shared enable/width values
        // stay project-scoped and use the existing shared mutation path.
        if (scope == "plate" && key != "wipe_tower_x" && key != "wipe_tower_y")
            return configuration_error("unsupported_reference", "only prime tower X/Y are supported at plate scope");
        ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
        DynamicPrintConfig project_candidate;
        std::optional<json> configuration_status;
        std::string effective_value;
        const auto effective_for = [&key](const auto& config) {
            const ConfigOption* option = config.option(key);
            if (option == nullptr) throw BadOptionValueException("native option is unavailable: " + key);
            return option->serialize();
        };
        if (scope == "project") {
            project_candidate = state().presets.project_config;
            apply_overlay_to_config(project_candidate, state().project_config_overlay["project"]);
            project_candidate.set_deserialize(key, value, substitutions);
            configuration_status = native_configuration_status(project_candidate, key, value);
            effective_value = effective_for(project_candidate);
        } else if (scope == "object") {
            auto* object = find_object_by_id(static_cast<std::size_t>(std::stoull(id)));
            if (!object) return configuration_error("unsupported_reference", "object not found");
            DynamicPrintConfig candidate = object->config.get();
            candidate.set_deserialize(key, value, substitutions);
            configuration_status = native_configuration_status(candidate, key, value);
            effective_value = effective_for(candidate);
            object->config.assign_config(candidate);
        } else if (scope == "part") {
            auto* volume = find_volume_by_id(static_cast<std::size_t>(std::stoull(id)));
            if (!volume) return configuration_error("unsupported_reference", "part not found");
            DynamicPrintConfig candidate = volume->config.get();
            candidate.set_deserialize(key, value, substitutions);
            configuration_status = native_configuration_status(candidate, key, value);
            effective_value = effective_for(candidate);
            volume->config.assign_config(candidate);
        } else if (scope == "plate") {
            auto* plate = const_cast<BridgeState::PlateSessionPlate*>(find_plate(id));
            if (!plate) return configuration_error("unsupported_reference", "plate not found");
            DynamicPrintConfig candidate = plate->settings;
            candidate.set_deserialize(key, value, substitutions);
            configuration_status = native_configuration_status(candidate, key, value);
            effective_value = effective_for(candidate);
            plate->settings = std::move(candidate);
            plate->settings_metadata = config_metadata_json(plate->settings);
        }
        json& bucket = scope == "project" ? state().project_config_overlay["project"]
            : scope == "object" ? state().project_config_overlay["objects"][id]
            : scope == "part" ? state().project_config_overlay["parts"][id]
            : state().project_config_overlay["plates"][id];
        bucket[key] = effective_value;
        const auto mutation = scope == "plate"
            ? plate_configuration_mutation_snapshot(id, "prime-tower-position")
            : shared_configuration_mutation_snapshot();
        json result = project_config_overlay_result();
        result["plate_session"] = mutation;
        if (configuration_status.has_value()) result["configuration_status"] = *configuration_status;
        return dup_json(result.dump());
    } catch (const BadOptionValueException& e) {
        return native_configuration_error_json("native_validation_failure", e.what());
    } catch (const std::exception& e) { return native_configuration_error_json("native_validation_failure", e.what()); }
    catch (...) { return native_configuration_error_json("native_validation_failure", "unknown C++ exception"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_revalidate_project_config_overlay() {
    try {
        // Revalidation is deliberately conservative: retain only keys known
        // by the current PrintConfig definition. Values are checked again at
        // slice time against the selected base preset and invalid values are
        // ignored without destroying the rest of the project overlay.
        for (const char* scope : {"project", "objects", "parts", "plates"}) {
            auto& values = state().project_config_overlay[scope];
            for (auto it = values.begin(); it != values.end();) {
                if (scope == std::string("project")) {
                    if (print_config_def.options.find(it.key()) == print_config_def.options.end()) it = values.erase(it);
                    else ++it;
                } else {
                    if (!it.value().is_object()) { it = values.erase(it); continue; }
                    for (auto option = it.value().begin(); option != it.value().end();) {
                        if (!option.value().is_string() || print_config_def.options.find(option.key()) == print_config_def.options.end()) option = it.value().erase(option);
                        else ++option;
                    }
                    ++it;
                }
            }
        }
        return dup_json(project_config_overlay_result().dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
}

// Read one atomic, picker-ready compatibility state. It contains only
// candidates the current strict-hide UI may render: visible printers, then
// visible-and-compatible FFF print and filament presets. Callers must replace
// all three lists and selections from this single response.
EMSCRIPTEN_KEEPALIVE const char* orc_get_preset_snapshot() {
    try {
        return dup_json(preset_snapshot_json().dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// The selection guard deliberately lives here as well as in the UI: stale UI
// state or another caller must not construct an invalid compatibility tuple.
EMSCRIPTEN_KEEPALIVE const char* orc_select_preset(const char* kind_cstr, const char* name_cstr) {
    try {
        const std::string kind = kind_cstr ? kind_cstr : "";
        const std::string name = name_cstr ? name_cstr : "";
        if (name.empty()) return error_json("preset name required");
        PresetCollection* coll = nullptr;
        if (kind == "print")        coll = &state().presets.prints;
        else if (kind == "printer") coll = &state().presets.printers;
        else return error_json("kind must be print|printer");
        Preset* requested = coll->find_preset(name);
        if (requested == nullptr)
            return error_json("preset not found: " + name);
        if (!requested->is_visible)
            return error_json("preset is not visible: " + name);
        // A printer has no compatibility context. Process names must already
        // be candidates for the current engine-resolved printer.
        if (kind != "printer" && !requested->is_compatible)
            return error_json("preset is incompatible: " + name);
        if (!coll->select_preset_by_name(name, true))
            return error_json("could not select preset: " + name);
        if (kind == "printer") {
            // OrcaSlicer's normal compatibility/fallback path.  Process is
            // resolved first, then filament against that final process.
            state().presets.update_compatible(PresetSelectCompatibleType::Always);
            state().presets.update_multi_material_filament_presets();
        } else if (kind == "print") {
            // The request was just validated as a compatible print preset, so
            // retain it while re-evaluating dependent filament compatibility.
            // The second argument selects OrcaSlicer's native filament
            // fallback when the newly active print makes it incompatible.
            state().presets.update_compatible(PresetSelectCompatibleType::Never,
                                               PresetSelectCompatibleType::Always);
            state().presets.update_multi_material_filament_presets();
        }
        return dup_json(preset_snapshot_json().dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_option_metadata() {
    try {
        // Drift at the pinned SHA: PrintConfigDef::defs() does not exist; the
        // shared definition instance is the global const PrintConfigDef
        // (PrintConfig.hpp:719), whose ConfigDef::options (Config.hpp:2589)
        // is the option map.
        const auto& defs = print_config_def.options;
        json out = json::object();
        for (const auto& [key, def] : defs)
            out[key] = option_def_to_json(def);
        return dup_json(out.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

// Model bytes arrive in the WASM heap (JS: _malloc + HEAPU8 + _free).
// Stage them to a MEMFS file so the format loaders can open a real path.
EMSCRIPTEN_KEEPALIVE const char* orc_add_model(const char* data, int len, const char* ext, const char* filename) {
    try {
        if (!data || len <= 0) return error_json("no model bytes");
        const std::string path = "/tmp/" + sanitized_model_basename(filename, ext);
        std::FILE* f = std::fopen(path.c_str(), "wb");
        if (!f) return error_json("cannot open /tmp for model upload");
        std::fwrite(data, 1, size_t(len), f);
        std::fclose(f);

        DynamicPrintConfig dummy;
        LoadStrategy model_strategy = LoadStrategy::AddDefaultInstances;
        std::string lower_ext = ext ? ext : "";
        std::transform(lower_ext.begin(), lower_ext.end(), lower_ext.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        // Model::read_from_file delegates .3mf to load_bbs_3mf.  The BBS
        // importer deliberately does nothing unless LoadModel is present;
        // Add Model remains geometry-only, but it must still request model
        // resources explicitly.
        if (lower_ext == "3mf")
            model_strategy = model_strategy | LoadStrategy::LoadModel;
        Model imported;
        if (lower_ext == "3mf") {
            // Keep Add Model on the native BBS reader, but avoid
            // Model::read_from_file's silent fallback context.  The latter
            // takes a different importer path in threaded wasm and can spin
            // while resolving a BBS archive; this explicit geometry-only
            // invocation is the same seam used by project loads.
            ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Enable};
            std::vector<PlateData*> plate_data_storage;
            std::vector<Preset*> project_presets;
            bool is_bbl_3mf = false;
            bool is_orca_3mf = false;
            Semver file_version;
            if (!load_bbs_3mf(path.c_str(), &dummy, &substitutions, &imported,
                              &plate_data_storage, &project_presets, &is_bbl_3mf,
                              &is_orca_3mf, &file_version, nullptr, model_strategy,
                              nullptr, 0))
                throw Slic3r::RuntimeError("Loading of a model file failed.");
            imported.add_default_instances();
            release_PlateData_list(plate_data_storage);
            for (Preset* preset : project_presets) delete preset;
        } else {
            imported = Model::read_from_file(path, &dummy, nullptr,
                                              model_strategy);
        }
        // The wxWidgets GUI is not compiled into the WASM build, so replicate
        // the Plater's post-load steps for non-project files (Plater.cpp
        // _load_files: per object center_around_origin(false) + ensure_on_bed
        // before the objects enter the plate): center each object's mesh
        // around the origin and rest it on the bed (min Z = 0). Without this
        // a model keeps its raw STL coordinates and its bbox center lands
        // wherever the file's own origin is — off the viewport origin. Like
        // the GUI, project files (3MF/AMF) keep their stored positions and
        // are NOT re-centered. center_around_origin shifts the volumes;
        // ensure_on_bed carries the Z drop in the instance offset
        // (auto_drop), which orc_get_model_mesh reports and the renderer
        // applies as the group position.
        {
            const bool is_project_file = lower_ext == "3mf" || lower_ext == "amf";
            if (!is_project_file) {
                for (ModelObject* o : imported.objects) {
                    o->center_around_origin(false);
                    o->ensure_on_bed(false);
                }
            }
        }
        // Preserve the current scene: only after parsing and preparing the
        // complete incoming file succeeds do we copy its objects into the
        // live Model. Model::add_object clones the object and rebinds it to
        // the destination model, so the temporary can be destroyed safely.
        const auto* current_plate = find_plate(state().current_plate_id);
        const PlateBounds placement_bounds = selected_plate_bounds();
        const Vec3d placement_center = current_plate
            ? Vec3d(current_plate->origin.x() + (placement_bounds.min_x + placement_bounds.max_x) * 0.5,
                    current_plate->origin.y() + (placement_bounds.min_y + placement_bounds.max_y) * 0.5,
                    current_plate->origin.z())
            : Vec3d::Zero();
        std::map<std::size_t, Vec3d> added_instances;
        for (const ModelObject* o : imported.objects) {
            if (lower_ext == "3mf")
                {
                    ModelObject* added = append_model_object_geometry(state().model, *o);
                    for (ModelInstance* instance : added->instances) {
                        const auto offset = instance->get_offset();
                        instance->set_offset(Vec3d(placement_center.x(), placement_center.y(), offset.z()));
                        added_instances[instance->id().id] = Vec3d::Zero();
                    }
                }
            else
                {
                    ModelObject* added = state().model.add_object(*o);
                    for (ModelInstance* instance : added->instances) {
                        const auto offset = instance->get_offset();
                        instance->set_offset(Vec3d(placement_center.x(), placement_center.y(), offset.z()));
                        added_instances[instance->id().id] = Vec3d::Zero();
                    }
                }
        }
        rebuild_plate_membership(true);
        // A model mutation makes any existing Print/G-code result stale.
        state().print.clear();
        invalidate_preview_source();
        // Drift at the pinned SHA: Model has no instance accessor — instances
        // live per-object (ModelObject::instances, Model.hpp:385; Model itself
        // only has the objects list, Model.hpp:1553-1560). Sum per object.
        size_t instance_count = 0;
        for (const ModelObject* o : state().model.objects)
            instance_count += o->instances.size();
        std::set<std::size_t> added_instance_ids;
        for (const auto& [instance_id, _] : added_instances) added_instance_ids.insert(instance_id);
        const auto mutation = plate_mutation_snapshot({}, {"model-import"},
                                                       reflow_instance_transforms(added_instances),
                                                       &added_instance_ids);
        return dup_json(attach_plate_mutation(json{{"ok", true},
                             {"objects",   state().model.objects.size()},
                             {"instances", instance_count}}, mutation).dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

// Progress transport is defined with the other bridge lifecycle helpers
// below, after the project operations. Keep declarations here so project
// loading can report its own long-running stages.
void begin_progress(std::string_view text = "Preparing slice");
void publish_slicer_progress(int percent, std::string_view text);
void finish_progress(std::string_view text = "Slice complete");
void stop_progress();

// Load a BBS 3MF into either a replacement project or an appended,
// geometry-only import.  Parsing and all candidate preset work happen against
// temporary objects first.  The live model/preset bundle is touched only
// after every required step succeeds, so malformed archives and future
// cancellation paths cannot leave a half-loaded session behind.
static const char* orc_load_project_impl(const char* data, int len,
                                          int geometry_only,
                                          const char* display_name,
                                          bool commit) {
    const std::string path = next_project_temp_path(".3mf");
    std::string load_path = path;
    const std::string project_name = display_name && *display_name ? display_name : load_path;
    std::vector<PlateData*> plate_data;
    std::vector<Preset*> project_presets;
    auto release_presets = [&]() {
        for (Preset* preset : project_presets) delete preset;
        project_presets.clear();
    };
    auto cleanup_paths = [&]() {
        remove_project_temp_path(path);
        if (load_path != path) remove_project_temp_path(load_path);
    };
    try {
        if (!data || len <= 0) {
            cleanup_paths();
            return error_json("no project bytes");
        }
        // A BBS 3MF is a ZIP archive.  Reject non-ZIP input before entering
        // minizip: malformed short buffers can otherwise make the threaded
        // reader spend an unbounded amount of time scanning for an EOCD.
        if (len < 4 || static_cast<unsigned char>(data[0]) != 0x50 ||
            static_cast<unsigned char>(data[1]) != 0x4b ||
            (static_cast<unsigned char>(data[2]) != 0x03 &&
             static_cast<unsigned char>(data[2]) != 0x05 &&
             static_cast<unsigned char>(data[2]) != 0x07) ||
            (static_cast<unsigned char>(data[3]) != 0x04 &&
             static_cast<unsigned char>(data[3]) != 0x06 &&
             static_cast<unsigned char>(data[3]) != 0x08)) {
            cleanup_paths();
            return error_json("project bytes are not a ZIP archive");
        }
        begin_progress(geometry_only ? "Preparing geometry import" : "Preparing project load");
        struct ProgressScope {
            bool completed = false;
            ~ProgressScope() { if (!completed) stop_progress(); }
        } progress_scope;
        std::FILE* file = std::fopen(path.c_str(), "wb");
        if (!file) {
            cleanup_paths();
            return error_json("cannot open temporary project path");
        }
        const std::size_t written = std::fwrite(data, 1, static_cast<std::size_t>(len), file);
        const int close_result = std::fclose(file);
        if (written != static_cast<std::size_t>(len) || close_result != 0) {
            cleanup_paths();
            return error_json("cannot stage project bytes");
        }
        publish_slicer_progress(10, "Reading project metadata");

        const auto model_config = read_archive_entry(path, "Metadata/model_settings.config");
        const auto project_settings = read_archive_entry(path, "Metadata/project_settings.config");
        const auto neo_entry = read_archive_entry(path, kNeoPlateMetadataEntry);
        const auto overlay_entry = read_archive_entry(path, kNeoConfigOverlayEntry);
        const auto filament_entry = read_archive_entry(path, kNeoFilamentStateEntry);
        std::optional<json> neo_metadata;
        std::optional<json> overlay_metadata;
        std::optional<json> filament_state_metadata;
        if (neo_entry) neo_metadata = parse_neo_plate_metadata(*neo_entry);
        if (overlay_entry) {
            const json parsed = json::parse(*overlay_entry);
            if (!parsed.is_object() || parsed.value("schema", "") != kNeoConfigOverlaySchema ||
                parsed.value("version", 0) != 1 || !valid_project_config_overlay(parsed["overlay"]))
                throw Slic3r::RuntimeError("corrupt Neo configuration overlay metadata");
            overlay_metadata = parsed["overlay"];
        }
        if (filament_entry) {
            const json parsed = json::parse(*filament_entry);
            if (!parsed.is_object() || parsed.value("schema", "") != kNeoFilamentStateSchema ||
                parsed.value("version", 0) != 1 || !parsed.contains("state"))
                throw Slic3r::RuntimeError("corrupt Neo filament state metadata");
            // The native BBS config remains authoritative for interoperability;
            // this sidecar protects Neo-only ordering/metadata during a
            // native round trip and is validated again by the client-facing
            // projection after the staged candidate is committed.
            if (!parsed["state"].is_object() || parsed["state"].value("version", 0) != 1)
                throw Slic3r::RuntimeError("corrupt Neo filament state metadata");
            filament_state_metadata = parsed["state"];
        }
        std::vector<ImportedPlateRecord> raw_records = model_config ? parse_plate_records(*model_config) : std::vector<ImportedPlateRecord>{};
        if (raw_records.size() > static_cast<size_t>(kMaxPlateCount) ||
            (neo_metadata && (*neo_metadata)["plates"].size() > static_cast<size_t>(kMaxPlateCount))) {
            cleanup_paths();
            return error_json("project contains more than 36 plates");
        }
        // The upstream reader indexes its internal map by plate_index and
        // rejects sparse indices. Normalize only the native XML copy, while
        // retaining the original record order and unknown metadata above.
        if (model_config && !raw_records.empty()) {
            const bool invalid_order = std::any_of(raw_records.begin(), raw_records.end(),
                [index = size_t{0}](const ImportedPlateRecord& record) mutable {
                    return record.source_index != static_cast<int>(++index);
                });
            if (invalid_order) {
                size_t normalized_count = 0;
                const std::string normalized = normalize_model_config_indices(*model_config, &normalized_count);
                if (normalized_count != raw_records.size()) {
                    cleanup_paths();
                    return error_json("corrupt project plate metadata");
                }
                load_path = next_project_temp_path(".normalized.3mf");
                if (!rewrite_model_config_archive(path, load_path, normalized)) {
                    cleanup_paths();
                    return error_json("could not normalize project plate metadata");
                }
            }
        }
        publish_slicer_progress(20, "Loading project model");

        DynamicPrintConfig imported_config;
        ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Enable};
        Model imported;
        bool is_bbl_3mf = false;
        bool is_orca_3mf = false;
        Semver file_version;
        // The upstream BBS parser's model-only mode is intended for the GUI
        // importer and can spin in the threaded wasm build while walking a
        // project archive.  Read the complete archive into the isolated
        // candidate for both modes, then discard config/preset state for the
        // geometry-only commit below.
        const LoadStrategy strategy = LoadStrategy::LoadModel | LoadStrategy::LoadConfig |
                                       LoadStrategy::LoadAuxiliary | LoadStrategy::AddDefaultInstances;
        const bool loaded = load_bbs_3mf(load_path.c_str(), &imported_config, &substitutions,
                                          &imported, &plate_data, &project_presets,
                                          &is_bbl_3mf, &is_orca_3mf, &file_version,
                                          nullptr, strategy, nullptr, 0);
        // A project export is also valid while the scene is empty: the BBS
        // reader can still restore its PresetBundle, plate session, and Neo
        // sidecars. Geometry-only import, however, must continue to reject an
        // archive that contains no geometry to append.
        if (!loaded || (geometry_only && imported.objects.empty()))
            throw Slic3r::RuntimeError("Loading of a project file failed.");
        publish_slicer_progress(55, geometry_only ? "Preparing imported geometry" : "Reading project settings");
        if (neo_metadata) {
            const size_t native_plate_count = std::max<size_t>(1, raw_records.empty() ? plate_data.size() : raw_records.size());
            if ((*neo_metadata)["plates"].size() != native_plate_count)
                throw Slic3r::RuntimeError("corrupt Neo plate metadata");
        }
        imported.add_default_instances();

        // Geometry-only imports intentionally discard object/part overrides;
        // extruder assignment is the one per-object value that remains.
        const auto* geometry_current_plate = find_plate(state().current_plate_id);
        const PlateBounds geometry_bounds = selected_plate_bounds();
        const Vec3d geometry_center = geometry_current_plate
            ? Vec3d(geometry_current_plate->origin.x() + (geometry_bounds.min_x + geometry_bounds.max_x) * 0.5,
                    geometry_current_plate->origin.y() + (geometry_bounds.min_y + geometry_bounds.max_y) * 0.5,
                    geometry_current_plate->origin.z())
            : Vec3d::Zero();
        std::map<std::size_t, Vec3d> geometry_added_instances;
        if (geometry_only) {
            for (ModelObject* object : imported.objects) {
                int extruder = 0;
                if (const auto* option = dynamic_cast<const ConfigOptionInt*>(object->config.option("extruder")))
                    extruder = option->value;
                object->config.reset();
                if (extruder > 0)
                    object->config.set_key_value("extruder", new ConfigOptionInt(extruder));
                for (ModelVolume* volume : object->volumes)
                    volume->config.reset();
            }
        }

        ++state().full_preset_bundle_copy_count;
        PresetBundle candidate = state().presets;
        std::vector<std::string> requested_filament_slots;
        bool filament_sidecar_applied = false;
        if (!geometry_only)
            requested_filament_slots = requested_filament_slots_from_project_settings(
                project_settings,
                requested_filament_slots_from_import(imported_config, candidate.filament_presets));
        std::size_t printer_preset_count = 0;
        std::size_t process_preset_count = 0;
        std::size_t filament_preset_count = 0;
        for (const Preset* preset : project_presets) {
            if (!preset) continue;
            if (preset->type == Preset::TYPE_PRINTER) ++printer_preset_count;
            else if (preset->type == Preset::TYPE_PRINT) ++process_preset_count;
            else if (preset->type == Preset::TYPE_FILAMENT) ++filament_preset_count;
        }
        if (!geometry_only && (!project_presets.empty() || is_bbl_3mf || is_orca_3mf)) {
            candidate.load_project_embedded_presets(project_presets,
                ForwardCompatibilitySubstitutionRule::Enable);

            // This is Orca's native project-load sequence after embedded
            // presets have been imported.  load_config_model delegates to
            // PresetBundle::load_config_file_config, which loads each merged
            // print/printer/filament config through load_external_preset with
            // LoadAndSelect::Always, then refreshes compatibility and the
            // multi-material filament list.  Keeping this call on the
            // candidate preserves the transaction while also handling a
            // parentless project preset (such as Lily.3mf) exactly as Orca.
            candidate.load_config_model(project_name, imported_config, file_version);
            // The Neo sidecar is a lossless request layered on top of the
            // interoperable BBS input.  Apply it before the native
            // compatibility pass so an unavailable/incompatible requested
            // value cannot overwrite the native fallback afterwards.
            if (filament_state_metadata) {
                requested_filament_slots = filament_state_metadata->value(
                    "filament_presets", std::vector<std::string>{});
                apply_project_sidecar(candidate, *filament_state_metadata);
                filament_sidecar_applied = true;
                validate_filament_candidate(candidate, imported, {},
                                            overlay_metadata.value_or(empty_project_config_overlay()),
                                            true, true);
            }
            // The GUI refreshes its active preset controls after this native
            // load.  Re-run the bridge's authoritative compatibility pass so
            // stale selections from the previous project cannot survive a
            // printer replacement.
            candidate.update_compatible(PresetSelectCompatibleType::Always);
            candidate.update_multi_material_filament_presets();
        }
        if (!geometry_only && filament_state_metadata) {
            // Generic projects may not enter the native config-model branch;
            // apply the same request-before-compatibility ordering here.
            if (!filament_sidecar_applied) {
                requested_filament_slots = filament_state_metadata->value("filament_presets", std::vector<std::string>{});
                apply_project_sidecar(candidate, *filament_state_metadata);
                filament_sidecar_applied = true;
                validate_filament_candidate(candidate, imported, {},
                                            overlay_metadata.value_or(empty_project_config_overlay()),
                                            true, true);
            }
            candidate.update_compatible(PresetSelectCompatibleType::Always);
            candidate.update_multi_material_filament_presets();
        }
        publish_slicer_progress(75, geometry_only ? "Finalizing geometry import" : "Applying project settings");

        ProjectPresetWarningDetails warning_details;
        if (!geometry_only)
            warning_details = inspect_project_preset_warnings(
                candidate, imported_config, project_presets, load_path);

        std::vector<BridgeState::PlateSessionPlate> staged_plates;
        std::string staged_current_plate_id;
        const json staged_overlay = overlay_metadata.value_or(empty_project_config_overlay());
        if (!geometry_only) {
            // Build the incoming plate session while the candidate is still
            // isolated.  Plate settings are part of filament validation, so
            // validating against an empty list would incorrectly accept an
            // out-of-range plate assignment or tool-change reference.
            staged_plates = build_plate_session_from_records(
                plate_data, raw_records, neo_metadata,
                g_plate_session_sequence.load(std::memory_order_relaxed) + 1,
                staged_current_plate_id);
            apply_plate_metadata_to_configs(staged_plates);
            apply_plate_overlay_to_configs(staged_plates, staged_overlay);
        }

        // Complete candidate validation is still inside the staging phase.
        // In particular, a project carrying an explicit extruder or mapping
        // beyond the compatible rack must be rejected before replacing the
        // live model, PresetBundle, or history baseline.
        if (!geometry_only)
            validate_filament_candidate(candidate, imported, staged_plates,
                                        staged_overlay,
                                        false, filament_state_metadata.has_value());

        if (!geometry_only && !commit) {
            json warning_metadata{
                {"present", !project_presets.empty()},
                {"count", project_presets.size()},
                {"printer_count", printer_preset_count},
                {"process_count", process_preset_count},
                {"filament_count", filament_preset_count},
                {"modified_printer_gcode", warning_details.modified_printer_gcode},
                {"modified_filament_gcode", warning_details.modified_filament_gcode},
                {"missing_system_preset", warning_details.missing_system_preset},
                {"modified_gcode_keys", warning_details.modified_gcode_keys},
                {"missing_system_preset_types", std::move(warning_details.missing_system_preset_types)},
                {"preset_evidence", std::move(warning_details.preset_evidence)},
                {"requires_confirmation", !project_presets.empty()},
            };
            json slot_changes = json::array();
            const auto& after_slots = candidate.filament_presets;
            const std::size_t max_slots = std::max(requested_filament_slots.size(), after_slots.size());
            for (std::size_t index = 0; index < max_slots; ++index) {
                const std::string before = index < requested_filament_slots.size() ? requested_filament_slots[index] : std::string{};
                const std::string after = index < after_slots.size() ? after_slots[index] : std::string{};
                if (before != after)
                    slot_changes.push_back({{"slot", index + 1}, {"before", before}, {"after", after},
                                            {"reason", "native-compatibility"}});
            }
            warning_metadata["filament_slot_changes"] = std::move(slot_changes);
            warning_metadata["requires_confirmation"] =
                warning_metadata["requires_confirmation"].get<bool>() ||
                !warning_metadata["filament_slot_changes"].empty();
            const std::string token = std::string("project-preflight-") + std::to_string(++state().next_history_transaction_id);
            state().pending_project_restore = BridgeState::PendingProjectRestore{
                token, std::vector<unsigned char>(reinterpret_cast<const unsigned char*>(data),
                                                  reinterpret_cast<const unsigned char*>(data) + len), project_name,
                state().history_revision, state().history.cursor(),
                history_state_json(state().presets).dump(),
                model_structure_json().dump(), state().project_config_overlay.dump()};
            json out{
                {"ok", true}, {"preflight", true}, {"preflight_token", token},
                {"objects", imported.objects.size()}, {"instances", model_instance_count(imported)},
                {"mode", "project"}, {"display_name", display_name ? display_name : ""},
                {"compatibility", is_orca_3mf ? "orca" : (is_bbl_3mf ? "bambu" : "generic")},
                {"project_settings_available", is_bbl_3mf || is_orca_3mf},
                {"is_bbl_3mf", is_bbl_3mf}, {"is_orca_3mf", is_orca_3mf},
                {"file_version", file_version.to_string()}, {"multi_plate", plate_data.size() > 1},
                {"plate_count", plate_data.size()}, {"embedded_preset_warnings", std::move(warning_metadata)},
                {"project_config_overlay", overlay_metadata.value_or(empty_project_config_overlay())},
            };
            finish_progress("Project preflight complete");
            progress_scope.completed = true;
            release_PlateData_list(plate_data);
            release_presets();
            cleanup_paths();
            return dup_json(out.dump());
        }

        if (geometry_only) {
            for (const ModelObject* object : imported.objects) {
                ModelObject* added = append_model_object_geometry(state().model, *object);
                for (ModelInstance* instance : added->instances) {
                    const auto offset = instance->get_offset();
                    instance->set_offset(Vec3d(geometry_center.x(), geometry_center.y(), offset.z()));
                    geometry_added_instances[instance->id().id] = Vec3d::Zero();
                }
            }
        } else {
            // Publication is guarded by a complete move-based rollback.  The
            // staged model/presets/history are all replaceable values; plate
            // identity and revision maps are captured alongside them so a
            // late failure cannot leave a hybrid project session.
            struct ProjectCommitRollback {
                Model model;
                PresetBundle presets;
                Neo::History::ProjectHistory history;
                json overlay;
                std::vector<BridgeState::PlateSessionPlate> plates;
                std::string current_plate;
                std::map<std::size_t, std::string> instance_plate_ids;
                std::map<std::string, std::set<std::size_t>> out_of_bounds;
                std::set<std::size_t> parked;
                std::set<std::size_t> pending_membership;
                std::map<std::string, std::uint64_t> plate_revisions;
                std::optional<BridgeState::HistoryTransaction> active_transaction;
                std::vector<BridgeState::HistoryTransaction> nested_transactions;
                std::uint64_t next_transaction_id { 0 };
                std::uint64_t history_revision { 0 };
                std::size_t next_colour_index { 0 };
                bool history_disabled { false };
            } rollback;
            rollback.model = std::move(state().model);
            rollback.presets = std::move(state().presets);
            rollback.history = std::move(state().history);
            rollback.overlay = std::move(state().project_config_overlay);
            rollback.plates = std::move(state().plate_session_plates);
            rollback.current_plate = std::move(state().current_plate_id);
            rollback.instance_plate_ids = std::move(state().instance_plate_ids);
            rollback.out_of_bounds = std::move(state().plate_out_of_bounds_ids);
            rollback.parked = std::move(state().parked_instance_ids);
            rollback.pending_membership = std::move(state().pending_membership_instance_ids);
            rollback.plate_revisions = std::move(state().plate_input_revisions);
            rollback.active_transaction = std::move(state().active_history_transaction);
            rollback.nested_transactions = std::move(state().nested_history_transactions);
            rollback.next_transaction_id = state().next_history_transaction_id;
            rollback.history_revision = state().history_revision;
            rollback.next_colour_index = state().next_filament_colour_index;
            rollback.history_disabled = state().history_disabled;
            bool committed = false;
            try {
                state().model = std::move(imported);
                // Keep the staged candidate available for the response's
                // provenance report; PresetBundle copy is the established
                // bridge staging boundary.
                state().presets = candidate;
                state().project_config_overlay = overlay_metadata.value_or(empty_project_config_overlay());
                initialize_plate_session_from_records(plate_data, raw_records, neo_metadata);
                for (auto& object : state().model.objects) {
                    const auto it = state().project_config_overlay["objects"].find(std::to_string(object->id().id));
                    if (it != state().project_config_overlay["objects"].end()) apply_overlay_to_config(object->config, it.value());
                    for (auto& volume : object->volumes) {
                        const auto part_it = state().project_config_overlay["parts"].find(std::to_string(volume->id().id));
                        if (part_it != state().project_config_overlay["parts"].end()) apply_overlay_to_config(volume->config, part_it.value());
                    }
                }
                apply_plate_metadata_to_configs(state().plate_session_plates);
                apply_plate_overlay_to_configs(state().plate_session_plates, state().project_config_overlay);
                // Results are deliberately not loaded from PlateData.
                rebuild_plate_membership(true);
                state().history.clear();
                state().active_history_transaction.reset();
                state().nested_history_transactions.clear();
                state().history_disabled = false;
                const json context = default_history_context();
                const std::string context_text = context.dump();
                const Neo::History::Bytes context_bytes(context_text.begin(), context_text.end());
                if (!state().history.commit("", Neo::History::Category::Project,
                                            Neo::History::Codec::capture_model_state(state().model), context_bytes))
                    throw Slic3r::RuntimeError("could not establish project history baseline");
                state().history.mark_current_as_saved();
                state().history_revision++;
                if (state().inject_project_commit_failure) {
                    state().inject_project_commit_failure = false;
                    throw Slic3r::RuntimeError("injected project commit failure after publication");
                }
                committed = true;
            } catch (...) {
                state().inject_project_commit_failure = false;
                state().model = std::move(rollback.model);
                state().presets = std::move(rollback.presets);
                state().history = std::move(rollback.history);
                state().project_config_overlay = std::move(rollback.overlay);
                state().plate_session_plates = std::move(rollback.plates);
                state().current_plate_id = std::move(rollback.current_plate);
                state().instance_plate_ids = std::move(rollback.instance_plate_ids);
                state().plate_out_of_bounds_ids = std::move(rollback.out_of_bounds);
                state().parked_instance_ids = std::move(rollback.parked);
                state().pending_membership_instance_ids = std::move(rollback.pending_membership);
                state().plate_input_revisions = std::move(rollback.plate_revisions);
                state().active_history_transaction = std::move(rollback.active_transaction);
                state().nested_history_transactions = std::move(rollback.nested_transactions);
                state().next_history_transaction_id = rollback.next_transaction_id;
                state().history_revision = rollback.history_revision;
                state().next_filament_colour_index = rollback.next_colour_index;
                state().history_disabled = rollback.history_disabled;
                throw;
            }
            if (!committed) throw Slic3r::RuntimeError("project commit did not publish");
        }
        state().print.clear();
        invalidate_preview_source();
        if (geometry_only) {
            rebuild_plate_membership(true);
        } else {
            // Replacement loads establish a fresh clean Worker session above.
        }
        publish_slicer_progress(90, "Finalizing project");

        const std::string compatibility = is_orca_3mf ? "orca" :
            (is_bbl_3mf ? "bambu" : "generic");
        json warning_metadata{
            {"present", !project_presets.empty()},
            {"count", project_presets.size()},
            {"printer_count", printer_preset_count},
            {"process_count", process_preset_count},
            {"filament_count", filament_preset_count},
            {"modified_printer_gcode", warning_details.modified_printer_gcode},
            {"modified_filament_gcode", warning_details.modified_filament_gcode},
            {"missing_system_preset", warning_details.missing_system_preset},
            {"modified_gcode_keys", warning_details.modified_gcode_keys},
            {"missing_system_preset_types", std::move(warning_details.missing_system_preset_types)},
            {"preset_evidence", std::move(warning_details.preset_evidence)},
            {"requires_confirmation", !project_presets.empty()},
        };
        if (!geometry_only) {
            json slot_changes = json::array();
            const auto& before_slots = requested_filament_slots;
            const auto& after_slots = candidate.filament_presets;
            const std::size_t max_slots = std::max(before_slots.size(), after_slots.size());
            for (std::size_t index = 0; index < max_slots; ++index) {
                const std::string before = index < before_slots.size() ? before_slots[index] : std::string{};
                const std::string after = index < after_slots.size() ? after_slots[index] : std::string{};
                if (before != after)
                    slot_changes.push_back({{"slot", index + 1}, {"before", before}, {"after", after},
                                            {"reason", "native-compatibility"}});
            }
            warning_metadata["filament_slot_changes"] = std::move(slot_changes);
            warning_metadata["requires_confirmation"] =
                warning_metadata["requires_confirmation"].get<bool>() ||
                !warning_metadata["filament_slot_changes"].empty();
        }
        json out{
            {"ok", true},
            {"objects", state().model.objects.size()},
            {"instances", model_instance_count(state().model)},
            {"mode", geometry_only ? "geometry-only" : "project"},
            {"display_name", display_name ? display_name : ""},
            {"compatibility", compatibility},
            {"project_settings_available", is_bbl_3mf || is_orca_3mf},
            {"is_bbl_3mf", is_bbl_3mf},
            {"is_orca_3mf", is_orca_3mf},
            {"file_version", file_version.to_string()},
            {"multi_plate", !geometry_only && state().plate_session_plates.size() > 1},
            {"plate_count", !geometry_only ? state().plate_session_plates.size() : plate_data.size()},
            {"embedded_preset_warnings", std::move(warning_metadata)},
        };
        // Include the candidate picker state in this same response. The
        // shared transaction can therefore commit model + presets together;
        // it never has to issue a second read after native replacement.
        if (!geometry_only)
            out["preset_snapshot"] = preset_snapshot_json();
        if (!geometry_only)
            out["project_config_overlay"] = state().project_config_overlay;
        if (geometry_only) {
            const auto mutation = plate_mutation_snapshot({}, {"model-import"},
                reflow_instance_transforms(geometry_added_instances));
            out = attach_plate_mutation(std::move(out), mutation);
        } else {
            // Replacement loads establish a fresh authoritative membership
            // snapshot for the newly loaded model without dirtying the clean
            // project session.
            out["plate_session"] = plate_session_snapshot_json();
        }
        finish_progress(geometry_only ? "Geometry import complete" : "Project load complete");
        progress_scope.completed = true;
        release_PlateData_list(plate_data);
        release_presets();
        cleanup_paths();
        return dup_json(out.dump());
    } catch (const std::exception& e) {
        release_PlateData_list(plate_data);
        release_presets();
        cleanup_paths();
        return error_json(e.what());
    } catch (...) {
        release_PlateData_list(plate_data);
        release_presets();
        cleanup_paths();
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_load_project(const char* data, int len,
                                                   int geometry_only,
                                                   const char* display_name) {
    return orc_load_project_impl(data, len, geometry_only, display_name, true);
}

EMSCRIPTEN_KEEPALIVE const char* orc_preflight_project(const char* data, int len,
                                                        const char* display_name) {
    return orc_load_project_impl(data, len, 0, display_name, false);
}

EMSCRIPTEN_KEEPALIVE const char* orc_commit_project_preflight(const char* token) {
    try {
        if (!token || !state().pending_project_restore || state().pending_project_restore->token != token)
            return error_json("project preflight is missing or stale");
        const auto pending = *state().pending_project_restore;
        if (pending.base_history_revision != state().history_revision ||
            pending.base_history_cursor != state().history.cursor() ||
            pending.base_filament_state != history_state_json(state().presets).dump() ||
            pending.base_model_state != model_structure_json().dump() ||
            pending.base_overlay != state().project_config_overlay.dump()) {
            state().pending_project_restore.reset();
            return error_json("project preflight is stale; the live project changed");
        }
        const char* result = orc_load_project_impl(
            reinterpret_cast<const char*>(pending.bytes.data()), static_cast<int>(pending.bytes.size()),
            0, pending.display_name.c_str(), true);
        // A failed commit is terminal for this token.  Never allow a caller
        // to retry a partially executed or otherwise obsolete plan.
        state().pending_project_restore.reset();
        return result;
    } catch (const std::exception& e) {
        state().pending_project_restore.reset();
        return error_json(e.what());
    } catch (...) {
        state().pending_project_restore.reset();
        return error_json("unknown C++ exception");
    }
}

// Harness-only fault injection for proving post-publication project rollback.
// It is one-shot and has no application/client surface.
EMSCRIPTEN_KEEPALIVE const char* orc_test_inject_project_commit_failure() {
    state().inject_project_commit_failure = true;
    return dup_json(json{{"ok", true}}.dump());
}

EMSCRIPTEN_KEEPALIVE const char* orc_cancel_project_preflight(const char* token) {
    if (!token || !state().pending_project_restore || state().pending_project_restore->token != token)
        return error_json("project preflight is missing or stale");
    state().pending_project_restore.reset();
    return dup_json(json{{"ok", true}}.dump());
}

EMSCRIPTEN_KEEPALIVE const char* orc_import_project_geometry(const char* data, int len,
                                                              const char* display_name) {
    return orc_load_project(data, len, 1, display_name);
}

// Build native PlateData records from the authoritative runtime session. The
// standard BBS writer remains responsible for the interoperable model config;
// the adjacent Neo metadata entry carries fields the native PlateData ABI
// cannot express (including unknown future key/value records).
extern "C++" {

json plate_metadata_json(const std::vector<std::unique_ptr<PlateData>>& owned)
{
    json plates = json::array();
    for (size_t i = 0; i < owned.size(); ++i) {
        const auto& native = *owned[i];
        const auto& runtime = state().plate_session_plates[i];
        json instances = json::array();
        for (const auto& pair : native.objects_and_instances)
            instances.push_back({{"object_id", pair.first}, {"instance_index", pair.second}});
        json record = {
            {"plate_index", static_cast<int>(i)}, {"origin", {runtime.origin.x(), runtime.origin.y(), runtime.origin.z()}},
            {"name", runtime.name}, {"locked", runtime.locked},
            {"settings", runtime.settings_metadata}, {"opaque_metadata", runtime.opaque_metadata},
            {"instances", std::move(instances)},
        };
        for (auto it = runtime.future_metadata.begin(); it != runtime.future_metadata.end(); ++it)
            if (!is_neo_plate_metadata_key(it.key())) record[it.key()] = it.value();
        plates.push_back(std::move(record));
    }
    size_t current_index = 0;
    if (!state().current_plate_id.empty()) {
        const auto it = std::find_if(state().plate_session_plates.begin(), state().plate_session_plates.end(),
            [](const auto& plate) { return plate.id == state().current_plate_id; });
        if (it != state().plate_session_plates.end())
            current_index = static_cast<size_t>(std::distance(state().plate_session_plates.begin(), it));
    }
    return json{{"schema", kNeoPlateMetadataSchema}, {"version", 1},
                {"current_plate_index", current_index}, {"plates", std::move(plates)}};
}

}

// Export the complete active multi-plate project. The resulting archive is
// native Orca-readable and contains no derived g-code/preview artifacts.
EMSCRIPTEN_KEEPALIVE const char* orc_export_project() {
    const std::string path = next_project_temp_path(".3mf");
    try {
        ensure_plate_session_state();
        rebuild_plate_membership(false);
        std::vector<std::unique_ptr<PlateData>> owned;
        PlateDataPtrs plates;
        owned.reserve(state().plate_session_plates.size());
        plates.reserve(state().plate_session_plates.size());
        for (const auto& runtime : state().plate_session_plates) {
            std::set<std::pair<int, int>> object_instances;
            for (size_t oi = 0; oi < state().model.objects.size(); ++oi) {
                const auto* object = state().model.objects[oi];
                // PlateData expects the zero-based Model::objects index; the
                // native writer translates it to the 3MF object id.
                const int object_id = static_cast<int>(oi);
                for (size_t ii = 0; ii < object->instances.size(); ++ii) {
                    const size_t instance_id = object->instances[ii]->id().id;
                    const auto member = state().instance_plate_ids.find(instance_id);
                    if (member != state().instance_plate_ids.end() && member->second == runtime.id)
                        object_instances.emplace(object_id, static_cast<int>(ii));
                }
            }
            auto plate = std::make_unique<PlateData>(static_cast<int>(owned.size()), object_instances, runtime.locked);
            plate->plate_name = runtime.name;
            plate->config = runtime.settings;
            plates.push_back(plate.get());
            owned.push_back(std::move(plate));
        }
        DynamicPrintConfig config = state().presets.full_config_secure();
        StoreParams params;
        params.path = path;
        params.model = &state().model;
        params.plate_data_list = plates;
        params.project_presets = state().presets.get_current_project_embedded_presets();
        params.config = &config;
        params.strategy = SaveStrategy::ShareMesh |
                          SaveStrategy::Zip64 | SaveStrategy::Silence |
                          SaveStrategy::SkipStatic | SaveStrategy::SkipAuxiliary;
        // BBS's exporter launches nested parallel_for jobs.  Running that
        // exporter in a one-slot arena keeps the bridge request deterministic
        // and avoids nested-pool starvation in the threaded WASM worker.
        bool stored = false;
        tbb::task_arena export_arena(1);
        export_arena.execute([&]() { stored = store_bbs_3mf(params); });
        if (!stored)
            throw Slic3r::RuntimeError("BBS 3MF export failed");
        const std::string metadata = plate_metadata_json(owned).dump();
        if (!append_archive_entry(path, kNeoPlateMetadataEntry, metadata))
            throw Slic3r::RuntimeError("Neo plate metadata append failed");
        const std::string overlay = project_config_overlay_metadata().dump();
        if (!append_archive_entry(path, kNeoConfigOverlayEntry, overlay))
            throw Slic3r::RuntimeError("Neo configuration overlay metadata append failed");
        const json filament_state = json{{"schema", kNeoFilamentStateSchema}, {"version", 1},
                                         {"state", history_state_json(state().presets)}};
        if (!append_archive_entry(path, kNeoFilamentStateEntry, filament_state.dump()))
            throw Slic3r::RuntimeError("Neo filament state metadata append failed");

        std::ifstream input(path, std::ios::binary | std::ios::ate);
        if (!input.good()) throw Slic3r::RuntimeError("BBS 3MF output could not be opened");
        const auto size = input.tellg();
        if (size < 0) throw Slic3r::RuntimeError("BBS 3MF output has invalid size");
        const std::size_t length = static_cast<std::size_t>(size);
        auto* bytes = static_cast<std::uint8_t*>(std::malloc(length == 0 ? 1 : length));
        input.seekg(0, std::ios::beg);
        if (length > 0) input.read(reinterpret_cast<char*>(bytes), static_cast<std::streamsize>(length));
        if (!input.good() && !input.eof()) {
            std::free(bytes);
            throw Slic3r::RuntimeError("BBS 3MF output read failed");
        }
        remove_project_temp_path(path);
        return dup_json(json{{"ok", true}, {"path", path},
                             {"bytes_ptr", reinterpret_cast<std::uintptr_t>(bytes)},
                             {"bytes_length", length}, {"objects", state().model.objects.size()},
                             {"plate_count", owned.size()}}.dump());
    } catch (const std::exception& e) {
        remove_project_temp_path(path);
        return error_json(e.what());
    } catch (...) {
        remove_project_temp_path(path);
        return error_json("unknown C++ exception");
    }
}

// OrcaSlicer primitives are created in the engine and added to the model
// directly (ObjectList::load_shape_object → create_mesh → load_mesh_object),
// never through a file: no staging, no basename-derived names, no extension.
// Mirror that here: the mesh is built with the same libslic3r builders and
// the same step angles as Orca's create_mesh (GUI_ObjectList.cpp), and the
// object and its single part are named after the primitive label — the six
// shapes the scene menu's "Add Primitive" submenu offers. The GUI canvas
// helpers (nearest-empty-cell placement, cooling orientation, snapshot) are
// not compiled into the WASM build, so the shape lands at the current scene
// origin, resting on the bed — the same result the staged STL import used
// to produce.
EMSCRIPTEN_KEEPALIVE const char* orc_add_shape(const char* type, const char* name) {
    try {
        const auto* current_plate = find_plate(state().current_plate_id);
        const PlateBounds placement_bounds = selected_plate_bounds();
        const Vec3d placement_center = current_plate
            ? Vec3d(current_plate->origin.x() + (placement_bounds.min_x + placement_bounds.max_x) * 0.5,
                    current_plate->origin.y() + (placement_bounds.min_y + placement_bounds.max_y) * 0.5,
                    current_plate->origin.z())
            : Vec3d::Zero();
        const std::string type_str = type ? type : "";
        const std::string object_name = (name && *name) ? name : type_str;
        // App-sized primitive: OrcaSlicer sizes shapes at 10% of the max bed
        // size (get_size_proportional_to_max_bed_size); keep the app's
        // established 20 mm so primitives render like the well-tested cube
        // path. Orca's create_mesh proportions from `side` are preserved.
        const double side = 20.0;
        TriangleMesh mesh;
        if (type_str == "Cube")
            mesh = TriangleMesh(its_make_cube(side, side, side));
        else if (type_str == "Cylinder")
            mesh = TriangleMesh(its_make_cylinder(0.5 * side, side));
        else if (type_str == "Sphere")
            mesh = TriangleMesh(its_make_sphere(0.5 * side, PI / 90));
        else if (type_str == "Cone")
            mesh = TriangleMesh(its_make_cone(0.5 * side, side));
        else if (type_str == "Disc")
            mesh = TriangleMesh(its_make_cylinder(0.5 * side, 0.2f));
        else if (type_str == "Torus")
            mesh = TriangleMesh(its_make_torus(0.5 * side, 0.125 * side, PI / 60));
        else
            return error_json("unsupported primitive type: " + type_str);
        const BoundingBoxf3 bb = mesh.bounding_box();

        ModelObject* new_object = state().model.add_object();
        new_object->name = object_name;
        new_object->add_instance(); // each object should have at least one instance
        ModelVolume* new_volume = new_object->add_volume(mesh);
        new_object->sort_volumes(true);
        new_volume->name = object_name;
        // The primitive has no per-object settings: default the extruder so
        // slicing assigns it without a provider (load_mesh_object does this
        // for the same reason).
        new_object->config.set_key_value("extruder", new ConfigOptionInt(1));
        new_object->invalidate_bounding_box();
        // load_mesh_object centers the freshly built 0..side mesh (its
        // add_volume already centered the volume mesh and re-offset the
        // volume; the object translate cancels that offset), then rests the
        // object on the bed. The empty-cell step is a canvas helper
        // (get_nearest_empty_cell at the build-volume center) — the shared
        // renderer's scene origin plays the same role here.
        new_object->translate(-bb.center());
        new_object->instances[0]->set_offset(Slic3r::Vec3d(placement_center.x(), placement_center.y(),
                                                            -new_object->origin_translation.z()));
        new_object->ensure_on_bed();
        // A model mutation makes any existing Print/G-code result stale.
        state().print.clear();
        invalidate_preview_source();
        size_t instance_count = 0;
        for (const ModelObject* o : state().model.objects)
            instance_count += o->instances.size();
        rebuild_plate_membership(true);
        const std::set<std::size_t> added_instances{new_object->instances[0]->id().id};
        const auto mutation = plate_mutation_snapshot({}, {"model-import"},
            reflow_instance_transforms({{new_object->instances[0]->id().id, Vec3d::Zero()}}), &added_instances);
        return dup_json(attach_plate_mutation(json{{"ok", true},
                             {"objects",   state().model.objects.size()},
                             {"instances", instance_count}}, mutation).dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

// Explicit scene reset for the renderer's Clear Scene action. Resetting the
// model rather than merely hiding meshes guarantees that the next slice and
// export operate on an empty plate.
EMSCRIPTEN_KEEPALIVE const char* orc_clear_model() {
    try {
        const auto affected_before = member_plate_ids();
        state().print.clear();
        invalidate_preview_source();
        state().model = Model{};
        reset_plate_session_state();
        const auto mutation = plate_mutation_snapshot(affected_before, {"model-clear"});
        return dup_json(attach_plate_mutation(json{{"ok", true}}, mutation).dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Delete whole objects by their stable ObjectIDs (spec §9.2). The renderer
// selection and object list use IDs, not positional indices — a structural
// mutation elsewhere cannot silently shift the target. All IDs are validated
// before any mutation so a bad request leaves the scene intact.
EMSCRIPTEN_KEEPALIVE const char* orc_delete_objects(const char* object_ids_json) {
    try {
        const json j = json::parse(object_ids_json ? object_ids_json : "");
        const auto ids = parse_positive_id_array(j);
        if (!ids) return error_json("no object ids");
        // Validate every ID resolves, so a malformed request does not partially delete.
        for (const std::size_t id : *ids)
            if (find_object_by_id(id) == nullptr)
                return error_json("object not found");
        std::set<std::size_t> affected_instances;
        for (const std::size_t id : *ids) {
            const auto* object = find_object_by_id(id);
            for (const auto* instance : object->instances) affected_instances.insert(instance->id().id);
        }
        const auto affected_before = member_plate_ids_for_instances(affected_instances);
        for (const std::size_t id : *ids)
            state().model.delete_object(ObjectID(id));
        rebuild_plate_membership(true);
        state().print.clear();
        invalidate_preview_source();
        const auto mutation = plate_mutation_snapshot(affected_before, {"model-delete"},
                                                       json::array(), &affected_instances);
        return dup_json(attach_plate_mutation(json{{"ok", true},
                             {"objects", state().model.objects.size()},
                             {"deleted", ids->size()}}, mutation).dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

// Delete specific parts (volumes) by their stable ObjectIDs. Enforces the
// upstream last-solid-part guard: a volume that is the only MODEL_PART of its
// object cannot be deleted. All IDs are resolved and guarded before any
// mutation, so a bad request leaves the scene intact.
EMSCRIPTEN_KEEPALIVE const char* orc_delete_volumes(const char* volume_ids_json) {
    try {
        const json j = json::parse(volume_ids_json ? volume_ids_json : "");
        const auto ids = parse_positive_id_array(j);
        if (!ids) return error_json("no volume ids");
        std::vector<std::pair<ModelObject*, ModelVolume*>> targets;
        for (const std::size_t id : *ids) {
            ModelVolume* vol = find_volume_by_id(id);
            if (vol == nullptr) return error_json("volume not found");
            if (vol->is_the_only_one_part())
                return error_json("deleting the last solid part is not allowed");
            targets.emplace_back(vol->get_object(), vol);
        }
        std::set<std::size_t> affected_instances;
        for (const auto& [object, _] : targets)
            for (const auto* instance : object->instances) affected_instances.insert(instance->id().id);
        const auto affected_before = member_plate_ids_for_instances(affected_instances);
        // delete_volume(idx) shifts the object's own volume indices, so group
        // by object and remove in descending index order within each object.
        std::map<ModelObject*, std::vector<std::size_t>> by_object;
        for (const auto& [obj, vol] : targets) {
            for (std::size_t vi = 0; vi < obj->volumes.size(); ++vi)
                if (obj->volumes[vi] == vol) { by_object[obj].push_back(vi); break; }
        }
        for (auto& [obj, indexes] : by_object) {
            std::sort(indexes.rbegin(), indexes.rend());
            for (const std::size_t idx : indexes)
                obj->delete_volume(idx);
        }
        rebuild_plate_membership(true);
        state().print.clear();
        invalidate_preview_source();
        const auto mutation = plate_mutation_snapshot(affected_before, {"model-delete"},
                                                       json::array(), &affected_instances);
        return dup_json(attach_plate_mutation(json{{"ok", true},
                             {"objects", state().model.objects.size()},
                             {"deleted", ids->size()}}, mutation).dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Clone whole objects by stable ObjectIDs. libslic3r's add_object(const
// ModelObject&) performs ModelObject::new_clone, assigning fresh recursive IDs
// to the clone. The new stable IDs are returned so the renderer can restore
// selection to the cloned objects (spec §9.2).
EMSCRIPTEN_KEEPALIVE const char* orc_clone_objects(const char* object_ids_json) {
    try {
        const json j = json::parse(object_ids_json ? object_ids_json : "");
        const auto ids = parse_positive_id_array(j);
        if (!ids) return error_json("no object ids");
        std::vector<std::size_t> new_object_ids;
        for (const std::size_t id : *ids) {
            ModelObject* obj = find_object_by_id(id);
            if (obj == nullptr) return error_json("object not found");
            ModelObject* clone = state().model.add_object(*obj);
            new_object_ids.push_back(clone->id().id);
        }
        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true},
                             {"newObjectIds", new_object_ids},
                             {"objects", state().model.objects.size()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Reorder the plate/list by a stable ObjectID and a DESTINATION INDEX. The
// object with `from_obj_id` is moved so it sits at `to_index` (0-based) in the
// final list; `to_index == object_count` (or anything >= count) appends it at
// the end. Returns the current structure for a single refresh round-trip.
EMSCRIPTEN_KEEPALIVE const char* orc_reorder_objects(double from_obj_id, double to_index) {
    try {
        const auto from_id = to_object_id(from_obj_id);
        if (!from_id) return error_json("object id must be a positive integer");
        if (to_index < 0) return error_json("target index must be >= 0");
        auto& objs = state().model.objects;
        const std::size_t count = objs.size();
        std::size_t from_idx = count;
        for (std::size_t i = 0; i < count; ++i)
            if (objs[i]->id().id == *from_id) { from_idx = i; break; }
        if (from_idx == count) return error_json("object not found");
        const std::size_t dest = static_cast<std::size_t>(to_index);
        // Destination final index; to_index == count (or beyond) appends last.
        const std::size_t target = dest >= count ? count - 1 : dest;
        if (from_idx != target) {
            ModelObject* from_obj = objs[from_idx];
            objs.erase(objs.begin() + static_cast<std::ptrdiff_t>(from_idx));
            objs.insert(objs.begin() + static_cast<std::ptrdiff_t>(target), from_obj);
        }
        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true}, {"objects", model_structure_json()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Reorder parts within an object by a stable volume ID and a DESTINATION INDEX.
// `to_index == volume_count` (or beyond) appends the part at the end; otherwise
// it is moved so it sits at `to_index` in the final list.
EMSCRIPTEN_KEEPALIVE const char* orc_reorder_volumes(double object_id, double from_volume_id, double to_index) {
    try {
        const auto obj_id = to_object_id(object_id);
        const auto from_id = to_object_id(from_volume_id);
        if (!obj_id || !from_id) return error_json("id must be a positive integer");
        if (to_index < 0) return error_json("target index must be >= 0");
        ModelObject* obj = find_object_by_id(*obj_id);
        if (obj == nullptr) return error_json("object not found");
        auto& vols = obj->volumes;
        const std::size_t count = vols.size();
        std::size_t from_idx = count;
        for (std::size_t i = 0; i < count; ++i)
            if (vols[i]->id().id == *from_id) { from_idx = i; break; }
        if (from_idx == count) return error_json("volume not found");
        const std::size_t dest = static_cast<std::size_t>(to_index);
        const std::size_t target = dest >= count ? count - 1 : dest;
        if (from_idx != target) {
            ModelVolume* from_vol = vols[from_idx];
            vols.erase(vols.begin() + static_cast<std::ptrdiff_t>(from_idx));
            vols.insert(vols.begin() + static_cast<std::ptrdiff_t>(target), from_vol);
        }
        obj->invalidate_bounding_box();
        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true}, {"objects", model_structure_json()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Split a volume into its disconnected parts (upstream ModelVolume::split).
// libslic3r assigns a NEW unique ID to the original volume and creates new
// volume(s) for the remaining shells, so the caller's volumeId is now stale.
// Return the freshly generated volume IDs plus the current structure so the
// renderer can clear stale selection and re-read (spec §8 mutation flow).
EMSCRIPTEN_KEEPALIVE const char* orc_split_volume_to_parts(double volume_id, double max_extruders, double remap_paint) {
    try {
        const auto id = to_object_id(volume_id);
        if (!id) return error_json("volume id must be a positive integer");
        ModelVolume* vol = find_volume_by_id(*id);
        if (vol == nullptr) return error_json("volume not found");
        if (!vol->is_splittable()) return error_json("volume is not splittable");

        ModelObject* obj = vol->get_object();
        // Capture the object's current volume IDs so the generated part IDs can
        // be computed after the split (the original is re-IDed, so it is "new").
        std::vector<std::size_t> before_ids;
        for (const ModelVolume* v : obj->volumes)
            before_ids.push_back(v->id().id);

        const unsigned int max_ext = max_extruders > 0.0
            ? static_cast<unsigned int>(max_extruders) : 1u;
        const std::size_t parts = vol->split(max_ext, remap_paint != 0.0);

        std::vector<std::size_t> new_volume_ids;
        for (const ModelVolume* v : obj->volumes)
            if (std::find(before_ids.begin(), before_ids.end(), v->id().id) == before_ids.end())
                new_volume_ids.push_back(v->id().id);

        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true},
                             {"parts", parts},
                             {"newVolumeIds", new_volume_ids},
                             {"objects", model_structure_json()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Split an object into one object per disconnected shell (upstream
// ObjectList::split_to_objects). ModelObject::split adds the new objects to the
// live model and fills new_objects; the bridge then removes the source object.
// Returns the freshly generated object IDs plus the current structure so the
// renderer can restore selection to the new objects. autoDrop is accepted for
// signature parity (the spec exposes it) but the auto_drop bed-drop has no
// first-version UI and is left to the host callers.
EMSCRIPTEN_KEEPALIVE const char* orc_split_object_to_objects(double object_id, double auto_drop) {
    try {
        const auto id = to_object_id(object_id);
        if (!id) return error_json("object id must be a positive integer");
        ModelObject* obj = find_object_by_id(*id);
        if (obj == nullptr) return error_json("object not found");
        const bool splittable = obj->volumes.size() > 1
            || (obj->volumes.size() == 1 && obj->volumes[0]->is_splittable());
        if (!splittable) return error_json("object is not splittable");

        ModelObjectPtrs new_objects;
        obj->split(&new_objects, /*remap_paint=*/false);
        // Remove the source; the split objects now own the geometry.
        state().model.delete_object(ObjectID(*id));

        std::vector<std::size_t> new_object_ids;
        for (const ModelObject* o : new_objects)
            new_object_ids.push_back(o->id().id);

        if (auto_drop != 0.0)
            state().model.adjust_min_z();

        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true},
                             {"newObjectIds", new_object_ids},
                             {"objects", state().model.objects.size()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Assemble objects into a single multipart object (upstream ObjectList::merge
// "Assemble"). Each source object's volumes are copied into a new object, with
// the source's first-instance transform composed into each volume transform; the
// new object carries one instance. Returns the new object's stable ID.
EMSCRIPTEN_KEEPALIVE const char* orc_merge_objects_to_multipart(const char* object_ids_json, const char* name_cstr) {
    try {
        const json j = json::parse(object_ids_json ? object_ids_json : "");
        const auto ids = parse_positive_id_array(j);
        if (!ids) return error_json("no object ids");
        std::vector<ModelObject*> sources;
        for (const std::size_t id : *ids) {
            ModelObject* obj = find_object_by_id(id);
            if (obj == nullptr) return error_json("object not found");
            sources.push_back(obj);
        }

        auto& model = state().model;
        ModelObject* new_obj = model.add_object();
        new_obj->name = (name_cstr && *name_cstr) ? name_cstr : "Assembly";

        bool first_instance = true;
        for (ModelObject* src : sources) {
            if (first_instance) {
                // A single instance whose (identity) transform is combined into
                // each volume's matrix below.
                new_obj->add_instance();
                first_instance = false;
            }
            const Transform3d src_matrix =
                src->instances.empty() ? Transform3d::Identity()
                                       : src->instances[0]->get_transformation().get_matrix();
            for (const ModelVolume* vol : src->volumes) {
                ModelVolume* new_vol = new_obj->add_volume(*vol);
                new_vol->set_transformation(src_matrix * new_vol->get_matrix());
            }
        }
        if (first_instance) {
            // No source volume/instance path executed (all sources had no volumes);
            // give the assembly a single default instance so it is renderable.
            new_obj->add_instance();
        }
        new_obj->sort_volumes(true);

        // Remove the source objects from the live model.
        std::sort(sources.begin(), sources.end());
        sources.erase(std::unique(sources.begin(), sources.end()), sources.end());
        for (ModelObject* src : sources)
            model.delete_object(src);

        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true},
                             {"objectId", new_obj->id().id},
                             {"objects", model.objects.size()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Separate selected instances into individual objects (upstream
// ObjectList::instances_to_separated_objects for the selected instances). Each
// selected instance becomes a new object carrying a copy of the source volumes
// and a single copied instance (preserving the instance transform). The selected
// instances are then removed from the source object.
EMSCRIPTEN_KEEPALIVE const char* orc_instances_to_separate_objects(double object_id, const char* instance_ids_json) {
    try {
        const auto id = to_object_id(object_id);
        if (!id) return error_json("object id must be a positive integer");
        ModelObject* obj = find_object_by_id(*id);
        if (obj == nullptr) return error_json("object not found");
        const auto ids = parse_positive_id_array(json::parse(instance_ids_json ? instance_ids_json : ""));
        if (!ids || ids->empty()) return error_json("no instance ids");

        // Validate every instance ID resolves before mutating.
        std::vector<std::size_t> to_remove;
        to_remove.reserve(ids->size());
        for (const std::size_t iid : *ids) {
            bool found = false;
            for (std::size_t i = 0; i < obj->instances.size(); ++i)
                if (obj->instances[i]->id().id == iid) { to_remove.push_back(i); found = true; break; }
            if (!found) return error_json("instance not found");
        }

        std::vector<std::size_t> new_object_ids;
        for (const std::size_t iid : *ids) {
            ModelInstance* src_inst = nullptr;
            for (ModelInstance* inst : obj->instances)
                if (inst->id().id == iid) { src_inst = inst; break; }
            ModelObject* clone = state().model.add_object();
            clone->name = obj->name;
            for (const ModelVolume* vol : obj->volumes)
                clone->add_volume(*vol);
            clone->add_instance(*src_inst);
            new_object_ids.push_back(clone->id().id);
        }

        // Remove the selected instances from the source (descending index).
        std::sort(to_remove.rbegin(), to_remove.rend());
        for (const std::size_t i : to_remove)
            obj->delete_instance(i);

        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true},
                             {"newObjectIds", new_object_ids},
                             {"objects", state().model.objects.size()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Add a new instance to an object. libslic3r's add_instance() (no args) stacks
// it at the object origin (identity), overlapping instance 0 — which reads as
// "nothing happened". Place it visibly to the right of the existing instances
// (object width + a gap, along X) so the copy is immediately visible and can be
// moved. Returns the new stable instance ID.
EMSCRIPTEN_KEEPALIVE const char* orc_add_instance(double object_id) {
    try {
        const auto id = to_object_id(object_id);
        if (!id) return error_json("object id must be a positive integer");
        ModelObject* obj = find_object_by_id(*id);
        if (obj == nullptr) return error_json("object not found");
        const BoundingBoxf3& bbox = obj->bounding_box_exact();
        const double width = static_cast<double>(bbox.size().x());
        const double step = width > 0.0 ? width + 30.0 : 30.0;
        const Slic3r::Vec3d base = obj->instances.empty()
            ? Slic3r::Vec3d(0, 0, 0)
            : obj->instances.back()->get_offset();
        ModelInstance* inst = obj->add_instance();
        inst->set_offset(Slic3r::Vec3d(base.x() + step, base.y(), base.z()));
        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true},
                             {"objectId", obj->id().id},
                             {"instanceId", inst->id().id}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Remove a specific instance from an object by stable ID. The last remaining
// instance cannot be removed (an object must keep at least one instance).
EMSCRIPTEN_KEEPALIVE const char* orc_remove_instance(double object_id, double instance_id) {
    try {
        const auto id = to_object_id(object_id);
        const auto iid = to_object_id(instance_id);
        if (!id || !iid) return error_json("id must be a positive integer");
        ModelObject* obj = find_object_by_id(*id);
        if (obj == nullptr) return error_json("object not found");
        if (obj->instances.size() <= 1) return error_json("cannot remove the last instance");
        for (std::size_t i = 0; i < obj->instances.size(); ++i) {
            if (obj->instances[i]->id().id == *iid) {
                obj->delete_instance(i);
                state().print.clear();
                invalidate_preview_source();
                return dup_json(json{{"ok", true}}.dump());
            }
        }
        return error_json("instance not found");
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

using progress_fn = void (*)(int, const char*);
progress_fn g_progress = nullptr;

// Threaded status transport -------------------------------------------------
//
// oneTBB can call Print's status callback from any pthread. Do not call a
// JS function-table entry from there: dynamically-grown tables are not shared
// reliably by Chromium's per-pthread Wasm instances. Instead publish the
// latest status in this fixed shared-memory mailbox. The renderer reads it
// directly while the module worker is blocked in orc_slice(). See
// doc/2026-08-18-threaded-progress-mailbox-design.md.
constexpr std::size_t k_progress_text_capacity = 512;
struct alignas(4) ProgressMailbox {
    std::atomic<std::uint32_t> sequence{0}; // odd while a writer owns it
    std::atomic<std::uint32_t> percent{0};
    std::atomic<std::uint32_t> text_length{0};
    std::uint32_t reserved{0};
    std::array<char, k_progress_text_capacity> text{};
};
static_assert(sizeof(std::atomic<std::uint32_t>) == sizeof(std::uint32_t));
static_assert(offsetof(ProgressMailbox, sequence) == 0);
static_assert(offsetof(ProgressMailbox, percent) == 4);
static_assert(offsetof(ProgressMailbox, text_length) == 8);
static_assert(offsetof(ProgressMailbox, text) == 16);

ProgressMailbox g_progress_mailbox;
std::mutex g_progress_mailbox_mutex;
bool g_progress_open = false;

void publish_progress_locked(int percent, std::string_view text)
{
    // The sequence brackets all non-atomic text writes. Readers retry if it
    // changes or is odd, so they never render a partially copied UTF-8 value.
    const std::uint32_t odd =
        g_progress_mailbox.sequence.fetch_add(1, std::memory_order_acq_rel) + 1;
    const auto clamped = static_cast<std::uint32_t>(std::clamp(percent, 0, 100));
    std::size_t len = std::min(text.size(), k_progress_text_capacity - 1);
    // If the next omitted byte is a continuation, remove the partial code
    // point that began before the truncation boundary.
    while (len > 0 && len < text.size() &&
           (static_cast<unsigned char>(text[len]) & 0xc0u) == 0x80u)
        --len;
    std::memcpy(g_progress_mailbox.text.data(), text.data(), len);
    g_progress_mailbox.text[len] = '\0';
    g_progress_mailbox.percent.store(clamped, std::memory_order_relaxed);
    g_progress_mailbox.text_length.store(static_cast<std::uint32_t>(len), std::memory_order_relaxed);
    g_progress_mailbox.sequence.store(odd + 1, std::memory_order_release);
}

void notify_progress(int percent, std::string_view text)
{
#ifndef ORCA_WASM_THREADING
    if (g_progress) {
        const std::string owned_text(text);
        g_progress(percent, owned_text.c_str());
    }
#else
    (void)percent;
    (void)text;
#endif
}

void begin_progress(std::string_view text)
{
    {
        std::lock_guard<std::mutex> lock(g_progress_mailbox_mutex);
        g_progress_open = true;
    }
    publish_slicer_progress(0, text);
}

void publish_slicer_progress(int percent, std::string_view text)
{
    bool active = false;
    {
        std::lock_guard<std::mutex> lock(g_progress_mailbox_mutex);
        active = g_progress_open;
        if (active)
            publish_progress_locked(percent, text);
    }
    if (active)
        notify_progress(percent, text);
}

void finish_progress(std::string_view text)
{
    {
        std::lock_guard<std::mutex> lock(g_progress_mailbox_mutex);
        // Close before the terminal write. A status callback that reaches us
        // later must acquire this same mutex and therefore cannot overwrite
        // 100%.
        g_progress_open = false;
        publish_progress_locked(100, text);
    }
    notify_progress(100, text);
}

void stop_progress()
{
    std::lock_guard<std::mutex> lock(g_progress_mailbox_mutex);
    g_progress_open = false;
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_progress_mailbox()
{
    return dup_json(json{{"ok", true},
                         {"byte_offset", reinterpret_cast<std::uintptr_t>(&g_progress_mailbox)},
                         {"text_capacity", k_progress_text_capacity}}.dump());
}

EMSCRIPTEN_KEEPALIVE void orc_set_progress_callback(progress_fn cb) {
#ifdef ORCA_WASM_THREADING
    // Deliberately ignore raw callbacks in a pthread module. The mailbox above
    // is the only safe threaded transport, including for direct bridge users.
    (void)cb;
#else
    g_progress = cb;
#endif
}

const char* slice_for_plate(const char* config_json, const std::string& plate_id,
                            const std::uint64_t revision) {
    std::optional<Model> local_model;
    try {
        // Refresh membership before the operation gate.  This is read-only
        // with respect to the editing model and makes direct bridge callers
        // obey the same empty/out-of-bounds rules as the UI path.
        rebuild_plate_membership(false);
        std::string target_error;
        if (!validate_plate_operation_target(plate_id, revision, target_error))
            return error_json(target_error);
        std::string model_error;
        local_model = make_current_plate_model(*find_plate(plate_id), model_error);
        if (!local_model) return error_json(model_error);

        // A new slice invalidates both the old toolpath and its source text
        // before any work begins. The client must fetch a fresh result id.
        invalidate_preview_source();
        // libslic3r's internal phase reporting does not promise a final 100%
        // notification (the current FDM path often ends at 75%). Establish
        // stable operation boundaries for the UI around those detailed phases.
        begin_progress();
        // Start from the GUI's own baseline: real OrcaSlicer never slices on
        // bare full_print_config() defaults — it assembles the config from
        // the selected print/filament/printer presets (PresetBundle::
        // full_config, the mechanism slice_main.cpp's comment references).
        // Bare defaults are NOT validatable: default Marlin flavor with
        // use_relative_e_distances=1 requires "G92 E0" in the layer-change
        // gcode (Print.cpp:1746), which only printer presets supply — the
        // app's minimal config {} therefore failed validate() with exactly
        // that message. full_config() yields the complete option map the
        // same discipline expects (optptr() returns nullptr for missing keys
        // and Print::apply's normalize paths dereference that). The JSON
        // keys are applied on top, then normalized like slice_main.cpp:30.
        DynamicPrintConfig config = state().presets.full_config();
        const json cfg = json::parse(config_json ? config_json : "");
        // Fix round 2: thread ONE substitution context through every key so
        // keys that are unknown at the pinned SHA are surfaced instead of
        // silently dropped. ConfigBase::set_deserialize_nothrow (Config.cpp:
        // 580-593) calls handle_legacy(), which CLEARS keys it does not know
        // and records the source key in ConfigSubstitutionContext::
        // unrecogized_keys (Config.hpp:266 — the pinned source's spelling)
        // before returning true; the old set_deserialize_strict threw the
        // context away, so the smoke's pre-rename keys (temperature,
        // perimeters, bed_shape, ...) vanished without a trace and the slice
        // ran on defaults while reporting {"ok":true}. Disable keeps the
        // strict no-substitution semantics of the previous code.
        ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
        for (auto it = cfg.begin(); it != cfg.end(); ++it) {
            const std::string& key = it.key();
            std::string value;
            if (it.value().is_array()) {
                for (const auto& v : it.value()) {
                    if (!value.empty()) value += ",";
                    value += v.is_string() ? v.get<std::string>() : v.dump();
                }
            } else if (it.value().is_string()) {
                // JSON strings use "\\n" escapes; restore real newlines for
                // multi-line values (start_gcode etc.).
                value = it.value().get<std::string>();
                std::string unescaped;
                unescaped.reserve(value.size());
                for (size_t i = 0; i < value.size(); ++i) {
                    if (value[i] == '\\' && i + 1 < value.size() && value[i + 1] == 'n') {
                        unescaped.push_back('\n');
                        ++i;
                    } else {
                        unescaped.push_back(value[i]);
                    }
                }
                value = std::move(unescaped);
            } else if (it.value().is_boolean()) {
                value = it.value().get<bool>() ? "1" : "0";
            } else {
                value = it.value().dump();
            }
            // Fix round 2: per-key set_deserialize with the shared context.
            // This is the same strict-no-substitution behavior the old
            // set_deserialize_strict had (Config.hpp:2771 builds an internal
            // {Disable} context), but it does NOT throw the context away —
            // handle_legacy (Config.cpp:586-590) records every dropped key in
            // substitutions.unrecogized_keys, which we surface below.
            config.set_deserialize(key, value, substitutions);
        }
        // Project and plate overrides are canonical Worker state and win over
        // any legacy renderer payload supplied for this slice request.
        apply_overlay_to_config(config, state().project_config_overlay["project"]);
        if (const auto* plate = find_plate(plate_id)) {
            const auto plate_it = state().project_config_overlay["plates"].find(plate_id);
            if (plate_it != state().project_config_overlay["plates"].end())
                apply_overlay_to_config(config, plate_it.value());
        }
        config.normalize_fdm();
        // Fix round 3: validate() invariant guarantee. A Marlin flavor with
        // use_relative_e_distances=1 requires "G92 E0" in the layer-change
        // gcode (Print.cpp:1746); real OrcaSlicer machine presets carry it in
        // before_layer_change_gcode, but the WASM's un-curated default
        // selection may leave the baseline without it (see orc_init).
        // Inject the standard reset so ANY selection validates — the bridge
        // contract is "a slice request must slice", and this only fires for
        // configs that otherwise fail validate() outright. Explicit client
        // values that satisfy the invariant (klipper, rel-e=0, or their own
        // G92 E0) are untouched.
        {
            const auto* flavor = config.option<ConfigOptionEnum<GCodeFlavor>>("gcode_flavor");
            const bool marlin = flavor &&
                (flavor->value == gcfMarlinFirmware || flavor->value == gcfMarlinLegacy);
            if (marlin && config.opt_bool("use_relative_e_distances")) {
                const auto* before_opt = config.option<ConfigOptionString>("before_layer_change_gcode");
                const auto* layer_opt  = config.option<ConfigOptionString>("layer_change_gcode");
                const std::string before = before_opt ? before_opt->value : std::string();
                const std::string layer  = layer_opt ? layer_opt->value : std::string();
                if (before.find("G92 E0") == std::string::npos &&
                    layer.find("G92 E0") == std::string::npos)
                    config.set("before_layer_change_gcode", ";BEFORE_LAYER_CHANGE\n;[layer_z]\nG92 E0\n");
            }
        }

        // The native GUI sets this on BackgroundSlicingProcess before both
        // validation and processing.  The bridge bypasses that GUI layer, so
        // carry the active preset bundle's vendor identity across explicitly.
        // Without it Bambu G-code takes the non-Bambu nozzle/context path and
        // a successful P1P slice can later yield an empty preview.
        state().print.is_BBL_printer() = state().presets.is_bbl_vendor();
        // Apply and process the isolated local model.  `state().model` is the
        // authoritative world-space editing model and is never changed by a
        // slice operation.
        state().print.apply(*local_model, config);
        // Drift at the pinned SHA: validate() returns StringObjectException
        // (PrintBase.hpp:30); use its .string member (same adaptation as
        // slice_main.cpp:55).
        const StringObjectException validation_error = state().print.validate();
        if (!validation_error.string.empty()) return error_json(validation_error.string);

        // Drift at the pinned SHA: SlicingStatus is nested as
        // PrintBase::SlicingStatus (PrintBase.hpp:440), not a Slic3r-top-level
        // type — qualify it (status_callback_type is PrintBase's typedef too).
        state().print.set_status_callback([&](const PrintBase::SlicingStatus& st) {
            publish_slicer_progress(st.percent, st.text);
        });
#ifdef ORCA_WASM_THREADING
        // Keep every libslic3r parallel_for inside the same fixed-size arena.
        // This mirrors the known-good oneTBB probe and prevents oneTBB from
        // trying to use more workers than Emscripten pre-created.
        state().tbb_arena.execute([&] { state().print.process(); });
#else
        state().print.process();
#endif
        state().print.set_status_default();
        finish_progress();
        // Fix round 2: additive success field — always present, empty when the
        // config is clean. M2 clients (config UI) rely on this to warn about
        // keys the pinned libslic3r dropped (handle_legacy's catch-all).
        json dropped = json::array();
        for (const std::string& k : substitutions.unrecogized_keys)
            dropped.push_back(k);
        state().preview_plate_id = plate_id;
        state().preview_plate_revision = revision;
        return dup_json(json{{"ok", true}, {"unrecognized_keys", std::move(dropped)}}.dump());
    } catch (const std::exception& e) {
        stop_progress();
        // process() is where libslic3r throws SlicingErrors (GCode.cpp:2250);
        // the helper surfaces the per-object messages instead of the bare
        // category. This is the only bridge call that can throw it, so the
        // other catches keep plain e.what().
        return error_json_from_exception(e);
    } catch (...) {
        stop_progress();
        // Fix round 1: a canceled print (orc_cancel → PrintBase::cancel sets
        // CANCELED_BY_USER; only restart() clears it) makes the NEXT process()
        // abort — but the thrown type escaped the std::exception catch and
        // surfaced as an uncatchable CppException, killing the module (same
        // defect class as the stale progress callback). Emscripten -fexceptions
        // surfaces some C++ throws (and JS exceptions from imports) through a
        // non-std::exception path; a catch-all here keeps the API contract
        // "a call either returns JSON or the module stays alive".
        std::string msg = "unknown exception";
        try { throw; }
        catch (const std::string& s) { msg = s; }
        catch (const char* s) { msg = s ? s : "null"; }
        catch (...) {}
        return error_json(msg);
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_slice(const char* config_json) {
    ensure_plate_session_state();
    const auto revision = state().plate_input_revisions[state().current_plate_id];
    return slice_for_plate(config_json, state().current_plate_id, revision);
}

EMSCRIPTEN_KEEPALIVE const char* orc_slice_plate(const char* config_json,
                                                  const char* plate_id,
                                                  double revision_number) {
    try {
        if (!plate_id || !std::isfinite(revision_number) || revision_number < 0.0 ||
            std::floor(revision_number) != revision_number ||
            revision_number > static_cast<double>(std::numeric_limits<std::uint64_t>::max()))
            return error_json("invalid plate operation target");
        return slice_for_plate(config_json, plate_id,
                               static_cast<std::uint64_t>(revision_number));
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// ---- model triangle meshes + GUI transform synchronization ----

static json transform_json(const Slic3r::Geometry::Transformation& t) {
    const auto offset = t.get_offset();
    const auto rotation = t.get_rotation();
    const auto scale = t.get_scaling_factor();
    const auto mirror = t.get_mirror();
    const Slic3r::Matrix4d m = t.get_matrix().matrix();
    json j = {{"offset", {offset.x(), offset.y(), offset.z()}},
            {"rotation", {rotation.x(), rotation.y(), rotation.z()}},
            {"scale", {scale.x(), scale.y(), scale.z()}},
            {"mirror", {mirror.x(), mirror.y(), mirror.z()}}};
    // Emit the full affine matrix (column-major, three.js layout) so a
    // sheared transform survives a JS-side load/reload round-trip. The TRS
    // fields remain for clean transforms and the gizmo/panel display.
    j["matrix"] = {m(0,0), m(1,0), m(2,0), m(3,0),
                   m(0,1), m(1,1), m(2,1), m(3,1),
                   m(0,2), m(1,2), m(2,2), m(3,2),
                   m(0,3), m(1,3), m(2,3), m(3,3)};
    return j;
}

static Slic3r::Vec3d transform_vec3(const json& transform, const char* key) {
    const auto& v = transform.at(key);
    if (!v.is_array() || v.size() != 3)
        throw std::runtime_error(std::string("transform.") + key + " must be a 3-vector");
    return Slic3r::Vec3d(v[0].get<double>(), v[1].get<double>(), v[2].get<double>());
}

static void set_transform(Slic3r::Geometry::Transformation& target, const json& transform) {
    // A full matrix is authoritative — it can carry shear that T·R·S cannot.
    // set_matrix stores the matrix verbatim; get_rotation/get_scaling_factor
    // below decompose it for display, and the slicer consumes get_matrix().
    if (transform.contains("matrix") && transform["matrix"].is_array()) {
        const auto& a = transform["matrix"];
        if (a.size() != 16)
            throw std::runtime_error("transform.matrix must be 16 numbers");
        Slic3r::Matrix4d m;
        for (int col = 0; col < 4; ++col)
            for (int row = 0; row < 4; ++row)
                m(row, col) = a[col * 4 + row].get<double>();
        target.set_matrix(Slic3r::Transform3d(m));
        return;
    }
    target.set_offset(transform_vec3(transform, "offset"));
    target.set_rotation(transform_vec3(transform, "rotation"));
    target.set_scaling_factor(transform_vec3(transform, "scale"));
    target.set_mirror(transform_vec3(transform, "mirror"));
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_instance_offset(int object_idx, int instance_idx, double x, double y, double z) {
    try {
        auto& model = state().model;
        if (object_idx < 0 || object_idx >= static_cast<int>(model.objects.size()))
            return error_json("object index out of range");
        auto& obj = model.objects[static_cast<size_t>(object_idx)];
        if (instance_idx < 0 || instance_idx >= static_cast<int>(obj->instances.size()))
            return error_json("instance index out of range");
        // Drift surface: ModelInstance::set_offset(Vec3d) — confirm at SHA.
        auto* instance = obj->instances[static_cast<size_t>(instance_idx)];
        instance->set_offset(Slic3r::Vec3d(x, y, z));
        state().pending_membership_instance_ids.insert(instance->id().id);
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_model_transform(
    int object_idx, int volume_idx, int instance_idx,
    const char* instance_transform_json, const char* volume_transform_json) {
    try {
        auto& model = state().model;
        if (object_idx < 0 || object_idx >= static_cast<int>(model.objects.size()))
            return error_json("object index out of range");
        auto& object = model.objects[static_cast<size_t>(object_idx)];
        if (volume_idx < 0 || volume_idx >= static_cast<int>(object->volumes.size()))
            return error_json("volume index out of range");
        if (instance_idx < 0 || instance_idx >= static_cast<int>(object->instances.size()))
            return error_json("instance index out of range");
        auto instance_transform = json::parse(instance_transform_json ? instance_transform_json : "");
        auto volume_transform = json::parse(volume_transform_json ? volume_transform_json : "");
        auto instance = object->instances[static_cast<size_t>(instance_idx)]->get_transformation();
        auto volume = object->volumes[static_cast<size_t>(volume_idx)]->get_transformation();
        const auto previous_instance = instance;
        const auto previous_volume = volume;
        set_transform(instance, instance_transform);
        set_transform(volume, volume_transform);
        object->instances[static_cast<size_t>(instance_idx)]->set_transformation(instance);
        object->volumes[static_cast<size_t>(volume_idx)]->set_transformation(volume);
        object->invalidate_bounding_box();
        // Slicing synchronizes every rendered composite before starting the
        // job. Re-emitting an identical transform is not an editing
        // transaction and must not advance a plate's input revision; doing
        // so would make retained results on other plates look stale merely
        // because Preview switched plates and started its target slice.
        if (instance != previous_instance || volume != previous_volume)
            state().pending_membership_instance_ids.insert(
                object->instances[static_cast<size_t>(instance_idx)]->id().id);
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Read-only model structure: objects, their parts (volumes), and instances.
// Returns stable ObjectIDs (for React keys and selection restoration) plus
// current positional indices (for operation dispatch and display). Read-only,
// so it does not invalidate the current Print.
EMSCRIPTEN_KEEPALIVE const char* orc_get_model_structure() {
    try {
        return dup_json(json{{"ok", true}, {"objects", model_structure_json()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// -------------------------------------------------------------------------
// Step 2: non-destructive model metadata operations (stable ObjectID input).
// Every successful mutation invalidates the current Print/G-code result so
// the renderer cannot continue to display a stale slice. Resolving by stable
// IDs (rather than positional indices) means a structural mutation elsewhere
// cannot silently target the wrong entity — see spec/ObjectList-and-Parts.md §7.
// -------------------------------------------------------------------------

EMSCRIPTEN_KEEPALIVE const char* orc_rename_object(double object_id, const char* name_cstr) {
    try {
        const auto id = to_object_id(object_id);
        if (!id) return error_json("object id must be a positive integer");
        if (name_cstr == nullptr) return error_json("name is required");
        ModelObject* obj = find_object_by_id(*id);
        if (obj == nullptr) return error_json("object not found");
        obj->name = name_cstr;
        // A rename does not change geometry, but it does change the object's
        // reported name; the existing Print/G-code is still considered stale.
        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_rename_volume(double volume_id, const char* name_cstr) {
    try {
        const auto id = to_object_id(volume_id);
        if (!id) return error_json("volume id must be a positive integer");
        if (name_cstr == nullptr) return error_json("name is required");
        ModelVolume* vol = find_volume_by_id(*id);
        if (vol == nullptr) return error_json("volume not found");
        vol->name = name_cstr;
        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_volume_type(double volume_id, const char* type_cstr) {
    try {
        const auto id = to_object_id(volume_id);
        if (!id) return error_json("volume id must be a positive integer");
        if (type_cstr == nullptr) return error_json("type is required");
        const auto new_type = volume_type_from_string(type_cstr);
        if (!new_type) return error_json("invalid volume type");
        ModelVolume* vol = find_volume_by_id(*id);
        if (vol == nullptr) return error_json("volume not found");
        // Upstream last-solid-part guard (GUI_ObjectList): refuse to turn the
        // only MODEL_PART into a non-print volume.
        if (*new_type != ModelVolumeType::MODEL_PART && vol->is_the_only_one_part())
            return error_json("changing the last solid part is not allowed");
        vol->set_type(*new_type);
        // The type changes which volumes compose the print mesh; drop the cached
        // object bounds so a later getModelMesh / slice recomputes them.
        vol->get_object()->invalidate_bounding_box();
        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_object_printable(double object_id, double printable) {
    try {
        const auto id = to_object_id(object_id);
        if (!id) return error_json("object id must be a positive integer");
        ModelObject* obj = find_object_by_id(*id);
        if (obj == nullptr) return error_json("object not found");
        // Object row toggles are an aggregate: set the object-level gate AND
        // every instance so the per-instance rows and ModelInstance::is_printable()
        // stay consistent (model_object->printable is an extra gate that would
        // otherwise disagree with the per-instance flags).
        const bool value = printable != 0.0;
        obj->printable = value;
        for (auto& inst : obj->instances)
            inst->printable = value;
        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_instance_printable(double instance_id, double printable) {
    try {
        const auto id = to_object_id(instance_id);
        if (!id) return error_json("instance id must be a positive integer");
        ModelInstance* inst = find_instance_by_id(*id);
        if (inst == nullptr) return error_json("instance not found");
        inst->printable = printable != 0.0;
        state().print.clear();
        invalidate_preview_source();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_model_mesh() {
    try {
        auto& model = state().model;
        json arr = json::array();
        for (size_t oi = 0; oi < model.objects.size(); ++oi) {
            const auto& obj = model.objects[oi];
            // LOCAL (volume-transformed, instance-untouched) vertices: the
            // instance offset is reported separately below and the renderer
            // applies it as the group position. Baking instance transforms
            // here (ModelObject::mesh()) double-offsets the model after any
            // committed move + reload — a zero offset hid it at load time
            // (see the mock-module contract comment).
            for (size_t vi = 0; vi < obj->volumes.size(); ++vi) {
                const auto& its = obj->volumes[vi]->mesh().its;
                for (size_t ii = 0; ii < obj->instances.size(); ++ii) {
                    MallocBuffer vbuf;
                    MallocBuffer ibuf;
                    for (const auto& v : its.vertices) {
                        vbuf.appendF32(v.x()); vbuf.appendF32(v.y()); vbuf.appendF32(v.z());
                    }
                    for (const auto& tri : its.indices) {
                        ibuf.appendU32(static_cast<std::uint32_t>(tri[0]));
                        ibuf.appendU32(static_cast<std::uint32_t>(tri[1]));
                        ibuf.appendU32(static_cast<std::uint32_t>(tri[2]));
                    }
                    const std::uintptr_t vptr = reinterpret_cast<std::uintptr_t>(vbuf.data);
                    const std::uintptr_t iptr = reinterpret_cast<std::uintptr_t>(ibuf.data);
                    vbuf.release(); ibuf.release();
                    const auto& instance = obj->instances[ii]->get_transformation();
                    const auto& volume = obj->volumes[vi]->get_transformation();
                    arr.push_back(json{{"object_idx", oi}, {"volume_idx", vi}, {"instance_idx", ii},
                        {"vertex_ptr", vptr}, {"vertex_count", its.vertices.size()},
                        {"index_ptr", iptr}, {"index_count", its.indices.size() * 3},
                        {"offset", {instance.get_offset().x(), instance.get_offset().y(), instance.get_offset().z()}},
                        {"instance_transform", transform_json(instance)},
                        {"volume_transform", transform_json(volume)}});
                }
            }
        }
        return dup_json(json{{"ok", true}, {"objects", std::move(arr)}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

// Binary preview result. v2 publishes explicit continuous segments as
// structure-of-arrays buffers. The returned pointers are transferred exactly
// once to the Worker client; that client copies each array and frees the
// corresponding heap allocation immediately (the JSON itself is freed by the
// normal callJson path).
EMSCRIPTEN_KEEPALIVE const char* orc_get_slice_result() {
    try {
        auto& print = state().print;
        if (print.objects().empty()) {
            invalidate_preview_source();
            json empty_toolpath{{"segment_count", 0},
                                {"starts_ptr", 0}, {"ends_ptr", 0},
                                {"layer_id_ptr", 0}, {"move_order_ptr", 0},
                                {"gcode_id_ptr", 0}, {"move_type_ptr", 0},
                                {"extrusion_role_ptr", 0}, {"extruder_id_ptr", 0},
                                {"color_print_id_ptr", 0}, {"width_ptr", 0}, {"height_ptr", 0},
                                // v1 aliases, retained until the renderer
                                // migration is complete.
                                {"vertex_ptr", 0}, {"vertex_count", 0},
                                {"layer_ptr", 0}, {"layer_count", 0},
                                {"feature_ptr", 0}, {"feature_count", 0},
                                {"features", json::array()}, {"metrics", json::object()}};
            return dup_json(json{{"ok", true}, {"preview_version", 2},
                                 {"objects", 0}, {"layers", 0},
                                 {"metadata", json{{"result_id", 0}, {"layer_ranges", json::array()},
                                                    {"feature_palette", json::array()},
                                                    {"source_text", json{{"available", false}, {"byte_length", 0}}}}},
                                 {"toolpath", std::move(empty_toolpath)}}.dump());
        }

        // The toolpath comes from post-processing the exported gcode
        // (GCodeProcessor::process_file — the GUI's own mechanism). Export
        // happens here so getSliceResult is self-contained; the client's
        // exportGcode() later reads the same /out.gcode via FS. Drift
        // surface: process_file/get_result signatures (Step 1).
        print.export_gcode("/out.gcode", nullptr, nullptr);

        Slic3r::GCodeProcessorResult gcode_result;
        {
            Slic3r::GCodeProcessor processor;
            processor.process_file("/out.gcode");
            gcode_result = processor.get_result();
        }
        {
            auto& bridge_state = state();
            bridge_state.preview_result_id = gcode_result.id;
            bridge_state.preview_gcode_path = "/out.gcode";
            std::ifstream source(bridge_state.preview_gcode_path, std::ios::binary | std::ios::ate);
            bridge_state.preview_text_available = source.good();
            bridge_state.preview_gcode_size = source.good()
                ? static_cast<std::size_t>(source.tellg())
                : 0;
            bridge_state.preview_gcode_line_ends.assign(gcode_result.lines_ends.begin(), gcode_result.lines_ends.end());
        }
        auto tp = bridge::build_toolpath(gcode_result);
        const auto analysis = bridge::build_preview_analysis(gcode_result, tp);
        // Layer count = max layer id present in the toolpath + 1. The gcode
        // spans the whole plate, so this covers every object's height — the
        // previous objects().front() cap hid taller objects' extra layers.
        const size_t layers = tp.layerCount;

        // Feature palette (local id → name/color). build_toolpath assigns
        // ids 0..N-1 in order of first use; the compatibility feature buffer
        // and the v2 extrusion_roles array both remain stable across calls.
        json features = json::array();
        json feature_palette = json::array();
        for (const auto& [role, info] : tp.palette_used) {
            const auto id = static_cast<int>(features.size());
            features.push_back({{"id", id}, {"name", info.name},
                                {"color", {info.color[0], info.color[1], info.color[2]}}});
            feature_palette.push_back({{"id", id}, {"role", static_cast<unsigned>(role)},
                                       {"name", info.name},
                                       {"color", {info.color[0], info.color[1], info.color[2]}}});
        }

        json layer_ranges = json::array();
        for (const auto& range : tp.layer_ranges)
            if (range.count > 0)
                layer_ranges.push_back({{"id", range.id}, {"z", range.z},
                                         {"first_segment", range.first},
                                         {"segment_count", range.count}});

        // GCodeProcessorResult keeps the configured filament colours parsed
        // from the completed G-code and the selected filament preset names.
        // Tool ids are stable zero-based indices. An undecodable source color
        // is omitted rather than replaced with an invented value.
        json extruder_palette = json::array();
        for (size_t tool = 0; tool < gcode_result.extruder_colors.size(); ++tool) {
            ColorRGB color;
            if (!decode_color(gcode_result.extruder_colors[tool], color)) continue;
            const std::string name = tool < gcode_result.settings_ids.filament.size() &&
                    !gcode_result.settings_ids.filament[tool].empty()
                ? gcode_result.settings_ids.filament[tool]
                : "Tool " + std::to_string(tool + 1);
            extruder_palette.push_back({
                {"id", tool}, {"tool", tool}, {"name", name},
                {"color", {color.r_uchar(), color.g_uchar(), color.b_uchar()}},
            });
        }

        auto ptr = [](const MallocBuffer& buffer) -> std::uintptr_t {
            return reinterpret_cast<std::uintptr_t>(buffer.data);
        };
        json metrics = {
            {"feedrate", { {"ptr", ptr(tp.feedrates)}, {"count", tp.segmentCount} }},
            {"actual_feedrate", { {"ptr", ptr(tp.actual_feedrates)}, {"count", tp.segmentCount} }},
            {"volumetric_flow", { {"ptr", ptr(tp.volumetric_flows)}, {"count", tp.segmentCount} }},
            {"actual_volumetric_flow", { {"ptr", ptr(tp.actual_volumetric_flows)}, {"count", tp.segmentCount} }},
            {"fan_speed", { {"ptr", ptr(tp.fan_speeds)}, {"count", tp.segmentCount} }},
            {"temperature", { {"ptr", ptr(tp.temperatures)}, {"count", tp.segmentCount} }},
            {"pressure_advance", { {"ptr", ptr(tp.pressure_advances)}, {"count", tp.segmentCount} }},
            {"acceleration", { {"ptr", ptr(tp.accelerations)}, {"count", tp.segmentCount} }},
            {"jerk", { {"ptr", ptr(tp.jerks)}, {"count", tp.segmentCount} }},
            {"time", { {"ptr", ptr(tp.times)}, {"count", tp.segmentCount} }},
            {"layer_duration", { {"ptr", ptr(tp.layer_durations)}, {"count", tp.segmentCount} }},
        };

        // wasm64: heap pointers as uintptr_t (see orc_get_model_mesh).
        const std::uintptr_t tvptr = ptr(tp.positions);
        const std::uintptr_t ts = ptr(tp.starts);
        const std::uintptr_t te = ptr(tp.ends);
        const std::uintptr_t tlptr = reinterpret_cast<std::uintptr_t>(tp.layers.data);
        const std::uintptr_t tfptr = reinterpret_cast<std::uintptr_t>(tp.features.data);
        const size_t n_verts = tp.positions.size / 12;

        json out{{"ok", true}, {"preview_version", 2},
                 {"objects", print.objects().size()}, {"layers", layers}};
        out["metadata"] = {
            {"result_id", gcode_result.id}, {"source_filename", gcode_result.filename},
            {"layer_ranges", std::move(layer_ranges)},
            {"feature_palette", std::move(feature_palette)},
            // Full G-code text is intentionally not copied. gcode_ids are
            // source-line identifiers; lines_ends records that source mapping
            // is available for a future chunked text API.
            {"source_line_mapping", json{{"available", !gcode_result.lines_ends.empty()},
                                           {"line_count", gcode_result.lines_ends.size()}}},
            {"source_text", json{{"available", state().preview_text_available},
                                  {"byte_length", state().preview_gcode_size}}},
        };
        if (!extruder_palette.empty()) out["metadata"]["extruder_palette"] = std::move(extruder_palette);
        json summary = json::object();
        if (analysis.has_estimated_time) summary["estimated_time_seconds"] = analysis.estimated_time_seconds;
        if (analysis.has_filament_length) summary["filament_length_meters"] = analysis.filament_length_meters;
        if (analysis.has_filament_weight) summary["filament_weight_grams"] = analysis.filament_weight_grams;
        if (analysis.has_filament_cost) summary["filament_cost"] = analysis.filament_cost;
        json feature_statistics = json::array();
        for (const auto& stats : analysis.feature_statistics) {
            json entry{{"feature_id", stats.feature_id}};
            if (stats.has_time) entry["time_seconds"] = stats.time_seconds;
            if (stats.has_filament) {
                entry["filament_length_meters"] = stats.filament_length_meters;
                entry["filament_weight_grams"] = stats.filament_weight_grams;
            }
            feature_statistics.push_back(std::move(entry));
        }
        out["metadata"]["analysis"] = {
            {"summary", std::move(summary)},
            {"feature_statistics", std::move(feature_statistics)},
        };
        out["toolpath"] = {
            {"segment_count", tp.segmentCount},
            {"starts_ptr", ts}, {"ends_ptr", te},
            {"layer_id_ptr", ptr(tp.layers)}, {"move_order_ptr", ptr(tp.move_orders)},
            {"gcode_id_ptr", ptr(tp.gcode_ids)}, {"move_type_ptr", ptr(tp.move_types)},
            {"extrusion_role_ptr", ptr(tp.extrusion_roles)},
            {"extruder_id_ptr", ptr(tp.extruders)},
            {"color_print_id_ptr", ptr(tp.color_prints)},
            {"width_ptr", ptr(tp.widths)}, {"height_ptr", ptr(tp.heights)},
            {"metrics", std::move(metrics)},
            {"vertex_ptr", tvptr}, {"vertex_count", n_verts},
            {"layer_ptr", ptr(tp.layers)}, {"layer_count", n_verts},
            {"feature_ptr", tfptr}, {"feature_count", n_verts},
            {"features", std::move(features)},
        };
        // Every pointer above is released after it has been recorded. JS now
        // owns the corresponding bytes and must _free() each exactly once.
        tp.starts.release(); tp.ends.release(); tp.positions.release();
        tp.layers.release(); tp.move_orders.release(); tp.gcode_ids.release();
        tp.move_types.release(); tp.extrusion_roles.release(); tp.extruders.release();
        tp.color_prints.release(); tp.widths.release(); tp.heights.release();
        tp.features.release(); tp.feedrates.release(); tp.actual_feedrates.release();
        tp.volumetric_flows.release(); tp.actual_volumetric_flows.release();
        tp.fan_speeds.release(); tp.temperatures.release(); tp.pressure_advances.release();
        tp.accelerations.release(); tp.jerks.release(); tp.times.release();
        tp.layer_durations.release();
        return dup_json(out.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

// Read a bounded byte range from the current completed result's exported
// G-code. The source is kept in MEMFS and opened only for this request; the
// initial preview payload contains metadata and line identifiers, never the
// complete text. `offset` and `length` are doubles at the Emscripten ABI so
// wasm32/wasm64 callers share one signature; both are validated as exact,
// non-negative integers before conversion.
EMSCRIPTEN_KEEPALIVE const char* orc_read_gcode_chunk(double result_id_number,
                                                      double offset_number,
                                                      double length_number) {
    try {
        constexpr std::size_t max_chunk_bytes = 64 * 1024;
        constexpr std::size_t max_alignment_overrun_bytes = 3;
        constexpr std::size_t max_response_bytes = max_chunk_bytes + max_alignment_overrun_bytes * 2;
        auto& bridge_state = state();
        const auto valid_integer = [](double value) {
            return std::isfinite(value) && value >= 0.0 &&
                   std::floor(value) == value &&
                   value <= static_cast<double>(std::numeric_limits<std::size_t>::max());
        };
        if (!valid_integer(result_id_number) || !valid_integer(offset_number) ||
            !valid_integer(length_number))
            return dup_json(json{{"ok", false}, {"error", "invalid chunk range"}}.dump());

        if (result_id_number > static_cast<double>(std::numeric_limits<std::uint32_t>::max()))
            return dup_json(json{{"ok", false}, {"error", "invalid result id"}}.dump());
        const auto result_id = static_cast<std::uint32_t>(result_id_number);
        const auto requested_offset = static_cast<std::size_t>(offset_number);
        const auto requested_length = static_cast<std::size_t>(length_number);
        if (result_id == 0 || result_id != bridge_state.preview_result_id ||
            !bridge_state.preview_text_available)
            return dup_json(json{{"ok", false}, {"error", "preview text is unavailable"}}.dump());
        if (requested_length > max_chunk_bytes || requested_offset > bridge_state.preview_gcode_size)
            return dup_json(json{{"ok", false}, {"error", "chunk range is outside the preview text"}}.dump());

        // Align the returned bytes to UTF-8 code-point boundaries. A caller
        // may request arbitrary byte offsets (for example after estimating a
        // virtualized line viewport), so include up to three preceding bytes
        // and up to three continuation bytes after the requested range.
        std::size_t actual_offset = requested_offset;
        std::size_t actual_end = std::min(bridge_state.preview_gcode_size,
                                          requested_offset + requested_length);
        std::ifstream source(bridge_state.preview_gcode_path, std::ios::binary);
        if (!source.good())
            return dup_json(json{{"ok", false}, {"error", "preview text could not be opened"}}.dump());
        auto read_byte = [&](std::size_t position, unsigned char& value) {
            source.clear();
            source.seekg(static_cast<std::streamoff>(position), std::ios::beg);
            char byte = 0;
            if (!source.get(byte)) return false;
            value = static_cast<unsigned char>(byte);
            return true;
        };
        if (requested_length > 0 && actual_offset > 0) {
            unsigned char byte = 0;
            std::size_t continuation_bytes = 0;
            while (actual_offset > 0 && continuation_bytes < max_alignment_overrun_bytes && read_byte(actual_offset, byte) &&
                   (byte & 0xc0u) == 0x80u)
                --actual_offset, ++continuation_bytes;
        }
        if (requested_length > 0 && actual_end < bridge_state.preview_gcode_size) {
            unsigned char byte = 0;
            while (actual_end < bridge_state.preview_gcode_size &&
                   actual_end < requested_offset + requested_length + max_alignment_overrun_bytes &&
                   read_byte(actual_end, byte) && (byte & 0xc0u) == 0x80u)
                ++actual_end;
        }
        const auto byte_count = actual_end - actual_offset;
        if (byte_count > max_response_bytes)
            return dup_json(json{{"ok", false}, {"error", "aligned chunk exceeds bounded response"}}.dump());
        auto* bytes = static_cast<std::uint8_t*>(std::malloc(byte_count == 0 ? 1 : byte_count));
        if (byte_count > 0) {
            source.clear();
            source.seekg(static_cast<std::streamoff>(actual_offset), std::ios::beg);
            source.read(reinterpret_cast<char*>(bytes), static_cast<std::streamsize>(byte_count));
            if (source.gcount() != static_cast<std::streamsize>(byte_count)) {
                std::free(bytes);
                return dup_json(json{{"ok", false}, {"error", "preview text read failed"}}.dump());
            }
        }
        return dup_json(json{{"ok", true}, {"result_id", bridge_state.preview_result_id},
                             {"offset", actual_offset}, {"length", byte_count},
                             {"eof", actual_end >= bridge_state.preview_gcode_size},
                             {"bytes_ptr", reinterpret_cast<std::uintptr_t>(bytes)},
                             {"bytes_length", byte_count}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

// Read a seekable bounded page of complete source lines. The line-end table
// stays in the bridge's current result; only the requested bytes cross the
// seam, so late-line inspection never walks or copies the preceding file.
EMSCRIPTEN_KEEPALIVE const char* orc_read_gcode_lines(double result_id_number,
                                                      double start_line_number,
                                                      double line_count_number) {
    try {
        constexpr std::size_t max_line_count = 128;
        constexpr std::size_t max_page_bytes = 64 * 1024;
        auto& bridge_state = state();
        const auto valid_integer = [](double value) {
            return std::isfinite(value) && value >= 0.0 &&
                   std::floor(value) == value &&
                   value <= static_cast<double>(std::numeric_limits<std::size_t>::max());
        };
        if (!valid_integer(result_id_number) || !valid_integer(start_line_number) ||
            !valid_integer(line_count_number) ||
            result_id_number > static_cast<double>(std::numeric_limits<std::uint32_t>::max()))
            return dup_json(json{{"ok", false}, {"error", "invalid source line page"}}.dump());
        const auto result_id = static_cast<std::uint32_t>(result_id_number);
        const auto start_line = static_cast<std::size_t>(start_line_number);
        const auto line_count = static_cast<std::size_t>(line_count_number);
        if (result_id == 0 || result_id != bridge_state.preview_result_id ||
            !bridge_state.preview_text_available)
            return dup_json(json{{"ok", false}, {"error", "preview text is unavailable"}}.dump());
        if (line_count == 0 || line_count > max_line_count ||
            start_line == 0 || start_line > bridge_state.preview_gcode_line_ends.size())
            return dup_json(json{{"ok", false}, {"error", "source line page is outside the preview"}}.dump());
        const auto end_line = std::min(bridge_state.preview_gcode_line_ends.size(),
                                      start_line + line_count - 1);
        const auto start_byte = start_line == 1 ? 0 : bridge_state.preview_gcode_line_ends[start_line - 2];
        const auto end_byte = bridge_state.preview_gcode_line_ends[end_line - 1];
        if (start_byte > end_byte || end_byte > bridge_state.preview_gcode_size ||
            end_byte - start_byte > max_page_bytes)
            return dup_json(json{{"ok", false}, {"error", "source line page exceeds byte bound"}}.dump());
        std::ifstream source(bridge_state.preview_gcode_path, std::ios::binary);
        if (!source.good())
            return dup_json(json{{"ok", false}, {"error", "preview text could not be opened"}}.dump());
        const auto byte_count = end_byte - start_byte;
        auto* bytes = static_cast<std::uint8_t*>(std::malloc(byte_count == 0 ? 1 : byte_count));
        source.seekg(static_cast<std::streamoff>(start_byte), std::ios::beg);
        if (byte_count > 0) {
            source.read(reinterpret_cast<char*>(bytes), static_cast<std::streamsize>(byte_count));
            if (source.gcount() != static_cast<std::streamsize>(byte_count)) {
                std::free(bytes);
                return dup_json(json{{"ok", false}, {"error", "preview text read failed"}}.dump());
            }
        }
        return dup_json(json{{"ok", true}, {"result_id", bridge_state.preview_result_id},
                             {"start_line", start_line}, {"line_count", end_line - start_line + 1},
                             {"eof", end_line == bridge_state.preview_gcode_line_ends.size()},
                             {"bytes_ptr", reinterpret_cast<std::uintptr_t>(bytes)},
                             {"bytes_length", byte_count}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

const char* export_gcode_for_target(const std::string& plate_id,
                                    const std::uint64_t revision) {
    try {
        std::string target_error;
        if (!validate_plate_operation_target(plate_id, revision, target_error))
            return error_json(target_error);
        if (state().preview_plate_id != plate_id || state().preview_plate_revision != revision)
            return error_json("plate slice result is stale or unavailable");
        const std::string path = "/out.gcode";
        state().print.export_gcode(path, nullptr, nullptr);
        return dup_json(json{{"ok", true}, {"path", path}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_export_gcode() {
    ensure_plate_session_state();
    try {
        const std::string path = "/out.gcode";
        state().print.export_gcode(path, nullptr, nullptr);
        return dup_json(json{{"ok", true}, {"path", path}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_export_gcode_plate(const char* plate_id,
                                                         double revision_number) {
    try {
        if (!plate_id || !std::isfinite(revision_number) || revision_number < 0.0 ||
            std::floor(revision_number) != revision_number ||
            revision_number > static_cast<double>(std::numeric_limits<std::uint64_t>::max()))
            return error_json("invalid plate operation target");
        return export_gcode_for_target(plate_id,
                                       static_cast<std::uint64_t>(revision_number));
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_cancel() {
    try {
        invalidate_preview_source();
        state().print.cancel();
        // Fix round 1: the bridge is strictly synchronous — JS cannot reenter
        // wasm while orc_slice is running, so a cancel can never interrupt an
        // in-flight slice. A surviving CANCELED_BY_USER flag (only restart()
        // clears it, PrintBase.hpp) makes the NEXT orc_slice's process()
        // throw CanceledException, which on Emscripten's -fexceptions runtime
        // surfaces as an uncatchable CppException that kills the module
        // (observed deterministically; the throw is caught and rethrown by
        // libslic3r internals, and the rethrow carries poisoned EH state).
        // So for v1, cancel is a state reset: it must never poison the module.
        state().print.restart();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return error_json("unknown C++ exception");
    }
}

// Lightweight build/runtime diagnostic for the worker client and smoke tests.
// It does not initialize presets or mutate the model, so it is safe to query
// before normal bridge setup.
EMSCRIPTEN_KEEPALIVE const char* orc_get_threading_info() {
#ifdef ORCA_WASM_THREADING
    return dup_json(json{{"ok", true}, {"threaded", true},
                         {"max_concurrency", state().tbb_max_concurrency},
                         {"arena_concurrency", state().tbb_arena.max_concurrency()}}.dump());
#else
    return dup_json(json{{"ok", true}, {"threaded", false},
                         {"max_concurrency", 1}, {"arena_concurrency", 1}}.dump());
#endif
}

}  // extern "C"
