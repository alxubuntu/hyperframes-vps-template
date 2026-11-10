import { StringDecoder } from "node:string_decoder";

// hyperframes 0.4.14's CLI writes progress bars to stdout with CR separators.
// The printed percentage is an internal weighted total; frame counts are global.
export function parseRendererProgress(line) {
  const clean = line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
  const frame = /\b(?:Capturing|Streaming|HDR composite) frame (\d+)\/(\d+)\b/.exec(clean);
  if (frame) {
    const done = Number(frame[1]);
    const total = Number(frame[2]);
    if (Number.isSafeInteger(done) && Number.isSafeInteger(total) && total > 0 && done <= total) {
      return { phase: "rendering", phaseProgress: Math.floor(done * 100 / total) };
    }
    return null;
  }
  if (clean.includes("Starting frame capture")) return { phase: "rendering", phaseProgress: null };
  if (clean.includes("Encoding video")) return { phase: "encoding", phaseProgress: null };
  if (clean.includes("Assembling final video")) return { phase: "finalizing", phaseProgress: null };
  if (/Compiling composition|Extracting video frames|Processing audio tracks/.test(clean)) {
    return { phase: "preparing", phaseProgress: null };
  }
  return null;
}

export function createProgressParser(onEvent) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  function feed(text) {
    pending += text;
    const lines = pending.split(/[\r\n]/);
    pending = lines.pop();
    for (const line of lines) {
      const event = parseRendererProgress(line);
      if (event) onEvent(event);
    }
    if (pending.length > 8192) pending = pending.slice(-8192);
  }
  return {
    write(chunk) { feed(decoder.write(chunk)); },
    end() { feed(decoder.end() + "\n"); },
  };
}
