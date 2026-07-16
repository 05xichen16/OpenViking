# Install KMM for OpenClaw

KMM provides long-term memory, knowledge base search, semantic retrieval, and RAG-style context for OpenClaw through the `@kmm/openclaw-plugin` plugin.

This guide describes the current plugin install flow. It is written for both people and automation agents.

## Do Not Install The Skill By Mistake

`@kmm/openclaw-plugin` is an OpenClaw plugin.

Do not use this command for plugin installation:

```bash
clawhub install kmm
```

That command installs an AgentSkill named `kmm`, not the OpenClaw plugin.

Use this plugin command instead:

```bash
openclaw plugins install clawhub:@kmm/openclaw-plugin
```

## Requirements

| Component | Required |
| --- | --- |
| Node.js | >= 22 |
| OpenClaw | >= 2026.4.8 |

The plugin connects to an existing KMM server. It does not start the KMM server for you. Start KMM first, keep it running, then point the plugin `baseUrl` at that HTTP service. The default local URL is `http://127.0.0.1:1933`.

OpenClaw plugin package boundaries:

- `2026.4.8` is the minimum supported OpenClaw version for the current plugin.
- `2026.5.3` starts validating package installs so TypeScript plugin entries need compiled JavaScript output.
- `2026.5.4` and later stop falling back to `.ts` source for installed/global plugin runtime loading when compiled JavaScript is missing.
- The recommended `openclaw plugins install clawhub:@kmm/openclaw-plugin` path installs a published package that already includes `dist/*.js`.
- `kmm-install` is the backup/source install path. Use it when ClawHub or the OpenClaw plugin manager path is unavailable/rate-limited, or when explicitly testing a source ref. For OpenClaw `>= 2026.5.3`, it builds the plugin during installation.

Quick check:

```bash
node -v
openclaw --version
```

## Start KMM Server

For a local KMM server on the same machine as OpenClaw:

```bash
pip install kmm --upgrade --force-reinstall
kmm-server init
kmm-server doctor
kmm-server
```

`kmm-server init` writes the server configuration, `kmm-server doctor` validates local model/provider auth, and `kmm-server` starts the HTTP API. Keep this process running while OpenClaw uses the plugin.

To run the server in the background:

```bash
mkdir -p ~/.kmm/data/log
nohup kmm-server > ~/.kmm/data/log/kmm.log 2>&1 &
```

If KMM runs on another machine, start it on a reachable host/port, for example:

```bash
kmm-server --host 0.0.0.0 --port 1933
```

Then configure the OpenClaw plugin `baseUrl` to that address, such as `http://your-server:1933`.

Verify the server before installing or restarting the plugin:

```bash
curl http://127.0.0.1:1933/health
```

## Recommended Install Path

Use this path for normal users, production installs, and agent-assisted installs.

### 1. Install The Plugin

```bash
openclaw plugins install clawhub:@kmm/openclaw-plugin
```

If your OpenClaw installation requires an explicit registry prefix, use:

```bash
openclaw plugins install clawhub:@kmm/openclaw-plugin
```

### 2. Configure The Plugin

For interactive human setup:

```bash
openclaw kmm setup
```

For non-interactive agent setup:

```bash
openclaw kmm setup --base-url <KMM_URL> --api-key <API_KEY> --json
```

Example:

```bash
openclaw kmm setup --base-url http://127.0.0.1:1933 --api-key sk-xxx --json
```

The setup command writes `plugins.entries.kmm.config` and activates `plugins.slots.contextEngine=kmm`.

If the KMM server is temporarily unreachable but you still want to save the config:

```bash
openclaw kmm setup --base-url <KMM_URL> --api-key <API_KEY> --allow-offline --json
```

If your API key is a root key, setup may require tenant context:

```bash
openclaw kmm setup \
  --base-url <KMM_URL> \
  --api-key <ROOT_API_KEY> \
  --account-id <ACCOUNT_ID> \
  --user-id <USER_ID> \
  --json
```

If another context engine already owns the slot, setup will not replace it by default. To intentionally replace the current owner:

```bash
openclaw kmm setup --base-url <KMM_URL> --api-key <API_KEY> --force-slot --json
```

If you want assistant messages to carry a prefixed `peer_id` and data-plane recall/search requests to use the matching actor peer view, pass a prefix explicitly:

```bash
openclaw kmm setup --base-url <KMM_URL> --api-key <API_KEY> --peer-role assistant --peer-prefix <PREFIX> --json
```

### 3. Restart OpenClaw Gateway

```bash
openclaw gateway restart
```

If your OpenClaw version uses a different restart command, use the equivalent gateway restart for your environment.

### 4. Verify

```bash
openclaw kmm status --json
```

Expected result:

| JSON field | Expected value |
| --- | --- |
| `configured` | `true` |
| `slotActive` | `true` |
| `health.ok` | `true` when the server is reachable |

You can also inspect the raw OpenClaw config:

```bash
openclaw config get plugins.entries.kmm.config
openclaw config get plugins.slots.contextEngine
```

`plugins.slots.contextEngine` should be `kmm`.

## Agent Result Handling

Automation should prefer `--json` and branch on these fields:

| Result | Meaning | Recommended action |
| --- | --- | --- |
| `success: true` | Config saved and setup completed | Restart gateway, then run status |
| `success: false`, `action: "slot_blocked"` | Config may be saved, but another plugin owns `contextEngine` | Ask before rerunning with `--force-slot` |
| `success: false`, `action: "error"` | Validation failed | Show `error`; do not claim install succeeded |
| `health.ok: false` | Server unreachable | Check URL/server, or rerun with `--allow-offline` only if the user accepts |
| `keyProbe.keyType: "root_key"` | Root key needs tenant context | Rerun with `--account-id` and `--user-id` |

## Configuration Reference

The plugin config lives at:

```text
plugins.entries.kmm.config
```

Core fields:

| Field | Default | Description |
| --- | --- | --- |
| `mode` | `remote` | Legacy compatibility field. Only remote mode is supported. |
| `baseUrl` | `http://127.0.0.1:1933` | KMM HTTP endpoint |
| `apiKey` | empty | KMM API key |
| `peer_role` | `assistant` | Peer identity mode: `none`, `assistant`, or `person`. Session messages use body `peer_id`; data-plane recall/search uses a tenant peer-identity header. |
| `peer_prefix` | empty | Optional prefix for assistant `peer_id` / actor peer values when `peer_role=assistant`. |
| `accountId` | empty | Required when using a root API key |
| `userId` | empty | Required when using a root API key |

Use setup for normal changes when possible:

```bash
openclaw kmm setup --reconfigure
```

Manual config inspection:

```bash
openclaw config get plugins.entries.kmm.config
```

## Upgrade

```bash
openclaw plugins update kmm
openclaw gateway restart
openclaw kmm status --json
```

Confirm that `configured` and `slotActive` are both `true`.

## Uninstall

```bash
openclaw plugins uninstall kmm
openclaw config set plugins.slots.contextEngine legacy
openclaw gateway restart
```

Current OpenClaw native uninstall does not always reset `plugins.slots.contextEngine`. The explicit `config set` step avoids leaving the slot pointed at an uninstalled plugin.

## Optional Pipeline Health Check

After status passes, you can run the bundled end-to-end health check from a repository checkout:

```bash
python examples/openclaw-plugin/health_check_tools/kmm-healthcheck.py
```

This checks the Gateway to KMM path by injecting a real conversation and verifying capture, commit, archive, and memory extraction. See [health_check_tools/HEALTHCHECK.md](./health_check_tools/HEALTHCHECK.md).

## Backup Path: kmm-install

`kmm-install` is the backup path, not the primary install path. Use it when `openclaw plugins install clawhub:@kmm/openclaw-plugin` cannot reach ClawHub, is rate-limited, or when you explicitly need to install/test plugin files from a Git branch or source ref.

Try the OpenClaw plugin manager first. If that path is unavailable, run:

```bash
npm install -g openclaw-kmm-setup-helper
kmm-install
```

Useful backup/source flags:

| Flag | Meaning |
| --- | --- |
| `--workdir PATH` | Target OpenClaw state directory |
| `--plugin-version=REF` | Plugin version: npm version, npm dist-tag, or Git ref to install |
| `--current-version` | Print the version tracked by the helper |
| `--base-url URL` | KMM server URL (enables non-interactive mode) |
| `--api-key KEY` | KMM API key |
| `--peer-role ROLE` | Peer role: `none`, `assistant`, or `person` |
| `--peer-prefix PREFIX` | Prefix for assistant `peer_id` / actor peer values |
| `--update` | Update an existing helper-managed install |

For user-facing installs, use `openclaw plugins install clawhub:@kmm/openclaw-plugin` first. Choose `kmm-install` only as the backup path.

## Migrate From kmm-install To openclaw plugin install

If you previously installed KMM with `kmm-install`, follow these steps before switching to the recommended `openclaw plugins install` path.

### Same Plugin ID (kmm, version >= 0.3.x)

The kmm-install context-engine deployment writes files to `~/.openclaw/extensions/kmm/`. After installing via npm, OpenClaw may still load from the old directory. Clean it up:

```bash
# Remove kmm-install deployed files
rm -rf ~/.openclaw/extensions/kmm/

# Install via the OpenClaw plugin manager
openclaw plugins install clawhub:@kmm/openclaw-plugin

# Reconfigure (your existing config in openclaw.json is preserved)
openclaw kmm setup --reconfigure
openclaw gateway restart
openclaw kmm status --json
```

Your existing config fields such as `baseUrl`, `apiKey`, `peer_role`, and `peer_prefix` are preserved.

The plugin configuration lives under `plugins.entries.kmm.config`.

Get the current full plugin configuration:

```bash
openclaw config get plugins.entries.kmm.config
```

### Configuration Parameters

The plugin connects to an existing remote KMM server.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:1933` | Remote KMM HTTP endpoint |
| `apiKey` | empty | Optional KMM API key |
| `peer_role` | `assistant` | Peer identity mode: `none`, `assistant`, or `person`; session messages use body `peer_id`, while data-plane recall/search uses a tenant peer-identity header |
| `peer_prefix` | empty | Optional prefix for assistant `peer_id` / actor peer values when `peer_role=assistant` |

Common settings:

```bash
openclaw config set plugins.entries.kmm.config.baseUrl http://your-server:1933
openclaw config set plugins.entries.kmm.config.apiKey your-api-key
openclaw config set plugins.entries.kmm.config.peer_role assistant
openclaw config set plugins.entries.kmm.config.peer_prefix your-prefix
```

## Start

After installation (if you skipped reconfigure above):

```bash
openclaw gateway restart
openclaw kmm status --json
```

### Old Plugin ID (memory-kmm, version < 0.3.x)

The old memory plugin used a different plugin ID and slot:

```bash
# Uninstall old plugin
openclaw plugins uninstall memory-kmm 2>/dev/null || true

# Clean up old slot and files
openclaw config set plugins.slots.memory none
rm -rf ~/.openclaw/extensions/memory-kmm/

# Install new plugin
openclaw plugins install clawhub:@kmm/openclaw-plugin
openclaw kmm setup --base-url <KMM_URL> --api-key <API_KEY> --json
openclaw gateway restart
openclaw kmm status --json
```

Or use the cleanup script:

```bash
bash examples/openclaw-plugin/upgrade_scripts/cleanup-memory-kmm.sh
```

See also: [INSTALL-ZH.md](./INSTALL-ZH.md), [INSTALL-AGENT.md](./INSTALL-AGENT.md), and [docs/kmm-tos-install-guide.md](./docs/kmm-tos-install-guide.md).
