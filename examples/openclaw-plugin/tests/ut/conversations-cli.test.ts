import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildConversationsCliInput,
  readOpenVikingRawConfig,
  registerOpenVikingConversationsCommand,
  type ConversationsCliCommand,
} from "../../commands/conversations-cli.js";

const tempDirs: string[] = [];
function tempStateDir(configJson?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "ov-cli-"));
  tempDirs.push(dir);
  if (configJson !== undefined) {
    writeFileSync(join(dir, "openclaw.json"), JSON.stringify(configJson), "utf8");
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    try {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("conversations CLI: readOpenVikingRawConfig", () => {
  it("extracts plugins.entries.openviking.config from openclaw.json", () => {
    const dir = tempStateDir({
      plugins: { entries: { kmm: { config: { baseUrl: "http://x:1933", apiKey: "sk" } } } },
    });
    expect(readOpenVikingRawConfig(dir)).toEqual({ baseUrl: "http://x:1933", apiKey: "sk" });
  });

  it("returns {} when the file or config is missing/malformed", () => {
    expect(readOpenVikingRawConfig(tempStateDir())).toEqual({});
    expect(readOpenVikingRawConfig(tempStateDir({ plugins: {} }))).toEqual({});
    expect(readOpenVikingRawConfig(join(tmpdir(), "definitely-missing-ov-dir-xyz"))).toEqual({});
  });
});

describe("conversations CLI: buildConversationsCliInput (shared grammar)", () => {
  it("maps list / number / resume / prefix + flags the same way the slash command does", () => {
    expect(buildConversationsCliInput([], {})).toEqual({ action: "list", limit: undefined });
    expect(buildConversationsCliInput([], { limit: 30 })).toEqual({ action: "list", limit: 30 });
    expect(buildConversationsCliInput(["3"], {})).toEqual({
      action: "restore",
      selector: { kind: "index", value: 3 },
      tokenBudget: undefined,
    });
    expect(buildConversationsCliInput(["resume"], {})).toEqual({
      action: "restore",
      selector: { kind: "latest" },
      tokenBudget: undefined,
    });
    expect(buildConversationsCliInput(["0ac0"], { tokens: 8000 })).toEqual({
      action: "restore",
      selector: { kind: "id", value: "0ac0" },
      tokenBudget: 8000,
    });
  });
});

type FakeRecord = {
  name?: string;
  options: string[];
  actionFn?: (...args: unknown[]) => unknown;
  subs: Array<{ record: FakeRecord }>;
};

function makeFakeCommand(): ConversationsCliCommand & { record: FakeRecord } {
  const record: FakeRecord = { options: [], subs: [] };
  const builder: ConversationsCliCommand & { record: FakeRecord } = {
    record,
    description: () => builder,
    option: (flags: string) => {
      record.options.push(flags);
      return builder;
    },
    command: (name: string) => {
      const sub = makeFakeCommand();
      sub.record.name = name;
      record.subs.push(sub);
      return sub;
    },
    action: (fn) => {
      record.actionFn = fn;
      return builder;
    },
  };
  return builder;
}

describe("conversations CLI: command registration", () => {
  it("registers a conversations subcommand with the expected options and an action", () => {
    const ov = makeFakeCommand();
    registerOpenVikingConversationsCommand(ov);

    const conv = ov.record.subs[0]!;
    expect(conv.record.name).toBe("conversations [selector...]");
    const opts = conv.record.options.join(" ");
    expect(opts).toContain("--limit");
    expect(opts).toContain("--tokens");
    expect(opts).toContain("--agent");
    expect(opts).toContain("--json");
    expect(typeof conv.record.actionFn).toBe("function");
  });

  it("action fails cleanly (exit 1) when OpenViking baseUrl is not configured — no network", async () => {
    const ov = makeFakeCommand();
    registerOpenVikingConversationsCommand(ov);
    const conv = ov.record.subs[0]!;

    const prevStateDir = process.env.OPENCLAW_STATE_DIR;
    const prevExit = process.exitCode;
    const errs: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    });
    try {
      // Empty baseUrl short-circuits before any client/network call.
      process.env.OPENCLAW_STATE_DIR = tempStateDir({
        plugins: { entries: { kmm: { config: { baseUrl: "" } } } },
      });
      process.exitCode = 0;
      await conv.record.actionFn!([], {});
      expect(process.exitCode).toBe(1);
      expect(errs.join(" ")).toMatch(/KMM conversations failed/);
      expect(errs.join(" ")).toMatch(/baseUrl is not set|not configured/i);
    } finally {
      errSpy.mockRestore();
      process.exitCode = prevExit;
      if (prevStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = prevStateDir;
      }
    }
  });
});
