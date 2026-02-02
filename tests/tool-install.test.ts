import assert from "node:assert/strict";
import test from "node:test";
import { selectReleaseAsset } from "../src/tool-install.js";

const ASSETS = [
  {
    name: "freeze_0.2.2_Linux_x86_64.tar.gz",
    browser_download_url: "https://example.com/linux-x86_64",
  },
  {
    name: "freeze_0.2.2_Darwin_arm64.tar.gz",
    browser_download_url: "https://example.com/darwin-arm64",
  },
  {
    name: "freeze_0.2.2_Darwin_x86_64.tar.gz",
    browser_download_url: "https://example.com/darwin-x86_64",
  },
  {
    name: "freeze_0.2.2_checksums.txt",
    browser_download_url: "https://example.com/checksums",
  },
];

test("selectReleaseAsset picks matching platform/arch", () => {
  const asset = selectReleaseAsset({
    assets: ASSETS,
    binaryName: "freeze",
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(asset?.name, "freeze_0.2.2_Darwin_arm64.tar.gz");
});

test("selectReleaseAsset skips checksum assets", () => {
  const asset = selectReleaseAsset({
    assets: [
      { name: "freeze_0.2.2_checksums.txt", browser_download_url: "https://x" },
    ],
    binaryName: "freeze",
    platform: "linux",
    arch: "x64",
  });
  assert.equal(asset, null);
});
