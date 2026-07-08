import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { OVMessage, SessionContextResult } from "../client.js";
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
 * Build the full transcript entry list (header + message entries) from an
 * OpenViking assembled session context. Earlier (archived) turns are folded
 * into one leading summary message; recent turns are converted verbatim.
 */
export function buildTranscriptEntries(params: {
  sessionId: string;
  cwd: string;
  ovContext: SessionContextResult;
  baseMs: number;
  model: string;
  provider: string;
}): TranscriptEntry[] {
  const { sessionId, cwd, ovContext, baseMs, model, provider } = params;
  const entries: TranscriptEntry[] = [
    { type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp: isoFromMs(baseMs), cwd },
  ];

  const agentMessages: AgentMessage[] = [];

  const overview = (ovContext.latest_archive_overview ?? "").trim();
  const abstracts = (ovContext.pre_archive_abstracts ?? [])
    .map((a) => (a?.abstract ?? "").trim())
    .filter(Boolean);
  if (overview || abstracts.length > 0) {
    const summary = [
      "[Earlier conversation — restored from OpenViking]",
      overview,
      ...(abstracts.length ? ["", ...abstracts.map((a) => `- ${a}`)] : []),
    ]
      .filter((line, i) => line !== "" || i > 0)
      .join("\n");
    agentMessages.push({ role: "user", content: summary });
  }

  const ovMessages: OVMessage[] = Array.isArray(ovContext.messages) ? ovContext.messages : [];
  for (const ovMsg of ovMessages) {
    for (const converted of convertToAgentMessages({ role: ovMsg.role, parts: ovMsg.parts })) {
      agentMessages.push(converted);
    }
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
}): Record<string, unknown> {
  return {
    sessionId: params.sessionId,
    updatedAt: params.updatedAt,
    sessionFile: params.sessionFile,
    chatType: "direct",
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
  ovContext: SessionContextResult;
  openclawAgentId: string;
  stateDir: string;
  cwd: string;
  nowMs: number;
  model?: string;
  provider?: string;
  label?: string;
}): Promise<HydrateResult> {
  const model = params.model?.trim() || "openviking-restored";
  const provider = params.provider?.trim() || "openviking";
  const sessionsDir = join(params.stateDir, "agents", params.openclawAgentId, "sessions");
  const fileName = `${params.ovSessionId}.jsonl`;
  const filePath = join(sessionsDir, fileName);
  const storePath = join(sessionsDir, "sessions.json");
  const sessionKey = `agent:${params.openclawAgentId}:${params.ovSessionId}`;

  const entries = buildTranscriptEntries({
    sessionId: params.ovSessionId,
    cwd: params.cwd,
    ovContext: params.ovContext,
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
