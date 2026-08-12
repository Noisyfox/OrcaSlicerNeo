// Native (host-compiler) test for the serial parallel_pipeline stand-in.
// Build:  g++ -std=c++17 -I shim shim/pipeline_test.cpp -o /tmp/pipeline_test
// Run:    /tmp/pipeline_test
#include "_serial.hpp"

#include <cassert>
#include <sstream>
#include <string>

int main() {
    std::ostringstream out;
    const int n = 5;
    tbb::parallel_pipeline(
        12,
        tbb::make_filter<void, int>(tbb::filter_mode::serial_in_order,
            [n](tbb::flow_control& fc) -> int {
                static int i = 0;
                if (i >= n) {
                    fc.stop();
                    return 0;
                }
                return i++;
            }) &
        tbb::make_filter<int, int>(tbb::filter_mode::serial_in_order,
            [](int v) { return v * 2; }) &
        tbb::make_filter<int, std::string>(tbb::filter_mode::serial_in_order,
            [](int v) { return "x" + std::to_string(v); }) &
        tbb::make_filter<std::string, void>(tbb::filter_mode::serial_in_order,
            [&](std::string&& s) { out << s << '\n'; }));
    assert(out.str() == "x0\nx2\nx4\nx6\nx8\n");
    return 0;
}
