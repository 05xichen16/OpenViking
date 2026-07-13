import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { OVMessage } from "../client.js";
import {
  convertToAgentMessages,
  sanitizeAgentMessagesForProvider,
  type AgentMessage,
} from "../services/context-message-adapter.js";

/** Matches OpenClaw's CURRENT_SESSION_VERSION (src/config/sessions/version.ts). */
const CURRENT_SESSION_VERSION = 3;

export type TranscriptSessionHeader = {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
};

export type TranscriptMessageEntry = {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: AgentMessage;
};

export type TranscriptEntry = TranscriptSessionHeader | TranscriptMessageEntry;

export type SessionsJson = Record<string, Record<string, unknown>>;

/** Session KEY looks like `agent:<agentId>:<rest>`; default OpenClaw agent is "main". */
export function parseOpenclawAgentId(sessionKey?: string): string {
  const raw = typeof sessionKey === "string" ? sessionKey.trim() : "";
  const match = raw.match(/^agent:([^:]+):/);
  return match?.[1]?.trim() || "main";
}

/** OPENCLAW_STATE_DIR (if set) else ~/.openclaw — mirrors commands/setup.ts. */
export function resolveOpenclawStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_STATE_DIR?.trim();
  return explicit || join(homedir(), ".openclaw");
}

const AGENT_ID_VALID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * Mirror OpenClaw's routing/session-key.ts::normalizeAgentId so the session-store
 * PATH we write to matches the directory OpenClaw physically reads from. OpenClaw
 * lowercases the id and, for path/shell safety, collapses anything outside
 * [a-z0-9_-] to "-" (note "." is NOT allowed in an agent id, unlike a session id).
 */
export function normalizeOpenclawAgentId(value?: string): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return "main";
  }
  const lower = trimmed.toLowerCase();
  if (AGENT_ID_VALID_RE.test(trimmed)) {
    return lower;
  }
  return (
    lower
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 64) || "main"
  );
}

/** Expand a leading `~`, `~/`, or `~\` against home — mirrors OpenClaw expandHomePrefix. */
function expandHome(input: string, home: string): string {
  if (!input.startsWith("~")) {
    return input;
  }
  return input.replace(/^~(?=$|[\\/])/, home);
}

/**
 * Resolve the on-disk `sessions.json` store path exactly as OpenClaw does
 * (src/config/sessions/paths.ts::resolveStorePath), honoring the user's
 * `session.store` config so a restore writes where OpenClaw actually reads:
 *   - unset            → <stateDir>/agents/<agentId>/sessions/sessions.json
 *   - "{agentId}" tmpl → expanded per-agent, then ~-expanded / resolved
 *   - "~"-relative     → expanded against home
 *   - otherwise        → resolved as an absolute/relative path
 * The transcript `.jsonl` is written alongside it (in the store's directory).
 */
export function resolveSessionStorePath(params: {
  store?: string;
  agentId: string;
  stateDir: string;
  home?: string;
}): string {
  const agentId = normalizeOpenclawAgentId(params.agentId);
  const home = params.home ?? homedir();
  const store = params.store?.trim();
  if (!store) {
    return join(params.stateDir, "agents", agentId, "sessions", "sessions.json");
  }
  if (store.includes("{agentId}")) {
    const expanded = store.replaceAll("{agentId}", agentId);
    return resolve(expanded.startsWith("~") ? expandHome(expanded, home) : expanded);
  }
  if (store.startsWith("~")) {
    return resolve(expandHome(store, home));
  }
  return resolve(store);
}

/**
 * Read the top-level `session.store` string from <stateDir>/openclaw.json, if any.
 * Returns undefined when unset/unreadable — callers then fall back to the default
 * per-agent store location. Same file as commands/conversations-cli.ts's
 * readOpenVikingRawConfig, different key path (top-level session.store, not the
 * plugin config).
 */
export function readOpenclawSessionStore(stateDir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, "openclaw.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const session = parsed?.session as Record<string, unknown> | undefined;
    const store = session?.store;
    return typeof store === "string" && store.trim() ? store : undefined;
  } catch {
    return undefined;
  }
}

/** Deterministic 8-hex entry id, unique within a single transcript file. */
function entryId(index: number): string {
  return (index + 1).toString(16).padStart(8, "0");
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Populate the fields OpenClaw persists per role. Content already matches
 * OpenClaw's content-block shape (from convertToAgentMessages); we add the
 * epoch-ms `timestamp` every message needs and the assistant accounting fields
 * (defaulted — OpenViking does not retain the original provider/usage).
 */
function withPersistedFields(
  message: AgentMessage,
  tsMs: number,
  model: string,
  provider: string,
): AgentMessage {
  const role = message.role;
  if (role === "assistant") {
    return {
      role: "assistant",
      content: Array.isArray(message.content) ? message.content : [],
      api: "openviking-restore",
      provider,
      model,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: tsMs,
    } as AgentMessage;
  }
  return { ...message, timestamp: tsMs } as AgentMessage;
}

/**
 * Build the full transcript entry list (header + message entries) from verbatim
 * OpenViking messages (archives + active tail, concatenated oldest-first). If no
 * verbatim messages are available, fall back to a single summary message.
 */
export function buildTranscriptEntries(params: {
  sessionId: string;
  cwd: string;
  messages: OVMessage[];
  summaryFallback?: string;
  baseMs: number;
  model: string;
  provider: string;
}): TranscriptEntry[] {
  const { sessionId, cwd, messages, summaryFallback, baseMs, model, provider } = params;
  const entries: TranscriptEntry[] = [
    { type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp: isoFromMs(baseMs), cwd },
  ];

  const agentMessages: AgentMessage[] = [];
  for (const ovMsg of Array.isArray(messages) ? messages : []) {
    for (const converted of convertToAgentMessages({ role: ovMsg.role, parts: ovMsg.parts })) {
      agentMessages.push(converted);
    }
  }

  // Only when the session has no verbatim messages (e.g. everything was
  // summarized away and the tail is empty) do we seed the archived summary.
  if (agentMessages.length === 0 && summaryFallback && summaryFallback.trim()) {
    agentMessages.push({
      role: "user",
      content: `[Earlier conversation — restored from OpenViking]\n${summaryFallback.trim()}`,
    });
  }

  const sanitized = sanitizeAgentMessagesForProvider(agentMessages);

  let parentId: string | null = null;
  sanitized.forEach((message, index) => {
    const id = entryId(index);
    const tsMs = baseMs + index * 1000;
    entries.push({
      type: "message",
      id,
      parentId,
      timestamp: isoFromMs(tsMs),
      message: withPersistedFields(message, tsMs, model, provider),
    });
    parentId = id;
  });

  return entries;
}

export function serializeTranscript(entries: TranscriptEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

export function buildSessionStoreEntry(params: {
  sessionId: string;
  sessionFile: string;
  updatedAt: number;
  model: string;
  modelProvider: string;
  label?: string;
  channel?: string;
  sessionStartedAt?: number;
}): Record<string, unknown> {
  // Write the SAME routing/lifecycle fields OpenClaw persists for its own local
  // sessions, so a restored session is structurally indistinguishable from a
  // native one. A minimal entry (id/file/model only) resumes on OpenClaw 2026.5.x
  // but breaks on 2026.6.x: the newer runtime derives a session's delivery context
  // ENTIRELY from these fields (dist delivery-context.shared `deliveryContextFromSession`
  // reads route/channel/origin/lastChannel/deliveryContext), so without them it
  // returns undefined and cannot reconstruct the session scene on resume.
  //
  // Default to the "webchat" surface with NO external target (to/accountId/threadId):
  // this mirrors what OpenClaw writes for its own local webchat/TUI sessions, i.e.
  // "render locally, do not deliver outbound", which is exactly what a resumed
  // restore should do.
  const channel = params.channel?.trim() || "webchat";
  const startedAt = params.sessionStartedAt ?? params.updatedAt;
  return {
    sessionId: params.sessionId,
    updatedAt: params.updatedAt,
    sessionStartedAt: startedAt,
    lastInteractionAt: params.updatedAt,
    systemSent: false,
    sessionFile: params.sessionFile,
    chatType: "direct",
    route: { channel },
    deliveryContext: { channel },
    lastChannel: channel,
    origin: { provider: channel, surface: channel, chatType: "direct" },
    compactionCount: 0,
    status: "done",
    model: params.model,
    modelProvider: params.modelProvider,
    ...(params.label ? { label: params.label, displayName: params.label } : {}),
  };
}

export function mergeSessionStoreEntry(
  existing: SessionsJson,
  key: string,
  entry: Record<string, unknown>,
): SessionsJson {
  return {
    ...existing,
    [key]: { ...(existing[key] ?? {}), ...entry },
  };
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.openviking.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

export type HydrateResult = {
  sessionKey: string;
  sessionFile: string;
  storePath: string;
  messageCount: number;
};

/**
 * Hydrate an OpenViking session into OpenClaw's LOCAL session store so that the
 * native `openclaw tui --session <key>` / `/session <key>` can resume it. Writes
 * two files: the transcript `.jsonl` and an entry in `sessions.json` (the store
 * is backed up to `sessions.json.openviking.bak` before it is rewritten).
 */
export async function hydrateSessionToLocalStore(params: {
  ovSessionId: string;
  messages: OVMessage[];
  summaryFallback?: string;
  openclawAgentId: string;
  stateDir: string;
  /** Raw `session.store` config (openclaw.json); undefined → default per-agent store. */
  sessionStore?: string;
  cwd: string;
  nowMs: number;
  model?: string;
  provider?: string;
  label?: string;
}): Promise<HydrateResult> {
  const model = params.model?.trim() || "openviking-restored";
  const provider = params.provider?.trim() || "openviking";
  // Write to wherever OpenClaw actually reads its store from (honors session.store),
  // not a hardcoded path — otherwise a custom-store user's restore lands in a dir
  // OpenClaw never reads and the session is silently unresumable.
  const storePath = resolveSessionStorePath({
    store: params.sessionStore,
    agentId: params.openclawAgentId,
    stateDir: params.stateDir,
  });
  const sessionsDir = dirname(storePath);
  const fileName = `${params.ovSessionId}.jsonl`;
  const filePath = join(sessionsDir, fileName);
  const sessionKey = `agent:${params.openclawAgentId}:${params.ovSessionId}`;

  const entries = buildTranscriptEntries({
    sessionId: params.ovSessionId,
    cwd: params.cwd,
    messages: params.messages,
    summaryFallback: params.summaryFallback,
    baseMs: params.nowMs,
    model,
    provider,
  });

  await mkdir(sessionsDir, { recursive: true });
  await writeFileAtomic(filePath, serializeTranscript(entries));

  let existing: SessionsJson = {};
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as SessionsJson;
      // Back up the real store before we rewrite it (recoverable on mishap).
      await writeFile(`${storePath}.openviking.bak`, JSON.stringify(existing, null, 2), "utf8").catch(() => undefined);
    }
  } catch {
    existing = {};
  }

  const merged = mergeSessionStoreEntry(
    existing,
    sessionKey,
    buildSessionStoreEntry({
      sessionId: params.ovSessionId,
      sessionFile: fileName,
      updatedAt: params.nowMs,
      model,
      modelProvider: provider,
      label: params.label,
    }),
  );
  await writeFileAtomic(storePath, JSON.stringify(merged, null, 2));

  return {
    sessionKey,
    sessionFile: filePath,
    storePath,
    messageCount: entries.filter((entry) => entry.type === "message").length,
  };
}
