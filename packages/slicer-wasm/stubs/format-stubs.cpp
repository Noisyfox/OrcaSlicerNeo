// stubs/format-stubs.cpp — link stand-ins for file formats excluded from the
// WASM build (SVG = SVG→mesh, needs OpenCASCADE). Model::load_from_file dispatches by
// extension and calls these unconditionally, so the symbols must resolve.
// Returning false is the correct v1 behaviour: unsupported formats report a
// load failure (v1 supports STL/3MF).
#include <string>

#include "Format/svg.hpp"

namespace Slic3r {

bool load_svg(const char *, Model *, std::string &message)
{
    message = "SVG import is not supported in the WASM build.";
    return false;
}

}  // namespace Slic3r
