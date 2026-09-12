# Multi-filament G-code Preview regression

Date: 2026-09-12
Status: In progress

## Accepted behavior

Two scene cubes assigned to different filament slots must retain both native
tool IDs in the threaded slice result. Preview's Filament / Tool scheme must
use the two active slot colours, and emitted G-code must still contain both
tools and remain printer-local.

## Orca source decision

The pinned Orca path is `BackgroundSlicingProcess::process_fff()` →
`Print::export_gcode(..., m_gcode_result)` → streaming
`GCodeProcessorResult` → GCodeViewer. For a sliced project, Orca's
`Plater::get_extruder_colors_from_plater_config()` supplies the active project
`filament_colour` palette; it does not infer colours from object geometry or
rebuild a frontend palette. Neo therefore reads the palette from the active
`PresetBundle::project_config`, while the active `Print` remains responsible
for plate-local geometry and exported G-code. The result sink is only the
standalone-G-code fallback.
