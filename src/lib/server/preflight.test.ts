import { describe, expect, it } from "vitest";
import { bufferToBase64Chunked } from "../encoding";
import { preflight } from "./preflight.mjs";

const encoder = new TextEncoder();
const utf8 = (value: string) => encoder.encode(value);
const b64 = (bytes: Uint8Array) => bufferToBase64Chunked(bytes);
const enc = (value: string) => ({ path: "index.html", bytes: utf8(value) });
const root = (
  attrs = 'data-composition-id="x" data-root="true" data-width="1280" data-height="720" data-duration="3"',
) => `<div ${attrs}></div>`;

// A real woff2 starts with the "wOF2" magic; the preflight checks it.
const fontBytes = new Uint8Array(36);
fontBytes.set([0x77, 0x4f, 0x46, 0x32]);
const woff2 = b64(fontBytes);

describe("preflight", () => {
  it("accepts a self-contained composition", () => {
    const html = `<style>@font-face{font-family:'M';src:url(data:font/woff2;base64,${woff2})}</style>
      <script src="/_hyperframes/gsap.min.js"></script>
      <p style="font-family:'M'">hi</p>${root()}`;
    expect(preflight([enc(html)]).ok).toBe(true);
  });

  it("rejects an external image", () => {
    const verdict = preflight([enc(`${root()}<img src="https://cdn.example.com/a.png">`)]);
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.map((issue) => issue.code)).toContain("external-url");
  });

  it("rejects an external css url()", () => {
    const verdict = preflight([enc(`<style>body{background:url(https://x.com/a.png)}</style>${root()}`)]);
    expect(verdict.issues.map((issue) => issue.code)).toContain("external-url");
  });

  it("rejects an asset that does not travel with the payload", () => {
    const verdict = preflight([enc(`${root()}<img src="assets/logo.png">`)]);
    expect(verdict.issues.map((issue) => issue.code)).toContain("missing-asset");
  });

  it("accepts an asset that does travel with the payload", () => {
    const files = [enc(`${root()}<img src="assets/logo.png">`), { path: "assets/logo.png", bytes: utf8("x") }];
    expect(preflight(files).ok).toBe(true);
  });

  it("requires the root contract", () => {
    expect(preflight([enc("<p>no root</p>")]).issues.map((issue) => issue.code)).toContain("missing-root");
    expect(
      preflight([enc(root('data-composition-id="x" data-root="true"'))]).issues.map((issue) => issue.code),
    ).toContain("missing-root");
  });

  it("rejects truncated base64", () => {
    const verdict = preflight([enc(`${root()}<img src="data:image/png;base64,AAA">`)]);
    expect(verdict.issues.map((issue) => issue.code)).toContain("bad-base64");
  });

  it("rejects a font whose bytes are not that format", () => {
    const fake = b64(utf8("not a font"));
    const html = `<style>@font-face{font-family:'F';src:url(data:font/woff2;base64,${fake})}</style>${root()}`;
    expect(preflight([enc(html)]).issues.map((issue) => issue.code)).toContain("bad-font");
  });

  it("warns about a font the container will not have", () => {
    const verdict = preflight([enc(`<p style="font-family: system-ui">x</p>${root()}`)]);
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings.map((warning) => warning.code)).toContain("system-font");
  });

  it("handles a multi-megabyte document without overflowing the stack", () => {
    const verdict = preflight([enc(`${root()}<!--${"x".repeat(6 * 1024 * 1024)}-->`)]);
    expect(verdict.ok).toBe(true);
  });
});
