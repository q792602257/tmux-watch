import { normalizeTmuxSocket } from "./socket.js";

export type NotifyMode = "last" | "targets" | "targets+last";

export type NotifyTarget = {
  channel: string;
  target: string;
  accountId?: string;
  threadId?: string;
  label?: string;
};

export type TmuxWatchConfig = {
  enabled: boolean;
  debug: boolean;
  captureIntervalSeconds?: number;
  pollIntervalMs?: number;
  stableCount?: number;
  stableSeconds?: number;
  captureLines: number;
  stripAnsi: boolean;
  maxOutputChars: number;
  sessionKey?: string;
  socket?: string;
  notify: {
    mode: NotifyMode;
    targets: NotifyTarget[];
  };
};

export const DEFAULT_CAPTURE_INTERVAL_SECONDS = 10;
export const DEFAULT_STABLE_COUNT = 6;

const DEFAULTS: Omit<TmuxWatchConfig, "captureIntervalSeconds" | "pollIntervalMs" | "stableCount" | "stableSeconds"> = {
  enabled: true,
  debug: false,
  captureLines: 50,
  stripAnsi: true,
  maxOutputChars: 4000,
  sessionKey: undefined,
  socket: undefined,
  notify: {
    mode: "last",
    targets: [],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNumber(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  return fallback;
}

function readOptionalNumber(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  return undefined;
}

function readBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function readString(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeNotifyMode(raw: unknown, fallback: NotifyMode): NotifyMode {
  if (raw === "last" || raw === "targets" || raw === "targets+last") {
    return raw;
  }
  return fallback;
}

function normalizeTargets(raw: unknown): NotifyTarget[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const targets: NotifyTarget[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    const channel = readString(entry.channel);
    const target = readString(entry.target);
    if (!channel || !target) {
      continue;
    }
    targets.push({
      channel,
      target,
      accountId: readString(entry.accountId),
      threadId: readString(entry.threadId),
      label: readString(entry.label),
    });
  }
  return targets;
}

export function resolveTmuxWatchConfig(raw: unknown): TmuxWatchConfig {
  const value = isRecord(raw) ? raw : {};
  const notifyRaw = isRecord(value.notify) ? value.notify : {};

  const captureLines = Math.max(10, readNumber(value.captureLines, DEFAULTS.captureLines));
  const maxOutputChars = Math.max(200, readNumber(value.maxOutputChars, DEFAULTS.maxOutputChars));

  return {
    enabled: readBoolean(value.enabled, DEFAULTS.enabled),
    debug: readBoolean(value.debug, DEFAULTS.debug),
    captureIntervalSeconds: readOptionalNumber(value.captureIntervalSeconds),
    pollIntervalMs: readOptionalNumber(value.pollIntervalMs),
    stableCount: readOptionalNumber(value.stableCount),
    stableSeconds: readOptionalNumber(value.stableSeconds),
    captureLines,
    stripAnsi: readBoolean(value.stripAnsi, DEFAULTS.stripAnsi),
    maxOutputChars,
    sessionKey: readString(value.sessionKey) ?? DEFAULTS.sessionKey,
    socket: normalizeTmuxSocket(value.socket) ?? DEFAULTS.socket,
    notify: {
      mode: normalizeNotifyMode(notifyRaw.mode, DEFAULTS.notify.mode),
      targets: normalizeTargets(notifyRaw.targets),
    },
  };
}
