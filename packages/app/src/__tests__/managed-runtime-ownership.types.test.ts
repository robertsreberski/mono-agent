import { expect, it } from "vitest";

import type {
  ManagedBackgroundRuntime,
  ManagedBackgroundRuntimeDeps,
  ManagedBackgroundRuntimeInput,
  ManagedRuntimeProgress,
  SourcePackageProofEntry,
} from "../service/managed-runtime/types.js";

function assertRuntimeContracts(
  runtime: ManagedBackgroundRuntime,
  input: ManagedBackgroundRuntimeInput,
  deps: ManagedBackgroundRuntimeDeps,
  progress: ManagedRuntimeProgress,
  proof: SourcePackageProofEntry,
): void {
  // @ts-expect-error Runtime identities remain readonly.
  runtime.cliSha256 = "replacement";
  // @ts-expect-error Caller-selected additional packages remain a readonly array.
  input.additionalPackages?.push({ packageName: "fixture", packageSource: "/fictional/source" });
  // @ts-expect-error Exact optional properties cannot be explicitly undefined.
  const invalid: ManagedBackgroundRuntimeInput = { currentCliPath: "fixture", nodePath: "node", onProgress: undefined };
  // @ts-expect-error Installer dependency contracts remain readonly.
  deps.installPackage = async () => {};
  // @ts-expect-error Progress projections cannot be mutated by observers.
  progress.completed = 10;
  // @ts-expect-error Proof identities remain readonly.
  proof.ino = "replacement";
  // @ts-expect-error Verification modes remain the closed existing union.
  const invalidRuntime: ManagedBackgroundRuntime = { ...runtime, verificationMode: "unchecked" };
  void invalid;
  void invalidRuntime;
}

it("retains managed-runtime readonly, exact-optional and closed-union contracts", () => {
  expect(assertRuntimeContracts).toBeTypeOf("function");
});
