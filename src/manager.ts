import type { OpenClawPluginApi, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { captureTmux, type CaptureParams, type CaptureResult } from "./capture.js";
import { stripAnsi, truncateOutput } from "./text-utils.js";
import {
  DEFAULT_CAPTURE_INTERVAL_SECONDS,
  DEFAULT_STABLE_COUNT,
  resolveTmuxWatchConfig,
  type NotifyMode,
  type NotifyTarget,
  type TmuxWatchConfig,
} from "./config.js";
import { normalizeTmuxSocket } from "./socket.js";

export type TmuxWatchSubscription = {
  id: string;
  label?: string;
  note?: string;
  target: string;
  socket?: string;
  sessionKey?: string;
  captureIntervalSeconds?: number;
  intervalMs?: number;
  stableCount?: number;
  stableSeconds?: number;
  captureLines?: number;
  stripAnsi?: boolean;
  enabled?: boolean;
  notify?: {
    mode?: NotifyMode;
    targets?: NotifyTarget[];
  };
};

type PersistedState = {
  version: number;
  subscriptions: TmuxWatchSubscription[];
};

type WatchRuntime = {
  running: boolean;
  stableTicks: number;
  lastHash?: string;
  lastOutput?: string;
  lastCapturedAt?: number;
  lastNotifiedHash?: string;
  lastNotifiedAt?: number;
  lastError?: string;
  timer?: NodeJS.Timeout;
};

type WatchEntry = {
  subscription: TmuxWatchSubscription;
  runtime: WatchRuntime;
};

export type ResolvedTarget = {
  channel: string;
  target: string;
  accountId?: string;
  threadId?: string | number;
  label?: string;
  source: "targets" | "last" | "last-fallback";
};

export type SessionEntryLike = {
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  updatedAt?: number;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  channel?: string;
  origin?: { threadId?: string | number };
};

type MinimalConfig = {
  session?: { scope?: string; mainKey?: string };
  agents?: { list?: Array<{ id?: string; default?: boolean }> };
};

const STATE_VERSION = 1;
const INTERNAL_LAST_CHANNELS = new Set(["webchat", "tui"]);
const TMUX_RECHECK_INTERVAL_MS = 5000;
const STATE_SYNC_INTERVAL_MS = 1000;

export class TmuxWatchManager {
  private readonly api: OpenClawPluginApi;
  private readonly config: TmuxWatchConfig;
  private readonly entries = new Map<string, WatchEntry>();
  private stateDir: string | null = null;
  private loaded = false;
  private active = false;
  private tmuxAvailable = false;
  private tmuxLastCheckedAt = 0;
  private stateMtimeMs = 0;
  private stateSyncPromise: Promise<void> | null = null;
  private stateSyncTimer: NodeJS.Timeout | null = null;

  constructor(api: OpenClawPluginApi) {
    this.api = api;
    this.config = resolveTmuxWatchConfig(api.pluginConfig);
  }

  async start(ctx: OpenClawPluginServiceContext): Promise<void> {
    if (!this.config.enabled) {
      this.api.logger.info("[tmux-watch] disabled via config");
      return;
    }
    this.stateDir = ctx.stateDir ?? null;
    this.active = true;
    await this.ensureLoaded();
    this.startStateSyncLoop();
    await this.ensureTmuxAvailable({ force: true });
    this.debugLog("manager started", {
      statePath: this.getStatePath(),
      subscriptions: this.entries.size,
      tmuxAvailable: this.tmuxAvailable,
    });
    for (const entry of this.entries.values()) {
      this.startWatch(entry);
    }
  }

  async stop(): Promise<void> {
    this.active = false;
    this.stopStateSyncLoop();
    this.debugLog("manager stopping", { subscriptions: this.entries.size });
    for (const entry of this.entries.values()) {
      this.stopWatchTimer(entry);
    }
  }

  private debugLog(message: string, details?: Record<string, unknown>): void {
    if (!this.config.debug) {
      return;
    }
    const suffix = details ? ` ${safeJson(details)}` : "";
    this.api.logger.debug(`[tmux-watch][debug] ${message}${suffix}`);
  }

  private debugSubscription(
    subscription: TmuxWatchSubscription,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    if (!this.config.debug) {
      return;
    }
    const context: Record<string, unknown> = {
      id: subscription.id,
      target: subscription.target,
      label: subscription.label,
    };
    this.debugLog(message, details ? { ...context, ...details } : context);
  }

  async listSubscriptions(options?: { includeOutput?: boolean }) {
    await this.ensureLoaded();
    const includeOutput = options?.includeOutput !== false;
    const maxOutputChars = this.config.maxOutputChars;
    const items = [];
    for (const entry of this.entries.values()) {
      const runtime = entry.runtime;
      const outputInfo = includeOutput
        ? truncateOutput(runtime.lastOutput ?? "", maxOutputChars)
        : { text: undefined, truncated: false };
      items.push({
        ...entry.subscription,
        enabled: entry.subscription.enabled !== false,
        runtime: {
          stableTicks: runtime.stableTicks,
          lastCapturedAt: runtime.lastCapturedAt,
          lastNotifiedAt: runtime.lastNotifiedAt,
          lastError: runtime.lastError,
          output: outputInfo.text,
          outputTruncated: outputInfo.truncated,
        },
      });
    }
    return items;
  }

  async capture(params: CaptureParams): Promise<CaptureResult> {
    await this.ensureTmuxAvailable({ force: true });
    if (!this.tmuxAvailable) {
      throw new Error("tmux not available");
    }
    return captureTmux({ api: this.api, config: this.config, ...params });
  }

  async addSubscription(input: Partial<TmuxWatchSubscription> & { target: string }) {
    await this.ensureLoaded();
    const id = input.id?.trim() || randomUUID();
    const existing = this.entries.get(id);
    const subscription: TmuxWatchSubscription = {
      ...(existing?.subscription ?? {}),
      ...sanitizeSubscriptionInput(input),
      id,
    };
    const runtime = existing?.runtime ?? createRuntime();
    this.entries.set(id, { subscription, runtime });
    this.debugSubscription(subscription, existing ? "subscription updated" : "subscription added", {
      enabled: subscription.enabled !== false,
    });
    await this.saveState();
    if (this.active && subscription.enabled !== false) {
      this.startWatch(this.entries.get(id)!);
    } else if (existing) {
      this.stopWatchTimer(existing);
    }
    return subscription;
  }

  async removeSubscription(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const entry = this.entries.get(id);
    if (!entry) {
      this.debugLog("remove subscription skipped because id missing", { id });
      return false;
    }
    this.stopWatchTimer(entry);
    this.entries.delete(id);
    this.debugSubscription(entry.subscription, "subscription removed");
    await this.saveState();
    return true;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const state = await this.loadState();
    for (const subscription of state.subscriptions) {
      if (!subscription.id || !subscription.target) {
        continue;
      }
      this.entries.set(subscription.id, {
        subscription,
        runtime: createRuntime(),
      });
    }
    this.stateMtimeMs = await this.readStateMtimeMs();
    this.loaded = true;
    this.debugLog("state loaded", {
      statePath: this.getStatePath(),
      subscriptions: this.entries.size,
      mtimeMs: this.stateMtimeMs,
    });
  }

  private getStatePath(): string {
    const stateDir = this.stateDir ?? this.api.runtime.state.resolveStateDir();
    return path.join(stateDir, "tmux-watch", "subscriptions.json");
  }

  private async loadState(): Promise<PersistedState> {
    const filePath = this.getStatePath();
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      if (!parsed || parsed.version !== STATE_VERSION || !Array.isArray(parsed.subscriptions)) {
        return { version: STATE_VERSION, subscriptions: [] };
      }
      return parsed;
    } catch {
      return { version: STATE_VERSION, subscriptions: [] };
    }
  }

  private async saveState(): Promise<void> {
    const filePath = this.getStatePath();
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const payload: PersistedState = {
      version: STATE_VERSION,
      subscriptions: Array.from(this.entries.values()).map((entry) => entry.subscription),
    };
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
    this.stateMtimeMs = await this.readStateMtimeMs();
    this.debugLog("state saved", {
      statePath: filePath,
      subscriptions: payload.subscriptions.length,
      mtimeMs: this.stateMtimeMs,
    });
  }

  private async readStateMtimeMs(): Promise<number> {
    const filePath = this.getStatePath();
    try {
      const stat = await fs.stat(filePath);
      return stat.mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }
      return this.stateMtimeMs;
    }
  }

  private async loadStateForSync(): Promise<PersistedState | null> {
    const filePath = this.getStatePath();
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      if (!parsed || parsed.version !== STATE_VERSION || !Array.isArray(parsed.subscriptions)) {
        return { version: STATE_VERSION, subscriptions: [] };
      }
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: STATE_VERSION, subscriptions: [] };
      }
      return null;
    }
  }

  private async syncStateFromDiskIfNeeded(): Promise<void> {
    if (!this.loaded) {
      return;
    }
    if (this.stateSyncPromise) {
      await this.stateSyncPromise;
      return;
    }
    this.stateSyncPromise = (async () => {
      const mtimeMs = await this.readStateMtimeMs();
      if (mtimeMs === this.stateMtimeMs) {
        return;
      }
      this.debugLog("state changed on disk; reconciling", {
        previousMtimeMs: this.stateMtimeMs,
        nextMtimeMs: mtimeMs,
      });
      const state = await this.loadStateForSync();
      if (!state) {
        return;
      }
      this.stateMtimeMs = mtimeMs;
      this.reconcileEntriesFromState(state);
    })().finally(() => {
      this.stateSyncPromise = null;
    });
    await this.stateSyncPromise;
  }

  private reconcileEntriesFromState(state: PersistedState): void {
    const previousSize = this.entries.size;
    const nextSubscriptions = new Map<string, TmuxWatchSubscription>();
    for (const subscription of state.subscriptions) {
      if (!subscription.id || !subscription.target) {
        continue;
      }
      nextSubscriptions.set(subscription.id, subscription);
    }

    for (const [id, entry] of this.entries) {
      if (nextSubscriptions.has(id)) {
        continue;
      }
      this.stopWatchTimer(entry);
      this.entries.delete(id);
    }

    for (const [id, subscription] of nextSubscriptions) {
      const existing = this.entries.get(id);
      if (!existing) {
        const entry: WatchEntry = {
          subscription,
          runtime: createRuntime(),
        };
        this.entries.set(id, entry);
        if (this.active && subscription.enabled !== false) {
          this.startWatch(entry);
        }
        continue;
      }
      existing.subscription = subscription;
      if (this.active && subscription.enabled !== false) {
        this.startWatch(existing);
      } else {
        this.stopWatchTimer(existing);
      }
    }
    this.debugLog("state reconciled", {
      previousSubscriptions: previousSize,
      nextSubscriptions: this.entries.size,
    });
  }

  private isManagedEntry(entry: WatchEntry): boolean {
    const id = entry.subscription.id;
    if (!id) {
      return false;
    }
    return this.entries.get(id) === entry;
  }

  private shouldWatchEntry(entry: WatchEntry): boolean {
    return this.active && this.isManagedEntry(entry) && entry.subscription.enabled !== false;
  }

  private stopWatchTimer(entry: WatchEntry): void {
    if (entry.runtime.timer) {
      clearInterval(entry.runtime.timer);
      entry.runtime.timer = undefined;
      this.debugSubscription(entry.subscription, "watch timer stopped");
    }
  }

  private startStateSyncLoop(): void {
    this.stopStateSyncLoop();
    if (!this.active) {
      return;
    }
    this.stateSyncTimer = setInterval(() => {
      void this.syncStateFromDiskIfNeeded().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.debugLog("state sync tick failed", { error: message });
      });
    }, STATE_SYNC_INTERVAL_MS);
    this.stateSyncTimer.unref?.();
    this.debugLog("state sync timer started", {
      intervalMs: STATE_SYNC_INTERVAL_MS,
    });
  }

  private stopStateSyncLoop(): void {
    if (!this.stateSyncTimer) {
      return;
    }
    clearInterval(this.stateSyncTimer);
    this.stateSyncTimer = null;
    this.debugLog("state sync timer stopped");
  }

  private startWatch(entry: WatchEntry): void {
    this.stopWatchTimer(entry);
    if (entry.subscription.enabled === false) {
      this.debugSubscription(entry.subscription, "watch skipped because disabled");
      return;
    }
    const intervalMs = resolveIntervalMs(entry.subscription, this.config);
    this.debugSubscription(entry.subscription, "watch timer started", {
      intervalMs,
      stableCount: resolveStableCount(entry.subscription, this.config),
      notifyMode: resolveNotifyMode(entry.subscription, this.config),
    });
    entry.runtime.timer = setInterval(() => {
      void (async () => {
        await this.syncStateFromDiskIfNeeded();
        await this.pollWatch(entry);
      })().catch((err) => {
        entry.runtime.lastError = err instanceof Error ? err.message : String(err);
        this.debugSubscription(entry.subscription, "watch tick failed", {
          error: entry.runtime.lastError,
        });
      });
    }, intervalMs);
  }

  private async pollWatch(entry: WatchEntry): Promise<void> {
    if (!this.shouldWatchEntry(entry)) {
      this.debugSubscription(entry.subscription, "poll skipped because entry is not watchable", {
        active: this.active,
        managed: this.isManagedEntry(entry),
        enabled: entry.subscription.enabled !== false,
      });
      this.stopWatchTimer(entry);
      return;
    }
    if (entry.runtime.running) {
      this.debugSubscription(entry.subscription, "poll skipped because previous tick still running");
      return;
    }
    entry.runtime.running = true;
    try {
      const output = await this.captureOutput(entry.subscription);
      if (output === null) {
        entry.runtime.stableTicks = 0;
        this.debugSubscription(entry.subscription, "capture returned null; stableTicks reset");
        return;
      }
      if (!this.shouldWatchEntry(entry)) {
        this.debugSubscription(entry.subscription, "poll aborted because entry became unwatchable");
        this.stopWatchTimer(entry);
        return;
      }
      entry.runtime.lastCapturedAt = Date.now();
      entry.runtime.lastError = undefined;
      const hash = hashOutput(output);
      const previousHash = entry.runtime.lastHash;
      if (entry.runtime.lastHash && entry.runtime.lastHash === hash) {
        entry.runtime.stableTicks += 1;
      } else {
        entry.runtime.lastHash = hash;
        entry.runtime.lastOutput = output;
        entry.runtime.stableTicks = 0;
        entry.runtime.lastNotifiedHash = undefined;
      }
      const stableTicks = resolveStableTicks(entry.subscription, this.config);
      this.debugSubscription(entry.subscription, "poll captured", {
        outputChars: output.length,
        hash: hash.slice(0, 12),
        previousHash: previousHash?.slice(0, 12),
        stableTicks: entry.runtime.stableTicks,
        stableTicksRequired: stableTicks,
      });
      if (entry.runtime.stableTicks >= stableTicks) {
        if (entry.runtime.lastNotifiedHash !== hash) {
          entry.runtime.lastNotifiedHash = hash;
          entry.runtime.lastNotifiedAt = Date.now();
          this.debugSubscription(entry.subscription, "stability reached; notifying", {
            stableTicks: entry.runtime.stableTicks,
            stableTicksRequired: stableTicks,
          });
          await this.notifyStable(entry.subscription, output);
        } else {
          this.debugSubscription(entry.subscription, "stability reached but notify skipped", {
            reason: "already notified for same hash",
          });
        }
      }
    } finally {
      entry.runtime.running = false;
    }
  }

  private async captureOutput(subscription: TmuxWatchSubscription): Promise<string | null> {
    if (!this.tmuxAvailable) {
      await this.ensureTmuxAvailable();
      if (!this.tmuxAvailable) {
        this.debugSubscription(subscription, "capture skipped because tmux unavailable");
        return null;
      }
    }
    const target = subscription.target.trim();
    if (!target) {
      this.debugSubscription(subscription, "capture skipped because target empty");
      return null;
    }

    const captureLines = resolveCaptureLines(subscription, this.config);
    const socket = normalizeTmuxSocket(subscription.socket ?? this.config.socket);
    const argv = socket
      ? ["tmux", "-S", socket, "capture-pane", "-p", "-J", "-t", target]
      : ["tmux", "capture-pane", "-p", "-J", "-t", target];
    if (captureLines > 0) {
      argv.push("-S", `-${captureLines}`);
    }

    try {
      const result = await this.api.runtime.system.runCommandWithTimeout(argv, {
        timeoutMs: Math.max(1000, resolveIntervalMs(subscription, this.config) - 50),
      });
      if (result.code !== 0) {
        const stderr = result.stderr?.trim();
        if (stderr) {
          this.api.logger.warn(`[tmux-watch] tmux error: ${stderr}`);
        }
        this.debugSubscription(subscription, "capture command failed", {
          exitCode: result.code,
          stderr: stderr || "",
        });
        return null;
      }
      let output = result.stdout ?? "";
      output = output.replace(/\r\n/g, "\n").trimEnd();
      if (resolveStripAnsi(subscription, this.config)) {
        output = stripAnsi(output);
      }
      this.debugSubscription(subscription, "capture command succeeded", {
        outputChars: output.length,
      });
      return output;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.api.logger.warn(`[tmux-watch] tmux capture failed: ${message}`);
      this.debugSubscription(subscription, "capture command threw", { error: message });
      return null;
    }
  }

  private async notifyStable(
    subscription: TmuxWatchSubscription,
    output: string,
  ): Promise<void> {
    this.debugSubscription(subscription, "notify pipeline started", {
      outputChars: output.length,
    });
    const sessionKey = normalizeSessionKey(
      subscription.sessionKey ?? this.config.sessionKey,
      this.api.config,
    );
    if (!sessionKey) {
      this.api.logger.warn("[tmux-watch] missing sessionKey; skipping notify");
      this.debugSubscription(subscription, "notify skipped because sessionKey missing");
      return;
    }
    const targets = await this.resolveNotifyTargets(subscription, sessionKey);
    if (targets.length === 0) {
      this.api.logger.warn("[tmux-watch] no notify targets resolved; skipping notify");
      this.debugSubscription(subscription, "notify skipped because no targets resolved", {
        sessionKey,
      });
      return;
    }
    this.debugSubscription(subscription, "notify targets resolved", {
      sessionKey,
      targets: targets.map((target) => ({
        channel: target.channel,
        target: target.target,
        source: target.source,
      })),
    });
    const primary = targets[0]!;
    const outputInfo = truncateOutput(output, this.config.maxOutputChars);

    const details = {
      id: subscription.id,
      label: subscription.label,
      note: subscription.note,
      target: subscription.target,
      sessionKey,
      notifyMode: resolveNotifyMode(subscription, this.config),
      notifyTargets: targets.map((target) => ({
        channel: target.channel,
        target: target.target,
        accountId: target.accountId,
        threadId: target.threadId,
        label: target.label,
        source: target.source,
      })),
      notifyExpectation: "required",
      primary: {
        channel: primary.channel,
        target: primary.target,
        accountId: primary.accountId,
        threadId: primary.threadId,
      },
      outputTruncated: outputInfo.truncated,
      stableCount: resolveStableCount(subscription, this.config),
      captureIntervalSeconds: resolveIntervalMs(subscription, this.config) / 1000,
      stableDurationSeconds: resolveStableDurationSeconds(subscription, this.config),
      intervalMs: resolveIntervalMs(subscription, this.config),
      capturedAt: new Date().toISOString(),
    };

    const lines = [
      "SYSTEM EVENT (tmux-watch): Not user input. Summarize the output and notify the user.",
      "policy: notify user (do not reply NO_REPLY unless user explicitly requested silence)",
      `subscription: ${subscription.label ? `${subscription.label} (${subscription.id})` : subscription.id}`,
      subscription.note ? `subscription_note: ${subscription.note}` : null,
      `tmux target: ${subscription.target}`,
      `session: ${sessionKey}`,
      `notify.mode: ${details.notifyMode}`,
      `notify.primary: ${primary.channel} ${primary.target}`,
      `notify.targets: ${targets
        .map((target) => `${target.channel}:${target.target}${target.label ? ` (${target.label})` : ""}`)
        .join(", ")}`,
      "details_json:",
      JSON.stringify(details, null, 2),
    ].filter((line): line is string => Boolean(line));

    if (outputInfo.text) {
      lines.push("output:");
      lines.push(outputInfo.text);
    }

    const body = lines.join("\n");
    const ctx = {
      Body: body,
      RawBody: body,
      CommandBody: body,
      Provider: "tmux-watch",
      Surface: "tmux-watch",
      SessionKey: sessionKey,
      MessageSid: `tmux-watch:${subscription.id}:${Date.now()}`,
      OriginatingChannel: primary.channel,
      OriginatingTo: primary.target,
      AccountId: primary.accountId,
      MessageThreadId: primary.threadId,
      To: primary.target,
      From: "tmux-watch",
      ChatType: "direct",
    };

    let dispatchedPrimary = false;
    try {
      this.debugSubscription(subscription, "dispatching to reply pipeline", {
        primaryChannel: primary.channel,
        primaryTarget: primary.target,
      });
      await this.api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg: this.api.config,
        dispatcherOptions: {
          deliver: async (payload: unknown, info: { kind: string }) => {
            if (info.kind !== "final") {
              this.debugSubscription(subscription, "dispatcher ignored non-final payload", {
                payloadKind: info.kind,
              });
              return;
            }
            const text = extractReplyText(payload);
            if (!text) {
              this.debugSubscription(subscription, "dispatcher final payload missing text");
              return;
            }
            this.debugSubscription(subscription, "dispatcher produced final text", {
              textChars: text.length,
            });
            await this.sendToTarget(primary, text, {
              subscriptionId: subscription.id,
              phase: "primary-dispatch",
            });
            dispatchedPrimary = true;
          },
          onError: (err: unknown) => {
            this.api.logger.warn(
              `[tmux-watch] dispatch error: ${err instanceof Error ? err.message : String(err)}`,
            );
            this.debugSubscription(subscription, "dispatch callback error", {
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      });
    } catch (err) {
      this.api.logger.warn(
        `[tmux-watch] notify dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.debugSubscription(subscription, "notify dispatch threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!dispatchedPrimary) {
      this.debugSubscription(subscription, "dispatch produced no primary output; fallback to raw body");
      await this.sendToTarget(primary, body, {
        subscriptionId: subscription.id,
        phase: "primary-fallback",
      });
    }

    if (targets.length > 1) {
      const mirrorText = body;
      for (const target of targets.slice(1)) {
        await this.sendToTarget(target, mirrorText, {
          subscriptionId: subscription.id,
          phase: "mirror",
        });
      }
    }
    this.debugSubscription(subscription, "notify pipeline completed", {
      dispatchedPrimary,
      mirroredCount: Math.max(0, targets.length - 1),
    });
  }

  private async sendToTarget(
    target: ResolvedTarget,
    text: string,
    context?: { subscriptionId?: string; phase?: string },
  ): Promise<void> {
    const channel = target.channel.trim().toLowerCase();
    if (!channel || !text.trim()) {
      this.debugLog("send skipped due to empty channel or text", {
        channel: target.channel,
        target: target.target,
        subscriptionId: context?.subscriptionId,
        phase: context?.phase,
      });
      return;
    }
    const accountId = target.accountId?.trim() || undefined;
    const threadId = parseThreadId(target.threadId);
    this.debugLog("send attempt", {
      channel,
      target: target.target,
      accountId,
      threadId,
      source: target.source,
      textChars: text.length,
      subscriptionId: context?.subscriptionId,
      phase: context?.phase,
    });

    try {
      switch (channel) {
        case "telegram": {
          await this.api.runtime.channel.telegram.sendMessage(target.target, text, {
            accountId,
            messageThreadId: threadId,
          });
          this.debugLog("send success", {
            channel,
            target: target.target,
            subscriptionId: context?.subscriptionId,
            phase: context?.phase,
          });
          return;
        }
        case "slack": {
          await this.api.runtime.channel.slack.sendMessage(target.target, text, {
            accountId,
            threadTs: threadId != null ? String(threadId) : undefined,
          });
          this.debugLog("send success", {
            channel,
            target: target.target,
            subscriptionId: context?.subscriptionId,
            phase: context?.phase,
          });
          return;
        }
        case "discord": {
          await this.api.runtime.channel.discord.sendMessage(target.target, text, {
            accountId,
            replyTo: threadId != null ? String(threadId) : undefined,
          });
          this.debugLog("send success", {
            channel,
            target: target.target,
            subscriptionId: context?.subscriptionId,
            phase: context?.phase,
          });
          return;
        }
        case "signal": {
          await this.api.runtime.channel.signal.sendMessage(target.target, text, {
            accountId,
          });
          this.debugLog("send success", {
            channel,
            target: target.target,
            subscriptionId: context?.subscriptionId,
            phase: context?.phase,
          });
          return;
        }
        case "imessage": {
          await this.api.runtime.channel.imessage.sendMessage(target.target, text, {
            accountId,
          });
          this.debugLog("send success", {
            channel,
            target: target.target,
            subscriptionId: context?.subscriptionId,
            phase: context?.phase,
          });
          return;
        }
        case "line": {
          await this.api.runtime.channel.line.sendMessage(target.target, text, {
            accountId,
          });
          this.debugLog("send success", {
            channel,
            target: target.target,
            subscriptionId: context?.subscriptionId,
            phase: context?.phase,
          });
          return;
        }
        case "whatsapp":
        case "gewe-openclaw":
        case "web":
        case "webchat": {
          await this.api.runtime.channel.whatsapp.sendMessage(target.target, text, {
            accountId,
          });
          this.debugLog("send success", {
            channel,
            target: target.target,
            subscriptionId: context?.subscriptionId,
            phase: context?.phase,
          });
          return;
        }
        default: {
          this.api.logger.warn(`[tmux-watch] unsupported notify channel: ${target.channel}`);
          this.debugLog("send failed due to unsupported channel", {
            channel: target.channel,
            target: target.target,
            subscriptionId: context?.subscriptionId,
            phase: context?.phase,
          });
          return;
        }
      }
    } catch (err) {
      this.api.logger.warn(
        `[tmux-watch] send failed (${target.channel}:${target.target}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.debugLog("send threw", {
        channel: target.channel,
        target: target.target,
        error: err instanceof Error ? err.message : String(err),
        subscriptionId: context?.subscriptionId,
        phase: context?.phase,
      });
    }
  }

  private async resolveNotifyTargets(
    subscription: TmuxWatchSubscription,
    sessionKey: string,
  ): Promise<ResolvedTarget[]> {
    const targets: ResolvedTarget[] = [];
    const mode = resolveNotifyMode(subscription, this.config);
    const includeTargets = mode === "targets" || mode === "targets+last";
    const includeLast = mode === "last" || mode === "targets+last";

    if (includeTargets) {
      const configured = resolveNotifyTargetList(subscription, this.config);
      this.debugSubscription(subscription, "resolve notify targets from config", {
        configuredCount: configured.length,
      });
      for (const target of configured) {
        targets.push({
          channel: target.channel,
          target: target.target,
          accountId: target.accountId,
          threadId: parseThreadId(target.threadId),
          label: target.label,
          source: "targets",
        });
      }
    }

    if (includeLast) {
      const lastTargets = await this.resolveLastTargets(sessionKey);
      this.debugSubscription(subscription, "resolve notify targets from last session", {
        lastCount: lastTargets.length,
        sessionKey,
      });
      if (lastTargets.length > 0) {
        targets.push(...lastTargets);
      }
    }

    const deduped = dedupeTargets(targets);
    this.debugSubscription(subscription, "notify target dedupe completed", {
      before: targets.length,
      after: deduped.length,
    });
    return deduped;
  }

  private async resolveLastTargets(sessionKey: string): Promise<ResolvedTarget[]> {
    const store = await this.readSessionStore(sessionKey);
    if (!store) {
      this.debugLog("resolve last targets skipped: session store unavailable", { sessionKey });
      return [];
    }
    const targets = resolveLastTargetsFromStore({ store, sessionKey });
    this.debugLog("resolved last targets", {
      sessionKey,
      count: targets.length,
      targets: targets.map((target) => ({
        channel: target.channel,
        target: target.target,
        source: target.source,
      })),
    });
    return targets;
  }

  private async readSessionStore(
    sessionKey: string,
  ): Promise<Record<string, SessionEntryLike> | null> {
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const storePath = this.api.runtime.channel.session.resolveStorePath(
      this.api.config.session?.store,
      { agentId },
    );
    try {
      const raw = await fs.readFile(storePath, "utf8");
      const store = JSON.parse(raw) as Record<string, SessionEntryLike>;
      if (!store || typeof store !== "object") {
        this.debugLog("session store parsed to non-object", { sessionKey, storePath });
        return null;
      }
      this.debugLog("session store loaded", {
        sessionKey,
        storePath,
        entries: Object.keys(store).length,
      });
      return store;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.api.logger.warn(`[tmux-watch] session store read failed: ${message}`);
      this.debugLog("session store read failed", { sessionKey, storePath, error: message });
      return null;
    }
  }

  private async ensureTmuxAvailable(options?: { force?: boolean }): Promise<void> {
    const now = Date.now();
    if (!options?.force && now - this.tmuxLastCheckedAt < TMUX_RECHECK_INTERVAL_MS) {
      return;
    }
    this.tmuxLastCheckedAt = now;
    try {
      const res = await this.api.runtime.system.runCommandWithTimeout(["tmux", "-V"], {
        timeoutMs: 2000,
      });
      this.tmuxAvailable = res.code === 0;
      this.debugLog("tmux availability checked", {
        code: res.code,
        stdout: (res.stdout ?? "").trim(),
        stderr: (res.stderr ?? "").trim(),
        tmuxAvailable: this.tmuxAvailable,
      });
      if (!this.tmuxAvailable) {
        this.api.logger.warn("[tmux-watch] tmux not available (tmux -V failed)");
      }
    } catch (err) {
      this.tmuxAvailable = false;
      this.api.logger.warn(
        `[tmux-watch] tmux not available: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.debugLog("tmux availability check threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function createTmuxWatchManager(api: OpenClawPluginApi) {
  return new TmuxWatchManager(api);
}

function createRuntime(): WatchRuntime {
  return {
    running: false,
    stableTicks: 0,
  };
}

export function resolveIntervalMs(
  subscription: TmuxWatchSubscription,
  cfg: TmuxWatchConfig,
): number {
  const captureIntervalSeconds =
    typeof subscription.captureIntervalSeconds === "number" &&
    Number.isFinite(subscription.captureIntervalSeconds)
      ? subscription.captureIntervalSeconds
      : typeof cfg.captureIntervalSeconds === "number" && Number.isFinite(cfg.captureIntervalSeconds)
        ? cfg.captureIntervalSeconds
        : undefined;
  if (typeof captureIntervalSeconds === "number") {
    return Math.max(200, Math.trunc(captureIntervalSeconds * 1000));
  }
  const raw =
    typeof subscription.intervalMs === "number" && Number.isFinite(subscription.intervalMs)
      ? subscription.intervalMs
      : typeof cfg.pollIntervalMs === "number" && Number.isFinite(cfg.pollIntervalMs)
        ? cfg.pollIntervalMs
        : DEFAULT_CAPTURE_INTERVAL_SECONDS * 1000;
  return Math.max(200, Math.trunc(raw));
}

export function resolveStableCount(
  subscription: TmuxWatchSubscription,
  cfg: TmuxWatchConfig,
): number {
  const rawCount =
    typeof subscription.stableCount === "number" && Number.isFinite(subscription.stableCount)
      ? subscription.stableCount
      : typeof cfg.stableCount === "number" && Number.isFinite(cfg.stableCount)
        ? cfg.stableCount
        : undefined;
  if (typeof rawCount === "number") {
    return Math.max(1, Math.trunc(rawCount));
  }
  const stableSeconds =
    typeof subscription.stableSeconds === "number" && Number.isFinite(subscription.stableSeconds)
      ? subscription.stableSeconds
      : typeof cfg.stableSeconds === "number" && Number.isFinite(cfg.stableSeconds)
        ? cfg.stableSeconds
        : undefined;
  if (typeof stableSeconds === "number") {
    const intervalMs = resolveIntervalMs(subscription, cfg);
    return Math.max(1, Math.ceil((stableSeconds * 1000) / intervalMs));
  }
  return DEFAULT_STABLE_COUNT;
}

function resolveStableTicks(subscription: TmuxWatchSubscription, cfg: TmuxWatchConfig): number {
  return resolveStableCount(subscription, cfg);
}

export function resolveStableDurationSeconds(
  subscription: TmuxWatchSubscription,
  cfg: TmuxWatchConfig,
): number {
  const intervalMs = resolveIntervalMs(subscription, cfg);
  const stableCount = resolveStableCount(subscription, cfg);
  return (stableCount * intervalMs) / 1000;
}

function resolveCaptureLines(subscription: TmuxWatchSubscription, cfg: TmuxWatchConfig): number {
  const raw =
    typeof subscription.captureLines === "number" && Number.isFinite(subscription.captureLines)
      ? subscription.captureLines
      : cfg.captureLines;
  return Math.max(10, Math.trunc(raw));
}

function resolveStripAnsi(subscription: TmuxWatchSubscription, cfg: TmuxWatchConfig): boolean {
  return typeof subscription.stripAnsi === "boolean" ? subscription.stripAnsi : cfg.stripAnsi;
}

function resolveNotifyMode(subscription: TmuxWatchSubscription, cfg: TmuxWatchConfig): NotifyMode {
  const mode = subscription.notify?.mode;
  if (mode === "last" || mode === "targets" || mode === "targets+last") {
    return mode;
  }
  return cfg.notify.mode;
}

function resolveNotifyTargetList(
  subscription: TmuxWatchSubscription,
  cfg: TmuxWatchConfig,
): NotifyTarget[] {
  const targets = subscription.notify?.targets;
  if (Array.isArray(targets) && targets.length > 0) {
    return sanitizeTargets(targets);
  }
  return sanitizeTargets(cfg.notify.targets);
}

function sanitizeTargets(targets: NotifyTarget[]): NotifyTarget[] {
  const out: NotifyTarget[] = [];
  for (const target of targets) {
    const channel = typeof target.channel === "string" ? target.channel.trim() : "";
    const to = typeof target.target === "string" ? target.target.trim() : "";
    if (!channel || !to) {
      continue;
    }
    out.push({
      channel,
      target: to,
      accountId: typeof target.accountId === "string" ? target.accountId.trim() : undefined,
      threadId: typeof target.threadId === "string" ? target.threadId.trim() : undefined,
      label: typeof target.label === "string" ? target.label.trim() : undefined,
    });
  }
  return out;
}

function sanitizeSubscriptionInput(
  input: Partial<TmuxWatchSubscription> & { target: string },
): TmuxWatchSubscription {
  const notifyTargets = Array.isArray(input.notify?.targets)
    ? sanitizeTargets(input.notify?.targets)
    : undefined;
  return {
    id: input.id?.trim() ?? "",
    label: typeof input.label === "string" ? input.label.trim() : undefined,
    note: typeof input.note === "string" ? input.note.trim() : undefined,
    target: input.target.trim(),
    socket: normalizeTmuxSocket(input.socket),
    sessionKey: typeof input.sessionKey === "string" ? input.sessionKey.trim() : undefined,
    captureIntervalSeconds: input.captureIntervalSeconds,
    intervalMs: input.intervalMs,
    stableCount: input.stableCount,
    stableSeconds: input.stableSeconds,
    captureLines: input.captureLines,
    stripAnsi: input.stripAnsi,
    enabled: input.enabled,
    notify:
      input.notify?.mode || notifyTargets
        ? {
            mode: input.notify?.mode,
            targets: notifyTargets,
          }
        : undefined,
  };
}

function resolveAgentIdFromSessionKey(sessionKey: string | undefined): string {
  const raw = typeof sessionKey === "string" ? sessionKey.trim().toLowerCase() : "";
  if (!raw) {
    return "main";
  }
  if (raw.startsWith("agent:")) {
    const parts = raw.split(":");
    return parts[1] || "main";
  }
  return "main";
}

function normalizeAgentId(value: string | undefined): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) {
    return "main";
  }
  const valid = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
  if (valid.test(trimmed)) {
    return trimmed;
  }
  return (
    trimmed
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 64) || "main"
  );
}

function normalizeMainKey(value: string | undefined): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  return trimmed || "main";
}

function resolveDefaultSessionKey(cfg?: MinimalConfig): string {
  if (cfg?.session?.scope === "global") {
    return "global";
  }
  const agents = cfg?.agents?.list ?? [];
  const defaultAgentId =
    agents.find((entry) => entry?.default)?.id ?? agents[0]?.id ?? "main";
  const agentId = normalizeAgentId(defaultAgentId);
  const mainKey = normalizeMainKey(cfg?.session?.mainKey);
  return `agent:${agentId}:${mainKey}`;
}

function normalizeSessionKey(input: string | undefined, cfg?: MinimalConfig) {
  const trimmed = (input ?? "").trim();
  if (!trimmed || trimmed === "main") {
    return resolveDefaultSessionKey(cfg);
  }
  const mainKey = normalizeMainKey(cfg?.session?.mainKey);
  if (trimmed === mainKey) {
    return resolveDefaultSessionKey(cfg);
  }
  if (trimmed.toLowerCase() === "global" && cfg?.session?.scope === "global") {
    return "global";
  }
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("agent:") || lowered.startsWith("subagent:") || lowered === "global") {
    return lowered;
  }
  const defaultKey = resolveDefaultSessionKey(cfg);
  const agentId = resolveAgentIdFromSessionKey(defaultKey);
  return `agent:${normalizeAgentId(agentId)}:${lowered}`;
}

type TargetSnapshot = {
  channel: string;
  target: string;
  accountId?: string;
  threadId?: string | number;
};

function isInternalLastChannel(channel: string | undefined): boolean {
  if (!channel) {
    return false;
  }
  return INTERNAL_LAST_CHANNELS.has(channel.trim().toLowerCase());
}

function extractTargetSnapshot(entry: SessionEntryLike): TargetSnapshot | null {
  const delivery = entry.deliveryContext ?? {};
  const channel =
    typeof delivery.channel === "string"
      ? delivery.channel.trim()
      : typeof entry.lastChannel === "string"
        ? entry.lastChannel.trim()
        : typeof entry.channel === "string"
          ? entry.channel.trim()
          : undefined;
  const target =
    typeof delivery.to === "string"
      ? delivery.to.trim()
      : typeof entry.lastTo === "string"
        ? entry.lastTo.trim()
        : undefined;
  if (!channel || !target) {
    return null;
  }
  const accountId =
    typeof delivery.accountId === "string"
      ? delivery.accountId.trim()
      : typeof entry.lastAccountId === "string"
        ? entry.lastAccountId.trim()
        : undefined;
  const threadId =
    delivery.threadId ?? entry.lastThreadId ?? entry.origin?.threadId ?? undefined;
  return {
    channel,
    target,
    accountId: accountId || undefined,
    threadId,
  };
}

function snapshotKey(snapshot: TargetSnapshot): string {
  return [snapshot.channel, snapshot.target, snapshot.accountId ?? "", snapshot.threadId ?? ""].join(
    "|",
  );
}

function findLatestExternalTarget(
  store: Record<string, SessionEntryLike>,
  exclude: TargetSnapshot,
): TargetSnapshot | null {
  const excludeKey = snapshotKey(exclude);
  let best: { updatedAt: number; target: TargetSnapshot } | null = null;
  for (const entry of Object.values(store)) {
    const snapshot = extractTargetSnapshot(entry);
    if (!snapshot) {
      continue;
    }
    if (isInternalLastChannel(snapshot.channel)) {
      continue;
    }
    if (snapshotKey(snapshot) === excludeKey) {
      continue;
    }
    const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
    if (!best || updatedAt > best.updatedAt) {
      best = { updatedAt, target: snapshot };
    }
  }
  return best?.target ?? null;
}

function toResolvedTarget(
  snapshot: TargetSnapshot,
  source: ResolvedTarget["source"],
): ResolvedTarget {
  return {
    channel: snapshot.channel,
    target: snapshot.target,
    accountId: snapshot.accountId,
    threadId: parseThreadId(snapshot.threadId),
    label: undefined,
    source,
  };
}

export function resolveLastTargetsFromStore(params: {
  store: Record<string, SessionEntryLike>;
  sessionKey: string;
}): ResolvedTarget[] {
  const entry =
    params.store[params.sessionKey] ??
    params.store[params.sessionKey.toLowerCase()] ??
    null;
  if (!entry) {
    return [];
  }
  const primary = extractTargetSnapshot(entry);
  if (!primary) {
    return [];
  }
  if (!isInternalLastChannel(primary.channel)) {
    return [toResolvedTarget(primary, "last")];
  }
  const fallback = findLatestExternalTarget(params.store, primary);
  if (fallback) {
    return [toResolvedTarget(fallback, "last-fallback")];
  }
  return [toResolvedTarget(primary, "last")];
}

function hashOutput(output: string): string {
  return createHash("sha256").update(output).digest("hex");
}

function parseThreadId(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  return trimmed;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "\"[unserializable]\"";
  }
}

export function extractReplyText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const value = payload as { text?: unknown };
  return typeof value.text === "string" ? value.text : undefined;
}

export { stripAnsi, truncateOutput };

function dedupeTargets(targets: ResolvedTarget[]): ResolvedTarget[] {
  const seen = new Set<string>();
  const out: ResolvedTarget[] = [];
  for (const target of targets) {
    const key = [
      target.channel,
      target.target,
      target.accountId ?? "",
      target.threadId ?? "",
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(target);
  }
  return out;
}
