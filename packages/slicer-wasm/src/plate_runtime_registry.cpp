// ----------------------------------------------------------------
// Runtime ownership for the FFF per-plate Print domain.
// ----------------------------------------------------------------
#include "plate_runtime_registry.hpp"

#include <cstdio>
#include <stdexcept>
#include <unordered_set>

namespace Slic3r::Neo::Bridge {

PlateRuntimeRegistry::Entry::~Entry()
{
    if (!gcode_path.empty()) std::remove(gcode_path.c_str());
}

PlateRuntimeRegistry::JobLease::JobLease(PlateRuntimeRegistry& owner,
                                         std::shared_ptr<Entry> entry,
                                         const std::uint64_t slice_task_id,
                                         const std::uint64_t input_revision) noexcept
    : owner_(&owner), entry_(std::move(entry)), slice_task_id_(slice_task_id),
      input_revision_(input_revision)
{
}

PlateRuntimeRegistry::JobLease::JobLease(JobLease&& other) noexcept
    : owner_(other.owner_), entry_(std::move(other.entry_)),
      slice_task_id_(other.slice_task_id_), input_revision_(other.input_revision_),
      process_completed_(other.process_completed_)
{
    other.owner_ = nullptr;
}

PlateRuntimeRegistry::JobLease& PlateRuntimeRegistry::JobLease::operator=(JobLease&& other) noexcept
{
    if (this == &other) return *this;
    release();
    owner_ = other.owner_;
    entry_ = std::move(other.entry_);
    slice_task_id_ = other.slice_task_id_;
    input_revision_ = other.input_revision_;
    process_completed_ = other.process_completed_;
    other.owner_ = nullptr;
    return *this;
}

PlateRuntimeRegistry::JobLease::~JobLease()
{
    release();
}

void PlateRuntimeRegistry::JobLease::release() noexcept
{
    if (owner_ != nullptr) owner_->release_job(*this);
    owner_ = nullptr;
    entry_.reset();
}

PlateRuntimeRegistry::Retirements PlateRuntimeRegistry::reconcile(
    const std::vector<std::string>& plate_ids)
{
    std::unordered_set<std::string> desired;
    desired.reserve(plate_ids.size());
    Retirements retirements;
    std::vector<std::shared_ptr<Entry>> released;
    std::lock_guard<std::mutex> lock(mutex_);

    for (const std::string& plate_id : plate_ids) {
        if (plate_id.empty())
            throw std::invalid_argument("plate runtime registry requires a non-empty id");
        if (!desired.insert(plate_id).second)
            throw std::invalid_argument("plate runtime registry requires unique ids");

        if (entries_.find(plate_id) == entries_.end()) {
            auto entry = std::make_shared<Entry>();
            entry->plate_id = plate_id;
            entry->incarnation_id = next_incarnation_id_++;
            entry->print = std::make_unique<Print>();
            entry->gcode_result = std::make_unique<GCodeProcessorResult>();
            entries_.emplace(plate_id, std::move(entry));
        }
    }

    for (auto it = entries_.begin(); it != entries_.end();) {
        if (desired.find(it->first) == desired.end()) {
            auto entry = std::move(it->second);
            it = entries_.erase(it);
            entry->presentation = PresentationLifecycle::Invalid;
            if (entry->active_job_leases != 0) {
                entry->retired = true;
                retired_entries_.emplace(entry->incarnation_id, entry);
                retirements.push_back({entry->plate_id, entry->incarnation_id});
            } else {
                released.push_back(std::move(entry));
            }
        } else {
            ++it;
        }
    }
    return retirements;
}

PlateRuntimeRegistry::Retirements PlateRuntimeRegistry::reconcile_history(
    const std::vector<std::string>& plate_ids,
    const std::set<std::string>& affected_plate_ids)
{
    auto retirements = reconcile(plate_ids);
    invalidate_presentations(affected_plate_ids);
    return retirements;
}

void PlateRuntimeRegistry::clear() noexcept
{
    std::vector<std::shared_ptr<Entry>> released;
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& [plate_id, entry] : entries_) {
        entry->presentation = PresentationLifecycle::Invalid;
        if (entry->active_job_leases != 0) {
            entry->retired = true;
            retired_entries_.emplace(entry->incarnation_id, entry);
        } else {
            released.push_back(std::move(entry));
        }
    }
    entries_.clear();
}

PlateRuntimeRegistry::JobLease PlateRuntimeRegistry::begin_slice(
    const std::string_view plate_id, const std::uint64_t slice_task_id,
    const std::uint64_t input_revision)
{
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = entries_.find(std::string(plate_id));
    if (it == entries_.end())
        throw std::invalid_argument("plate operation target was not found");
    auto& entry = *it->second;
    if (entry.active_job_leases != 0)
        throw std::runtime_error("slice_busy");
    entry.presentation = PresentationLifecycle::Slicing;
    entry.active_job_leases = 1;
    entry.active_slice_task_id = slice_task_id;
    entry.active_input_revision = input_revision;
    entry.cancel_requested = false;
    return JobLease(*this, it->second, slice_task_id, input_revision);
}

bool PlateRuntimeRegistry::mark_process_completed(JobLease& lease,
                                                  const std::uint64_t completed_revision,
                                                  const std::uint64_t current_revision) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (lease.owner_ != this || lease.entry_ == nullptr) return false;
    auto& entry = *lease.entry_;
    lease.process_completed_ = true;
    const auto live = entries_.find(entry.plate_id);
    if (entry.retired || live == entries_.end() || live->second != lease.entry_ ||
        entry.active_slice_task_id != lease.slice_task_id_ ||
        entry.active_input_revision != lease.input_revision_) {
        entry.presentation = PresentationLifecycle::Invalid;
        return false;
    }
    entry.native_core_materialized = true;
    entry.completed_input_revision = completed_revision;
    entry.completed_slice_task_id = lease.slice_task_id_;
    // Result/export materialization may promote this intermediate state to
    // valid without losing the retained native core objects.
    entry.presentation = completed_revision == current_revision
        ? PresentationLifecycle::Slicing
        : PresentationLifecycle::Invalid;
    return true;
}

void PlateRuntimeRegistry::mark_process_failed(JobLease& lease) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (lease.owner_ == this && lease.entry_ != nullptr)
        lease.entry_->presentation = PresentationLifecycle::Invalid;
}

bool PlateRuntimeRegistry::can_publish_completed_job(
    const JobLease& lease, const std::uint64_t current_revision) const noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (lease.owner_ != this || lease.entry_ == nullptr) return false;
    const auto& entry = *lease.entry_;
    const auto live = entries_.find(entry.plate_id);
    return !entry.retired && live != entries_.end() && live->second == lease.entry_ &&
           entry.active_slice_task_id == lease.slice_task_id_ &&
           entry.active_input_revision == lease.input_revision_ &&
           can_materialize_result(entry, current_revision);
}

bool PlateRuntimeRegistry::has_active_job(const std::string_view plate_id) const noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = entries_.find(std::string(plate_id));
    return it != entries_.end() && it->second->active_job_leases != 0;
}

bool PlateRuntimeRegistry::request_job_cancellation(const JobLease& lease) noexcept
{
    std::shared_ptr<Entry> entry;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (lease.owner_ != this || lease.entry_ == nullptr ||
            lease.entry_->active_job_leases == 0)
            return false;
        entry = lease.entry_;
        entry->cancel_requested = true;
    }
    // PrintBase::cancel() is an atomic request.  The caller must remain free
    // to commit the mutation which made this task obsolete.
    entry->print->cancel();
    return true;
}

bool PlateRuntimeRegistry::request_retired_job_cancellation(
    const std::uint64_t incarnation_id) noexcept
{
    std::shared_ptr<Entry> entry;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto it = retired_entries_.find(incarnation_id);
        if (it == retired_entries_.end() || it->second->active_job_leases == 0)
            return false;
        entry = it->second;
        entry->cancel_requested = true;
    }
    // PrintBase cancellation is an atomic request. Never wait for process(),
    // the job thread, or the tombstone lease while handling Delete Plate.
    entry->print->cancel();
    return true;
}

bool PlateRuntimeRegistry::cancellation_requested(const JobLease& lease) const noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    return lease.owner_ == this && lease.entry_ != nullptr && lease.entry_->cancel_requested;
}

void PlateRuntimeRegistry::mark_presentation_valid(Entry& entry,
                                                   const std::uint64_t current_revision) noexcept
{
    entry.presentation = entry.native_core_materialized &&
            entry.completed_input_revision.has_value() &&
            *entry.completed_input_revision == current_revision
        ? PresentationLifecycle::Valid
        : PresentationLifecycle::Invalid;
}

void PlateRuntimeRegistry::mark_presentation_invalid(Entry& entry) noexcept
{
    entry.presentation = PresentationLifecycle::Invalid;
}

void PlateRuntimeRegistry::invalidate_presentations(const std::set<std::string>& plate_ids) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& plate_id : plate_ids) {
        const auto it = entries_.find(plate_id);
        if (it == entries_.end()) continue;
        auto& entry = *it->second;
        entry.presentation = PresentationLifecycle::Invalid;
        if (entry.active_job_leases != 0 && !entry.cancel_requested) {
            entry.cancel_requested = true;
            // PrintBase::cancel() only writes the atomic cancellation state;
            // it never waits for the job or tears down the retained Print.
            entry.print->cancel();
        }
    }
}

PlateRuntimeRegistry::LifecycleSnapshots PlateRuntimeRegistry::capture_lifecycle() const
{
    std::lock_guard<std::mutex> lock(mutex_);
    LifecycleSnapshots snapshots;
    for (const auto& [plate_id, entry] : entries_)
        snapshots.emplace(plate_id, LifecycleSnapshot{
            entry->incarnation_id, entry->presentation,
            entry->completed_input_revision, entry->completed_slice_task_id,
            entry->result_generation, entry->active_slice_task_id});
    return snapshots;
}

void PlateRuntimeRegistry::restore_lifecycle(const LifecycleSnapshots& snapshots) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& [plate_id, snapshot] : snapshots) {
        const auto live = entries_.find(plate_id);
        auto* entry = live == entries_.end() ? nullptr : live->second.get();
        // A replacement entry, result, or job cannot inherit availability
        // from an earlier snapshot, even when the input revision is unchanged.
        if (entry == nullptr || entry->incarnation_id != snapshot.incarnation_id ||
            entry->result_generation != snapshot.result_generation ||
            entry->completed_input_revision != snapshot.completed_input_revision ||
            entry->completed_slice_task_id != snapshot.completed_slice_task_id ||
            entry->active_slice_task_id != snapshot.active_slice_task_id)
            continue;
        entry->presentation = snapshot.presentation;
    }
}

bool PlateRuntimeRegistry::can_materialize_result(const Entry& entry,
                                                  const std::uint64_t current_revision) noexcept
{
    return (entry.presentation == PresentationLifecycle::Slicing ||
            entry.presentation == PresentationLifecycle::Valid) &&
           entry.native_core_materialized &&
           entry.completed_input_revision.has_value() &&
           *entry.completed_input_revision == current_revision;
}

bool PlateRuntimeRegistry::is_publishable(const Entry& entry,
                                          const std::uint64_t current_revision) noexcept
{
    return entry.presentation == PresentationLifecycle::Valid &&
           entry.native_core_materialized &&
           entry.completed_input_revision.has_value() &&
           *entry.completed_input_revision == current_revision;
}

PlateRuntimeRegistry::Entry* PlateRuntimeRegistry::find(const std::string_view plate_id) noexcept
{
    const auto it = entries_.find(std::string(plate_id));
    return it == entries_.end() ? nullptr : it->second.get();
}

const PlateRuntimeRegistry::Entry* PlateRuntimeRegistry::find(const std::string_view plate_id) const noexcept
{
    const auto it = entries_.find(std::string(plate_id));
    return it == entries_.end() ? nullptr : it->second.get();
}

std::size_t PlateRuntimeRegistry::retired_size() const noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    return retired_entries_.size();
}

std::size_t PlateRuntimeRegistry::size() const noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    return entries_.size();
}

bool PlateRuntimeRegistry::empty() const noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    return entries_.empty();
}

#ifdef NEO_REAL_PROJECT_PROFILE
std::vector<PlateRuntimeRegistry::ProfileEntry> PlateRuntimeRegistry::profile_entries() const
{
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<ProfileEntry> result;
    result.reserve(entries_.size());
    for (const auto& [plate_id, entry] : entries_)
        result.push_back({plate_id, entry->print.get(), entry->gcode_result.get(),
                          entry->native_core_materialized});
    return result;
}
#endif

void PlateRuntimeRegistry::release_job(JobLease& lease) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (lease.owner_ != this || lease.entry_ == nullptr) return;
    auto& entry = *lease.entry_;
    if (!lease.process_completed_)
        entry.presentation = PresentationLifecycle::Invalid;
    if (entry.active_job_leases != 0) --entry.active_job_leases;
    if (entry.active_job_leases == 0) {
        entry.active_slice_task_id.reset();
        entry.active_input_revision.reset();
        if (entry.retired)
            retired_entries_.erase(entry.incarnation_id);
    }
}

} // namespace Slic3r::Neo::Bridge
