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

# wasm64 throughout: Emscripten 6 emits wasm32 objects unless -m64 is
# also given at COMPILE time (the link flag alone is not enough), and wasm-ld
# refuses to mix the two. Must match the Boost archives (build-boost-wasm64.sh
# / .bat) and the final module's -m64 link flag. (-m64 is the standard spelling;
# -sMEMORY64 is deprecated and warns on every em++ invocation.)
add_compile_options(-m64)

option(WASM_THREADING "Use upstream oneTBB and Emscripten pthreads" ON)
option(NEO_PROJECT_HISTORY_TEST "Build the standalone headless ProjectHistory test" OFF)
# Debug build (build.sh/build.bat --debug or WASM_DEBUG=1): only the
# libslic3r part (slic3r_core + bridge/CLI TUs) is rebuilt with -g -O0 so the
# final module embeds DWARF for interactive source-level debugging in Chrome
# DevTools. Dependencies (Boost, oneTBB, vendored deps_core) stay -O3 release
# WITHOUT debug info — they are not recompiled. -g at link time is what keeps
# the DWARF sections inside orca_slice.wasm (no external source maps).
option(WASM_DEBUG "Build libslic3r + bridge with embedded DWARF (-g -O0); deps stay release" OFF)
# This JavaScript expression is emitted directly into the module loader.
# oneTBB and Emscripten use every logical core the runtime exposes.
set(WASM_PTHREAD_POOL_SIZE "navigator.hardwareConcurrency" CACHE STRING "Pre-created Emscripten pthread workers")
if(WASM_THREADING)
  # The compatibility shim uses this to select its std::thread-backed
  # implementation. Keep it global so every target that includes the shim sees
  # the same thread semantics as the final module.
  add_compile_definitions(ORCA_WASM_THREADING=1)
  if(NOT DEFINED TBB_ROOT OR "${TBB_ROOT}" STREQUAL "")
    message(FATAL_ERROR "TBB_ROOT must name the staged oneTBB build when WASM_THREADING=ON.")
  endif()
  set(TBB_INCLUDE_DIR "${TBB_ROOT}/include")
  set(TBB_ARCHIVE "${TBB_ROOT}/lib/libtbb.a")
  set(TBBMALLOC_ARCHIVE "${TBB_ROOT}/lib/libtbbmalloc.a")
  foreach(required_path "${TBB_INCLUDE_DIR}/tbb/tbb.h" "${TBB_ARCHIVE}" "${TBBMALLOC_ARCHIVE}")
    if(NOT EXISTS "${required_path}")
      message(FATAL_ERROR "Threaded WASM build requires oneTBB artifact: ${required_path}")
    endif()
  endforeach()
  # Emscripten requires -pthread on every compilation as well as the final
  # link; putting it here covers libslic3r, vendored deps, and bridge TUs.
  add_compile_options(-pthread)
  message(STATUS "WASM threading: oneTBB (${TBB_ROOT}), pthread pool=${WASM_PTHREAD_POOL_SIZE}")
else()
  message(STATUS "WASM threading: serial TBB shim (explicit fallback)")
endif()
# The upstream BBS backup manager starts a native boost::thread and is not
# part of the synchronous WASM bridge contract. Its complete implementation
# is excluded by patch 0008 for both WASM variants; the ABI-compatible no-op
# entry points live in stubs/backup-manager-stub.cpp.
add_compile_definitions(ORCA_WASM_DISABLE_BBS_BACKUP_MANAGER=1)
if(WASM_DEBUG)
  message(STATUS "WASM debug: libslic3r + bridge at -g -O0 (embedded DWARF); deps stay -O3 without debug info")
endif()

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
  # SLA/ is dropped wholesale EXCEPT IndexedMesh.cpp: ContourZ.cpp (kept, Z
  # contouring) calls sla::IndexedMesh. The resin pipeline (supports, hollowing,
  # rasterizers) is the rest of the dir.
  "/SLA/Clustering"
  "/SLA/ConcaveHull"
  "/SLA/Pad"
  "/SLA/RasterBase"
  "/SLA/RasterToPolygons"
  "/SLA/Rotfinder"
  "/SLA/SpatIndex"
  "/SLA/SupportPointGenerator"
  "/SLA/SupportTree"      # SupportTree{,Builder,Buildsteps,Mesher}.cpp
  "OpenVDBUtils"          # OpenVDB grid conversion (hollowing)
  "Hollowing"             # OpenVDB
  "CutSurface"            # CGAL
  "MeshBoolean"           # CGAL boolean ops
  "/Format/STEP"          # OpenCASCADE
  "/Format/svg"           # SVG->mesh needs OpenCASCADE; load_svg stubbed in stubs/format-stubs.cpp
  "/Shape/TextShape"      # OCCT font->mesh; no kept callers
  "/Arrange.cpp"          # libnest2d bed arrangement (nlopt + boost::geometry deps)
  "GCodeSender"           # serial/network host control; boost::asio signal_blocker
                          # supports only Windows/POSIX, and nothing kept calls it
  "VoronoiUtilsCgal"      # CGAL Voronoi planarity diagnostics; planarity checks
                          # stubbed in stubs/voronoi-cgal-stubs.cpp
  "ObjColorUtils"         # OpenCV-based 3MF color utilities; zero kept callers
  "TryCatchSignalSEH"     # _WIN32-only SEH (windows.h); POSIX TryCatchSignal.cpp is kept
  "Triangulation"         # CGAL constrained-Delaunay; symbols stubbed in stubs/triangulation-stub.cpp
  "PNGReadWrite"          # libpng image export; symbols stubbed in stubs/png-stub.cpp
  "PrintConfig_test"
  "TriangleMeshSlicer_test"
  "pchheader"             # precompiled-header TU; no-PCH build has zero users
)
foreach(pattern ${DROP_PATTERNS})
  list(FILTER LIBSLIC3R_SRC EXCLUDE REGEX "${pattern}")
endforeach()

# Hand-written stubs for symbols referenced from kept code but defined in
# dropped files (e.g. md5.cpp for the openssl/md5.h declarations).
file(GLOB STUB_SRC CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/stubs/*.cpp")

add_library(slic3r_core STATIC ${LIBSLIC3R_SRC} ${STUB_SRC})

if(WASM_THREADING)
  # Real oneTBB must precede the generic compatibility shim. The shim still
  # supplies the Boost.Thread compatibility surface, plus libnoise/libjpeg
  # stand-ins for dropped features.
  target_include_directories(slic3r_core PUBLIC "${TBB_INCLUDE_DIR}")
endif()
target_include_directories(slic3r_core PUBLIC
  "${SHIM_INCLUDE}"
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
if(NOT DEFINED DRACO_INCLUDE OR "${DRACO_INCLUDE}" STREQUAL "" OR NOT EXISTS "${DRACO_INCLUDE}/draco")
  message(FATAL_ERROR "DRACO_INCLUDE must name the staged Draco include directory.")
endif()
if(NOT DEFINED DRACO_ARCHIVE OR "${DRACO_ARCHIVE}" STREQUAL "" OR NOT EXISTS "${DRACO_ARCHIVE}")
  message(FATAL_ERROR "DRACO_ARCHIVE must name the staged Draco static archive.")
endif()
target_include_directories(slic3r_core PUBLIC "${DRACO_INCLUDE}")
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
  BOOST_HAS_THREADS
  BOOST_HAS_PTHREADS
  BOOST_THREAD_PLATFORM_PTHREAD
)
# Boost.Log ABI tag: Boost.Log 2.x is a compiled library (no header-only
# mode). The Boost archives were built with -pthread (build-boost-wasm64.sh),
# so their symbols live in the v2s_mt_posix namespace. Emscripten's libc++
# defines BOOST_HAS_THREADS, but boost/config/detail/suffix.hpp undefines it
# unless a threading API is recognized (BOOST_HAS_PTHREADS); without the
# defines below every BOOST_LOG_TRIVIAL call site would compile with the
# v2s_st namespace and fail to link. The define set opts our TUs into the
# multithreaded ABI namespace while the serial artifact remains free of
# pthreads. In the threaded artifact, retained Boost.Thread compatibility calls
# use the std::thread-backed shim; the slice's primary parallel work remains
# oneTBB-owned. The only real boost::thread user (GCodeSender) is dropped, and
# utils.cpp's async_frontend.hpp include (which would pull in boost::thread) is
# guarded out under __EMSCRIPTEN__ (patch 0007).
# -Wno-missing-template-arg-list-after-template-kw: Boost 1.84 quat_traits.hpp
# uses `quat_traits<Q>::template write_element_idx(...)` where the member is
# not a template in the scalar specialization; clang 21 promotes the
# diagnostic to an error (boost/qvm via boost/geometry). Boost fixed this
# upstream post-1.84; suppress here (accepted by clang 18/20).
# WASM_DEBUG: the libslic3r part is rebuilt with -g -O0 (embedded DWARF for
# interactive source-level debugging; -O0 keeps breakpoints, stepping and
# variable inspection usable). Deps are intentionally NOT covered — see the
# option comment at the top of this file.
if(WASM_DEBUG)
  set(SLIC3R_COMPILE_OPTS -g -O0 -fexceptions -Wno-unused
      -Wno-missing-template-arg-list-after-template-kw)
else()
  set(SLIC3R_COMPILE_OPTS -O3 -fexceptions -Wno-unused
      -Wno-missing-template-arg-list-after-template-kw)
endif()
target_compile_options(slic3r_core PRIVATE ${SLIC3R_COMPILE_OPTS})

# ---- Vendored deps (deps_src/ inside the submodule) ----
# The upstream two-stage build compiles these as separate static libs; the
# scaffold folds the needed ones into one deps_core archive. Sources mirror
# each deps_src/<dep>/CMakeLists.txt source list. Compiled here because they
# live outside the libslic3r GLOB and the link needs them (expat=3MF XML,
# miniz=3MF zip, admesh=STL load/repair, clipper=old ClipperLib Z-variant,
# clipper2=offset/rectclip, qhull=convex hull, glu-libtess=tesselation,
# semver=Semver.hpp, qoi=thumbnail PNG). Keep in sync with upstream lists.
enable_language(C)

set(DEPS_CORE_SRC
  "${ORCA_SRC}/deps_src/expat/xmlparse.c"
  "${ORCA_SRC}/deps_src/expat/xmlrole.c"
  "${ORCA_SRC}/deps_src/expat/xmltok.c"
  "${ORCA_SRC}/deps_src/miniz/miniz.c"
  "${ORCA_SRC}/deps_src/admesh/connect.cpp"
  "${ORCA_SRC}/deps_src/admesh/normals.cpp"
  "${ORCA_SRC}/deps_src/admesh/shared.cpp"
  "${ORCA_SRC}/deps_src/admesh/stl_io.cpp"
  "${ORCA_SRC}/deps_src/admesh/stlinit.cpp"
  "${ORCA_SRC}/deps_src/admesh/util.cpp"
  "${ORCA_SRC}/deps_src/clipper/clipper_z.cpp"
  "${ORCA_SRC}/deps_src/clipper2/Clipper2Lib/src/clipper.engine.cpp"
  "${ORCA_SRC}/deps_src/clipper2/Clipper2Lib/src/clipper.offset.cpp"
  "${ORCA_SRC}/deps_src/clipper2/Clipper2Lib/src/clipper.rectclip.cpp"
  "${ORCA_SRC}/deps_src/clipper2/Clipper2Lib/src/clipper2_z.cpp"
  "${ORCA_SRC}/deps_src/glu-libtess/src/dict.c"
  "${ORCA_SRC}/deps_src/glu-libtess/src/geom.c"
  "${ORCA_SRC}/deps_src/glu-libtess/src/memalloc.c"
  "${ORCA_SRC}/deps_src/glu-libtess/src/mesh.c"
  "${ORCA_SRC}/deps_src/glu-libtess/src/normal.c"
  "${ORCA_SRC}/deps_src/glu-libtess/src/priorityq-heap.c"
  "${ORCA_SRC}/deps_src/glu-libtess/src/priorityq.c"
  "${ORCA_SRC}/deps_src/glu-libtess/src/render.c"
  "${ORCA_SRC}/deps_src/glu-libtess/src/sweep.c"
  "${ORCA_SRC}/deps_src/glu-libtess/src/tess.c"
  "${ORCA_SRC}/deps_src/glu-libtess/src/tessmono.c"
  "${ORCA_SRC}/deps_src/qhull/src/libqhull_r/geom2_r.c"
  "${ORCA_SRC}/deps_src/qhull/src/libqhull_r/geom_r.c"
  "${ORCA_SRC}/deps_src/qhull/src/libqhull_r/global_r.c"
  "${ORCA_SRC}/deps_src/qhull/src/libqhull_r/io_r.c"
  "${ORCA_SRC}/deps_src/qhull/src/libqhull_r/libqhull_r.c"
  "${ORCA_SRC}/deps_src/qhull/src/libqhull_r/mem_r.c"
  "${ORCA_SRC}/deps_src/qhull/src/libqhull_r/merge_r.c"
  "${ORCA_SRC}/deps_src/qhull/src/libqhull_r/poly2_r.c"
  "${ORCA_SRC}/deps_src/qhull/src/libqhull_r/poly_r.c"
  "${ORCA_SRC}/deps_src/qhull/src/libqhull_r/qset_r.c"
  "${ORCA_SRC}/deps_src/qhull/src/libqhull_r/random_r.c"
  "${ORCA_SRC}/deps_src/qhull/src/libqhull_r/rboxlib_r.c"
  "${ORCA_SRC}/deps_src/qhull/src/libqhull_r/stat_r.c"
  "${ORCA_SRC}/deps_src/qhull/src/libqhull_r/user_r.c"
  "${ORCA_SRC}/deps_src/qhull/src/libqhull_r/usermem_r.c"
  # qhullcpp: the Qt-bound qt-qhull.cpp and usermem_r-cpp.cpp are omitted
  # (usermem_r.c provides the allocator hooks).
  "${ORCA_SRC}/deps_src/qhull/src/libqhullcpp/Coordinates.cpp"
  "${ORCA_SRC}/deps_src/qhull/src/libqhullcpp/PointCoordinates.cpp"
  "${ORCA_SRC}/deps_src/qhull/src/libqhullcpp/Qhull.cpp"
  "${ORCA_SRC}/deps_src/qhull/src/libqhullcpp/QhullFacet.cpp"
  "${ORCA_SRC}/deps_src/qhull/src/libqhullcpp/QhullFacetList.cpp"
  "${ORCA_SRC}/deps_src/qhull/src/libqhullcpp/QhullFacetSet.cpp"
  "${ORCA_SRC}/deps_src/qhull/src/libqhullcpp/QhullHyperplane.cpp"
  "${ORCA_SRC}/deps_src/qhull/src/libqhullcpp/QhullPoint.cpp"
  "${ORCA_SRC}/deps_src/qhull/src/libqhullcpp/QhullPointSet.cpp"
  "${ORCA_SRC}/deps_src/qhull/src/libqhullcpp/QhullPoints.cpp"
  "${ORCA_SRC}/deps_src/qhull/src/libqhullcpp/QhullQh.cpp"
  "${ORCA_SRC}/deps_src/qhull/src/libqhullcpp/QhullRidge.cpp"
  "${ORCA_SRC}/deps_src/qhull/src/libqhullcpp/QhullSet.cpp"
  "${ORCA_SRC}/deps_src/qhull/src/libqhullcpp/QhullStat.cpp"
  "${ORCA_SRC}/deps_src/qhull/src/libqhullcpp/QhullVertex.cpp"
  "${ORCA_SRC}/deps_src/qhull/src/libqhullcpp/QhullVertexSet.cpp"
  "${ORCA_SRC}/deps_src/qhull/src/libqhullcpp/RboxPoints.cpp"
  "${ORCA_SRC}/deps_src/qhull/src/libqhullcpp/RoadError.cpp"
  "${ORCA_SRC}/deps_src/qhull/src/libqhullcpp/RoadLogEvent.cpp"
  "${ORCA_SRC}/deps_src/semver/semver.c"
  "${ORCA_SRC}/deps_src/qoi/qoilib.c"
)
add_library(deps_core STATIC ${DEPS_CORE_SRC})

if(WASM_THREADING)
  target_include_directories(deps_core PUBLIC "${TBB_INCLUDE_DIR}")
endif()
target_include_directories(deps_core PUBLIC
  "${SHIM_INCLUDE}"
  "${GEN_INCLUDE}"
  "${ORCA_SRC}/src"
  "${LIBSLIC3R_ROOT}"
)
foreach(dep EIGEN_INCLUDE BOOST_INCLUDE CEREAL_INCLUDE)
  if(DEFINED ${dep} AND NOT "${${dep}}" STREQUAL "")
    target_include_directories(deps_core PUBLIC "${${dep}}")
  endif()
endforeach()
target_include_directories(deps_core PUBLIC
  "${ORCA_SRC}/deps_src"
  "${ORCA_SRC}/deps_src/admesh"
  "${ORCA_SRC}/deps_src/clipper"
  "${ORCA_SRC}/deps_src/clipper2/Clipper2Lib/include"
  "${ORCA_SRC}/deps_src/expat"
  "${ORCA_SRC}/deps_src/glu-libtess/include"
  "${ORCA_SRC}/deps_src/miniz"
  "${ORCA_SRC}/deps_src/qhull/src"
  "${ORCA_SRC}/deps_src/qoi"
  "${ORCA_SRC}/deps_src/semver"
)
# admesh's stl_io.cpp/util.cpp use boost::log/trivial.hpp — same ABI-tag
# defines as slic3r_core so the v2s_mt_posix symbols match the archives.
target_compile_definitions(deps_core PUBLIC
  BOOST_HAS_THREADS
  BOOST_HAS_PTHREADS
  BOOST_THREAD_PLATFORM_PTHREAD
)
target_compile_options(deps_core PRIVATE
  -O3 -fexceptions -Wno-unused
  -Wno-missing-template-arg-list-after-template-kw
  # glu-libtess priorityq-heap.c uses LONG_MAX without including <limits.h>
  # (compiles on other platforms only via transitive includes); wasm's libc
  # doesn't provide it. Scaffold-level fix, no submodule edit. Two separate
  # entries so the flag and header survive cmake->ninja quoting.
  -include
  limits.h
)

# ---- Module: bridge + CLI driver -> single WASM module ----
# Explicitly list every Neo bridge and CLI translation unit. Keep this source
# set outside the pinned Orca submodule; the C bridge and Worker transaction
# adapters remain Neo code.
set(ORCA_SLICE_SRC
  "${CMAKE_CURRENT_SOURCE_DIR}/src/slice_main.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/wasm_log.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/history/ProjectHistory.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/bridge_state.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/bridge_filament.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/bridge_history.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/bridge_model_operations.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/bridge_profiles.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/bridge_plate.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/bridge_slicing_pipeline.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/bridge_project_persistence.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/bridge_project_overlay.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/bridge.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/bridge_buffers.cpp"
)
add_executable(orca_slice ${ORCA_SLICE_SRC})
if(NEO_PROJECT_HISTORY_TEST)
  add_executable(project_history_core_test
    "${CMAKE_CURRENT_SOURCE_DIR}/src/history/ProjectHistory.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/history/ProjectHistory.test.cpp")
  target_link_options(project_history_core_test PRIVATE -m64 -sEXIT_RUNTIME=1 -sASSERTIONS=1)
endif()
# The bridge's error contract leans on C++ exceptions (nlohmann type_error,
# std::runtime_error from the slice path) being caught inside the bridge —
# emcc's default is -fignore-exceptions, which compiles try/catch blocks
# OUT; a throw then unwinds into JS as an uncatchable CppException even
# though -sDISABLE_EXCEPTION_CATCHING=0 keeps the runtime machinery alive.
# The libslic3r/deps TUs get -fexceptions from their own targets; the
# executable's TUs need it explicitly (the -fexceptions in
# target_link_options below is link-time only). M4 probe section 4: the
# nlohmann throw escaped orc_init's catches exactly because of this.
if(WASM_DEBUG)
  # Bridge/CLI TUs get the same -g -O0 as libslic3r (see slic3r_core above).
  target_compile_options(orca_slice PRIVATE -fexceptions -g -O0)
else()
  target_compile_options(orca_slice PRIVATE -fexceptions)
endif()
target_link_libraries(orca_slice PRIVATE slic3r_core deps_core "${DRACO_ARCHIVE}")
if(WASM_THREADING)
  target_link_libraries(orca_slice PRIVATE "${TBB_ARCHIVE}" "${TBBMALLOC_ARCHIVE}")
endif()
# Boost static archives (Emscripten-built wasm64, build-boost-wasm64.sh):
# libslic3r objects reference boost::filesystem / boost::regex / boost::log
# (v2s_mt_posix ABI — the archives were built with -pthread) / etc. Grouped
# because wasm-ld is a single-pass linker (cross-archive references).
file(GLOB BOOST_ARCHIVES "${BOOST_INCLUDE}/stage-wasm64/lib/libboost_*.a")
if(BOOST_ARCHIVES)
  target_link_libraries(orca_slice PRIVATE -Wl,--start-group ${BOOST_ARCHIVES} -Wl,--end-group)
endif()
set_target_properties(orca_slice PROPERTIES OUTPUT_NAME "orca_slice" SUFFIX ".js")
# Link optimization: debug replaces -O3 with -O0 -g. -g at LINK time is what
# embeds the DWARF sections in the final .wasm (no -gsource-map, no external
# files); -O0 skips heavy wasm-opt so the debug info survives in place.
set(ORCA_LINK_OPTIMIZE -O3)
if(WASM_DEBUG)
  set(ORCA_LINK_OPTIMIZE -O0 -g)
endif()
target_link_options(orca_slice PRIVATE
  ${ORCA_LINK_OPTIMIZE}
  -fexceptions
  -m64
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sENVIRONMENT=web,worker,node
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=64MB
  # Emscripten's default stack is 64KB. libslic3r's deep call chains (G-code
  # export nests the ~34KB GCode object plus recursive geometry passes) exceed
  # that, overflowing the stack region down into the .bss globals below it
  # (observed: locale facet id statics clobbered -> std::locale crash in
  # tm2str). 8MB gives generous headroom; with ALLOW_MEMORY_GROWTH the heap
  # simply starts higher.
  -sSTACK_SIZE=8388608
  -sEXIT_RUNTIME=0
  -sINVOKE_RUN=0
  -sFORCE_FILESYSTEM=1
  # HEAPU8: the bridge's binary-buffer contract (design §Bridge API: bytes
  # cross via _malloc/_free + HEAPU8 views) requires the JS side to see the
  # heap view; the bridge smoke stages model bytes through it.
  # addFunction/removeFunction: the progress-callback handoff (orc_
  # set_progress_callback takes a JS function via the wasm function table;
  # ALLOW_TABLE_GROWTH above makes dynamic allocation safe).
  # getExceptionMessage: M4 diag — decodes a CppException's excPtr into the
  # thrown type name (bridge probe); kept in the export list for CI probes.
  -sEXPORTED_RUNTIME_METHODS=callMain,FS,ccall,cwrap,UTF8ToString,HEAPU8,addFunction,removeFunction,getExceptionMessage
  # _main must be exported too: callMain is only generated when main is
  # kept (Emscripten 6 drops it otherwise, breaking Module.callMain).
  -sEXPORTED_FUNCTIONS=_main,_malloc,_free
  -sDISABLE_EXCEPTION_CATCHING=0
  -sALLOW_TABLE_GROWTH=1
)
if(WASM_DEBUG)
  # Runtime assertions are the default at -O0, but kept explicit here so a
  # future link-flag edit (e.g. raising the optimization level) cannot
  # silently strip them from a debug build.
  target_link_options(orca_slice PRIVATE -sASSERTIONS=1)
endif()
if(WASM_THREADING)
  target_link_options(orca_slice PRIVATE
    -pthread
    "-sPTHREAD_POOL_SIZE=${WASM_PTHREAD_POOL_SIZE}"
    # dlmalloc has a single global lock; mimalloc has per-thread allocation
    # contexts and avoids making TBB's allocation-heavy passes serialize.
    -sMALLOC=mimalloc
  )
endif()
# Only non-profile runtime resources (currently resources/info) may be
# preloaded. Profile packages are fetched and installed into MEMFS by JS.
foreach(_pf IN LISTS PRELOAD_FILES)
  if(NOT "${_pf}" STREQUAL "")
    if("${_pf}" MATCHES "resources[/\\]profiles|/profiles@")
      message(FATAL_ERROR "Profile resources must be packaged separately; do not pass --preload-file for profiles")
    endif()
    target_link_options(orca_slice PRIVATE "--preload-file=${_pf}")
  endif()
endforeach()
if(NOT PRELOAD_FILES)
  if(DEFINED PRELOAD_FILE AND NOT "${PRELOAD_FILE}" STREQUAL "")
    target_link_options(orca_slice PRIVATE "--preload-file=${PRELOAD_FILE}")
  endif()
endif()
