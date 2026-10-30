// AGPL-3.0. Exact 02.08.01 PrintParams ABI from the pinned Orca header.
// Verified against Open Bamboo Networking v2.2.0 (ABI_VERSION=0x020801).
#pragma once
#include <string>
namespace Slic3r {
struct PrintParams {
    /* basic info */
    std::string     dev_id;
    std::string     task_name;
    std::string     project_name;
    std::string     preset_name;
    std::string     filename;
    std::string     config_filename;
    int             plate_index;
    std::string     ftp_folder;
    std::string     ftp_file;
    std::string     ftp_file_md5;
    std::string     nozzle_mapping;
    std::string     ams_mapping;
    std::string     ams_mapping2;
    std::string     ams_mapping_info;
    std::string     nozzles_info;
    std::string     connection_type;
    std::string     comments;
    int             origin_profile_id = 0;
    int             stl_design_id = 0;
    std::string     origin_model_id;
    std::string     print_type;
    std::string     dst_file;
    std::string     dev_name;

    /* access options */
    std::string     dev_ip;
    bool            use_ssl_for_ftp;
    bool            use_ssl_for_mqtt;
    std::string     username;
    std::string     password;

    /*user options */
    bool            task_bed_leveling;      /* bed leveling of task */
    bool            task_flow_cali;         /* flow calibration of task */
    bool            task_vibration_cali;    /* vibration calibration of task */
    bool            task_layer_inspect;     /* first layer inspection of task */
    bool            task_record_timelapse;  /* record timelapse of task */
    bool            task_timelapse_use_internal;
    bool            task_use_ams;
    std::string     task_bed_type;
    std::string     extra_options;
    int             auto_bed_leveling{ 0 };
    int             auto_flow_cali{ 0 };
    int             auto_offset_cali{ 0 };
    int             extruder_cali_manual_mode{ -1 };
    bool            task_ext_change_assist;
    bool            try_emmc_print;
    std::string     svc_context;
    std::string     slicer_uid;
};
}
