#include <ft2build.h>
#include FT_FREETYPE_H

int main(void)
{
    FT_Library library = 0;
    return FT_Init_FreeType(&library) == 0 ? 0 : 1;
}
