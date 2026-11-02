// Test target only; never linked into the production addon.
#include "sampler.h"
#include <utility>
namespace screen_color {
namespace { Callback pending; }
bool Available() { return true; }
void Start(Callback done) { pending = std::move(done); }
void CompleteFixture(Result result) { auto done = std::move(pending); if (done) done(result); }
void Cancel() { CompleteFixture({Status::Cancelled}); }
}
