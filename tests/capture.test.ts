import assert from "node:assert/strict";
import test from "node:test";
import {
  pickTool,
  resolveCaptureFormat,
  resolveImageFormat,
} from "../src/capture.js";

test("resolveCaptureFormat defaults to text when no output path", () => {
  assert.equal(resolveCaptureFormat(undefined, undefined), "text");
});

test("resolveCaptureFormat defaults to image when output path provided", () => {
  assert.equal(resolveCaptureFormat(undefined, "/tmp/out.png"), "image");
});

test("resolveImageFormat prefers explicit value", () => {
  assert.equal(resolveImageFormat("svg", undefined), "svg");
});

test("resolveImageFormat derives from output extension", () => {
  assert.equal(resolveImageFormat(undefined, "/tmp/out.webp"), "webp");
});

test("pickTool prefers cryosnap over freeze", () => {
  const tool = pickTool([
    { id: "freeze", path: "/bin/freeze", source: "path" },
    { id: "cryosnap", path: "/bin/cryosnap", source: "path" },
  ]);
  assert.equal(tool?.id, "cryosnap");
});
