// ----------------------------------------------------------------
// ------------ Boost.Log setup for the WASM module ----------------
// ----------------------------------------------------------------
// The only place that touches boost::log::core in the WASM build. libslic3r
// emits BOOST_LOG_TRIVIAL records throughout the FDM path, but with no sinks
// registered logging::core drops every record — this TU installs them.
//
// Both entry points of the orca_slice module call init_with_level():
//   - bridge path: orc_init passes the level string from its options JSON
//     (the JS client forwards globalThis.ORCA_LOG_LEVEL)
//   - CLI path: slice_main's main() reads the same global via EM_JS (Node
//     harness sets globalThis.ORCA_LOG_LEVEL before callMain)
// init_with_level() is idempotent: sinks install once, the severity filter
// re-applies every call.
#include "wasm_log.hpp"

#include <boost/log/core.hpp>
#include <boost/log/expressions.hpp>
#include <boost/log/sinks/sync_frontend.hpp>
#include <boost/log/sinks/text_file_backend.hpp>
#include <boost/log/sinks/text_ostream_backend.hpp>
#include <boost/log/trivial.hpp>
#include <boost/log/utility/setup/common_attributes.hpp>
#include <boost/core/null_deleter.hpp>
#include <boost/make_shared.hpp>
// Defines the date_time_formatter_generator_traits<ptime> specializations the
// formatter below needs; the bare formatters/date_time.hpp only declares the
// generic machinery and leaves the traits undefined (link-compile error).
#include <boost/log/support/date_time.hpp>

#include <emscripten/emscripten.h>

#include <iostream>
#include <string>

namespace wasm_log {

namespace expr   = boost::log::expressions;
namespace sinks  = boost::log::sinks;
namespace trivia = boost::log::trivial;

namespace {

using ostream_sink = sinks::synchronous_sink<sinks::text_ostream_backend>;
using file_sink    = sinks::synchronous_sink<sinks::text_file_backend>;

bool g_initialized = false;

trivia::severity_level parse_level(const std::string& level)
{
    if (level == "trace")   return trivia::trace;
    if (level == "debug")   return trivia::debug;
    if (level == "info")    return trivia::info;
    if (level == "warning" || level == "warn") return trivia::warning;
    if (level == "error")   return trivia::error;
    if (level == "fatal")   return trivia::fatal;
    // Unknown or unset (empty) — never let a bad JS value silence or flood
    // the log; fall back to the sane default.
    return trivia::info;
}

// Shared by both sinks: [2026-08-21 10:15:30.123456] [info] message
const auto k_format = expr::stream
    << "[" << expr::format_date_time<boost::posix_time::ptime>(
                 "TimeStamp", "%Y-%m-%d %H:%M:%S.%f")
    << "] [" << expr::attr<trivia::severity_level>("Severity")
    << "] " << expr::smessage;

// CLI path only: read the level from the module's JS global. EM_JS bodies
// run in the module's own JS context — the Node harness global for callMain,
// the app worker global for the bridge. Returns -1 when unset/unknown so the
// C++ side can apply its default.
EM_JS(int, wasm_log_js_level, (), {
  var lv = (typeof globalThis !== 'undefined' && globalThis.ORCA_LOG_LEVEL) || "";
  var map = {trace: 0, debug: 1, info: 2, warning: 3, warn: 3, error: 4, fatal: 5};
  return (lv in map) ? map[lv] : -1;
});

}  // namespace

void init_with_level(const std::string& level)
{
    auto& core = *boost::log::core::get();
    if (!g_initialized) {
        // TimeStamp / Severity / ThreadID attributes on every record.
        boost::log::add_common_attributes();
        {
            // Console: std::clog → DevTools console in the browser, stdout
            // in the Node harness. auto_flush keeps each record visible
            // immediately (crash = log is still complete up to that point).
            auto backend = boost::make_shared<sinks::text_ostream_backend>();
            backend->add_stream(
                boost::shared_ptr<std::ostream>(&std::clog, boost::null_deleter()));
            backend->auto_flush(true);
            auto sink = boost::make_shared<ostream_sink>(backend);
            sink->set_formatter(k_format);
            core.add_sink(sink);
        }
        {
            // File: /tmp/orca.log in MEMFS. open_mode defaults to out|trunc
            // (fresh file per module session); auto_flush defaults to FALSE
            // (text_file_backend.hpp:606), which would leave records stuck in
            // the C++ stream buffer — the JS side reads the file while the
            // module is still alive, so flush explicitly. No rotation
            // configured — logs grow within a session. The JS client reads
            // the file back via Module.FS.readFile (same mechanism as
            // /out.gcode).
            auto backend = boost::make_shared<sinks::text_file_backend>(
                boost::log::keywords::file_name  = "/tmp/orca.log",
                boost::log::keywords::auto_flush = true);
            auto sink = boost::make_shared<file_sink>(backend);
            sink->set_formatter(k_format);
            core.add_sink(sink);
        }
        g_initialized = true;
    }
    // "Severity" is the keyword the BOOST_LOG_TRIVIAL macros tag their
    // records with (boost/log/trivial.hpp). Records below the level are
    // dropped before any sink sees them.
    core.set_filter(trivia::severity >= parse_level(level));
}

std::string level_from_js_global()
{
    switch (wasm_log_js_level()) {
        case 0: return "trace";
        case 1: return "debug";
        case 2: return "info";
        case 3: return "warning";
        case 4: return "error";
        case 5: return "fatal";
        default: return "info";
    }
}

}  // namespace wasm_log
