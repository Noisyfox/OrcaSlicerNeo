import { configVectorElementAt, type ConfigEditorSnapshot } from '@slicer/client';
import { editorFieldTarget } from './presetEditorBindings';

export type SettingConditionValue = string | number | boolean | null | { readonly value: number; readonly percent: boolean };

export interface SettingValues {
  value(key: string): SettingConditionValue | undefined;
  boolean(key: string): boolean | undefined;
  number(key: string): number | undefined;
  numbers(key: string): readonly number[] | undefined;
  string(key: string): string | undefined;
}

export interface SettingConditionContext extends SettingValues {
  readonly scope: 'printer' | 'filament' | 'project' | 'object' | 'part' | 'plate';
  readonly printer: SettingValues;
  readonly project: SettingValues;
  readonly isBblPrinter: boolean | undefined;
  readonly nozzleCount: number | undefined;
}

/** A calculation pass writes presentation only; it cannot mutate configuration. */
export interface OptionToggles {
  toggleLine(keys: string | readonly string[], visible: boolean | undefined): void;
  toggleField(keys: string | readonly string[], enabled: boolean | undefined): void;
}
export type UpdateOptionStates = (context: SettingConditionContext, ui: OptionToggles) => void;

export function settingValues(read: SettingValues['value'], readNumbers?: SettingValues['numbers']): SettingValues {
  return {
    value: read,
    boolean(key) {
      const value = read(key);
      if (value === true || value === '1') return true;
      if (value === false || value === '0') return false;
      return undefined;
    },
    number(key) {
      const value = read(key);
      if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
      if (value && typeof value === 'object') return Number.isFinite(value.value) ? value.value : undefined;
      if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$/i.test(value.trim())) return undefined;
      return Number.isFinite(Number.parseFloat(value)) ? Number.parseFloat(value) : undefined;
    },
    numbers(key) {
      if (readNumbers) return readNumbers(key);
      const value = read(key);
      if (typeof value === 'number') return Number.isFinite(value) ? [value] : undefined;
      if (typeof value !== 'string') return undefined;
      const parts = value.split(',').map(part => part.trim());
      return parts.every(part => part !== '' && Number.isFinite(Number(part))) ? parts.map(Number) : undefined;
    },
    string(key) {
      const value = read(key);
      return typeof value === 'string' ? value : undefined;
    },
  };
}

// Three-valued boolean helpers are useful inside complete calculation functions.
export const not = (value: boolean | undefined) => value === undefined ? undefined : !value;
export const all = (...values: readonly (boolean | undefined)[]) => values.includes(false) ? false : values.includes(undefined) ? undefined : true;
export const any = (...values: readonly (boolean | undefined)[]) => values.includes(true) ? true : values.includes(undefined) ? undefined : false;
export const greaterThan = (value: number | undefined, minimum = 0) => value === undefined ? undefined : value > minimum;
export const equalTo = (value: string | undefined, expected: string) => value === undefined ? undefined : value === expected;
export const oneOf = (value: string | undefined, expected: readonly string[]) => value === undefined ? undefined : expected.includes(value);

type EditorValues = Pick<ConfigEditorSnapshot, 'effectiveValues' | 'editorVectors' | 'editorSelection'>;
type ContextOptions = {
  scope: SettingConditionContext['scope'];
  printerValues?: Readonly<Record<string, string>>;
  projectValues?: Readonly<Record<string, string>>;
  isBblPrinter?: boolean;
  nozzleCount?: number;
};

/** Resolve the controlling option's own native binding, not the displayed field's index. */
export function editorSettingContext(snapshot: EditorValues | null, choiceId: string | null, options: ContextOptions): SettingConditionContext {
  const printer = settingValues(key => options.printerValues?.[key]);
  const project = settingValues(key => options.projectValues?.[key]);
  const ownsPreset = options.scope === 'printer' || options.scope === 'filament';
  const values = settingValues(key => {
      if (!snapshot || !Object.hasOwn(snapshot.effectiveValues, key)) return ownsPreset ? undefined : project.value(key);
      const vector = snapshot.editorVectors[key];
      if (!vector) return snapshot.effectiveValues[key];
      const binding = editorFieldTarget(snapshot, key, choiceId);
      if (binding.kind === 'unavailable') return undefined;
      const value = configVectorElementAt(vector, vector.effectiveValues, binding.kind === 'indexed' ? binding.index : 0);
      if (vector.scalarType === 'point' || vector.scalarType === 'points') return undefined;
      if (vector.scalarType === 'enum' && typeof value === 'number') return vector.enumOptions?.find(option => option.value === value)?.name;
      return value as SettingConditionValue | undefined;
    }, key => {
      const vector = snapshot?.editorVectors[key];
      if (vector) return vector.effectiveValues.every(value => typeof value === 'number' && Number.isFinite(value)) ? vector.effectiveValues as number[] : undefined;
      const raw = snapshot?.effectiveValues[key];
      return raw === undefined ? ownsPreset ? undefined : project.numbers(key) : settingValues(() => raw).numbers(key);
    });
  return {
    ...values,
    printer: options.scope === 'printer' ? values : printer, project,
    scope: options.scope,
    isBblPrinter: options.isBblPrinter,
    nozzleCount: options.nozzleCount,
  };
}

export function printerNozzleCount(values: Readonly<Record<string, string>>) {
  const text = values.nozzle_diameter;
  if (!text) return undefined;
  const elements = text.startsWith('[') ? (() => { try { return JSON.parse(text) as unknown; } catch { return undefined; } })() : text.split(',');
  return Array.isArray(elements) && elements.length > 0 && elements.every(value => Number.isFinite(Number(value))) ? elements.length : undefined;
}

/** Presentation-only transcription of ConfigManipulation::toggle_print_fff_options
 * and TabPrinter/TabFilament::toggle_options at Orca c936ee9a5ce2.
 * Deliberately excludes their config writes, dialogs, enum filtering and labels.
 * Each context is evaluated once, independently of the mounted page or search.
 */
export function updateOptionStates(context: SettingConditionContext, ui: OptionToggles) {
  if (context.scope === 'printer') updatePrinterOptions(context, ui);
  else if (context.scope === 'filament') updateFilamentOptions(context, ui);
  else if (context.scope !== 'plate') updatePrintOptions(context, ui);
}

function updatePrintOptions(c: SettingConditionContext, ui: OptionToggles) {
  const b = c.boolean, n = c.number, s = c.string;
  const show = ui.toggleLine, enable = ui.toggleField;

  // Extrusion smoothing.
  const slope = greaterThan(n('max_volumetric_extrusion_rate_slope'));
  enable('enable_arc_fitting', not(slope));
  show(['max_volumetric_extrusion_rate_slope_segment_length', 'extrusion_rate_smoothing_external_perimeter_only'], slope);

  // Wall availability.
  const walls = greaterThan(n('wall_loops'));
  enable([
    'extra_perimeters_on_overhangs', 'ensure_vertical_shell_thickness', 'detect_overhang_wall', 'seam_position',
    'staggered_inner_seams', 'wall_sequence', 'outer_wall_line_width', 'inner_wall_speed', 'outer_wall_speed',
    'small_perimeter_speed', 'small_perimeter_threshold', 'gap_infill_speed'
  ], walls);

  // Sparse infill patterns and anchoring.
  const infill = greaterThan(n('sparse_infill_density'));
  const pattern = s('sparse_infill_pattern');
  show([
    'sparse_infill_pattern', 'infill_combination', 'fill_multiline', 'infill_direction',
    'minimum_sparse_infill_area', 'sparse_infill_filament_id', 'sparse_infill_rotate_template'
  ], infill);

  const anchor = not(oneOf(pattern, ['concentric', 'spiralinset']));
  show(['infill_anchor', 'infill_anchor_max'], all(infill, anchor));

  show('infill_combination_max_layer_height', all(infill, b('infill_combination')));
  show('gyroid_optimized', all(infill, equalTo(pattern, 'gyroid')));

  const multiline = oneOf(pattern, [
    'gyroid', 'grid', 'rectilinear', 'tpmsd', 'tpmsfk', 'crosshatch', 'honeycomb', 'lateral-lattice',
    'lateral-honeycomb', 'concentric', 'cubic', 'tri-hexagon', 'alignedrectilinear', 'lightning',
    '3dhoneycomb', 'adaptivecubic', 'supportcubic', 'triangles', 'quartercubic', 'archimedeanchords',
    'hilbertcurve', 'octagramspiral'
  ]);
  enable('fill_multiline', infill === false ? undefined : multiline);
  const lineAnchor = not(equalTo(pattern, 'line'));
  enable('infill_anchor_max', infill === false ? undefined : lineAnchor);
  enable('infill_anchor', infill === false ? undefined : all(lineAnchor, greaterThan(n('infill_anchor_max'))));

  const crossZag = equalTo(pattern, 'crosszag'), lockedZag = equalTo(pattern, 'lockedzag');
  show('infill_shift_step', any(crossZag, lockedZag));
  show([
    'skeleton_infill_density', 'skin_infill_density', 'infill_lock_depth', 'skin_infill_depth',
    'skin_infill_line_width', 'skeleton_infill_line_width'
  ], lockedZag);
  show('symmetric_infill_y_axis', any(equalTo(pattern, 'zigzag'), crossZag, lockedZag));

  // Spiral vase, shells and surface fill.
  const spiral = b('spiral_mode');
  show(['spiral_mode_smooth', 'spiral_starting_flow_ratio', 'spiral_finishing_flow_ratio'], spiral);
  show('spiral_mode_max_xy_smoothing', all(spiral, b('spiral_mode_smooth')));

  const topLayers = any(greaterThan(n('top_shell_layers')), all(spiral, greaterThan(n('bottom_shell_layers'), 1)));
  const top = all(topLayers, greaterThan(n('top_surface_density')));
  const bottom = greaterThan(n('bottom_shell_layers'));
  const solid = any(topLayers, bottom);

  const smooth = any(oneOf(pattern, ['hilbertcurve', 'octagramspiral', 'lightning', 'honeycomb', '3dhoneycomb', 'concentric', 'crosshatch']),
    all(oneOf(pattern, ['grid', 'triangles', 'tri-hexagon', 'cubic']), greaterThan(n('fill_multiline'), 1)));
  show('sparse_infill_smooth_factor', smooth);

  enable(['top_surface_pattern', 'top_layer_direction', 'top_surface_line_width', 'top_surface_speed'], top);
  enable('top_surface_density', topLayers);
  enable(['bottom_surface_pattern', 'bottom_surface_density', 'bottom_layer_direction'], bottom);

  show(['top_surface_expansion', 'top_surface_expansion_margin', 'top_surface_expansion_direction'], top);
  enable(['top_surface_expansion_margin', 'top_surface_expansion_direction'], greaterThan(n('top_surface_expansion')));

  const topPattern = s('top_surface_pattern'), bottomPattern = s('bottom_surface_pattern');
  const centered = ['archimedeanchords', 'octagramspiral'];
  show('center_of_surface_pattern', any(all(top, oneOf(topPattern, centered)), all(bottom, oneOf(bottomPattern, centered))));
  const centeredFill = ['concentric', 'spiralinset', ...centered];
  show('top_surface_fill_order', all(top, oneOf(topPattern, centeredFill)));
  show('bottom_surface_fill_order', all(bottom, oneOf(bottomPattern, centeredFill)));

  const sparseRotation = s('sparse_infill_rotate_template'), solidRotation = s('solid_infill_rotate_template');
  show('separated_infills', any(
    oneOf(pattern, [
      'rectilinear', 'alignedrectilinear', 'zigzag', 'crosszag', 'lockedzag', 'grid', 'triangles',
      'tri-hexagon', 'cubic', 'quartercubic', 'lateral-honeycomb', 'lateral-lattice', 'hilbertcurve', ...centered
    ]),
    not(equalTo(sparseRotation, '')), not(equalTo(solidRotation, ''))
  ));

  enable([
    'infill_direction', 'sparse_infill_line_width', 'gap_fill_target', 'filter_out_gap_fill',
    'infill_wall_overlap', 'bridge_angle', 'internal_bridge_angle', 'relative_bridge_angle',
    'solid_infill_direction', 'solid_infill_rotate_template', 'internal_solid_infill_pattern',
    'internal_solid_filament_id', 'top_surface_filament_id', 'bottom_surface_filament_id',
    'sparse_infill_speed', 'bridge_speed', 'internal_bridge_speed'
  ], any(infill, solid));
  enable('top_shell_thickness', all(not(spiral), topLayers));
  enable('bottom_shell_thickness', all(not(spiral), bottom));

  // Acceleration, junction deviation and jerk.
  enable([
    'outer_wall_acceleration', 'inner_wall_acceleration', 'initial_layer_acceleration',
    'initial_layer_travel_acceleration', 'top_surface_acceleration', 'travel_acceleration',
    'bridge_acceleration', 'sparse_infill_acceleration', 'internal_solid_infill_acceleration'
  ], greaterThan(n('default_acceleration')));

  const flavor = c.printer.string('gcode_flavor');
  const marlin = equalTo(flavor, 'marlin2'), klipper = equalTo(flavor, 'klipper');
  // Orca uses the first machine-limit entry, independently of the editing variant.
  const junctionValues = c.printer.numbers('machine_max_junction_deviation');
  const junction = all(marlin, greaterThan(junctionValues?.[0]));
  show('default_junction_deviation', marlin);
  enable('default_junction_deviation', junction);
  enable('default_jerk', not(junction));
  const jerk = [
    'outer_wall_jerk', 'inner_wall_jerk', 'initial_layer_jerk', 'initial_layer_travel_jerk',
    'top_surface_jerk', 'travel_jerk', 'infill_jerk'
  ];
  show(jerk, not(junction));
  enable(jerk, junction === true ? undefined : greaterThan(n('default_jerk')));

  // Bed adhesion: skirt, brim and elephant-foot compensation.
  const skirt = greaterThan(n('skirt_loops'));
  show('single_loop_draft_shield', skirt);
  enable('skirt_height', all(skirt, not(equalTo(s('draft_shield'), 'enabled'))));
  enable(['skirt_type', 'min_skirt_length', 'skirt_distance', 'skirt_start_angle', 'skirt_speed', 'draft_shield'], skirt);

  const brimType = s('brim_type'), brim = not(equalTo(brimType, 'no_brim'));
  enable(['brim_object_gap', 'brim_use_efc_outline', 'combine_brims', 'brim_flow_ratio'], brim);
  enable('brim_width', not(oneOf(brimType, ['no_brim', 'auto_brim', 'painted'])));
  enable(['outer_wall_filament_id', 'inner_wall_filament_id'], any(walls, brim));

  const ears = equalTo(brimType, 'brim_ears'), painted = equalTo(brimType, 'painted'), brimWidth = greaterThan(n('brim_width'));
  show(['brim_ears_max_angle', 'brim_ears_detection_length'], ears);
  show('brim_ears_outer_only', any(ears, painted));
  enable(['brim_ears_max_angle', 'brim_ears_detection_length'], brimWidth);
  enable('brim_ears_outer_only', any(painted, brimWidth));

  show('elefant_foot_compensation_layers', any(greaterThan(n('elefant_foot_compensation')), n('elefant_foot_layers_density') === undefined ? undefined : n('elefant_foot_layers_density')! < 100));

  // Supports, interfaces and raft.
  const raft = greaterThan(n('raft_layers')), support = b('enable_support');
  const material = any(support, raft);
  const supportType = s('support_type'), style = s('support_style');
  const autoSupport = oneOf(supportType, ['normal(auto)', 'tree(auto)']);
  const tree = all(support, oneOf(supportType, ['tree(auto)', 'tree(manual)']));
  const organic = all(tree, oneOf(style, ['organic', 'default']));
  const normalTree = all(tree, not(organic));
  const supportInterface = any(greaterThan(n('support_interface_top_layers')), greaterThan(n('support_interface_bottom_layers')));
  enable([
    'support_style', 'support_base_pattern', 'support_base_pattern_spacing', 'support_expansion',
    'support_angle', 'support_interface_pattern', 'support_interface_top_layers',
    'support_interface_bottom_layers', 'bridge_no_support', 'max_bridge_length', 'support_top_z_distance',
    'support_bottom_z_distance', 'support_type', 'support_on_build_plate_only', 'support_critical_regions_only',
    'support_interface_not_for_body', 'support_object_xy_distance', 'support_object_first_layer_gap',
    'independent_support_layer_height'
  ], material);
  enable('support_threshold_angle', all(material, autoSupport));
  enable('support_threshold_overlap', all(material, autoSupport, n('support_threshold_angle') === undefined ? undefined : n('support_threshold_angle') === 0));
  show('support_threshold_overlap', not(tree));

  show([
    'tree_support_branch_angle', 'tree_support_branch_distance', 'tree_support_branch_diameter',
    'tree_support_auto_brim', 'tree_support_brim_width'
  ], normalTree);
  show([
    'tree_support_branch_angle_organic', 'tree_support_branch_distance_organic',
    'tree_support_branch_diameter_organic', 'tree_support_angle_slow', 'tree_support_tip_diameter',
    'tree_support_top_rate', 'tree_support_branch_diameter_angle'
  ], organic);
  show('independent_support_layer_height', all(material, not(organic)));
  enable('tree_support_brim_width', all(tree, not(b('tree_support_auto_brim'))));
  show('max_bridge_length', tree);
  show('bridge_no_support', not(tree));
  show('support_critical_regions_only', all(autoSupport, tree));

  enable(['support_interface_filament', 'support_interface_loop_pattern', 'support_bottom_interface_spacing'], all(material, supportInterface));

  const canIronSupport = any(raft, all(material, greaterThan(n('support_interface_top_layers'))));
  enable('support_ironing', canIronSupport);
  const ironSupport = all(canIronSupport, b('support_ironing'));
  show(['support_ironing_pattern', 'support_ironing_flow', 'support_ironing_spacing'], ironSupport);
  enable('support_interface_spacing', all(material, supportInterface, not(ironSupport)));

  enable(['small_support_perimeter_speed', 'small_support_perimeter_threshold'], support);

  enable('inner_wall_line_width', any(walls, skirt, brim));
  enable('support_filament', any(material, skirt));

  show('raft_contact_distance', all(raft, not(all(material, n('support_top_z_distance') === undefined ? undefined : n('support_top_z_distance') === 0))));
  enable('raft_first_layer_density', material);
  enable('raft_first_layer_expansion', all(material, any(not(normalTree), equalTo(style, 'tree_hybrid'), raft)));

  // Surface ironing.
  const ironing = not(equalTo(s('ironing_type'), 'no ironing'));
  show(['ironing_pattern', 'ironing_flow', 'ironing_spacing', 'ironing_angle', 'ironing_inset', 'ironing_angle_fixed'], ironing);
  enable(['ironing_angle', 'ironing_angle_fixed'], all(ironing, equalTo(s('ironing_pattern'), 'rectilinear')));
  show('ironing_speed', any(ironing, ironSupport));

  // Z-layer contouring.
  show(['zaa_minimize_perimeter_height', 'zaa_min_z', 'zaa_dont_alternate_fill_direction', 'ironing_expansion'], b('zaa_enabled'));

  // Sequential printing and ooze prevention.
  enable('print_order', not(equalTo(s('print_sequence'), 'by object')));

  const semm = c.printer.boolean('single_extruder_multi_material');
  enable('ooze_prevention', not(semm));
  const ooze = b('ooze_prevention');
  show(['standby_temperature_delta', 'preheat_time'], ooze);
  show('preheat_steps', all(ooze, greaterThan(n('preheat_steps'))));

  // Prime tower, tool changes and flushing.
  const tower = b('enable_prime_tower');
  const tower2 = all(not(c.isBblPrinter), equalTo(c.printer.string('wipe_tower_type'), 'type2'));
  show([
    'prime_tower_width', 'prime_tower_brim_width', 'prime_tower_skip_points', 'wipe_tower_wall_type',
    'prime_tower_infill_gap', 'prime_tower_enable_framework', 'enable_tower_interface_features',
    'wipe_tower_no_sparse_layers'
  ], tower);
  show('enable_tower_interface_cooldown_during_tower', all(tower, b('enable_tower_interface_features')));
  show([
    'wipe_tower_rotation_angle', 'wipe_tower_extra_spacing', 'wipe_tower_max_purge_speed',
    'wipe_tower_bridging', 'wipe_tower_extra_flow'
  ], all(tower, tower2));
  show('wipe_tower_sparse_layers_combination', all(tower, not(b('wipe_tower_no_sparse_layers'))));

  const wallType = s('wipe_tower_wall_type'), rib = all(tower, equalTo(wallType, 'rib'));
  show('wipe_tower_cone_angle', all(tower, tower2, equalTo(wallType, 'cone')));
  show(['wipe_tower_extra_rib_length', 'wipe_tower_rib_width', 'wipe_tower_fillet_wall'], rib);
  enable('prime_tower_width', all(tower, not(rib)));
  show('single_extruder_multi_material_priming', all(not(semm), tower, tower2));
  show('prime_volume', all(tower, any(not(c.printer.boolean('purge_in_prime_tower')), not(semm))));

  show(['toolchange_cyclic_order', 'toolchange_cyclic_first_layer'], equalTo(s('toolchange_ordering'), 'cyclic'));

  enable(['flush_into_infill', 'flush_into_support', 'flush_into_objects'], tower);
  show('flush_into_objects', c.scope !== 'project');

  // Travel, flow ratios and overhang speed.
  show('max_travel_detour_distance', b('reduce_crossing_wall'));

  show([
    'first_layer_flow_ratio', 'outer_wall_flow_ratio', 'inner_wall_flow_ratio', 'overhang_flow_ratio',
    'sparse_infill_flow_ratio', 'internal_solid_infill_flow_ratio', 'gap_fill_flow_ratio', 'support_flow_ratio',
    'support_interface_flow_ratio'
  ], b('set_other_flow_ratios'));

  show(['overhang_1_4_speed', 'overhang_2_4_speed', 'overhang_3_4_speed', 'overhang_4_4_speed', 'slowdown_for_curled_perimeters'], b('enable_overhang_speed'));

  show('support_interface_not_for_body', all(greaterThan(n('support_interface_filament')), n('support_filament') === undefined ? undefined : n('support_filament') === 0));

  // Fuzzy skin and its noise-specific controls.
  const fuzzy = not(equalTo(s('fuzzy_skin'), 'disabled_fuzzy')), noise = s('fuzzy_skin_noise_type');
  show(['fuzzy_skin_mode', 'fuzzy_skin_noise_type', 'fuzzy_skin_point_distance', 'fuzzy_skin_thickness', 'fuzzy_skin_first_layer'], fuzzy);
  show('fuzzy_skin_scale', all(fuzzy, not(oneOf(noise, ['classic', 'ripple']))));
  show('fuzzy_skin_octaves', all(fuzzy, not(oneOf(noise, ['classic', 'voronoi', 'ripple']))));
  show('fuzzy_skin_persistence', all(fuzzy, oneOf(noise, ['perlin', 'billow'])));
  show(['fuzzy_skin_ripples_per_layer', 'fuzzy_skin_ripple_offset', 'fuzzy_skin_layers_between_ripple_offset'], all(fuzzy, equalTo(noise, 'ripple')));

  // Wall generation and surface handling.
  const arachne = equalTo(s('wall_generator'), 'arachne');
  show([
    'wall_transition_length', 'wall_transition_filter_deviation', 'wall_transition_angle', 'min_feature_size',
    'min_length_factor', 'min_bead_width', 'wall_distribution_count', 'initial_layer_min_bead_width',
    'wall_maximum_resolution', 'wall_maximum_deviation'
  ], arachne);
  enable('detect_thin_wall', not(arachne));

  enable('wipe_speed', not(b('role_based_wipe_speed')));
  show('wipe_inward_distance', b('wipe_inward'));

  show(['accel_to_decel_enable', 'accel_to_decel_factor'], klipper);
  enable('accel_to_decel_factor', klipper === false ? undefined : b('accel_to_decel_enable'));

  show(['make_overhang_printable_angle', 'make_overhang_printable_hole_size'], b('make_overhang_printable'));

  show('only_one_wall_first_layer', bottom);
  show('only_one_wall_top', topLayers);
  show('min_width_top_surface', any(all(topLayers, b('only_one_wall_top')), all(greaterThan(n('min_length_factor'), 0.5), arachne)));

  show(['hole_to_polyhole_threshold', 'hole_to_polyhole_twisted', 'hole_to_polyhole_max_edges'], b('hole_to_polyhole'));

  const detectOverhang = b('detect_overhang_wall'), reverse = b('overhang_reverse'), internalOnly = b('overhang_reverse_internal_only');
  show('unsupported_wall_last', detectOverhang);
  show('overhang_reverse', not(spiral));
  show('overhang_reverse_internal_only', all(not(spiral), reverse));
  show('overhang_reverse_threshold', all(detectOverhang, not(spiral), reverse, not(internalOnly)));

  show('timelapse_type', c.isBblPrinter);

  show('small_area_infill_flow_compensation_model', b('small_area_infill_flow_compensation'));

  // Scarf seams.
  enable('seam_slope_type', not(spiral));
  const scarf = all(not(spiral), not(equalTo(s('seam_slope_type'), 'none')));
  show([
    'seam_slope_conditional', 'seam_slope_start_height', 'seam_slope_entire_loop', 'seam_slope_min_length',
    'seam_slope_steps', 'seam_slope_inner_walls', 'scarf_joint_speed', 'scarf_joint_flow_ratio'
  ], scarf);
  enable('seam_slope_min_length', not(b('seam_slope_entire_loop')));
  show(['scarf_angle_threshold', 'scarf_overhang_threshold'], all(scarf, b('seam_slope_conditional')));

  // Multi-material interlocking.
  const interlock = b('interlocking_beam');
  show('mmu_segmented_region_interlocking_depth', not(interlock));
  show([
    'interlocking_beam_width', 'interlocking_orientation', 'interlocking_beam_layer_count',
    'interlocking_depth', 'interlocking_boundary_avoidance'
  ], interlock);

  // Pattern-specific infill controls.
  show(['lateral_lattice_angle_1', 'lateral_lattice_angle_2'], equalTo(pattern, 'lateral-lattice'));

  show(['lightning_overhang_angle', 'lightning_prune_angle', 'lightning_straightening_angle'], equalTo(pattern, 'lightning'));

  const adaptive = oneOf(pattern, ['adaptivecubic', 'supportcubic']);
  enable('sparse_infill_rotate_template', not(adaptive));
  enable('infill_direction', all(equalTo(sparseRotation, ''), not(adaptive)));
  enable('solid_infill_direction', equalTo(solidRotation, ''));
  show('infill_overhang_angle', equalTo(pattern, 'lateral-honeycomb'));

  // DeviceCore's machine capability database is not a native option snapshot.
  // Unknown capabilities remain visible until an existing UI source supplies them.
  show('enable_wrapping_detection', c.printer.boolean('support_wrapping_detection'));
}

function updatePrinterOptions(c: SettingConditionContext, ui: OptionToggles) {
  const b = c.boolean, n = c.number, s = c.string;
  const show = ui.toggleLine, enable = ui.toggleField;

  // Printer and firmware capabilities.
  const bbl = c.isBblPrinter, flavor = s('gcode_flavor');
  const marlin = equalTo(flavor, 'marlin2'), legacy = equalTo(flavor, 'marlin'), klipper = equalTo(flavor, 'klipper'), reprap = equalTo(flavor, 'reprapfirmware');

  show(['scan_first_layer', 'bbl_calib_mark_logo', 'bbl_use_printhost'], bbl);
  show([
    'use_firmware_retraction', 'use_relative_e_distances', 'support_multi_bed_types', 'pellet_modded_printer',
    'bed_mesh_max', 'bed_mesh_min', 'bed_mesh_probe_distance', 'adaptive_bed_mesh_margin', 'thumbnails',
    'wipe_tower_type'
  ], not(bbl));
  show('enable_power_loss_recovery', any(bbl, marlin));

  show('parallel_printheads_count', b('support_parallel_printheads'));

  show('fan_direction', b('auxiliary_fan'));

  const coolingFilter = b('support_cooling_filter');
  show('support_air_filtration', not(coolingFilter));
  show('cooling_filter_enabled', coolingFilter);

  show('wrapping_detection_gcode', c.printer.boolean('support_wrapping_detection'));

  // Multi-material hardware and printable area.
  const tower2 = all(not(bbl), equalTo(s('wipe_tower_type'), 'type2'));
  enable([
    'enable_filament_ramming', 'cooling_tube_retraction', 'cooling_tube_length', 'parking_pos_retraction',
    'extra_loading_move', 'high_current_on_filament_swap'
  ], tower2);

  const semm = b('single_extruder_multi_material');
  enable('extruders_count', not(semm));
  enable('manual_filament_change', semm);
  enable('purge_in_prime_tower', all(semm, tower2));
  enable(['tool_change_on_wipe_tower', 'wait_for_temp_on_wipe_tower'], all(not(semm), tower2, greaterThan(c.nozzleCount, 1)));

  show(['extruder_printable_area', 'extruder_printable_height'], c.nozzleCount === undefined ? undefined : c.nozzleCount === 2);
  enable(['extruder_printable_area', 'extruder_printable_height'], false);

  // Retraction and wiping.
  const firmwareRetraction = b('use_firmware_retraction'), length = greaterThan(n('retraction_length'));
  const retraction = any(length, firmwareRetraction);
  enable(['retraction_minimum_travel', 'z_hop', 'retract_when_changing_layer'], retraction);
  enable(['retract_lift_above', 'retract_lift_below', 'retract_lift_enforce'], all(retraction, greaterThan(n('z_hop'))));
  enable(['retraction_speed', 'deretraction_speed', 'retract_restart_extra'], all(retraction, not(firmwareRetraction)));
  // Neo's field is retraction_length; upstream's toggle uses the older retract_length spelling.
  enable('retraction_length', not(firmwareRetraction));

  const wipe = all(retraction, b('wipe'));
  const before = n('retract_before_wipe'), after = n('retract_after_wipe');
  enable('retract_before_wipe', all(wipe, after === undefined ? undefined : Math.abs(after - 100) > 1e-6));
  enable('retract_after_wipe', all(wipe, before === undefined ? undefined : Math.abs(before - 100) > 1e-6));
  enable('wipe_distance', wipe);

  enable('retract_restart_extra_toolchange', greaterThan(n('retract_length_toolchange')));

  enable('long_retractions_when_cut', all(not(firmwareRetraction), greaterThan(n('enable_long_retraction_when_cut'))));
  show('retraction_distances_when_cut', b('long_retractions_when_cut'));

  enable('travel_slope', not(equalTo(s('z_hop_types'), 'Normal Lift')));

  // Firmware motion limits.
  const accelerationTravel = all(not(legacy), not(klipper));
  show('machine_max_acceleration_travel', accelerationTravel);
  enable('machine_max_acceleration_travel', accelerationTravel);

  show('machine_max_junction_deviation', marlin);
  enable('machine_max_junction_deviation', marlin);
  const junction = c.numbers('machine_max_junction_deviation');
  const zeroJunction = junction?.every(value => value === 0);
  enable(['machine_max_jerk_x', 'machine_max_jerk_y', 'machine_max_jerk_z', 'machine_max_jerk_e'], any(not(marlin), zeroJunction));

  enable('emit_machine_limits_to_gcode', any(legacy, marlin, reprap));

  // Resonance avoidance and input shaping.
  enable(['min_resonance_avoidance_speed', 'max_resonance_avoidance_speed'], b('resonance_avoidance'));

  const shaping = any(marlin, reprap), emitLimits = b('emit_machine_limits_to_gcode');
  show(['input_shaping_emit', 'input_shaping_type', 'input_shaping_freq_x', 'input_shaping_freq_y', 'input_shaping_damp_x', 'input_shaping_damp_y'], shaping);
  enable('input_shaping_emit', shaping === false ? undefined : emitLimits);
  const emitShaping = all(emitLimits, b('input_shaping_emit'));
  enable(['input_shaping_type', 'input_shaping_freq_x', 'input_shaping_damp_x'], shaping === false ? undefined : emitShaping);
  enable(['input_shaping_freq_y', 'input_shaping_damp_y'], shaping === false ? undefined : all(emitShaping, not(reprap)));
}

function updateFilamentOptions(c: SettingConditionContext, ui: OptionToggles) {
  const b = c.boolean, s = c.string;
  const show = ui.toggleLine, enable = ui.toggleField;

  // Part cooling.
  enable(['overhang_fan_speed', 'overhang_fan_threshold', 'internal_bridge_fan_speed'], b('enable_overhang_bridge_fan'));

  enable('dont_slow_down_outer_wall', b('slow_down_for_layer_cooling'));

  const firstFan = c.number('close_fan_the_first_x_layers');
  show('initial_layer_fan_speed', firstFan === undefined ? undefined : firstFan <= 0);

  show('additional_cooling_fan_speed', c.printer.boolean('auxiliary_fan'));

  // Chamber air filtration.
  const filtration = c.printer.boolean('support_air_filtration'), active = b('activate_air_filtration');
  // Orca's exhaust-speed lines also contain their activation checkboxes.
  show([
    'activate_air_filtration', 'activate_air_filtration_during_print', 'during_print_exhaust_fan_speed',
    'activate_air_filtration_on_completion', 'complete_print_exhaust_fan_speed'
  ], filtration);
  enable(['activate_air_filtration_during_print', 'activate_air_filtration_on_completion'], filtration === false ? undefined : active);
  enable('during_print_exhaust_fan_speed', filtration === false ? undefined : all(active, b('activate_air_filtration_during_print')));
  enable('complete_print_exhaust_fan_speed', filtration === false ? undefined : all(active, b('activate_air_filtration_on_completion')));

  // Pressure advance.
  const pa = b('enable_pressure_advance');
  enable(['pressure_advance', 'adaptive_pressure_advance', 'adaptive_pressure_advance_overhangs'], pa);
  show([
    'adaptive_pressure_advance_overhangs', 'adaptive_pressure_advance_model',
    'adaptive_pressure_advance_bridges'
  ], all(pa, b('adaptive_pressure_advance')));

  // Material and chamber capabilities.
  const pellet = c.printer.boolean('pellet_modded_printer');
  show('pellet_flow_coefficient', pellet);
  show('filament_diameter', not(pellet));

  show('activate_chamber_temp_control', c.printer.boolean('support_chamber_temp_control'));

  // Adaptive volumetric speed.
  const coefficients = s('volumetric_speed_coefficients');
  enable('filament_adaptive_volumetric_speed', coefficients === undefined ? undefined : coefficients !== '0 0 0 0 0 0');

  // Bed temperatures for the active printer and project.
  const multiBed = any(c.isBblPrinter, c.printer.boolean('support_multi_bed_types'));
  const bed = c.project.string('curr_bed_type');
  const bedKeys: Record<string, string> = {
    'Supertack Plate': 'supertack_plate_temp_initial_layer',
    'Cool Plate': 'cool_plate_temp_initial_layer',
    'Textured Cool Plate': 'textured_cool_plate_temp_initial_layer',
    'Engineering Plate': 'eng_plate_temp_initial_layer',
    'Textured PEI Plate': 'textured_plate_temp_initial_layer',
    'High Temp Plate': 'hot_plate_temp_initial_layer'
  };
  // Each native bed-temperature line contains initial- and subsequent-layer fields.
  for (const key of Object.values(bedKeys)) show([key, key.replace('_initial_layer', '')], bed === undefined || !bedKeys[bed] ? true : any(multiBed, bedKeys[bed] === key));

  // Filament loading, unloading and tool changes.
  enable([
    'filament_minimal_purge_on_wipe_tower', 'filament_loading_speed_start', 'filament_loading_speed',
    'filament_unloading_speed_start', 'filament_unloading_speed', 'filament_toolchange_delay',
    'filament_cooling_moves', 'filament_cooling_initial_speed', 'filament_cooling_final_speed'
  ], not(c.isBblPrinter));

  enable(['filament_multitool_ramming_volume', 'filament_multitool_ramming_flow'], b('filament_multitool_ramming'));

  // Bambu multi-nozzle extruder-change retractions.
  const bblMulti = all(c.isBblPrinter, greaterThan(c.nozzleCount, 1));
  show('long_retractions_when_ec', bblMulti);
  show('retraction_distances_when_ec', all(bblMulti, b('long_retractions_when_ec')));
}
