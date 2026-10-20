import assert from "node:assert/strict";

// Auxiliary naming is not a user turn and must never receive tool access.
export function respondToSessionName(body, response) {
  if (
    !body.messages?.some(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith("Generate a concise semantic session title"),
    )
  )
    return false;
  assert.ok(!body.tools?.length, "session naming must not receive tools");
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Fixture session" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
  return true;
}
