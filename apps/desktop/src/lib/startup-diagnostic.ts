import { invoke, isTauri } from "@tauri-apps/api/core";

export function reportStartup(message: string) {
  if (import.meta.env.DEV && isTauri()) {
    void invoke("frontend_diagnostic", { message }).catch(console.error);
  }
}
