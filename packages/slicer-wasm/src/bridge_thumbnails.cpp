#include "bridge_thumbnails.hpp"
#include <emscripten/heap.h>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <limits>
#include <stdexcept>

namespace Slic3r::Neo::Bridge::Thumbnails {
ThumbnailData read_rgba(const nlohmann::json& image)
{
    for (const auto* field : {"width", "height", "pixels_length", "pixels_ptr"})
        if (!image.at(field).is_number_unsigned())
            throw std::runtime_error("Invalid RGBA thumbnail");
    const auto width = image.at("width").get<std::uint64_t>();
    const auto height = image.at("height").get<std::uint64_t>();
    // miniz stores 16-bit dimensions and allocates scanlines with signed int arithmetic.
    if (!width || !height || width > 0xffff || height > 0xffff)
        throw std::runtime_error("Invalid RGBA thumbnail");
    const auto pointer = image.at("pixels_ptr").get<std::uint64_t>();
    const std::uint64_t length = width * height * 4;
    if (length + height > std::numeric_limits<int>::max() - 57 ||
        image.at("pixels_length").get<std::uint64_t>() != length || !pointer ||
        pointer > emscripten_get_heap_size() || length > emscripten_get_heap_size() - pointer)
        throw std::runtime_error("Invalid RGBA thumbnail");
    ThumbnailData thumbnail;
    thumbnail.width = static_cast<unsigned int>(width);
    thumbnail.height = static_cast<unsigned int>(height);
    const auto* bytes = reinterpret_cast<const unsigned char*>(static_cast<uintptr_t>(pointer));
    thumbnail.pixels.assign(bytes, bytes + length);
    return thumbnail;
}

ThumbnailsGeneratorCallback generator(const ThumbnailData& source)
{
    if (!source.is_valid()) return nullptr;
    return [&source](const ThumbnailsParams& params) {
        ThumbnailsList result;
        for (const auto& size : params.sizes) {
            const auto width = static_cast<unsigned int>(size.x());
            const auto height = static_cast<unsigned int>(size.y());
            if (!width || !height) continue;
            auto& image = result.emplace_back();
            image.set(width, height);
            std::fill(image.pixels.begin(), image.pixels.end(), 0);
            const double scale = std::min(double(width) / source.width, double(height) / source.height);
            const auto scaled_width = std::max(1u, static_cast<unsigned int>(source.width * scale));
            const auto scaled_height = std::max(1u, static_cast<unsigned int>(source.height * scale));
            const auto left = (width - scaled_width) / 2;
            const auto bottom = (height - scaled_height) / 2;
            // Bilinear resampling preserves bottom-up RGBA rows and fits rectangular targets.
            for (unsigned int y = 0; y < scaled_height; ++y) {
                const double source_y = std::clamp((y + 0.5) * source.height / scaled_height - 0.5,
                    0.0, double(source.height - 1));
                const auto y0 = static_cast<unsigned int>(source_y);
                const auto y1 = std::min(y0 + 1, source.height - 1);
                const double vertical = source_y - y0;
                for (unsigned int x = 0; x < scaled_width; ++x) {
                    const double source_x = std::clamp((x + 0.5) * source.width / scaled_width - 0.5,
                        0.0, double(source.width - 1));
                    const auto x0 = static_cast<unsigned int>(source_x);
                    const auto x1 = std::min(x0 + 1, source.width - 1);
                    const double horizontal = source_x - x0;
                    for (unsigned int channel = 0; channel < 4; ++channel) {
                        const double lower = source.pixels[(y0 * source.width + x0) * 4 + channel] * (1 - horizontal)
                            + source.pixels[(y0 * source.width + x1) * 4 + channel] * horizontal;
                        const double upper = source.pixels[(y1 * source.width + x0) * 4 + channel] * (1 - horizontal)
                            + source.pixels[(y1 * source.width + x1) * 4 + channel] * horizontal;
                        image.pixels[((bottom + y) * width + left + x) * 4 + channel] =
                            static_cast<unsigned char>(std::lround(lower * (1 - vertical) + upper * vertical));
                    }
                }
            }
        }
        return result;
    };
}
}
