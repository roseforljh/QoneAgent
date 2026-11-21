// Only export proxy policy to tool subprocesses, not the sidecar's full environment.
export const toolProxyEnvironmentKey = "QONE_TOOL_PROXY_ENV";
export const proxyEnvironmentKey = /^(?:https?|all|no)_proxy$/i;
export const hasExplicitProxy = (env: Record<string, string | undefined>) =>
  Object.keys(env).some(key => proxyEnvironmentKey.test(key) && Boolean(env[key]));

export function toolProxyEnvironment(inherited: Record<string, string | undefined>, overrides: Record<string, string> = {}): Record<string, string> {
  const explicit = Object.entries(inherited).filter((entry): entry is [string, string] => proxyEnvironmentKey.test(entry[0]) && entry[1] !== undefined);
  let defaults: [string, string][] = [];
  try {
    const settings: unknown = hasExplicitProxy(inherited) ? undefined : JSON.parse(inherited[toolProxyEnvironmentKey] ?? "{}");
    if (settings && typeof settings === "object") defaults = Object.entries(settings).filter(([name, value]) => proxyEnvironmentKey.test(name) && typeof value === "string");
  } catch { /* Standalone runtimes do not have a desktop proxy environment. */ }
  const custom = Object.entries(overrides).filter(([name]) => proxyEnvironmentKey.test(name));
  const proxy = new Map<string, string>();
  for (const entries of [defaults, explicit, custom]) {
    for (const [name, value] of entries) proxy.set(name.toLowerCase(), value);
  }
  const result: Record<string, string> = {};
  for (const [name, value] of proxy) {
    result[name] = value;
    // POSIX variable names are case-sensitive. On Windows Node deduplicates them.
    result[name.toUpperCase()] = value;
  }
  const useProxy = [...proxy.entries()].some(([name, value]) => name !== "no_proxy" && value);
  return { ...result, ...(useProxy ? { NODE_USE_ENV_PROXY: inherited.NODE_USE_ENV_PROXY ?? "1" } : {}), ...overrides };
}
