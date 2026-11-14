// IPC transport regression: a real shipping exception, never a synthetic stack.
import { validateRequest } from "../../../packages/conversation/dist/harness/validation.js";
import { errorDiagnostic } from "../../lib/continuity-e2-diagnostics.mjs";
process.once("message", sizing => {
  try { validateRequest({ conversationId: "fictional-canary", userMessage: "" }); }
  catch (error) {
    error.message = "fictional-canary /Users/example/private-note";
    error.code = "FICTIONAL_PRIVATE_CODE";
    const message = { type: "failure", code: "E2_PROTECTED_SIZING_INVALID", diagnostic: errorDiagnostic(error) };
    if (sizing.summary === "faux-max") {
      // Receiver must project again, even if an IPC peer sends unfiltered data.
      message.code = "FICTIONAL_PRIVATE_CODE";
      Object.assign(message.diagnostic, { errorCode: "FICTIONAL_PRIVATE_CODE", site: "/Users/example/private-note.mjs:4", message: "fictional-canary" });
    }
    process.send(message);
    process.exitCode = 1; process.disconnect();
  }
});
