/** Modulated synthetic tone (seven seconds by default); no device/provider audio. */
export function syntheticAudio(seconds = 7): Uint8Array<ArrayBuffer> {
  const rate = 3000; const samples = rate * seconds;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.sin(i / rate * 2 * Math.PI * 440) * (0.1 + 0.6 * Math.sin(i / rate * 3 * (7 / seconds)) ** 2) * 32767, true);
  return bytes;
}
