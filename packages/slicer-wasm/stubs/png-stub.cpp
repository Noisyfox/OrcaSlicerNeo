// stubs/png-stub.cpp — no-op stand-ins for the libslic3r png API so the
// declarations in PNGReadWrite.hpp resolve at link time without libpng.
// PNGReadWrite.cpp (real implementation, needs libpng/zlib) is excluded from
// the WASM build via DROP_PATTERNS; every in-tree caller is a debug-visualization
// or SLA-format path that is dead in the FDM v1 slice flow, so returning
// false/no-op is correct for the module.
#include "PNGReadWrite.hpp"

namespace Slic3r { namespace png {

bool decode_png(IStream &, ImageGreyscale &) { return false; }

bool decode_colored_png(IStream &, ImageColorscale &) { return false; }

bool decode_colored_png(const ReadBuf &, ImageColorscale &) { return false; }

bool is_png(const ReadBuf &) { return false; }

bool write_rgb_to_file(const char *, size_t, size_t, const uint8_t *) { return false; }
bool write_rgb_to_file(const std::string &, size_t, size_t, const uint8_t *) { return false; }
bool write_rgb_to_file(const std::string &, size_t, size_t, const std::vector<uint8_t> &) { return false; }

bool write_gray_to_file(const char *, size_t, size_t, const uint8_t *) { return false; }
bool write_gray_to_file(const std::string &, size_t, size_t, const uint8_t *) { return false; }
bool write_gray_to_file(const std::string &, size_t, size_t, const std::vector<uint8_t> &) { return false; }

bool write_rgb_to_file_scaled(const char *, size_t, size_t, const uint8_t *, size_t) { return false; }
bool write_rgb_to_file_scaled(const std::string &, size_t, size_t, const uint8_t *, size_t) { return false; }
bool write_rgb_to_file_scaled(const std::string &, size_t, size_t, const std::vector<uint8_t> &, size_t) { return false; }

bool write_gray_to_file_scaled(const char *, size_t, size_t, const uint8_t *, size_t) { return false; }
bool write_gray_to_file_scaled(const std::string &, size_t, size_t, const uint8_t *, size_t) { return false; }
bool write_gray_to_file_scaled(const std::string &, size_t, size_t, const std::vector<uint8_t> &, size_t) { return false; }

}}  // namespace Slic3r::png
