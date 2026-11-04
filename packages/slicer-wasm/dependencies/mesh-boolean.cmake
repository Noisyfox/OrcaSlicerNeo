# The wrapper is the complete upstream TU. Keep its expensive CGAL headers
# and numerical policy local to this target, rather than every slicing TU.
foreach(required include/CGAL/version.h include/CGAL/CORE/Expr.h include/gmpxx.h include/mpfr.h lib/libgmp.a lib/libgmpxx.a lib/libmpfr.a manifest.json)
  if(NOT EXISTS "${CGAL_ROOT}/${required}")
    message(FATAL_ERROR "Missing CGAL dependency ${CGAL_ROOT}/${required}. Run dependencies/cgal/build.mjs for this variant.")
  endif()
endforeach()

# A quick Ninja build must also reject a stage from an older recipe/compiler.
# Track the recipe inputs so Ninja reconfigures before it can reuse that stage.
file(GLOB_RECURSE numerical_recipe_files CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/dependencies/cgal/*")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${numerical_recipe_files})
find_program(NEO_NODE_EXECUTABLE NAMES node REQUIRED)
execute_process(COMMAND "${NEO_NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/dependencies/cgal/build.mjs"
  verify --target "${WASM_TARGET}" --variant "${_DEPS_DEFAULT_VARIANT}" --stage "${CGAL_ROOT}"
  RESULT_VARIABLE numerical_verify_result ERROR_VARIABLE numerical_verify_error)
if(NOT numerical_verify_result EQUAL 0)
  message(FATAL_ERROR "CGAL stage verification failed; run the normal build driver: ${numerical_verify_error}")
endif()
file(READ "${CGAL_ROOT}/manifest.json" numerical_manifest)
string(JSON numerical_compiler GET "${numerical_manifest}" identity compiler)
execute_process(COMMAND "${CMAKE_CXX_COMPILER}" --version OUTPUT_VARIABLE actual_compiler
  OUTPUT_STRIP_TRAILING_WHITESPACE RESULT_VARIABLE compiler_result ERROR_VARIABLE compiler_error)
if(NOT compiler_result EQUAL 0)
  message(FATAL_ERROR "Cannot identify CMake's cached Emscripten compiler ${CMAKE_CXX_COMPILER} (exit ${compiler_result}): ${compiler_error}")
endif()
# execute_process normalizes Windows CRLF output to LF; the JSON manifest
# preserves Node's original command output. Compare the same line endings.
string(REPLACE "\r\n" "\n" numerical_compiler "${numerical_compiler}")
if(NOT actual_compiler STREQUAL numerical_compiler)
  message(FATAL_ERROR "CGAL stage and CMake's cached Emscripten compiler do not match.\nStage: ${numerical_compiler}\nCached compiler: ${actual_compiler}")
endif()
string(JSON numerical_width GET "${numerical_manifest}" identity width)
string(JSON numerical_threaded GET "${numerical_manifest}" identity threaded)
string(REPLACE "wasm" "" expected_width "${WASM_TARGET}")
if(NOT numerical_width STREQUAL expected_width OR (numerical_threaded AND NOT WASM_THREADING) OR (WASM_THREADING AND NOT numerical_threaded))
  message(FATAL_ERROR "CGAL stage width/threading does not match ${WASM_TARGET}, WASM_THREADING=${WASM_THREADING}")
endif()

# Never patch the checked-out submodule. Recreate the private source copy
# when either the pinned input or the external-dependency patch changes.
set(mcut_patch "${CMAKE_CURRENT_SOURCE_DIR}/patches/mcut/0001-serial-context-execution.patch")
file(GLOB_RECURSE mcut_inputs CONFIGURE_DEPENDS "${ORCA_SRC}/deps_src/mcut/*")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${mcut_inputs} "${mcut_patch}")
file(SHA256 "${mcut_patch}" mcut_identity)
file(SHA256 "${CMAKE_CURRENT_LIST_FILE}" mcut_recipe)
string(APPEND mcut_identity "${mcut_recipe}")
foreach(input IN LISTS mcut_inputs)
  if(NOT IS_DIRECTORY "${input}")
    file(SHA256 "${input}" hash)
    string(APPEND mcut_identity "${hash}")
  endif()
endforeach()
string(SHA256 mcut_identity "${mcut_identity}")
set(mcut_source "${CMAKE_CURRENT_BINARY_DIR}/dependencies/mcut")
set(previous_identity "")
if(EXISTS "${mcut_source}/.neo-source")
  file(READ "${mcut_source}/.neo-source" previous_identity)
endif()
if(NOT previous_identity STREQUAL mcut_identity)
  file(REMOVE_RECURSE "${mcut_source}")
  file(COPY "${ORCA_SRC}/deps_src/mcut/" DESTINATION "${mcut_source}")
  find_package(Git REQUIRED)
  # Stop repository discovery above the private copy. Otherwise git apply,
  # invoked from an ignored directory inside the superproject, can silently
  # skip every hunk because its paths do not match the current repo prefix.
  file(REAL_PATH "${mcut_source}" mcut_real_source)
  cmake_path(GET mcut_real_source PARENT_PATH mcut_ceiling)
  execute_process(COMMAND "${CMAKE_COMMAND}" -E env "GIT_CEILING_DIRECTORIES=${mcut_ceiling}"
    "${GIT_EXECUTABLE}" apply "${mcut_patch}"
    WORKING_DIRECTORY "${mcut_real_source}" RESULT_VARIABLE patch_result ERROR_VARIABLE patch_error)
  if(NOT patch_result EQUAL 0)
    message(FATAL_ERROR "MCUT dependency patch failed: ${patch_error}")
  endif()
  file(READ "${mcut_source}/CMakeLists.txt" patched_mcut_cmake)
  if(NOT patched_mcut_cmake MATCHES "option\\(MCUT_BUILD_WITH_API_THREADS")
    message(FATAL_ERROR "MCUT dependency patch did not modify its source copy")
  endif()
  file(WRITE "${mcut_source}/.neo-source" "${mcut_identity}")
endif()
set(MCUT_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(MCUT_BUILD_TUTORIALS OFF CACHE BOOL "" FORCE)
set(MCUT_BUILD_DOCUMENTATION OFF CACHE BOOL "" FORCE)
set(MCUT_BUILD_AS_SHARED_LIB OFF CACHE BOOL "" FORCE)
set(MCUT_BUILD_WITH_API_THREADS ${WASM_THREADING} CACHE BOOL "" FORCE)
set(MCUT_BUILD_WITH_COMPUTE_HELPER_THREADPOOL ${WASM_THREADING} CACHE BOOL "" FORCE)
add_subdirectory("${mcut_source}" "${CMAKE_CURRENT_BINARY_DIR}/dependencies/mcut-build")
target_compile_options(mcut PRIVATE -fexceptions)

add_library(mesh_boolean STATIC "${LIBSLIC3R_ROOT}/MeshBoolean.cpp")
target_include_directories(mesh_boolean PRIVATE
  "$<TARGET_PROPERTY:slic3r_core,INCLUDE_DIRECTORIES>" "${CGAL_ROOT}/include")
target_compile_definitions(mesh_boolean PRIVATE
  "$<TARGET_PROPERTY:slic3r_core,COMPILE_DEFINITIONS>"
  CGAL_ALWAYS_ROUND_TO_NEAREST=1 CGAL_USE_GMPXX=1)
if(NOT WASM_THREADING)
  target_compile_definitions(mesh_boolean PRIVATE CGAL_HAS_NO_THREADS=1)
endif()
target_compile_options(mesh_boolean PRIVATE ${SLIC3R_COMPILE_OPTS})
target_link_libraries(mesh_boolean PUBLIC mcut
  "${CGAL_ROOT}/lib/libmpfr.a" "${CGAL_ROOT}/lib/libgmpxx.a" "${CGAL_ROOT}/lib/libgmp.a")
target_link_libraries(slic3r_core PUBLIC mesh_boolean)
