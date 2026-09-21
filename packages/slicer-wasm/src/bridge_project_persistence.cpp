// ----------------------------------------------------------------
// Project archive persistence for the Neo WASM bridge.
// ----------------------------------------------------------------
#include "bridge_project_persistence.hpp"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "bridge_filament.hpp"
#include "bridge_history.hpp"
#include "bridge_model_operations.hpp"
#include "bridge_plate.hpp"
#include "bridge_profiles.hpp"
#include "bridge_prime_tower.hpp"
#include "bridge_slicing_pipeline.hpp"
#include "libslic3r/Exception.hpp"
#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/miniz_extension.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/Utils.hpp"
#include "nlohmann/json.hpp"

#ifdef ORCA_WASM_THREADING
#include <tbb/task_arena.h>
#endif

#include <emscripten/emscripten.h>

using namespace Slic3r;
using nlohmann::json;

namespace Slic3r::Neo::Bridge::ProjectPersistence {

using Neo::Bridge::BridgeState;
using Neo::Bridge::state;
using Neo::Bridge::Filament::State::config_metadata_json;
using Neo::Bridge::Filament::State::history_state_json;
using Neo::Bridge::HistoryMetadata::default_history_context;
using Neo::Bridge::HistoryMetadata::history_status_json;
using Neo::Bridge::Profiles::preset_snapshot_json;
using namespace Neo::Bridge::ModelOperations;
using namespace Neo::Bridge::PlateSession;
using namespace Neo::Bridge::SlicingPipeline;

static constexpr int kMaxPlateCount = 36;

// BBS project_settings.config already stores the merged native PrintConfig.
// Keep a native marker there for the additional local Project keys which are
// outside PresetBundle's historical s_project_options list. The marker and
// its values travel with the ordinary native project-settings config and are
// ignored by older readers as an ordinary known ConfigOptionStrings field.
static constexpr const char* kNativeProjectOverrideMarker = "different_settings_to_system";

const std::set<std::string>& canonical_project_config_keys()
{
    static const std::set<std::string> keys = {
        "flush_volumes_vector", "flush_volumes_matrix",
        "filament_colour", "filament_colour_type", "filament_multi_colour",
        "wipe_tower_x", "wipe_tower_y", "wipe_tower_rotation_angle",
        "curr_bed_type", "flush_multiplier", "flush_multiplier_fast",
        "prime_volume_mode", "nozzle_volume_type", "filament_map_mode",
        "filament_map", "filament_volume_map", "filament_nozzle_map",
        "has_filament_switcher", "enable_filament_dynamic_map",
    };
    return keys;
}

bool is_native_project_override_key(const std::string& key)
{
    if (canonical_project_config_keys().find(key) != canonical_project_config_keys().end())
        return false;
    const auto* definition = Slic3r::print_config_def.get(key);
    if (definition == nullptr || key == "extruder" || key == "wipe_tower_x" || key == "wipe_tower_y")
        return false;
    // Filament/rack/material and test-only cutter inputs stay owned by the
    // native filament/device authorities, never by the Project local map.
    if (key.find("filament") != std::string::npos || key.find("rack") != std::string::npos ||
        key.find("ams") != std::string::npos || key == "nozzle_volume" ||
        key == "nozzle_flush_dataset" || key == "enable_long_retraction_when_cut" ||
        key == "long_retractions_when_cut" || key == "retraction_distances_when_cut" ||
        key == "filament_diameter" || key == "filament_flush_temp")
        return false;
    for (const auto& [unused, placeholders] : Slic3r::custom_gcode_specific_placeholders())
        if (std::find(placeholders.begin(), placeholders.end(), key) != placeholders.end())
            return false;
    return true;
}

std::vector<std::string> native_project_override_keys(const DynamicPrintConfig& config)
{
    std::vector<std::string> keys;
    for (const auto& key : config.keys())
        if (is_native_project_override_key(key)) keys.push_back(key);
    return keys;
}

void restore_native_project_overrides(PresetBundle& bundle,
                                      const DynamicPrintConfig& imported_config,
                                      const std::vector<std::string>& keys)
{
    for (const auto& key : keys) {
        if (!is_native_project_override_key(key)) continue;
        const auto* value = imported_config.option(key);
        if (value != nullptr) bundle.project_config.set_key_value(key, value->clone());
    }
}

const char* duplicate_json(const std::string& value)
{
    char* out = static_cast<char*>(std::malloc(value.size() + 1));
    std::memcpy(out, value.data(), value.size());
    out[value.size()] = '\0';
    return out;
}

const char* project_error_json(const std::string& message)
{
    return duplicate_json(json{{"error", message}}.dump());
}

json project_history_context()
{
    return default_history_context(state(), plate_session_snapshot_json(), history_state_json(state().presets));
}

void establish_clean_history_baseline()
{
    state().history.clear();
    state().mesh_capture_cache.clear();
    state().mutable_object_capture_cache.clear();
    state().active_history_transaction.reset();
    state().nested_history_transactions.clear();
    state().history_disabled = false;
    state().history_live_context = project_history_context();
    // Prime immutable archive sharing at the load boundary, but keep timestamp
    // zero lazy: native slicing may legitimately update non-history model state
    // before the first edit and must not stale an already-retained root.
    (void) HistoryMetadata::capture_history_roots(state(), state().history_live_context);
    HistoryMetadata::advance_history_epoch(state());
    state().history.mark_current_as_saved();
}

json close_project_session()
{
    auto& bridge_state = state();

    // Release every runtime-only result owner before constructing the fresh
    // empty session. The project-load replacement boundary intentionally does
    // not keep the old registry alive while the new archive is parsed.
    bridge_state.plate_runtime_registry.clear();
    invalidate_preview_source();

    bridge_state.model = Model{};
    bridge_state.pending_membership_instance_ids.clear();
    bridge_state.presets.reset_project_embedded_presets();
    reset_plate_session_state();
    establish_clean_history_baseline();

    return json{{"ok", true}, {"plate_session", plate_session_snapshot_json()}};
}

std::vector<std::string> requested_filament_slots_from_import(
    const DynamicPrintConfig& config, const std::vector<std::string>& fallback)
{
    if (const auto* option = config.opt<ConfigOptionStrings>("filament_settings_id"))
        if (!option->values.empty()) return option->values;
    return fallback;
}

std::vector<std::string> requested_filament_slots_from_project_settings(
    const std::optional<std::string>& bytes, const std::vector<std::string>& fallback)
{
    if (bytes) {
        const json parsed = json::parse(*bytes, nullptr, false);
        if (parsed.is_object() && parsed.contains("filament_settings_id")) {
            const auto& value = parsed["filament_settings_id"];
            std::vector<std::string> result;
            if (value.is_array()) {
                for (const auto& item : value) {
                    if (!item.is_string()) return fallback;
                    result.push_back(item.get<std::string>());
                }
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

std::vector<BridgeState::PlateSessionPlate> build_plate_session_from_records(
    const std::vector<PlateData*>& native_data,
    const std::vector<ImportedPlateRecord>& raw_records,
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

void initialize_plate_session_from_records(const std::vector<PlateData*>& native_data,
                                            const std::vector<ImportedPlateRecord>& raw_records)
{
    auto& s = state();
    const auto sequence = next_plate_session_sequence();
    s.plate_session_plates = build_plate_session_from_records(native_data, raw_records,
                                                               sequence, s.current_plate_id);
    s.instance_plate_ids.clear();
    s.plate_out_of_bounds_ids.clear();
    s.parked_instance_ids.clear();
    s.pending_membership_instance_ids.clear();
    s.plate_input_revisions.clear();
    for (const auto& plate : s.plate_session_plates) s.plate_input_revisions[plate.id] = 0;
    PlateSession::reconcile_plate_runtime_registry();
}

std::vector<BridgeState::PlateSessionPlate> build_plate_session_from_records(
    const std::vector<PlateData*>& native_data,
    const std::vector<ImportedPlateRecord>& raw_records,
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
        // The native BBS model-settings parser does not populate PlateData::locked
        // for every archive path.  The lock flag is nevertheless a native
        // model_settings.config plate field, so prefer the parsed native XML
        // record when it is available and only fall back to PlateData for
        // archives without a raw model-settings record.
        plate.locked = raw ? raw->locked : (native ? native->locked : false);
        if (native) plate.settings = native->config;
        plate.settings_metadata = native ? config_metadata_json(native->config) : json::object();
        if (raw) plate.opaque_metadata = raw->opaque_metadata;
        result.push_back(std::move(plate));
    }
    current_plate_id = result.front().id;
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



extern "C" {

// Load a BBS 3MF into either a replacement project or an appended,
// geometry-only import. A replacement closes the old session before parsing;
// parsing and all candidate preset work then happen against temporary objects.
// Publication stays atomic within the new session, so failures leave the fresh
// empty baseline rather than a half-loaded candidate or a revived old project.
static const char* orc_load_project_impl(const char* data, int len,
                                          int geometry_only,
                                          const char* display_name,
                                          bool close_before_load) {
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
        if (!geometry_only && close_before_load)
            close_project_session();
        if (!data || len <= 0) {
            cleanup_paths();
            return project_error_json("no project bytes");
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
            return project_error_json("project bytes are not a ZIP archive");
        }
        begin_progress(geometry_only ? "Preparing geometry import" : "Preparing project load");
        struct ProgressScope {
            bool completed = false;
            ~ProgressScope() { if (!completed) stop_progress(); }
        } progress_scope;
        std::FILE* file = std::fopen(path.c_str(), "wb");
        if (!file) {
            cleanup_paths();
            return project_error_json("cannot open temporary project path");
        }
        const std::size_t written = std::fwrite(data, 1, static_cast<std::size_t>(len), file);
        const int close_result = std::fclose(file);
        if (written != static_cast<std::size_t>(len) || close_result != 0) {
            cleanup_paths();
            return project_error_json("cannot stage project bytes");
        }
        publish_slicer_progress(10, "Reading project metadata");

        const auto model_config = read_archive_entry(path, "Metadata/model_settings.config");
        const auto project_settings = read_archive_entry(path, "Metadata/project_settings.config");
        std::vector<ImportedPlateRecord> raw_records = model_config ? parse_plate_records(*model_config) : std::vector<ImportedPlateRecord>{};
        if (raw_records.size() > static_cast<size_t>(kMaxPlateCount)) {
            cleanup_paths();
            return project_error_json("project contains more than 36 plates");
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
                    return project_error_json("corrupt project plate metadata");
                }
                load_path = next_project_temp_path(".normalized.3mf");
                if (!rewrite_model_config_archive(path, load_path, normalized)) {
                    cleanup_paths();
                    return project_error_json("could not normalize project plate metadata");
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
        // reader can still restore its PresetBundle and native plate session.
        // Geometry-only import, however, must continue to reject an
        // archive that contains no geometry to append.
        if (!loaded || (geometry_only && imported.objects.empty()))
            throw Slic3r::RuntimeError("Loading of a project file failed.");
        std::vector<std::string> imported_project_override_keys;
        if (const auto* marker = imported_config.opt<ConfigOptionStrings>(kNativeProjectOverrideMarker))
            imported_project_override_keys = marker->values;
        publish_slicer_progress(55, geometry_only ? "Preparing imported geometry" : "Reading project settings");
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
        Vec3d geometry_translation = Vec3d::Zero();
        if (geometry_only) {
            bool has_geometry_bounds = false;
            Vec3d imported_min = Vec3d::Zero();
            Vec3d imported_max = Vec3d::Zero();
            for (const ModelObject* object : imported.objects) {
                if (object->instances.empty()) continue;
                const BoundingBoxf3& box = object->bounding_box_exact();
                if (!box.defined) continue;
                if (!has_geometry_bounds) {
                    imported_min = box.min;
                    imported_max = box.max;
                    has_geometry_bounds = true;
                } else {
                    imported_min = imported_min.cwiseMin(box.min);
                    imported_max = imported_max.cwiseMax(box.max);
                }
            }
            if (has_geometry_bounds) {
                const Vec3d imported_center = (imported_min + imported_max) * 0.5;
                geometry_translation = Vec3d(geometry_center.x() - imported_center.x(),
                                             geometry_center.y() - imported_center.y(), 0.0);
            }
        }
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
        if (!geometry_only) {
            // Replacement loads must start from the native Project option set,
            // not from the previous session's edited map.  load_config_model
            // applies the project options present in the incoming archive, so
            // retaining keys which are absent there would make a stale
            // filament/test fixture survive a project round trip.  Rebuild
            // the canonical Project map from PrintConfig defaults before
            // applying the archive; filament/rack state is handled by its
            // dedicated native authorities below.
            static const t_config_option_keys project_option_keys = {
                "flush_volumes_vector", "flush_volumes_matrix",
                "filament_colour", "filament_colour_type", "filament_multi_colour",
                "wipe_tower_x", "wipe_tower_y", "wipe_tower_rotation_angle",
                "curr_bed_type", "flush_multiplier", "flush_multiplier_fast",
                "prime_volume_mode", "nozzle_volume_type", "filament_map_mode",
                "filament_map", "filament_volume_map", "filament_nozzle_map",
                "has_filament_switcher", "enable_filament_dynamic_map",
            };
            DynamicPrintConfig clean_project_config;
            clean_project_config.apply_only(FullPrintConfig::defaults(), project_option_keys, true);
            candidate.project_config = std::move(clean_project_config);
        }
        std::vector<std::string> requested_filament_slots;
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
            // The GUI refreshes its active preset controls after this native
            // load.  Re-run the bridge's authoritative compatibility pass so
            // stale selections from the previous project cannot survive a
            // printer replacement.
            candidate.update_compatible(PresetSelectCompatibleType::Always);
            candidate.update_multi_material_filament_presets();
        }
        if (!geometry_only)
            restore_native_project_overrides(candidate, imported_config, imported_project_override_keys);
        publish_slicer_progress(75, geometry_only ? "Finalizing geometry import" : "Applying project settings");

        ProjectPresetWarningDetails warning_details;
        if (!geometry_only)
            warning_details = inspect_project_preset_warnings(
                candidate, imported_config, project_presets, load_path);

        std::vector<BridgeState::PlateSessionPlate> staged_plates;
        std::string staged_current_plate_id;
        if (!geometry_only) {
            // Build the incoming plate session while the candidate is still
            // isolated.  Plate settings are part of filament validation, so
            // validating against an empty list would incorrectly accept an
            // out-of-range plate assignment or tool-change reference.
            staged_plates = build_plate_session_from_records(
                plate_data, raw_records,
                current_plate_session_sequence() + 1,
                staged_current_plate_id);
            Neo::Bridge::ScopedConfig::apply_plate_metadata_to_configs(staged_plates);
            Neo::Bridge::PlateSession::normalize_coordinate_arrays(candidate.project_config, staged_plates.size());
        }

        // Complete candidate validation is still inside the staging phase.
        // In particular, a project carrying an explicit extruder or mapping
        // beyond the compatible rack must be rejected before replacing the
        // fresh empty model, PresetBundle, or history baseline.
        if (!geometry_only)
            validate_filament_candidate(candidate, imported, staged_plates,
                                        json{{"project", json::object()}, {"objects", json::object()},
                                             {"parts", json::object()}, {"plates", json::object()}},
                                        false, false);

        if (geometry_only) {
            for (const ModelObject* object : imported.objects) {
                ModelObject* added = append_model_object_geometry(state().model, *object);
                for (ModelInstance* instance : added->instances) {
                    instance->set_offset(instance->get_offset() + geometry_translation);
                    geometry_added_instances[instance->id().id] = geometry_translation;
                }
            }
        } else {
            // Publication is guarded by a complete move-based rollback to the
            // already-closed empty session. A late failure may not leave a
            // partially published new project, but it never revives the old
            // project that was released before parsing began.
            struct ProjectCommitRollback {
                Model model;
                PresetBundle presets;
                Neo::History::TimestampedHistory history;
                json history_live_context;
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
            // TimestampedHistory is move-only. Keep the publication target
            // valid while rollback owns the closed session; the successful
            // project load establishes its clean baseline in this fresh core.
            state().history = Neo::History::TimestampedHistory(rollback.history.byte_budget());
            rollback.history_live_context = std::move(state().history_live_context);
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
                initialize_plate_session_from_records(plate_data, raw_records);
                Neo::Bridge::ScopedConfig::apply_plate_metadata_to_configs(state().plate_session_plates);
                Neo::Bridge::PlateSession::normalize_coordinate_arrays(
                    state().presets.project_config, state().plate_session_plates.size());
                // Results are deliberately not loaded from PlateData.
                rebuild_plate_membership(true);
                // Loading a project is a clean lifecycle transition: clamp
                // saved native coordinates in memory, but establish the
                // history baseline only after that normalization so no dirty
                // entry is created. A later explicit save persists it.
                Neo::Bridge::PrimeTower::normalize_coordinate_positions();
                establish_clean_history_baseline();
                if (state().inject_project_commit_failure) {
                    state().inject_project_commit_failure = false;
                    throw Slic3r::RuntimeError("injected project commit failure after publication");
                }
                committed = true;
            } catch (...) {
                state().inject_project_commit_failure = false;
                state().model = std::move(rollback.model);
                state().mutable_object_capture_cache.clear();
                state().presets = std::move(rollback.presets);
                state().history = std::move(rollback.history);
                state().history_live_context = std::move(rollback.history_live_context);
                state().plate_session_plates = std::move(rollback.plates);
                PlateSession::reconcile_plate_runtime_registry();
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
        invalidate_preview_source();
        if (geometry_only) {
            rebuild_plate_membership(true);
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
        // Return a disposable projection rebuilt from native config owners;
        // the native configs themselves remain the only persisted authority.
        if (!geometry_only) {
            out["native_scoped_config"] = Neo::Bridge::ScopedConfig::native_scoped_config_full_transport(
                state().history_revision);
            out["history_status"] = history_status_json(state());
        }
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
        return duplicate_json(out.dump());
    } catch (const std::exception& e) {
        release_PlateData_list(plate_data);
        release_presets();
        cleanup_paths();
        return project_error_json(e.what());
    } catch (...) {
        release_PlateData_list(plate_data);
        release_presets();
        cleanup_paths();
        return project_error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_load_project(const char* data, int len,
                                                   int geometry_only,
                                                   const char* display_name) {
    return orc_load_project_impl(data, len, geometry_only, display_name, !geometry_only);
}

EMSCRIPTEN_KEEPALIVE const char* orc_close_project() {
    try {
        return duplicate_json(close_project_session().dump());
    } catch (const std::exception& e) {
        return project_error_json(e.what());
    } catch (...) {
        return project_error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_load_project_after_close(const char* data, int len,
                                                               const char* display_name) {
    return orc_load_project_impl(data, len, 0, display_name, false);
}

// Harness-only fault injection for proving post-publication rollback to the
// already-closed empty project session.
// It is one-shot and has no application/client surface.
EMSCRIPTEN_KEEPALIVE const char* orc_test_inject_project_commit_failure() {
    state().inject_project_commit_failure = true;
    return duplicate_json(json{{"ok", true}}.dump());
}

EMSCRIPTEN_KEEPALIVE const char* orc_import_project_geometry(const char* data, int len,
                                                              const char* display_name) {
    return orc_load_project(data, len, 1, display_name);
}

// Build native PlateData records from the authoritative runtime session. The
// standard BBS writer is the complete project persistence path; runtime-only
// selection and layout state is reconstructed when the project is opened.
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
        if (auto* marker = config.option<ConfigOptionStrings>(kNativeProjectOverrideMarker, true))
            marker->values = native_project_override_keys(state().presets.project_config);
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
        return duplicate_json(json{{"ok", true}, {"path", path},
                             {"bytes_ptr", reinterpret_cast<std::uintptr_t>(bytes)},
                             {"bytes_length", length}, {"objects", state().model.objects.size()},
                             {"plate_count", owned.size()}}.dump());
    } catch (const std::exception& e) {
        remove_project_temp_path(path);
        return project_error_json(e.what());
    } catch (...) {
        remove_project_temp_path(path);
        return project_error_json("unknown C++ exception");
    }
}



} // extern "C"

} // namespace Slic3r::Neo::Bridge::ProjectPersistence
