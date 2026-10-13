#include "libslic3r/PresetBundle.hpp"
#include <cstdlib>
#include <iostream>

#define CHECK(value) do { if (!(value)) { std::cerr << "failed: " #value << " at " << __LINE__ << '\n'; return EXIT_FAILURE; } } while (false)

int main()
{
    Slic3r::PresetBundle bundle;
    auto& presets = bundle.prints;
    const auto config = presets.default_preset().config;
    presets.load_preset("", "A snapshot", config, false).is_external = true;
    presets.load_preset("", "Z current", config, true).is_external = true;
    auto& edited = presets.get_edited_preset();
    edited.config.set_key_value("layer_height", new Slic3r::ConfigOptionFloat(0.37));
    edited.neo_vector_overrides["test"] = "1";
    edited.is_dirty = true;
    const auto selected_index = presets.get_selected_idx();
    const auto overrides = edited.neo_vector_overrides;
    const auto saved_dirty = presets.saved_is_dirty();
    CHECK(presets.erase_runtime_preset("A snapshot"));
    CHECK(presets.find_preset("A snapshot", false, true) == nullptr);
    CHECK(presets.get_selected_idx() == selected_index - 1);
    CHECK(presets.get_selected_preset_name() == "Z current");
    CHECK(presets.get_edited_preset().config.option("layer_height")->serialize() == "0.37");
    CHECK(presets.get_edited_preset().neo_vector_overrides == overrides);
    CHECK(presets.get_edited_preset().is_dirty);
    CHECK(presets.saved_is_dirty() == saved_dirty);
    CHECK(!presets.erase_runtime_preset("Z current"));
    CHECK(!presets.erase_runtime_preset("missing"));
    CHECK(!presets.erase_runtime_preset(presets.default_preset().name));
    presets.load_preset("", "Normal", config, false).is_external = false;
    CHECK(!presets.erase_runtime_preset("Normal"));
    auto& file = presets.load_preset("", "File backed", config, false);
    file.is_external = true;
    file.file = "/must-not-delete.json";
    CHECK(!presets.erase_runtime_preset("File backed"));
    presets.load_preset("", "ZZ snapshot", config, false).is_external = true;
    const auto index_before_tail_erase = presets.get_selected_idx();
    CHECK(presets.erase_runtime_preset("ZZ snapshot"));
    CHECK(presets.get_selected_idx() == index_before_tail_erase);
    CHECK(presets.get_selected_preset_name() == "Z current");
    CHECK(presets.get_edited_preset().config.option("layer_height")->serialize() == "0.37");
    std::cout << "PresetRuntimeErase tests passed\n";
    return EXIT_SUCCESS;
}
