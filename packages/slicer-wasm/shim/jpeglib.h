// ------------------------------------------------------------------
// ---- Minimal libjpeg stand-in for the WASM build ------------------
// ------------------------------------------------------------------
// GCode/Thumbnails.cpp embeds JPEG thumbnails in G-code and includes
// <jpeglib.h> unconditionally; libjpeg is not part of the WASM dep set
// (no vendored source, no Emscripten-built archive). The v1 slice uses
// PNG/QOI thumbnails, so this stub provides just enough of the libjpeg
// public API to COMPILE Thumbnails.cpp; stubs/jpeg-stub.cpp implements
// it as no-ops that produce an empty buffer. Selecting JPG thumbnails
// in v1 therefore yields an empty thumbnail, never a link failure.
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

#define FALSE 0
#define TRUE  1

enum J_COLOR_SPACE {
  JCS_UNKNOWN, JCS_GRAYSCALE, JCS_RGB, JCS_YCbCr, JCS_CMYK, JCS_YCCK,
  JCS_EXT_RGB, JCS_EXT_RGBX, JCS_EXT_BGR, JCS_EXT_BGRX, JCS_EXT_XBGR,
  JCS_EXT_XRGB, JCS_EXT_RGBA, JCS_EXT_BGRA, JCS_EXT_ARGB, JCS_EXT_ABGR,
  JCS_RGB565
};

struct jpeg_error_mgr {
  int dummy;
};

typedef struct {
  struct jpeg_error_mgr *err;
  unsigned int image_width;
  unsigned int image_height;
  unsigned int input_components;
  enum J_COLOR_SPACE in_color_space;
} jpeg_compress_struct;

struct jpeg_error_mgr *jpeg_std_error(struct jpeg_error_mgr *);
void jpeg_create_compress(jpeg_compress_struct *);
void jpeg_mem_dest(jpeg_compress_struct *, unsigned char **outbuffer, unsigned long *outsize);
void jpeg_set_defaults(jpeg_compress_struct *);
void jpeg_set_quality(jpeg_compress_struct *, int quality, int force_baseline);
void jpeg_start_compress(jpeg_compress_struct *, int write_all_tables);
unsigned int jpeg_write_scanlines(jpeg_compress_struct *, unsigned char **scanlines, unsigned int max_lines);
void jpeg_finish_compress(jpeg_compress_struct *);
void jpeg_destroy_compress(jpeg_compress_struct *);

#ifdef __cplusplus
}
#endif
