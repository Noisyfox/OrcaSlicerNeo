# Middle-mouse panning

Date: 2026-08-22

## Change

The viewport's OrbitControls mapping previously used **middle-drag = zoom**
(`THREE.MOUSE.DOLLY`). Middle-drag now **pans** the camera
(`THREE.MOUSE.PAN`), matching the upstream OrcaSlicer default
(`middle_mouse_drag_action = "1"` → Pan in `libslic3r/AppConfig.cpp`; the C++
`GLCanvas3D` `MouseAction` enum orders `None, Pan, Rotation`).

Final mapping in `packages/slicer-app/src/components/workspace/viewport/Viewport.tsx`:

| Button | Drag action |
|---|---|
| Left | Orbit (rotate) |
| Middle | Pan |
| Right | Pan (unchanged; the scene context menu still opens on right-button release without movement) |
| Wheel | Zoom (OrbitControls default, unchanged) |

No e2e or unit test depended on middle-drag zoom, and right-drag panning (used
by `SceneContextMenu`'s open-on-release logic) is untouched.
