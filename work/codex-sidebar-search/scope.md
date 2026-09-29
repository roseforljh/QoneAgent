# Case Scope

## meta
- case_id: codex-sidebar-search
- created: 2026-09-29T08:50:15.1686957+08:00
- operator: local
- project_root: C:\Users\33039\Desktop\QoneAgent
- primary_skill: reverse-engineering/SKILL.md
- primary_id: R0
- lead_role: lead
- specialist_roles: []
- hint: 逆向本地 OpenAI Codex app.asar 的侧栏搜索入口并对齐前端实现
- preset: offline-sample

## auth
- status: granted
- basis: own_system
- evidence_of_auth: preset:offline-sample (owner-operated local file)
- MUST NOT proceed if status != granted

## in_scope
- assets:
  - C:\Program Files\WindowsApps\OpenAI.Codex_26.924.2738.0_x64__2p2nqsd0c76g0\app\resources\app.asar
- surfaces: []
- activities: []

## out_of_scope
- assets: []
- activities: [dos, phishing_real_users, unrestricted_exfil]

## network_profile
- mode: offline
- notes: |
    offline | lab_only | authorized_target_only | unrestricted_lab
    Change mode only after auth.status = granted.

## deliverables
- report: true
- field_journal: true
- diagrams: true
- timeline: true

## constraints
- timebox: {}
- stealth: low
- data_handling: anonymize

## signoff
- ready_for_act: true
- checklist:
  - [x] auth.status = granted
  - [x] in_scope.assets non-empty OR offline sample path set
  - [x] network_profile.mode chosen
  - [ ] out_of_scope reviewed
  - [ ] roles assigned (see skills/ops/role-map.md)

## ops_refs
- skills/ops/scope-contract.md
- skills/ops/evidence-finding-path.md
- skills/ops/role-map.md
- skills/ops/timeline-workitem.md
- skills/ops/IDENTITY.md