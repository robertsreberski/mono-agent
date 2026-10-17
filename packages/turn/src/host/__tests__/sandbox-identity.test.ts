import { describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { MANAGED_SRT_LOCK_SHA256, MANAGED_SRT_TREE_SHA256, managedSrtCacheRoot, managedSrtInstallRoot, type ManagedSrtMarker } from "@mono-agent/turn/host/sandbox";

vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => { throw new Error("HOME unavailable"); }) };
});

describe("managed SRT identity", () => {
  it("does not ask for a home directory when absolute XDG is available", () => {
    vi.mocked(homedir).mockClear();
    expect(managedSrtCacheRoot({ env: { XDG_CACHE_HOME: "/fictional/cache" } })).toBe("/fictional/cache");
    expect(homedir).not.toHaveBeenCalled();
  });

  it("keeps platform, explicit and absolute-XDG cache identities", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const homeDir = "/fictional/home";
      const fallback = resolve(homeDir, platform === "darwin" ? "Library/Caches" : ".cache");
      for (const XDG_CACHE_HOME of [undefined, "", "  ", "relative/cache"]) {
        expect(managedSrtCacheRoot({ platform, homeDir, env: { XDG_CACHE_HOME } })).toBe(fallback);
      }
      expect(managedSrtCacheRoot({ platform, homeDir, env: { XDG_CACHE_HOME: " /fictional/cache " } })).toBe("/fictional/cache");
      expect(managedSrtInstallRoot({ platform, cacheRoot: "/fictional/explicit" })).toBe(resolve("/fictional/explicit", "mono-agent/tools/srt/0.0.64", MANAGED_SRT_LOCK_SHA256));
    }
  });

  it("retains literal and readonly marker guarantees with an explicit fixture shape", () => {
    if (false) {
      const marker = null as unknown as ManagedSrtMarker;
      // @ts-expect-error markers remain readonly.
      marker.cliSha256 = "changed";
      // @ts-expect-error runtime markers require the independent release pin.
      const wrongPin: ManagedSrtMarker["treeSha256"] = "fixture";
      // @ts-expect-error marker fields remain required.
      const incomplete: ManagedSrtMarker = { schemaVersion: 2 };
      const fixture: ManagedSrtMarker<string> = { ...marker, treeSha256: "fixture" };
      const pin: typeof MANAGED_SRT_TREE_SHA256 = marker.treeSha256;
      void [wrongPin, incomplete, fixture, pin];
    }
    expect(MANAGED_SRT_TREE_SHA256).toBe("a6302340f9754fbb4fab32e3bc636a6d05e389ad338a7bc6b98c71a9f3609649");
  });
});
