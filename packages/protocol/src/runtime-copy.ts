import { runtimeCopyCore } from "./runtime-copy-core";
import { runtimeCopyMedia } from "./runtime-copy-media";
import { runtimeCopyMemory } from "./runtime-copy-memory";
import { runtimeCopyServers } from "./runtime-copy-servers";
import { subagentCopy } from "./subagent-copy";
export const runtimeCopy = {
  ...runtimeCopyCore, ...runtimeCopyMedia, ...runtimeCopyMemory, ...runtimeCopyServers, ...subagentCopy,
  "background-shell.title": { en: "Background command", "zh-CN": "后台命令" },
  "background-shell.exited": { en: "Finished with exit code {code} after {seconds}s", "zh-CN": "已结束，退出码 {code}，用时 {seconds} 秒" },
  "background-shell.ended": { en: "Ended without an exit code after {seconds}s", "zh-CN": "未正常结束，用时 {seconds} 秒" },
  "skills.builtin.reserved": { en: "{name} is a built-in skill. Use its switch and update button to manage it.", "zh-CN": "{name} 是内置技能，请通过开关和更新按钮管理，不能重复安装或覆盖。" },
  "skills.builtin.unknown": { en: "Unknown built-in skill", "zh-CN": "未知的内置技能" },
  "skills.builtin.unavailable": { en: "Built-in skill preferences are unavailable", "zh-CN": "内置技能配置不可用" },
  "skills.builtin.invalid": { en: "Invalid built-in skill installation", "zh-CN": "内置技能文件格式无效" },
  "skills.builtin.nameChanged": { en: "The upstream skill name changed; the current version was preserved.", "zh-CN": "上游技能名称已改变，已保留当前版本。" },
  "skills.builtin.missingLicense": { en: "The upstream skill is missing its license; the current version was preserved.", "zh-CN": "上游技能缺少许可证，已保留当前版本。" },
} as const;
