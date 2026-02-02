import type { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { installTool, removeTool, type ToolId } from "./tool-install.js";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type PluginsConfig = {
  enabled?: boolean;
  entries?: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
};

function extractSocket(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const comma = trimmed.indexOf(",");
  if (comma > 0) {
    return trimmed.slice(0, comma);
  }
  return trimmed;
}

function printSocketHelp(logger: Logger) {
  logger.info("How to find the tmux socket:");
  logger.info("  1) Enter the target tmux session.");
  logger.info("  2) Run: echo $TMUX");
  logger.info("  3) Use the path before the first comma as the socket.");
  logger.info("Example: /private/tmp/tmux-501/default,3191,4 -> /private/tmp/tmux-501/default");
}

async function promptSocket(logger: Logger): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("No TTY available for interactive prompt. Use --socket <path>.");
  }
  printSocketHelp(logger);
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question("Paste tmux socket path (or full $TMUX value): ");
    return extractSocket(answer);
  } finally {
    rl.close();
  }
}

function resolveSocketFromEnv(): string | undefined {
  const env = process.env.TMUX;
  if (!env) {
    return undefined;
  }
  const socket = extractSocket(env);
  return socket || undefined;
}

function normalizeToolId(raw: string): ToolId {
  const normalized = raw.trim().toLowerCase();
  if (normalized !== "cryosnap" && normalized !== "freeze") {
    throw new Error("Tool must be cryosnap or freeze.");
  }
  return normalized as ToolId;
}

export function registerTmuxWatchCli(params: {
  program: Command;
  api: OpenClawPluginApi;
  logger: Logger;
}) {
  const { program, api, logger } = params;

  const root = program
    .command("tmux-watch")
    .description("tmux-watch plugin utilities")
    .addHelpText("after", () => "\nDocs: https://docs.openclaw.ai/cli/plugins\n");

  root
    .command("setup")
    .description("Configure tmux-watch (socket is required)")
    .option("--socket <path>", "tmux socket path (or full $TMUX value)")
    .action(async (options: { socket?: string }) => {
      let socket = options.socket ? extractSocket(options.socket) : undefined;
      if (!socket) {
        socket = resolveSocketFromEnv();
      }
      if (!socket) {
        socket = await promptSocket(logger);
      }
      if (!socket) {
        throw new Error("Socket required. Re-run with --socket or provide it interactively.");
      }

      const cfg = api.runtime.config.loadConfig();
      const plugins = (cfg.plugins ?? {}) as PluginsConfig;
      const entries = { ...(plugins.entries ?? {}) };
      const entry = { ...(entries["tmux-watch"] ?? {}) };
      const entryConfig = { ...(entry.config ?? {}) };

      entry.enabled = true;
      entry.config = {
        ...entryConfig,
        socket,
      };

      entries["tmux-watch"] = entry;

      await api.runtime.config.writeConfigFile({
        ...cfg,
        plugins: {
          ...plugins,
          entries,
        },
      });

      logger.info(`tmux-watch configured. socket=${socket}`);
      logger.info("Restart the Gateway for changes to take effect.");
    });

  root
    .command("socket-help")
    .description("Print instructions for finding the tmux socket")
    .action(() => {
      printSocketHelp(logger);
    });

  root
    .command("install")
    .description("Install cryosnap or freeze into the OpenClaw tools directory")
    .argument("[tool]", "cryosnap or freeze", "cryosnap")
    .option("--force", "Replace existing tool binary")
    .action(async (tool: string, options: { force?: boolean }) => {
      const normalized = normalizeToolId(tool);
      const result = await installTool({
        tool: normalized,
        api,
        logger,
        force: Boolean(options.force),
      });
      const version = result.version ? ` (${result.version})` : "";
      logger.info(`Installed ${result.tool}${version}`);
      logger.info(`Path: ${result.path}`);
    });

  root
    .command("update")
    .description("Update cryosnap or freeze in the OpenClaw tools directory")
    .argument("[tool]", "cryosnap or freeze", "cryosnap")
    .action(async (tool: string) => {
      const normalized = normalizeToolId(tool);
      const result = await installTool({
        tool: normalized,
        api,
        logger,
        force: true,
      });
      const version = result.version ? ` (${result.version})` : "";
      logger.info(`Updated ${result.tool}${version}`);
      logger.info(`Path: ${result.path}`);
    });

  root
    .command("remove")
    .description("Remove cryosnap or freeze from the OpenClaw tools directory")
    .argument("[tool]", "cryosnap or freeze", "cryosnap")
    .action(async (tool: string) => {
      const normalized = normalizeToolId(tool);
      const result = await removeTool({
        tool: normalized,
        api,
        logger,
      });
      if (result.removed) {
        logger.info(`Removed ${result.tool}`);
      }
      logger.info(`Path: ${result.path}`);
    });
}
