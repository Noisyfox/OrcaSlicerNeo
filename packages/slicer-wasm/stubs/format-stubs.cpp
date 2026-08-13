// stubs/format-stubs.cpp — link stand-ins for file formats excluded from the
// WASM build (DRC = Google Draco, needs the draco library; SVG = SVG→mesh,
// needs OpenCASCADE). Model::load_from_file (Model.cpp) dispatches by
// extension and calls these unconditionally, so the symbols must resolve.
// Returning false is the correct v1 behaviour: unsupported formats report a
// load failure (v1 supports STL/3MF).
#include <string>

#include "Format/DRC.hpp"
#include "Format/svg.hpp"

namespace Slic3r {

bool load_drc(const char *, TriangleMesh *) { return false; }
bool load_drc(const char *, Model *, const char *) { return false; }

bool store_drc(const char *, TriangleMesh *, int, int) { return false; }
bool store_drc(const char *, ModelObject *, int, int) { return false; }
bool store_drc(const char *, Model *, int, int) { return false; }

bool load_svg(const char *, Model *, std::string &message)
{
    message = "SVG import is not supported in the WASM build.";
    return false;
}

}  // namespace Slic3r
