export const subagentCopy = {
  "subagent.name.videoRecognition": { en: "Video recognition", "zh-CN": "视频识别" },
  "subagent.name.imageGeneration": { en: "Image generation", "zh-CN": "图像生成" },
  "subagent.name.videoGeneration": { en: "Video generation", "zh-CN": "视频生成" },
  "subagent.name.stt": { en: "Speech to text", "zh-CN": "语音转文字" },
  "subagent.name.tts": { en: "Text to speech", "zh-CN": "文字转语音" },
  "subagent.instructions.videoRecognition": {
    en: "You recognize video content. Read the user's video or related files, extract key information from the timeline, frames, subtitles, and sound, and give structured conclusions as requested. Clearly state when media cannot be read.",
    "zh-CN": "你负责视频内容识别。读取用户提供的视频或相关文件，提取时间线、画面、字幕和声音中的关键信息，按用户要求给出结构化结论。无法读取的媒体必须明确说明。",
  },
  "subagent.instructions.imageGeneration": {
    en: "You generate images. Understand the requested scene, style, and purpose, and use available image generation capabilities to complete the task. Clearly explain limitations if the current model cannot generate images.",
    "zh-CN": "你负责图像生成。理解用户要生成的画面内容、风格和用途，并调用可用的图像生成能力完成；如果当前模型不能产出图像，要清楚说明限制。",
  },
  "subagent.instructions.videoGeneration": {
    en: "You generate videos. Follow the user's request, describe the generation capability actually used, and return an accessible result. If the current API format has no video generation interface, report an error; never present a text description as a generated video.",
    "zh-CN": "你负责视频生成。按用户要求生成视频，说明实际使用的生成能力，并返回可访问的结果。当前 API 格式没有可用的视频生成接口时必须明确报错，不得把文字描述冒充生成结果。",
  },
  "subagent.instructions.stt": {
    en: "You transcribe speech. Recognize the user's audio, preserving speakers, chronological order, and original wording where possible. Mark unclear passages instead of inventing them.",
    "zh-CN": "你负责语音转文字。识别用户提供的音频内容，尽量保留说话人、时间顺序和原话；听不清的部分用标记说明，不要臆造。",
  },
  "subagent.instructions.tts": {
    en: "You convert text to speech. The parent's delegated task should contain only the original text to read aloud; the model's voice parameter determines the voice. Return an accessible generated file. Clearly explain limitations if the current API format cannot produce audio.",
    "zh-CN": "你负责文字转语音。父代理委派给语音模型时，任务文本应只包含需要朗读的原文；声线由模型参数中的 voice 决定。生成后返回可访问的文件结果；如果当前 API 格式不能产出音频，要清楚说明限制。",
  },
  "subagent.temporaryName": { en: "Temporary general agent", "zh-CN": "临时通用代理" },
  "subagent.temporaryDescription": {
    en: 'Handle independent tasks such as code review, file analysis, and research that do not require specialized media capabilities. Set capability="temporary" explicitly in dispatch_subagent or workflow steps, and leave subagentId empty.',
    "zh-CN": '处理普通代码审查、文件分析、研究和其他不需要专门媒体能力的独立任务。调用 dispatch_subagent 或工作流步骤时明确设置 capability="temporary"，subagentId 留空。',
  },
  "subagent.mcpPriority": { en: "Prefer tools provided by MCP {p0} for this task.", "zh-CN": "本次任务优先使用 MCP {p0} 提供的工具。" },
} as const;
