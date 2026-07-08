import type { SessionContextResult, SessionListEntry, SessionMetaResult } from "../client.js";
import { parseOpenclawAgentId, type HydrateResult } from "./openviking-session-hydration.js";

export type ConversationsListInput = { action: "list"; limit?: number };
export type ConversationsRestoreInput = { action: "restore"; sessionId: string; tokenBudget?: number };
export type ConversationsCommandInput = ConversationsListInput | ConversationsRestoreInput;

/** Current-session routing passed from the command handler. */
export type ConversationsSession = {
  agentId?: string;
  sessionKey?: string;
  ovSessionId?: string;
};

export type OpenVikingConversationsToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
};

type OpenVikingConversationsClient = {
  listSessions: (actorPeerId?: string) => Promise<SessionListEntry[]>;
  getSession: (sessionId: string, actorPeerId?: string) => Promise<SessionMetaResult>;
  getSessionContext: (
    sessionId: string,
    tokenBudget?: number,
    actorPeerId?: string,
  ) => Promise<SessionContextResult>;
};

/** Writes the restored session into OpenClaw's local store (see openviking-session-hydration). */
export type HydrateSessionFn = (args: {
  ovSessionId: string;
  ovContext: SessionContextResult;
  openclawAgentId: string;
  label?: string;
}) => Promise<HydrateResult>;

export type OpenVikingConversationsRuntimeDeps = {
  getClient: () => Promise<OpenVikingConversationsClient>;
  hydrateSession: HydrateSessionFn;
  logger?: { warn?: (message: string) => void };
};

export const CONVERSATION_LIST_DEFAULT_LIMIT = 20;
/** Cap on per-session metadata lookups so listing stays bounded on large stores. */
export const CONVERSATION_ENRICH_CAP = 200;
export const CONVERSATION_RESTORE_DEFAULT_TOKENS = 128_000;

export type ConversationRow = { session_id: string; modTime: string; meta: SessionMetaResult | null };

function formatConversationTimestamp(value: string): string {
  const raw = value.trim();
  if (!raw) {
    return "-";
  }
  // ISO-ish "2026-01-07T17:24:00Z" -> "2026-01-07 17:24"
  const normalized = raw.replace("T", " ");
  return normalized.length >= 16 ? normalized.slice(0, 16) : normalized;
}

function conversationRowTime(row: ConversationRow): string {
  return (
    row.modTime ||
    row.meta?.updated_at ||
    row.meta?.last_commit_at ||
    row.meta?.created_at ||
    ""
  );
}

export function formatConversationsList(
  rows: ConversationRow[],
  opts: { total: number; enrichTruncated: number },
): string {
  if (rows.length === 0) {
    return "No OpenViking conversations found for the current user.";
  }
  const idWidth = Math.max(10, ...rows.map((row) => row.session_id.length));
  const header = `${"#".padEnd(3)}  ${"session_id".padEnd(idWidth)}  ${"updated".padEnd(16)}  ${"msgs".padStart(5)}  agents`;
  const lines = rows.map((row, index) => {
    const meta = row.meta;
    const updated = formatConversationTimestamp(conversationRowTime(row));
    const msgs = meta?.total_message_count ?? meta?.message_count;
    const msgsStr = typeof msgs === "number" ? String(msgs) : "?";
    const agents = (meta?.participant_agent_ids ?? []).join(",") || "-";
    return `${String(index + 1).padEnd(3)}  ${row.session_id.padEnd(idWidth)}  ${updated.padEnd(16)}  ${msgsStr.padStart(5)}  ${agents}`;
  });
  const footer: string[] = [
    "",
    `Showing ${rows.length} of ${opts.total} conversation(s) for the current user.`,
    "Resume one with: /conversations restore <session_id>",
  ];
  if (opts.enrichTruncated > 0) {
    footer.push(
      `Note: ${opts.enrichTruncated} older session(s) were not inspected (enrichment cap ${CONVERSATION_ENRICH_CAP}).`,
    );
  }
  return [header, ...lines, ...footer].join("\n");
}

export function createOpenVikingConversationsRuntime(
  deps: OpenVikingConversationsRuntimeDeps,
): {
  runConversations: (
    input: ConversationsCommandInput,
    session: ConversationsSession,
  ) => Promise<OpenVikingConversationsToolResult>;
} {
  const listConversations = async (
    input: ConversationsListInput,
    session: ConversationsSession,
  ): Promise<OpenVikingConversationsToolResult> => {
    const client = await deps.getClient();
    const limit = Math.max(1, Math.floor(input.limit ?? CONVERSATION_LIST_DEFAULT_LIMIT));
    const entries = (await client.listSessions(session.agentId)).filter(
      (entry) => entry && entry.session_id && entry.is_dir !== false,
    );

    // Metadata is fetched per session; cap the pool so listing stays bounded.
    const capped = entries.slice(0, CONVERSATION_ENRICH_CAP);
    const enrichTruncated = entries.length - capped.length;
    const rows: ConversationRow[] = await Promise.all(
      capped.map(async (entry): Promise<ConversationRow> => {
        const modTime = typeof entry.mod_time === "string" ? entry.mod_time : "";
        try {
          const meta = await client.getSession(entry.session_id, session.agentId);
          return { session_id: entry.session_id, modTime, meta };
        } catch (err) {
          deps.logger?.warn?.(
            `openviking: failed to enrich session ${entry.session_id} for /conversations: ${String(err)}`,
          );
          return { session_id: entry.session_id, modTime, meta: null };
        }
      }),
    );

    // Newest first; timestamps are ISO strings so lexicographic sort is chronological.
    rows.sort((a, b) => conversationRowTime(b).localeCompare(conversationRowTime(a)));
    const top = rows.slice(0, limit);

    const text = formatConversationsList(top, { total: rows.length, enrichTruncated });
    return {
      content: [{ type: "text" as const, text }],
      details: {
        action: "list_conversations",
        total: rows.length,
        shown: top.length,
        sessions: top.map((row) => ({ session_id: row.session_id, mod_time: row.modTime, ...(row.meta ?? {}) })),
      },
    };
  };

  const restoreConversation = async (
    input: ConversationsRestoreInput,
    session: ConversationsSession,
  ): Promise<OpenVikingConversationsToolResult> => {
    const targetSessionId = input.sessionId.trim();
    if (!targetSessionId) {
      throw new Error("session id is required to restore a conversation");
    }

    const client = await deps.getClient();
    let ovContext: SessionContextResult;
    try {
      ovContext = await client.getSessionContext(
        targetSessionId,
        input.tokenBudget ?? CONVERSATION_RESTORE_DEFAULT_TOKENS,
        session.agentId,
      );
    } catch (err) {
      throw new Error(`Conversation ${targetSessionId} not found or unreadable: ${String(err)}`);
    }

    const openclawAgentId = parseOpenclawAgentId(session.sessionKey);
    const result = await deps.hydrateSession({
      ovSessionId: targetSessionId,
      ovContext,
      openclawAgentId,
      label: `OpenViking ${targetSessionId.slice(0, 8)}`,
    });

    const text = [
      `Restored conversation ${targetSessionId} into your local OpenClaw sessions (${result.messageCount} message(s)).`,
      "Switch to it and keep chatting:",
      `  /session ${result.sessionKey}`,
      `  (or from a shell:  openclaw tui --session ${result.sessionKey} )`,
    ].join("\n");
    return {
      content: [{ type: "text" as const, text }],
      details: {
        action: "hydrate_conversation",
        targetSessionId,
        sessionKey: result.sessionKey,
        sessionFile: result.sessionFile,
        messageCount: result.messageCount,
      },
    };
  };

  const runConversations = async (
    input: ConversationsCommandInput,
    session: ConversationsSession,
  ): Promise<OpenVikingConversationsToolResult> => {
    return input.action === "restore"
      ? restoreConversation(input, session)
      : listConversations(input, session);
  };

  return { runConversations };
}
