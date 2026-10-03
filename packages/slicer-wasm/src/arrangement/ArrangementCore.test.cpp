#include "libslic3r/Arrange.hpp"
#include "libslic3r/BoundingBox.hpp"
#include "libslic3r/ClipperUtils.hpp"

#include <atomic>
#include <cmath>
#include <iostream>
#include <stdexcept>
#ifdef ORCA_WASM_THREADING
#include <tbb/global_control.h>
#endif

using namespace Slic3r;
using namespace Slic3r::arrangement;

static void check(bool condition, const char* message)
{
    if (!condition) throw std::runtime_error(message);
}

static ArrangePolygon square(double side)
{
    const coord_t length = scaled(side);
    ArrangePolygon item;
    item.poly.contour.points = {{0, 0}, {length, 0}, {length, length}, {0, length}};
    item.bed_idx = 0;
    item.extrude_ids = {1};
    return item;
}

static void run(bool parallel)
{
    ArrangeParams params;
    params.parallel = parallel;
    params.allow_rotations = true;
    std::atomic<unsigned> progress_calls{0};
    params.progressind = [&](unsigned, std::string) { ++progress_calls; };
    const BoundingBox bed({0, 0}, {scaled(100.), scaled(100.)});
    ArrangePolygons items{square(20), square(30), square(200)};
    arrange(items, bed, params);
    check(items[0].bed_idx == 0 && items[1].bed_idx == 0, "small items must share the first bed");
    check(items[2].bed_idx == UNARRANGED, "oversized item must remain unarranged");
    ExPolygons placed;
    double sum_area = 0;
    for (std::size_t i = 0; i < 2; ++i) {
        check(std::isfinite(items[i].rotation), "rotation must be finite");
        auto shape = items[i].transformed_poly();
        for (const auto& point : shape.contour.points)
            check(bed.contains(point), "placed vertex must be inside bed");
        sum_area += shape.area();
        placed.push_back(std::move(shape));
    }
    double union_area = 0;
    for (const auto& shape : union_ex(placed)) union_area += shape.area();
    check(std::abs(sum_area - union_area) <= sum_area * 1e-9, "placed items must not overlap");
    check(progress_calls.load() > 0, "algorithm must report progress");

    ArrangePolygons overflow{square(80), square(80)};
    arrange(overflow, bed, params);
    check(overflow[0].is_arranged() && overflow[1].is_arranged(), "overflow must use another logical bed");
    check(overflow[0].bed_idx != overflow[1].bed_idx, "large items cannot share one bed");

    std::atomic<bool> stop_checked{false};
    params.stopcondition = [&] { stop_checked = true; return true; };
    ArrangePolygons canceled{square(20), square(30)};
    arrange(canceled, bed, params);
    check(stop_checked.load(), "algorithm must consult cancellation callback");
}

int main()
{
    try {
#ifdef ORCA_WASM_THREADING
        // Match the standalone test's four pre-created pthreads; production
        // continues to use its host-reported thread budget.
        tbb::global_control threads(tbb::global_control::max_allowed_parallelism, 4);
        tbb::task_scheduler_handle scheduler{tbb::attach{}};
#endif
        run(false);
#ifdef ORCA_WASM_THREADING
        run(true);
        check(tbb::finalize(scheduler, std::nothrow), "scheduler must finish before module shutdown");
#endif
        std::cout << "Arrangement core checks passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "Arrangement core check failed: " << error.what() << '\n';
        return 1;
    }
}
