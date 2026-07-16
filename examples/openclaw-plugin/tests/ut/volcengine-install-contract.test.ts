import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = join(__dirname, "../..");

function readText(path: string): string {
  return readFileSync(join(rootDir, path), "utf8");
}

describe("Volcengine OpenViking one-click install contract", () => {
  it("keeps the Volcengine install script as a compatibility wrapper", () => {
    const script = readText("scripts/volcengine-openviking-install.sh");

    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("Compatibility wrapper");
    expect(script).toContain("exec \"$SCRIPT_DIR/install.sh\"");
  });

  it("moves Volcengine configuration flags to the global install script", () => {
    const script = readText("scripts/install.sh");

    expect(script).toContain("KMM_BASE_URL");
    expect(script).toContain("KMM_API_KEY");
    expect(script).toContain("KMM_PEER_ROLE");
    expect(script).toContain("KMM_PEER_PREFIX");
    expect(script).toContain("KMM_ACCOUNT_ID");
    expect(script).toContain("KMM_USER_ID");
    expect(script).toContain("OPENCLAW_STATE_DIR");
  });

  it("supports tos, tarball, local, and existing plugin install sources", () => {
    const script = readText("scripts/install.sh");

    expect(script).toContain("--source tos|tarball|local|existing");
    expect(script).toContain("INSTALL_SOURCE=\"${INSTALL_SOURCE:-tos}\"");
    expect(script).toContain("--source existing");
    expect(script).toContain("--tarball");
  });

  it("writes a protected env file and never prints the raw api key", () => {
    const script = readText("scripts/install.sh");

    expect(script).toContain("kmm.env");
    expect(script).toContain("chmod 600 \"$ENV_FILE\"");
    expect(script).toContain("mask_secret");
    expect(script).toContain("redact_arg");
    expect(script).toContain("KMM_RECALL_RESOURCES");
    expect(script).not.toContain("echo \"$KMM_API_KEY\"");
  });

  it("delegates configuration to openclaw setup and verifies status", () => {
    const script = readText("scripts/install.sh");

    expect(script).toContain("openclaw kmm setup");
    expect(script).toContain("--base-url \"$KMM_BASE_URL\"");
    expect(script).toContain("--api-key \"$KMM_API_KEY\"");
    expect(script).toContain("--peer-role \"$KMM_PEER_ROLE\"");
    expect(script).toContain("--peer-prefix \"$KMM_PEER_PREFIX\"");
    expect(script).toContain("--force-slot");
    expect(script).toContain("openclaw gateway restart");
    expect(script).toContain("openclaw kmm status --json");
    expect(script).toContain("openclaw config get plugins.slots.contextEngine");
  });

  it("keeps the Volcengine wrapper in package build outputs for compatibility", () => {
    const buildScript = readText("build.sh");

    expect(buildScript).toContain("scripts/volcengine-openviking-install.sh");
    expect(buildScript).toContain("output/volcengine-install.sh");
  });
});
