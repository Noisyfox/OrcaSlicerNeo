#include "bridge_user_presets.hpp"
#include "PresetContextRenames.hpp"
#include "bridge_state.hpp"
#include "bridge_profiles.hpp"
#include "bridge_history.hpp"
#include "bridge_filament.hpp"
#include "bridge_plate.hpp"
#include "bridge_prime_tower.hpp"
#include "bridge_scoped_config.hpp"
#include "bridge_slicing_pipeline.hpp"
#include "libslic3r/Utils.hpp"
#include <emscripten/emscripten.h>
#include <boost/filesystem.hpp>
#include <fstream>
#include <sstream>
#include <algorithm>

namespace Slic3r::Neo::Bridge::UserPresets {
using json = nlohmann::json;
using Key = std::pair<Preset::Type, std::string>;
struct Snapshot {
    std::string original;
    // Preserve the original inheritance chain before flattening native snapshots.
    std::vector<std::string> ancestors;
    bool deleted = false;
};
static std::map<Key, Snapshot> snapshots;
static std::uint64_t next_snapshot = 1;
// Includes the local prepare owner before it is published as `pending`.
static unsigned repository_rollback_owners = 0;

PresetCollection& collection(Preset::Type type) {
    auto& bundle = state().presets;
    if (type == Preset::TYPE_PRINTER) return bundle.printers;
    if (type == Preset::TYPE_FILAMENT) return bundle.filaments;
    if (type == Preset::TYPE_PRINT) return bundle.prints;
    throw std::runtime_error("invalid preset kind");
}
Preset::Type kind(const std::string& value) {
    if (value == "printer") return Preset::TYPE_PRINTER;
    if (value == "filament") return Preset::TYPE_FILAMENT;
    if (value == "print") return Preset::TYPE_PRINT;
    throw std::runtime_error("kind must be printer|filament|print");
}
std::string kind_name(Preset::Type type) {
    return type == Preset::TYPE_PRINT ? "print" : type == Preset::TYPE_PRINTER ? "printer" : "filament";
}
bool is_snapshot(Preset::Type type, const std::string& name) { return snapshots.count({type, name}) != 0; }
const Preset* baseline(Preset::Type type, const std::string& name) {
    const auto found = snapshots.find({type, name});
    if (found == snapshots.end()) return collection(type).find_preset(name, false, true);
    auto& c = collection(type);
    if (!found->second.deleted) return c.find_preset(found->second.original, false, true);
    for (const auto& name : found->second.ancestors)
        if (const auto* parent = c.find_preset(name, false, true)) return parent;
    return &c.default_preset();
}
std::string display_label(const Preset& preset) {
    const auto found = snapshots.find({preset.type, preset.name});
    if (found == snapshots.end()) return preset.alias.empty() ? preset.name : preset.alias;
    if (found->second.deleted) {
        const auto* parent = baseline(preset.type, preset.name);
        return parent->alias.empty() ? parent->name : parent->alias;
    }
    return found->second.original;
}
bool picker_is_user(const Preset& preset) {
    const Preset* source = &preset;
    std::set<std::string> visited;
    while (source && visited.insert(source->name).second) {
        if (is_snapshot(source->type, source->name)) {
            const auto* saved = baseline(source->type, source->name);
            if (saved) { source = saved; continue; }
        }
        if (source->is_project_embedded) {
            const auto* parent = collection(source->type).get_preset_parent(*source);
            if (parent) { source = parent; continue; }
        }
        return !source->is_system && !source->is_default;
    }
    return false;
}
bool picker_is_project_embedded(const Preset& preset) {
    return preset.is_project_embedded && !is_snapshot(preset.type, preset.name) &&
        !is_snapshot(preset.type, preset.inherits());
}
bool active(Preset::Type type, const std::string& name) {
    auto& bundle = state().presets;
    if (type == Preset::TYPE_FILAMENT)
        return std::find(bundle.filament_presets.begin(), bundle.filament_presets.end(), name) != bundle.filament_presets.end();
    const auto& selected = collection(type).get_selected_preset();
    return selected.name == name || (type == Preset::TYPE_PRINT && selected.is_project_embedded && selected.inherits() == name);
}
bool picker_visible(const Preset& preset) {
    if (is_snapshot(preset.type, preset.name)) return active(preset.type, preset.name);
    for (const auto& [key, record] : snapshots)
        if (key.first == preset.type && record.original == preset.name && !record.deleted && active(key.first, key.second)) return false;
    return true;
}
std::string view_name(Preset::Type type, const std::string& name) {
    const auto record = snapshots.find({type, name});
    if (record != snapshots.end() && record->second.deleted) return name;
    const std::string original = record == snapshots.end() ? name : record->second.original;
    if (active(type, original)) return original;
    for (const auto& [key, snapshot] : snapshots)
        if (key.first == type && snapshot.original == original && !snapshot.deleted && active(type, key.second)) return key.second;
    return name;
}
std::string print_reset_target() {
    const auto& c = collection(Preset::TYPE_PRINT);
    const auto& selected = c.get_selected_preset();
    const auto name = selected.is_project_embedded ? selected.inherits() : selected.name;
    const auto record = snapshots.find({Preset::TYPE_PRINT, name});
    return record != snapshots.end() && !record->second.deleted ? record->second.original : std::string{};
}
bool modified(Preset::Type type, const std::string& name, const DynamicPrintConfig& effective) {
    const auto* saved = baseline(type, name);
    if (!saved) return false;
    // System-source overlays keep the editor's existing explicit-override
    // indication (including equal-valued toolhead overrides). User versions
    // instead compare their effective parameters with the saved head.
    if (!is_snapshot(type, name) && (saved->is_system || saved->is_default)) {
        const auto* overrides = state().preset_drafts.find(type, name);
        return overrides && !overrides->empty();
    }
    for (const auto& key : effective.diff(saved->config))
        if (key != "inherits" && key != "printer_settings_id" && key != "filament_settings_id" && key != "print_settings_id") return true;
    return false;
}

json context(const json& editing_context) {
    return HistoryRuntime::canonical_history_context(HistoryRuntime::runtime(), editing_context);
}
std::string repository_path(std::string path) {
    while (path.rfind("//", 0) == 0) path.erase(0, 1);
    const std::string root = "/user/default/";
    if (path.rfind(root, 0) != 0) throw std::runtime_error("invalid user preset destination: " + path);
    return path.substr(root.size());
}

void adopt(Preset::Type type, const std::string& from, const std::string& to) {
    auto& c = collection(type);
    if (type == Preset::TYPE_FILAMENT) {
        const bool first = !state().presets.filament_presets.empty() && state().presets.filament_presets.front() == from;
        for (auto& name : state().presets.filament_presets) if (name == from) name = to;
        if (first || c.get_selected_preset_name() == from) c.select_preset_by_name(to, true);
    } else if (active(type, from)) c.select_preset_by_name(to, true);
}

std::string retain(Preset::Type type, const std::string& name, PresetContextRenames& renames) {
    auto& c = collection(type);
    const auto* source = c.find_preset(name, false, true);
    if (!source) throw std::runtime_error("preset source is unavailable");
    Preset copy = *source;
    std::string frozen;
    do { frozen = name + " [snapshot " + std::to_string(next_snapshot++) + "]"; }
    while (c.find_preset(frozen, false, true));
    // Full resolved values freeze the entire inheritance chain.
    copy.name = frozen;
    // Keep the stable system ancestor for Orca's printer compatibility rules.
    // All effective options are copied, so mutable user ancestors are severed.
    std::vector<std::string> ancestors;
    const Preset* ancestor = c.get_preset_parent(*source);
    const Preset* system_ancestor = nullptr;
    std::set<std::string> visited{source->name};
    while (ancestor && visited.insert(ancestor->name).second) {
        ancestors.push_back(ancestor->name);
        if (ancestor->is_system) { system_ancestor = ancestor; break; }
        ancestor = c.get_preset_parent(*ancestor);
    }
    ancestor = system_ancestor;
    copy.inherits() = ancestor && ancestor->is_system ? ancestor->name : std::string{};
    copy.neo_vector_overrides.clear();
    copy.file.clear();
    copy.vendor = nullptr;
    copy.is_system = false;
    copy.is_default = false;
    copy.is_external = true;
    copy.is_project_embedded = false;
    copy.is_visible = true;
    auto& stored = c.load_preset("", frozen, copy.config, false);
    stored = std::move(copy);
    snapshots.emplace(Key{type, frozen}, Snapshot{name, std::move(ancestors), false});
    renames.add(kind_name(type), name, frozen);
    return frozen;
}

// A repository operation is infrequent and owns an isolated rollback snapshot.
// Geometry archives in history remain shared; no new undo entry is used as a
// persistence transaction. The Worker excludes every competing command while
// the host commits the single JSON file.
struct Pending {
    const bool had_redo = state().history.can_redo();
    std::map<std::string, std::optional<std::string>> files;
    std::string delete_file;
    void watch(const std::string& file) {
        for (const auto& path : {file, boost::filesystem::path(file).replace_extension(".info").string()}) {
            std::ifstream input(path);
            if (!input) files[path] = std::nullopt;
            else { std::ostringstream content; content << input.rdbuf(); files[path] = content.str(); }
        }
    }
    PresetBundle presets = state().presets;
    PresetDraftRegistry drafts = state().preset_drafts;
    Model model = state().model;
    decltype(snapshots) retained = snapshots;
    decltype(BridgeState::plate_session_plates) plates = state().plate_session_plates;
    decltype(BridgeState::plate_input_revisions) revisions = state().plate_input_revisions;
    decltype(BridgeState::instance_plate_ids) membership = state().instance_plate_ids;
    decltype(BridgeState::plate_out_of_bounds_ids) outside = state().plate_out_of_bounds_ids;
    decltype(BridgeState::parked_instance_ids) parked = state().parked_instance_ids;
    decltype(BridgeState::pending_membership_instance_ids) pending_membership = state().pending_membership_instance_ids;
    decltype(BridgeState::filament_slot_ids) slots = state().filament_slot_ids;
    std::string current_plate = state().current_plate_id;
    PlateRuntimeRegistry::LifecycleSnapshots runtime = state().plate_runtime_registry.capture_lifecycle();
    json live_context = state().history_live_context;
    std::uint64_t revision = state().history_revision;
    std::uint64_t draft_revision = state().preset_draft_revision;
    History::TimestampedHistory::NavigationPublication publication = state().history.stage_navigation();
    bool accepted = false;
    Pending() { ++repository_rollback_owners; }
    ~Pending() {
        --repository_rollback_owners;
        if (accepted) return;
        state().presets = presets;
        state().preset_drafts = drafts;
        state().model = model;
        snapshots = retained;
        state().plate_session_plates = plates;
        PlateSession::reconcile_plate_runtime_registry();
        state().plate_input_revisions = revisions;
        state().instance_plate_ids = membership;
        state().plate_out_of_bounds_ids = outside;
        state().parked_instance_ids = parked;
        state().pending_membership_instance_ids = pending_membership;
        state().filament_slot_ids = slots;
        state().current_plate_id = current_plate;
        state().plate_runtime_registry.restore_lifecycle(runtime);
        state().history_live_context = live_context;
        state().history_revision = revision;
        state().preset_draft_revision = draft_revision;
        state().mutable_object_capture_cache.clear();
        PrimeTower::invalidate_projection_cache();
        for (const auto& [path, content] : files) {
            if (content) { std::ofstream output(path); output << *content; }
            else { boost::system::error_code ignored; boost::filesystem::remove(path, ignored); }
        }
    }
};
static std::unique_ptr<Pending> pending;
static std::uint64_t token = 0;

void collect_discarded_redo_snapshots(bool had_redo) noexcept {
    if (!had_redo || snapshots.empty() || repository_rollback_owners ||
        state().history.operation_active() || state().history.can_redo()) return;
    // Mark completely before sweeping. Allocation/decoding failure retains all
    // versions; collection must never turn an already published edit into an
    // error or partially remove a still-referenced version.
    try {
        std::set<Key> reachable;
        std::vector<Key> work;
        auto root = [&](Preset::Type type, const std::string& name) {
            if (!name.empty() && reachable.emplace(type, name).second) work.emplace_back(type, name);
        };
        auto drafts = [&](const json& registry) {
            for (const auto& entry : registry.at("entries"))
                root(kind(entry.at("kind").get<std::string>()), entry.at("canonical_name").get<std::string>());
        };
        auto context_roots = [&](const json& value) {
            if (value.contains("nativePrinterPreset"))
                root(Preset::TYPE_PRINTER, value.at("nativePrinterPreset").at("selected").get<std::string>());
            if (value.contains("filamentState"))
                for (const auto& name : value.at("filamentState").at("filament_presets"))
                    root(Preset::TYPE_FILAMENT, name.get<std::string>());
            if (value.contains("nativePrintPreset")) {
                const auto& print = value.at("nativePrintPreset");
                root(Preset::TYPE_PRINT, print.at("selected").get<std::string>());
                for (const auto& preset : print.at("project_embedded_presets"))
                    root(Preset::TYPE_PRINT, preset.at("inherits").get<std::string>());
            }
            if (value.contains("presetDraftRegistry")) drafts(value.at("presetDraftRegistry"));
        };
        state().history.visit_contexts([&](const History::Bytes& bytes) {
            context_roots(json::parse(std::string(bytes.begin(), bytes.end())));
        });
        context_roots(state().history_live_context);
        drafts(state().preset_drafts.snapshot_json());
        for (const auto type : {Preset::TYPE_PRINTER, Preset::TYPE_FILAMENT, Preset::TYPE_PRINT}) {
            const auto& c = collection(type);
            root(type, c.get_selected_preset_name());
            root(type, c.get_edited_preset().inherits());
            // Embedded presets can outlive their selection. Their parents are
            // still needed for restoration, reset and 3MF export.
            for (const auto& preset : c.get_presets())
                if (!is_snapshot(type, preset.name)) root(type, preset.inherits());
        }
        for (const auto& name : state().presets.filament_presets) root(Preset::TYPE_FILAMENT, name);
        for (size_t i = 0; i < work.size(); ++i) {
            const auto key = work[i];
            if (const auto* preset = collection(key.first).find_preset(key.second, false, true))
                root(key.first, preset->inherits());
            const auto retained = snapshots.find(key);
            if (retained != snapshots.end()) {
                root(key.first, retained->second.original);
                for (const auto& ancestor : retained->second.ancestors) root(key.first, ancestor);
            }
        }
        // Everything below is allocation-free. Erasing a runtime preset keeps
        // the collection's selected index and edited/saved copies intact.
        for (auto it = snapshots.begin(); it != snapshots.end();) {
            if (!reachable.count(it->first) && collection(it->first.first).erase_runtime_preset(it->first.second))
                it = snapshots.erase(it);
            else ++it;
        }
    } catch (...) {
        // Retry at the next branch discard (or release at the session boundary).
    }
}

void reset_session() {
    if (pending) throw std::runtime_error("user preset write is pending");
    for (const auto& [key, record] : snapshots) {
        auto& c = collection(key.first);
        if (active(key.first, key.second)) {
            // End the old version view at its saved head, or the surviving
            // parent of a deleted source. Never pick an arbitrary catalogue row.
            const auto* saved = baseline(key.first, key.second);
            adopt(key.first, key.second, saved ? saved->name : c.default_preset().name);
        }
        if (auto* preset = collection(key.first).find_preset(key.second, false, true)) {
            const auto selected = c.get_selected_preset_name();
            preset->file.clear();
            c.delete_preset(key.second, true);
            c.select_preset_by_name(selected, true);
        }
    }
    snapshots.clear();
}

std::vector<Preset> export_presets(DynamicPrintConfig& config, const std::vector<Preset*>& embedded) {
    std::vector<Preset> result;
    std::map<Key, std::string> names;
    auto export_name = [&](Preset::Type type, const std::string& name) {
        const auto* source = collection(type).find_preset(name, false, true);
        if (!source) return name;
        auto record = snapshots.find({type, source->name});
        if (record == snapshots.end() && source->is_project_embedded) record = snapshots.find({type, source->inherits()});
        const Preset* parent = collection(type).get_preset_parent(*source);
        const bool local_source = !source->is_project_embedded && source->is_user();
        const bool local_child = source->is_project_embedded && parent && parent->is_user() && !parent->is_project_embedded;
        if (record == snapshots.end() && !local_source && !local_child) return name;
        auto found = names.find({type, name});
        if (found != names.end()) return found->second;
        const std::string original = record != snapshots.end() ? record->second.original : local_child ? parent->name : name;
        // Ordinary saved users retain Orca's source identity on interchange.
        // Only retained MVCC versions must avoid reconnecting to a saved head.
        std::string clean = record == snapshots.end() ? original : original + " (Project)";
        for (unsigned suffix = 2; record != snapshots.end() && (collection(type).find_preset(clean, false, true) ||
            std::any_of(names.begin(), names.end(), [&](const auto& pair) { return pair.first.first == type && pair.second == clean; })); ++suffix)
            clean = original + " (Project " + std::to_string(suffix) + ")";
        names[{type, name}] = clean;
        Preset copy = *source;
        copy.config = type == Preset::TYPE_PRINT ? collection(type).get_edited_preset().config :
            PresetDrafts::effective_preset_config(state().presets, state().preset_drafts, type, name);
        copy.name = clean;
        // Retained sources already sever mutable user ancestors. Keeping the
        // system ancestor preserves Orca compatibility; explicit diff metadata
        // below prevents its defaults from replacing the frozen values.
        std::set<std::string> visited;
        while (parent && !parent->is_system && visited.insert(parent->name).second)
            parent = collection(type).get_preset_parent(*parent);
        copy.inherits() = parent && parent->is_system ? parent->name : std::string{};
        copy.neo_vector_overrides.clear();
        copy.is_project_embedded = true; copy.is_external = false; copy.vendor = nullptr;
        if (type == Preset::TYPE_FILAMENT) copy.config.option<ConfigOptionStrings>("filament_settings_id", true)->values = {clean};
        else copy.config.option<ConfigOptionString>(type == Preset::TYPE_PRINT ? "print_settings_id" : "printer_settings_id", true)->value = clean;
        result.push_back(std::move(copy));
        return clean;
    };
    config.option<ConfigOptionString>("printer_settings_id", true)->value = export_name(Preset::TYPE_PRINTER, state().presets.printers.get_selected_preset_name());
    config.option<ConfigOptionString>("print_settings_id", true)->value = export_name(Preset::TYPE_PRINT, state().presets.prints.get_selected_preset_name());
    auto& ids = config.option<ConfigOptionStrings>("filament_settings_id", true)->values;
    ids.clear();
    for (const auto& name : state().presets.filament_presets) ids.push_back(export_name(Preset::TYPE_FILAMENT, name));
    for (const auto* preset : embedded) {
        if (names.count({preset->type, preset->name})) continue;
        // Inactive snapshot descendants are history, not project export inputs.
        if (is_snapshot(preset->type, preset->name) ||
            is_snapshot(preset->type, preset->inherits())) continue;
        result.push_back(*preset);
    }
    auto& diff = config.option<ConfigOptionStrings>("different_settings_to_system", true)->values;
    auto& inherits = config.option<ConfigOptionStrings>("inherits_group", true)->values;
    diff.resize(state().presets.filament_presets.size() + 2);
    inherits.resize(diff.size());
    const auto mark_frozen = [&](Preset::Type type, const std::string& original, size_t index) {
        const auto found = names.find({type, original});
        if (found == names.end()) return;
        const auto preset = std::find_if(result.begin(), result.end(), [&](const Preset& value) {
            return value.type == type && value.name == found->second;
        });
        if (preset == result.end()) return;
        // Orca interprets this list as actual differences, including its
        // modified-G-code safety check. Listing every frozen option falsely
        // marks unchanged user presets as unsafe in multi-filament projects.
        const auto* parent = collection(type).find_preset(preset->inherits(), false, true);
        static const std::set<std::string> identity_keys = {
            "inherits", "print_settings_id", "filament_settings_id", "printer_settings_id"
        };
        // Match PresetBundle::full_config's parent-diff filtering, including
        // optional keys. A parentless version still needs its full values.
        const auto keys = parent ? PresetCollection::dirty_options_without_option_list(
            &*preset, parent, identity_keys, false) : preset->config.keys();
        diff[index] = escape_strings_cstyle(keys);
        inherits[index] = preset->inherits();
    };
    mark_frozen(Preset::TYPE_PRINT, state().presets.prints.get_selected_preset_name(), 0);
    mark_frozen(Preset::TYPE_PRINTER, state().presets.printers.get_selected_preset_name(), diff.size() - 1);
    for (size_t index = 0; index < state().presets.filament_presets.size(); ++index)
        mark_frozen(Preset::TYPE_FILAMENT, state().presets.filament_presets[index], index + 1);
    return result;
}

const Preset* source_for(Preset::Type type, const std::string& name) {
    auto& c = collection(type);
    const auto* source = c.find_preset(view_name(type, name), false, true);
    if (source && type == Preset::TYPE_PRINT && source->is_project_embedded && !source->inherits().empty()) {
        if (const auto* parent = c.find_preset(source->inherits(), false, true)) return parent;
    }
    return source;
}
bool deleted(Preset::Type type, const std::string& name) {
    const auto found = snapshots.find({type, name});
    return found != snapshots.end() && found->second.deleted;
}
json info(Preset::Type type, const std::string& name) {
    const auto* source = source_for(type, name);
    if (!source) throw std::runtime_error("preset not found");
    const auto* head = baseline(type, source->name);
    const bool writable = head && head->is_user() && !head->is_project_embedded && !deleted(type, source->name);
    // SavePresetDialog::Item naming rules, with session aliases resolved back
    // to the original user name so snapshot/deletion markers stay out of files.
    const auto snapshot = snapshots.find({type, source->name});
    std::string save_as_name = snapshot != snapshots.end() ? snapshot->second.original :
        source->is_default ? "Untitled" : source->is_system ? source->name + " - Copy" :
        source->is_from_bundle() && !source->alias.empty() ? source->alias : source->name;
    if (save_as_name.size() >= 4) {
        auto extension = save_as_name.substr(save_as_name.size() - 4);
        std::transform(extension.begin(), extension.end(), extension.begin(), [](unsigned char ch) { return std::tolower(ch); });
        if (extension == ".ini") save_as_name.resize(save_as_name.size() - 4);
    }
    return {{"ok", true}, {"kind", kind_name(type)}, {"canonical_name", name},
        {"default_save_as_name", save_as_name},
        {"overwrite_name", writable ? json(head->name) : json(nullptr)}, {"compatible", source->is_compatible},
        {"label", display_label(*source)}, {"can_save", writable}, {"can_delete", writable},
        {"can_reset", type == Preset::TYPE_PRINT && is_snapshot(type, source->name)},
        {"deleted", deleted(type, source->name)}, {"revision", state().history_revision}};
}

void validate_name(const std::string& name) {
    if (name.empty() || name.find_first_of("/\\<>:\"|?*\r\n\t") != std::string::npos ||
        name.front() == ' ' || name.back() == ' ' || name.back() == '.' ||
        name.find("[snapshot ") != std::string::npos)
        throw std::runtime_error("Choose a valid, unused preset name");
    for (unsigned char c : name) if (c < 32) throw std::runtime_error("Invalid preset name");
}

json prepare(const json& request) {
    const auto editing_context = HistoryMetadata::parse_history_context(
        request.at("history_context").dump().c_str());
    if (pending || state().active_history_transaction || state().history.operation_active())
        throw std::runtime_error("Finish the current operation first");
    if (request.at("expected_revision").get<std::uint64_t>() != state().history_revision)
        throw std::runtime_error("Preset state changed; refresh and retry");
    const auto type = kind(request.at("kind").get<std::string>());
    auto& c = collection(type);
    const std::string requested = request.at("canonical_name").get<std::string>();
    const auto* source_ptr = source_for(type, requested);
    if (!source_ptr) throw std::runtime_error("preset not found");
    Preset source = *source_ptr;
    const std::string from = source.name;
    const std::string action = request.at("action").get<std::string>();
    const bool remove = action == "delete";
    if (action != "save-as" && !remove && action != "save") throw std::runtime_error("invalid user preset action");
    const auto capabilities = info(type, requested);
    if (action != "save-as" && !capabilities.at("can_save").get<bool>()) throw std::runtime_error("This preset can only be saved as a new preset");
    const Preset* baseline_head = baseline(type, from);
    const std::optional<Preset> saved_head = baseline_head ? std::optional<Preset>(*baseline_head) : std::nullopt;
    const Preset* head = saved_head ? &*saved_head : nullptr;
    const std::string target = action == "save-as" ? request.at("name").get<std::string>() : head->name;
    const bool save_as = action == "save-as" &&
        (!capabilities.at("can_save").get<bool>() || target != head->name);
    validate_name(target);
    std::optional<Preset> destination;
    if (save_as) {
        std::string lower = target;
        std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char ch) { return std::tolower(ch); });
        for (const auto& preset : c) {
            std::string other = preset.name;
            std::transform(other.begin(), other.end(), other.begin(), [](unsigned char ch) { return std::tolower(ch); });
            if (other != lower) continue;
            if (preset.name != target) throw std::runtime_error("A preset with that name already exists with different capitalization");
            if (!preset.is_user() || preset.is_project_embedded || is_snapshot(type, preset.name))
                throw std::runtime_error("Overwriting this preset is not allowed");
            if (!request.value("confirm_overwrite", false)) throw std::runtime_error("Confirm overwriting the existing user preset");
            destination = preset;
        }
    }
    if (!save_as) destination = *head;
    if (remove) for (const auto& preset : c)
        if (preset.is_user() && !preset.is_project_embedded && preset.inherits() == target)
            throw std::runtime_error("Delete the dependent user presets first");

    Preset candidate = source;
    candidate.config = type == Preset::TYPE_PRINT && active(type, from)
        ? c.get_edited_preset().config : type == Preset::TYPE_PRINT ? source.config :
        PresetDrafts::effective_preset_config(state().presets, state().preset_drafts, type, from);
    candidate.neo_vector_overrides.clear();
    // A Process draft is an embedded child of the saved head. Copy its
    // effective values, but never overwrite the head with a self-inheritance.
    if (!save_as) candidate.inherits() = head->inherits();
    // Overwriting an ancestor from its child must not create self-inheritance
    // or a cycle. Full effective values preserve the source configuration.
    if (destination && save_as) {
        auto parent = candidate.inherits();
        std::set<std::string> visited;
        while (!parent.empty() && visited.insert(parent).second) {
            if (parent == target) { candidate.inherits() = destination->inherits(); break; }
            const auto* preset = c.find_preset(parent, false, true);
            parent = preset ? preset->inherits() : std::string{};
        }
    }
    if (is_snapshot(type, from)) {
        candidate.name = target;
        candidate.is_external = false;
        candidate.is_project_embedded = false;
    }
    const bool was_active = active(type, from);
    std::string source_active_name = from;
    std::string target_active_name = destination ? view_name(type, target) : target;
    const bool target_was_active = destination && active(type, target_active_name);
    const bool affects_project = was_active || target_was_active;
    auto transaction = std::make_unique<Pending>();
    std::string result_name = target;
    try {
        PresetContextRenames renames;
        std::string retained;
        const std::string path = destination ? destination->file : std::string{};
        std::vector<std::string> descendants;
        if (destination && !remove) {
            std::set<std::string> parents{target};
            for (bool added = true; added;) {
                added = false;
                for (const auto& preset : c) if (!is_snapshot(type, preset.name) && preset.is_user() &&
                    !preset.is_project_embedded && !parents.count(preset.name) && parents.count(preset.inherits())) {
                    descendants.push_back(preset.name); parents.insert(preset.name); added = true;
                }
            }
            for (const auto& name : descendants) {
                const bool selected = active(type, name);
                const auto edited = c.get_edited_preset().config;
                const auto frozen = retain(type, name, renames);
                if (selected) {
                    adopt(type, name, frozen);
                    if (source_active_name == name) source_active_name = frozen;
                    if (type == Preset::TYPE_PRINT) c.get_edited_preset().config = edited;
                    if (const auto* draft = state().preset_drafts.find(type, name))
                        for (const auto& [key, value] : *draft) state().preset_drafts.set(type, frozen, key, value);
                    state().preset_drafts.erase_preset(type, name);
                }
            }
        }
        if (destination) retained = retain(type, target, renames);
        if (save_as && target_was_active && target_active_name == target) {
            const auto edited = c.get_edited_preset().config;
            adopt(type, target, retained);
            if (type == Preset::TYPE_PRINT) c.get_edited_preset().config = edited;
            if (const auto* draft = state().preset_drafts.find(type, target))
                for (const auto& [key, value] : *draft) state().preset_drafts.set(type, retained, key, value);
            state().preset_drafts.erase_preset(type, target);
            target_active_name = retained;
        }
        if (remove) {
            for (auto& [key, record] : snapshots) {
                if (key.first != type) continue;
                if (record.original == target) record.deleted = true;
                // A later same-name creation is a different parent identity.
                auto& chain = record.ancestors;
                chain.erase(std::remove(chain.begin(), chain.end(), target), chain.end());
            }
            // If Undo already selected an older version, retain that version's
            // effective values, not the newer head that is being deleted.
            if (is_snapshot(type, from)) retained = from;
            // Keep the deleted source, including unsaved edits, in the before state.
            adopt(type, from, retained);
            if (from != retained) {
                if (const auto* draft = state().preset_drafts.find(type, from))
                    for (const auto& [key, value] : *draft) state().preset_drafts.set(type, retained, key, value);
                state().preset_drafts.erase_preset(type, from);
            }
            if (type == Preset::TYPE_PRINT && was_active) c.get_edited_preset().config = candidate.config;
        }
        const bool history_entry = was_active && (save_as || remove);
        // Historical before roots must be frozen before the new operation
        // captures its live predecessor. A history-neutral Save can combine
        // migration with the post-save current binding below instead.
        if (history_entry) renames.publish(state().history);
        const auto before = context(editing_context);
        if (history_entry && !HistoryMetadata::begin_timestamped_operation(state(), save_as ? "Save preset as" : "Delete preset", before))
            throw std::runtime_error("could not begin preset history");

        json change;
        if (remove) {
            // Resolve replacement through the native visible compatible catalogue.
            std::string replacement;
            for (const auto& preset : c) if (preset.name != target && !is_snapshot(type, preset.name) &&
                preset.is_visible && (type == Preset::TYPE_PRINTER || preset.is_compatible)) { replacement = preset.name; break; }
            if (replacement.empty()) replacement = c.default_preset().name;
            if (was_active) adopt(type, retained, replacement);
            auto* removed = c.find_preset(target, false, true);
            const auto selected_name = c.get_selected_preset_name();
            const auto edited = c.get_edited_preset();
            removed->file.clear(); // host owns the durable file deletion
            if (!c.delete_preset(target, true)) throw std::runtime_error("could not delete user preset");
            c.select_preset_by_name(selected_name, true);
            c.get_edited_preset() = edited;
            result_name = replacement;
            change = {{"path", repository_path(path)}, {"content", nullptr}};
            transaction->delete_file = path;
        } else {
            const bool detach = !destination && save_as && is_snapshot(type, from);
            transaction->watch(destination ? path : c.path_from_name(target, detach));
            c.save_current_preset(target, detach, false, &candidate);
            for (const auto& name : descendants) {
                auto* child = c.find_preset(name, false, true);
                if (const auto* parent = c.get_preset_parent(*child)) child->reload(*parent);
            }
            const auto* saved = c.find_preset(target, false, true);
            if (!saved) throw std::runtime_error("saved user preset not found");
            std::ifstream input(saved->file);
            if (!input) throw std::runtime_error("could not read saved user preset");
            std::ostringstream content; content << input.rdbuf();
            change = {{"path", repository_path(saved->file)}, {"content", content.str()}};
            if (was_active) {
                adopt(type, source_active_name, target);
                if (type == Preset::TYPE_PRINT) c.select_preset_by_name(target, true);
            }
            if (save_as && target_was_active) adopt(type, target_active_name, target);
            state().preset_drafts.erase_preset(type, from);
            state().preset_drafts.erase_preset(type, source_active_name);
            if (save_as && target_was_active) state().preset_drafts.erase_preset(type, target_active_name);
            state().preset_drafts.erase_preset(type, target);
        }
        // Native compatibility and bed normalization are part of the one action.
        if (affects_project) {
            state().presets.update_compatible(PresetSelectCompatibleType::Always);
            state().presets.update_multi_material_filament_presets();
            Profiles::normalize_bed_types(type == Preset::TYPE_PRINTER);
        }
        const auto plate = affects_project ? PlateSession::shared_configuration_mutation_snapshot() : PlateSession::plate_session_snapshot_json();
        ++state().preset_draft_revision;
        const auto after = context(editing_context);
        if (history_entry) {
            if (!HistoryMetadata::commit_timestamped_operation(state(), after)) throw std::runtime_error("could not commit preset history");
        } else {
            const auto current = JsonContextCodec::encode(after);
            renames.publish(state().history, &current);
            state().history_live_context = after;
            HistoryMetadata::advance_history_epoch(state());
        }
        json result = {{"ok", true}, {"canonical_name", result_name}, {"kind", kind_name(type)},
            {"profile_snapshot", Profiles::preset_snapshot_json()},
            {"filament_session", Filament::Session::filament_session_snapshot_json()},
            {"plate_session", plate}, {"history_status", HistoryMetadata::history_status_json(state())},
            {"native_scoped_config", ScopedConfig::native_scoped_config_full_transport(state().history_revision)},
            {"history_entry_delta", history_entry ? 1 : 0}};
        pending = std::move(transaction);
        return {{"ok", true}, {"token", ++token}, {"change", std::move(change)}, {"result", std::move(result)}};
    } catch (...) {
        if (state().history.operation_active()) HistoryMetadata::abort_timestamped_operation(state());
        throw;
    }
}
}

extern "C" {
EMSCRIPTEN_KEEPALIVE const char* orc_user_preset_info(const char* kind, const char* name) {
    using namespace Slic3r::Neo::Bridge;
    try { return Profiles::duplicate_json(UserPresets::info(UserPresets::kind(kind ? kind : ""), name ? name : "").dump()); }
    catch (const std::exception& error) { return Profiles::duplicate_json(nlohmann::json{{"ok", false}, {"error", error.what()}}.dump()); }
}
EMSCRIPTEN_KEEPALIVE const char* orc_prepare_user_preset(const char* request) {
    using namespace Slic3r::Neo::Bridge;
    try { return Profiles::duplicate_json(UserPresets::prepare(nlohmann::json::parse(request)).dump()); }
    catch (const std::exception& error) { return Profiles::duplicate_json(nlohmann::json{{"ok", false}, {"error", error.what()}}.dump()); }
}
EMSCRIPTEN_KEEPALIVE const char* orc_finish_user_preset(const char* request) {
    using namespace Slic3r::Neo::Bridge;
    try {
        const auto value = nlohmann::json::parse(request);
        if (!UserPresets::pending || value.at("token").get<std::uint64_t>() != UserPresets::token) throw std::runtime_error("stale user preset transaction");
        if (value.at("commit").get<bool>()) {
            if (!UserPresets::pending->delete_file.empty()) {
                boost::filesystem::remove(UserPresets::pending->delete_file);
                boost::filesystem::remove(boost::filesystem::path(UserPresets::pending->delete_file).replace_extension(".info"));
            }
            UserPresets::pending->publication.commit();
            UserPresets::pending->accepted = true;
            SlicingPipeline::invalidate_preview_source();
        }
        const bool collect = UserPresets::pending->accepted && UserPresets::pending->had_redo;
        UserPresets::pending.reset();
        UserPresets::collect_discarded_redo_snapshots(collect);
        return Profiles::duplicate_json("{\"ok\":true}");
    } catch (const std::exception& error) { return Profiles::duplicate_json(nlohmann::json{{"ok", false}, {"error", error.what()}}.dump()); }
}
}
