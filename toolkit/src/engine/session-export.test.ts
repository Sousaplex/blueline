import assert from "node:assert/strict";
import { test } from "node:test";
import { flatten } from "./session-export.ts";

test("flatten extracts assistant text + tool call with args", () => {
  const e = flatten({
    type: "message",
    timestamp: "2026-07-27T00:00:00Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Drafting the page." },
        { type: "tool_use", name: "render", input: { round: 1 } },
      ],
    },
  });
  assert.equal(e.type, "message");
  assert.equal(e.role, "assistant");
  assert.equal(e.text, "Drafting the page.");
  assert.equal(e.tool, "render");
  assert.deepEqual(e.args, { round: 1 });
  assert.equal(e.timestamp, "2026-07-27T00:00:00Z");
});

test("flatten handles this Pi build's toolCall/toolResult/image shapes", () => {
  const call = flatten({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I'll grab the logo." },
        { type: "toolCall", id: "t1", name: "fetch_image", arguments: { url: "https://x.com/logo.png", into: "brand" } },
      ],
    },
  });
  assert.equal(call.tool, "fetch_image");
  assert.deepEqual(call.args, { url: "https://x.com/logo.png", into: "brand" });
  assert.equal(call.thinking, "I'll grab the logo.");

  const res = flatten({
    type: "message",
    message: { role: "toolResult", content: [{ type: "text", text: "Saved brand/logo.png" }, { type: "image", mimeType: "image/png", data: "AAAA" }] },
  });
  assert.match(res.result ?? "", /Saved brand\/logo\.png/);
  assert.match(res.result ?? "", /\[image: image\/png/);
});

test("flatten extracts a tool result (array content)", () => {
  const e = flatten({
    type: "message",
    message: { role: "tool", content: [{ type: "tool_result", content: [{ type: "text", text: "ok, 2 issues" }] }] },
  });
  assert.equal(e.result, "ok, 2 issues");
});

test("flatten captures thinking and a plain-string content", () => {
  const think = flatten({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } });
  assert.equal(think.thinking, "hmm");
  const str = flatten({ type: "message", message: { role: "user", content: "read brief.md" } });
  assert.equal(str.text, "read brief.md");
  assert.equal(str.role, "user");
});

test("flatten summarizes non-message entries and always keeps raw", () => {
  const c = flatten({ type: "compaction", summary: "trimmed", tokensBefore: 120000 });
  assert.match(c.note ?? "", /compaction/);
  assert.match(c.note ?? "", /120000/);
  const m = flatten({ type: "model_change", provider: "anthropic", modelId: "claude-sonnet-4-5" });
  assert.match(m.note ?? "", /anthropic\/claude-sonnet-4-5/);
  assert.ok(c.raw && m.raw, "raw entry preserved for lossless analysis");
});
