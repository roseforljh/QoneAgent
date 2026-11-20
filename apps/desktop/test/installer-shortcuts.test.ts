import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const requireFromBuilder = createRequire(import.meta.resolve("electron-builder"));
const templates = path.join(path.dirname(requireFromBuilder.resolve("app-builder-lib/package.json")), "templates/nsis");

// Read the templates used by the release build, so losing the Bun patch fails this check.
test("Windows in-place installs keep shortcuts even without the updater flag", () => {
  const section = readFileSync(path.join(templates, "installSection.nsh"), "utf8");
  const upgrade = section.slice(section.indexOf('StrCpy $keepShortcuts "false"'), section.indexOf("!insertmacro uninstallOldVersion SHELL_CONTEXT"));
  expect(upgrade).not.toContain("${isUpdated}");
  expect(upgrade).toContain('ReadRegStr $R2 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation');
  expect(upgrade).toMatch(/\$R1 == "true"\s+\$\{andIf\} \$R2 == "\$INSTDIR"\s+\$\{andIf\} \$\{FileExists\} "\$appExe"\s+StrCpy \$keepShortcuts "true"/);
  expect(section).toContain("!insertmacro addStartMenuLink $keepShortcuts");
  expect(section).toContain("!insertmacro addDesktopLink $keepShortcuts");

  const uninstall = readFileSync(path.join(templates, "include/installUtil.nsh"), "utf8");
  expect(uninstall).toMatch(/\$rootKey == "SHELL_CONTEXT"\s+\$\{andIf\} \$keepShortcuts == "true"\s+StrCpy \$0 "\$0 --keep-shortcuts"/);
});
