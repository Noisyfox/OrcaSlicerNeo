/** User intent, independent of the current printer's effective values or delivery route. */
export type PrintCalibrationMode = 'auto' | 'on' | 'off';
export interface PrintPreferences {
  bedLeveling?: PrintCalibrationMode;
  flowCalibration?: PrintCalibrationMode;
  nozzleOffsetCalibration?: PrintCalibrationMode;
  timelapse?: boolean;
  timelapseStorage?: 'internal' | 'external';
  sharedPressureAdvance?: boolean;
}
/** Per-dialog option; deliberately excluded from persisted PrintPreferences. */
export interface PrintOptions extends PrintPreferences {
  externalChangeAssist?: boolean;
}
