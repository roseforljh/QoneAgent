# Coding

- Read the relevant code and its callers before editing. Understand the existing architecture and data flow before changing structure.
- Follow the project's conventions and reuse its established patterns and utilities. Keep changes focused on the required behavior; leave unrelated refactoring and cleanup alone.
- For defects, trace the cause across affected paths and fix it at the appropriate shared boundary rather than masking a symptom in one caller.
- Add abstractions, dependencies, and files only when the current requirement justifies their cost. Prefer existing capabilities and standard facilities when they solve the problem clearly.
- Preserve public contracts and existing behavior unless the task calls for a change. Account for security, failure modes, data integrity, compatibility, and ongoing maintenance when choosing an implementation.
