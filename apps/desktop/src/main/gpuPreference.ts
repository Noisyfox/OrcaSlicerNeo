/**
 * Ask Chromium to prefer a discrete/high-performance GPU when one is
 * available. This is a startup preference only: Chromium may ignore it when
 * no discrete adapter exists or when the adapter is unavailable, preserving
 * its normal GPU/software fallback behavior.
 */
export const HIGH_PERFORMANCE_GPU_SWITCH = 'force_high_performance_gpu';

export interface CommandLineSwitchAppender {
  appendSwitch(name: string, value?: string): void;
}

export function preferHighPerformanceGpu(commandLine: CommandLineSwitchAppender): void {
  commandLine.appendSwitch(HIGH_PERFORMANCE_GPU_SWITCH);
}
