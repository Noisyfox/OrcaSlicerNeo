// Emscripten supports pthread execution but intentionally does not expose the
// non-standard pthread_setname_np API. libslic3r uses it only for diagnostics
// in Thread.cpp; retaining a no-op keeps real slice workers intact without
// modifying the pinned C++ submodule.
#ifdef __EMSCRIPTEN__
#include <pthread.h>

extern "C" int pthread_setname_np(pthread_t /*thread*/, const char* /*name*/)
{
    return 0;
}
#endif
