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
#include <emscripten/threading.h>

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
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "libslic3r/AppConfig.hpp"
#include "libslic3r/BuildVolume.hpp"
#include "libslic3r/Color.hpp"
#include "libslic3r/Exception.hpp"
#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/miniz_extension.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/PresetBundle.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/TriangleMesh.hpp"
#include "libslic3r/Utils.hpp"

#include "bridge_buffers.hpp"
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

namespace {

#ifdef ORCA_WASM_THREADING
// Match the pre-created Emscripten pool. This API returns the runtime's
// navigator.hardwareConcurrency value; keep a nonzero fallback for unusual
// hosts.
int wasm_tbb_concurrency()
{
    return std::max(1, emscripten_num_logical_cores());
}
#endif

// Module-global state. orc_init() (re)creates the preset bundle.
//
// Drift at the pinned SHA (build-system level): bridge.cpp.o is linked before
// the libslic3r archive, so module-scope globals here construct BEFORE
// PrintConfig.cpp's `print_config_def` global — and PresetBundle's constructor
// chain (PresetCollection -> FullPrintConfig::defaults() -> print_config_def)
// reads it. Native OrcaSlicer never keeps a module-scope PresetBundle. Keep
// the state in a lazily-constructed holder instead: it is created on the
// first orc_* call (after all TUs' statics, including print_config_def, have
// run) — observed as "memory access out of bounds" at instantiation when
// constructed eagerly.
struct BridgeState {
#ifdef ORCA_WASM_THREADING
    // Match the pre-created Emscripten pthread pool at runtime. This avoids a
    // fixed compile-time cap while ensuring oneTBB never asks for more worker
    // threads than the loader supplied.
    const int tbb_max_concurrency = wasm_tbb_concurrency();
    tbb::global_control tbb_concurrency{
        tbb::global_control::max_allowed_parallelism,
        static_cast<std::size_t>(tbb_max_concurrency)};
    tbb::task_arena tbb_arena{tbb_max_concurrency};
#endif
    AppConfig profile_config;
    PresetBundle presets;
    Model       model;
    Print       print;
    // The current completed preview owns the exported G-code in MEMFS. Keep
    // only its identity and file metadata here: full source text must never
    // be copied into the initial preview JSON or retained as a second string.
    std::uint32_t preview_result_id = 0;
    std::string preview_gcode_path;
    std::size_t preview_gcode_size = 0;
    std::vector<std::size_t> preview_gcode_line_ends;
    bool preview_text_available = false;
    // The current result is deliberately single-plate until Step 8 adds the
    // per-plate result cache.  Keep its operation identity beside the result
    // so export cannot accidentally consume a result for another plate or
    // revision after selection/editing races.
    std::string preview_plate_id;
    std::uint64_t preview_plate_revision = 0;
    // Runtime-only identity for the headless plate session. These records are
    // deliberately independent from native plate_index values and are never
    // persisted. Membership is derived from the live Model, not maintained by
    // the renderer.
    struct PlateSessionPlate {
        std::string id;
        std::string name;
        int display_index = 0;
        Vec3d origin = Vec3d::Zero();
        bool locked = false;
        DynamicPrintConfig settings;
        json settings_metadata = json::object();
        // Ordered key/value records retain unknown native metadata without
        // colliding with the bridge's own schema.  Values are intentionally
        // strings because that is the native model_settings.config wire type.
        json opaque_metadata = json::array();
        // Future Neo per-plate fields are copied through without interpreting
        // them, so newer producers can round-trip them through this version.
        json future_metadata = json::object();
    };
    std::vector<PlateSessionPlate> plate_session_plates;
    std::string current_plate_id;
    std::map<std::size_t, std::string> instance_plate_ids;
    std::map<std::string, std::set<std::size_t>> plate_out_of_bounds_ids;
    std::set<std::size_t> parked_instance_ids;
    // Instances touched by a pending committed transform.  The renderer may
    // send one setModelTransform call per composite, but recomputation is
    // deliberately deferred until the complete global operation has settled.
    std::set<std::size_t> pending_membership_instance_ids;
    // Per-plate slice-input generations.  Selection and preview-only reads do
    // not advance these values; a committed model/configuration mutation does
    // so only for plates containing an instance before or after the command.
    std::map<std::string, std::uint64_t> plate_input_revisions;
};
BridgeState& state() { static BridgeState s; return s; }

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

json config_metadata_json(const DynamicPrintConfig& config)
{
    json out = json::object();
    for (const std::string& key : config.keys()) {
        try { out[key] = config.opt_serialize(key); }
        catch (...) { /* an unknown future option remains in opaque data */ }
    }
    return out;
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
    s.plate_session_plates.clear();
    s.instance_plate_ids.clear();
    s.plate_out_of_bounds_ids.clear();
    s.parked_instance_ids.clear();
    s.pending_membership_instance_ids.clear();
    s.plate_input_revisions.clear();

    const size_t count = std::max<size_t>(1, raw_records.empty() ? native_data.size() : raw_records.size());
    const PlateBounds bounds = selected_plate_bounds();
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
        s.plate_input_revisions[plate.id] = 0;
        s.plate_session_plates.push_back(std::move(plate));
    }
    if (neo_metadata) {
        const auto& records = (*neo_metadata)["plates"];
        for (size_t i = 0; i < records.size() && i < s.plate_session_plates.size(); ++i) {
            auto& plate = s.plate_session_plates[i];
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
    s.current_plate_id = s.plate_session_plates[current_index].id;
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
                {"unprintable", parked || plate_id.empty()},
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
json preset_entry_json(const Preset& preset, const PresetCollection& collection) {
    json entry{{"name", preset.name},
               {"is_visible", preset.is_visible},
               {"is_default", preset.is_default},
               {"selected", preset.name == collection.get_selected_preset_name()}};
    entry["vendor_id"] = preset.vendor ? preset.vendor->id : "";
    entry["model"]     = preset.config.opt_string("printer_model");
    entry["variant"]   = preset.config.opt_string("printer_variant");
    return entry;
}

json preset_candidates_json(const PresetCollection& collection, bool require_compatible) {
    json candidates = json::array();
    // begin()/end() intentionally omit generated "- default -" presets.
    // Keep the collection order: it is the engine's candidate ordering and
    // must not be re-sorted by an application-layer policy.
    for (auto it = collection.begin(); it != collection.end(); ++it) {
        if (!it->is_visible || (require_compatible && !it->is_compatible))
            continue;
        candidates.push_back(preset_entry_json(*it, collection));
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
                {"filaments", preset_candidates_json(state().presets.filaments, true)},
                {"printer", preset_selection_json(state().presets.printers)},
                {"print", preset_selection_json(state().presets.prints)},
                {"filament", preset_selection_json(state().presets.filaments)},
                {"printable_area", selected_printer_printable_area_json()}};
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

}  // namespace

extern "C" {

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
        else if (kind == "filament")coll = &state().presets.filaments;
        else if (kind == "printer") coll = &state().presets.printers;
        else return error_json("kind must be print|filament|printer");
        Preset* requested = coll->find_preset(name);
        if (requested == nullptr)
            return error_json("preset not found: " + name);
        if (!requested->is_visible)
            return error_json("preset is not visible: " + name);
        // A printer has no compatibility context.  Print and filament names
        // must already be candidates for the current engine-resolved printer
        // (and, for filament, current process) before they may be selected.
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

// Load a BBS 3MF into either a replacement project or an appended,
// geometry-only import.  Parsing and all candidate preset work happen against
// temporary objects first.  The live model/preset bundle is touched only
// after every required step succeeds, so malformed archives and future
// cancellation paths cannot leave a half-loaded session behind.
EMSCRIPTEN_KEEPALIVE const char* orc_load_project(const char* data, int len,
                                                   int geometry_only,
                                                   const char* display_name) {
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

        const auto model_config = read_archive_entry(path, "Metadata/model_settings.config");
        const auto neo_entry = read_archive_entry(path, kNeoPlateMetadataEntry);
        std::optional<json> neo_metadata;
        if (neo_entry) neo_metadata = parse_neo_plate_metadata(*neo_entry);
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
        if (!loaded || imported.objects.empty())
            throw Slic3r::RuntimeError("Loading of a project file failed.");
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

        PresetBundle candidate = state().presets;
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
            // The GUI refreshes its active preset controls after this native
            // load.  Re-run the bridge's authoritative compatibility pass so
            // stale selections from the previous project cannot survive a
            // printer replacement.
            candidate.update_compatible(PresetSelectCompatibleType::Always);
            candidate.update_multi_material_filament_presets();
        }

        ProjectPresetWarningDetails warning_details;
        if (!geometry_only)
            warning_details = inspect_project_preset_warnings(
                candidate, imported_config, project_presets, load_path);

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
            state().model = std::move(imported);
            state().presets = candidate;
        }
        state().print.clear();
        invalidate_preview_source();
        if (!geometry_only) {
            initialize_plate_session_from_records(plate_data, raw_records, neo_metadata);
            // Results are deliberately not loaded from PlateData. Membership
            // is recomputed from the imported world geometry after the fresh
            // runtime identities and native plate order are established.
            rebuild_plate_membership(true);
        } else {
            rebuild_plate_membership(true);
        }

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

void begin_progress()
{
    std::lock_guard<std::mutex> lock(g_progress_mailbox_mutex);
    g_progress_open = true;
    publish_progress_locked(0, "Preparing slice");
}

void publish_slicer_progress(int percent, std::string_view text)
{
    std::lock_guard<std::mutex> lock(g_progress_mailbox_mutex);
    if (g_progress_open)
        publish_progress_locked(percent, text);
}

void finish_progress()
{
    std::lock_guard<std::mutex> lock(g_progress_mailbox_mutex);
    // Close before the terminal write. A status callback that reaches us
    // later must acquire this same mutex and therefore cannot overwrite 100%.
    g_progress_open = false;
    publish_progress_locked(100, "Slice complete");
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
#ifndef ORCA_WASM_THREADING
            if (g_progress) g_progress(st.percent, st.text.c_str());
#endif
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
