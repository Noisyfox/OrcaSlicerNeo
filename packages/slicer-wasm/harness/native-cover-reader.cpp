#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <wx/image.h>
#include <wx/imagpng.h>
#include <wx/mstream.h>

namespace Slic3r { std::string bbs_3mf_get_thumbnail(const char* path); }

int main(int argc, char** argv)
{
    if (argc != 3) {
        std::cerr << "Usage: native-cover-reader project.3mf expected.png\n";
        return 2;
    }
    const std::string actual = Slic3r::bbs_3mf_get_thumbnail(argv[1]);
    std::ifstream input(argv[2], std::ios::binary);
    const std::string expected{std::istreambuf_iterator<char>(input), {}};
    if (!input || expected.empty() || actual != expected) {
        std::cerr << "Desktop Orca did not read the expected custom cover (read "
                  << actual.size() << " bytes, expected " << expected.size() << ")\n";
        return 1;
    }
    wxImage::AddHandler(new wxPNGHandler);
    wxMemoryInputStream stream(actual.data(), actual.size());
    const wxImage image(stream, wxBITMAP_TYPE_PNG);
    if (!image.IsOk()) {
        std::cerr << "Desktop Orca could not decode the custom cover PNG\n";
        return 1;
    }
    std::cout << "PASS desktop Orca cover read and PNG decode: "
              << image.GetWidth() << "x" << image.GetHeight() << "\n";
}
