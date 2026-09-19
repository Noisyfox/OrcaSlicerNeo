// ----------------------------------------------------------------
// Slicing, progress, preview, G-code, and threading bridge pipeline.
//
// This translation unit owns the slice/result pipeline and its asynchronous
// task transport; renderer-facing client results remain promise-compatible.
// ----------------------------------------------------------------
#include <emscripten/emscripten.h>
#ifdef ORCA_WASM_THREADING
#include <emscripten/threading.h>
#endif

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <condition_variable>
#include <deque>
#include <fstream>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "bridge_buffers.hpp"
#include "bridge_filament.hpp"
#include "bridge_history.hpp"
#include "bridge_plate.hpp"
#include "bridge_prime_tower.hpp"
#include "bridge_slicing_pipeline.hpp"
#include "bridge_state.hpp"
#include "libslic3r/BuildVolume.hpp"
#include "libslic3r/Exception.hpp"
#include "libslic3r/GCode/GCodeProcessor.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/Print.hpp"

#include <nlohmann/json.hpp>

using namespace Slic3r;
using nlohmann::json;

namespace Slic3r::Neo::Bridge::SlicingPipeline {

namespace {
using Neo::Bridge::BridgeState;
using Neo::Bridge::state;
using namespace Neo::Bridge::PlateSession;

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

std::string error_message_from_exception(const std::exception& e) {
    if (const auto* se = dynamic_cast<const SlicingErrors*>(&e); se != nullptr) {
        std::string joined;
        for (const auto& err : se->errors_) {
            if (!joined.empty()) joined += "\n";
            joined += err.what();
        }
        if (!joined.empty()) return joined;
    }
    return e.what();
}

const char* error_json_from_exception(const std::exception& e) {
    return error_json(error_message_from_exception(e));
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
} // namespace

void invalidate_preview_result_only()
{
    Neo::Bridge::PrimeTower::invalidate_projection_cache();
}

// Print::apply() reads ModelInstance::is_printable() while it builds its
// native snapshot.  Keep that existing PartPlate context on the authoritative
// model for the duration of the synchronous apply, then restore the bridge
// model before any later slice stage can observe it.  This carries only the
// derived print-volume states and plate index; it never clones or filters a
// Model just for Slice.
class ScopedPlateModelContext {
    struct InstanceState {
        ModelInstance* instance;
        ModelInstanceEPrintVolumeState print_volume_state;
    };

    Model& model_;
    const int previous_plate_index_;
    std::vector<InstanceState> previous_instance_states_;

public:
    ScopedPlateModelContext(Model& model, const BridgeState::PlateSessionPlate& plate)
        : model_(model), previous_plate_index_(model.curr_plate_index)
    {
        for (ModelObject* object : model_.objects)
            for (ModelInstance* instance : object->instances)
                previous_instance_states_.push_back({instance, instance->print_volume_state});

        try {
            const PlateBounds bounds = selected_plate_bounds();
            const BuildVolume build_volume(selected_printable_area(bounds, plate), bounds.max_z, {}, {});
            model_.curr_plate_index = plate.display_index;
            model_.update_print_volume_state(build_volume);
        } catch (...) {
            restore();
            throw;
        }
    }

    ~ScopedPlateModelContext()
    {
        restore();
    }

private:
    void restore()
    {
        model_.curr_plate_index = previous_plate_index_;
        for (const InstanceState& previous : previous_instance_states_)
            previous.instance->print_volume_state = previous.print_volume_state;
    }
};

void invalidate_preview_source()
{
    PrimeTower::invalidate_projection_cache();
    invalidate_preview_result_only();
}

extern "C" {
using async_task_notify_fn = void (*)();

// The shared-memory structure is only a wake signal. Task lifecycle data is
// retained in the C++ FIFO below and drained exactly once on the stateful
// Worker. The task id is split into high/low words so wasm64 identities never
// pass through a lossy JavaScript number.
struct alignas(4) AsyncTaskWakeMailbox {
    std::atomic<std::uint32_t> sequence{0}; // odd while a writer owns it
    std::atomic<std::uint32_t> wake_sequence{0};
    std::atomic<std::uint32_t> task_id_low{0};
    std::atomic<std::uint32_t> task_id_high{0};
};
static_assert(sizeof(std::atomic<std::uint32_t>) == sizeof(std::uint32_t));
static_assert(offsetof(AsyncTaskWakeMailbox, sequence) == 0);
static_assert(offsetof(AsyncTaskWakeMailbox, wake_sequence) == 4);
static_assert(offsetof(AsyncTaskWakeMailbox, task_id_low) == 8);
static_assert(offsetof(AsyncTaskWakeMailbox, task_id_high) == 12);

struct AsyncTaskMessage {
    std::uint64_t sequence = 0;
    std::uint64_t task_id = 0;
    json payload;
};

constexpr std::size_t k_async_task_mailbox_capacity = 8192;
AsyncTaskWakeMailbox g_async_task_wake_mailbox;
std::mutex g_async_task_wake_mutex;
std::mutex g_async_task_mailbox_mutex;
std::condition_variable g_async_task_mailbox_not_full;
std::deque<AsyncTaskMessage> g_async_task_messages;
std::uint64_t g_next_async_task_message_sequence = 1;
async_task_notify_fn g_async_task_notify = nullptr;

struct ForegroundProgressTask {
    std::uint64_t id = 0;
    std::string kind;
};
std::mutex g_foreground_progress_mutex;
std::optional<ForegroundProgressTask> g_foreground_progress_task;

std::uint64_t allocate_async_task_id()
{
    auto& next = state().next_async_task_id;
    if (next == std::numeric_limits<std::uint64_t>::max())
        throw std::overflow_error("asynchronous task id allocator exhausted");
    return next++;
}

void signal_async_task_mailbox(const std::uint64_t task_id)
{
    {
        // The stateful Worker and a job pthread may enqueue concurrently.
        // Serialize wake writers so the seqlock is always odd for the entire
        // payload write and returns to one strictly newer even generation.
        std::lock_guard<std::mutex> lock(g_async_task_wake_mutex);
        const std::uint32_t odd =
            g_async_task_wake_mailbox.sequence.fetch_add(1, std::memory_order_acq_rel) + 1;
        g_async_task_wake_mailbox.wake_sequence.fetch_add(1, std::memory_order_relaxed);
        g_async_task_wake_mailbox.task_id_low.store(
            static_cast<std::uint32_t>(task_id & 0xffffffffu), std::memory_order_relaxed);
        g_async_task_wake_mailbox.task_id_high.store(
            static_cast<std::uint32_t>(task_id >> 32), std::memory_order_relaxed);
        g_async_task_wake_mailbox.sequence.store(odd + 1, std::memory_order_release);
    }
    // Every message is first committed to the same ordered FIFO. Producers on
    // the main runtime thread may then synchronously ask JavaScript to drain
    // that FIFO. A pthread cannot enter the JS function table, so it stops at
    // the shared wake above and the stateful Worker drains it on its timer.
#ifdef ORCA_WASM_THREADING
    if (emscripten_is_main_runtime_thread() && g_async_task_notify != nullptr)
        g_async_task_notify();
#else
    if (g_async_task_notify != nullptr) g_async_task_notify();
#endif
}

void enqueue_async_task_message(const std::uint64_t task_id, json payload)
{
    {
        std::unique_lock<std::mutex> lock(g_async_task_mailbox_mutex);
        g_async_task_mailbox_not_full.wait(lock, [] {
            return g_async_task_messages.size() < k_async_task_mailbox_capacity;
        });
        payload["task_id"] = std::to_string(task_id);
        g_async_task_messages.push_back(
            {g_next_async_task_message_sequence++, task_id, std::move(payload)});
    }
    signal_async_task_mailbox(task_id);
}

void enqueue_task_progress(const std::uint64_t task_id, const std::string_view kind,
                           const int percent, const std::string_view text,
                           const std::string_view plate_id = {},
                           const std::uint64_t incarnation_id = 0)
{
    json message{{"type", "progress"}, {"kind", kind},
                 {"percent", std::clamp(percent, 0, 100)}, {"text", text}};
    if (!plate_id.empty()) message["plate_id"] = plate_id;
    if (incarnation_id != 0)
        message["entry_incarnation"] = std::to_string(incarnation_id);
    enqueue_async_task_message(task_id, std::move(message));
}

void enqueue_task_terminal(const std::uint64_t task_id, const std::string_view kind,
                           const std::string_view terminal, json result,
                           const std::string_view plate_id = {},
                           const std::uint64_t incarnation_id = 0)
{
    json message{{"type", "task-terminal"}, {"kind", kind},
                 {"terminal", terminal}, {"result", std::move(result)}};
    if (!plate_id.empty()) message["plate_id"] = plate_id;
    if (incarnation_id != 0)
        message["entry_incarnation"] = std::to_string(incarnation_id);
    enqueue_async_task_message(task_id, std::move(message));
}

void begin_progress(std::string_view text)
{
    std::lock_guard<std::mutex> lock(g_foreground_progress_mutex);
    const std::uint64_t task_id = allocate_async_task_id();
    g_foreground_progress_task = ForegroundProgressTask{task_id, "project-load"};
    enqueue_task_progress(task_id, "project-load", 0, text);
}

void publish_slicer_progress(int percent, std::string_view text)
{
    std::lock_guard<std::mutex> lock(g_foreground_progress_mutex);
    if (g_foreground_progress_task)
        enqueue_task_progress(g_foreground_progress_task->id,
                              g_foreground_progress_task->kind, percent, text);
}

void finish_progress(std::string_view text)
{
    std::lock_guard<std::mutex> lock(g_foreground_progress_mutex);
    if (!g_foreground_progress_task) return;
    const auto task = *g_foreground_progress_task;
    g_foreground_progress_task.reset();
    enqueue_task_progress(task.id, task.kind, 100, text);
    enqueue_task_terminal(task.id, task.kind, "completed", json{{"ok", true}});
}

void stop_progress()
{
    std::lock_guard<std::mutex> lock(g_foreground_progress_mutex);
    if (!g_foreground_progress_task) return;
    const auto task = *g_foreground_progress_task;
    g_foreground_progress_task.reset();
    enqueue_task_terminal(task.id, task.kind, "failed", json{{"error", "task failed"}});
}
} // extern "C"

PlateRuntimeRegistry::Entry* runtime_entry_for_plate(const std::string& plate_id,
                                                      std::string& error)
{
    auto* entry = state().plate_runtime_registry.find(plate_id);
    if (entry == nullptr || entry->print == nullptr || entry->gcode_result == nullptr) {
        error = "plate operation target was not found";
        return nullptr;
    }
    return entry;
}

std::uint64_t current_input_revision_for_plate(const std::string& plate_id)
{
    const auto it = state().plate_input_revisions.find(plate_id);
    return it == state().plate_input_revisions.end() ? 0 : it->second;
}

const char* result_unavailable_error()
{
    return dup_json(json{{"ok", false}, {"status", "unavailable"},
                         {"error", "plate slice result is stale or unavailable"}}.dump());
}

const char* result_stale_error()
{
    return dup_json(json{{"ok", false}, {"status", "stale"},
                         {"error", "plate slice result was superseded"}}.dump());
}

json projection_receipt(const PlateRuntimeRegistry::Entry& entry)
{
    return json{{"plate_id", entry.plate_id},
                {"input_stamp", entry.completed_input_revision.value_or(0)},
                {"result_generation", std::to_string(entry.result_generation)},
                {"slice_task_id", std::to_string(entry.completed_slice_task_id.value_or(0))}};
}

std::string generation_gcode_path(const PlateRuntimeRegistry::Entry& entry,
                                  const std::uint64_t generation)
{
    std::string safe_id = entry.plate_id;
    for (char& value : safe_id) {
        const unsigned char byte = static_cast<unsigned char>(value);
        if (!std::isalnum(byte) && value != '-' && value != '_') value = '_';
    }
    return "/plate-result-" + safe_id + "-" +
           std::to_string(entry.incarnation_id) + "-" +
           std::to_string(generation) + ".gcode";
}

void materialize_completed_generation(PlateRuntimeRegistry::Entry& entry)
{
    const std::uint64_t generation = entry.result_generation + 1;
    const std::string path = generation_gcode_path(entry, generation);
    entry.print->export_gcode(path, entry.gcode_result.get(), nullptr);

    std::ifstream source(path, std::ios::binary | std::ios::ate);
    if (!source.good()) {
        std::remove(path.c_str());
        throw std::runtime_error("completed slice G-code could not be opened");
    }
    const auto position = source.tellg();
    if (position < 0) {
        std::remove(path.c_str());
        throw std::runtime_error("completed slice G-code size is unavailable");
    }

    const std::string previous_path = entry.gcode_path;
    entry.gcode_path = path;
    entry.gcode_size = static_cast<std::size_t>(position);
    entry.gcode_line_ends.assign(entry.gcode_result->lines_ends.begin(),
                                 entry.gcode_result->lines_ends.end());
    entry.gcode_text_available = true;
    entry.result_generation = generation;
    if (!previous_path.empty() && previous_path != path)
        std::remove(previous_path.c_str());
}

struct SliceTask {
    SliceTask(const std::uint64_t task_id_, std::string plate_id_,
              const std::uint64_t revision_, PlateRuntimeRegistry::JobLease lease_)
        : task_id(task_id_), plate_id(std::move(plate_id_)), revision(revision_),
          incarnation_id(lease_.entry().incarnation_id), lease(std::move(lease_))
    {}

    std::uint64_t task_id;
    std::string plate_id;
    std::uint64_t revision;
    std::uint64_t incarnation_id;
    PlateRuntimeRegistry::JobLease lease;
    json unrecognized_keys = json::array();
    json warnings = json::array();
};

struct PendingSliceRequest {
    std::uint64_t task_id = 0;
    std::string config_json;
    std::string plate_id;
    std::uint64_t entry_incarnation = 0;
};

std::mutex g_slice_job_mutex;
std::shared_ptr<SliceTask> g_active_slice_task;
std::optional<PendingSliceRequest> g_pending_slice_request;
std::uint64_t g_serial_terminal_epoch = 0;
#ifdef ORCA_WASM_THREADING
// Keep the dedicated slice pthread joinable until its native terminal reaches
// the stateful Worker. The terminal is enqueued from inside the pthread, so it
// can otherwise be observed while the pthread is still unwinding. Clearing
// g_active_slice_task in that gap permits history edits or a second slice to
// overlap Emscripten/oneTBB thread teardown and corrupt the shared WASM heap.
std::thread g_slice_worker_thread;
#endif

void start_pending_slice_if_any();

json slice_task_acceptance(const std::uint64_t task_id, const std::string_view plate_id,
                           const std::uint64_t incarnation_id)
{
    return json{{"accepted", true}, {"kind", "slice"},
                {"task_id", std::to_string(task_id)}, {"plate_id", plate_id},
                {"entry_incarnation", std::to_string(incarnation_id)}};
}

void release_active_slice_task(const std::shared_ptr<SliceTask>& task)
{
    std::lock_guard<std::mutex> lock(g_slice_job_mutex);
    if (g_active_slice_task == task) {
        g_active_slice_task.reset();
#ifndef ORCA_WASM_THREADING
        ++g_serial_terminal_epoch;
#endif
    }
}

std::pair<std::string, json> finalize_slice_task(
    const std::shared_ptr<SliceTask>& task, const std::string_view process_outcome,
    const std::string_view process_error)
{
    auto& registry = state().plate_runtime_registry;
    const bool cancelled = registry.cancellation_requested(task->lease);
    if (process_outcome != "completed" || cancelled) {
        registry.mark_process_failed(task->lease);
        if (cancelled) task->lease.entry().print->restart();
        invalidate_preview_source();
        const std::string terminal = cancelled ? "cancelled" : "failed";
        const std::string error = cancelled ? "slice cancelled" :
            (process_error.empty() ? "slice failed" : std::string(process_error));
        release_active_slice_task(task);
        return {terminal, json{{"error", error}}};
    }

    const std::uint64_t current_revision = current_input_revision_for_plate(task->plate_id);
    if (current_revision != task->revision) {
        registry.mark_process_failed(task->lease);
        invalidate_preview_source();
        release_active_slice_task(task);
        return {"stale", json{{"error", "plate slice result is stale or unavailable"}}};
    }
    try {
        materialize_completed_generation(task->lease.entry());
    } catch (const std::bad_alloc&) {
        registry.mark_process_failed(task->lease);
        release_active_slice_task(task);
        return {"out_of_memory", json{{"error", "out of memory while materializing plate result"},
                                      {"plate_id", task->plate_id}, {"layer", "native-result"}}};
    } catch (const std::exception& error) {
        registry.mark_process_failed(task->lease);
        release_active_slice_task(task);
        return {"failed", json{{"error", error.what()}}};
    }
    const bool live_completion = registry.mark_process_completed(
        task->lease, task->revision, current_revision);
    if (!live_completion || !registry.can_publish_completed_job(task->lease, current_revision)) {
        invalidate_preview_source();
        release_active_slice_task(task);
        return {"stale", json{{"error", "plate slice result is stale or unavailable"}}};
    }

    auto& entry = task->lease.entry();
    PlateRuntimeRegistry::mark_presentation_valid(entry, current_revision);
    json result{{"ok", true}, {"unrecognized_keys", task->unrecognized_keys},
                {"warnings", task->warnings}, {"receipt", projection_receipt(entry)}};
    release_active_slice_task(task);
    return {"completed", std::move(result)};
}

std::optional<std::pair<std::string, json>> run_slice_process(
    const std::shared_ptr<SliceTask>& task)
{
    auto& print = *task->lease.entry().print;
    std::string outcome = "completed";
    std::string error;
    try {
#ifdef ORCA_WASM_THREADING
        state().tbb_arena.execute([&] { print.process(); });
#else
        print.process();
#endif
        enqueue_task_progress(task->task_id, "slice", 100, "Slice complete",
                              task->plate_id, task->incarnation_id);
    } catch (const std::exception& e) {
        outcome = "failed";
        error = error_message_from_exception(e);
    } catch (...) {
        outcome = "failed";
        error = "unknown exception";
    }
    print.set_status_default();

#ifdef ORCA_WASM_THREADING
    enqueue_async_task_message(task->task_id,
        json{{"type", "native-task-terminal"}, {"kind", "slice"},
             {"outcome", outcome}, {"error", error}, {"plate_id", task->plate_id},
             {"entry_incarnation", std::to_string(task->incarnation_id)}});
    return std::nullopt;
#else
    auto terminal_result = finalize_slice_task(task, outcome, error);
    const auto& [terminal, result] = terminal_result;
    enqueue_task_terminal(task->task_id, "slice", terminal, result,
                          task->plate_id, task->incarnation_id);
    return terminal_result;
#endif
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_get_async_task_mailbox()
{
    return dup_json(json{{"ok", true},
                         {"byte_offset", reinterpret_cast<std::uintptr_t>(&g_async_task_wake_mailbox)},
                         {"capacity", k_async_task_mailbox_capacity}}.dump());
}

extern "C" EMSCRIPTEN_KEEPALIVE void orc_set_async_task_callback(async_task_notify_fn cb) {
    // signal_async_task_mailbox invokes this callback only from the main
    // runtime thread. Threaded job pthreads retain wake-only delivery.
    g_async_task_notify = cb;
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_drain_async_task_mailbox()
{
    std::deque<AsyncTaskMessage> messages;
    {
        std::lock_guard<std::mutex> lock(g_async_task_mailbox_mutex);
        messages.swap(g_async_task_messages);
    }
    g_async_task_mailbox_not_full.notify_all();

    json drained = json::array();
    bool released_slice_job = false;
    for (auto& message : messages) {
        if (message.payload.value("type", "") == "native-task-terminal") {
#ifdef ORCA_WASM_THREADING
            // The terminal message proves run_slice_process has finished all
            // Print access. Join before publishing the terminal and releasing
            // the active-job gate so no subsequent bridge mutation or slice
            // can race the pthread runtime's final teardown.
            if (g_slice_worker_thread.joinable()) g_slice_worker_thread.join();
#endif
            std::shared_ptr<SliceTask> task;
            {
                std::lock_guard<std::mutex> lock(g_slice_job_mutex);
                if (g_active_slice_task && g_active_slice_task->task_id == message.task_id)
                    task = g_active_slice_task;
            }
            std::pair<std::string, json> terminal = task
                ? finalize_slice_task(task, message.payload.value("outcome", "failed"),
                                      message.payload.value("error", ""))
                : std::pair<std::string, json>{"stale", json{{"error", "stale task terminal"}}};
            message.payload = json{{"type", "task-terminal"}, {"kind", "slice"},
                                   {"terminal", terminal.first},
                                   {"result", std::move(terminal.second)},
                                   {"plate_id", message.payload.value("plate_id", "")},
                                   {"entry_incarnation", message.payload.value("entry_incarnation", "0")},
                                   {"task_id", std::to_string(message.task_id)}};
            released_slice_job = true;
        }
        message.payload["sequence"] = std::to_string(message.sequence);
        drained.push_back(std::move(message.payload));
    }
    // The active task's terminal is already in this returned batch. Starting
    // the one retained replacement now puts all of its messages into the next
    // FIFO batch, preserving terminal-before-replacement ordering.
    if (released_slice_job) start_pending_slice_if_any();
    return dup_json(json{{"ok", true}, {"messages", std::move(drained)}}.dump());
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_check_serial_admission(const char* observed_epoch)
{
#ifdef ORCA_WASM_THREADING
    (void)observed_epoch;
    return dup_json(json{{"ok", true}}.dump());
#else
    try {
        const std::uint64_t observed = observed_epoch == nullptr
            ? std::numeric_limits<std::uint64_t>::max()
            : std::stoull(observed_epoch);
        std::lock_guard<std::mutex> lock(g_slice_job_mutex);
        if (g_active_slice_task || observed != g_serial_terminal_epoch)
            return error_json("slice_busy");
        return dup_json(json{{"ok", true},
                             {"terminal_epoch", std::to_string(g_serial_terminal_epoch)}}.dump());
    } catch (...) {
        return error_json("slice_busy");
    }
#endif
}

const char* slice_for_plate(const char* config_json, const std::string& plate_id,
                            const std::uint64_t revision,
                            const std::optional<std::uint64_t> reserved_task_id = std::nullopt,
                            const std::optional<std::uint64_t> expected_incarnation = std::nullopt) {
    std::shared_ptr<SliceTask> task;
    try {
#ifdef ORCA_WASM_THREADING
        if (!reserved_task_id) {
            std::shared_ptr<SliceTask> active;
            std::optional<PendingSliceRequest> replaced;
            std::uint64_t replacement_task_id = 0;
            std::uint64_t replacement_incarnation = 0;
            {
                std::lock_guard<std::mutex> lock(g_slice_job_mutex);
                if (g_active_slice_task) {
                    auto* entry = state().plate_runtime_registry.find(plate_id);
                    if (entry == nullptr || find_plate(plate_id) == nullptr)
                        return error_json("plate operation target was not found");
                    replacement_task_id = allocate_async_task_id();
                    replacement_incarnation = entry->incarnation_id;
                    active = g_active_slice_task;
                    replaced = std::move(g_pending_slice_request);
                    g_pending_slice_request = PendingSliceRequest{
                        replacement_task_id, config_json ? config_json : "", plate_id,
                        replacement_incarnation};
                }
            }
            if (active) {
                if (replaced) {
                    enqueue_task_terminal(replaced->task_id, "slice", "replaced",
                        json{{"error", "slice request was replaced by a newer explicit Slice"}},
                        replaced->plate_id, replaced->entry_incarnation);
                }
                state().plate_runtime_registry.request_job_cancellation(active->lease);
                return dup_json(slice_task_acceptance(replacement_task_id, plate_id,
                                                      replacement_incarnation).dump());
            }
        }
#endif
        {
            std::lock_guard<std::mutex> lock(g_slice_job_mutex);
            if (g_active_slice_task)
                return error_json("slice_busy");
        }
        // Refresh membership before the operation gate.  This is read-only
        // with respect to the editing model and makes direct bridge callers
        // obey the same empty/out-of-bounds rules as the UI path.
        rebuild_plate_membership(false);
        std::string target_error;
        const bool replacement_target = reserved_task_id.has_value();
        bool target_valid = false;
        if (!replacement_target) {
            target_valid = validate_plate_operation_target(plate_id, revision, target_error);
        } else {
            const auto* plate = find_plate(plate_id);
            const auto out_of_bounds = state().plate_out_of_bounds_ids.find(plate_id);
            bool has_member = false;
            for (const auto& [instance_id, member_plate_id] : state().instance_plate_ids) {
                (void)instance_id;
                if (member_plate_id == plate_id) { has_member = true; break; }
            }
            if (plate == nullptr) target_error = "plate operation target was not found";
            else if (current_input_revision_for_plate(plate_id) != revision)
                target_error = "plate operation target is stale";
            else if (out_of_bounds != state().plate_out_of_bounds_ids.end() &&
                     !out_of_bounds->second.empty())
                target_error = "current plate contains an out-of-bounds instance";
            else if (!has_member) target_error = "current plate is empty";
            else target_valid = true;
        }
        if (!target_valid) {
            if (reserved_task_id) {
                enqueue_task_terminal(*reserved_task_id, "slice", "not_sliceable",
                    json{{"error", target_error}}, plate_id, expected_incarnation.value_or(0));
            }
            return error_json(target_error);
        }
        auto* runtime_entry = runtime_entry_for_plate(plate_id, target_error);
        if (runtime_entry == nullptr)
            return error_json(target_error);
        if (expected_incarnation && runtime_entry->incarnation_id != *expected_incarnation) {
            const json result{{"error", "slice replacement target incarnation is stale"}};
            enqueue_task_terminal(*reserved_task_id, "slice", "stale", result,
                                  plate_id, *expected_incarnation);
            return dup_json(result.dump());
        }
        const std::uint64_t slice_task_id = reserved_task_id
            ? *reserved_task_id : allocate_async_task_id();
        task = std::make_shared<SliceTask>(slice_task_id, plate_id, revision,
            state().plate_runtime_registry.begin_slice(plate_id, slice_task_id, revision));
        {
            std::lock_guard<std::mutex> lock(g_slice_job_mutex);
            if (g_active_slice_task)
                return error_json("slice_busy");
            g_active_slice_task = task;
        }
        runtime_entry = &task->lease.entry();
        auto& print = *runtime_entry->print;

        // begin_slice() withdraws the old toolpath/result presentation before
        // any work begins. Starting a slice does not mutate model/config input,
        // so retain the prime-tower projection and used-slot summary. Actual
        // model/config mutations invalidate that source through their normal
        // commit paths.
        // libslic3r's internal phase reporting does not promise a final 100%
        // notification (the current FDM path often ends at 75%). Establish
        // stable operation boundaries for the UI around those detailed phases.
        enqueue_task_progress(task->task_id, "slice", 0, "Preparing slice",
                              task->plate_id, task->incarnation_id);
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
        const DynamicPrintConfig native_full_config = state().presets.full_config(false);
        // Project overrides and imported plate settings are canonical Worker state and win over
        // any renderer payload supplied for this slice request.  PlateData
        // carries native per-plate filament/tool mappings (for example a
        // H2D plate can map logical slots 1 and 2 to physical tools 2 and 1)
        // which are not part of the global PresetBundle config.  Apply that
        // native plate config before the small Neo overlay so imported
        // painted projects keep their plate-local tool mapping when sliced.
        if (const auto* plate = find_plate(plate_id))
            config.apply(plate->settings, true);
        apply_overlay_to_config(config, state().project_config_overlay["project"]);
        // Plater's full_config() is assembled from every active filament
        // preset. The renderer settings projection uses scalars for compact
        // values, so restore native multi-slot vectors once after every
        // overlay has been composed. Explicit JSON arrays remain authoritative.
        for (const std::string& key : native_full_config.keys()) {
            const auto* native_option = native_full_config.option(key);
            const auto* requested_option = config.option(key, false);
            if (native_option == nullptr || requested_option == nullptr ||
                !native_option->is_vector() || native_option->is_nil())
                continue;
            const auto* native_vector = static_cast<const ConfigOptionVectorBase*>(native_option);
            if (native_vector->size() > 1 && cfg.contains(key) && !cfg[key].is_array())
                config.set_key_value(key, native_option->clone());
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
        print.is_BBL_printer() = state().presets.is_bbl_vendor();
        const auto* target_plate = find_plate(plate_id);
        if (target_plate == nullptr || target_plate->display_index < 0)
            throw std::invalid_argument("plate operation target was not found");
        // PartPlate binds the reusable Print before applying the complete
        // world-space Model.  The binding supplies both per-plate config
        // selection and the target BuildVolume context used by apply/process.
        print.set_plate_index(target_plate->display_index);
        print.set_plate_origin(target_plate->origin);
        // Apply and process the authoritative world-space model directly.
        // Membership is maintained incrementally on the model's instances;
        // the scoped native context supplies the selected plate's printable
        // instances while PartPlate's plate index/origin supplies its local
        // coordinate context.  Print::apply() owns the native processing
        // snapshot, while the bridge must not clone/filter a Model just for
        // this slice.
        {
            ScopedPlateModelContext model_context(state().model, *target_plate);
            print.apply(state().model, config);
        }
        // Print::apply() may finish lazy native transform/config normalization
        // on the authoritative model while it constructs the reusable Print
        // snapshot. Refresh the history acceleration only after the scoped
        // plate state has been restored. The captured archives describe the
        // exact post-apply model; a later edit may therefore share every
        // untouched object without treating a pre-normalization archive as a
        // canonical predecessor.
        (void) Neo::History::Codec::capture_model_state(
            state().model, state().mesh_capture_cache, state().mutable_object_capture_cache);
        // Native validation also checks whether the generated prime tower
        // footprint overlaps a configured exclusion/wrapping area.  Those
        // three tower collision classes are slice-time advisories in Neo;
        // compute the typed warning projection before validation so only the
        // corresponding native tower diagnostics can be downgraded.  All
        // unrelated native validation failures remain blocking.
        json tower_warnings = json::array();
        try { tower_warnings = Neo::Bridge::PrimeTower::slice_warnings_for_plate(plate_id); }
        catch (...) { /* warning computation cannot affect native validation */ }
        // Drift at the pinned SHA: validate() returns StringObjectException
        // (PrintBase.hpp:30); use its .string member (same adaptation as
        // slice_main.cpp:55).
        const StringObjectException validation_error = print.validate();
        if (!validation_error.string.empty()) {
            const auto has_tower_warning = [&tower_warnings](const char* warning) {
                return std::find(tower_warnings.begin(), tower_warnings.end(), warning) != tower_warnings.end();
            };
            const auto is_exact_diagnostic = [&validation_error](const char* diagnostic) {
                std::string actual = validation_error.string;
                while (!actual.empty() && (actual.back() == '\r' || actual.back() == '\n')) actual.pop_back();
                return actual == diagnostic;
            };
            const bool exclusion_advisory =
                has_tower_warning("Prime Tower intersects an exclusion area.") &&
                is_exact_diagnostic("Prime Tower is too close to an exclusion area, and collisions will be caused.");
            const bool wrapping_advisory =
                has_tower_warning("Prime Tower intersects a wrapping-detection area.") &&
                is_exact_diagnostic("Prime Tower is too close to clumping detection area, and collisions will be caused.");
            if (!exclusion_advisory && !wrapping_advisory) {
                state().plate_runtime_registry.mark_process_failed(task->lease);
                release_active_slice_task(task);
                const json result{{"error", validation_error.string}};
                enqueue_task_terminal(task->task_id, "slice", "invalid_input", result,
                                      task->plate_id, task->incarnation_id);
                return dup_json(result.dump());
            }
        }

        // Drift at the pinned SHA: SlicingStatus is nested as
        // PrintBase::SlicingStatus (PrintBase.hpp:440), not a Slic3r-top-level
        // type — qualify it (status_callback_type is PrintBase's typedef too).
        print.set_status_callback([task](const PrintBase::SlicingStatus& st) {
            enqueue_task_progress(task->task_id, "slice", st.percent, st.text,
                                  task->plate_id, task->incarnation_id);
        });
        // Preserve the established public Slice result while the task-terminal
        // message becomes the sole lifecycle authority.
        for (const std::string& k : substitutions.unrecogized_keys)
            task->unrecognized_keys.push_back(k);
        task->warnings = std::move(tower_warnings);
        try { task->warnings = Neo::Bridge::PrimeTower::slice_warnings_for_plate(plate_id); }
        catch (...) { /* advisory warnings must never turn a successful slice into a hard error */ }
#ifdef ORCA_WASM_THREADING
        // The dedicated job pthread shares the module heap and participates in
        // the same oneTBB arena.  The stateful Worker remains available for
        // edits, cancellation, stamps, and mailbox draining.
        if (g_slice_worker_thread.joinable())
            throw std::runtime_error("slice worker terminal was not consumed");
        g_slice_worker_thread = std::thread([task] { run_slice_process(task); });
        return dup_json(slice_task_acceptance(task->task_id, task->plate_id,
                                              task->incarnation_id).dump());
#else
        // Fix round 2: additive success field — always present, empty when the
        // config is clean. M2 clients (config UI) rely on this to warn about
        // keys the pinned libslic3r dropped (handle_legacy's catch-all).
#endif
#ifndef ORCA_WASM_THREADING
        run_slice_process(task);
        return dup_json(slice_task_acceptance(task->task_id, task->plate_id,
                                              task->incarnation_id).dump());
#endif
    } catch (const std::exception& e) {
        if (task) {
            state().plate_runtime_registry.mark_process_failed(task->lease);
            release_active_slice_task(task);
            const json result{{"error", e.what()}};
            enqueue_task_terminal(task->task_id, "slice", "failed", result,
                                  task->plate_id, task->incarnation_id);
        }
        // process() is where libslic3r throws SlicingErrors (GCode.cpp:2250);
        // the helper surfaces the per-object messages instead of the bare
        // category. This is the only bridge call that can throw it, so the
        // other catches keep plain e.what().
        return error_json_from_exception(e);
    } catch (...) {
        if (task) {
            state().plate_runtime_registry.mark_process_failed(task->lease);
            release_active_slice_task(task);
        }
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
        if (task) {
            const json result{{"error", msg}};
            enqueue_task_terminal(task->task_id, "slice", "failed", result,
                                  task->plate_id, task->incarnation_id);
        }
        return error_json(msg);
    }
}

void start_pending_slice_if_any()
{
#ifdef ORCA_WASM_THREADING
    std::optional<PendingSliceRequest> pending;
    {
        std::lock_guard<std::mutex> lock(g_slice_job_mutex);
        if (g_active_slice_task || !g_pending_slice_request) return;
        pending = std::move(g_pending_slice_request);
        g_pending_slice_request.reset();
    }
    auto* entry = state().plate_runtime_registry.find(pending->plate_id);
    if (entry == nullptr || entry->incarnation_id != pending->entry_incarnation) {
        enqueue_task_terminal(pending->task_id, "slice", "stale",
            json{{"error", "slice replacement target is stale or unavailable"}},
            pending->plate_id, pending->entry_incarnation);
        return;
    }
    const std::uint64_t revision = current_input_revision_for_plate(pending->plate_id);
    const char* response = slice_for_plate(pending->config_json.c_str(), pending->plate_id,
                                           revision, pending->task_id,
                                           pending->entry_incarnation);
    std::free(const_cast<char*>(response));
#endif
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_slice(const char* config_json) {
    ensure_plate_session_state();
    const auto revision = state().plate_input_revisions[state().current_plate_id];
    return slice_for_plate(config_json, state().current_plate_id, revision);
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_slice_plate(const char* config_json,
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

// Binary preview result. v2 publishes explicit continuous segments as
// structure-of-arrays buffers. The returned pointers are transferred exactly
// once to the Worker client; that client copies each array and frees the
// corresponding heap allocation immediately (the JSON itself is freed by the
// normal callJson path).
extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_get_slice_result(const char* plate_id,
                                                        double input_stamp_number,
                                                        double result_generation_number) {
    PlateRuntimeRegistry::Entry* runtime_entry = nullptr;
    try {
        ensure_plate_session_state();
        const auto valid_integer = [](double value) {
            return std::isfinite(value) && value >= 0.0 && std::floor(value) == value &&
                   value <= static_cast<double>(std::numeric_limits<std::uint64_t>::max());
        };
        if (plate_id == nullptr || !valid_integer(input_stamp_number) ||
            !valid_integer(result_generation_number) || result_generation_number == 0.0)
            return dup_json(json{{"ok", false}, {"status", "failed"},
                                 {"error", "invalid result receipt"}}.dump());
        const std::string target_plate_id = plate_id;
        const auto expected_stamp = static_cast<std::uint64_t>(input_stamp_number);
        const auto expected_generation = static_cast<std::uint64_t>(result_generation_number);
        std::string target_error;
        runtime_entry = runtime_entry_for_plate(target_plate_id, target_error);
        if (runtime_entry == nullptr)
            return dup_json(json{{"ok", false}, {"status", "unavailable"},
                                 {"error", target_error}}.dump());
        auto& print = *runtime_entry->print;
        const auto current_revision = current_input_revision_for_plate(target_plate_id);
        if (current_revision != expected_stamp ||
            runtime_entry->result_generation != expected_generation)
            return result_stale_error();
        if (!PlateRuntimeRegistry::is_publishable(*runtime_entry, current_revision)) {
            return result_unavailable_error();
        }
        if (print.objects().empty()) {
            invalidate_preview_source();
            json empty_toolpath{{"segment_count", 0},
                                {"starts_ptr", 0}, {"ends_ptr", 0},
                                {"layer_id_ptr", 0}, {"move_order_ptr", 0},
                                {"gcode_id_ptr", 0}, {"move_type_ptr", 0},
                                {"extrusion_role_ptr", 0}, {"extruder_id_ptr", 0},
                                {"color_print_id_ptr", 0}, {"width_ptr", 0}, {"height_ptr", 0},
                                {"metrics", json::object()}};
            return dup_json(json{{"ok", true}, {"preview_version", 2},
                                 {"status", "ok"},
                                 {"receipt", projection_receipt(*runtime_entry)},
                                 {"objects", 0}, {"layers", 0},
                                 {"metadata", json{{"result_id", 0}, {"layer_ranges", json::array()},
                                                    {"feature_palette", json::array()},
                                                    {"source_text", json{{"available", false}, {"byte_length", 0}}}}},
                                 {"toolpath", std::move(empty_toolpath)}}.dump());
        }

        // Slice completion already produced this plate generation's immutable
        // G-code and GCodeProcessorResult. Projection is a read-only conversion
        // and must never rerun Print::export_gcode().
        auto& gcode_result = *runtime_entry->gcode_result;
        auto tp = bridge::build_toolpath(gcode_result);
        const auto analysis = bridge::build_preview_analysis(gcode_result, tp);
        // Layer count = max layer id present in the toolpath + 1. The gcode
        // spans the whole plate, so this covers every object's height — the
        // previous objects().front() cap hid taller objects' extra layers.
        const size_t layers = tp.layerCount;

        // Feature palette (local id → role/name/color). build_toolpath assigns
        // ids 0..N-1 in order of first use; the client derives the local id
        // for each segment from this table and extrusion_roles.
        json feature_palette = json::array();
        for (const auto& [role, info] : tp.palette_used) {
            const auto id = static_cast<int>(feature_palette.size());
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

        // Match Orca's Plater::get_extruder_colors_from_plater_config() path:
        // a sliced project uses PresetBundle::project_config's filament_colour
        // palette, indexed by logical filament slot. GCodeProcessorResult owns
        // the equivalent palette for standalone G-code viewer input, but its
        // default entries are not authoritative for a sliced project.
        // Plate-local geometry remains in the active Print; palette ownership
        // deliberately follows Orca's project-level configuration path.
        // Read the live PresetBundle project config directly.  DynamicPrintConfig's
        // copy path is intentionally a normalized print-config carrier and can
        // omit project-only vector options such as filament_colour; Orca's
        // Plater path reads PresetBundle::project_config in place as well.
        const json filament_session = Filament::Session::filament_session_snapshot_json();
        const json* active_slots = filament_session.value("ok", false) &&
                filament_session.contains("slots") && filament_session["slots"].is_array()
            ? &filament_session["slots"] : nullptr;
        json extruder_palette = json::array();
        const size_t active_color_count = active_slots ? active_slots->size() : 0;
        const size_t palette_count = active_color_count > 0
            ? active_color_count : gcode_result.extruder_colors.size();
        for (size_t tool = 0; tool < palette_count; ++tool) {
            ColorRGB color;
            std::string source_color;
            if (active_slots && tool < active_color_count &&
                (*active_slots)[tool].is_object() &&
                (*active_slots)[tool]["colour"].is_object())
                source_color = (*active_slots)[tool]["colour"].value("effective", "");
            else if (tool < gcode_result.extruder_colors.size())
                source_color = gcode_result.extruder_colors[tool];
            if (source_color.empty() || !decode_color(source_color, color)) continue;
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
        const std::uintptr_t ts = ptr(tp.starts);
        const std::uintptr_t te = ptr(tp.ends);

        json out{{"ok", true}, {"status", "ok"}, {"preview_version", 2},
                 {"receipt", projection_receipt(*runtime_entry)},
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
            {"source_text", json{{"available", runtime_entry->gcode_text_available},
                                  {"byte_length", runtime_entry->gcode_size}}},
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
        };
        // Every pointer above is released after it has been recorded. JS now
        // owns the corresponding bytes and must _free() each exactly once.
        tp.starts.release(); tp.ends.release();
        tp.layers.release(); tp.move_orders.release(); tp.gcode_ids.release();
        tp.move_types.release(); tp.extrusion_roles.release(); tp.extruders.release();
        tp.color_prints.release(); tp.widths.release(); tp.heights.release();
        tp.feedrates.release(); tp.actual_feedrates.release();
        tp.volumetric_flows.release(); tp.actual_volumetric_flows.release();
        tp.fan_speeds.release(); tp.temperatures.release(); tp.pressure_advances.release();
        tp.accelerations.release(); tp.jerks.release(); tp.times.release();
        tp.layer_durations.release();
        return dup_json(out.dump());
    } catch (const std::exception& e) {
        // Projection construction is presentation-only work. A failed copy or
        // allocation may be retried from the retained native core result and
        // must not revoke Export eligibility or mutate registry ownership.
        return dup_json(json{{"ok", false}, {"status", "failed"}, {"error", e.what()}}.dump());
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
extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_read_gcode_chunk(const char* plate_id,
                                                      double input_stamp_number,
                                                      double result_generation_number,
                                                      double result_id_number,
                                                      double offset_number,
                                                      double length_number) {
    try {
        constexpr std::size_t max_chunk_bytes = 64 * 1024;
        constexpr std::size_t max_alignment_overrun_bytes = 3;
        constexpr std::size_t max_response_bytes = max_chunk_bytes + max_alignment_overrun_bytes * 2;
        const auto valid_integer = [](double value) {
            return std::isfinite(value) && value >= 0.0 &&
                   std::floor(value) == value &&
                   value <= static_cast<double>(std::numeric_limits<std::size_t>::max());
        };
        if (plate_id == nullptr || !valid_integer(input_stamp_number) ||
            !valid_integer(result_generation_number) || result_generation_number == 0.0 ||
            !valid_integer(result_id_number) || !valid_integer(offset_number) ||
            !valid_integer(length_number))
            return dup_json(json{{"ok", false}, {"error", "invalid chunk range"}}.dump());

        if (result_id_number > static_cast<double>(std::numeric_limits<std::uint32_t>::max()))
            return dup_json(json{{"ok", false}, {"error", "invalid result id"}}.dump());
        const auto result_id = static_cast<std::uint32_t>(result_id_number);
        const auto input_stamp = static_cast<std::uint64_t>(input_stamp_number);
        const auto result_generation = static_cast<std::uint64_t>(result_generation_number);
        const auto requested_offset = static_cast<std::size_t>(offset_number);
        const auto requested_length = static_cast<std::size_t>(length_number);
        auto* entry = state().plate_runtime_registry.find(plate_id);
        const auto current_revision = current_input_revision_for_plate(plate_id);
        if (entry == nullptr) return result_unavailable_error();
        if (current_revision != input_stamp || entry->result_generation != result_generation ||
            result_id == 0 || result_id != entry->gcode_result->id)
            return result_stale_error();
        if (!PlateRuntimeRegistry::is_publishable(*entry, current_revision) ||
            !entry->gcode_text_available)
            return result_unavailable_error();
        if (requested_length > max_chunk_bytes || requested_offset > entry->gcode_size)
            return dup_json(json{{"ok", false}, {"error", "chunk range is outside the preview text"}}.dump());

        // Align the returned bytes to UTF-8 code-point boundaries. A caller
        // may request arbitrary byte offsets (for example after estimating a
        // virtualized line viewport), so include up to three preceding bytes
        // and up to three continuation bytes after the requested range.
        std::size_t actual_offset = requested_offset;
        std::size_t actual_end = std::min(entry->gcode_size,
                                          requested_offset + requested_length);
        std::ifstream source(entry->gcode_path, std::ios::binary);
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
        if (requested_length > 0 && actual_end < entry->gcode_size) {
            unsigned char byte = 0;
            while (actual_end < entry->gcode_size &&
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
        return dup_json(json{{"ok", true}, {"status", "ok"}, {"result_id", entry->gcode_result->id},
                             {"offset", actual_offset}, {"length", byte_count},
                             {"eof", actual_end >= entry->gcode_size},
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
extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_read_gcode_lines(const char* plate_id,
                                                      double input_stamp_number,
                                                      double result_generation_number,
                                                      double result_id_number,
                                                      double start_line_number,
                                                      double line_count_number) {
    try {
        constexpr std::size_t max_line_count = 128;
        constexpr std::size_t max_page_bytes = 64 * 1024;
        const auto valid_integer = [](double value) {
            return std::isfinite(value) && value >= 0.0 &&
                   std::floor(value) == value &&
                   value <= static_cast<double>(std::numeric_limits<std::size_t>::max());
        };
        if (plate_id == nullptr || !valid_integer(input_stamp_number) ||
            !valid_integer(result_generation_number) || result_generation_number == 0.0 ||
            !valid_integer(result_id_number) || !valid_integer(start_line_number) ||
            !valid_integer(line_count_number) ||
            result_id_number > static_cast<double>(std::numeric_limits<std::uint32_t>::max()))
            return dup_json(json{{"ok", false}, {"error", "invalid source line page"}}.dump());
        const auto result_id = static_cast<std::uint32_t>(result_id_number);
        const auto input_stamp = static_cast<std::uint64_t>(input_stamp_number);
        const auto result_generation = static_cast<std::uint64_t>(result_generation_number);
        const auto start_line = static_cast<std::size_t>(start_line_number);
        const auto line_count = static_cast<std::size_t>(line_count_number);
        auto* entry = state().plate_runtime_registry.find(plate_id);
        const auto current_revision = current_input_revision_for_plate(plate_id);
        if (entry == nullptr) return result_unavailable_error();
        if (current_revision != input_stamp || entry->result_generation != result_generation ||
            result_id == 0 || result_id != entry->gcode_result->id)
            return result_stale_error();
        if (!PlateRuntimeRegistry::is_publishable(*entry, current_revision) ||
            !entry->gcode_text_available)
            return result_unavailable_error();
        if (line_count == 0 || line_count > max_line_count ||
            start_line == 0 || start_line > entry->gcode_line_ends.size())
            return dup_json(json{{"ok", false}, {"error", "source line page is outside the preview"}}.dump());
        const auto end_line = std::min(entry->gcode_line_ends.size(),
                                      start_line + line_count - 1);
        const auto start_byte = start_line == 1 ? 0 : entry->gcode_line_ends[start_line - 2];
        const auto end_byte = entry->gcode_line_ends[end_line - 1];
        if (start_byte > end_byte || end_byte > entry->gcode_size ||
            end_byte - start_byte > max_page_bytes)
            return dup_json(json{{"ok", false}, {"error", "source line page exceeds byte bound"}}.dump());
        std::ifstream source(entry->gcode_path, std::ios::binary);
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
        return dup_json(json{{"ok", true}, {"status", "ok"}, {"result_id", entry->gcode_result->id},
                             {"start_line", start_line}, {"line_count", end_line - start_line + 1},
                             {"eof", end_line == entry->gcode_line_ends.size()},
                             {"bytes_ptr", reinterpret_cast<std::uintptr_t>(bytes)},
                             {"bytes_length", byte_count}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

const char* export_gcode_for_target(const std::string& plate_id,
                                    const std::uint64_t revision,
                                    const std::uint64_t result_generation) {
    try {
        if (plate_id != state().current_plate_id)
            return result_unavailable_error();
        std::string target_error;
        auto* runtime_entry = runtime_entry_for_plate(plate_id, target_error);
        if (runtime_entry == nullptr)
            return result_unavailable_error();
        const auto current_revision = current_input_revision_for_plate(plate_id);
        if (current_revision != revision || runtime_entry->result_generation != result_generation)
            return result_stale_error();
        if (!PlateRuntimeRegistry::is_publishable(*runtime_entry, current_revision))
            return result_unavailable_error();
        if (!runtime_entry->completed_input_revision.has_value() ||
            *runtime_entry->completed_input_revision != revision ||
            runtime_entry->gcode_path.empty())
            return result_unavailable_error();
        return dup_json(json{{"ok", true}, {"status", "ok"},
                             {"path", runtime_entry->gcode_path},
                             {"receipt", projection_receipt(*runtime_entry)}}.dump());
    } catch (const std::exception& e) {
        return dup_json(json{{"ok", false}, {"status", "failed"}, {"error", e.what()}}.dump());
    } catch (...) {
        // Non-std throw (M4 probe caught one escaping a partial-install
        // init): never let a C++ exception cross the extern "C" seam.
        return dup_json(json{{"ok", false}, {"status", "failed"},
                             {"error", "unknown C++ exception"}}.dump());
    }
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_export_gcode_plate(const char* plate_id,
                                                         double revision_number,
                                                         double result_generation_number) {
    try {
        if (!plate_id || !std::isfinite(revision_number) || revision_number < 0.0 ||
            std::floor(revision_number) != revision_number ||
            revision_number > static_cast<double>(std::numeric_limits<std::uint64_t>::max()) ||
            !std::isfinite(result_generation_number) || result_generation_number <= 0.0 ||
            std::floor(result_generation_number) != result_generation_number ||
            result_generation_number > static_cast<double>(std::numeric_limits<std::uint64_t>::max()))
            return error_json("invalid plate operation target");
        return export_gcode_for_target(plate_id,
                                       static_cast<std::uint64_t>(revision_number),
                                       static_cast<std::uint64_t>(result_generation_number));
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_cancel() {
    try {
#ifndef ORCA_WASM_THREADING
        // The sole Worker is occupied by synchronous Print::process(); a
        // queued cancel cannot interrupt it and must not poison the next run.
        return error_json("slice_busy");
#else
        std::shared_ptr<SliceTask> task;
        {
            std::lock_guard<std::mutex> lock(g_slice_job_mutex);
            task = g_active_slice_task;
        }
        if (!task)
            return error_json("no active slice job");
        PlateRuntimeRegistry::mark_presentation_invalid(task->lease.entry());
        invalidate_preview_source();
        if (!state().plate_runtime_registry.request_job_cancellation(task->lease))
            return error_json("slice job is no longer active");
        return dup_json(json{{"ok", true}}.dump());
#endif
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
extern "C" EMSCRIPTEN_KEEPALIVE const char* orc_get_threading_info() {
#ifdef ORCA_WASM_THREADING
    return dup_json(json{{"ok", true}, {"threaded", true},
                         {"max_concurrency", state().tbb_max_concurrency},
                         {"arena_concurrency", state().tbb_arena.max_concurrency()},
                         {"serial_terminal_epoch", "0"}}.dump());
#else
    return dup_json(json{{"ok", true}, {"threaded", false},
                         {"max_concurrency", 1}, {"arena_concurrency", 1},
                         {"serial_terminal_epoch", std::to_string(g_serial_terminal_epoch)}}.dump());
#endif
}

#ifdef NEO_REAL_PROJECT_PROFILE
// Dedicated-profile builds use this narrow probe to place the active-slice
// interaction measurement after Print::apply() has returned to the stateful
// Worker and the detached process thread owns the job. Production builds do
// not contain this symbol or its mutex read.
extern "C" EMSCRIPTEN_KEEPALIVE int orc_real_project_profile_active_slice_count() {
    std::lock_guard<std::mutex> lock(g_slice_job_mutex);
    return g_active_slice_task ? 1 : 0;
}
#endif

} // namespace Slic3r::Neo::Bridge::SlicingPipeline
