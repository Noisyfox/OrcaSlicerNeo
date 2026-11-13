#pragma once

#include <cstdint>
#include <memory>
#include <optional>

#include "MeasureSession.hpp"

namespace Slic3r::Neo::Measurement {

// Worker-owned measurement state. All externally visible identities are
// monotonic integers; features and their mesh owners stay inside the Worker.
class Service {
public:
    struct OpenCandidate {
        std::uint64_t id;
        std::unique_ptr<Session> session;
    };
    struct Display {
        std::uint64_t id;
        std::uint64_t session_id;
        std::uint64_t target_revision;
        std::uint64_t selection_revision;
        DisplaySnapshot snapshot;
    private:
        friend class Service;
        std::unique_ptr<Display> next;
    };
    enum class Reset { First, Second, All, Escape };
    enum class Outcome { Selected, Mesh, Miss, Close, Unchanged };
    struct SelectionCandidate {
        std::uint64_t session_id;
        std::uint64_t base_revision;
        Outcome outcome;
        std::unique_ptr<SelectionState> selection;
        std::uint64_t revision() const { return base_revision + (selection ? 1 : 0); }
    };
    struct RebaseCandidate {
        std::uint64_t session_id;
        std::uint64_t target_revision;
        std::uint64_t selection_revision;
        std::unique_ptr<Session> session;
    };

    ~Service() { reset(); }
    std::unique_ptr<OpenCandidate> prepare_open(const Model& model, const std::vector<TargetId>& targets);
    void publish_open(std::unique_ptr<OpenCandidate> candidate) noexcept;
    std::unique_ptr<Display> prepare_display(const Model& model, std::uint64_t session_id, const PointerEvent& event);
    void publish_display(std::unique_ptr<Display> candidate) noexcept;
    const Display& display(std::uint64_t session_id, std::uint64_t display_id) const;
    void release_display(std::uint64_t session_id, std::uint64_t display_id) noexcept;
    SelectionCandidate prepare_click(const Model& model, std::uint64_t session_id, const PointerEvent& event,
        std::optional<std::uint64_t> display_id, std::optional<std::size_t> marker, bool shift) const;
    SelectionCandidate prepare_reset(const Model& model, std::uint64_t session_id, Reset action) const;
    void publish_selection(SelectionCandidate candidate) noexcept;
    std::unique_ptr<RebaseCandidate> prepare_rebase(const Model& model, std::uint64_t session_id) const;
    void publish_rebase(std::unique_ptr<RebaseCandidate> candidate) noexcept;

    const Session& require(std::uint64_t session_id) const;
    std::uint64_t id() const { return m_id; }
    std::uint64_t target_revision() const { return m_target_revision; }
    std::uint64_t selection_revision() const { return m_selection_revision; }
    bool protects_object(std::size_t object) const { return m_session && m_session->contains_object(object); }
    bool protects_instance(std::size_t object, std::size_t instance) const { return m_session && m_session->contains_instance(object, instance); }
    // A ModelVolume mesh is shared by all instances of its object.
    bool protects_volume(std::size_t volume) const { return m_session && m_session->contains_volume(volume); }
    void reset() noexcept;

private:
    static std::uint64_t take_id(std::uint64_t& next);
    void clear_displays() noexcept;
    std::unique_ptr<Session> m_session;
    std::unique_ptr<Display> m_displays;
    std::uint64_t m_id = 0;
    std::uint64_t m_target_revision = 0;
    std::uint64_t m_selection_revision = 0;
    std::uint64_t m_next_session = 1;
    std::uint64_t m_next_display = 1;
};

} // namespace Slic3r::Neo::Measurement
