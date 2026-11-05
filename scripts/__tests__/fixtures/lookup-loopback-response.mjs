import { createServer } from "node:http";
export async function loopbackResponse() {
  const server = createServer(async (req, res) => {
    try {
      for await (const _ of req) {} // Drain, never retain or export request content.
      const item = {type: "message", id: "fictional-message", role: "assistant", status: "completed", content: [{type: "output_text", text: "Fictional answer.", annotations: []}]};
      const events = [{type: "response.output_item.added", output_index: 0, item: {...item, content: []}},
        {type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "Fictional answer."},
        {type: "response.output_item.done", output_index: 0, item},
        {type: "response.completed", response: {id: "fictional-response", status: "completed", output: [item], service_tier: "default", usage: {input_tokens: 10, output_tokens: 5}}}];
      res.writeHead(200, {"content-type": "text/event-stream"}); res.end(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
    } catch { res.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server;
}
