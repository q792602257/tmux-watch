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

function makeApiForSendGuardTest(onTelegramSend: () => Promise<void> | void): OpenClawPluginApi {
  return {
    pluginConfig: {
      enabled: true,
      debug: false,
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
        resolveStateDir: () => os.tmpdir(),
      },
      system: {
        runCommandWithTimeout: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
      channel: {
        telegram: {
          sendMessage: async () => {
            await onTelegramSend();
          },
        },
      },
    },
  } as unknown as OpenClawPluginApi;
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

test("sendToTarget skips send when guard already stale", async () => {
  let sendCount = 0;
  const manager = createTmuxWatchManager(
    makeApiForSendGuardTest(async () => {
      sendCount += 1;
    }),
  ) as unknown as {
    sendToTarget: (
      target: { channel: string; target: string; source: "targets" },
      text: string,
      context?: { subscriptionId?: string; phase?: string },
      canSend?: () => boolean,
    ) => Promise<boolean>;
  };
  const sent = await manager.sendToTarget(
    { channel: "telegram", target: "123", source: "targets" },
    "hello",
    { subscriptionId: "sub-1", phase: "primary-dispatch" },
    () => false,
  );
  assert.equal(sent, false);
  assert.equal(sendCount, 0);
});

test("sendToTarget aborts at last checkpoint when guard flips stale", async () => {
  let sendCount = 0;
  let guardChecks = 0;
  const manager = createTmuxWatchManager(
    makeApiForSendGuardTest(async () => {
      sendCount += 1;
    }),
  ) as unknown as {
    sendToTarget: (
      target: { channel: string; target: string; source: "targets" },
      text: string,
      context?: { subscriptionId?: string; phase?: string },
      canSend?: () => boolean,
    ) => Promise<boolean>;
  };
  const sent = await manager.sendToTarget(
    { channel: "telegram", target: "123", source: "targets" },
    "hello",
    { subscriptionId: "sub-1", phase: "primary-dispatch" },
    () => {
      guardChecks += 1;
      return guardChecks < 2;
    },
  );
  assert.equal(sent, false);
  assert.equal(sendCount, 0);
  assert.equal(guardChecks >= 2, true);
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

test("stop invalidates in-flight notify before message send", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "tmux-watch-stop-race-"));
  let sendCount = 0;
  let releaseDeliver: (() => void) | null = null;
  const deliverGate = new Promise<void>((resolve) => {
    releaseDeliver = resolve;
  });

  const api = {
    pluginConfig: {
      enabled: true,
      debug: false,
      captureIntervalSeconds: 60,
      stableCount: 1,
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
          if (argv[0] === "tmux" && argv.includes("capture-pane")) {
            return { code: 0, stdout: "stable output", stderr: "" };
          }
          return { code: 1, stdout: "", stderr: "unexpected command" };
        },
      },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async ({
            dispatcherOptions,
          }: {
            dispatcherOptions: {
              deliver: (payload: unknown, info: { kind: string }) => Promise<void> | void;
            };
          }) => {
            await deliverGate;
            await dispatcherOptions.deliver({ text: "summary" }, { kind: "final" });
          },
        },
        telegram: {
          sendMessage: async () => {
            sendCount += 1;
          },
        },
      },
    },
  } as unknown as OpenClawPluginApi;

  const manager = createTmuxWatchManager(api) as unknown as {
    start: (ctx: OpenClawPluginServiceContext) => Promise<void>;
    stop: () => Promise<void>;
    addSubscription: (
      input: Partial<{
        id: string;
        target: string;
        captureIntervalSeconds: number;
        stableCount: number;
        notify: { mode: "targets"; targets: Array<{ channel: string; target: string }> };
      }> &
        { target: string },
    ) => Promise<void>;
    pollWatch: (entry: unknown) => Promise<void>;
    entries: Map<string, unknown>;
  };

  try {
    await manager.start({ stateDir });
    await manager.addSubscription({
      id: "sub-stop-race",
      target: "session:0.0",
      captureIntervalSeconds: 60,
      stableCount: 1,
      notify: {
        mode: "targets",
        targets: [{ channel: "telegram", target: "123" }],
      },
    });
    const entry = manager.entries.get("sub-stop-race");
    assert.ok(entry);

    await manager.pollWatch(entry);
    const secondPoll = manager.pollWatch(entry);
    await waitFor(async () => {
      const runtime = (entry as { runtime?: { notifyInFlight?: unknown } }).runtime;
      return Boolean(runtime?.notifyInFlight);
    });

    if (typeof releaseDeliver !== "function") {
      assert.fail("releaseDeliver should be initialized");
    }
    await manager.stop();
    (releaseDeliver as () => void)();
    await secondPoll;

    assert.equal(sendCount, 0);
  } finally {
    await manager.stop();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("manager ignores malformed sync state instead of clearing in-memory subscriptions", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "tmux-watch-state-invalid-"));
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
    await manager.start({ stateDir });
    await manager.addSubscription({
      id: "keep-sub",
      target: "session:0.0",
      captureIntervalSeconds: 60,
      enabled: true,
    });

    const statePath = path.join(stateDir, "tmux-watch", "subscriptions.json");
    await fs.writeFile(statePath, JSON.stringify({ version: 1, subscriptions: {} }, null, 2));

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const items = await manager.listSubscriptions({ includeOutput: false });
    assert.equal(items.some((item) => item.id === "keep-sub"), true);
  } finally {
    await manager.stop();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("subscription notify.targets=[] overrides global targets", async () => {
  const api = {
    pluginConfig: {
      enabled: true,
      debug: false,
      notify: {
        mode: "targets",
        targets: [{ channel: "telegram", target: "global-target" }],
      },
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
        resolveStateDir: () => os.tmpdir(),
      },
      system: {
        runCommandWithTimeout: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
      channel: {
        session: {
          resolveStorePath: () => "",
        },
      },
    },
  } as unknown as OpenClawPluginApi;
  const manager = createTmuxWatchManager(api) as unknown as {
    resolveNotifyTargets: (
      subscription: {
        id: string;
        target: string;
        notify: { mode: "targets"; targets: Array<{ channel: string; target: string }> };
      },
      sessionKey: string,
    ) => Promise<Array<{ channel: string; target: string }>>;
  };

  const targets = await manager.resolveNotifyTargets(
    {
      id: "sub-empty-targets",
      target: "session:0.0",
      notify: { mode: "targets", targets: [] },
    },
    "agent:main:main",
  );
  assert.equal(targets.length, 0);
});

test("resolveLastTargetsFromStore tolerates invalid session entry values", () => {
  const store = {
    "agent:main:main": {
      updatedAt: 5,
      deliveryContext: { channel: "webchat", to: "webchat:client" },
    },
    "agent:main:bad-null": null,
    "agent:main:bad-string": "invalid",
    "agent:main:telegram": {
      updatedAt: 4,
      deliveryContext: { channel: "telegram", to: "123" },
    },
  } as unknown as Record<string, unknown> as Record<string, { updatedAt?: number }>;

  const targets = resolveLastTargetsFromStore({
    store: store as unknown as Record<string, { updatedAt?: number }>,
    sessionKey: "agent:main:main",
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.channel, "telegram");

  const empty = resolveLastTargetsFromStore({
    store: { "agent:main:main": null } as unknown as Record<string, { updatedAt?: number }>,
    sessionKey: "agent:main:main",
  });
  assert.equal(empty.length, 0);
});
