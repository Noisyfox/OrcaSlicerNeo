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
#include "bridge_preset_drafts.hpp"
#include "bridge_prime_tower.hpp"
#include "bridge_slicing_pipeline.hpp"
#include "bridge_scoped_config.hpp"
#include "libslic3r/Exception.hpp"
#include "libslic3r/Config.hpp"
#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/miniz_extension.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/Preset.hpp"
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
    bridge_state.preset_drafts.clear();
    bridge_state.preset_draft_revision = 0;
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

using PresetDiffKeys = std::vector<std::set<std::string>>;

PresetDiffKeys project_preset_diff_keys(const DynamicPrintConfig& config,
                                       std::size_t* filament_count = nullptr)
{
    std::size_t count = 0;
    if (const auto* diameters = config.opt<ConfigOptionFloats>("filament_diameter"))
        count = diameters->values.size();
    if (const auto* ids = config.opt<ConfigOptionStrings>("filament_settings_id"))
        count = std::max(count, ids->values.size());
    if (const auto* colours = config.opt<ConfigOptionStrings>("filament_colour"))
        count = std::max(count, colours->values.size());
    if (filament_count != nullptr) *filament_count = count;

    PresetDiffKeys result(count + 2);
    const auto* encoded = config.opt<ConfigOptionStrings>("different_settings_to_system");
    if (encoded == nullptr) return result;

    for (std::size_t index = 0; index < std::min(result.size(), encoded->values.size()); ++index) {
        std::vector<std::string> keys;
        if (!Slic3r::unescape_strings_cstyle(encoded->values[index], keys)) continue;
        result[index].insert(keys.begin(), keys.end());
    }
    return result;
}

std::optional<std::pair<std::size_t, std::size_t>> project_filament_variant_span(
    const DynamicPrintConfig& config, const std::size_t slot)
{
    if (config.option("extruder_variant_list") == nullptr) return std::nullopt;
    const auto* diameters = config.opt<ConfigOptionFloats>("filament_diameter");
    const auto* variants = config.opt<ConfigOptionStrings>("filament_extruder_variant");
    const auto* self_indices = config.opt<ConfigOptionInts>("filament_self_index");
    if (diameters == nullptr || variants == nullptr || self_indices == nullptr ||
        slot >= diameters->values.size() || variants->values.size() <= diameters->values.size() ||
        self_indices->values.size() != variants->values.size())
        return std::nullopt;

    std::vector<std::size_t> first_variant(diameters->values.size(), variants->values.size());
    std::size_t current_slot = 1;
    for (std::size_t index = 0; index < self_indices->values.size(); ++index) {
        if (self_indices->values[index] != static_cast<int>(current_slot)) continue;
        first_variant[current_slot - 1] = index;
        ++current_slot;
        if (current_slot > first_variant.size()) break;
    }
    if (first_variant[slot] == variants->values.size()) return std::nullopt;
    const std::size_t end = slot + 1 < first_variant.size()
        ? first_variant[slot + 1] : variants->values.size();
    if (end <= first_variant[slot]) return std::nullopt;
    return std::pair{first_variant[slot], end - first_variant[slot]};
}

struct ProjectEmbeddedPresetSnapshot {
    std::map<std::string, DynamicPrintConfig> configs;
    std::map<std::string, bool> dirty;
};

ProjectEmbeddedPresetSnapshot snapshot_project_embedded_presets(
    const PresetCollection& collection)
{
    ProjectEmbeddedPresetSnapshot snapshot;
    for (const Preset& preset : collection.get_presets()) {
        if (!preset.is_project_embedded) continue;
        snapshot.configs.emplace(preset.name, preset.config);
        snapshot.dirty.emplace(preset.name, preset.is_dirty);
    }
    return snapshot;
}

void restore_project_embedded_presets(PresetCollection& collection,
                                      const ProjectEmbeddedPresetSnapshot& snapshot)
{
    for (const auto& [name, config] : snapshot.configs) {
        Preset* preset = collection.find_preset(name, false, true);
        if (preset == nullptr || !preset->is_project_embedded) continue;
        preset->config = config;
        const auto dirty = snapshot.dirty.find(name);
        preset->is_dirty = dirty != snapshot.dirty.end() && dirty->second;
    }
}

const DynamicPrintConfig* project_preset_source_config(
    PresetCollection& collection,
    const ProjectEmbeddedPresetSnapshot& embedded_snapshot,
    const std::string& canonical_name)
{
    const auto embedded = embedded_snapshot.configs.find(canonical_name);
    if (embedded != embedded_snapshot.configs.end()) return &embedded->second;
    const Preset* preset = collection.find_preset(canonical_name, false, true);
    return preset == nullptr ? nullptr : &preset->config;
}

std::string project_load_source_name(PresetCollection& collection,
                                     const ProjectEmbeddedPresetSnapshot& embedded_snapshot,
                                     const std::string& loaded_name,
                                     const std::string& requested_name,
                                     const std::set<std::string>& diff_keys)
{
    if (loaded_name.empty() || requested_name.empty() || diff_keys.empty() ||
        embedded_snapshot.configs.count(loaded_name) != 0)
        return loaded_name;

    const Preset* loaded = collection.find_preset(loaded_name, false, true);
    if (loaded == nullptr || !loaded->is_project_embedded ||
        loaded->inherits() != requested_name ||
        collection.find_preset(requested_name, false, true) == nullptr)
        return loaded_name;

    // The native loader may materialize a temporary @Project child for an
    // ordinary different-settings value (notably on a later filament slot).
    // The 3MF still names the real source preset; retain the embedded source
    // record and represent those changed fields in Neo's session overlay.
    return requested_name;
}

void restore_native_modified_presets(PresetCollection& collection,
                                     const std::string& loaded_name,
                                     const std::string& source_name,
                                     const std::set<std::string>& archive_embedded_names)
{
    if (loaded_name.empty() || source_name.empty()) return;
    if (collection.get_selected_preset_name() == loaded_name)
        collection.select_preset_by_name(source_name, true);

    if (loaded_name == source_name || archive_embedded_names.count(loaded_name) != 0)
        return;
    const Preset* child = collection.find_preset(loaded_name, false, true);
    if (child != nullptr && child->is_project_embedded)
        collection.delete_preset(loaded_name, true);
}

void add_active_draft_overrides(PresetDraftRegistry& drafts,
                                PresetCollection& collection,
                                const ProjectEmbeddedPresetSnapshot& embedded_snapshot,
                                const Preset::Type type,
                                const std::string& canonical_name,
                                const DynamicPrintConfig& imported_config,
                                const std::set<std::string>& diff_keys,
                                const std::optional<std::size_t> filament_slot = std::nullopt)
{
    if (canonical_name.empty() || diff_keys.empty()) return;
    const DynamicPrintConfig* source_config = project_preset_source_config(
        collection, embedded_snapshot, canonical_name);
    if (source_config == nullptr) return;

    for (const std::string& key : diff_keys) {
        const ConfigOption* source_option = source_config->option(key);
        const ConfigOption* imported_option = imported_config.option(key);
        if (source_option == nullptr || imported_option == nullptr ||
            source_option->type() != imported_option->type())
            continue;

        ConfigOptionUniquePtr effective_option(source_option->clone());
        if (source_option->is_scalar()) {
            effective_option->set(imported_option);
        } else if (filament_slot) {
            auto* effective_vector = dynamic_cast<ConfigOptionVectorBase*>(effective_option.get());
            const auto* imported_vector = dynamic_cast<const ConfigOptionVectorBase*>(imported_option);
            if (effective_vector == nullptr || imported_vector == nullptr) continue;
            const auto* variants = imported_config.opt<ConfigOptionStrings>("filament_extruder_variant");
            const auto span = filament_options_with_variant.count(key) != 0
                ? project_filament_variant_span(imported_config, *filament_slot)
                : std::nullopt;
            if (span && variants != nullptr &&
                imported_vector->size() == variants->values.size()) {
                if (span->first + span->second > imported_vector->size()) continue;
                // Multi-extruder projects flatten variant-aware Filament
                // options by physical-extruder variant. Follow the exact
                // filament_self_index span used by PresetBundle's loader.
                effective_vector->set(imported_vector, span->first, span->second);
            } else {
                if (*filament_slot >= imported_vector->size()) continue;
                // In ordinary project_settings.config, a filament-associated
                // vector is flattened by material slot. Neo draft edits may
                // also intentionally collapse a variant field to one value
                // per slot, so use the native variant span only when the
                // stored vector actually carries every variant value.
                effective_vector->resize(1);
                effective_vector->set_at(imported_vector, 0, *filament_slot);
            }
        } else {
            effective_option->set(imported_option);
        }

        const std::string source_value = source_option->serialize();
        const std::string effective_value = effective_option->serialize();
        if (source_value != effective_value)
            drafts.set(type, canonical_name, key, effective_value);
    }
}

void reconstruct_active_project_drafts(
    PresetBundle& candidate,
    const DynamicPrintConfig& imported_config,
    const std::vector<std::string>& requested_filament_slots,
    const PresetDiffKeys& diff_keys,
    const ProjectEmbeddedPresetSnapshot& embedded_printers,
    const ProjectEmbeddedPresetSnapshot& embedded_filaments,
    PresetDraftRegistry& drafts)
{
    std::vector<std::string> loaded_filament_names = candidate.filament_presets;
    std::vector<std::string> canonical_filament_names;
    canonical_filament_names.reserve(loaded_filament_names.size());
    const std::set<std::string> archive_embedded_filament_names = [&]() {
        std::set<std::string> names;
        for (const auto& entry : embedded_filaments.configs) names.insert(entry.first);
        return names;
    }();
    const std::set<std::string> archive_embedded_printer_names = [&]() {
        std::set<std::string> names;
        for (const auto& entry : embedded_printers.configs) names.insert(entry.first);
        return names;
    }();

    // Capture every active slot's loaded values before restoring any embedded
    // source record. PresetCollection has one edited Filament copy; later
    // slots may instead refer to a real embedded preset or a temporary child.
    struct LoadedFilament {
        std::string loaded_name;
        std::string canonical_name;
    };
    std::vector<LoadedFilament> loaded_filaments;
    loaded_filaments.reserve(loaded_filament_names.size());
    for (std::size_t index = 0; index < loaded_filament_names.size(); ++index) {
        const std::string& loaded_name = loaded_filament_names[index];
        const std::string requested_name = index < requested_filament_slots.size()
            ? requested_filament_slots[index] : std::string{};
        const std::set<std::string> empty_keys;
        const std::set<std::string>& keys = index + 1 < diff_keys.size()
            ? diff_keys[index + 1] : empty_keys;
        const std::string canonical_name = project_load_source_name(
            candidate.filaments, embedded_filaments, loaded_name, requested_name, keys);
        add_active_draft_overrides(drafts, candidate.filaments, embedded_filaments,
                                   Preset::TYPE_FILAMENT, canonical_name,
                                   imported_config, keys, index);
        canonical_filament_names.push_back(canonical_name);
        loaded_filaments.push_back({loaded_name, canonical_name});
    }

    const std::string loaded_printer_name = candidate.printers.get_selected_preset_name();
    const std::string requested_printer_name = imported_config.opt_string("printer_settings_id");
    const std::set<std::string> empty_printer_keys;
    const std::set<std::string>& printer_keys = diff_keys.size() > 1
        ? diff_keys.back() : empty_printer_keys;
    const std::string canonical_printer_name = project_load_source_name(
        candidate.printers, embedded_printers, loaded_printer_name,
        requested_printer_name, printer_keys);
    if (!loaded_printer_name.empty()) {
        add_active_draft_overrides(drafts, candidate.printers, embedded_printers,
                                   Preset::TYPE_PRINTER, canonical_printer_name,
                                   imported_config, printer_keys);
    }

    // Orca's loader remains the source of compatibility, fallback, and
    // project-embedded parsing decisions. Undo only the in-place update it
    // performs for later embedded Filament slots; those archive entries are
    // sources, not the Neo runtime overlays reconstructed above.
    restore_project_embedded_presets(candidate.filaments, embedded_filaments);
    restore_project_embedded_presets(candidate.printers, embedded_printers);

    for (std::size_t index = 0; index < loaded_filaments.size(); ++index) {
        auto& loaded = loaded_filaments[index];
        restore_native_modified_presets(candidate.filaments, loaded.loaded_name,
                                        loaded.canonical_name,
                                        archive_embedded_filament_names);
        if (index < candidate.filament_presets.size())
            candidate.filament_presets[index] = loaded.canonical_name;
    }
    if (!loaded_printer_name.empty())
        restore_native_modified_presets(candidate.printers, loaded_printer_name,
                                        canonical_printer_name,
                                        archive_embedded_printer_names);
    if (!canonical_filament_names.empty() &&
        std::find(canonical_filament_names.begin(), canonical_filament_names.end(),
                  candidate.filaments.get_selected_preset_name()) == canonical_filament_names.end()) {
        const std::string& first = canonical_filament_names.front();
        if (candidate.filaments.find_preset(first, false, true) != nullptr)
            candidate.filaments.select_preset_by_name(first, true);
    }
    candidate.update_multi_material_filament_presets();
}

void merge_active_draft_keys_into_project_metadata(
    DynamicPrintConfig& output_config,
    const DynamicPrintConfig& native_metadata,
    const PresetBundle& bundle,
    const PresetDraftRegistry& drafts)
{
    const std::size_t filament_count = bundle.filament_presets.size();
    std::vector<std::string> values(filament_count + 2);
    if (const auto* native_values = native_metadata.opt<ConfigOptionStrings>("different_settings_to_system")) {
        const std::size_t count = std::min(values.size(), native_values->values.size());
        std::copy_n(native_values->values.begin(), count, values.begin());
    }

    const auto merge = [&values](const std::size_t index,
                                 const PresetDraftRegistry::Overrides* overrides) {
        if (overrides == nullptr || overrides->empty() || index >= values.size()) return;
        std::vector<std::string> keys;
        if (!Slic3r::unescape_strings_cstyle(values[index], keys)) return;
        std::set<std::string> existing(keys.begin(), keys.end());
        for (const auto& entry : *overrides)
            if (existing.insert(entry.first).second) keys.push_back(entry.first);
        values[index] = Slic3r::escape_strings_cstyle(keys);
    };

    merge(filament_count + 1,
          drafts.find(Preset::TYPE_PRINTER, bundle.printers.get_selected_preset_name()));
    for (std::size_t index = 0; index < filament_count; ++index)
        merge(index + 1, drafts.find(Preset::TYPE_FILAMENT, bundle.filament_presets[index]));

    output_config.set_key_value("different_settings_to_system",
                                new ConfigOptionStrings(std::move(values)));
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

// Use the same result as Plater's project-load warning. Do not independently
// diff embedded presets: that can warn for projects Orca accepts silently.
ProjectPresetWarningDetails inspect_project_preset_warnings(
    PresetBundle& bundle, DynamicPrintConfig& config, const std::string& path)
{
    ProjectPresetWarningDetails details;
    std::set<std::string> evidence;
    const int result = bundle.validate_presets(path, config, evidence);
    if (result == VALIDATE_PRESETS_PRINTER_NOT_FOUND ||
        result == VALIDATE_PRESETS_FILAMENTS_NOT_FOUND) {
        details.missing_system_preset = true;
        std::set<std::string> missing_types;
        for (const std::string& name : evidence) {
            const char* type = name == config.opt_string("printer_settings_id") ? "printer" : "filament";
            missing_types.insert(type);
            details.preset_evidence.push_back({{"type", type}, {"name", name},
                {"has_matching_system_preset", false}, {"modified_gcode_keys", json::array()}});
        }
        for (const std::string& type : missing_types)
            details.missing_system_preset_types.push_back(type);
    } else if (result == VALIDATE_PRESETS_MODIFIED_GCODES) {
        const std::set<std::string> filament_gcode_keys = {
            "filament_end_gcode", "filament_start_gcode", "change_filament_gcode"
        };
        details.modified_gcode_keys = std::move(evidence);
        for (const std::string& key : details.modified_gcode_keys) {
            if (filament_gcode_keys.count(key)) details.modified_filament_gcode = true;
            else details.modified_printer_gcode = true;
        }
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
        publish_slicer_progress(55, geometry_only ? "Preparing imported geometry" : "Reading project settings");
        imported.add_default_instances();
        if (!geometry_only) {
            // Match the desktop Plater path. Project JSON may encode a
            // filament vector as an empty scalar, while the multi-filament
            // preset loader expects every ordinary filament vector to have
            // one value per slot. This normalized form is Neo's canonical
            // imported project config for the entire transaction.
            Preset::normalize(imported_config);
        }

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
        PresetDraftRegistry staged_preset_drafts;
        std::size_t printer_preset_count = 0;
        std::size_t process_preset_count = 0;
        std::size_t filament_preset_count = 0;
        for (const Preset* preset : project_presets) {
            if (!preset) continue;
            if (preset->type == Preset::TYPE_PRINTER) ++printer_preset_count;
            else if (preset->type == Preset::TYPE_PRINT) ++process_preset_count;
            else if (preset->type == Preset::TYPE_FILAMENT) ++filament_preset_count;
        }
        ProjectPresetWarningDetails warning_details;
        if (!geometry_only && (!project_presets.empty() || is_bbl_3mf || is_orca_3mf)) {
            candidate.load_project_embedded_presets(project_presets,
                ForwardCompatibilitySubstitutionRule::Enable);
            const ProjectEmbeddedPresetSnapshot embedded_printers =
                snapshot_project_embedded_presets(candidate.printers);
            const ProjectEmbeddedPresetSnapshot embedded_filaments =
                snapshot_project_embedded_presets(candidate.filaments);
            const PresetDiffKeys diff_keys = project_preset_diff_keys(imported_config);
            const std::vector<std::string> native_requested_filament_slots =
                requested_filament_slots_from_import(imported_config, requested_filament_slots);
            warning_details = inspect_project_preset_warnings(candidate, imported_config, load_path);

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
            reconstruct_active_project_drafts(candidate, imported_config,
                native_requested_filament_slots, diff_keys, embedded_printers,
                embedded_filaments, staged_preset_drafts);
        }
        publish_slicer_progress(75, geometry_only ? "Finalizing geometry import" : "Applying project settings");

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
                PresetDraftRegistry preset_drafts;
                std::uint64_t preset_draft_revision { 0 };
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
            rollback.preset_drafts = std::move(state().preset_drafts);
            rollback.preset_draft_revision = state().preset_draft_revision;
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
                state().preset_drafts = std::move(staged_preset_drafts);
                state().preset_draft_revision = 0;
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
                state().preset_drafts = std::move(rollback.preset_drafts);
                state().preset_draft_revision = rollback.preset_draft_revision;
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
            {"requires_confirmation", warning_details.modified_printer_gcode ||
                                      warning_details.modified_filament_gcode ||
                                      warning_details.missing_system_preset},
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
        DynamicPrintConfig config = Neo::Bridge::PresetDrafts::effective_full_config_secure();
        if (state().presets.printers.get_edited_preset().printer_technology() == ptFFF) {
            // construct_full_config() intentionally omits BBS's aggregate
            // different_settings_to_system metadata because slicing does not
            // consume it. The project writer does: without this vector, the
            // 3MF reader treats a project-embedded Process value as inherited
            // and replaces it with the parent on reopen. Preserve the native
            // bundle's Process/Printer/Filament diff metadata while keeping
            // the effective config (including supported preset drafts) as
            // the flattened value source.
            const DynamicPrintConfig native_metadata = state().presets.full_config_secure();
            merge_active_draft_keys_into_project_metadata(
                config, native_metadata, state().presets, state().preset_drafts);
        }
        StoreParams params;
        params.path = path;
        params.model = &state().model;
        params.plate_data_list = plates;
        // The edited Print preset is a separate native copy.  Mirror it into
        // the selected project-embedded record immediately before the
        // standard BBS exporter enumerates embedded presets; no private
        // archive metadata is needed for this owner boundary.
        Neo::Bridge::ScopedConfig::sync_project_print_preset_storage();
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
