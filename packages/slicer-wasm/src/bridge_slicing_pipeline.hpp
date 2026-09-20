// Slicing/progress/preview/G-code bridge pipeline interface.
#pragma once

#include <string_view>

namespace Slic3r::Neo::Bridge::SlicingPipeline {

void invalidate_preview_source();
// History restore clears the slice result but may preserve a valid derived
// Prime Tower projection (for example an adjacent translation-only Move).
void invalidate_preview_result_only();

extern "C" {
void begin_progress(std::string_view text = "Preparing slice");
void publish_slicer_progress(int percent, std::string_view text);
void finish_progress(std::string_view text = "Slice complete");
void stop_progress();
}

} // namespace Slic3r::Neo::Bridge::SlicingPipeline
