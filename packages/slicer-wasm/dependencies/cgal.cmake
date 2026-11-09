# CGAL/CORE are header-only. This interface carries their common numerical
# policy and prebuilt GMP/MPFR closure without creating a compiled library.
foreach(required include/CGAL/version.h include/CGAL/CORE/Expr.h include/gmpxx.h include/mpfr.h lib/libgmp.a lib/libgmpxx.a lib/libmpfr.a manifest.json)
  if(NOT EXISTS "${CGAL_ROOT}/${required}")
    message(FATAL_ERROR "Missing CGAL dependency ${CGAL_ROOT}/${required}. Run dependencies/cgal/build.mjs for this variant.")
  endif()
endforeach()

# A quick Ninja build must also reject a stage from an older recipe/compiler.
file(GLOB_RECURSE numerical_recipe_files CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/dependencies/cgal/*")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${numerical_recipe_files}
  "${ORCA_SRC}/deps/GMP/0001-GMP_GCC15.patch" "${CGAL_ROOT}/manifest.json")
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

add_library(cgal_dependencies INTERFACE)
target_include_directories(cgal_dependencies INTERFACE "${CGAL_ROOT}/include")
target_compile_definitions(cgal_dependencies INTERFACE
  CGAL_ALWAYS_ROUND_TO_NEAREST=1 CGAL_USE_GMPXX=1)
if(WASM_THREADING)
  target_compile_definitions(cgal_dependencies INTERFACE CGAL_LINKED_WITH_TBB)
  target_include_directories(cgal_dependencies INTERFACE "${TBB_INCLUDE_DIR}")
else()
  target_compile_definitions(cgal_dependencies INTERFACE CGAL_HAS_NO_THREADS=1)
endif()
target_link_libraries(cgal_dependencies INTERFACE
  "${CGAL_ROOT}/lib/libmpfr.a" "${CGAL_ROOT}/lib/libgmpxx.a" "${CGAL_ROOT}/lib/libgmp.a")
