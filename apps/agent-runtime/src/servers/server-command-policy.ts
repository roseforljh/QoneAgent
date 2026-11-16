/**
 * Port of EveryTalk's ComputerHostCommandPolicy: a command runs on a server
 * without approval only when it is provably read-only. Anything unknown,
 * privileged, composed with shell syntax or touching secrets needs approval.
 */
const SHELL_SYNTAX = /[;|><`'"\n\r&(){}#\\]|\$\(|\$[{_A-Za-z]/;
const SAFE_PS_COLUMNS = new Set(["pid", "ppid", "user", "uid", "gid", "comm", "stat", "%cpu", "%mem", "etime", "etimes", "lstart", "nlwp", "rss", "vsz", "tty"]);
const SAFE_SS_LONG = new Set(["--numeric", "--listening", "--tcp", "--udp", "--raw", "--unix", "--ipv4", "--ipv6", "--processes", "--summary", "--extended", "--memory", "--info", "--options", "--no-header", "--oneline"]);
const SAFE_IP_GLOBAL = new Set(["-brief", "-br", "-details", "-d", "-stats", "-s", "-4", "-6", "-json", "-j", "-pretty", "-p", "-human", "-h", "-oneline", "-o"]);
const READ_ONLY_FILES = new Set(["/etc/os-release", "/etc/debian_version", "/proc/cpuinfo", "/proc/meminfo", "/proc/loadavg"]);
const JOURNAL_READ = new Set(["--disk-usage", "--list-boots", "--list-catalog", "--header", "--verify"]);

const sensitivePath = (word: string) => {
  const value = word.toLowerCase();
  return value === "/etc/shadow" || value === "/etc/gshadow" || value.includes("/.ssh/") || value.startsWith("~/.ssh/")
    || value.endsWith("/.env") || value.endsWith("/credentials") || value.endsWith(".pem") || value.endsWith(".key");
};
const safePath = (value: string) => (value.startsWith("/") || value.startsWith("~")) && !sensitivePath(value);
const safeUnit = (value: string) => /^[\w.@-]+$/.test(value);
const psFields = (value: string) => value.split(",").every((field) => SAFE_PS_COLUMNS.has(field.split("=")[0]!.trim()));

function readOnlySystemctl(words: string[]): boolean {
  return words.length === 3 && words[0] === "systemctl" && ["status", "is-active", "is-enabled"].includes(words[1]!) && safeUnit(words[2]!);
}

function readOnlyPs(args: string[]): boolean {
  if (!args.length) return true;
  let format = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (["-e", "-A", "--no-headers"].includes(arg)) continue;
    if (arg === "-o" || arg === "-eo") { if (!psFields(args[++index] ?? "")) return false; format = true; continue; }
    if (/^-e?o./.test(arg)) { if (!psFields(arg.replace(/^-e?o/, ""))) return false; format = true; continue; }
    if (arg.startsWith("--sort=")) { if (!arg.slice(7).split(",").every((field) => SAFE_PS_COLUMNS.has(field.trim().replace(/^[+-]/, "")))) return false; continue; }
    return false;
  }
  // Only explicit safe columns: process arguments can carry tokens.
  return format;
}

function readOnlyIp(args: string[]): boolean {
  const objectIndex = args.findIndex((arg) => !arg.startsWith("-"));
  if (objectIndex < 0 || args.slice(0, objectIndex).some((arg) => !SAFE_IP_GLOBAL.has(arg))) return false;
  const tail = args.slice(objectIndex + 1);
  return ["address", "addr", "link", "route", "rule", "neigh"].includes(args[objectIndex]!) && (!tail.length || (tail.length === 1 && ["show", "list"].includes(tail[0]!)));
}

function readOnlyDu(args: string[]): boolean {
  let depth = false;
  for (const arg of args) {
    if (depth) { if (!/^\d+$/.test(arg)) return false; depth = false; continue; }
    if (arg === "-d" || arg === "--max-depth") depth = true;
    else if (arg.startsWith("--max-depth=")) { if (!/^\d+$/.test(arg.slice(12))) return false; }
    else if (arg.startsWith("--")) { if (!["--all", "--human-readable", "--one-file-system", "--summarize"].includes(arg)) return false; }
    else if (arg.startsWith("-")) { if (!/^-[ahxsd]+$/.test(arg)) return false; }
    else if (!safePath(arg)) return false;
  }
  return !depth;
}

function knownReadOnly(words: string[]): boolean {
  const [name, ...args] = words;
  switch (name) {
    case "hostname": case "uptime": case "whoami": case "id": return !args.length;
    case "uname": return args.every((arg) => ["-a", "-s", "-n", "-r", "-v", "-m", "-p", "-i", "-o"].includes(arg));
    case "nproc": return args.every((arg) => arg === "--all" || /^--ignore=\d+$/.test(arg));
    case "lscpu": case "lsblk": return !args.some((arg) => arg === "--help" || arg === "-h");
    case "vmstat": return args.every((arg) => ["-s", "-d", "-D", "-f"].includes(arg));
    case "free": return args.every((arg) => ["-b", "-k", "-m", "-g", "-h", "--si", "-t", "-w", "-l", "-v", "--wide", "--lohi"].includes(arg));
    case "df": return args.every((arg) => arg.startsWith("-") || safePath(arg));
    case "ps": return readOnlyPs(args);
    case "ss": return args.every((arg) => SAFE_SS_LONG.has(arg) || (/^-[Hnltuwx46psemiOar]+$/.test(arg)));
    case "ip": return readOnlyIp(args);
    case "cat": return args.length === 1 && READ_ONLY_FILES.has(args[0]!);
    case "journalctl": return args.every((arg) => JOURNAL_READ.has(arg));
    case "docker": return ["ps", "info", "version", "port"].includes(args[0] ?? "") || (args[0] === "stats" && args.some((arg) => arg === "--no-stream" || arg === "--no-stream=true"));
    default: return false;
  }
}

function pipelineReadOnly(words: string[]): boolean {
  const [name, ...args] = words;
  if (name === "echo") return true;
  if (name === "du") return readOnlyDu(args);
  if (name === "sort") return args.every((arg) => /^-[bdfghinrRsuVz]+$/.test(arg));
  if (name === "head") return !args.length || (args.length === 2 && args[0] === "-n" && /^\d+$/.test(args[1]!)) || (args.length === 1 && /^-\d+$/.test(args[0]!));
  return false;
}

const segmentReadOnly = (words: string[]) => words.length > 0 && (readOnlySystemctl(words) || knownReadOnly(words));

/** Quote-aware split on `|`, `;` and `&&`; rejects variables, substitution and write redirects. */
function splitStages(command: string): string[] | undefined {
  if (/[$`\\\n\r]/.test(command)) return undefined;
  const stages: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (char === "'" || char === '"') { quote = quote === undefined ? char : quote === char ? undefined : quote; current += char; continue; }
    if (quote === undefined) {
      if (command.startsWith("2>/dev/null", index)) { current += "2>/dev/null"; index += 10; continue; }
      const next = command[index + 1];
      if ((char === "|" && next === "|") || (char === "&" && next !== "&") || char === ">" || char === "<") return undefined;
      const separator = char === ";" || char === "|" ? 1 : char === "&" ? 2 : 0;
      if (separator) {
        if (!current.trim()) return undefined;
        stages.push(current.trim()); current = ""; index += separator - 1; continue;
      }
    }
    current += char;
  }
  if (quote !== undefined || !current.trim()) return undefined;
  return [...stages, current.trim()];
}

function tokenize(stage: string): string[] | undefined {
  const words: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of stage) {
    if (char === "'" || char === '"') quote = quote === undefined ? char : quote === char ? undefined : quote;
    else if (/\s/.test(char) && quote === undefined) { if (current) { words.push(current); current = ""; } }
    else current += char;
  }
  if (quote !== undefined) return undefined;
  if (current) words.push(current);
  return words;
}

export function isReadOnlyServerCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const words = trimmed.split(/\s+/);
  if (!SHELL_SYNTAX.test(trimmed) && !trimmed.startsWith("!")) {
    return !words.some(sensitivePath) && segmentReadOnly(words)
      && !(words[0] === "journalctl" && words.slice(1).some((arg) => !JOURNAL_READ.has(arg)));
  }
  const stages = splitStages(trimmed);
  if (!stages || stages.length < 2) return false;
  return stages.every((stage) => {
    const tokens = tokenize(stage);
    if (!tokens || tokens.filter((token) => token === "2>/dev/null").length > 1) return false;
    const command = tokens.filter((token) => token !== "2>/dev/null");
    return !command.some(sensitivePath) && (segmentReadOnly(command) || pipelineReadOnly(command));
  });
}
