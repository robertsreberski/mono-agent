import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ToolHistoryReader } from "@mono-agent/conversation";
import { createJsonlRunRecorder } from "@mono-agent/observability";
import { handleHistoryRequest } from "../request-tools/history.js";
const body = (result: any) => result.structuredContent;
it("round-trips cursor-only run navigation without treating the cursor as authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "history-cursor-"));
  try {
    for (const [runId, conversationId] of [["old","web:fiction"],["foreign","web:other"],["current","web:fiction"]]) {
      const recorder = createJsonlRunRecorder({artifactDir:root,runId:runId!,conversationId:conversationId!});
      for (let i=0;i<25;i++) recorder.onEvent({type:"warning",message:`Fictional warning ${i}`});
      await recorder.finish({text:"Fictional done."});
    }
    const binding = {reader:new ToolHistoryReader(join(root,"history")),artifactDir:root,conversationId:"web:fiction",logicalConversationId:"web:fiction",runId:"current",scopes:["runs"] as const};
    const call = async (args: object) => body(await handleHistoryRequest(binding,{scope:"runs",...args}));
    const overview = await call({action:"get",runId:"old"});
    const next = overview.navigation.nextActions[0].arguments;
    expect(next).toEqual({scope:"runs",action:"get",cursor:overview.nextCursor});
    const page = await call(next); expect(page.view).toBe("timeline");
    expect(await call({...next,runId:"old"})).toEqual(page);
    expect((await call({...next,runId:"foreign"})).error.code).toBe("invalid_cursor");
    const alter = (patch: object) => Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(next.cursor,"base64url").toString()),...patch})).toString("base64url");
    for (const cursor of ["not-json",alter({kind:"list"}),alter({runId:"foreign"}),alter({runId:"current"})]) {
      const denied = await call({action:"get",cursor}); expect(denied.error).toBeDefined(); expect(JSON.stringify(denied)).not.toContain("Fictional warning");
    }
    if (page.nextCursor) expect(page.navigation.nextActions[0].arguments).toEqual({scope:"runs",action:"get",cursor:page.nextCursor});
  } finally {await rm(root,{recursive:true,force:true});}
});
