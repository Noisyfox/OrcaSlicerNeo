#include "libslic3r/PresetBundle.hpp"

#include <stdexcept>
#include <iostream>
#include "libslic3r/AppConfig.hpp"
#include "libslic3r/Utils.hpp"
#include <boost/filesystem.hpp>

namespace {
void verify_vendor_config()
{
    using Slic3r::PresetBundle;
    using Slic3r::VendorProfile;
    using Vendors = std::map<std::string, std::map<std::string, std::set<std::string>>>;
    using Filaments = std::map<std::string, std::string>;
    Slic3r::set_data_dir("/tmp/vendor-config-native");
    Slic3r::set_resources_dir("/missing-vendor-resources");
    boost::filesystem::create_directories(Slic3r::data_dir());
    PresetBundle bundle;
    bundle.vendors.emplace("A", VendorProfile("A"));
    bundle.vendors.at("A").default_filaments = {"Generic PLA vendor override"};
    bundle.vendors.emplace("B", VendorProfile("B"));
    bundle.vendors.at("B").default_filaments = {"Only B"};
    const auto metadata_before = bundle.vendors.at("A").default_filaments;
    const Vendors selected_a = {{"A", {{"printer", {"0.4"}}}}};
    auto check = [&](const char* label, const Vendors& selected, const Filaments& input, const Filaments& expected) {
        PresetBundle candidate;
        candidate.setup_directories();
        candidate.vendors = bundle.vendors; // Metadata only; no existing collection pointers.
        Slic3r::AppConfig config;
        config.set_section(Slic3r::AppConfig::SECTION_FILAMENTS, {{"Old filament", "true"}});
        config.set_vendors({{"Old vendor", {{"old", {"0.4"}}}}});
        if (!candidate.apply_vendor_config(selected, input, &config, true))
            throw std::runtime_error("Neo attempted installation from missing resources");
        if (config.get_section(Slic3r::AppConfig::SECTION_FILAMENTS) != expected || config.vendors() != selected)
            throw std::runtime_error(label);
        if (candidate.printers.size() != 1 || !candidate.printers.get_selected_preset().is_default)
            throw std::runtime_error("metadata-only seed activated old source collections");
        if (boost::filesystem::exists(boost::filesystem::path(Slic3r::data_dir()) / "system/A.json"))
            throw std::runtime_error("Neo copied vendor resources");
        if (config.get("presets", PRESET_PRINTER_NAME) != candidate.printers.get_selected_preset_name())
            throw std::runtime_error("native selection export missing");
    };
    check("substring replacement preserves values and exact suffix", selected_a,
          {{"Generic PLA @System", "false"}, {"Generic PLA@System", "one"}, {"Generic PLA @System extra", "two"}, {" @System", "three"}},
          {{"Generic PLA", "false"}, {"Generic PLA@System", "one"}, {"Generic PLA @System extra", "two"}, {" @System", "three"}});
    check("no match stays unchanged", selected_a, {{"Unmatched @System", "true"}}, {{"Unmatched @System", "true"}});
    check("Custom only has no non-Custom printer", {{"Custom", {{"custom", {"0.4"}}}}},
          {{"Generic PLA @System", "true"}}, {{"Generic PLA @System", "true"}});
    check("empty non-Custom models do not trigger replacement", {{"A", {}}},
          {{"Generic PLA @System", "true"}}, {{"Generic PLA @System", "true"}});
    auto custom_and_a = selected_a;
    custom_and_a["Custom"] = {{"custom", {"0.4"}}};
    check("enabled Custom retains both names", custom_and_a, {{"Generic PLA @System", "enabled"}},
          {{"Generic PLA", "enabled"}, {"Generic PLA @System", "enabled"}});
    auto both = selected_a;
    both["B"] = {{"printer", {"0.4"}}};
    check("first loaded vendor stops search even without match", both, {{"Only B @System", "true"}}, {{"Only B @System", "true"}});
    auto a_unloaded = both;
    a_unloaded["0-Unloaded"] = {{"printer", {"0.4"}}};
    check("unloaded vendors are skipped before first loaded match", a_unloaded,
          {{"Generic PLA @System", "true"}}, {{"Generic PLA", "true"}});
    check("target vendor not already loaded stays unchanged", {{"NewVendor", {{"printer", {"0.4"}}}}},
          {{"Generic PLA @System", "true"}}, {{"Generic PLA @System", "true"}});
    bundle.vendors.at("A").default_filaments.clear();
    check("JSON-style empty metadata does not match model materials", selected_a,
          {{"Generic PLA @System", "true"}}, {{"Generic PLA @System", "true"}});
    bundle.vendors.at("A").default_filaments = metadata_before;
    check("repeat uses same metadata without mutation", selected_a,
          {{"Generic PLA @System", "true"}}, {{"Generic PLA", "true"}});
    if (bundle.vendors.at("A").default_filaments != metadata_before)
        throw std::runtime_error("normalization mutated metadata");
    // Exercise the complete API against the compact production JSON fixtures.
    Slic3r::set_data_dir("/");
    PresetBundle initial;
    initial.setup_directories();
    Slic3r::AppConfig initial_config;
    const Vendors actual = {{"CompatibilityFixture", {{"Compatibility Alpha", {"0.4"}}}}};
    initial_config.set_vendors(actual);
    initial_config.set_section(Slic3r::AppConfig::SECTION_FILAMENTS, {{"Alpha Explicit Filament", "true"}});
    initial.load_presets(initial_config, Slic3r::ForwardCompatibilitySubstitutionRule::Enable);
    auto apply_actual = [&](const Filaments& input) {
        PresetBundle candidate;
        candidate.vendors = initial.vendors;
        Slic3r::AppConfig config;
        config.set("presets", PRESET_PRINTER_NAME, "Compatibility Alpha 0.4 nozzle");
        if (!candidate.apply_vendor_config(actual, input, &config, true))
            throw std::runtime_error("fixture application failed");
        if (candidate.printers.get_selected_preset_name() != "Compatibility Alpha 0.4 nozzle")
            throw std::runtime_error("current Printer was not retained");
        if (config.get_printer_setting(candidate.printers.get_selected_preset_name(), PRESET_FILAMENT_NAME) != candidate.filament_presets.front())
            throw std::runtime_error("first material was not exported");
        return std::make_pair(candidate.filament_presets.front(), config.get_section(Slic3r::AppConfig::SECTION_FILAMENTS));
    };
    const auto chosen = apply_actual({{"Alpha Explicit Filament", "true"}});
    if (chosen.first != "Alpha Explicit Filament") throw std::runtime_error("compatible input first material was not honored");
    const auto empty = apply_actual({});
    if (!empty.second.count("Alpha Explicit Filament") || empty.first != "Alpha Explicit Filament")
        throw std::runtime_error("empty activation default supplementation failed");
    const auto stale = apply_actual({{"Retired Filament", "true"}});
    if (!stale.second.count("Retired Filament") || !stale.second.count("Alpha Explicit Filament"))
        throw std::runtime_error("stale input/default supplementation lost activation");
    if (stale.first != "Alpha Explicit Filament")
        throw std::runtime_error("stale-only correction did not retain native supplemented fallback");
    Slic3r::AppConfig merged;
    merged.set_vendors(actual);
    merged.set_section(Slic3r::AppConfig::SECTION_FILAMENTS, {{"Alpha Explicit Filament", "true"}});
    merged.set("presets", PRESET_PRINTER_NAME, "Compatibility Alpha 0.4 nozzle");
    merged.set_printer_setting("Compatibility Alpha 0.4 nozzle", PRESET_FILAMENT_NAME, "Alpha Explicit Filament");
    auto direct_config = merged;
    direct_config.set(Slic3r::AppConfig::SECTION_FILAMENTS, "Z Chosen Filament", "true");
    PresetBundle direct;
    direct.load_presets(direct_config, Slic3r::ForwardCompatibilitySubstitutionRule::Enable);
    if (direct.filament_presets.front() != "Alpha Explicit Filament")
        throw std::runtime_error("fixture did not preserve the prior compatible first material");
    PresetBundle corrected;
    corrected.vendors = initial.vendors;
    if (!corrected.apply_vendor_config(actual, {{"Z Chosen Filament", "true"}}, &merged, false))
        throw std::runtime_error("merge application failed");
    if (corrected.filament_presets.front() != "Z Chosen Filament" ||
        merged.get_printer_setting("Compatibility Alpha 0.4 nozzle", PRESET_FILAMENT_NAME) != "Z Chosen Filament" ||
        !merged.get_section(Slic3r::AppConfig::SECTION_FILAMENTS).count("Alpha Explicit Filament"))
        throw std::runtime_error("first-material correction must follow the new input map, not the expanded activation: " +
            corrected.filament_presets.front() + " / " + merged.get_printer_setting("Compatibility Alpha 0.4 nozzle", PRESET_FILAMENT_NAME));


}
}

int main()
{
    try {
        verify_vendor_config();
        std::cout << "vendor config native API PASS (14 cases, first-material correction/overwrite/export/install gate/absent-library metadata)\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
