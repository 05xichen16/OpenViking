export type OpenVikingRequestHeaders = Record<string, string>;

export type ResolveOpenVikingRequestHeadersOptions = {
  headers?: unknown;
};

export function resolveOpenVikingRequestHeaders(
  options: ResolveOpenVikingRequestHeadersOptions = {},
): OpenVikingRequestHeaders {
  return cleanOpenVikingRequestHeaders(options.headers);
}

export function cleanOpenVikingRequestHeaders(headers: unknown): OpenVikingRequestHeaders {
  if (headers === undefined || headers === null) {
    return {};
  }
  if (typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("kmm request headers must be an object");
  }

  const out: OpenVikingRequestHeaders = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new Error(`kmm request header ${key} must be a string`);
    }
    out[key] = value;
  }
  return out;
}
