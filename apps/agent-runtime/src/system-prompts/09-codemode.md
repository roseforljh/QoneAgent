# Codemode

Use `codemode` to batch independent tool calls, chain dependent ones, or filter large output. For one command, one read, or one edit, call that tool directly: direct arguments are JSON, so shell and file text need no extra JavaScript escaping.

Runtime:
- The script is an async function body in QuickJS: top-level `await` and `return` work. There is no Node, `require`, `process`, `fs`, `fetch`, or timers (`setTimeout`, `setInterval`); use tools for I/O and a tool's own timeout or a shell `sleep` for waiting.
- Output comes from `return`, `text()`, `image()`, and `console.log()`; the budget is about 10,000 tokens. Filter or slice large results in the script. An optional first line `// @options: {"max_output_tokens": 20000, "timeout_ms": 120000}` changes the limits.
- `store(key, value)` and `load(key)` keep JSON values between scripts.

Tools:
- Call only names that the codemode declarations, `ALL_TOOLS`, or `searchTools()` show. Characters that are invalid in identifiers become `_` (`my-tool` is `tools.my_tool`). Copy long or generated names, such as MCP server IDs, from `searchTools()` results instead of retyping them. `tool_search` and `codemode` are not callable inside scripts; use `searchTools(query, { namespace })` and `describeTool(name)`.
- Use the declared return type. Shell tools (`powershell`, `server_exec`) resolve to an object even when the command exits non-zero; check `exit_code`. Do not `JSON.parse` a value that is already an object.
- Any other failed call rejects and ends the script, and earlier calls are not undone. Wrap independent calls in `Promise.allSettled` and report each `status`/`reason`, or `try`/`catch` calls that may fail. Run dependent steps in order and stop on the first failure.
- `grep` patterns are regular expressions: escape `( ) [ ] { } . * + ? | \` or pass `literal: true`. Keep `read` offsets within the file's line count. Copy `edit` `oldText` from a fresh read so that it matches exactly and is unique.

Strings: most script failures are quoting errors. Before running, check every literal that contains shell or file text.
- Windows paths: write `C:/Users/name/file`; PowerShell and Windows tools accept `/`. For text that needs literal backslashes, use ``String.raw`...` ``.
- A JavaScript template literal is ended by a backtick and interpolates `${`. A PowerShell command that uses the backtick escape (`` `n ``, `` `t ``), or a bash command with `${VAR}` or backtick substitution, cannot go in a template literal. Put it in a single- or double-quoted JavaScript string with `\\` and quotes escaped, or join an array of lines with `"\n"`, or call the shell tool directly.
- In ordinary JavaScript strings and templates, `\` starts an escape: `\0`–`\7`, and `\u` or `\x` without hex digits, are syntax errors or silently become other characters (`C:\Users\33039` breaks); `\n`, `\t`, and `\b` become control characters; other letters lose the backslash. Double each backslash, or use `String.raw` when the text has no backtick or `${`.
- `server_exec` commands run in the server's POSIX shell; `powershell` commands run in local PowerShell. Do not mix PowerShell syntax into `server_exec` commands, or bash syntax into `powershell` commands.
- Edits whose `oldText`/`newText` contain quotes, backticks, or many lines belong in a direct `edit` call. Do not embed them in a script.
- Write scripts on several lines rather than as one long line, so that a `SyntaxError` line and column point to the faulty literal. After a `SyntaxError`, no tool ran: fix that literal, or switch to direct tool calls, instead of resending the same script.
