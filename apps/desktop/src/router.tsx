import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import App from "./App";

const rootRoute = createRootRoute();
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: App });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: App });
const pluginsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/plugins", component: App });
const skillsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/skills", component: App });
const permissionsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/permissions", component: App });
const chatRoute = createRoute({ getParentRoute: () => rootRoute, path: "/chat/$sessionId", component: App });
const workspaceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/workspaces/$workspaceId", component: App });

const routeTree = rootRoute.addChildren([
  indexRoute,
  settingsRoute,
  pluginsRoute,
  skillsRoute,
  permissionsRoute,
  chatRoute,
  workspaceRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
