// AGPL-3.0. Native screen sampling adapted from OrcaSlicer PR #16587.
#pragma once
#include <cstdint>
#include <functional>

namespace screen_color {
enum class Status { Picked, Cancelled, Failed };
struct Result { Status status; std::uint32_t rgb = 0; };
using Callback = std::function<void(Result)>;
bool Available(); // Local API only. Does not connect to or probe a Linux portal.
void Start(Callback done);
void Cancel();
#ifdef SCREEN_COLOR_FIXTURE
void CompleteFixture(Result result);
#endif
}
