/** Scheduled tasks, interrupted-run recovery and MCP questions. */
export const runtimeCopyAutomation = {
  "schedule.sender": { "en": "Scheduled task · {title}", "zh-CN": "定时任务 · {title}" },
  "schedule.not_found": { "en": "This scheduled task no longer exists", "zh-CN": "这个定时任务已被删除" },
  "schedule.workspace_missing": { "en": "The project of this task was removed", "zh-CN": "这个任务所在的项目已被删除" },
  "schedule.session_missing": { "en": "The bound conversation is not in this project", "zh-CN": "绑定的会话不在这个项目里" },
  "schedule.busy": { "en": "The task's conversation is still running; it will start when that run ends", "zh-CN": "任务会话还在运行，结束后会自动开始" },
  "recovery.sender": { "en": "Qone", "zh-CN": "Qone" },
  "recovery.notice": { "en": "Qone restarted during this reply. Finished steps were kept and the task continues.", "zh-CN": "回复过程中 Qone 重启了，已保留完成的步骤并继续执行。" },
  "recovery.prompt": {
    "en": "The previous turn was interrupted by an application restart. Its completed messages and tool results above are kept; a tool that was still running when the restart happened has no result and may or may not have taken effect. Check the current state, then continue the unfinished task from where it stopped. Do not repeat steps that already succeeded.",
    "zh-CN": "上一轮因应用重启而中断。上面已完成的消息和工具结果都保留了；重启时仍在运行的工具没有结果，可能生效也可能没有。先检查当前状态，再从中断处继续完成未完成的任务，不要重复已经成功的步骤。",
  },
  "recovery.tool_interrupted": { "en": "Interrupted by an application restart", "zh-CN": "因应用重启而中断" },
  "elicitation.unavailable": { "en": "Qone could not show this request", "zh-CN": "Qone 无法显示这个请求" },
} as const;
