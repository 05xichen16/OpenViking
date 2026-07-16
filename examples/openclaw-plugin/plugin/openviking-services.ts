export type OpenVikingServiceLogger = {
  info: (message: string) => void;
  warn?: (message: string) => void;
};

export type OpenVikingServiceConfig = {
  baseUrl: string;
  targetUri: string;
};

export type OpenVikingServiceClient = {
  healthCheck: () => Promise<unknown>;
};

export type OpenVikingServiceOptions = {
  cfg: OpenVikingServiceConfig;
  getClient: () => Promise<OpenVikingServiceClient>;
  logger: OpenVikingServiceLogger;
  recallTraceHttpRoutesRegistered: boolean;
  registerRecallTraceRoutes: (ctx?: unknown) => boolean;
};

export function createOpenVikingService({
  cfg,
  getClient,
  logger,
  recallTraceHttpRoutesRegistered,
  registerRecallTraceRoutes,
}: OpenVikingServiceOptions) {
  return {
    id: "kmm",
    start: async (ctx?: unknown) => {
      const runtimeRouteRegistered = registerRecallTraceRoutes(ctx);
      const routeRegistered = recallTraceHttpRoutesRegistered || runtimeRouteRegistered;
      await (await getClient()).healthCheck().catch(() => {});
      logger.info(
        `kmm: initialized (url: ${cfg.baseUrl}, targetUri: ${cfg.targetUri}, search: hybrid endpoint)`,
      );
      if (routeRegistered) {
        logger.info("kmm: registered recall trace Gateway routes");
      } else {
        logger.warn?.("kmm: recall trace Gateway route adapter unavailable; use kmm_recall_trace tool or /kmm-recall-trace command");
      }
    },
    stop: () => {
      logger.info("kmm: stopped");
    },
  };
}
