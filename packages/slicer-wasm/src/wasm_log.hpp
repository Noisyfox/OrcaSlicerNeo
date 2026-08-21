// packages/slicer-wasm/src/wasm_log.hpp
// See wasm_log.cpp — boost::log setup shared by the bridge and CLI entry
// points of the orca_slice module.
#pragma once

#include <string>

namespace wasm_log {

// Install the console (std::clog) + file (/tmp/orca.log, MEMFS) sinks on the
// first call, then apply the severity filter from a level string
// (trace|debug|info|warning|error|fatal; unknown/empty → info). Idempotent.
void init_with_level(const std::string& level);

// CLI path: the level value from globalThis.ORCA_LOG_LEVEL in the module's
// JS context (Node harness global; EM_JS). Defaults to "info" when unset.
std::string level_from_js_global();

}  // namespace wasm_log
