// ----------------------------------------------------------------
// ------------ Minimal libslic3r driver for the WASM spike -------
// ----------------------------------------------------------------
// A tiny headless entry point that exercises the FDM slice path directly via
// libslic3r's public API, avoiding OrcaSlicer's GUI-entangled CLI. Driven from
// Node (harness/run-slice.mjs) through Emscripten MEMFS + callMain.
//
// Usage:  orca_slice <model-file> <config.json> <out.gcode>
//
// The libslic3r API is version-sensitive across the Slic3r/Prusa/Orca lineage;
// this targets the pinned ORCA_REF and is the expected place to adjust call
// signatures as the spike compiles. Keep it small.
#include <cstdio>
#include <exception>
#include <string>

#include "libslic3r/Model.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/PrintConfig.hpp"

#include "wasm_log.hpp"

using namespace Slic3r;

int main(int argc, char** argv) {
  // Boost.Log sinks (console + /tmp/orca.log) before any libslic3r work so
  // the earliest records are captured. The level comes from the module's JS
  // global (the Node harness sets globalThis.ORCA_LOG_LEVEL before callMain).
  wasm_log::init_with_level(wasm_log::level_from_js_global());

  if (argc < 4) {
    std::fprintf(stderr, "usage: orca_slice <model-file> <config.json> <out.gcode>\n");
    return 2;
  }
  const std::string model_path = argv[1];
  const std::string config_path = argv[2];
  const std::string out_path = argv[3];

  try {
    // ---- Load print configuration from a .json config file ----
    // Start from the full default config: libslic3r expects the config map to
    // contain every option (optptr() returns nullptr for missing keys, and
    // some code paths dereference that). Real OrcaSlicer always slices with a
    // complete config assembled from presets.
    DynamicPrintConfig config = DynamicPrintConfig::full_print_config();
    config.load(config_path, ForwardCompatibilitySubstitutionRule::Enable);
    config.normalize_fdm();

    // ---- Load the mesh ----
    Model model = Model::read_from_file(model_path, &config, nullptr,
                                        LoadStrategy::AddDefaultInstances);
    if (model.objects.empty()) {
      std::fprintf(stderr, "error: model has no objects\n");
      return 1;
    }

    // ---- Build and run the print ----
    Print print;
    print.apply(model, config);
    // validate() returns a StringObjectException (error string + object it
    // refers to) at the pinned SHA; use its .string member for the message.
    const StringObjectException validation_error = print.validate();
    if (!validation_error.string.empty()) {
      std::fprintf(stderr, "validate: %s\n", validation_error.string.c_str());
      return 1;
    }
    print.process();

    // ---- Export G-code ----
    // Newer signature: export_gcode(path_template, GCodeProcessorResult*, callback).
    print.export_gcode(out_path, nullptr, nullptr);

    std::fprintf(stderr, "ok: wrote %s\n", out_path.c_str());
    return 0;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "exception: %s\n", e.what());
    return 1;
  }
}
