# One identity check covers recipe/compiler/width/threading for each compiled
# import dependency. Never pair old in-tree headers with the staged archives.
find_program(NEO_NODE_EXECUTABLE NAMES node REQUIRED)
file(GLOB_RECURSE external_recipe_files CONFIGURE_DEPENDS
  "${CMAKE_CURRENT_SOURCE_DIR}/dependencies/external/*"
  "${CMAKE_CURRENT_SOURCE_DIR}/patches/occt/*"
  "${ORCA_SRC}/deps/EXPAT/expat/*")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${external_recipe_files})
foreach(library occt qhull expat)
  string(TOUPPER "${library}" root_name)
  set(stage "${${root_name}_ROOT}")
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${stage}/manifest.json")
  execute_process(COMMAND "${NEO_NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/dependencies/external/build.mjs"
    verify --library "${library}" --target "${WASM_TARGET}" --variant "${_DEPS_DEFAULT_VARIANT}" --stage "${stage}"
    RESULT_VARIABLE external_verify_result ERROR_VARIABLE external_verify_error)
  if(NOT external_verify_result EQUAL 0)
    message(FATAL_ERROR "${library} stage verification failed; run the normal build driver: ${external_verify_error}")
  endif()
endforeach()

add_library(qhull_cpp STATIC IMPORTED)
set_target_properties(qhull_cpp PROPERTIES IMPORTED_LOCATION "${QHULL_ROOT}/lib/libqhullcpp.a"
  INTERFACE_INCLUDE_DIRECTORIES "${QHULL_ROOT}/include")
add_library(qhull_reentrant STATIC IMPORTED)
set_target_properties(qhull_reentrant PROPERTIES IMPORTED_LOCATION "${QHULL_ROOT}/lib/libqhullstatic_r.a"
  INTERFACE_INCLUDE_DIRECTORIES "${QHULL_ROOT}/include")
add_library(expat_parser STATIC IMPORTED)
set_target_properties(expat_parser PROPERTIES IMPORTED_LOCATION "${EXPAT_ROOT}/lib/libexpat.a"
  INTERFACE_INCLUDE_DIRECTORIES "${EXPAT_ROOT}/include")
target_link_libraries(slic3r_core PUBLIC qhull_cpp qhull_reentrant expat_parser)
