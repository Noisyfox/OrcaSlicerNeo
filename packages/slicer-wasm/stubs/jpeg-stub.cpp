// stubs/jpeg-stub.cpp — no-op implementations of the minimal libjpeg API
// declared in shim/jpeglib.h (paired with the shim header; Thumbnails.cpp
// includes <jpeglib.h> unconditionally but v1 uses PNG/QOI thumbnails).
// jpeg_mem_dest zeroes the output size so a JPG thumbnail configured in v1
// degrades to an empty buffer instead of garbage.
#include "jpeglib.h"

extern "C" {

struct jpeg_error_mgr *jpeg_std_error(struct jpeg_error_mgr *e) { return e; }

void jpeg_create_compress(jpeg_compress_struct *) {}

void jpeg_mem_dest(jpeg_compress_struct *, unsigned char **, unsigned long *outsize) { *outsize = 0; }

void jpeg_set_defaults(jpeg_compress_struct *) {}

void jpeg_set_quality(jpeg_compress_struct *, int, int) {}

void jpeg_start_compress(jpeg_compress_struct *, int) {}

unsigned int jpeg_write_scanlines(jpeg_compress_struct *, unsigned char **, unsigned int) { return 0; }

void jpeg_finish_compress(jpeg_compress_struct *) {}

void jpeg_destroy_compress(jpeg_compress_struct *) {}

}  // extern "C"
