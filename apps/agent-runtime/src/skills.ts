import { runtimeError } from "./runtime-localization";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DefaultResourceLoader,
  createCodemodeExtension,
  createToolSearchExtension,
  type Skill,
  type ResourceLoader,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { readSystemPrompt } from "./system-prompt.js";
import { qonePiStateDir, qoneSkillsDir, qoneBuiltinSkillsDir, qoneSkillCacheDir, qoneSettingsPath } from "@qone/shared";
import { globalInstructionsPath, readGlobalInstructions } from "./global-instructions.js";
import { workspaceInstructions } from "./workspace-instructions.js";
import { toolPromptContextExtension } from "./tool-prompt-context.js";
import { assertUserSkillName, isBuiltinSkillName } from "./builtin-skills/identity.js";
import { SKILL_PUBLISHER_FILE } from "./skill-catalog.js";
import { listBuiltinSkills } from "./builtin-skills/manager.js";
import { syncPonytailProjectInstructions } from "./project-instructions.js";
import eccResources from "./builtin-subagents/ecc-resources.json";
import { syncedSkills, saveSyncedSkills } from "./claude-code/skills";
import type { SkillInfo } from "@qone/protocol";
export type { SkillInfo } from "@qone/protocol";

export function qoneAgentDir(): string {
  return qonePiStateDir();
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_CONTENT_BYTES = 2 * 1024 * 1024;

async function ensureEccReferenceSkills(): Promise<string[]> {
  const root = path.join(qoneBuiltinSkillsDir(), "ecc-reference", eccResources.revision);
  const paths = new Set<string>();
  for (const [relative, content] of Object.entries(eccResources.files)) {
    const destination = path.resolve(root, relative.replaceAll("/", path.sep));
    if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) throw new Error("Invalid ECC reference path");
    await mkdir(path.dirname(destination), { recursive: true });
    if (!existsSync(destination)) await writeFile(destination, content, "utf8");
    if (relative.startsWith("skills/") && relative.endsWith("/SKILL.md")) paths.add(path.dirname(destination));
  }
  return [...paths];
}

export async function deleteLocalSkill(skillId: string): Promise<void> {
  assertUserSkillName(skillId);
  const imported = syncedSkills();
  const { skills } = await createResourceLoader(process.cwd());
  const skill = skills.find(skill => skill.id === skillId && !skill.builtin);
  if (!skill) throw new Error(`Unknown skill: ${skillId}`);
  if (imported.some(item => item.path === skill.path)) {
    // Imported resources belong to Claude Code; remove Qone's registration only.
    saveSyncedSkills(imported.filter(item => item.path !== skill.path));
    return;
  }
  const root = path.resolve(qoneSkillsDir());
  const directory = path.dirname(path.resolve(skill.path));
  if (path.dirname(directory) !== root || path.basename(skill.path) !== "SKILL.md") throw new Error("Skill is outside the installed skills directory");
  await rm(directory, { recursive: true });
}

export async function installLocalSkill(content: string): Promise<SkillInfo> {
  return writeSkillContent(content);
}

export async function createLocalSkill(name: string, description: string, instructions: string): Promise<SkillInfo> {
  const normalizedName = name.trim().toLowerCase();
  const normalizedDescription = description.trim();
  const normalizedInstructions = instructions.trim();
  if (!SKILL_NAME.test(normalizedName)) throw runtimeError("skills.skill_names_may_only_contain_lowercase_letters_numbers_and", {});
  if (!normalizedDescription) throw runtimeError("skills.the_skill_description_cannot_be_empty", {});
  if (!normalizedInstructions) throw runtimeError("skills.the_skill_instructions_cannot_be_empty", {});
  const content = `---\nname: ${normalizedName}\ndescription: ${JSON.stringify(normalizedDescription.replace(/[\r\n]+/g, " "))}\n---\n\n${normalizedInstructions}\n`;
  return writeSkillContent(content, normalizedName);
}

async function writeSkillContent(content: string, expectedName?: string): Promise<SkillInfo> {
  if (!content.trim() || Buffer.byteLength(content, "utf8") > MAX_SKILL_CONTENT_BYTES) throw runtimeError("skills.the_skill_file_is_empty_or_exceeds_2_mb", {});
  const agentDir = qoneAgentDir();
  const skillsDir = qoneSkillsDir();
  const cacheDir = qoneSkillCacheDir();
  await mkdir(cacheDir, { recursive: true });
  const staging = await mkdtemp(path.join(cacheDir, ".skill-import-"));
  try {
    const skillFile = path.join(staging, "SKILL.md");
    await writeFile(skillFile, content, "utf8");
    const loaded = new DefaultResourceLoader({
      cwd: staging,
      agentDir,
      noSkills: true,
      noContextFiles: true,
      additionalSkillPaths: [staging],
      noExtensions: true,
    });
    await loaded.reload();
    const skill = loaded.getSkills().skills[0];
    if (!skill || loaded.getSkills().skills.length !== 1) throw runtimeError("skills.invalid_skill_file_format", {});
    if (!SKILL_NAME.test(skill.name)) throw runtimeError("skills.skill_names_may_only_contain_lowercase_letters_numbers_and", {});
    if (expectedName && skill.name !== expectedName) throw runtimeError("skills.the_skill_name_does_not_match_the_creation_form", {});
    assertUserSkillName(skill.name);
    const destination = path.join(skillsDir, skill.name);
    if (existsSync(destination)) throw runtimeError("skill-catalog.skill_is_already_installed", { p0: skill.name });
    await mkdir(skillsDir, { recursive: true });
    await rename(staging, destination);
    return { id: skill.name, name: skill.name, description: skill.description, path: path.join(destination, "SKILL.md") };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Keep skill discovery on Pi's ResourceLoader. The wrapper only exposes a
 * product-facing catalog for the GUI and persistence; it does not create a
 * second skill format.
 */
export async function createResourceLoader(cwd: string, additionalInstructions?: string, enableCodemode = false, includeEccReferences = false, extraExtensions: ExtensionFactory[] = []): Promise<{
  loader: ResourceLoader;
  skills: SkillInfo[];
}> {
  const agentDir = qoneAgentDir();
  const ownSkills = qoneSkillsDir();
  const builtinSkills = await listBuiltinSkills();
  const ponytail = builtinSkills.find((skill) => skill.id === "ponytail");
  if (ponytail) await syncPonytailProjectInstructions(cwd, ponytail.enabled !== false, ponytail.path);
  const eccReferencePaths = includeEccReferences ? await ensureEccReferenceSkills() : [];
  const importedSkills = syncedSkills().filter(skill => existsSync(skill.path));
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    // Pi's default discovery also includes project and package skills.
    // QoneAgent only loads skills installed in its own data directory.
    noSkills: true,
    noContextFiles: true,
    // Suppress Pi's SYSTEM.md / APPEND_SYSTEM.md discovery. The eight modules
    // supply the fixed preamble, before any variable context sections.
    systemPrompt: "",
    systemPromptOverride: () => readSystemPrompt(),
    appendSystemPrompt: [],
    agentsFilesOverride: () => ({ agentsFiles: workspaceInstructions(cwd) }),
    additionalSkillPaths: [
      ...builtinSkills.filter((skill) => skill.enabled).map((skill) => path.dirname(skill.path)),
      ...(existsSync(ownSkills) ? [ownSkills] : []),
      ...importedSkills.filter(skill => !isBuiltinSkillName(skill.name)).map(skill => skill.path),
      ...eccReferencePaths,
    ],
    // A manually copied user skill cannot override a reserved built-in name,
    // including while the built-in is disabled.
    skillsOverride: (base) => ({
      ...base,
      skills: base.skills.filter((skill) => !isBuiltinSkillName(skill.name) || builtinSkills.some((builtin) => builtin.enabled && builtin.path === skill.filePath)),
    }),
    noExtensions: true,
    extensionFactories: [...extensionFactories(enableCodemode), ...extraExtensions],
    // Qone.md is user-level global guidance. It stays separate from Qone's
    // built-in rules so updating the file never replaces product behavior.
    appendSystemPromptOverride: () => {
      const instructions = readGlobalInstructions().trim();
      return [
        qoneConfigurationGuide(),
        ...(instructions ? [`## Qone.md\n\n${instructions}`] : []),
        ...(additionalInstructions ? [additionalInstructions] : []),
        ...importedSkills.filter(skill => skill.pluginRoot).map(skill => `For the imported skill "${skill.name}", resolve \${CLAUDE_PLUGIN_ROOT} as ${JSON.stringify(skill.pluginRoot)}. Relative resources stay in its original directory.`),
        ...builtinSkills.filter((skill) => !skill.enabled).map((skill) => `The built-in skill "${skill.name}" is disabled. Do not apply its instructions, including its section in Qone.md and instructions previously loaded in conversation history.`),
      ];
    },
  });
  await loader.reload();
  return { loader, skills: [...builtinSkills, ...loader.getSkills().skills.filter((skill) => !isBuiltinSkillName(skill.name)).map(toInfo)] };
}

/** Tells the agent it configures Qone by editing files, which the app applies the moment they are saved. */
export function qoneConfigurationGuide(): string {
  return [
    "## Configuring Qone",
    "When the user asks you to install, change or remove an MCP service, a skill or a Qone setting, edit these files directly with your file tools. Qone applies every save immediately and updates its interface; never ask the user to restart or to open Settings.",
    `- ${qoneSettingsPath()}: JSON object. "mcpServers" maps an id to { "name", "command", "args", "env" } for local services or { "type": "http" | "sse", "url", "headers" } for remote ones (Claude Code's mcpServers shape); "disabled": true keeps a service configured but off. Saving a new or changed entry connects it; deleting an entry removes the service. Write API keys as plain values in "env"/"headers": Qone moves them into encrypted storage and leaves "$mcp.env:..." references, which you must keep unchanged. "models", "permissions" and "preferences" hold the other settings; keep keys you are not changing.`,
    '- "models" maps "provider/model" to { "provider", "model", "apiType", "baseUrl", ...model options }; model API keys must use the existing encrypted Models settings, never put them in this object. "permissions" maps a subject ("builtin" or "mcp:<id>") to permission decisions ("allow", "ask", "deny").',
    '- "preferences" supports "compaction.settings": { "autoCompactionEnabled": boolean, "compactionThreshold": 50–95 }, "memory.enabled": boolean, "skills.builtin.<name>": { "enabled": boolean, "revision": existing revision }, and "subagents.config" (profiles/routing/runtime such as maxConcurrent, timeoutMs, tokenBudget, allowNested, maxDepth, backgroundEnabled). Inspect the current file before changing a setting; do not invent option names.',
    `- ${qoneSkillsDir()}/<name>/SKILL.md (frontmatter "name" and "description", then the instructions, plus any files it needs): the skill is available at once. Delete the folder to uninstall.`,
    `- ${globalInstructionsPath()}: the user's global instructions (Qone.md).`,
    "Edit only what was asked, keep the JSON valid (an invalid file is ignored until fixed), and read the file back afterwards to confirm the change.",
  ].join("\n");
}

function extensionFactories(enableCodemode: boolean) {
  return [toolPromptContextExtension, ...(enableCodemode ? [createCodemodeExtension({ models: false }), createToolSearchExtension()] : [])];
}

/**
 * Pi keeps one extension runtime per loader and rebinds it to whichever session
 * bound last, so a loader shared by concurrent sessions would make tool_search
 * and codemode act on another session's tools. Each session gets its own
 * extensions; skills, prompts and instructions stay shared.
 */
export async function sessionResourceLoader(shared: ResourceLoader, cwd: string, enableCodemode = true, extensions: ExtensionFactory[] = [], extraExtensions: ExtensionFactory[] = []): Promise<ResourceLoader> {
  const own = new DefaultResourceLoader({
    cwd, agentDir: qoneAgentDir(), noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    noExtensions: true, systemPrompt: "", appendSystemPrompt: [], extensionFactories: [...extensionFactories(enableCodemode), ...extensions, ...extraExtensions],
  });
  await own.reload();
  return {
    getExtensions: () => own.getExtensions(),
    getSkills: () => shared.getSkills(),
    getPrompts: () => shared.getPrompts(),
    getThemes: () => shared.getThemes(),
    getAgentsFiles: () => shared.getAgentsFiles(),
    getSystemPrompt: () => shared.getSystemPrompt(),
    getSystemPromptSource: () => shared.getSystemPromptSource(),
    getAppendSystemPrompt: () => shared.getAppendSystemPrompt(),
    getAppendSystemPromptSources: () => shared.getAppendSystemPromptSources(),
    extendResources: (paths) => shared.extendResources(paths),
    reload: async (options) => { await shared.reload(options); await own.reload(options); },
  };
}

function toInfo(skill: Skill): SkillInfo {
  return {
    id: skill.name,
    name: skill.name,
    description: skill.description,
    path: skill.filePath,
    ...installedSource(skill.filePath),
  };
}

/** Read the origin recorded at install time so the UI can show the publisher. */
function installedSource(filePath: string): Pick<SkillInfo, "source" | "revision"> {
  try {
    const meta = JSON.parse(readFileSync(path.join(path.dirname(filePath), SKILL_PUBLISHER_FILE), "utf8")) as { source?: unknown; revision?: unknown };
    return {
      ...(typeof meta.source === "string" ? { source: meta.source } : {}),
      ...(typeof meta.revision === "string" ? { revision: meta.revision } : {}),
    };
  } catch {
    return {};
  }
}
