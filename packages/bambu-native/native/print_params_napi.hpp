#pragma once
#include <napi.h>
#include "print_params.hpp"
#include <cmath>
#include <limits>
inline Slic3r::PrintParams read_print_params(const Napi::Object& object) {
    Slic3r::PrintParams params{};
    const auto env = object.Env();
#define STRING(key) if (object.Has(#key)) { auto v = object.Get(#key); if (!v.IsString()) throw Napi::TypeError::New(env, "Invalid print string"); params.key = v.As<Napi::String>().Utf8Value(); }
#define BOOLEAN(key) if (object.Has(#key)) { auto v = object.Get(#key); if (!v.IsBoolean()) throw Napi::TypeError::New(env, "Invalid print boolean"); params.key = v.As<Napi::Boolean>().Value(); }
#define INTEGER(key) if (object.Has(#key)) { auto v = object.Get(#key); if (!v.IsNumber()) throw Napi::TypeError::New(env, "Invalid print integer"); double n = v.As<Napi::Number>().DoubleValue(); if (!std::isfinite(n) || std::trunc(n) != n || n < std::numeric_limits<int>::min() || n > std::numeric_limits<int>::max()) throw Napi::TypeError::New(env, "Invalid print integer"); params.key = static_cast<int>(n); }
    STRING(dev_id)
    STRING(task_name)
    STRING(project_name)
    STRING(preset_name)
    STRING(filename)
    STRING(config_filename)
    STRING(ftp_folder)
    STRING(ftp_file)
    STRING(ftp_file_md5)
    STRING(nozzle_mapping)
    STRING(ams_mapping)
    STRING(ams_mapping2)
    STRING(ams_mapping_info)
    STRING(nozzles_info)
    STRING(connection_type)
    STRING(comments)
    STRING(origin_model_id)
    STRING(print_type)
    STRING(dst_file)
    STRING(dev_name)
    STRING(dev_ip)
    STRING(username)
    STRING(password)
    STRING(task_bed_type)
    STRING(extra_options)
    STRING(svc_context)
    STRING(slicer_uid)
    BOOLEAN(use_ssl_for_ftp)
    BOOLEAN(use_ssl_for_mqtt)
    BOOLEAN(task_bed_leveling)
    BOOLEAN(task_flow_cali)
    BOOLEAN(task_vibration_cali)
    BOOLEAN(task_layer_inspect)
    BOOLEAN(task_record_timelapse)
    BOOLEAN(task_timelapse_use_internal)
    BOOLEAN(task_use_ams)
    BOOLEAN(task_ext_change_assist)
    BOOLEAN(try_emmc_print)
    INTEGER(plate_index)
    INTEGER(origin_profile_id)
    INTEGER(stl_design_id)
    INTEGER(auto_bed_leveling)
    INTEGER(auto_flow_cali)
    INTEGER(auto_offset_cali)
    INTEGER(extruder_cali_manual_mode)
#undef STRING
#undef BOOLEAN
#undef INTEGER
    if (params.dev_id.empty() || params.filename.empty() || params.plate_index < 1)
        throw Napi::TypeError::New(env, "Missing print identity or artifact");
    return params;
}
