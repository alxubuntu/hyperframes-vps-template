import test from "node:test";
import assert from "node:assert/strict";
import { createProgressParser, parseRendererProgress } from "./render-progress.mjs";

test("0.4.14 reports global capture counts, not overall percentage", () => {
  assert.deepEqual(parseRendererProgress("  ███  53%  Capturing frame 60/120 (2 workers)"), { phase: "rendering", phaseProgress: 50 });
  assert.deepEqual(parseRendererProgress("Streaming frame 30/120 (2 workers)"), { phase: "rendering", phaseProgress: 25 });
  assert.deepEqual(parseRendererProgress("HDR composite frame 3/4"), { phase: "rendering", phaseProgress: 75 });
  assert.equal(parseRendererProgress("Capturing frame 121/120"), null);
  assert.equal(parseRendererProgress("Capturing frame 1/0"), null);
  assert.deepEqual(parseRendererProgress("Encoding video"), { phase: "encoding", phaseProgress: null });
});

test("parser handles split UTF-8, ANSI, carriage returns and trailing line", () => {
  const events = [];
  const parser = createProgressParser((event) => events.push(event));
  const bytes = Buffer.from("\r\x1b[2K  █  25%  Capturing frame 3/12\rEncoding video");
  for (const byte of bytes) parser.write(Buffer.from([byte]));
  parser.end();
  assert.deepEqual(events, [{ phase: "rendering", phaseProgress: 25 }, { phase: "encoding", phaseProgress: null }]);
});

test("oversized and unrecognized output is bounded and harmless", () => {
  const events = [];
  const parser = createProgressParser((event) => events.push(event));
  parser.write(Buffer.from("x".repeat(100000)));
  parser.write(Buffer.from("\rAssembling final video\n"));
  assert.deepEqual(events, [{ phase: "finalizing", phaseProgress: null }]);
});
