import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

// Current PDF.js uses paintImageXObject for both PNG and JPEG. Recognize the
// separate legacy JPEG operator too, when exposed by the installed version.
const jpegOperator = (OPS as Readonly<Record<string, number | undefined>>).paintJpegXObject;
export const isPdfImageOperator = (operator: number): boolean =>
  operator === OPS.paintImageXObject || (jpegOperator !== undefined && operator === jpegOperator);

/** Normalize PDF.js CSS-hex or byte RGB operands to one explicit representation. */
export function pdfRgbColor(operands: readonly unknown[]): number[] {
  const first = operands[0];
  if (typeof first === "string" && /^#[\da-f]{6}$/iu.test(first)) {
    return [1, 3, 5].map((offset) => Number.parseInt(first.slice(offset, offset + 2), 16));
  }
  const values = Array.isArray(first) || first instanceof Uint8Array || first instanceof Uint8ClampedArray
    ? Array.from(first as ArrayLike<unknown>) : [...operands];
  if (values.length === 3 && values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 255)) return values as number[];
  throw new Error("Unexpected PDF.js RGB operands");
}
