import { describe, expect, it } from "vitest";

import {
  buildSessionStoreEntry,
  buildTranscriptEntries,
  mergeSessionStoreEntry,
  parseOpenclawAgentId,
  resolveOpenclawStateDir,
  serializeTranscript,
  type TranscriptMessageEntry,
} from "../../plugin/openviking-session-hydration.js";
import type { SessionContextResult } from "../../client.js";

const BASE_MS = 1_767_000_000_000; // fixed for deterministic timestamps

function makeContext(overrides: Partial<SessionContextResult> = {}): SessionContextResult {
  return {
    latest_archive_overview: "",
    pre_archive_abstracts: [],
    messages: [],
    estimatedTokens: 0,
    stats: { totalArchives: 0, includedArchives: 0, droppedArchives: 0, failedArchives: 0, activeTokens: 0, archiveTokens: 0 },
    ...overrides,
  };
}

describe("openviking session hydration", () => {
  it("parses the OpenClaw agent id from a session key (defaults to main)", () => {
    expect(parseOpenclawAgentId("agent:main:685feecb-uuid")).toBe("main");
    expect(parseOpenclawAgentId("agent:work:abc")).toBe("work");
    expect(parseOpenclawAgentId(undefined)).toBe("main");
    expect(parseOpenclawAgentId("not-a-key")).toBe("main");
  });

  it("resolves the OpenClaw state dir from OPENCLAW_STATE_DIR", () => {
    expect(resolveOpenclawStateDir({ OPENCLAW_STATE_DIR: "/tmp/oc" } as NodeJS.ProcessEnv)).toBe("/tmp/oc");
    expect(resolveOpenclawStateDir({} as NodeJS.ProcessEnv)).toMatch(/[\\/]\.openclaw$/);
  });

  it("builds a valid transcript: header first, then chained message entries", () => {
    const ctx = makeContext({
      latest_archive_overview: "We set up the repo.",
      pre_archive_abstracts: [{ archive_id: "a0", abstract: "Kickoff." }],
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "hello again" }], created_at: "2026-02-02T09:00:00" },
        { id: "m2", role: "assistant", parts: [{ type: "text", text: "welcome back" }], created_at: "2026-02-02T09:00:05" },
      ],
    });

    const entries = buildTranscriptEntries({
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      cwd: "/home/u/project",
      ovContext: ctx,
      baseMs: BASE_MS,
      model: "test-model",
      provider: "test-provider",
    });

    // Header is first and well-formed.
    expect(entries[0]).toEqual({
      type: "session",
      version: 3,
      id: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date(BASE_MS).toISOString(),
      cwd: "/home/u/project",
    });

    const messages = entries.slice(1) as TranscriptMessageEntry[];
    // First message includes the earlier-summary, carrying overview + abstract.
    expect(messages[0]!.parentId).toBeNull();
    expect(JSON.stringify(messages[0]!.message)).toContain("restored from OpenViking");
    expect(JSON.stringify(messages[0]!.message)).toContain("We set up the repo.");
    expect(JSON.stringify(messages[0]!.message)).toContain("Kickoff.");

    // parentId forms a linear chain and every entry id is unique.
    const ids = messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < messages.length; i += 1) {
      expect(messages[i]!.parentId).toBe(messages[i - 1]!.id);
    }

    // Verbatim recent messages are present; assistant carries persisted accounting fields.
    const flat = JSON.stringify(messages);
    expect(flat).toContain("hello again");
    expect(flat).toContain("welcome back");
    const assistant = messages.find((m) => (m.message as { role?: string }).role === "assistant");
    expect(assistant?.message).toMatchObject({ role: "assistant", provider: "test-provider", model: "test-model", stopReason: "stop" });
    expect(typeof (assistant?.message as { timestamp?: unknown }).timestamp).toBe("number");
  });

  it("serializes entries to newline-terminated JSONL, one JSON object per line", () => {
    const entries = buildTranscriptEntries({
      sessionId: "s-1",
      cwd: "",
      ovContext: makeContext({ messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }], created_at: "" }] }),
      baseMs: BASE_MS,
      model: "m",
      provider: "p",
    });
    const text = serializeTranscript(entries);
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(entries.length);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(JSON.parse(lines[0]!).type).toBe("session");
  });

  it("merges a session store entry without dropping existing sessions", () => {
    const existing = { "agent:main:other": { sessionId: "other", updatedAt: 1 } };
    const entry = buildSessionStoreEntry({
      sessionId: "s-1",
      sessionFile: "s-1.jsonl",
      updatedAt: BASE_MS,
      model: "m",
      modelProvider: "p",
      label: "OpenViking s-1",
    });
    const merged = mergeSessionStoreEntry(existing, "agent:main:s-1", entry);

    expect(merged["agent:main:other"]).toEqual({ sessionId: "other", updatedAt: 1 });
    expect(merged["agent:main:s-1"]).toMatchObject({
      sessionId: "s-1",
      sessionFile: "s-1.jsonl",
      updatedAt: BASE_MS,
      chatType: "direct",
      model: "m",
      modelProvider: "p",
      label: "OpenViking s-1",
    });
  });
});
