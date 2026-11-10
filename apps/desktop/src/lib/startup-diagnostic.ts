import { invoke, isDesktop } from "./desktop-bridge";

export function reportStartup(message: string) {
  if (import.meta.env.DEV && isDesktop()) {
    void invoke("frontend_diagnostic", { message }).catch(console.error);
  }
}
