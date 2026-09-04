# 3MF Project Persistence

**Status:** Approved — implementation basis  
**Scope:** Single-plate 3MF project open/save in the shared Electron and Web application.

## Project-open behaviour

3MF project opening follows the current OrcaSlicer load-behaviour policy.

- The saved preference is one of **Load All**, **Ask When Relevant**,
  **Always Ask**, or **Load Geometry Only**. The default is **Ask When
  Relevant**.
- **Load All** opens the selected 3MF as a project: it replaces the current
  project and restores eligible project settings.
- **Load Geometry Only** imports only model geometry and layout, appending it
  to the current scene without replacing the current project settings.
- **Ask When Relevant** shows a choice only when the current scene already
  contains a model; otherwise it opens the selected 3MF as a project.
- **Always Ask** shows a choice for every selected 3MF.
- The choice presents **Open as project** and **Import geometry only**;
  **Import geometry only** is the initial selection. Cancelling leaves the
  current session unchanged.
- Opening as a project first applies the normal unsaved-work and modified
  preset protections before replacing the current project. Importing geometry
  only does not replace the existing scene.

## Compatibility and fallback

- The application identifies whether a 3MF carries supported Orca project
  settings, BambuStudio project settings, generic 3MF geometry, or settings
  that cannot be safely restored by this application version.
- A generic 3MF, missing project settings, unsupported settings, or an
  incompatible project version falls back to geometry-only import following
  the current OrcaSlicer policy.
- The application presents the reason for that fallback. It does not request
  an additional confirmation before continuing.
- A failed parse or cancelled operation is atomic: the current session stays
  unchanged.

## Project-save behaviour

- **Save Project** writes an Orca/Bambu-compatible BBS 3MF file with the
  `.3mf` extension. It preserves the single-plate model, object and part
  semantics, instance layout, and eligible project settings.
- Normal project saves do not embed a slice result, G-code, or thumbnails.
  G-code export and send-to-printer remain independent operations.
- Electron provides **Save Project** and **Save Project As…**. Save Project
  overwrites the current project file when the host has an in-memory source
  path; Save Project As… selects a new path.
- The Web host provides **Save Project** as a new `.3mf` download on every
  invocation. It does not attempt to overwrite a previously downloaded file.
- The project file path is host-private, in-memory session data. It is not
  stored in shared preferences or made available to the shared application.
