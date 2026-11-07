#pragma once

#include "libslic3r/GCode/ThumbnailData.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::Thumbnails {
ThumbnailData read_rgba(const nlohmann::json& image);
// The source outlives the synchronous G-code export using this callback.
ThumbnailsGeneratorCallback generator(const ThumbnailData& source);
}
