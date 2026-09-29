# E-triage：Codex app.asar

- sample: `C:\Program Files\WindowsApps\OpenAI.Codex_26.924.2738.0_x64__2p2nqsd0c76g0\app\resources\app.asar`
- type: Electron ASAR archive containing bundled JavaScript and web assets
- SHA256: `89FBA67324FFB8DD54CCF13B6F097172E697549EEB1F26396F86F972C10C5B0C`
- network: offline static analysis only
- equivalent imports anchor: bundled React/UI modules and icon assets; no native PE import table applies to the inspected ASAR surface
- hypothesis: the sidebar search trigger is implemented by GPT's animated icon wrapper plus a uniform icon button
