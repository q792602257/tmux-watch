declare module "openclaw/plugin-sdk" {
  type TSchema = import("@sinclair/typebox").TSchema;

  type BasicSendOptions = {
    accountId?: string;
  };

  type TelegramSendOptions = BasicSendOptions & {
    messageThreadId?: string | number;
  };

  type SlackSendOptions = BasicSendOptions & {
    threadTs?: string;
  };

  type DiscordSendOptions = BasicSendOptions & {
    replyTo?: string;
  };

  type ReplyPayload = {
    text?: string;
  };
  export type OpenClawConfig = {
    session?: {
      store?: unknown;
      scope?: string;
      mainKey?: string;
    };
    agents?: {
      list?: Array<{ id?: string; default?: boolean }>;
    };
  } & Record<string, unknown>;

  export type OpenClawPluginServiceContext = {
    stateDir?: string;
  };

  export type OpenClawPluginService = {
    id: string;
    start?: (ctx: OpenClawPluginServiceContext) => Promise<void> | void;
    stop?: () => Promise<void> | void;
  };

  export type OpenClawPluginApi = {
    pluginConfig: unknown;
    config: OpenClawConfig;
    logger: {
      debug: (message: string) => void;
      info: (message: string) => void;
      warn: (message: string) => void;
      error: (message: string) => void;
    };
    registerTool: (tool: unknown) => void;
    registerService: (service: OpenClawPluginService) => void;
    registerCli: (handler: (ctx: { program: unknown }) => void, opts?: { commands?: string[] }) => void;
    runtime: {
      state: {
        resolveStateDir: () => string;
      };
      system: {
        runCommandWithTimeout: (
          argv: string[],
          opts: { timeoutMs: number },
        ) => Promise<{ code: number; stdout?: string; stderr?: string }>;
      };
      channel: {
        telegram: {
          sendMessage: (
            target: string,
            text: string,
            options?: TelegramSendOptions,
          ) => Promise<unknown>;
        };
        slack: {
          sendMessage: (
            target: string,
            text: string,
            options?: SlackSendOptions,
          ) => Promise<unknown>;
        };
        discord: {
          sendMessage: (
            target: string,
            text: string,
            options?: DiscordSendOptions,
          ) => Promise<unknown>;
        };
        signal: {
          sendMessage: (
            target: string,
            text: string,
            options?: BasicSendOptions,
          ) => Promise<unknown>;
        };
        imessage: {
          sendMessage: (
            target: string,
            text: string,
            options?: BasicSendOptions,
          ) => Promise<unknown>;
        };
        line: {
          sendMessage: (
            target: string,
            text: string,
            options?: BasicSendOptions,
          ) => Promise<unknown>;
        };
        whatsapp: {
          sendMessage: (
            target: string,
            text: string,
            options?: BasicSendOptions,
          ) => Promise<unknown>;
        };
        [key: string]: unknown;
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: (args: {
            ctx: unknown;
            cfg: OpenClawConfig;
            dispatcherOptions: {
              deliver: (payload: ReplyPayload, info: { kind: string }) => Promise<void> | void;
              onError: (err: unknown) => void;
            };
          }) => Promise<void>;
        };
        session: {
          resolveStorePath: (store: unknown, opts: { agentId: string }) => string;
        };
      };
      config: {
        loadConfig: () => Record<string, unknown>;
        writeConfigFile: (cfg: Record<string, unknown>) => Promise<void>;
      };
    };
  };

  export function stringEnum<T extends readonly string[]>(
    values: T,
    opts?: { description?: string },
  ): TSchema;
}
