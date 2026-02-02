import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type ToolId = "cryosnap" | "freeze";

export type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type ReleaseResponse = {
  tag_name?: string;
  assets?: ReleaseAsset[];
};

type ToolSpec = {
  id: ToolId;
  repo: string;
  binary: string;
};

const TOOL_SPECS: Record<ToolId, ToolSpec> = {
  cryosnap: {
    id: "cryosnap",
    repo: "Wangnov/cryosnap",
    binary: "cryosnap",
  },
  freeze: {
    id: "freeze",
    repo: "charmbracelet/freeze",
    binary: "freeze",
  },
};

const ARCH_TOKENS: Record<string, string[]> = {
  x64: ["x86_64", "amd64", "x64"],
  arm64: ["aarch64", "arm64"],
  arm: ["armv7", "armv6", "arm"],
};

const PLATFORM_TOKENS: Record<string, string[]> = {
  darwin: ["darwin", "apple-darwin", "macos", "mac"],
  linux: ["linux", "unknown-linux", "linux-gnu", "linux-musl"],
  win32: ["windows", "win32", "msvc", "pc-windows"],
};

const ARCHIVE_EXTENSIONS = [".tar.gz", ".tgz", ".zip", ".tar.xz"];

export async function installTool(params: {
  tool: ToolId;
  api: OpenClawPluginApi;
  logger: Logger;
  force?: boolean;
}): Promise<{ tool: ToolId; version?: string; path: string; asset: string }> {
  if (process.env.OPENCLAW_NIX_MODE === "1") {
    throw new Error("OPENCLAW_NIX_MODE=1; auto-install is disabled.");
  }
  const spec = TOOL_SPECS[params.tool];
  if (!spec) {
    throw new Error(`Unknown tool: ${params.tool}`);
  }

  const toolsDir = resolveToolsDir(params.api);
  await fs.mkdir(toolsDir, { recursive: true, mode: 0o700 });

  const binaryName = resolveBinaryName(spec.binary);
  const destPath = path.join(toolsDir, binaryName);
  if (!params.force) {
    try {
      await fs.access(destPath);
      params.logger.info(`Tool already installed: ${destPath}`);
      return { tool: spec.id, path: destPath, asset: binaryName };
    } catch {
      // proceed
    }
  }

  params.logger.info(`Fetching latest release for ${spec.repo}...`);
  const release = await fetchLatestRelease(spec.repo);
  const assets = release.assets ?? [];
  const selected = selectReleaseAsset({
    assets,
    binaryName: spec.binary,
  });
  if (!selected) {
    throw new Error(
      `No matching release asset found for ${spec.repo} (${process.platform}/${process.arch}).`,
    );
  }

  const tmpDir = await fs.mkdtemp(path.join(toolsDir, `.tmp-${spec.id}-`));
  try {
    const downloadPath = path.join(tmpDir, selected.name);
    params.logger.info(`Downloading ${selected.name}...`);
    await downloadFile(selected.browser_download_url, downloadPath);

    const extracted = await extractIfNeeded(params.api, downloadPath, tmpDir);
    const binPath = extracted
      ? await findBinary(tmpDir, binaryName)
      : downloadPath;

    if (!binPath) {
      throw new Error(`Binary ${binaryName} not found in extracted archive.`);
    }

    await fs.copyFile(binPath, destPath);
    if (process.platform !== "win32") {
      await fs.chmod(destPath, 0o755);
    }

    params.logger.info(`Installed ${spec.id} -> ${destPath}`);
    return {
      tool: spec.id,
      version: release.tag_name,
      path: destPath,
      asset: selected.name,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export async function removeTool(params: {
  tool: ToolId;
  api: OpenClawPluginApi;
  logger: Logger;
}): Promise<{ tool: ToolId; path: string; removed: boolean }> {
  const spec = TOOL_SPECS[params.tool];
  if (!spec) {
    throw new Error(`Unknown tool: ${params.tool}`);
  }
  const toolsDir = resolveToolsDir(params.api);
  const binaryName = resolveBinaryName(spec.binary);
  const destPath = path.join(toolsDir, binaryName);
  try {
    await fs.access(destPath);
  } catch {
    params.logger.info(`Tool not found: ${destPath}`);
    return { tool: spec.id, path: destPath, removed: false };
  }
  await fs.rm(destPath, { force: true });
  params.logger.info(`Removed ${spec.id} -> ${destPath}`);
  return { tool: spec.id, path: destPath, removed: true };
}

function resolveToolsDir(api: OpenClawPluginApi): string {
  const stateDir = resolveStateDir(api);
  return path.join(stateDir, "tools");
}

function resolveStateDir(api: OpenClawPluginApi): string {
  const resolver = api.runtime?.state?.resolveStateDir;
  if (typeof resolver === "function") {
    return resolver();
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveBinaryName(base: string): string {
  if (process.platform === "win32") {
    return `${base}.exe`;
  }
  return base;
}

async function fetchLatestRelease(repo: string): Promise<ReleaseResponse> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "openclaw-tmux-watch",
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub release fetch failed (${response.status}): ${body}`);
  }
  return (await response.json()) as ReleaseResponse;
}

export function selectReleaseAsset(params: {
  assets: ReleaseAsset[];
  binaryName: string;
  platform?: string;
  arch?: string;
}): ReleaseAsset | null {
  const platform = params.platform ?? process.platform;
  const arch = params.arch ?? process.arch;
  const assets = params.assets ?? [];
  let best: { asset: ReleaseAsset; score: number } | null = null;

  for (const asset of assets) {
    const score = scoreAsset(asset.name, params.binaryName, platform, arch);
    if (score <= 0) {
      continue;
    }
    if (!best || score > best.score) {
      best = { asset, score };
    }
  }

  return best?.asset ?? null;
}

function scoreAsset(
  name: string,
  binaryName: string,
  platform: string,
  arch: string,
): number {
  const lowered = name.toLowerCase();
  if (/(sha256|checksums|sbom|sig|signature|\.txt)$/.test(lowered)) {
    return 0;
  }

  const platformTokens = PLATFORM_TOKENS[platform] ?? [];
  const archTokens = ARCH_TOKENS[arch] ?? [];

  let score = 0;
  if (lowered.includes(binaryName)) {
    score += 2;
  }
  for (const token of platformTokens) {
    if (lowered.includes(token)) {
      score += 3;
      break;
    }
  }
  for (const token of archTokens) {
    if (lowered.includes(token)) {
      score += 2;
      break;
    }
  }
  if (ARCHIVE_EXTENSIONS.some((ext) => lowered.endsWith(ext))) {
    score += 1;
  }
  return score;
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url, { headers: { "User-Agent": "openclaw-tmux-watch" } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Download failed (${response.status}): ${body}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destPath, buffer);
}

async function extractIfNeeded(
  api: OpenClawPluginApi,
  archivePath: string,
  destDir: string,
): Promise<boolean> {
  const lowered = archivePath.toLowerCase();
  if (lowered.endsWith(".zip")) {
    await runCommand(api, ["unzip", "-o", archivePath, "-d", destDir]);
    return true;
  }
  if (lowered.endsWith(".tar.gz") || lowered.endsWith(".tgz")) {
    await runCommand(api, ["tar", "-xzf", archivePath, "-C", destDir]);
    return true;
  }
  if (lowered.endsWith(".tar.xz")) {
    await runCommand(api, ["tar", "-xJf", archivePath, "-C", destDir]);
    return true;
  }
  return false;
}

async function runCommand(api: OpenClawPluginApi, argv: string[]): Promise<void> {
  const result = await api.runtime.system.runCommandWithTimeout(argv, {
    timeoutMs: 120_000,
  });
  if (result.code !== 0) {
    throw new Error(`Command failed: ${argv.join(" ")}\n${result.stderr ?? ""}`.trim());
  }
}

async function findBinary(dir: string, binaryName: string): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "__MACOSX") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === binaryName) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const nested = await findBinary(fullPath, binaryName);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}
