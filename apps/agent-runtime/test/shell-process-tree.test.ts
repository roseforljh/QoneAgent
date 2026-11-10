import { expect, test } from "bun:test";
import { createPowerShellTool } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Windows PowerShell is the case that needs a process tree kill: a plain
// child.kill() leaves the grandchild running.
const listPids = async (marker: string): Promise<number[]> => {
  const query = createPowerShellTool(process.cwd());
  const result = await query.execute("query", {
    command: `try { (Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.CommandLine -notlike '*Get-CimInstance*' } | Select-Object -ExpandProperty ProcessId) -join ',' } catch { '' }`,
  });
  const text = result.content.map((part) => part.text ?? "").join("");
  return text.split(/[\s,]+/).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
};

test("aborting a PowerShell tool kills its descendant processes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-shell-tree-"));
  const marker = `qone-descendant-${crypto.randomUUID()}`;
  const controller = new AbortController();
  const tool = createPowerShellTool(directory);
  try {
    const execution = tool.execute("tree", {
      command: [
        `$child = Start-Process -PassThru -FilePath powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 120 # ${marker}'`,
        `[Console]::Out.WriteLine("child=$($child.Id)")`,
        "Start-Sleep -Seconds 120",
      ].join("; "),
    }, controller.signal, (update) => {
      if (update.content.some((part) => (part.text ?? "").includes("child="))) controller.abort();
    });

    const error = await execution.then(() => undefined, (reason: Error) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain("aborted");

    // The grandchild must die with the tree, not linger for its full sleep.
    const deadline = Date.now() + 10_000;
    let remaining = await listPids(marker);
    while (remaining.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      remaining = await listPids(marker);
    }
    expect(remaining).toEqual([]);
  } finally {
    controller.abort();
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);