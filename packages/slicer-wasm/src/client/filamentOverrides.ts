/** Dedicated Setting Overrides allow-list, matching TabFilament's three groups. */
export const FILAMENT_OVERRIDE_KEYS = [
  'filament_retraction_length', 'filament_z_hop', 'filament_z_hop_types',
  'filament_retract_lift_above', 'filament_retract_lift_below', 'filament_retract_lift_enforce',
  'filament_retraction_speed', 'filament_deretraction_speed', 'filament_retract_restart_extra',
  'filament_retraction_minimum_travel', 'filament_retract_when_changing_layer', 'filament_wipe',
  'filament_wipe_distance', 'filament_retract_before_wipe', 'filament_retract_after_wipe',
  'filament_long_retractions_when_cut', 'filament_retraction_distances_when_cut',
  'filament_retract_length_toolchange', 'filament_retract_restart_extra_toolchange',
  'filament_ironing_flow', 'filament_ironing_spacing', 'filament_ironing_inset', 'filament_ironing_speed',
] as const;
