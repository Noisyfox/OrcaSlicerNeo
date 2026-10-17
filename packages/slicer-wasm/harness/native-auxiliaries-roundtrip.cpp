#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/Preset.hpp"
#include "libslic3r/Utils.hpp"
#include <iostream>
#include <string>
#include <tbb/task_arena.h>

int main(int argc, char** argv)
{
    if (argc != 4 && (argc != 5 || std::string(argv[4]) != "--thumbnails")) {
        std::cerr << "Usage: native-auxiliaries-roundtrip input.3mf output.3mf temporary-directory [--thumbnails]\n";
        return 2;
    }
    using namespace Slic3r;
    set_temporary_dir(argv[3]);
    Model model;
    DynamicPrintConfig config;
    ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Enable};
    PlateDataPtrs plates;
    std::vector<Preset*> presets;
    bool bbl = false, orca = false;
    Semver version;
    const bool loaded = load_bbs_3mf(argv[1], &config, &substitutions, &model, &plates,
        &presets, &bbl, &orca, &version, nullptr,
        LoadStrategy::LoadModel | LoadStrategy::LoadConfig | LoadStrategy::LoadAuxiliary |
        LoadStrategy::AddDefaultInstances | LoadStrategy::Silence);
    bool stored = false;
    if (loaded) {
        StoreParams params;
        params.path = argv[2];
        params.model = &model;
        params.config = &config;
        params.plate_data_list = plates;
        params.project_presets = presets;
        if (argc == 5) for (auto* plate : plates) {
            plate->plate_thumbnail.width = 512;
            plate->plate_thumbnail.height = 512;
            plate->plate_thumbnail.pixels.assign(512 * 512 * 4, 0);
            params.thumbnail_data.push_back(&plate->plate_thumbnail);
        }
        params.strategy = SaveStrategy::ShareMesh | SaveStrategy::Zip64 | SaveStrategy::Silence;
        tbb::task_arena arena(1);
        arena.execute([&] { stored = store_bbs_3mf(params); });
    }
    release_PlateData_list(plates);
    for (auto* preset : presets) delete preset;
    model.remove_backup_path_if_exist();
    if (!stored) {
        std::cerr << "Desktop Orca project round trip failed\n";
        return 1;
    }
    std::cout << "PASS desktop Orca native project round trip\n";
}
