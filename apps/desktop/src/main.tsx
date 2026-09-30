import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { initLocale, translateCurrent as t } from "./localization";
import { initAppearance } from "./lib/appearance";
import "./index.css";
import "./desktop-overrides.css";
import { reportStartup } from "./lib/startup-diagnostic";

reportStartup("Loading application modules");

type StartupErrorBoundaryProps = { children: ReactNode };
type StartupErrorBoundaryState = { error: Error | null };

class StartupErrorBoundary extends Component<StartupErrorBoundaryProps, StartupErrorBoundaryState> {
  state: StartupErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): StartupErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Qone failed to render", error, info.componentStack);
    reportStartup(error.stack || error.message);
  }

  componentDidMount() {
    document.documentElement.dataset.qoneBooted = "true";
    reportStartup("React root mounted");
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main style={{ minHeight: "100vh", padding: 32, fontFamily: "system-ui, sans-serif", color: "var(--qone-boot-foreground, #171717)", background: "var(--qone-boot-background, #fff)" }}>
        <h1 style={{ margin: "0 0 12px", fontSize: 20 }}>{t("startup.failed")}</h1>
        <p style={{ margin: "0 0 16px", color: "#666" }}>{t("startup.reportError")}</p>
        <pre style={{ margin: 0, padding: 16, overflow: "auto", whiteSpace: "pre-wrap", border: "1px solid color-mix(in srgb, currentColor 20%, transparent)", borderRadius: 8, background: "var(--qone-boot-error-surface, #f7f7f7)", color: "#9d2626" }}>
          {this.state.error.stack || this.state.error.message}
        </pre>
      </main>
    );
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Qone root element is missing");

try {
  const disposeLocale = initLocale();
  const disposeAppearance = initAppearance();
  if (import.meta.hot) import.meta.hot.dispose(() => { disposeLocale(); disposeAppearance(); });

  // A recovered module load replaces the early diagnostic page completely.
  rootElement.style.cssText = "";
  createRoot(rootElement).render(
    <StartupErrorBoundary>
      <RouterProvider router={router} />
    </StartupErrorBoundary>,
  );
} catch (error) {
  rootElement.textContent = `${t("startup.failed")}: ${error instanceof Error ? error.stack || error.message : String(error)}`;
  rootElement.style.cssText = "padding:32px;white-space:pre-wrap;font:14px/1.6 system-ui,sans-serif;color:#9d2626;background:var(--qone-boot-background,#fff)";
}
