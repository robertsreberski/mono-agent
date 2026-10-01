import { describe, expect, it } from "vitest";
import { validWakeCertificates, validWakeFence } from "../process-jobs-wake-fence.js";

const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const boundary = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("private v1 wake proof validation", () => {
  it("accepts only bounded exact versioned states and identities", () => {
    expect(validWakeFence({ version: 1, token, state: "not_crossed" })).toBe(true);
    expect(validWakeFence({ version: 1, token, state: "crossed", boundary })).toBe(true);
    expect(validWakeFence({ version: 1, token, state: "fenced" })).toBe(true);
    expect(validWakeFence({ version: 1, token, state: "crossed", boundary, legacy: true })).toBe(true);
    expect(validWakeFence({ version: 1, token, state: "not_crossed", legacy: false })).toBe(false);
    for (const invalid of [undefined, {}, { version: 2, token, state: "not_crossed" },
      { version: 1, token: "-".repeat(36), state: "not_crossed" },
      { version: 1, token, state: "crossed" },
      { version: 1, token, state: "not_crossed", boundary },
      { version: 1, token, state: "fenced", admitted: false }]) {
      expect(validWakeFence(invalid)).toBe(false);
    }
    expect(validWakeCertificates([])).toBe(true);
    expect(validWakeCertificates([token])).toBe(true);
    expect(validWakeCertificates([token, token])).toBe(false);
    expect(validWakeCertificates(Array.from({ length: 17 }, (_, i) => `${i.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`))).toBe(false);
  });
});
