import { describe, expect, it } from 'vitest';
import { all, any, not, settingValues, updateOptionStates, type SettingConditionContext, editorSettingContext } from './settingConditions';
import { OptionStateScope } from './optionStateRegistry';
import { type ConfigEditorSnapshot } from '@slicer/client';

const context = (values: Record<string, string>): SettingConditionContext => ({
  ...settingValues(key => values[key]), printer: settingValues(() => undefined), project: settingValues(() => undefined),
  scope: 'object', isBblPrinter: undefined, nozzleCount: undefined,
});

describe('shared setting conditions', () => {
  it('runs a complete function once per target and batches multiple options', () => {
    const scope = new OptionStateScope<string>();
    let calls = 0;
    const calculate = (ctx: SettingConditionContext, ui: import('./settingConditions').OptionToggles) => {
      calls++;
      const enabled = ctx.boolean('enabled');
      ui.toggleLine(['a', 'b'], enabled);
      ui.toggleField('b', enabled);
    };
    const rows = ['a', 'b'].map(key => ({ key, data: key, signature: key }));
    scope.publish(rows, [context({ enabled: '0' })], calculate, 'off');
    expect(calls).toBe(1);
    expect(scope.get('a')?.visible).toBe(false);
    expect(scope.get('b')?.readOnly).toBe(true);
    scope.publish(rows, [context({ enabled: '0' })], calculate, 'off');
    expect(calls).toBe(1);
    scope.publish(rows, [context({ enabled: '0' }), context({ enabled: '1' })], calculate, 'mixed');
    expect(calls).toBe(3);
    expect(scope.get('b')).toMatchObject({ visible: true, readOnly: true });
  });

  it('propagates unknown without hiding or adding a read-only lock', () => {
    expect(all(undefined, false)).toBe(false);
    expect(any(undefined, true)).toBe(true);
    expect(not(undefined)).toBeUndefined();
    const scope = new OptionStateScope<string>();
    scope.publish([{ key: 'a', data: 'a', signature: 'a' }], [context({})], (ctx, ui) => {
      ui.toggleLine('a', ctx.boolean('missing'));
      ui.toggleField('a', ctx.boolean('missing'));
    }, 'unknown');
    expect(scope.get('a')).toMatchObject({ visible: true, readOnly: false });
  });

  it('uses each controlling key native mapping and preserves unavailable and nullable values', () => {
    const snapshot = {
      effectiveValues: { control: '0,1', nullable: 'nil' },
      editorSelection: { choices: [{ id: 'head' }], fieldBindings: {
        control: { kind: 'per_selection', bindings: [{ kind: 'indexed', index: 1 }] },
        nullable: { kind: 'per_selection', bindings: [{ kind: 'indexed', index: 0 }] },
      } },
      editorVectors: {
        control: { scalarType: 'bool', effectiveValues: [false, true], indexCount: 2 },
        nullable: { scalarType: 'float', effectiveValues: [null], indexCount: 1 },
      },
    } as unknown as ConfigEditorSnapshot;
    const values = editorSettingContext(snapshot, 'head', { scope: 'printer', projectValues: { control: '0', inherited: '4' } });
    expect(values.boolean('control')).toBe(true);
    expect(values.value('nullable')).toBeNull();
    expect(values.number('nullable')).toBeUndefined();
    expect(values.number('inherited')).toBeUndefined(); // A browsed preset never borrows another preset's values.
    expect(editorSettingContext(snapshot, 'head', { scope: 'object', projectValues: { inherited: '4' } }).number('inherited')).toBe(4);
    expect(editorSettingContext(snapshot, null, { scope: 'printer', projectValues: { control: '0' } }).boolean('control')).toBeUndefined();
  });
});

function calculate(scope: SettingConditionContext['scope'], values: Record<string, string>, keys: string[],
  printer: Record<string, string> = {}, isBblPrinter?: boolean, nozzleCount?: number) {
  const registry = new OptionStateScope<string>();
  const source = Object.freeze({ ...values });
  const context: SettingConditionContext = { ...settingValues(key => source[key]), scope,
    printer: settingValues(key => printer[key]), project: settingValues(key => printer[key]), isBblPrinter, nozzleCount };
  registry.publish(keys.map(key => ({ key, data: key, signature: key })), [context], updateOptionStates, JSON.stringify([scope, source, printer]));
  expect(source).toEqual(values);
  return (key: string) => ({ visible: registry.get(key)!.visible, readOnly: registry.get(key)!.readOnly });
}

describe('central Orca option presentation', () => {
  it('computes tower visibility and enablement without normalizing configuration', () => {
    const get = calculate('project', { enable_prime_tower: '1', wipe_tower_wall_type: 'rib', enable_tower_interface_features: '0', wipe_tower_no_sparse_layers: '1' },
      ['prime_tower_width', 'wipe_tower_rib_width', 'wipe_tower_cone_angle', 'enable_tower_interface_cooldown_during_tower', 'wipe_tower_sparse_layers_combination', 'flush_into_objects'],
      { wipe_tower_type: 'type2', single_extruder_multi_material: '0' }, false);
    expect(get('prime_tower_width')).toEqual({ visible: true, readOnly: true });
    expect(get('wipe_tower_rib_width').visible).toBe(true);
    for (const key of ['wipe_tower_cone_angle', 'enable_tower_interface_cooldown_during_tower', 'wipe_tower_sparse_layers_combination', 'flush_into_objects']) expect(get(key).visible).toBe(false);
  });

  it('distinguishes organic and normal tree support and their separate locks', () => {
    const keys = ['tree_support_branch_angle', 'tree_support_branch_angle_organic', 'independent_support_layer_height', 'support_threshold_overlap', 'support_style'];
    const organic = calculate('object', { enable_support: '1', support_type: 'tree(auto)', support_style: 'organic', raft_layers: '0' }, keys);
    expect(organic('tree_support_branch_angle').visible).toBe(false);
    expect(organic('tree_support_branch_angle_organic').visible).toBe(true);
    expect(organic('independent_support_layer_height').visible).toBe(false);
    expect(organic('support_threshold_overlap').visible).toBe(false);
    expect(organic('support_style').readOnly).toBe(false);
    const off = calculate('part', { enable_support: '0', raft_layers: '0' }, keys);
    expect(off('support_style').readOnly).toBe(true);
  });

  it('handles pattern, shell, scarf, fuzzy noise and ironing branches', () => {
    const get = calculate('project', { sparse_infill_density: '0%', sparse_infill_pattern: 'lightning', wall_loops: '0',
      spiral_mode: '1', bottom_shell_layers: '1', top_shell_layers: '0', fuzzy_skin: 'external', fuzzy_skin_noise_type: 'ripple', ironing_type: 'no ironing', wall_generator: 'arachne' },
    ['sparse_infill_pattern', 'outer_wall_speed', 'lightning_prune_angle', 'fuzzy_skin_scale', 'fuzzy_skin_ripple_offset', 'ironing_flow', 'seam_slope_type', 'seam_slope_start_height', 'wall_transition_angle', 'detect_thin_wall']);
    expect(get('sparse_infill_pattern').visible).toBe(false);
    expect(get('outer_wall_speed').readOnly).toBe(true);
    expect(get('lightning_prune_angle').visible).toBe(true);
    expect(get('fuzzy_skin_scale').visible).toBe(false);
    expect(get('fuzzy_skin_ripple_offset').visible).toBe(true);
    expect(get('ironing_flow').visible).toBe(false);
    expect(get('seam_slope_type').readOnly).toBe(true);
    expect(get('seam_slope_start_height').visible).toBe(false);
    expect(get('wall_transition_angle').visible).toBe(true);
    expect(get('detect_thin_wall').readOnly).toBe(true);
  });

  it('uses machine flavor and junction deviation for jerk fields', () => {
    const get = calculate('project', { default_jerk: '5', default_acceleration: '0', accel_to_decel_enable: '0' },
      ['default_junction_deviation', 'default_jerk', 'outer_wall_jerk', 'outer_wall_acceleration', 'accel_to_decel_factor'],
      { gcode_flavor: 'marlin2', machine_max_junction_deviation: '0.03,0' });
    expect(get('default_junction_deviation')).toEqual({ visible: true, readOnly: false });
    expect(get('default_jerk').readOnly).toBe(true);
    expect(get('outer_wall_jerk').visible).toBe(false);
    expect(get('outer_wall_acceleration').readOnly).toBe(true);
    expect(get('accel_to_decel_factor').visible).toBe(false);
  });

  it('covers Printer capabilities, retraction and motion without companion writes', () => {
    const get = calculate('printer', { gcode_flavor: 'klipper', single_extruder_multi_material: '1', auxiliary_fan: '0', support_cooling_filter: '1',
      use_firmware_retraction: '1', retraction_length: '0', z_hop: '0', wipe: '0', wipe_tower_type: 'type2', resonance_avoidance: '0' },
    ['fan_direction', 'support_air_filtration', 'cooling_filter_enabled', 'extruders_count', 'retraction_length', 'retraction_speed', 'retract_lift_above', 'extruder_printable_area', 'machine_max_acceleration_travel', 'min_resonance_avoidance_speed'], {}, false, 2);
    expect(get('fan_direction').visible).toBe(false);
    expect(get('support_air_filtration').visible).toBe(false);
    expect(get('cooling_filter_enabled').visible).toBe(true);
    for (const key of ['extruders_count', 'retraction_length', 'retraction_speed', 'retract_lift_above', 'extruder_printable_area', 'min_resonance_avoidance_speed']) expect(get(key).readOnly).toBe(true);
    expect(get('extruder_printable_area').visible).toBe(true);
    expect(get('machine_max_acceleration_travel').visible).toBe(false);
  });

  it('covers Filament cooling, PA, bed selection and machine accessory conditions', () => {
    const get = calculate('filament', { enable_pressure_advance: '0', adaptive_pressure_advance: '1', close_fan_the_first_x_layers: '3',
      enable_overhang_bridge_fan: '0', filament_multitool_ramming: '0', volumetric_speed_coefficients: '0 0 0 0 0 0' },
    ['pressure_advance', 'adaptive_pressure_advance_model', 'initial_layer_fan_speed', 'additional_cooling_fan_speed', 'filament_diameter', 'pellet_flow_coefficient', 'overhang_fan_threshold', 'filament_adaptive_volumetric_speed', 'hot_plate_temp_initial_layer', 'hot_plate_temp', 'cool_plate_temp_initial_layer', 'cool_plate_temp', 'activate_air_filtration_during_print', 'during_print_exhaust_fan_speed'],
    { auxiliary_fan: '0', pellet_modded_printer: '1', support_multi_bed_types: '0', support_air_filtration: '0', curr_bed_type: 'High Temp Plate' }, false, 1);
    for (const key of ['adaptive_pressure_advance_model', 'initial_layer_fan_speed', 'additional_cooling_fan_speed', 'filament_diameter', 'cool_plate_temp_initial_layer', 'cool_plate_temp', 'activate_air_filtration_during_print', 'during_print_exhaust_fan_speed']) expect(get(key).visible).toBe(false);
    expect(get('pellet_flow_coefficient').visible).toBe(true);
    expect(get('hot_plate_temp_initial_layer').visible).toBe(true);
    expect(get('hot_plate_temp').visible).toBe(true);
    for (const key of ['pressure_advance', 'overhang_fan_threshold', 'filament_adaptive_volumetric_speed']) expect(get(key).readOnly).toBe(true);
  });

  it('leaves missing capabilities unrestricted and keeps Plates outside this extension', () => {
    const get = calculate('project', {}, ['enable_wrapping_detection', 'timelapse_type']);
    expect(get('enable_wrapping_detection')).toEqual({ visible: true, readOnly: false });
    expect(get('timelapse_type').visible).toBe(true);
    expect(calculate('plate', { enable_prime_tower: '0' }, ['prime_tower_width'])('prime_tower_width')).toEqual({ visible: true, readOnly: false });
  });
});
