import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { mcpAppAuditStorageFor } from "../mcp-apps/audit-storage.js";

it("shares inventory, quota and protected reservations across concurrent same-root clients and recreation", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-audit-clients-"));
  const firstOwner = join(root, randomUUID());
  const secondOwner = join(root, randomUUID());
  await Promise.all([mkdir(firstOwner), mkdir(secondOwner)]);
  let inventories = 0;
  let unblock!: () => void;
  const barrier = new Promise<void>((resolve) => { unblock = resolve; });
  let entered!: () => void;
  const inventoryEntered = new Promise<void>((resolve) => { entered = resolve; });
  const beforeOperation = async (operation: string, path: string) => {
    if (operation === "readdir" && path === root) {
      inventories += 1;
      entered();
      await barrier;
    }
  };
  const options = { maxBytes: 2_048, fileMaxBytes: 1_024, retainedFiles: 1 };
  const protectedOwner = (directory: string) => directory === firstOwner || directory === secondOwner;
  const first = mcpAppAuditStorageFor(root, options, beforeOperation, (directory) => protectedOwner(directory));
  const second = mcpAppAuditStorageFor(root, options, beforeOperation, (directory) => protectedOwner(directory));
  const line = `${"x".repeat(511)}\n`;
  try {
    const one = first.reserveAppend(firstOwner, line, 512);
    await inventoryEntered;
    const two = second.reserveAppend(secondOwner, line, 512);
    unblock();
    const reservations = await Promise.all([one, two]);
    expect(inventories).toBe(1);
    await expect(second.reserveAppend(firstOwner, line, 512)).rejects.toThrow("MCP App audit storage is full.");
    await Promise.all(reservations.map(async (reservation) => await reservation.append(line)));
    expect((await readFile(join(firstOwner, "audit.jsonl"))).length).toBe(1_024);
    expect((await readFile(join(secondOwner, "audit.jsonl"))).length).toBe(1_024);
    first.dispose();
    const recreated = mcpAppAuditStorageFor(root, options, beforeOperation, protectedOwner);
    try {
      await expect(recreated.reserveAppend(secondOwner, line, 512)).rejects.toThrow("MCP App audit storage is full.");
      expect(inventories).toBe(1);
    } finally {
      recreated.dispose();
    }
  } finally {
    unblock();
    first.dispose();
    second.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
