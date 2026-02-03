import type { NotifyMode, NotifyTarget } from "./config.js";
import type { TmuxWatchManager, TmuxWatchSubscription } from "./manager.js";

const ACTIONS = ["add", "remove", "list", "capture"] as const;
const NOTIFY_MODES = ["last", "targets", "targets+last"] as const;

type ToolParams = {
  action: (typeof ACTIONS)[number];
  id?: string;
  target?: string;
  label?: string;
  note?: string;
  sessionKey?: string;
  socket?: string;
  captureIntervalSeconds?: number;
  intervalMs?: number;
  stableCount?: number;
  stableSeconds?: number;
  captureLines?: number;
  stripAnsi?: boolean;
  format?: string;
  imageFormat?: string;
  outputPath?: string;
  base64?: boolean;
  ttlSeconds?: number;
  maxChars?: number;
  enabled?: boolean;
  notifyMode?: NotifyMode;
  targets?: NotifyTarget[];
  includeOutput?: boolean;
};

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: unknown;
};

function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeTargets(raw: NotifyTarget[] | undefined): NotifyTarget[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const targets: NotifyTarget[] = [];
  for (const entry of raw) {
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
  return targets.length > 0 ? targets : undefined;
}

export function createTmuxWatchTool(manager: TmuxWatchManager) {
  return {
    name: "tmux-watch",
    description:
      "Manage tmux-watch subscriptions (add/remove/list) or capture tmux output.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: [...ACTIONS],
          description: `Action to perform: ${ACTIONS.join(", ")}`,
        },
        id: { type: "string", description: "Subscription id." },
        target: { type: "string", description: "tmux target, e.g. session:0.0" },
        label: { type: "string", description: "Human-friendly label." },
        note: { type: "string", description: "Purpose/intent note shown to the agent on alert." },
        sessionKey: { type: "string", description: "Session key override." },
        socket: { type: "string", description: "tmux socket path (for -S)." },
        captureIntervalSeconds: { type: "number", description: "Capture interval in seconds." },
        intervalMs: { type: "number", description: "Legacy: capture interval in ms." },
        stableCount: {
          type: "number",
          description: "Consecutive identical captures before alert.",
        },
        stableSeconds: { type: "number", description: "Legacy: stable duration in seconds." },
        captureLines: { type: "number", description: "Lines to capture." },
        stripAnsi: { type: "boolean", description: "Strip ANSI escape codes." },
        format: { type: "string", description: "Capture format: text, image, or both." },
        imageFormat: { type: "string", description: "Image format: png, svg, webp." },
        outputPath: { type: "string", description: "Image output path (optional)." },
        base64: { type: "boolean", description: "Include base64 image output." },
        ttlSeconds: {
          type: "number",
          description: "Temporary image TTL in seconds (default 600).",
        },
        maxChars: { type: "number", description: "Max characters for text output." },
        enabled: { type: "boolean", description: "Enable or disable subscription." },
        notifyMode: {
          type: "string",
          enum: [...NOTIFY_MODES],
          description: "Notify mode override.",
        },
        targets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              channel: { type: "string", description: "Channel id (e.g. telegram, gewe)." },
              target: { type: "string", description: "Channel target id." },
              accountId: { type: "string", description: "Provider account id." },
              threadId: { type: "string", description: "Thread id." },
              label: { type: "string", description: "Label for this target." },
            },
          },
        },
        includeOutput: { type: "boolean", description: "Include last captured output in list." },
      },
      required: ["action"],
    },
    async execute(_id: string, params: ToolParams): Promise<ToolResult> {
      try {
        switch (params.action) {
          case "add": {
            const target = readString(params.target);
            if (!target) {
              throw new Error("target required for add action");
            }
            const subscription: Partial<TmuxWatchSubscription> & { target: string } = {
              id: readString(params.id),
              target,
              label: readString(params.label),
              note: readString(params.note),
              sessionKey: readString(params.sessionKey),
              socket: readString(params.socket),
              captureIntervalSeconds:
                typeof params.captureIntervalSeconds === "number"
                  ? params.captureIntervalSeconds
                  : undefined,
              intervalMs:
                typeof params.intervalMs === "number" ? params.intervalMs : undefined,
              stableCount:
                typeof params.stableCount === "number" ? params.stableCount : undefined,
              stableSeconds:
                typeof params.stableSeconds === "number" ? params.stableSeconds : undefined,
              captureLines:
                typeof params.captureLines === "number" ? params.captureLines : undefined,
              stripAnsi: typeof params.stripAnsi === "boolean" ? params.stripAnsi : undefined,
              enabled: typeof params.enabled === "boolean" ? params.enabled : undefined,
              notify:
                params.notifyMode || params.targets
                  ? {
                      mode: params.notifyMode,
                      targets: normalizeTargets(params.targets),
                    }
                  : undefined,
            };
            const created = await manager.addSubscription(subscription);
            return jsonResult({ ok: true, subscription: created });
          }
          case "remove": {
            const id = readString(params.id);
            if (!id) {
              throw new Error("id required for remove action");
            }
            const removed = await manager.removeSubscription(id);
            return jsonResult({ ok: removed });
          }
          case "list": {
            const items = await manager.listSubscriptions({
              includeOutput: params.includeOutput !== false,
            });
            return jsonResult({ ok: true, subscriptions: items });
          }
          case "capture": {
            const target = readString(params.target);
            if (!target) {
              throw new Error("target required for capture action");
            }
            const result = await manager.capture({
              target,
              socket: readString(params.socket),
              captureLines:
                typeof params.captureLines === "number" ? params.captureLines : undefined,
              stripAnsi: typeof params.stripAnsi === "boolean" ? params.stripAnsi : undefined,
              format: readString(params.format),
              imageFormat: readString(params.imageFormat),
              outputPath: readString(params.outputPath),
              base64: typeof params.base64 === "boolean" ? params.base64 : undefined,
              ttlSeconds:
                typeof params.ttlSeconds === "number" ? params.ttlSeconds : undefined,
              maxChars: typeof params.maxChars === "number" ? params.maxChars : undefined,
            });
            return jsonResult({ ok: true, capture: result });
          }
          default: {
            params.action satisfies never;
            throw new Error(`Unknown action: ${String(params.action)}`);
          }
        }
      } catch (err) {
        return jsonResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
