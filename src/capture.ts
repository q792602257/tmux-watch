import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { TmuxWatchConfig } from "./config.js";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripAnsi, truncateOutput } from "./text-utils.js";
import { resolveBinaryName, resolveToolsDir, type ToolId } from "./tool-install.js";

export type CaptureFormat = "text" | "image" | "both";
export type ImageFormat = "png" | "svg" | "webp";

export type CaptureParams = {
  target: string;
  socket?: string;
  captureLines?: number;
  stripAnsi?: boolean;
  format?: string;
  imageFormat?: string;
  outputPath?: string;
  base64?: boolean;
  ttlSeconds?: number;
  maxChars?: number;
};

export type CaptureResult = {
  target: string;
  format: CaptureFormat;
  capturedAt: string;
  text?: string;
  textTruncated?: boolean;
  imagePath?: string;
  imageTool?: ToolId;
  imageFormat?: ImageFormat;
  imageBase64?: string;
  temporary?: boolean;
  ttlSeconds?: number;
};

type ToolLocation = {
  id: ToolId;
  path: string;
  source: "path" | "user-bin" | "openclaw";
};

const DEFAULT_TTL_SECONDS = 600;
const TEMP_DIR_NAME = "openclaw-tmux-watch";

export function resolveCaptureFormat(raw?: string, outputPath?: string): CaptureFormat {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "text" || value === "image" || value === "both") {
    return value;
  }
  if (outputPath && outputPath.trim()) {
    return "image";
  }
  return "text";
}

export function resolveImageFormat(raw?: string, outputPath?: string): ImageFormat {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "png" || value === "svg" || value === "webp") {
    return value;
  }
  const ext = outputPath ? path.extname(outputPath).slice(1).toLowerCase() : "";
  if (ext === "png" || ext === "svg" || ext === "webp") {
    return ext as ImageFormat;
  }
  return "png";
}

export function pickTool(candidates: ToolLocation[]): ToolLocation | null {
  const cryosnap = candidates.find((tool) => tool.id === "cryosnap");
  if (cryosnap) {
    return cryosnap;
  }
  const freeze = candidates.find((tool) => tool.id === "freeze");
  return freeze ?? null;
}

export async function captureTmux(params: {
  api: OpenClawPluginApi;
  config: TmuxWatchConfig;
} & CaptureParams): Promise<CaptureResult> {
  const target = params.target.trim();
  if (!target) {
    throw new Error("target required for capture");
  }
  const socket = normalizeSocket(params.socket ?? params.config.socket);
  const format = resolveCaptureFormat(params.format, params.outputPath);
  const captureLines = resolveCaptureLines(params.captureLines, params.config);
  const stripOutput = resolveStripAnsi(params.stripAnsi, params.config);
  const includeAnsi = format !== "text" || !stripOutput;

  const rawOutput = await capturePaneOutput({
    api: params.api,
    target,
    socket,
    captureLines,
    includeAnsi,
  });

  const capturedAt = new Date().toISOString();
  const result: CaptureResult = {
    target,
    format,
    capturedAt,
  };

  if (format !== "image") {
    let text = rawOutput;
    if (stripOutput) {
      text = stripAnsi(text);
    }
    const maxChars = resolveMaxChars(params.maxChars, params.config);
    if (maxChars > 0) {
      const outputInfo = truncateOutput(text, maxChars);
      result.text = outputInfo.text;
      result.textTruncated = outputInfo.truncated;
    } else {
      result.text = text;
      result.textTruncated = false;
    }
  }

  if (format !== "text") {
    const imageFormat = resolveImageFormat(params.imageFormat, params.outputPath);
    const ttlSeconds = resolveTtlSeconds(params.ttlSeconds);
    const image = await renderImage({
      api: params.api,
      output: rawOutput,
      imageFormat,
      outputPath: params.outputPath,
      ttlSeconds,
    });
    result.imagePath = image.path;
    result.imageTool = image.tool;
    result.imageFormat = imageFormat;
    result.temporary = image.temporary;
    result.ttlSeconds = image.temporary ? ttlSeconds : undefined;
    if (params.base64) {
      const bytes = await fs.readFile(image.path);
      result.imageBase64 = bytes.toString("base64");
    }
  }

  return result;
}

type CapturePaneParams = {
  api: OpenClawPluginApi;
  target: string;
  socket?: string;
  captureLines: number;
  includeAnsi: boolean;
};

async function capturePaneOutput(params: CapturePaneParams): Promise<string> {
  const argv = params.socket
    ? ["tmux", "-S", params.socket, "capture-pane", "-p", "-J", "-t", params.target]
    : ["tmux", "capture-pane", "-p", "-J", "-t", params.target];
  if (params.includeAnsi) {
    argv.push("-e");
  }
  if (params.captureLines > 0) {
    argv.push("-S", `-${params.captureLines}`);
  }

  try {
    const result = await params.api.runtime.system.runCommandWithTimeout(argv, {
      timeoutMs: 5000,
    });
    if (result.code !== 0) {
      const err = (result.stderr ?? result.stdout ?? "").trim();
      throw new Error(err ? `tmux capture failed: ${err}` : "tmux capture failed");
    }
    let output = result.stdout ?? "";
    output = output.replace(/\r\n/g, "\n").trimEnd();
    return output;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`tmux capture failed: ${message}`);
  }
}

type RenderImageParams = {
  api: OpenClawPluginApi;
  output: string;
  imageFormat: ImageFormat;
  outputPath?: string;
  ttlSeconds: number;
};

type RenderImageResult = {
  path: string;
  tool: ToolId;
  temporary: boolean;
};

async function renderImage(params: RenderImageParams): Promise<RenderImageResult> {
  const tool = await resolveRenderTool(params.api);
  const outputPath = await resolveOutputPath(params.outputPath, params.imageFormat);
  const tempDir = await ensureTempDir();
  await cleanupTempDir(tempDir, params.ttlSeconds * 1000);

  const inputPath = await writeTempInput(params.output, tempDir);
  try {
    if (tool.id === "cryosnap") {
      await runCryosnap(params.api, tool.path, inputPath, outputPath);
    } else {
      await runFreeze(params.api, tool.path, inputPath, outputPath);
    }
  } finally {
    await fs.rm(inputPath, { force: true });
  }

  if (!params.outputPath && params.ttlSeconds > 0) {
    scheduleCleanup(outputPath, params.ttlSeconds * 1000);
  }

  return { path: outputPath, tool: tool.id, temporary: !params.outputPath };
}

async function runCryosnap(
  api: OpenClawPluginApi,
  toolPath: string,
  inputPath: string,
  outputPath: string,
): Promise<void> {
  const argv = [toolPath, "--language", "ansi", "-o", outputPath, inputPath];
  const result = await api.runtime.system.runCommandWithTimeout(argv, {
    timeoutMs: 120_000,
  });
  if (result.code !== 0) {
    const err = (result.stderr ?? result.stdout ?? "").trim();
    throw new Error(err ? `cryosnap failed: ${err}` : "cryosnap failed");
  }
}

async function runFreeze(
  api: OpenClawPluginApi,
  toolPath: string,
  inputPath: string,
  outputPath: string,
): Promise<void> {
  const cmd = `cat -- ${shellQuote(inputPath)} | ${shellQuote(toolPath)} -o ${shellQuote(outputPath)}`;
  const result = await api.runtime.system.runCommandWithTimeout(["bash", "-lc", cmd], {
    timeoutMs: 120_000,
  });
  if (result.code !== 0) {
    const err = (result.stderr ?? result.stdout ?? "").trim();
    throw new Error(err ? `freeze failed: ${err}` : "freeze failed");
  }
}

async function resolveRenderTool(api: OpenClawPluginApi): Promise<ToolLocation> {
  const cryosnap = await resolveToolBinary(api, "cryosnap");
  if (cryosnap) {
    return cryosnap;
  }
  const freeze = await resolveToolBinary(api, "freeze");
  if (freeze) {
    return freeze;
  }
  throw new Error(
    "No screenshot tool found. Install with `openclaw tmux-watch install cryosnap` or `openclaw tmux-watch install freeze`.",
  );
}

async function resolveToolBinary(api: OpenClawPluginApi, id: ToolId): Promise<ToolLocation | null> {
  const binaryName = resolveBinaryName(id);
  const fromPath = await findInPath(binaryName);
  if (fromPath) {
    return { id, path: fromPath, source: "path" };
  }

  const home = os.homedir();
  const userBins = [path.join(home, ".local", "bin"), path.join(home, "bin")];
  for (const dir of userBins) {
    const found = await findInDir(dir, binaryName);
    if (found) {
      return { id, path: found, source: "user-bin" };
    }
  }

  const toolsDir = resolveToolsDir(api);
  const openclawPath = await findInDir(toolsDir, binaryName);
  if (openclawPath) {
    return { id, path: openclawPath, source: "openclaw" };
  }

  return null;
}

async function findInPath(binaryName: string): Promise<string | null> {
  const raw = process.env.PATH ?? "";
  const paths = raw.split(path.delimiter).filter(Boolean);
  for (const dir of paths) {
    const found = await findInDir(dir, binaryName);
    if (found) {
      return found;
    }
  }
  return null;
}

async function findInDir(dir: string, binaryName: string): Promise<string | null> {
  if (!dir) {
    return null;
  }
  const candidate = path.join(dir, binaryName);
  if (await isExecutable(candidate)) {
    return candidate;
  }
  return null;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return true;
    }
    await fs.access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCaptureLines(raw: unknown, config: TmuxWatchConfig): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(10, Math.trunc(raw));
  }
  return Math.max(10, Math.trunc(config.captureLines));
}

function resolveStripAnsi(raw: unknown, config: TmuxWatchConfig): boolean {
  return typeof raw === "boolean" ? raw : config.stripAnsi;
}

function resolveMaxChars(raw: unknown, config: TmuxWatchConfig): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.trunc(raw));
  }
  return Math.max(0, Math.trunc(config.maxOutputChars));
}

function resolveTtlSeconds(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.trunc(raw));
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.trunc(parsed));
    }
  }
  return DEFAULT_TTL_SECONDS;
}

function normalizeSocket(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const comma = trimmed.indexOf(",");
  if (comma > 0) {
    return trimmed.slice(0, comma);
  }
  return trimmed;
}

async function ensureTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), TEMP_DIR_NAME);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function resolveOutputPath(outputPath: string | undefined, format: ImageFormat): Promise<string> {
  const trimmed = outputPath?.trim();
  if (!trimmed) {
    const dir = await ensureTempDir();
    return path.join(dir, `tmux-watch-${Date.now()}-${randomUUID()}.${format}`);
  }
  const ext = path.extname(trimmed);
  const finalPath = ext ? trimmed : `${trimmed}.${format}`;
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  return finalPath;
}

async function writeTempInput(content: string, dir: string): Promise<string> {
  const filePath = path.join(dir, `tmux-watch-input-${Date.now()}-${randomUUID()}.ansi`);
  await fs.writeFile(filePath, content);
  return filePath;
}

async function cleanupTempDir(dir: string, ttlMs: number): Promise<void> {
  if (ttlMs <= 0) {
    return;
  }
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) {
          return;
        }
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = await fs.stat(fullPath);
          if (now - stat.mtimeMs > ttlMs) {
            await fs.rm(fullPath, { force: true });
          }
        } catch {
          // ignore
        }
      }),
    );
  } catch {
    // ignore
  }
}

function scheduleCleanup(filePath: string, ttlMs: number): void {
  if (ttlMs <= 0) {
    return;
  }
  const timer = setTimeout(() => {
    void fs.rm(filePath, { force: true });
  }, ttlMs);
  timer.unref?.();
}

function shellQuote(input: string): string {
  return `'${input.replace(/'/g, `'"'"'`)}'`;
}
