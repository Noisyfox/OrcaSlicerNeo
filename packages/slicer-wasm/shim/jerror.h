// Minimal stand-in for libjpeg's jerror.h (paired with shim/jpeglib.h).
// GCode/Thumbnails.cpp includes <jerror.h> but uses no JERR_* constants in
// the compiled code paths.
#pragma once
#include "jpeglib.h"
