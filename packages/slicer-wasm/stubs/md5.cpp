// stubs/md5.cpp — public-domain MD5 (RFC 1321) so the generated
// <openssl/md5.h> declarations resolve at link time. Used by Utils.hpp
// (bbl_calc_md5) and Format/bbs_3mf.cpp (plate gcode md5).
// After Colin Plumb's public-domain reference implementation.
#include <openssl/md5.h>

#include <cstdint>
#include <cstring>

namespace {

using u32 = std::uint32_t;
using u8  = std::uint8_t;

inline u32 rotl(u32 x, int c) { return (x << c) | (x >> (32 - c)); }

void transform(u32 state[4], const u8 block[64]) {
    static const u32 K[64] = {
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
        0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
        0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
        0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
        0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
        0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
        0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
        0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
        0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
        0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
        0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391};
    static const int S[64] = {
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21};

    u32 a = state[0], b = state[1], c = state[2], d = state[3];
    u32 M[16];
    for (int i = 0; i < 16; ++i)
        M[i] = u32(block[i * 4]) | (u32(block[i * 4 + 1]) << 8) |
               (u32(block[i * 4 + 2]) << 16) | (u32(block[i * 4 + 3]) << 24);
    for (int i = 0; i < 64; ++i) {
        u32 f;
        int g;
        if (i < 16) {
            f = (b & c) | (~b & d);
            g = i;
        } else if (i < 32) {
            f = (d & b) | (~d & c);
            g = (5 * i + 1) % 16;
        } else if (i < 48) {
            f = b ^ c ^ d;
            g = (3 * i + 5) % 16;
        } else {
            f = c ^ (b | ~d);
            g = (7 * i) % 16;
        }
        u32 tmp = d;
        d = c;
        c = b;
        b = b + rotl(a + f + K[i] + M[g], S[i]);
        a = tmp;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
}

}  // namespace

extern "C" {

int MD5_Init(MD5_CTX* ctx) {
    ctx->A = 0x67452301;
    ctx->B = 0xefcdab89;
    ctx->C = 0x98badcfe;
    ctx->D = 0x10325476;
    ctx->Nl = 0;
    ctx->Nh = 0;
    ctx->num = 0;
    return 1;
}

int MD5_Update(MD5_CTX* ctx, const void* data, size_t len) {
    const u8* p = static_cast<const u8*>(data);
    u32 old = ctx->Nl;
    ctx->Nl = old + u32(len << 3);
    if (ctx->Nl < old) ++ctx->Nh;
    ctx->Nh += u32(len >> 29);

    u32 t = (old >> 3) & 0x3f;  // bytes already buffered
    if (t) {
        u32 want = 64 - t;
        if (len < want) {
            std::memcpy(ctx->data + (t >> 2), p, len);
            ctx->num = t + u32(len);
            return 1;
        }
        std::memcpy(ctx->data + (t >> 2), p, want);
        u32 s[4] = {ctx->A, ctx->B, ctx->C, ctx->D};
        u8 block[64];
        std::memcpy(block, ctx->data, 64);
        transform(s, block);
        ctx->A = s[0];
        ctx->B = s[1];
        ctx->C = s[2];
        ctx->D = s[3];
        ctx->num = 0;
        p += want;
        len -= want;
    }
    while (len >= 64) {
        u32 s[4] = {ctx->A, ctx->B, ctx->C, ctx->D};
        transform(s, p);
        ctx->A = s[0];
        ctx->B = s[1];
        ctx->C = s[2];
        ctx->D = s[3];
        p += 64;
        len -= 64;
    }
    if (len) {
        std::memcpy(ctx->data, p, len);
        ctx->num = u32(len);
    }
    return 1;
}

int MD5_Final(u8 digest[MD5_DIGEST_LENGTH], MD5_CTX* ctx) {
    // Append 0x80 + zeros to 56 mod 64, then the 64-bit bit length, feed the
    // whole tail through Update (which already has the buffered bytes), emit.
    const u32 t = (ctx->Nl >> 3) & 0x3f;
    const u64 bits = (u64(ctx->Nh) << 32) | u64(ctx->Nl);
    // Padding: 0x80 followed by zeros up to 56, then 8 length bytes (LE).
    // Build the padded message and feed it through Update.
    size_t total = t;
    u8 tail[128];
    size_t tail_len = 0;
    tail[tail_len++] = 0x80;
    while (((total + tail_len) % 64) != 56) tail[tail_len++] = 0;
    for (int i = 0; i < 8; ++i) tail[tail_len++] = u8(bits >> (8 * i));
    MD5_Update(ctx, tail, tail_len);
    u32 s[4] = {ctx->A, ctx->B, ctx->C, ctx->D};
    for (int i = 0; i < 4; ++i) {
        digest[i * 4] = u8(s[i]);
        digest[i * 4 + 1] = u8(s[i] >> 8);
        digest[i * 4 + 2] = u8(s[i] >> 16);
        digest[i * 4 + 3] = u8(s[i] >> 24);
    }
    return 1;
}

}  // extern "C"
