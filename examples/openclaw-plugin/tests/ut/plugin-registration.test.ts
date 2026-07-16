import { describe, expect, it, vi } from "vitest";

import contextEnginePlugin from "../../index.js";
import { OPENVIKING_FEATURE_GATES_RPC } from "../../plugin/openviking-feature-gates.js";

function withOpenVikingEnv<T>(
  values: Partial<Record<"KMM_API_KEY" | "KMM_BASE_URL", string | undefined>>,
  fn: () => T,
): T {
  const previous = {
    KMM_API_KEY: process.env.KMM_API_KEY,
    KMM_BASE_URL: process.env.KMM_BASE_URL,
  };
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function createPluginApi(pluginConfig: Record<string, unknown>) {
  return {
    pluginConfig,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerService: vi.fn(),
    registerContextEngine: vi.fn(),
    registerGatewayMethod: vi.fn(),
    on: vi.fn(),
  };
}

describe("plugin registration", () => {
  it("keeps runtime enabled for default no-key trusted deployments", () => {
    withOpenVikingEnv(
      {
        KMM_API_KEY: undefined,
        KMM_BASE_URL: undefined,
      },
      () => {
        const api = createPluginApi({});

        contextEnginePlugin.register(api as any);

        expect(api.registerTool).toHaveBeenCalled();
        expect(api.registerContextEngine).toHaveBeenCalledWith("kmm", expect.any(Function));
        expect(api.registerService).toHaveBeenCalledWith(expect.objectContaining({ id: "kmm" }));
        expect(api.logger.warn).not.toHaveBeenCalledWith(
          expect.stringContaining("tools and context-engine are disabled"),
        );
      },
    );
  });

  it("keeps runtime enabled when only KMM_BASE_URL is configured", () => {
    withOpenVikingEnv(
      {
        KMM_API_KEY: undefined,
        KMM_BASE_URL: "http://127.0.0.1:1933",
      },
      () => {
        const api = createPluginApi({});

        contextEnginePlugin.register(api as any);

        expect(api.registerTool).toHaveBeenCalled();
        expect(api.registerContextEngine).toHaveBeenCalledWith("kmm", expect.any(Function));
      },
    );
  });

  it("registers the feature-gates Gateway RPC when Gateway methods are available", () => {
    const api = createPluginApi({});

    contextEnginePlugin.register(api as any);

    expect(api.registerGatewayMethod).toHaveBeenCalledWith(
      OPENVIKING_FEATURE_GATES_RPC,
      expect.any(Function),
    );
  });
});
