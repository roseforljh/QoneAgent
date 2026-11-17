import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const version = "2.4.5";
const archiveHash = "f2160930a98fcf5200ed50b37b1653e0f685036d5d4bcafa88da6912e5dff9cd";
const desktop = path.resolve(import.meta.dirname, "..");
const patch = path.resolve(desktop, "../../patches/PSReadLine@2.4.5.patch");
const modules = path.join(desktop, "binaries/powershell");
const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: desktop, windowsHide: true, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`)));
  });
}

/** App-local module only: never replace the user's installed PowerShell modules. */
export async function preparePSReadLine(): Promise<void> {
  const recipe = hash(Buffer.concat([await readFile(import.meta.filename), await readFile(patch)]));
  // Loaded assemblies stay mapped on Windows. Each recipe gets its own module
  // root; a pointer switches new terminals without touching running shells.
  const destination = path.join(modules, recipe, "PSReadLine");
  const active = path.join(modules, "active.txt");
  const marker = path.join(destination, "build.txt");
  const activate = async () => {
    await writeFile(active, recipe);
    for (const entry of await readdir(modules, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== recipe) {
        try { await rm(path.join(modules, entry.name), { recursive: true, force: true }); }
        catch { /* A running shell still owns this image; retry next build. */ }
      }
    }
  };
  const files = [
    "PSReadLine.psd1", "PSReadLine.psm1", "PSReadLine.format.ps1xml", "License.txt",
    "Microsoft.PowerShell.PSReadLine.dll", "Microsoft.PowerShell.Pager.dll",
    "netstd/Microsoft.PowerShell.PSReadLine.Polyfiller.dll",
    "net6plus/Microsoft.PowerShell.PSReadLine.Polyfiller.dll",
  ];
  try {
    const manifest = JSON.parse(await readFile(marker, "utf8")) as { recipe: string; files: Record<string, string> };
    if (manifest.recipe === recipe && (await Promise.all(files.map(async (file) => hash(await readFile(path.join(destination, file))) === manifest.files[file]))).every(Boolean)) {
      await activate();
      return;
    }
  } catch { /* Build a missing or changed module below. */ }

  // Downloaded files and our build workspace are separate; commands always run
  // from the project, never from a downloaded directory or its configuration.
  const source = await mkdtemp(path.join(os.tmpdir(), "qone-psreadline-source-"));
  const build = await mkdtemp(path.join(os.tmpdir(), "qone-psreadline-build-"));
  try {
    const archive = path.join(source, "source.tgz");
    await run("curl.exe", ["-fL", "--retry", "2", `https://codeload.github.com/PowerShell/PSReadLine/tar.gz/refs/tags/v${version}`, "-o", archive]);
    if (hash(await readFile(archive)) !== archiveHash) throw new Error("PSReadLine 源码 SHA-256 校验失败");
    const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/tar.exe") : "tar";
    await run(tar, ["-xzf", archive, "-C", source]);
    const upstream = path.join(source, `PSReadLine-${version}`);
    for (const directory of ["PSReadLine", "Polyfill"]) await cp(path.join(upstream, directory), path.join(build, directory), { recursive: true });
    await run("git", ["-C", path.resolve(desktop, "../.."), "apply", "--unsafe-paths", `--directory=${build.replaceAll("\\", "/")}`, patch]);

    const publish = async (project: string, framework: string) => run("dotnet", [
      "publish", path.join(build, project, `${project}.csproj`), "-c", "Release", "-f", framework,
      `-p:TargetFrameworks=${framework}`, "--source", "https://api.nuget.org/v3/index.json", "-v", "minimal",
    ]);
    await publish("PSReadLine", "netstandard2.0");
    await publish("Polyfill", "net6.0");

    await mkdir(destination, { recursive: true });
    const main = path.join(build, "PSReadLine/bin/Release/netstandard2.0/publish");
    for (const file of files.slice(0, 6)) {
      await cp(file === "License.txt" ? path.join(upstream, file) : path.join(main, file), path.join(destination, file));
    }
    for (const [directory, framework] of [["netstd", "netstandard2.0"], ["net6plus", "net6.0"]]) {
      await mkdir(path.join(destination, directory), { recursive: true });
      await cp(path.join(build, `Polyfill/bin/Release/${framework}/Microsoft.PowerShell.PSReadLine.Polyfiller.dll`), path.join(destination, directory, "Microsoft.PowerShell.PSReadLine.Polyfiller.dll"));
    }
    const digests = Object.fromEntries(await Promise.all(files.map(async (file) => [file, hash(await readFile(path.join(destination, file)))])));
    await writeFile(marker, JSON.stringify({ recipe, files: digests }));
    await activate();
    console.log(`已准备应用内 PSReadLine ${version}（尺寸变化不再跳过检查）`);
  } finally {
    await Promise.all([rm(source, { recursive: true, force: true }), rm(build, { recursive: true, force: true })]);
  }
}

if (import.meta.main) await preparePSReadLine();
