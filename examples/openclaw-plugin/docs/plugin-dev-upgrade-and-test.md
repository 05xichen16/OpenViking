# OpenViking OpenClaw Plugin — Dev Upgrade & Test Playbook

Reusable workflow for iterating on this plugin: build on Windows → deploy the
changed compiled files into the running OpenClaw install (WSL) → verify. Written
against the concrete dev setup below, but the shape generalizes.

> TL;DR: `npm run build` on Windows, `diff` fresh `dist/` vs the installed
> `dist/`, copy only the changed `*.js` into `~/.openclaw/extensions/openviking/dist/`
> (back up first). **CLI changes are live immediately; TUI / context-engine
> changes need `openclaw gateway restart`.**

---

## 1. Environment (this setup)

| Thing | Value |
| --- | --- |
| Windows repo | `D:\code\OpenViking` (branch `feat/conversations`); plugin at `examples\openclaw-plugin` |
| From WSL, the Windows repo is | `/mnt/d/code/OpenViking` |
| WSL distro / user | `Ubuntu-24.04` / `xichen` (`/home/xichen`) |
| **Installed (running) plugin** | `/home/xichen/.openclaw/extensions/openviking/` — loads `dist/*.js` |
| node + openclaw (nvm) | `/home/xichen/.nvm/versions/node/v24.18.0/bin/` — only on PATH in a **login/interactive** shell |
| OpenClaw version | 2026.5.27 |
| OpenClaw agent in use | `main` (local store `~/.openclaw/agents/main/`) |
| Plugin config | `~/.openclaw/openclaw.json` → `plugins.entries.openviking.config` (peer_role=`assistant`, peer_prefix empty) |
| **OpenViking server** | **REMOTE**: `baseUrl = https://121.37.53.201:40006`. The WSL `openviking` Python pkg is source-linked to `/mnt/d/code/OpenViking/openviking`, but **the plugin talks to the remote server** — so **server-side (`openviking/**`) changes must be deployed to that remote host, not locally.** |

There is also a sparse source checkout at `/home/xichen/ov-fork/examples/openclaw-plugin`
(no `node_modules`) — not used for the build/deploy loop below.

---

## 2. Build (on Windows)

```bash
cd /d/code/OpenViking/examples/openclaw-plugin   # Git Bash
npm run build        # tsc -p tsconfig.build.json → dist/
```

- **Do NOT use `bash build.sh` for the dev loop.** It runs `npm test` under
  `set -e`, and this branch has **6 pre-existing `architecture-boundaries`
  failures** (unrelated), so `build.sh` aborts before building. `npm run build`
  only runs `tsc` (type-check clean) and is the right thing here.
- TypeScript **type-only** changes (e.g. adding a type/interface) produce **no
  JS diff** — only files with runtime changes appear in the deploy diff.

---

## 3. Deploy the changed compiled files into WSL

All `wsl.exe` calls from Git Bash that contain `/mnt` or `/home` paths must be
prefixed with `MSYS_NO_PATHCONV=1` (otherwise Git Bash mangles the paths / shell
vars).

**a. See exactly which compiled files changed** (ignore `.bak.*`):

```bash
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- diff -rq \
  /mnt/d/code/OpenViking/examples/openclaw-plugin/dist \
  /home/xichen/.openclaw/extensions/openviking/dist | grep -vE '\.bak\.'
```

**b. Back up, then copy each changed file** (one `cp` per file; keep it simple to
avoid nested-quote issues through `wsl.exe`). Example for one file:

```bash
SRC=/mnt/d/code/OpenViking/examples/openclaw-plugin/dist
DST=/home/xichen/.openclaw/extensions/openviking/dist
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- cp "$DST/<rel>.js" "$DST/<rel>.js.bak.<label>"
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- cp "$SRC/<rel>.js" "$DST/<rel>.js"
```

**c. Verify the copy landed** (`cmp` = identical, and grep a marker of the change):

```bash
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- cmp "$SRC/<rel>.js" "$DST/<rel>.js" && echo IDENTICAL
```

**d. Make it take effect:**
- **CLI** (`openclaw openviking ...`): **no restart** — the CLI command tree is
  loaded per `openclaw` invocation.
- **TUI slash commands + context engine** (`/conversations`, assemble/afterTurn,
  hooks): **`openclaw gateway restart`** (the plugin runtime is loaded at gateway
  start). Run it in the user's WSL terminal (interactive shell has openclaw on PATH).

> Backups accumulate as `…​.bak.<label>` next to each file. To roll back, copy the
> `.bak` back over the file and restart if needed.

---

## 4. Verify

### On Windows (fast, before deploying)
```bash
cd /d/code/OpenViking/examples/openclaw-plugin
npx tsc -p tsconfig.json --noEmit          # type-check (must be clean)
npx vitest run tests/ut                     # unit tests
```
**Baseline:** `tests/ut` has **6 known-failing `architecture-boundaries` tests**
(transport seam / dead recall-trace exports / setup CLI fetch / resource packager
seam / memory URI seam / commit polling). Anything else failing is your change.
Confirm a failure is pre-existing by stashing your edits and re-running.

### Live in WSL
openclaw needs the nvm PATH → run inside an **interactive** shell:
```bash
# from the user's WSL terminal (openclaw already on PATH), or:
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- bash -ic 'openclaw openviking conversations --limit 10'
```
- **Don't** call `wsl.exe -- openclaw …` directly — the shebang can't find `node`
  (nvm not loaded). Use `bash -ic '…'`, or prefix `PATH=/home/xichen/.nvm/versions/node/v24.18.0/bin:$PATH`.
- Plugin `console.log` in a CLI command is routed to **stderr** by OpenClaw. For
  pipeable output use `process.stdout.write` (already done for `--json`). To
  capture just stdout: `openclaw openviking conversations --json 1>out.json 2>/dev/null`.

### Verify a restored conversation has no `(no content)` garbage
```bash
grep -c '"(no content)"' ~/.openclaw/agents/*/sessions/<session_id>.jsonl   # expect 0
```

---

## 5. Reference: `/conversations` command surface (current)

Same grammar in the TUI slash command and the `openclaw openviking conversations`
CLI (they share the parser + runtime):

| Input | Action |
| --- | --- |
| `conversations` / `list` / `ls` | list, newest-first, numbered |
| `conversations 3` | restore row #3 |
| `conversations resume` / `last` | restore the most recent |
| `conversations <id-or-prefix>` | restore by full id or unique prefix |
| `--limit N` (list), `--tokens N` (restore), `--agent <id>` (CLI, default `main`), `--json` (CLI) | flags |

CLI restore is stateless (re-fetches + ranks the same way the list does). Restore
writes a local OpenClaw session and prints `/session <key>` + `openclaw tui --session <key>`.

---

## 6. Gotchas cheat-sheet

- `MSYS_NO_PATHCONV=1` for every `wsl.exe` call carrying `/mnt` or `/home` paths.
- `npm run build`, not `build.sh` (test gate trips on 6 pre-existing failures).
- CLI = no restart; TUI/context-engine = `openclaw gateway restart`.
- Server-side (`openviking/**`) changes: the running server is **remote** — deploy there, not to `/mnt/d`.
- Plugin CLI `console.log` → stderr; use `process.stdout.write` for real stdout.
- Only compiled `*.js` with runtime changes need copying; type-only edits emit nothing.
