#include <CGAL/CORE_Expr.h>
#include <CGAL/Exact_predicates_exact_constructions_kernel_with_sqrt.h>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <gmpxx.h>
#include <igl/copyleft/cgal/assign_scalar.h>
#include <mpfr.h>
#include <stdexcept>
#if !defined(CGAL_USE_GMP) || !defined(CGAL_USE_MPFR) || !defined(CGAL_USE_CORE)
#error Full GMP MPFR CORE configuration is required.
#endif
static void require(bool condition, const char *message) {
    if (!condition)
        throw std::runtime_error(message);
}
void run_numeric_backend_tests() {
    static_assert(sizeof(mp_limb_t) * 8 == GMP_LIMB_BITS, "GMP ABI mismatch");
    for (unsigned i = 1; i <= 64; i++) {
        mpz_class a = (mpz_class(1) << (512 + i * 3)) + 1234567;
        mpz_class b = (mpz_class(1) << (255 + i * 2)) - 76543;
        mpz_class product = a * b;
        require(product / a == b && product % b == 0, "GMP large-integer division/multiply failed");
    }
    mpq_class third(1, 3);
    require(third * 3 == 1, "GMPXX rational failed");
    mpfr_t two, lo, hi, squared;
    mpfr_inits2(256, two, lo, hi, squared, (mpfr_ptr)0);
    mpfr_set_ui(two, 2, MPFR_RNDN);
    mpfr_sqrt(lo, two, MPFR_RNDD);
    mpfr_sqrt(hi, two, MPFR_RNDU);
    require(mpfr_cmp(lo, hi) < 0, "MPFR directed rounding collapsed");
    mpfr_mul(squared, lo, lo, MPFR_RNDD);
    require(mpfr_cmp(squared, two) < 0, "MPFR lower enclosure failed");
    mpfr_mul(squared, hi, hi, MPFR_RNDU);
    require(mpfr_cmp(squared, two) > 0, "MPFR upper enclosure failed");
    mpfr_clears(two, lo, hi, squared, (mpfr_ptr)0);
    require(std::strcmp(mpfr_get_patches(), "") == 0, "Unexpected MPFR patch inventory");
#if defined(ORCA_WASM_THREADING)
    require(mpfr_buildopt_tls_p() != 0, "Threaded MPFR requires thread-local state");
#else
    require(mpfr_buildopt_tls_p() == 0, "Serial MPFR must not require thread-local state");
#endif
    const CORE::Expr r2 = CORE::sqrt(CORE::Expr(2)), r3 = CORE::sqrt(CORE::Expr(3));
    require(r2 * r2 == CORE::Expr(2), "CORE exact square failed");
    require((r2 + r3) * (r2 - r3) == CORE::Expr(-1), "CORE exact cancellation failed");
    require(r2 + r3 > CORE::Expr(3) && r2 + r3 < CORE::Expr(4), "CORE exact comparison failed");
    using K = CGAL::Exact_predicates_exact_constructions_kernel_with_sqrt;
    K::Point_2 point(r2, 0);
    require(point.x() * point.x() == K::FT(2), "CGAL sqrt kernel failed");
    double d = 0;
    float f = 0;
    igl::copyleft::cgal::assign_scalar(r2, d);
    igl::copyleft::cgal::assign_scalar(r2, f);
    require(std::abs(d - std::sqrt(2.0)) < 1e-15 && std::abs(f - std::sqrt(2.0)) < 1e-6,
            "unmodified libigl CORE conversion failed");
    const CGAL::Epeck::FT rational = CGAL::Epeck::FT(1) / 3;
    igl::copyleft::cgal::assign_scalar(rational, d);
    require(std::abs(d - 1.0 / 3.0) < 1e-15, "unmodified libigl rational conversion failed");
    std::printf("{\"kind\":\"numeric\",\"passed\":true,\"pointerBits\":%zu,\"longBits\":%zu,"
                "\"gmpLimbBits\":%d,\"gmpVersion\":\"%s\",\"mpfrVersion\":\"%s\",\"mpfrTLS\":%d,"
                "\"coreEnabled\":true,\"libiglModified\":false}\n",
                sizeof(void *) * 8, sizeof(long) * 8, GMP_LIMB_BITS, gmp_version,
                mpfr_get_version(), mpfr_buildopt_tls_p());
    mpfr_free_cache();
}
