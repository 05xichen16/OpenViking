export type AddResourceCommandArgs = {
  source?: string;
  to?: string;
  parent?: string;
  reason?: string;
  instruction?: string;
  wait?: boolean;
  timeout?: number;
};

export type AddSkillCommandArgs = {
  source?: string;
  data?: unknown;
  wait?: boolean;
  timeout?: number;
};

export type OVSearchCommandArgs = {
  query: string;
  uri?: string;
  limit?: number;
};

/**
 * How a restore target was addressed on the command line. Concrete resolution
 * (index/prefix/latest -> session id) happens statelessly in the runtime, which
 * has the session list; the parser only classifies the token.
 */
export type ConversationsRestoreSelector =
  | { kind: "id"; value: string }
  | { kind: "index"; value: number }
  | { kind: "latest" };

export type ConversationsCommandArgs =
  | { action: "list"; limit?: number }
  | { action: "restore"; selector: ConversationsRestoreSelector; tokenBudget?: number };

export function tokenizeCommandArgs(args: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i]!;
    const next = args[i + 1];
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      const shouldEscape =
        quote === '"'
          ? next === '"' || next === "\\"
          : !quote && Boolean(next && (/\s/.test(next) || next === '"' || next === "'"));
      if (shouldEscape) {
        escaping = true;
        continue;
      }
      current += ch;
      continue;
    }
    if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? null : ch;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error("Unterminated quoted argument");
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

type ParsedFlagArgs = {
  positionals: string[];
  flags: Map<string, string | boolean>;
};

function parseFlagArgs(args: string): ParsedFlagArgs {
  const tokens = tokenizeCommandArgs(args);
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const raw = token.slice(2);
    if (!raw) {
      continue;
    }
    const eqIndex = raw.indexOf("=");
    if (eqIndex >= 0) {
      flags.set(raw.slice(0, eqIndex), raw.slice(eqIndex + 1));
      continue;
    }
    const next = tokens[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(raw, next);
      i += 1;
    } else {
      flags.set(raw, true);
    }
  }

  return { positionals, flags };
}

function getStringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getNumberFlag(flags: Map<string, string | boolean>, name: string): number | undefined {
  const raw = getStringFlag(flags, name);
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} must be a number`);
  }
  return value;
}

function getBoolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

export function parseAddResourceCommandArgs(args: string): AddResourceCommandArgs {
  const parsed = parseFlagArgs(args);
  const source =
    parsed.positionals.length <= 1 ? parsed.positionals[0] : parsed.positionals.join(" ").trim();
  if (!source) {
    throw new Error("Usage: /add-resource <source> [--to URI] [--parent URI] [--reason TEXT] [--instruction TEXT] [--wait] [--timeout SEC]");
  }
  const to = getStringFlag(parsed.flags, "to");
  const parent = getStringFlag(parsed.flags, "parent");
  if (to && parent) {
    throw new Error("Cannot specify both --to and --parent.");
  }
  return {
    source,
    to,
    parent,
    reason: getStringFlag(parsed.flags, "reason"),
    instruction: getStringFlag(parsed.flags, "instruction"),
    wait: getBoolFlag(parsed.flags, "wait"),
    timeout: getNumberFlag(parsed.flags, "timeout"),
  };
}

export function parseAddSkillCommandArgs(args: string): AddSkillCommandArgs {
  const parsed = parseFlagArgs(args);
  const source =
    parsed.positionals.length <= 1 ? parsed.positionals[0] : parsed.positionals.join(" ").trim();
  if (!source) {
    throw new Error("Usage: /add-skill <source> [--wait] [--timeout SEC]");
  }
  if (parsed.flags.has("to") || parsed.flags.has("parent") || parsed.flags.has("reason") || parsed.flags.has("instruction")) {
    throw new Error("--to, --parent, --reason, and --instruction are resource-only options.");
  }
  return {
    source,
    wait: getBoolFlag(parsed.flags, "wait"),
    timeout: getNumberFlag(parsed.flags, "timeout"),
  };
}

export function parseOVSearchCommandArgs(args: string): OVSearchCommandArgs {
  const parsed = parseFlagArgs(args);
  // `/ov-search` only accepts a single query string, so positional segments are
  // always re-joined to preserve unquoted multi-word searches.
  const query = parsed.positionals.join(" ").trim();
  if (!query) {
    throw new Error('Usage: /ov-search "<query>" [--uri URI] [--limit N]');
  }
  return {
    query,
    uri: getStringFlag(parsed.flags, "uri"),
    limit: getNumberFlag(parsed.flags, "limit"),
  };
}

export const CONVERSATIONS_USAGE =
  "Usage: /conversations [list] [--limit N]  |  /conversations <#|id|prefix> [--tokens N]  |  /conversations resume";

const LATEST_WORDS = new Set(["last", "latest"]);

/** Classify a restore target token: a number is a list row, else id/prefix. */
function parseRestoreSelector(target: string): ConversationsRestoreSelector {
  const trimmed = target.trim();
  if (!trimmed || LATEST_WORDS.has(trimmed.toLowerCase())) {
    return { kind: "latest" };
  }
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error("Conversation number must be 1 or greater.");
    }
    return { kind: "index", value };
  }
  return { kind: "id", value: trimmed };
}

export function parseConversationsCommandArgs(args: string): ConversationsCommandArgs {
  const parsed = parseFlagArgs(args);
  const [first, second] = parsed.positionals;
  const sub = (first ?? "").toLowerCase();
  const tokenBudget = getNumberFlag(parsed.flags, "tokens");

  // `resume` doubles as a bare "restore the latest" shortcut and as a verb that
  // takes an explicit target (`resume 3`, `resume <id>`).
  if (sub === "resume") {
    return { action: "restore", selector: parseRestoreSelector(second ?? ""), tokenBudget };
  }

  // `restore`/`open`/`show` require an explicit target.
  if (sub === "restore" || sub === "open" || sub === "show") {
    const target = (second ?? "").trim();
    if (!target) {
      throw new Error(CONVERSATIONS_USAGE);
    }
    return { action: "restore", selector: parseRestoreSelector(target), tokenBudget };
  }

  // Bare `last`/`latest` -> most recent conversation.
  if (LATEST_WORDS.has(sub)) {
    return { action: "restore", selector: { kind: "latest" }, tokenBudget };
  }

  // Empty / `list` / `ls` -> list.
  if (sub === "" || sub === "list" || sub === "ls") {
    return { action: "list", limit: getNumberFlag(parsed.flags, "limit") };
  }

  // Any other bare positional is a restore target: `/conversations 3`,
  // `/conversations 0ac0`, `/conversations <full-uuid>`.
  return { action: "restore", selector: parseRestoreSelector(first!), tokenBudget };
}
