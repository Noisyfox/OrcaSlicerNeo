// ----------------------------------------------------------------
// -------- Runtime proof that oneTBB uses multiple WASM workers ---
// ----------------------------------------------------------------
// This is deliberately independent from libslic3r. It establishes that the
// exact Emscripten flags + oneTBB archive used by the slicer can execute a
// tbb::parallel_for on more than one worker before the full build depends on
// it. The Node runner asserts the machine-readable final line.
#include <array>
#include <atomic>
#include <iostream>

#include <tbb/global_control.h>
#include <tbb/parallel_for.h>
#include <tbb/task_arena.h>

int main()
{
    constexpr int requested_workers = 4;
    constexpr int task_count = 4 * 1024 * 1024;
    std::array<std::atomic<bool>, 64> seen{};
    std::atomic<unsigned int> checksum{0};

    tbb::global_control cap(tbb::global_control::max_allowed_parallelism, requested_workers);
    tbb::task_arena arena(requested_workers);
    arena.execute([&] {
        tbb::parallel_for(0, task_count, [&](int i) {
            const int index = tbb::this_task_arena::current_thread_index();
            if (index >= 0 && index < static_cast<int>(seen.size()))
                seen[static_cast<std::size_t>(index)].store(true, std::memory_order_relaxed);
            checksum.fetch_xor(static_cast<unsigned int>(i * 2654435761u), std::memory_order_relaxed);
        }, tbb::static_partitioner{});
    });

    int workers = 0;
    for (const auto& value : seen)
        workers += value.load(std::memory_order_relaxed) ? 1 : 0;
    std::cout << "ORCA_TBB_WORKERS=" << workers
              << " ORCA_TBB_MAX_CONCURRENCY=" << tbb::this_task_arena::max_concurrency()
              << " ORCA_TBB_CHECKSUM=" << checksum.load(std::memory_order_relaxed)
              << std::endl;
    return workers >= 2 ? 0 : 2;
}
