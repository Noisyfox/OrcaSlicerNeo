// stubs/format-stubs.cpp — link stand-ins for file formats excluded from the
// WASM build (SVG requires additional OCCT components; GLB/GLTF/FBX require
// Assimp). Model::read_from_file dispatches by
// extension and calls these unconditionally, so the symbols must resolve.
// Returning false is the correct v1 behaviour: unsupported formats report a
// load failure. The retained STL/OBJ/AMF/3MF/DRC/STEP readers are unchanged.
#include <string>

#include "Format/svg.hpp"
#include "Format/AssimpImport.hpp"

namespace Slic3r {

bool load_svg(const char *, Model *, std::string &message)
{
    message = "SVG import is not supported in the WASM build.";
    return false;
}

bool load_assimp_textured_model(const std::string &, TexturedMesh &, std::string *message)
{
    if (message)
        *message = "GLB/GLTF/FBX import is not supported in the WASM build.";
    return false;
}

}  // namespace Slic3r
