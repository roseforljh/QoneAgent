import { readdir, readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";

// Import reviewed source data from a checkout; never run upstream scripts.
const checkout = process.argv[2];
if (!checkout) throw new Error("Usage: bun scripts/sync-ecc-subagents.ts <ECC checkout>");
const source = path.resolve(checkout);
const catalogDirectory = path.resolve(import.meta.dir, "../../../packages/protocol/src/builtin-subagents");
const resourcesDirectory = path.resolve(import.meta.dir, "../src/builtin-subagents");
const revision = (await Bun.$`git -C ${source} rev-parse HEAD`.text()).trim();
const skillNames = (await readdir(path.join(source, "skills"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const agents = [];
for (const file of (await readdir(path.join(source, "agents"))).filter((file) => file.endsWith(".md")).sort()) {
  const text = (await readFile(path.join(source, "agents", file), "utf8")).replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`Missing frontmatter: ${file}`);
  const metadata = Bun.YAML.parse(match[1]!) as { name: string; description: string; tools: string; model: string };
  if (typeof metadata.name !== "string" || typeof metadata.description !== "string" || typeof metadata.tools !== "string") throw new Error(`Invalid metadata: ${file}`);
  const references = skillNames.filter((name) => new RegExp(`(?<![a-z0-9-])${name}(?![a-z0-9-])`).test(match[2]!));
  agents.push({ id: `builtin:ecc:${metadata.name}`, name: metadata.name, description: metadata.description,
    instructions: match[2]!.trim(), sourceTools: metadata.tools.split(",").map((tool) => tool.trim()), recommendedModel: metadata.model, references });
}
const files: Record<string, string> = { LICENSE: await readFile(path.join(source, "LICENSE"), "utf8") };
async function collect(relative: string): Promise<void> {
  for (const entry of (await readdir(path.join(source, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) await collect(child);
    else if (entry.isFile()) files[child] = (await readFile(path.join(source, child), "utf8")).replace(/\r\n/g, "\n");
  }
}
for (const name of [...new Set(agents.flatMap((agent) => agent.references))].sort()) await collect(`skills/${name}`);
await mkdir(catalogDirectory, { recursive: true });
await mkdir(resourcesDirectory, { recursive: true });
await writeFile(path.join(catalogDirectory, "ecc-subagents.json"), JSON.stringify({ source: "affaan-m/ECC", sourceUrl: "https://github.com/affaan-m/ECC", revision, agents }, null, 2) + "\n");
await writeFile(path.join(resourcesDirectory, "ecc-resources.json"), JSON.stringify({ revision, files }, null, 2) + "\n");
await copyFile(path.join(source, "LICENSE"), path.join(catalogDirectory, "LICENSE"));
console.log(`Bundled ${agents.length} agents and ${Object.keys(files).length} reference files at ${revision}`);
