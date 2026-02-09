import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk";
import type { TmuxWatchConfig } from "../src/config.js";
import {
  DEFAULT_CAPTURE_INTERVAL_SECONDS,
  DEFAULT_STABLE_COUNT,
} from "../src/config.js";
import {
  resolveIntervalMs,
  resolveStableCount,
  resolveStableDurationSeconds,
  resolveLastTargetsFromStore,
  extractReplyText,
  createTmuxWatchManager,
  stripAnsi,
  truncateOutput,
} from "../src/manager.js";

type PartialConfig = Partial<TmuxWatchConfig>;

function makeConfig(overrides: PartialConfig = {}): TmuxWatchConfig {
  return {
    enabled: true,
    debug: false,
    captureIntervalSeconds: undefined,
    pollIntervalMs: undefined,
    stableCount: undefined,
    stableSeconds: undefined,
    captureLines: 200,
    stripAnsi: true,
    maxOutputChars: 4000,
    sessionKey: undefined,
    socket: undefined,
    notify: {
      mode: "targets",
      targets: [],
    },
    ...overrides,
  };
}

function makeSub(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    target: "session:0.0",
    ...overrides,
  };
}

async function waitFor(
  condition: () => Promise<boolean>,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 4000;
  const intervalMs = options?.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(`condition not met within ${timeoutMs}ms`);
}

test("resolveIntervalMs prefers captureIntervalSeconds over pollIntervalMs", () => {
  const cfg = makeConfig({ captureIntervalSeconds: 2, pollIntervalMs: 9000 });
  assert.equal(resolveIntervalMs(makeSub(), cfg), 2000);
  assert.equal(
    resolveIntervalMs(makeSub({ captureIntervalSeconds: 3 }), cfg),
    3000,
  );
});

test("resolveIntervalMs falls back to default when no interval is configured", () => {
  const cfg = makeConfig();
  assert.equal(
    resolveIntervalMs(makeSub(), cfg),
    DEFAULT_CAPTURE_INTERVAL_SECONDS * 1000,
  );
});

test("resolveStableCount uses stableCount when provided", () => {
  const cfg = makeConfig({ captureIntervalSeconds: 3, stableCount: 5 });
  assert.equal(resolveStableCount(makeSub(), cfg), 5);
});

test("resolveStableCount derives from stableSeconds when stableCount is missing", () => {
  const cfg = makeConfig({ captureIntervalSeconds: 3, stableSeconds: 15 });
  assert.equal(resolveStableCount(makeSub(), cfg), 5);
});

test("resolveStableCount falls back to default", () => {
  const cfg = makeConfig();
  assert.equal(resolveStableCount(makeSub(), cfg), DEFAULT_STABLE_COUNT);
});

test("resolveStableDurationSeconds uses interval * stableCount", () => {
  const cfg = makeConfig({ captureIntervalSeconds: 3, stableCount: 5 });
  assert.equal(resolveStableDurationSeconds(makeSub(), cfg), 15);
});

test("manager syncs new state even when no watch timers are active", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "tmux-watch-state-"));
  const api = {
    pluginConfig: {
      enabled: true,
      debug: false,
      captureIntervalSeconds: 60,
      stableCount: 6,
      notify: { mode: "targets", targets: [] },
    },
    config: {
      session: { scope: "agent", mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    runtime: {
      state: {
        resolveStateDir: () => stateDir,
      },
      system: {
        runCommandWithTimeout: async (argv: string[]) => {
          if (argv[0] === "tmux" && argv[1] === "-V") {
            return { code: 0, stdout: "tmux 3.4", stderr: "" };
          }
          return { code: 1, stdout: "", stderr: "not implemented in test" };
        },
      },
    },
  } as unknown as OpenClawPluginApi;
  const manager = createTmuxWatchManager(api);

  try {
    await manager.start({ stateDir } as unknown as OpenClawPluginServiceContext);
    const before = await manager.listSubscriptions({ includeOutput: false });
    assert.equal(before.length, 0);

    const statePath = path.join(stateDir, "tmux-watch", "subscriptions.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          version: 1,
          subscriptions: [
            {
              id: "sub-from-disk",
              target: "session:0.0",
              label: "from-disk",
              enabled: true,
              captureIntervalSeconds: 60,
            },
          ],
        },
        null,
        2,
      ),
    );

    await waitFor(async () => {
      const items = await manager.listSubscriptions({ includeOutput: false });
      return items.some((item) => item.id === "sub-from-disk");
    });

    const after = await manager.listSubscriptions({ includeOutput: false });
    assert.equal(after.length, 1);
    assert.equal(after[0]?.id, "sub-from-disk");
  } finally {
    await manager.stop();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("manager routes debug logs to debug channel", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "tmux-watch-debug-log-"));
  const debugMessages: string[] = [];
  const infoMessages: string[] = [];
  const api = {
    pluginConfig: {
      enabled: true,
      debug: true,
      captureIntervalSeconds: 60,
      stableCount: 6,
      notify: { mode: "targets", targets: [] },
    },
    config: {
      session: { scope: "agent", mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    },
    logger: {
      debug: (message: string) => {
        debugMessages.push(message);
      },
      info: (message: string) => {
        infoMessages.push(message);
      },
      warn: () => {},
      error: () => {},
    },
    runtime: {
      state: {
        resolveStateDir: () => stateDir,
      },
      system: {
        runCommandWithTimeout: async (argv: string[]) => {
          if (argv[0] === "tmux" && argv[1] === "-V") {
            return { code: 0, stdout: "tmux 3.4", stderr: "" };
          }
          return { code: 1, stdout: "", stderr: "not implemented in test" };
        },
      },
    },
  } as unknown as OpenClawPluginApi;
  const manager = createTmuxWatchManager(api);

  try {
    await manager.start({ stateDir } as unknown as OpenClawPluginServiceContext);
    assert.equal(
      infoMessages.some((message) => message.includes("[tmux-watch][debug]")),
      false,
    );
    assert.equal(
      debugMessages.some((message) => message.includes("[tmux-watch][debug] manager started")),
      true,
    );
  } finally {
    await manager.stop();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("stripAnsi removes SGR and OSC8 sequences", () => {
  const text = "\u001b[31mred\u001b[0m \u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\";
  assert.equal(stripAnsi(text), "red link");
});

test("truncateOutput keeps tail content and marks truncation", () => {
  const text = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
  const result = truncateOutput(text, 40);
  assert.equal(result.truncated, true);
  assert.ok(result.text.startsWith("...[truncated]\n"));
  const lines = result.text.split("\n");
  assert.equal(lines[0], "...[truncated]");
  assert.equal(lines[lines.length - 1], "line20");
  assert.notEqual(lines[1], "line1");
});

test("truncateOutput leaves short text untouched", () => {
  const text = "short line";
  const result = truncateOutput(text, 200);
  assert.equal(result.truncated, false);
  assert.equal(result.text, text);
});

test("resolveLastTargetsFromStore replaces webchat last with latest external", () => {
  const store = {
    "agent:main:main": {
      updatedAt: 5,
      deliveryContext: { channel: "webchat", to: "webchat:client" },
    },
    "agent:main:gewe": {
      updatedAt: 3,
      deliveryContext: { channel: "gewe-openclaw", to: "gewe-openclaw:wxid_a" },
    },
    "agent:main:telegram": {
      updatedAt: 4,
      deliveryContext: { channel: "telegram", to: "123" },
    },
  };
  const targets = resolveLastTargetsFromStore({
    store,
    sessionKey: "agent:main:main",
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.channel, "telegram");
});

test("resolveLastTargetsFromStore uses last external directly", () => {
  const store = {
    "agent:main:main": {
      updatedAt: 5,
      deliveryContext: { channel: "gewe-openclaw", to: "gewe-openclaw:wxid_a" },
    },
    "agent:main:web": {
      updatedAt: 6,
      deliveryContext: { channel: "webchat", to: "webchat:client" },
    },
  };
  const targets = resolveLastTargetsFromStore({
    store,
    sessionKey: "agent:main:main",
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.channel, "gewe-openclaw");
});

test("extractReplyText reads text from reply payload", () => {
  assert.equal(extractReplyText({ text: "hello" }), "hello");
  assert.equal(extractReplyText({ text: 123 }), undefined);
  assert.equal(extractReplyText(null), undefined);
});
