import type { PresetDraftKind } from '@slicer/client';

export type PresetEditorFieldAccess = 'editable' | 'read-only';

export interface PresetEditorManifestField {
  readonly key: string;
  readonly access: PresetEditorFieldAccess;
  readonly readOnlyReason?: string;
  /** Render a multiline text control for native script values. */
  readonly multiline?: boolean;
  /** The field must have a native vector-element binding before it is editable. */
  readonly nativeElementOnly?: boolean;
}

export interface PresetEditorManifestGroup {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly PresetEditorManifestField[];
}

export interface PresetEditorManifestPage {
  readonly id: string;
  readonly title: string;
  readonly groups: readonly PresetEditorManifestGroup[];
}

export interface PresetEditorManifest {
  readonly version: 1;
  readonly kind: PresetDraftKind;
  readonly pages: readonly PresetEditorManifestPage[];
}

const editable = (...keys: string[]): PresetEditorManifestField[] =>
  keys.map((key) => ({ key, access: 'editable' }));

const readOnly = (readOnlyReason: string, ...keys: string[]): PresetEditorManifestField[] =>
  keys.map((key) => ({ key, access: 'read-only', readOnlyReason }));

const editableMultiline = (...keys: string[]): PresetEditorManifestField[] =>
  keys.map((key) => ({ key, access: 'editable', multiline: true, nativeElementOnly: true }));

const editableNativeElement = (...keys: string[]): PresetEditorManifestField[] =>
  keys.map((key) => ({ key, access: 'editable', nativeElementOnly: true }));

type ManifestFieldInput = PresetEditorManifestField | readonly PresetEditorManifestField[];

const group = (id: string, title: string, fields: readonly ManifestFieldInput[]): PresetEditorManifestGroup => ({
  id,
  title,
  fields: fields.flatMap((fieldOrGroup) => (
    Array.isArray(fieldOrGroup) ? fieldOrGroup : [fieldOrGroup]
  ) as readonly PresetEditorManifestField[]),
});

/**
 * Explicit transcription of OrcaSlicer's TabFilament::build() at
 * b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde. The manifest is the allow-list
 * and layout source; native option metadata never creates or reorders fields.
 */
export const FILAMENT_PRESET_EDITOR_MANIFEST: PresetEditorManifest = {
  version: 1,
  kind: 'filament',
  pages: [
    {
      id: 'filament',
      title: 'Filament',
      groups: [
        group('basic-information', 'Basic information', [
          editable(
            'filament_type',
            'filament_vendor',
            'filament_soluble',
            'filament_is_support',
            'filament_change_length',
            'required_nozzle_HRC',
            'default_filament_colour',
            'filament_diameter',
            'filament_adhesiveness_category',
            'filament_density',
            'filament_shrink',
            'filament_shrinkage_compensation_z',
            'filament_cost',
            'temperature_vitrification',
            'idle_temperature',
          ),
          readOnly(
            'This value is stored per nozzle and needs a dedicated multi-value editor.',
            'nozzle_temperature_range_low',
            'nozzle_temperature_range_high',
          ),
        ]),
        group('flow-ratio-pressure-advance', 'Flow ratio and Pressure Advance', [
          editable(
            'pellet_flow_coefficient',
            'enable_pressure_advance',
            'pressure_advance',
            'adaptive_pressure_advance',
            'adaptive_pressure_advance_overhangs',
            'adaptive_pressure_advance_bridges',
          ),
          readOnly(
            'The calibration model uses a structured editor.',
            'adaptive_pressure_advance_model',
          ),
          readOnly(
            'Flow ratio is stored per nozzle and needs a dedicated multi-value editor.',
            'filament_flow_ratio',
          ),
        ]),
        group('print-chamber-temperature', 'Print chamber temperature', [
          editable('activate_chamber_temp_control', 'chamber_temperature', 'chamber_minimal_temperature'),
        ]),
        group('print-temperature', 'Print temperature', [
          readOnly(
            'Nozzle temperatures are stored per nozzle and need a dedicated multi-value editor.',
            'nozzle_temperature_initial_layer',
            'nozzle_temperature',
          ),
        ]),
        group('bed-temperature', 'Bed temperature', [
          editable(
            'supertack_plate_temp_initial_layer',
            'supertack_plate_temp',
            'cool_plate_temp_initial_layer',
            'cool_plate_temp',
            'textured_cool_plate_temp_initial_layer',
            'textured_cool_plate_temp',
            'eng_plate_temp_initial_layer',
            'eng_plate_temp',
            'hot_plate_temp_initial_layer',
            'hot_plate_temp',
            'textured_plate_temp_initial_layer',
            'textured_plate_temp',
          ),
        ]),
        group('volumetric-speed-limitation', 'Volumetric speed limitation', [
          editable('filament_adaptive_volumetric_speed', 'filament_max_volumetric_speed'),
        ]),
      ],
    },
    {
      id: 'cooling',
      title: 'Cooling',
      groups: [
        group('cooling-specific-layer', 'Cooling for specific layer', [
          editable('close_fan_the_first_x_layers', 'initial_layer_fan_speed', 'full_fan_speed_layer'),
        ]),
        group('part-cooling-fan', 'Part cooling fan', [
          editable(
            'fan_min_speed',
            'fan_cooling_layer_time',
            'fan_max_speed',
            'slow_down_layer_time',
            'reduce_fan_stop_start_freq',
            'slow_down_for_layer_cooling',
            'dont_slow_down_outer_wall',
            'slow_down_min_speed',
            'enable_overhang_bridge_fan',
            'overhang_fan_threshold',
            'overhang_fan_speed',
            'internal_bridge_fan_speed',
            'support_material_interface_fan_speed',
            'ironing_fan_speed',
          ),
        ]),
        group('auxiliary-part-cooling-fan', 'Auxiliary part cooling fan', [
          editable('additional_cooling_fan_speed'),
        ]),
        group('exhaust-fan', 'Exhaust fan', [
          editable(
            'activate_air_filtration',
            'activate_air_filtration_during_print',
            'during_print_exhaust_fan_speed',
            'activate_air_filtration_on_completion',
            'complete_print_exhaust_fan_speed',
          ),
        ]),
      ],
    },
    {
      id: 'setting-overrides',
      title: 'Setting Overrides',
      groups: [
        group('retraction-overrides', 'Retraction', [
          readOnly(
            'This setting is an indexed override that requires the dedicated Orca override control.',
            'filament_retraction_length',
            'filament_z_hop',
            'filament_z_hop_types',
            'filament_retract_lift_above',
            'filament_retract_lift_below',
            'filament_retract_lift_enforce',
            'filament_retraction_speed',
            'filament_deretraction_speed',
            'filament_retract_restart_extra',
            'filament_retraction_minimum_travel',
            'filament_retract_when_changing_layer',
            'filament_wipe',
            'filament_wipe_distance',
            'filament_retract_before_wipe',
            'filament_retract_after_wipe',
            'filament_long_retractions_when_cut',
            'filament_retraction_distances_when_cut',
          ),
        ]),
        group('retraction-material-change-overrides', 'Retraction when switching material', [
          readOnly(
            'This setting is an indexed override that requires the dedicated Orca override control.',
            'filament_retract_length_toolchange',
            'filament_retract_restart_extra_toolchange',
          ),
        ]),
        group('ironing-overrides', 'Ironing', [
          readOnly(
            'This setting is an indexed override that requires the dedicated Orca override control.',
            'filament_ironing_flow',
            'filament_ironing_spacing',
            'filament_ironing_inset',
            'filament_ironing_speed',
          ),
        ]),
      ],
    },
    {
      id: 'advanced',
      title: 'Advanced',
      groups: [
        group('filament-start-gcode', 'Filament start G-code', [
          editableMultiline('filament_start_gcode'),
        ]),
        group('change-extrusion-role-gcode', 'Change extrusion role G-code', [
          editableMultiline('filament_change_extrusion_role_gcode'),
        ]),
        group('filament-end-gcode', 'Filament end G-code', [
          editableMultiline('filament_end_gcode'),
        ]),
        group('plugin-configuration', 'Plugin Configuration', [
          readOnly('Plugin configuration is a structured value.', 'filament_plugin_config_overrides'),
        ]),
      ],
    },
    {
      id: 'multimaterial',
      title: 'Multimaterial',
      groups: [
        group('wipe-tower-parameters', 'Wipe tower parameters', [
          editable(
            'filament_minimal_purge_on_wipe_tower',
            'filament_tower_interface_pre_extrusion_dist',
            'filament_tower_interface_pre_extrusion_length',
            'filament_tower_ironing_area',
            'filament_tower_interface_purge_volume',
            'filament_tower_interface_print_temp',
          ),
        ]),
        group('multi-filament', 'Multi Filament', [
          readOnly(
            'This value contains per-extruder vectors and needs a dedicated editor.',
            'long_retractions_when_ec',
            'retraction_distances_when_ec',
          ),
        ]),
        group('single-extruder-tool-change', 'Tool change parameters with single extruder MM printers', [
          editable(
            'filament_loading_speed_start',
            'filament_loading_speed',
            'filament_unloading_speed_start',
            'filament_unloading_speed',
            'filament_toolchange_delay',
            'filament_cooling_moves',
            'filament_cooling_initial_speed',
            'filament_cooling_final_speed',
            'filament_stamping_loading_speed',
            'filament_stamping_distance',
          ),
          readOnly('Ramming parameters use a dedicated dialog.', 'filament_ramming_parameters'),
        ]),
        group('multi-extruder-tool-change', 'Tool change parameters with multi extruder MM printers', [
          readOnly(
            'Multi-tool ramming uses a specialized structured control.',
            'filament_multitool_ramming',
            'filament_multitool_ramming_volume',
            'filament_multitool_ramming_flow',
          ),
        ]),
      ],
    },
    {
      id: 'dependencies',
      title: 'Dependencies',
      groups: [
        group('compatible-printers', 'Compatible printers', [
          readOnly('Printer compatibility uses a dedicated list editor.', 'compatible_printers'),
          editable('compatible_printers_condition'),
        ]),
        group('compatible-process-profiles', 'Compatible process profiles', [
          readOnly('Process compatibility uses a dedicated list editor.', 'compatible_prints'),
          editable('compatible_prints_condition'),
        ]),
      ],
    },
    {
      id: 'notes',
      title: 'Notes',
      groups: [group('notes', 'Notes', editableNativeElement('filament_notes'))],
    },
  ],
};

/**
 * Explicit transcription of the FFF pages built by OrcaSlicer's
 * TabPrinter::build() at b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde.
 * Printer extruder settings stay read-only because their values are indexed
 * vectors and the phase-one editor has no per-extruder control.
 */
export const PRINTER_PRESET_EDITOR_MANIFEST: PresetEditorManifest = {
  version: 1,
  kind: 'printer',
  pages: [
    {
      id: 'basic-information',
      title: 'Basic information',
      groups: [
        group('identity', 'Identity', [
          readOnly(
            'Printer technology and source model metadata identify this preset and require a dedicated native transition.',
            'printer_technology',
            'printer_model',
            'printer_variant',
          ),
        ]),
        group('printable-space', 'Printable space', [
          readOnly(
            'The printable bed shape uses a dedicated geometry editor.',
            'printable_area',
          ),
          readOnly(
            'This value affects machine topology.',
            'parallel_printheads_count',
          ),
          readOnly('The excluded-bed area uses a structured geometry editor.', 'bed_exclude_area'),
          editable('printable_height', 'support_multi_bed_types'),
          readOnly('Best object position uses a dedicated coordinate editor.', 'best_object_pos'),
          editable('z_offset'),
          readOnly('Preferred orientation uses a dedicated orientation control.', 'preferred_orientation'),
        ]),
        group('advanced', 'Advanced', [
          editable(
            'gcode_flavor',
            'gcode_skip_config_block',
            'pellet_modded_printer',
            'bbl_use_printhost',
            'use_3mf',
            'scan_first_layer',
            'enable_power_loss_recovery',
            'disable_m73',
            'use_relative_e_distances',
            'use_firmware_retraction',
            'time_cost',
          ),
          readOnly(
            'Printer structure describes machine geometry and is structural preset state.',
            'printer_structure',
          ),
          readOnly('Printer Agent is selected from the live network-agent registry.', 'printer_agent'),
          readOnly('Thumbnails use a structured format editor.', 'thumbnails'),
        ]),
        group('plugin-configuration', 'Plugin Configuration', [
          readOnly('Plugin configuration is a structured value.', 'printer_plugin_config_overrides'),
        ]),
        group('cooling-fan', 'Cooling Fan', [
          editable('fan_speedup_time', 'fan_speedup_overhangs', 'fan_kickstart', 'part_cooling_fan_min_pwm'),
        ]),
        group('extruder-clearance', 'Extruder Clearance', [
          editable('extruder_clearance_radius', 'extruder_clearance_height_to_rod', 'extruder_clearance_height_to_lid'),
        ]),
        group('adaptive-bed-mesh', 'Adaptive bed mesh', [
          readOnly('Bed mesh bounds use a structured coordinate editor.', 'bed_mesh_min', 'bed_mesh_max'),
          editable('bed_mesh_probe_distance', 'adaptive_bed_mesh_margin'),
        ]),
        group('accessory', 'Accessory', [
          editable(
            'nozzle_type',
            'nozzle_hrc',
            'auxiliary_fan',
            'fan_direction',
            'support_chamber_temp_control',
            'support_air_filtration',
            'cooling_filter_enabled',
          ),
        ]),
      ],
    },
    {
      id: 'machine-gcode',
      title: 'Machine G-code',
      groups: [
        group('file-header-gcode', 'File header G-code', [
          readOnly('Custom G-code uses a dedicated editor.', 'file_start_gcode'),
        ]),
        group('machine-start-gcode', 'Machine start G-code', [
          readOnly('Custom G-code uses a dedicated editor.', 'machine_start_gcode'),
        ]),
        group('machine-end-gcode', 'Machine end G-code', [
          readOnly('Custom G-code uses a dedicated editor.', 'machine_end_gcode'),
        ]),
        group('printing-by-object-gcode', 'Printing by object G-code', [
          readOnly('Custom G-code uses a dedicated editor.', 'printing_by_object_gcode'),
        ]),
        group('before-layer-change-gcode', 'Before layer change G-code', [
          readOnly('Custom G-code uses a dedicated editor.', 'before_layer_change_gcode'),
        ]),
        group('layer-change-gcode', 'Layer change G-code', [
          readOnly('Custom G-code uses a dedicated editor.', 'layer_change_gcode'),
        ]),
        group('timelapse-gcode', 'Timelapse G-code', [
          readOnly('Custom G-code uses a dedicated editor.', 'time_lapse_gcode'),
        ]),
        group('clumping-detection-gcode', 'Clumping Detection G-code', [
          readOnly('Custom G-code uses a dedicated editor.', 'wrapping_detection_gcode'),
        ]),
        group('change-filament-gcode', 'Change filament G-code', [
          readOnly('Custom G-code uses a dedicated editor.', 'change_filament_gcode'),
        ]),
        group('change-extrusion-role-gcode', 'Change extrusion role G-code', [
          readOnly('Custom G-code uses a dedicated editor.', 'change_extrusion_role_gcode'),
        ]),
        group('pause-gcode', 'Pause G-code', [
          readOnly('Custom G-code uses a dedicated editor.', 'machine_pause_gcode'),
        ]),
        group('template-custom-gcode', 'Template Custom G-code', [
          readOnly('Custom G-code uses a dedicated editor.', 'template_custom_gcode'),
        ]),
      ],
    },
    {
      id: 'motion-ability',
      title: 'Motion ability',
      groups: [
        group('advanced', 'Advanced', editable('emit_machine_limits_to_gcode')),
        group('resonance-compensation', 'Resonance Compensation', [
          editable(
            'resonance_avoidance',
            'min_resonance_avoidance_speed',
            'max_resonance_avoidance_speed',
            'input_shaping_emit',
            'input_shaping_type',
            'input_shaping_freq_x',
            'input_shaping_freq_y',
            'input_shaping_damp_x',
            'input_shaping_damp_y',
          ),
        ]),
        group('speed-limitation', 'Speed limitation', editable(
          'machine_max_speed_x', 'machine_max_speed_y', 'machine_max_speed_z', 'machine_max_speed_e',
        )),
        group('acceleration-limitation', 'Acceleration limitation', editable(
          'machine_max_acceleration_x',
          'machine_max_acceleration_y',
          'machine_max_acceleration_z',
          'machine_max_acceleration_e',
          'machine_max_acceleration_extruding',
          'machine_max_acceleration_retracting',
          'machine_max_acceleration_travel',
        )),
        group('jerk-limitation', 'Jerk limitation', editable(
          'machine_max_junction_deviation',
          'machine_max_jerk_x',
          'machine_max_jerk_y',
          'machine_max_jerk_z',
          'machine_max_jerk_e',
        )),
      ],
    },
    {
      id: 'multimaterial',
      title: 'Multimaterial',
      groups: [
        group('single-extruder-multimaterial-setup', 'Single extruder multi-material setup', [
          readOnly(
            'These fields change the Printer capability topology and require a dedicated native transition.',
            'single_extruder_multi_material',
            'extruders_count',
          ),
          editable('manual_filament_change', 'bed_temperature_formula'),
        ]),
        group('wipe-tower', 'Wipe tower', editable(
          'wipe_tower_type',
          'purge_in_prime_tower',
          'enable_filament_ramming',
          'tool_change_on_wipe_tower',
        )),
        group('single-extruder-multimaterial-parameters', 'Single extruder multi-material parameters', editable(
          'cooling_tube_retraction',
          'cooling_tube_length',
          'parking_pos_retraction',
          'extra_loading_move',
          'high_current_on_filament_swap',
        )),
        group('advanced', 'Advanced', editable(
          'machine_load_filament_time',
          'machine_unload_filament_time',
          'machine_tool_change_time',
        )),
        group('material-defaults', 'Material defaults', [
          readOnly(
            'Default material profiles are source identity and require a dedicated native transition.',
            'default_filament_profile',
          ),
        ]),
      ],
    },
    {
      id: 'extruder',
      title: 'Extruder',
      groups: [
        group('basic-information', 'Basic information', [
          readOnly(
            'Per-extruder values require a dedicated indexed control.',
            'nozzle_diameter',
            'nozzle_volume',
            'extruder_printable_height',
            'extruder_printable_area',
          ),
        ]),
        group('layer-height-limits', 'Layer height limits', [
          readOnly('Per-extruder values require a dedicated indexed control.', 'min_layer_height', 'max_layer_height'),
        ]),
        group('position', 'Position', [
          readOnly('Per-extruder offsets require a dedicated coordinate control.', 'extruder_offset'),
        ]),
        group('retraction', 'Retraction', [
          readOnly(
            'Per-extruder values require a dedicated indexed control.',
            'retraction_length',
            'retract_restart_extra',
            'retraction_speed',
            'deretraction_speed',
            'retraction_minimum_travel',
            'retract_when_changing_layer',
            'wipe',
            'wipe_distance',
            'retract_before_wipe',
            'retract_after_wipe',
          ),
        ]),
        group('z-hop', 'Z-Hop', [
          readOnly(
            'Per-extruder values require a dedicated indexed control.',
            'retract_lift_enforce',
            'z_hop_types',
            'z_hop',
            'travel_slope',
            'retract_lift_above',
            'retract_lift_below',
          ),
        ]),
        group('retraction-material-change', 'Retraction when switching material', [
          readOnly(
            'Per-extruder values require a dedicated indexed control.',
            'retract_length_toolchange',
            'retract_restart_extra_toolchange',
            'long_retractions_when_cut',
            'retraction_distances_when_cut',
          ),
        ]),
      ],
    },
    {
      id: 'notes',
      title: 'Notes',
      groups: [group('notes', 'Notes', editable('printer_notes'))],
    },
  ],
};

export function presetEditorFields(manifest: PresetEditorManifest): readonly PresetEditorManifestField[] {
  return manifest.pages.flatMap((page) => page.groups.flatMap((optionGroup) => optionGroup.fields));
}
