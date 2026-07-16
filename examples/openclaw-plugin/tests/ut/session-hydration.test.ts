import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildSessionStoreEntry,
  buildTranscriptEntries,
  hydrateSessionToLocalStore,
  mergeSessionStoreEntry,
  normalizeOpenclawAgentId,
  parseOpenclawAgentId,
  readOpenclawSessionStore,
  resolveOpenclawStateDir,
  resolveSessionStorePath,
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

  it("normalizes an OpenClaw agent id the way routing/session-key does", () => {
    expect(normalizeOpenclawAgentId("main")).toBe("main");
    expect(normalizeOpenclawAgentId("Work")).toBe("work");
    expect(normalizeOpenclawAgentId("  Main  ")).toBe("main");
    expect(normalizeOpenclawAgentId(undefined)).toBe("main");
    expect(normalizeOpenclawAgentId("")).toBe("main");
    // "." is not a valid agent-id char (unlike a session id): collapse to "-".
    expect(normalizeOpenclawAgentId("a.b")).toBe("a-b");
  });

  it("resolveSessionStorePath: default per-agent store, agent-id normalized", () => {
    expect(resolveSessionStorePath({ agentId: "main", stateDir: "/tmp/oc" })).toBe(
      join("/tmp/oc", "agents", "main", "sessions", "sessions.json"),
    );
    expect(resolveSessionStorePath({ agentId: "Work", stateDir: "/tmp/oc" })).toBe(
      join("/tmp/oc", "agents", "work", "sessions", "sessions.json"),
    );
  });

  it("resolveSessionStorePath: honors an absolute / ~-relative / {agentId} session.store", () => {
    // Absolute store wins over the default location.
    expect(
      resolveSessionStorePath({ store: "/data/store.json", agentId: "main", stateDir: "/tmp/oc" }),
    ).toBe(resolve("/data/store.json"));
    // ~ expands against the provided home.
    expect(
      resolveSessionStorePath({
        store: "~/oc/store.json",
        agentId: "main",
        stateDir: "/tmp/oc",
        home: "/home/u",
      }),
    ).toBe(resolve("/home/u/oc/store.json"));
    // {agentId} template expands with the NORMALIZED id.
    expect(
      resolveSessionStorePath({
        store: "/data/agents/{agentId}/s.json",
        agentId: "Work",
        stateDir: "/tmp/oc",
      }),
    ).toBe(resolve("/data/agents/work/s.json"));
    // {agentId} template plus ~ expansion together.
    expect(
      resolveSessionStorePath({
        store: "~/oc/{agentId}/s.json",
        agentId: "main",
        stateDir: "/tmp/oc",
        home: "/home/u",
      }),
    ).toBe(resolve("/home/u/oc/main/s.json"));
  });

  it("readOpenclawSessionStore: reads top-level session.store, undefined when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "ov-cfg-"));
    // Missing file → undefined.
    expect(readOpenclawSessionStore(dir)).toBeUndefined();
    // Present with session.store → returns the raw string.
    writeFileSync(
      join(dir, "openclaw.json"),
      JSON.stringify({ session: { store: "~/oc/sessions.json" }, gateway: { port: 1 } }),
      "utf8",
    );
    expect(readOpenclawSessionStore(dir)).toBe("~/oc/sessions.json");
    // Present but no session.store → undefined.
    writeFileSync(join(dir, "openclaw.json"), JSON.stringify({ session: { mainKey: "main" } }), "utf8");
    expect(readOpenclawSessionStore(dir)).toBeUndefined();
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
    expect(flat).not.toContain("restored from KMM");
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
    expect(body).toContain("Earlier conversation — restored from KMM");
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

  it("hydrates transcript + store to the default per-agent location when session.store is unset", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ov-hydrate-def-"));
    const result = await hydrateSessionToLocalStore({
      ovSessionId: "abc123",
      messages: [ovMessage("user", "hi"), ovMessage("assistant", "hello")],
      openclawAgentId: "main",
      stateDir,
      cwd: "/proj",
      nowMs: BASE_MS,
    });

    const sessionsDir = join(stateDir, "agents", "main", "sessions");
    expect(result.storePath).toBe(join(sessionsDir, "sessions.json"));
    expect(result.sessionFile).toBe(join(sessionsDir, "abc123.jsonl"));
    expect(existsSync(join(sessionsDir, "sessions.json"))).toBe(true);
    expect(existsSync(join(sessionsDir, "abc123.jsonl"))).toBe(true);
  });

  it("hydrates transcript + store NEXT TO a custom absolute session.store, not the default dir", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ov-hydrate-custom-"));
    const stateDir = join(tmp, "state");
    const storeDir = join(tmp, "custom");
    const storePath = join(storeDir, "sessions.json");

    const result = await hydrateSessionToLocalStore({
      ovSessionId: "abc123",
      messages: [ovMessage("user", "hi"), ovMessage("assistant", "hello")],
      openclawAgentId: "main",
      stateDir,
      sessionStore: storePath,
      cwd: "/proj",
      nowMs: BASE_MS,
    });

    // Both files land in the store's directory...
    expect(result.storePath).toBe(resolve(storePath));
    expect(result.sessionFile).toBe(join(storeDir, "abc123.jsonl"));
    expect(existsSync(storePath)).toBe(true);
    expect(existsSync(join(storeDir, "abc123.jsonl"))).toBe(true);
    // ...and NOTHING is written to the default per-agent location OpenClaw would ignore.
    expect(existsSync(join(stateDir, "agents", "main", "sessions"))).toBe(false);

    // The persisted entry keeps sessionFile relative so OpenClaw resolves it
    // against dirname(storePath).
    const store = JSON.parse(readFileSync(storePath, "utf8")) as Record<
      string,
      { sessionFile?: string }
    >;
    expect(store["agent:main:abc123"]?.sessionFile).toBe("abc123.jsonl");
  });
});
