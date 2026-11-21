import { expect, test } from "bun:test";
import { toolProxyEnvironment, toolProxyEnvironmentKey } from "@qone/protocol/proxy-environment";
import { manualToolProxy } from "../electron/tool-proxy";

test("Windows manual proxy becomes standard child variables without replacing explicit policy", () => {
  const route = manualToolProxy({ ProxyEnable: 1, ProxyServer: "http=proxy:8123;https=proxy:8443", ProxyOverride: "127.*;*.internal.example" });
  expect(route).toEqual({ HTTP_PROXY: "http://proxy:8123", HTTPS_PROXY: "http://proxy:8443", NO_PROXY: "localhost,127.0.0.1,[::1],.internal.example" });
  const env = { [toolProxyEnvironmentKey]: JSON.stringify(route), OTHER_SECRET: "ignored" };
  expect(toolProxyEnvironment(env, { https_proxy: "http://tool:9999", TOOL_SECRET: "configured" })).toMatchObject({
    http_proxy: "http://proxy:8123", https_proxy: "http://tool:9999", HTTPS_PROXY: "http://tool:9999", NODE_USE_ENV_PROXY: "1", TOOL_SECRET: "configured",
  });
  expect(toolProxyEnvironment({ ...env, NO_PROXY: "*" })).toEqual({ no_proxy: "*", NO_PROXY: "*" });
  expect(toolProxyEnvironment(env)).not.toHaveProperty("OTHER_SECRET");
  expect(manualToolProxy({ ProxyEnable: 1, ProxyServer: "proxy:8123", AutoConfigURL: "https://example.com/proxy.pac" })).toBeUndefined();
  expect(manualToolProxy({ ProxyEnable: 1, ProxyServer: "proxy:8123", ProxyOverride: "<local>" })).toBeUndefined();
});
