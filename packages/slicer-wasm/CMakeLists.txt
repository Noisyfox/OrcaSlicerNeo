# ----------------------------------------------------------------
# ------------ Stripped libslic3r + bridge + CLI -> WASM ---------
# ----------------------------------------------------------------
# Standalone target compiling ONLY the FDM slice path of libslic3r plus the
# bridge (src/bridge.cpp) and CLI driver (src/slice_main.cpp), sidestepping
# the upstream two-stage native dep build. Configure via emcmake (build.sh).
#
# This is a scaffold: DROP_PATTERNS and the compile defines are the iteration
# surface (AGENTS.md "WASM Build Workflow").
cmake_minimum_required(VERSION 3.20)
project(orca_slicer_wasm CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Configure with emcmake (Emscripten toolchain required).")
endif()

# ---- Required paths (passed by build.sh) ----
foreach(var ORCA_SRC SHIM_INCLUDE GEN_INCLUDE)
  if(NOT DEFINED ${var} OR "${${var}}" STREQUAL "")
    message(FATAL_ERROR "${var} must be set (-D${var}=...).")
  endif()
endforeach()

set(LIBSLIC3R_ROOT "${ORCA_SRC}/src/libslic3r")

# ---- Source set: all libslic3r .cpp minus the dropped v1 features ----
file(GLOB_RECURSE LIBSLIC3R_SRC CONFIGURE_DEPENDS "${LIBSLIC3R_ROOT}/*.cpp")

# Denylist: dropped for the FDM v1 (pull in OpenVDB/CGAL/OCCT/networking).
# NOTE: "/Format/3mf" is intentionally NOT here — 3MF is re-added for v1
# (Format/3mf.cpp + Format/bbs_3mf.cpp; expat/miniz/fast_float are in-tree).
set(DROP_PATTERNS
  "/SLA/"                 # resin pipeline
  "OpenVDBUtils"          # OpenVDB grid conversion (hollowing)
  "Hollowing"             # OpenVDB
  "CutSurface"            # CGAL
  "MeshBoolean"           # CGAL boolean ops
  "/Format/STEP"          # OpenCASCADE
  "PrintConfig_test"
  "TriangleMeshSlicer_test"
)
foreach(pattern ${DROP_PATTERNS})
  list(FILTER LIBSLIC3R_SRC EXCLUDE REGEX "${pattern}")
endforeach()

# Hand-written stubs for symbols referenced from kept code but defined in
# dropped files (e.g. md5.cpp for the openssl/md5.h declarations).
file(GLOB STUB_SRC CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/stubs/*.cpp")

add_library(slic3r_core STATIC ${LIBSLIC3R_SRC} ${STUB_SRC})

target_include_directories(slic3r_core PUBLIC
  "${SHIM_INCLUDE}"          # serial TBB shim FIRST, ahead of any real tbb
  "${GEN_INCLUDE}"           # generated headers: libslic3r_version.h, openssl/md5.h
  "${ORCA_SRC}/src"
  "${LIBSLIC3R_ROOT}"
)
# Emscripten-built / header-only dependency includes (set by build.sh).
foreach(dep EIGEN_INCLUDE BOOST_INCLUDE CEREAL_INCLUDE)
  if(DEFINED ${dep} AND NOT "${${dep}}" STREQUAL "")
    target_include_directories(slic3r_core PUBLIC "${${dep}}")
  endif()
endforeach()
# In-tree vendored deps (deps_src/ inside the submodule) — the spike's proven
# include set from its per-file compile recipe.
target_include_directories(slic3r_core PUBLIC
  "${ORCA_SRC}/deps_src"
  "${ORCA_SRC}/deps_src/libigl"
  "${ORCA_SRC}/deps_src/miniz"
  "${ORCA_SRC}/deps_src/clipper2/Clipper2Lib/include"
  "${ORCA_SRC}/deps_src/expat"
  "${ORCA_SRC}/deps_src/glu-libtess/include"
  "${ORCA_SRC}/deps_src/libnest2d/include"
  "${ORCA_SRC}/deps_src/qhull/src"
)

# Compile defines libslic3r expects (spike-proven set + WASM guards). The
# version macros come from GEN_INCLUDE/libslic3r_version.h (build.sh writes it).
target_compile_definitions(slic3r_core PUBLIC
  USE_TBB
  TBB_USE_CAPTURED_EXCEPTION=0
  SLIC3R_WASM_NO_OCCT
  BOOST_NO_CXX98_FUNCTION_BASE
)
# Single-threaded: no pthreads in v1 (serial TBB shim).
target_compile_options(slic3r_core PRIVATE -O3 -fexceptions -Wno-unused)

# ---- Module: bridge + CLI driver -> single WASM module ----
add_executable(orca_slice
  "${CMAKE_CURRENT_SOURCE_DIR}/src/bridge.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/slice_main.cpp"
)
target_link_libraries(orca_slice PRIVATE slic3r_core)
set_target_properties(orca_slice PROPERTIES OUTPUT_NAME "orca_slice" SUFFIX ".js")
target_link_options(orca_slice PRIVATE
  -O3 -fexceptions
  -sMEMORY64
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sENVIRONMENT=web,worker,node
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=64MB
  -sEXIT_RUNTIME=0
  -sINVOKE_RUN=0
  -sFORCE_FILESYSTEM=1
  -sEXPORTED_RUNTIME_METHODS=callMain,FS,ccall,cwrap,UTF8ToString,_malloc,_free
  -sDISABLE_EXCEPTION_CATCHING=0
  -sALLOW_TABLE_GROWTH=1
)
if(DEFINED EMBED_FILE AND NOT "${EMBED_FILE}" STREQUAL "")
  target_link_options(orca_slice PRIVATE "--embed-file=${EMBED_FILE}")
endif()
