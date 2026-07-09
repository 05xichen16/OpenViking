import type { OVMessage, SessionListEntry, SessionMetaResult } from "../client.js";
import { parseOpenclawAgentId, type HydrateResult } from "./openviking-session-hydration.js";

/** See openviking-command-args: how a restore target was addressed on the CLI. */
export type ConversationsRestoreSelector =
  | { kind: "id"; value: string }
  | { kind: "index"; value: number }
  | { kind: "latest" };

export type ConversationsListInput = { action: "list"; limit?: number };
export type ConversationsRestoreInput = {
  action: "restore";
  selector: ConversationsRestoreSelector;
  tokenBudget?: number;
};
export type ConversationsCommandInput = ConversationsListInput | ConversationsRestoreInput;

/** A full OpenViking session id (UUID / 64-hex hash) is at least this long; a
 * shorter restore token is treated as a prefix and resolved against the list. */
const FULL_SESSION_ID_MIN_LENGTH = 32;

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

type SessionContextLite = {
  latest_archive_overview?: string;
  messages?: OVMessage[];
  stats?: { totalArchives?: number };
};

type OpenVikingConversationsClient = {
  listSessions: (actorPeerId?: string) => Promise<SessionListEntry[]>;
  getSession: (sessionId: string, actorPeerId?: string) => Promise<SessionMetaResult>;
  getSessionContext: (
    sessionId: string,
    tokenBudget?: number,
    actorPeerId?: string,
  ) => Promise<SessionContextLite>;
  getArchiveMessages: (
    sessionId: string,
    archiveCount: number,
    actorPeerId?: string,
  ) => Promise<OVMessage[]>;
};

/** Writes the restored session into OpenClaw's local store (see openviking-session-hydration). */
export type HydrateSessionFn = (args: {
  ovSessionId: string;
  messages: OVMessage[];
  summaryFallback?: string;
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
    "Restore by number:  /conversations 1   ·   continue latest:  /conversations resume",
    "Then press /session and pick it — no id to copy.",
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
  // Fetch + enrich + sort (newest first). Shared by list and by restore's
  // stateless selector resolution, so a row number always maps to the same
  // ordering the user just saw in /conversations.
  const computeConversationRows = async (
    session: ConversationsSession,
  ): Promise<{ rows: ConversationRow[]; enrichTruncated: number }> => {
    const client = await deps.getClient();
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
    return { rows, enrichTruncated };
  };

  const listConversations = async (
    input: ConversationsListInput,
    session: ConversationsSession,
  ): Promise<OpenVikingConversationsToolResult> => {
    const limit = Math.max(1, Math.floor(input.limit ?? CONVERSATION_LIST_DEFAULT_LIMIT));
    const { rows, enrichTruncated } = await computeConversationRows(session);
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

  // Resolve a restore selector to a concrete session id, statelessly. A full id
  // is used directly (no fetch); index/latest/prefix are resolved against the
  // same newest-first ordering that /conversations shows.
  const resolveTargetSessionId = async (
    selector: ConversationsRestoreSelector,
    session: ConversationsSession,
  ): Promise<{ sessionId: string; row?: ConversationRow; note: string }> => {
    if (selector.kind === "id" && selector.value.length >= FULL_SESSION_ID_MIN_LENGTH) {
      return { sessionId: selector.value, note: "" };
    }

    const { rows } = await computeConversationRows(session);
    if (rows.length === 0) {
      throw new Error("No OpenViking conversations found to restore. Run /conversations to check.");
    }

    if (selector.kind === "latest") {
      return { sessionId: rows[0]!.session_id, row: rows[0], note: " (latest)" };
    }

    if (selector.kind === "index") {
      const row = rows[selector.value - 1];
      if (!row) {
        throw new Error(
          `Conversation #${selector.value} is out of range (1–${rows.length}). Run /conversations to see the list.`,
        );
      }
      return { sessionId: row.session_id, row, note: ` (#${selector.value})` };
    }

    // Short token: match as an id prefix against the visible rows.
    const value = selector.value;
    const exact = rows.find((r) => r.session_id === value);
    if (exact) {
      return { sessionId: exact.session_id, row: exact, note: "" };
    }
    const matches = rows.filter((r) => r.session_id.startsWith(value));
    if (matches.length === 1) {
      return { sessionId: matches[0]!.session_id, row: matches[0], note: ` (prefix "${value}")` };
    }
    if (matches.length > 1) {
      const preview = matches.slice(0, 5).map((m) => m.session_id).join(", ");
      throw new Error(
        `"${value}" matches ${matches.length} conversations: ${preview}${matches.length > 5 ? ", …" : ""}. Use more characters or a row number.`,
      );
    }
    // Not in the visible list — fall back to treating it as a literal id so a
    // valid-but-unlisted id still resolves (getSessionContext validates it).
    return { sessionId: value, note: "" };
  };

  const restoreConversation = async (
    input: ConversationsRestoreInput,
    session: ConversationsSession,
  ): Promise<OpenVikingConversationsToolResult> => {
    const resolved = await resolveTargetSessionId(input.selector, session);
    const targetSessionId = resolved.sessionId;

    const client = await deps.getClient();
    let ovContext: SessionContextLite;
    try {
      ovContext = await client.getSessionContext(
        targetSessionId,
        input.tokenBudget ?? CONVERSATION_RESTORE_DEFAULT_TOKENS,
        session.agentId,
      );
    } catch (err) {
      throw new Error(`Conversation ${targetSessionId} not found or unreadable: ${String(err)}`);
    }

    // Reconstruct the full verbatim transcript: archived turns (archive_000..N-1)
    // followed by the active tail. getSessionContext only returns a summary + tail.
    const totalArchives = ovContext.stats?.totalArchives ?? 0;
    const archiveMessages = await client
      .getArchiveMessages(targetSessionId, totalArchives, session.agentId)
      .catch((err) => {
        deps.logger?.warn?.(
          `openviking: failed to read archives for ${targetSessionId}: ${String(err)}`,
        );
        return [] as OVMessage[];
      });
    const activeMessages = Array.isArray(ovContext.messages) ? ovContext.messages : [];
    const fullMessages = [...archiveMessages, ...activeMessages];

    const openclawAgentId = parseOpenclawAgentId(session.sessionKey);
    const result = await deps.hydrateSession({
      ovSessionId: targetSessionId,
      messages: fullMessages,
      summaryFallback: ovContext.latest_archive_overview,
      openclawAgentId,
      label: `OpenViking ${targetSessionId.slice(0, 8)}`,
    });

    const metaBits: string[] = [];
    if (resolved.row) {
      const updated = formatConversationTimestamp(conversationRowTime(resolved.row));
      if (updated && updated !== "-") {
        metaBits.push(`updated ${updated}`);
      }
      const msgs = resolved.row.meta?.total_message_count ?? resolved.row.meta?.message_count;
      if (typeof msgs === "number") {
        metaBits.push(`${msgs} msg(s)`);
      }
    }
    const metaSuffix = metaBits.length > 0 ? ` — ${metaBits.join(", ")}` : "";
    const text = [
      `Restored conversation ${targetSessionId}${resolved.note}${metaSuffix} into your local OpenClaw sessions (${result.messageCount} message(s) written).`,
      "Continue it — press /session and pick it (it is the most recent), or:",
      `  /session ${result.sessionKey}`,
      `  (or from a shell:  openclaw tui --session ${result.sessionKey} )`,
    ].join("\n");
    return {
      content: [{ type: "text" as const, text }],
      details: {
        action: "hydrate_conversation",
        selector: input.selector,
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
