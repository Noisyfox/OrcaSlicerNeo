import type { ConfigurationMode, ScopedConfigurationField } from './scopedConfigurationProjection';

interface PrintSettingsGroup {
  readonly title: string;
  readonly keys: readonly string[];
  /** Native compound option lines rendered as sections of scalar controls. */
  readonly sections?: readonly { title: string; keys: readonly string[] }[];
}

interface PrintSettingsPage {
  readonly title: string;
  readonly groups: readonly PrintSettingsGroup[];
}

/** Explicit UI allow-list transcribed from TabPrint::build() at pinned Orca
 * 9d3118b7a406a4e44d5344ae69c084f01d72e772. Metadata supplies option
 * definitions and eligibility, never additional pages or fields. */
export const PRINT_SETTINGS_PAGES: readonly PrintSettingsPage[] = [
  { title: "Quality", groups: [
    { title: "Layer height", keys: ["layer_height", "initial_layer_print_height", "enable_mixed_color_sublayer"] },
    { title: "Line width", keys: ["line_width", "initial_layer_line_width", "outer_wall_line_width", "inner_wall_line_width", "top_surface_line_width", "sparse_infill_line_width", "internal_solid_infill_line_width", "support_line_width", "bridge_line_width"] },
    { title: "Seam", keys: ["seam_position", "staggered_inner_seams", "seam_gap", "seam_slope_type", "seam_slope_conditional", "scarf_angle_threshold", "scarf_overhang_threshold", "scarf_joint_speed", "seam_slope_start_height", "seam_slope_entire_loop", "seam_slope_min_length", "seam_slope_steps", "scarf_joint_flow_ratio", "seam_slope_inner_walls", "role_based_wipe_speed", "wipe_speed", "wipe_on_loops", "wipe_inward", "wipe_inward_distance", "wipe_before_external_loop"] },
    { title: "Precision", keys: ["slice_closing_radius", "resolution", "enable_arc_fitting", "xy_hole_compensation", "xy_contour_compensation", "elefant_foot_compensation", "elefant_foot_layers_density", "elefant_foot_compensation_layers", "precise_outer_wall", "precise_z_height", "hole_to_polyhole", "hole_to_polyhole_threshold", "hole_to_polyhole_twisted", "hole_to_polyhole_max_edges"] },
    { title: "Ironing", keys: ["ironing_type", "ironing_pattern", "ironing_flow", "ironing_spacing", "ironing_inset", "ironing_angle", "ironing_angle_fixed"] },
    { title: "Z contouring", keys: ["zaa_enabled", "zaa_minimize_perimeter_height", "zaa_min_z", "zaa_dont_alternate_fill_direction"] },
    { title: "Wall generator", keys: ["wall_generator", "wall_transition_angle", "wall_transition_filter_deviation", "wall_transition_length", "wall_distribution_count", "initial_layer_min_bead_width", "min_bead_width", "min_feature_size", "min_length_factor", "wall_maximum_resolution", "wall_maximum_deviation"] },
    { title: "Walls and surfaces", keys: ["wall_sequence", "is_infill_first", "wall_direction", "print_flow_ratio", "top_solid_infill_flow_ratio", "bottom_solid_infill_flow_ratio", "set_other_flow_ratios", "first_layer_flow_ratio", "outer_wall_flow_ratio", "inner_wall_flow_ratio", "overhang_flow_ratio", "sparse_infill_flow_ratio", "internal_solid_infill_flow_ratio", "gap_fill_flow_ratio", "support_flow_ratio", "support_interface_flow_ratio", "only_one_wall_first_layer", "only_one_wall_top", "min_width_top_surface", "reduce_crossing_wall", "max_travel_detour_distance", "small_area_infill_flow_compensation", "small_area_infill_flow_compensation_model"] },
    { title: "Bridging", keys: ["bridge_flow", "internal_bridge_flow", "bridge_density", "internal_bridge_density", "thick_bridges", "thick_internal_bridges", "enable_extra_bridge_layer", "dont_filter_internal_bridges", "counterbore_hole_bridging"] },
    { title: "Overhangs", keys: ["detect_overhang_wall", "unsupported_wall_last", "make_overhang_printable", "make_overhang_printable_angle", "make_overhang_printable_hole_size", "extra_perimeters_on_overhangs", "overhang_reverse", "overhang_reverse_internal_only", "overhang_reverse_threshold"] },
  ] },
  { title: "Strength", groups: [
    { title: "Walls", keys: ["wall_loops", "alternate_extra_wall", "detect_thin_wall"] },
    { title: "Top/bottom shells", keys: ["top_shell_layers", "top_shell_thickness", "top_surface_density", "top_surface_pattern", "top_surface_fill_order", "top_layer_direction", "top_surface_expansion", "top_surface_expansion_margin", "top_surface_expansion_direction", "bottom_shell_layers", "bottom_shell_thickness", "bottom_surface_density", "bottom_surface_pattern", "bottom_surface_fill_order", "bottom_layer_direction", "center_of_surface_pattern", "top_bottom_infill_wall_overlap"] },
    { title: "Infill", keys: ["sparse_infill_density", "fill_multiline", "sparse_infill_pattern", "gyroid_optimized", "sparse_infill_smooth_factor", "infill_direction", "sparse_infill_rotate_template", "skin_infill_density", "skeleton_infill_density", "infill_lock_depth", "skin_infill_depth", "skin_infill_line_width", "skeleton_infill_line_width", "symmetric_infill_y_axis", "infill_shift_step", "lateral_lattice_angle_1", "lateral_lattice_angle_2", "infill_overhang_angle", "lightning_overhang_angle", "lightning_prune_angle", "lightning_straightening_angle", "infill_anchor_max", "infill_anchor", "internal_solid_infill_pattern", "solid_infill_direction", "solid_infill_rotate_template", "gap_fill_target", "filter_out_gap_fill", "separated_infills", "infill_wall_overlap"] },
    { title: "Advanced", keys: ["align_infill_direction_to_model", "extra_solid_infills", "bridge_angle", "internal_bridge_angle", "relative_bridge_angle", "minimum_sparse_infill_area", "infill_combination", "infill_combination_max_layer_height", "detect_narrow_internal_solid_infill", "ensure_vertical_shell_thickness"] },
  ] },
  { title: "Speed", groups: [
    { title: "First layer speed", keys: ["initial_layer_speed", "initial_layer_infill_speed", "initial_layer_travel_speed", "slow_down_layers"] },
    { title: "Other layers speed", keys: ["outer_wall_speed", "inner_wall_speed", "small_perimeter_speed", "small_perimeter_threshold", "sparse_infill_speed", "internal_solid_infill_speed", "top_surface_speed", "gap_infill_speed", "ironing_speed", "support_speed", "support_interface_speed", "small_support_perimeter_speed", "small_support_perimeter_threshold"] },
    { title: "Overhang speed", keys: ["enable_overhang_speed", "slowdown_for_curled_perimeters", "overhang_1_4_speed", "overhang_2_4_speed", "overhang_3_4_speed", "overhang_4_4_speed", "bridge_speed", "internal_bridge_speed"], sections: [
      { title: "Overhang speed", keys: ["overhang_1_4_speed", "overhang_2_4_speed", "overhang_3_4_speed", "overhang_4_4_speed"] },
      { title: "Bridge", keys: ["bridge_speed", "internal_bridge_speed"] },
    ] },
    { title: "Travel speed", keys: ["travel_speed"] },
    { title: "Acceleration", keys: ["default_acceleration", "outer_wall_acceleration", "inner_wall_acceleration", "bridge_acceleration", "sparse_infill_acceleration", "internal_solid_infill_acceleration", "initial_layer_acceleration", "initial_layer_travel_acceleration", "top_surface_acceleration", "travel_acceleration", "accel_to_decel_enable", "accel_to_decel_factor"] },
    { title: "Junction Deviation", keys: ["default_junction_deviation"] },
    { title: "Jerk(XY)", keys: ["default_jerk", "outer_wall_jerk", "inner_wall_jerk", "infill_jerk", "top_surface_jerk", "initial_layer_jerk", "initial_layer_travel_jerk", "travel_jerk"] },
    { title: "Advanced", keys: ["max_volumetric_extrusion_rate_slope", "max_volumetric_extrusion_rate_slope_segment_length", "extrusion_rate_smoothing_external_perimeter_only"] },
  ] },
  { title: "Support", groups: [
    { title: "Support", keys: ["enable_support", "support_type", "support_style", "support_threshold_angle", "support_threshold_overlap", "raft_first_layer_density", "raft_first_layer_expansion", "support_on_build_plate_only", "support_critical_regions_only", "support_remove_small_overhang"] },
    { title: "Raft", keys: ["raft_layers", "raft_contact_distance"] },
    { title: "Filament for Supports", keys: ["support_filament", "support_interface_filament", "support_interface_not_for_body"] },
    { title: "Support ironing", keys: ["support_ironing", "support_ironing_pattern", "support_ironing_flow", "support_ironing_spacing"] },
    { title: "Advanced", keys: ["support_top_z_distance", "support_bottom_z_distance", "tree_support_wall_count", "support_base_pattern", "support_base_pattern_spacing", "support_angle", "support_interface_top_layers", "support_interface_bottom_layers", "support_interface_pattern", "support_interface_spacing", "support_bottom_interface_spacing", "support_expansion", "support_object_xy_distance", "support_object_first_layer_gap", "bridge_no_support", "max_bridge_length", "independent_support_layer_height"] },
    { title: "Tree supports", keys: ["tree_support_tip_diameter", "tree_support_branch_distance", "tree_support_branch_distance_organic", "tree_support_top_rate", "tree_support_branch_diameter", "tree_support_branch_diameter_organic", "tree_support_branch_diameter_angle", "tree_support_branch_angle", "tree_support_branch_angle_organic", "tree_support_angle_slow", "tree_support_auto_brim", "tree_support_brim_width"] },
  ] },
  { title: "Multi.", groups: [
    { title: "Prime tower", keys: ["enable_prime_tower", "prime_tower_skip_points", "enable_tower_interface_features", "enable_tower_interface_cooldown_during_tower", "prime_tower_enable_framework", "prime_tower_width", "prime_volume", "prime_tower_brim_width", "prime_tower_infill_gap", "wipe_tower_rotation_angle", "wipe_tower_bridging", "wipe_tower_extra_spacing", "wipe_tower_extra_flow", "wipe_tower_max_purge_speed", "wipe_tower_wall_type", "wipe_tower_cone_angle", "wipe_tower_extra_rib_length", "wipe_tower_rib_width", "wipe_tower_fillet_wall", "wipe_tower_no_sparse_layers", "wipe_tower_sparse_layers_combination", "single_extruder_multi_material_priming"] },
    { title: "Filament for Features", keys: ["outer_wall_filament_id", "inner_wall_filament_id", "sparse_infill_filament_id", "internal_solid_filament_id", "top_surface_filament_id", "bottom_surface_filament_id", "wipe_tower_filament"] },
    { title: "Ooze prevention", keys: ["ooze_prevention", "standby_temperature_delta", "preheat_time", "preheat_steps"] },
    { title: "Flush options", keys: ["flush_into_infill", "flush_into_objects", "flush_into_support"] },
    { title: "Advanced", keys: ["interlocking_beam", "toolchange_ordering", "toolchange_cyclic_order", "toolchange_cyclic_first_layer", "interface_shells", "mmu_segmented_region_max_width", "mmu_segmented_region_interlocking_depth", "interlocking_beam_width", "interlocking_orientation", "interlocking_beam_layer_count", "interlocking_depth", "interlocking_boundary_avoidance"] },
  ] },
  { title: "Other", groups: [
    { title: "Skirt", keys: ["skirt_loops", "skirt_type", "min_skirt_length", "skirt_distance", "skirt_start_angle", "skirt_speed", "skirt_height", "draft_shield", "single_loop_draft_shield"] },
    { title: "Brim", keys: ["brim_type", "brim_width", "brim_object_gap", "brim_flow_ratio", "brim_use_efc_outline", "combine_brims", "brim_ears_max_angle", "brim_ears_detection_length", "brim_ears_outer_only"] },
    { title: "Special mode", keys: ["slicing_mode", "print_sequence", "print_order", "spiral_mode", "spiral_mode_smooth", "spiral_mode_max_xy_smoothing", "spiral_starting_flow_ratio", "spiral_finishing_flow_ratio", "timelapse_type", "enable_wrapping_detection"] },
    { title: "Fuzzy skin", keys: ["fuzzy_skin", "fuzzy_skin_mode", "fuzzy_skin_noise_type", "fuzzy_skin_point_distance", "fuzzy_skin_thickness", "fuzzy_skin_scale", "fuzzy_skin_octaves", "fuzzy_skin_persistence", "fuzzy_skin_ripples_per_layer", "fuzzy_skin_ripple_offset", "fuzzy_skin_layers_between_ripple_offset", "fuzzy_skin_first_layer"] },
    { title: "G-code output", keys: ["reduce_infill_retraction", "gcode_add_line_number", "gcode_comments", "gcode_label_objects", "exclude_object", "filename_format"] },
    { title: "Change extrusion role G-code", keys: ["process_change_extrusion_role_gcode"] },
    { title: "Post-processing Scripts", keys: ["post_process"] },
    { title: "Slicing Pipeline Plugin", keys: ["slicing_pipeline_plugin"] },
    { title: "Plugin Configuration", keys: ["print_plugin_config_overrides"] },
    { title: "Notes", keys: ["notes"] },
  ] },
];

// TabPrintModel adds an unlabelled Frequent group before the process pages.
const FREQUENT_PAGE: PrintSettingsPage = { title: 'Frequent', groups: [
  { title: '', keys: ['layer_height', 'sparse_infill_density', 'wall_loops', 'enable_support'] },
] };

// TabPrintPlate has its own page rather than the full process catalogue.
const PLATE_SETTINGS_PAGES: readonly PrintSettingsPage[] = [{ title: 'Plate Settings', groups: [
  { title: '', keys: ['curr_bed_type', 'skirt_start_angle', 'print_sequence', 'spiral_mode',
    'first_layer_sequence_choice', 'other_layers_sequence_choice'] },
] }];

export function printSettingsPages(mode: ConfigurationMode): readonly PrintSettingsPage[] {
  return mode === 'plates' ? PLATE_SETTINGS_PAGES
    : mode === 'scoped' ? [FREQUENT_PAGE, ...PRINT_SETTINGS_PAGES] : PRINT_SETTINGS_PAGES;
}

export interface PrintSettingPlacement {
  readonly page: string;
  readonly group: string;
  readonly section?: string;
}

const placements = new Map<string, PrintSettingPlacement>();
for (const page of PRINT_SETTINGS_PAGES) {
  for (const group of page.groups) {
    group.keys.forEach((key) => placements.set(key, {
      page: page.title, group: group.title,
      section: group.sections?.find((section) => section.keys.includes(key))?.title,
    }));
  }
}

export function printSettingPlacement(field: ScopedConfigurationField): PrintSettingPlacement | undefined {
  return placements.get(field.key);
}

export function isVisiblePrintSetting(field: ScopedConfigurationField, mode: ConfigurationMode): boolean {
  return printSettingsPages(mode).some((page) => page.groups.some((group) => group.keys.includes(field.key)));
}

/** Project already-eligible fields into the allow-list in native layout order. */
export function printSettingsGroups(fields: readonly ScopedConfigurationField[], pageTitle: string | undefined, search: string, mode: ConfigurationMode) {
  const query = search.trim().toLocaleLowerCase();
  const byKey = new Map(fields.map((field) => [field.key, field]));
  // Frequent duplicates process fields. Cross-page search lists each option
  // once in its full process-page context.
  const pages = query && mode === 'scoped' ? PRINT_SETTINGS_PAGES : printSettingsPages(mode);
  return pages.flatMap((page) => {
    if (!query && page.title !== pageTitle) return [];
    return page.groups.flatMap((group) => {
      const visible = group.keys.flatMap((key) => {
        const field = byKey.get(key);
        if (!field) return [];
        const section = placements.get(key)?.section;
        const text = `${key} ${field.label} ${field.category} ${page.title} ${group.title} ${section ?? ''}`;
        return !query || text.toLocaleLowerCase().includes(query) ? [field] : [];
      });
      return visible.length ? [{
        page: page.title, group: group.title,
        title: query && group.title ? `${page.title} / ${group.title}` : group.title,
        keys: group.keys, fields: visible,
      }] : [];
    });
  });
}
