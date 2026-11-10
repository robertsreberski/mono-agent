// File identity survives attachment normalization/recovery through the adapter.
const durations = new WeakMap<File, number>();
export function noteRecordingDuration(file: File, seconds: number): void {
  if (Number.isFinite(seconds) && seconds > 0) durations.set(file, seconds);
}
export const recordingDuration = (file?: File): number | undefined => file && durations.get(file);
