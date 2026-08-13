// ----------------------------------------------------------------
// ------------ Minimal libnoise shim for the WASM build -----------
// ----------------------------------------------------------------
// libslic3r/Feature/FuzzySkin/FuzzySkin.cpp includes <libnoise/noise.h>
// (libnoise, a C++ noise library ported from the public-domain libnoise C
// library). The WASM build does not vendor libnoise; this stand-in provides
// the Module base plus the Perlin/Billow/RidgedMulti/Voronoi modules FuzzySkin
// instantiates, each implementing a cheap layered-sine noise in [-1, 1] that
// honours the frequency/octave/persistence settings. The fuzzy-skin feature
// therefore keeps producing plausible displacement; exact libnoise output is
// not a v1 goal. Compiled into the module, not a quality-critical path.
#pragma once

#include <cmath>

namespace noise { namespace module {

class Module {
public:
    explicit Module(int /*source_module_count*/) {}
    virtual ~Module() = default;
    virtual int GetSourceModuleCount() const { return 0; }
    virtual double GetValue(double x, double y, double z) const = 0;
};

namespace detail {

// Layered sine product noise in [-1, 1]: each octave halves the amplitude
// (persistence) and doubles the frequency. Deterministic.
inline double layered_sine(double x, double y, double z, double freq, int octaves, double persistence)
{
    double v   = 0.0;
    double amp = 1.0;
    double f   = freq > 0.0 ? freq : 1.0;
    for (int i = 0; i < octaves && i < 12; ++i) {
        v += amp * std::sin(x * f) * std::cos(y * f) * std::sin(z * f);
        amp *= persistence;
        f *= 2.0;
    }
    return v;
}

}  // namespace detail

class Perlin : public Module {
public:
    Perlin() : Module(0) {}
    void SetFrequency(double f) { freq_ = f; }
    void SetOctaveCount(int n) { octaves_ = n; }
    void SetPersistence(double p) { persistence_ = p; }
    double GetValue(double x, double y, double z) const override
    {
        return detail::layered_sine(x, y, z, freq_, octaves_, persistence_);
    }

private:
    double freq_        = 1.0;
    int    octaves_     = 6;
    double persistence_ = 0.5;
};

class Billow : public Perlin {
public:
    Billow() : Perlin() { SetPersistence(0.5); }
};

class RidgedMulti : public Perlin {
public:
    RidgedMulti() : Perlin() { SetOctaveCount(6); }
};

class Voronoi : public Module {
public:
    Voronoi() : Module(0) {}
    void SetFrequency(double f) { freq_ = f; }
    void SetDisplacement(double d) { displacement_ = d; }
    double GetValue(double x, double y, double z) const override
    {
        return detail::layered_sine(x, y, z, freq_, 2, 0.5) * displacement_;
    }

private:
    double freq_        = 1.0;
    double displacement_ = 1.0;
};

}}  // namespace noise::module
