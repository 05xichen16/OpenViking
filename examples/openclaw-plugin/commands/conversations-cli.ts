// `openclaw kmm conversations` — a shell-side entry point that mirrors the
// in-TUI /conversations command. It reuses the exact same argument grammar
// (parseConversationsCommandArgs) and runtime (createOpenVikingConversationsRuntime)
// as the slash command, so list / restore-by-number / resume / prefix behave
// identically outside the TUI. Runs standalone: reads config from openclaw.json,
// talks to the OpenViking server directly, and writes restored sessions to the
// local OpenClaw session store (no running gateway required).
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { memoryOpenVikingConfigSchema } from "../config.js";
import { parseConversationsCommandArgs } from "../plugin/openviking-command-args.js";
import { createOpenVikingClientRuntime } from "../plugin/openviking-client-runtime.js";
import { createOpenVikingConversationsRuntime } from "../plugin/openviking-conversations-runtime.js";
import {
  hydrateSessionToLocalStore,
  readOpenclawSessionStore,
  resolveOpenclawStateDir,
} from "../plugin/openviking-session-hydration.js";

/** Minimal Commander command surface (matches commands/setup.ts's CommandBuilder). */
export type ConversationsCliCommand = {
  description: (desc: string) => ConversationsCliCommand;
  option: (flags: string, desc: string) => ConversationsCliCommand;
  command: (name: string) => ConversationsCliCommand;
  action: (fn: (...args: unknown[]) => void | Promise<void>) => ConversationsCliCommand;
};

/** Read `plugins.entries.openviking.config` from <stateDir>/openclaw.json. */
export function readOpenVikingRawConfig(stateDir: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, "openclaw.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const plugins = parsed?.plugins as Record<string, unknown> | undefined;
    const entries = plugins?.entries as Record<string, unknown> | undefined;
    const entry = entries?.openviking as Record<string, unknown> | undefined;
    const config = entry?.config;
    return config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Map CLI positionals + flags into the same input the slash-command parser
 * produces, by re-serialising into an arg string. Keeps one grammar for both
 * surfaces (numbers, resume/last, id prefixes, full ids, --limit, --tokens).
 */
export function buildConversationsCliInput(
  selector: string[],
  options: { limit?: unknown; tokens?: unknown },
): ReturnType<typeof parseConversationsCommandArgs> {
  const parts = [...selector];
  if (options.limit != null) {
    parts.push("--limit", String(options.limit));
  }
  if (options.tokens != null) {
    parts.push("--tokens", String(options.tokens));
  }
  return parseConversationsCommandArgs(parts.join(" "));
}

function extractSelector(cliArgs: unknown[]): string[] {
  return Array.isArray(cliArgs[0]) ? (cliArgs[0] as string[]).filter((s) => typeof s === "string") : [];
}

function extractOptions(cliArgs: unknown[]): Record<string, unknown> {
  const found = cliArgs.find((arg) => arg && typeof arg === "object" && !Array.isArray(arg));
  return (found as Record<string, unknown> | undefined) ?? {};
}

/**
 * Attach `conversations` under the plugin's `openclaw kmm` CLI command.
 * The caller passes the already-created `kmm` command so there is exactly
 * one `kmm` command with all subcommands hanging off it.
 */
export function registerOpenVikingConversationsCommand(ovCmd: ConversationsCliCommand): void {
  ovCmd
    .command("conversations [selector...]")
    .description(
      "List past OpenViking conversations, or restore one into your local OpenClaw sessions. " +
        "Examples: `openclaw kmm conversations`, `conversations 3`, `conversations resume`, `conversations <id-prefix>`.",
    )
    .option("--limit <n>", "Max conversations to list")
    .option("--tokens <n>", "Token budget when restoring")
    .option("--agent <id>", "OpenClaw agent id for routing and local store (default: main)")
    .option("--json", "Output machine-readable JSON")
    .action(async (...cliArgs: unknown[]) => {
      const selector = extractSelector(cliArgs);
      const options = extractOptions(cliArgs);
      const jsonMode = options.json === true;
      const agent =
        typeof options.agent === "string" && options.agent.trim() ? options.agent.trim() : "main";

      // Primary output goes to real stdout via process.stdout.write: OpenClaw
      // routes plugin console.log to stderr, which would corrupt `--json | jq`.
      const fail = (message: string): void => {
        if (jsonMode) {
          process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
        } else {
          console.error(`OpenViking conversations failed: ${message}`);
        }
        process.exitCode = 1;
      };

      let input: ReturnType<typeof parseConversationsCommandArgs>;
      try {
        input = buildConversationsCliInput(selector, options);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
        return;
      }

      const stateDir = resolveOpenclawStateDir();
      const rawCfg = readOpenVikingRawConfig(stateDir);
      let cfg: ReturnType<typeof memoryOpenVikingConfigSchema.parse>;
      try {
        cfg = memoryOpenVikingConfigSchema.parse(rawCfg);
      } catch (err) {
        fail(
          `OpenViking is not configured (${err instanceof Error ? err.message : String(err)}). Run: openclaw openviking setup`,
        );
        return;
      }
      if (!cfg.baseUrl) {
        fail("OpenViking baseUrl is not set. Run: openclaw openviking setup");
        return;
      }

      const logger = {
        info: () => {},
        warn: (message: string) => console.error(message),
      };

      try {
        const { getClient } = createOpenVikingClientRuntime({
          cfg,
          rawPeerPrefix: rawCfg.peer_prefix,
          logger,
        });
        const { runConversations } = createOpenVikingConversationsRuntime({
          getClient,
          hydrateSession: (args) =>
            hydrateSessionToLocalStore({
              ...args,
              stateDir,
              sessionStore: readOpenclawSessionStore(stateDir),
              cwd: process.cwd(),
              nowMs: Date.now(),
            }),
          logger,
        });

        const result = await runConversations(input, {
          agentId: agent,
          // parseOpenclawAgentId reads the agent id from this key for the local store.
          sessionKey: `agent:${agent}:cli`,
        });

        if (jsonMode) {
          process.stdout.write(`${JSON.stringify(result.details ?? {}, null, 2)}\n`);
        } else {
          process.stdout.write(`${result.content[0]?.text ?? ""}\n`);
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });
}
