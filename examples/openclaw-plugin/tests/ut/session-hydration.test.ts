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
import type { OVMessage } from "../../client.js";

const BASE_MS = 1_767_000_000_000; // fixed for deterministic timestamps

function ovMessage(role: string, text: string): OVMessage {
  return { id: `m-${text}`, role, parts: [{ type: "text", text }], created_at: "" } as OVMessage;
}

function ovToolMessage(
  role: string,
  tool: { id: string; name: string; input: unknown; output: string },
): OVMessage {
  return {
    id: `m-${tool.id}`,
    role,
    parts: [
      {
        type: "tool",
        tool_id: tool.id,
        tool_name: tool.name,
        tool_status: "completed",
        tool_input: tool.input,
        tool_output: tool.output,
      },
    ],
    created_at: "",
  } as OVMessage;
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

  it("builds a valid transcript from verbatim messages: header first, then chained entries", () => {
    const messages = [ovMessage("user", "hello again"), ovMessage("assistant", "welcome back")];

    const entries = buildTranscriptEntries({
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      cwd: "/home/u/project",
      messages,
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

    const msgs = entries.slice(1) as TranscriptMessageEntry[];
    expect(msgs[0]!.parentId).toBeNull();

    // parentId forms a linear chain and every entry id is unique.
    const ids = msgs.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < msgs.length; i += 1) {
      expect(msgs[i]!.parentId).toBe(msgs[i - 1]!.id);
    }

    // Verbatim turns are present; assistant carries persisted accounting fields.
    const flat = JSON.stringify(msgs);
    expect(flat).toContain("hello again");
    expect(flat).toContain("welcome back");
    // No summary message is injected when verbatim messages exist.
    expect(flat).not.toContain("restored from OpenViking");
    const assistant = msgs.find((m) => (m.message as { role?: string }).role === "assistant");
    expect(assistant?.message).toMatchObject({ role: "assistant", provider: "test-provider", model: "test-model", stopReason: "stop" });
    expect(typeof (assistant?.message as { timestamp?: unknown }).timestamp).toBe("number");
  });

  it("restores tool turns without injecting '(no content)' placeholders", () => {
    // Mirrors a real OpenViking transcript: an OV assistant turn is stored as a
    // text message plus a separate role:user 'tool' part per tool call. After
    // convertToAgentMessages these land as consecutive assistant messages
    // (text, then one assistant-per-tool-call, then more assistant text). The
    // restore path must merge them the way OpenClaw's validateAnthropicTurns
    // does — otherwise the stream is left with assistant-assistant adjacencies
    // that the old placeholder pass turned into bogus "(no content)" user turns.
    const messages: OVMessage[] = [
      ovMessage("assistant", "Here is the A4 paper quote comparison."),
      ovToolMessage("user", {
        id: "call_read_1",
        name: "read",
        input: { path: "~/.openclaw/workspace/skills/weather/SKILL.md" },
        output: "---\nname: weather\n---\n",
      }),
      ovToolMessage("user", {
        id: "call_exec_1",
        name: "exec",
        input: { command: "curl -s wttr.in/Shenzhen" },
        output: "Shenzhen: +34C",
      }),
      ovMessage("assistant", "Shenzhen weather: 34C, cloudy."),
      ovMessage("assistant", "And the A4 paper table again."),
    ];

    const entries = buildTranscriptEntries({
      sessionId: "s-tools",
      cwd: "/home/u/project",
      messages,
      baseMs: BASE_MS,
      model: "m",
      provider: "p",
    });
    const msgs = entries.slice(1) as TranscriptMessageEntry[];

    // No synthetic placeholder user turns anywhere in the restored transcript.
    const flat = JSON.stringify(msgs);
    expect(flat).not.toContain("(no content)");

    // The tool calls survive as canonical toolCall blocks paired with results.
    const toolCallIds = msgs
      .filter((m) => (m.message as { role?: string }).role === "assistant")
      .flatMap((m) => {
        const content = (m.message as { content?: unknown }).content;
        return Array.isArray(content) ? content : [];
      })
      .filter((b) => (b as { type?: string }).type === "toolCall")
      .map((b) => (b as { id?: string }).id);
    expect(toolCallIds).toEqual(["call_read_1", "call_exec_1"]);

    const toolResults = msgs.filter((m) => (m.message as { role?: string }).role === "toolResult");
    expect(toolResults.map((m) => (m.message as { toolCallId?: string }).toolCallId)).toEqual([
      "call_read_1",
      "call_exec_1",
    ]);

    // The two originally-consecutive assistant text turns are merged, not split
    // by a placeholder: no user turn separates them in the output.
    const roles = msgs.map((m) => (m.message as { role?: string }).role);
    for (let i = 1; i < roles.length; i += 1) {
      if (roles[i] === "assistant") {
        expect(roles[i - 1]).not.toBe("assistant");
      }
    }
    expect(flat).toContain("A4 paper table again");
  });

  it("falls back to the archived summary only when there are no verbatim messages", () => {
    const entries = buildTranscriptEntries({
      sessionId: "s-1",
      cwd: "",
      messages: [],
      summaryFallback: "We set up the repo.",
      baseMs: BASE_MS,
      model: "m",
      provider: "p",
    });
    const msgs = entries.slice(1) as TranscriptMessageEntry[];
    expect(msgs).toHaveLength(1);
    const body = JSON.stringify(msgs[0]!.message);
    expect(body).toContain("Earlier conversation — restored from OpenViking");
    expect(body).toContain("We set up the repo.");
  });

  it("serializes entries to newline-terminated JSONL, one JSON object per line", () => {
    const entries = buildTranscriptEntries({
      sessionId: "s-1",
      cwd: "",
      messages: [ovMessage("user", "hi")],
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
