// Stable UI-independent entry point for Step 4 callers. The implementation
// lives at the shared app boundary so hosts and dialogs use one transaction.
export {
  importProjectGeometry,
  newProject,
  openProject,
  saveProject,
  saveProjectAs,
  cancelProjectOperation,
} from '../../../projectActions';
export type { ProjectActionOptions, ProjectActionResult } from '../../../projectActions';
