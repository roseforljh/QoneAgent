/**
 * The dedicated ChatGPT subscription adapter uses the backend root and adds
 * `/codex/responses` itself.  A normal Codex/Responses-compatible API uses the
 * same `/v1` root as the other OpenAI APIs.
 */
function withEndpointScheme(value: string): string {
  const base = value.trim().replace(/\/+$/, "");
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(base)) return base;
  return /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(base)
    ? `http://${base}`
    : `https://${base}`;
}

function isAnthropicApi(apiType: string): boolean {
  return /^(?:claude|anthropic|anthropic-messages)$/i.test(apiType);
}

export function isCodexSubscriptionEndpoint(value: string): boolean {
  try {
    const pathname = new URL(withEndpointScheme(value)).pathname.replace(/\/+$/, "");
    return /\/backend-api(?:\/|$)/i.test(pathname) || /\/codex(?:\/responses)?$/i.test(pathname);
  } catch {
    return false;
  }
}

export const VERTEX_AI_DEFAULT_BASE_URL = "https://aiplatform.googleapis.com/v1";

/** Google publishes distinct hosts for global, locational and multi-region endpoints. */
export function vertexProjectBaseUrl(projectId: string, location: string): string {
  const project = projectId.trim();
  const region = location.trim().toLowerCase();
  if (!/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[1-9][0-9]*)$/.test(project) || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(region)) return "";
  const url = new URL(VERTEX_AI_DEFAULT_BASE_URL);
  if (region === "us" || region === "eu") url.hostname = `aiplatform.${region}.rep.googleapis.com`;
  else if (region !== "global") url.hostname = `${region}-${url.hostname}`;
  url.pathname += `/projects/${project}/locations/${region}`;
  return url.href;
}

/** Round-trip official project URLs; retain non-matching legacy endpoints as custom URLs. */
export function vertexProjectFromBaseUrl(baseUrl: string): { projectId: string; location: string } | undefined {
  const match = /\/v1\/projects\/([^/]+)\/locations\/([^/]+)$/.exec(baseUrl);
  if (!match) return;
  const [, projectId, location] = match;
  if (vertexProjectBaseUrl(projectId, location) === baseUrl) return { projectId, location };
}

/** Domain-only input uses the provider default; explicit proxy paths stay intact. */
export function modelBaseUrl(apiType: string, value: string): string {
  const base = value.trim().replace(/\/+$/, "");
  const isVertex = apiType === "google-vertex";
  if (!base) return isVertex ? VERTEX_AI_DEFAULT_BASE_URL : "";
  // The settings UI accepts a bare host (for example `api.openai.com/v1`).
  // URL treats `host:port` as a custom protocol, so add the scheme before
  // parsing instead of making valid local/proxy endpoints fail silently.
  const url = new URL(withEndpointScheme(base));
  // URL fragments are client-only and must never become part of either the
  // provider directory or model request endpoint.
  url.hash = "";
  // Accept both a base URL and a copied request URL. Google commonly exposes
  // `.../models/{id}:generateContent`, while OpenAI/Anthropic use the shorter
  // `/chat/completions`, `/responses`, and `/messages` suffixes.
  url.pathname = url.pathname.replace(
    /\/(?:chat\/completions|responses|codex\/responses|messages|interactions|models(?:\/[^/]+)?)\/?$/i,
    "",
  );
  if (isVertex) {
    // Pi appends publishers/google/models/{id}; retain only the optional project/location prefix.
    url.pathname = url.pathname.replace(/\/publishers\/google\/?$/i, "");
    url.search = "";
  }
  // The Anthropic SDK always appends `/v1/messages` to its base URL. Keep the
  // user-facing input flexible (`host`, `/v1`, or `/v1/messages`) while
  // storing only the prefix that the SDK expects at runtime.
  if (isAnthropicApi(apiType)) {
    url.pathname = url.pathname.replace(/\/v1(?:beta)?\/?$/i, "");
  }
  // The dedicated Codex adapter appends /codex/responses itself. Its base is
  // the backend root, unlike the ordinary Responses API which uses /v1.
  if (apiType === "codex-subscription" || (apiType === "codex" && isCodexSubscriptionEndpoint(base))) {
    return url.toString().replace(/\/+$/, "");
  }
  if ((!url.pathname || url.pathname === "/") && !isAnthropicApi(apiType)) {
    url.pathname = apiType === "google" ? "/v1beta" : "/v1";
  }
  return url.toString().replace(/\/+$/, "");
}

/** Build the provider model-directory URL without corrupting query strings. */
export function modelListUrl(apiType: string, value: string): string {
  // Vertex Express does not expose a model directory; project models are not a Gemini directory either.
  if (apiType === "google-vertex") return "";
  const base = modelBaseUrl(apiType, value);
  if (!base) return "";
  const url = new URL(base);
  const suffix = isAnthropicApi(apiType) ? "/v1/models" : "/models";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${suffix}`;
  return url.toString();
}
