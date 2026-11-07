/** Persistent device settings, separate from local send defaults and per-job options. */
import type { Reading } from './common';
export type DevicePreferenceKey = 'detectionEnabled' | 'spaghettiDetection' | 'spaghettiSensitivity' | 'foreignObjectDetection' | 'foreignObjectSensitivity' | 'airPrintingDetection' | 'airPrintingSensitivity' | 'autoRefill' | 'allowDifferentColors' | 'lightsOffAfterPrint';
export type DevicePreferenceValue = boolean | 'low' | 'medium' | 'high';
export interface DevicePreferenceField {
  key: DevicePreferenceKey;
  label: string;
  choices: readonly DevicePreferenceValue[];
  value: Reading<DevicePreferenceValue>;
}
export interface DevicePreferences { fields: readonly DevicePreferenceField[] }
