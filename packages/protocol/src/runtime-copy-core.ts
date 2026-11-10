/** Fixed runtime copy. Keys are also stable error codes. */
export const runtimeCopyCore = {
  "file-preview.invalidPath": {
    "en": "Invalid file path",
    "zh-CN": "文件路径无效"
  },
  "file-preview.workspaceRequired": {
    "en": "A workspace is required for a relative file path",
    "zh-CN": "预览相对路径文件需要工作区"
  },
  "file-preview.permissionDenied": {
    "en": "File preview is not allowed for this path",
    "zh-CN": "不允许预览此路径的文件"
  },
  "file-preview.notRegularFile": {
    "en": "Not a regular file",
    "zh-CN": "不是普通文件"
  },
  "mcp.loginRequired": {
    "en": "{p0} login credentials have expired. Sign in again to authorize access.",
    "zh-CN": "{p0} 登录凭据已失效，请重新登录授权。"
  },
  "browser-sync.opencli_operation_timed_out": {
    "en": "OpenCLI operation timed out",
    "zh-CN": "OpenCLI 操作超时"
  },
  "browser-sync.douyin_embedded_route_required": {
    "en": "The embedded media route is unavailable for this request",
    "zh-CN": "当前请求无法使用内置媒体链路"
  },
  "browser-sync.opencli_exit_code": {
    "en": "OpenCLI exit code {p0}",
    "zh-CN": "OpenCLI 退出码 {p0}"
  },
  "browser-sync.done": {
    "en": "Done",
    "zh-CN": "完成"
  },
  "browser-sync.output_truncated": {
    "en": "{p0}\n[Output truncated]",
    "zh-CN": "{p0}\n[输出已截断]"
  },
  "browser-sync.invalid_opencli_command_registry_format": {
    "en": "Invalid OpenCLI command registry format",
    "zh-CN": "OpenCLI 命令注册表格式无效"
  },
  "browser-sync.opencli_site_and_command_may_only_contain_letters_numbers": {
    "en": "OpenCLI site and command may only contain letters, numbers, underscores, or hyphens",
    "zh-CN": "OpenCLI 的 site 和 command 只能包含字母、数字、下划线或短横线"
  },
  "browser-sync.bilibili_download_must_use_qone_app_download": {
    "en": "The primary media download route failed; the fallback route is unavailable",
    "zh-CN": "主要媒体下载链路失败，备用链路不可用"
  },
  "browser-sync.bilibili_embedded_route_required": {
    "en": "The embedded media route is unavailable for this request",
    "zh-CN": "当前请求无法使用内置媒体链路"
  },
  "browser-sync.opencli_returned_no_available_adapter_commands": {
    "en": "OpenCLI returned no available adapter commands",
    "zh-CN": "OpenCLI 没有返回可用适配器命令"
  },
  "browser-sync.built_in_browser_page_closed": {
    "en": "The Qone built-in browser page was closed.",
    "zh-CN": "Qone 内置浏览器页面已关闭。"
  },
  "index.failed_to_save_qone_md": {
    "en": "Failed to save Qone.md: {p0}",
    "zh-CN": "保存 Qone.md 失败：{p0}"
  },
  "index.there_is_no_session_content_to_compact": {
    "en": "There is no session content to compact",
    "zh-CN": "没有可压缩的会话内容"
  },
  "index.the_agent_is_no_longer_running_and_cannot_be": {
    "en": "The agent is no longer running and cannot be steered",
    "zh-CN": "当前 Agent 已不在运行，无法引导"
  },
  "index.the_target_agent_run_has_ended": {
    "en": "The target agent run has ended",
    "zh-CN": "目标 Agent run 已结束"
  },
  "index.pi_is_not_accepting_steering_messages": {
    "en": "Pi is not accepting steering messages",
    "zh-CN": "Pi 当前不接受引导消息"
  },
  "pi-adapter.the_current_model_cannot_directly_read_some_attachments_only": {
    "en": "<media-routing-candidates>{p0}</media-routing-candidates>\nThe current model cannot directly read some attachments. Only if their content is required, select a suitable enabled subagent using the descriptions above and delegate the original attachments. If no suitable subagent exists, state that the task cannot be completed; do not guess attachment content.",
    "zh-CN": "<media-routing-candidates>{p0}</media-routing-candidates>\n当前模型不能直接读取部分附件。仅在任务需要其内容时，按上述已启用子代理的描述选择合适代理，委派原始附件；没有合适代理则明确说明无法完成，不要猜测附件内容。"
  },
  "pi-adapter.the_current_model_cannot_directly_read_some_attachments_and": {
    "en": "The current model cannot directly read some attachments and cannot delegate further at this execution depth. If their content is required, explain that the task cannot be completed; do not guess.",
    "zh-CN": "当前模型不能直接读取部分附件，且当前执行层级无法继续委派。任务需要这些附件内容时须明确说明无法完成，不要猜测。"
  },
  "pi-adapter.video_recognition_subagent_title": {
    "en": "Read video with the configured video agent",
    "zh-CN": "使用已配置的视频识别子代理读取视频"
  },
  "pi-adapter.video_recognition_subagent_reason": {
    "en": "The current model cannot read native video input; route the original video to the configured video recognition agent first.",
    "zh-CN": "当前模型不能原生读取视频输入，先把原视频交给已配置的视频识别子代理。"
  },
  "pi-adapter.video_recognition_subagent_expected_result": {
    "en": "Return the video findings needed to answer the user's request.",
    "zh-CN": "返回回答用户请求所需的视频识别结果。"
  },
  "pi-adapter.video_recognition_subagent_result": {
    "en": "<media-routing-result status=\"{p0}\">\n{p1}\n</media-routing-result>",
    "zh-CN": "<media-routing-result status=\"{p0}\">\n{p1}\n</media-routing-result>"
  },
  "pi-adapter.no_api_key_configured_for_speech_provider": {
    "en": "No API key configured for speech provider {p0}",
    "zh-CN": "语音生成渠道 {p0} 没有配置 API Key"
  },
  "pi-adapter.speech_result_storage_is_not_initialized": {
    "en": "Speech result storage is not initialized",
    "zh-CN": "语音结果保存功能未初始化"
  },
  "pi-adapter.speech_generated": {
    "en": "Speech generated: {p0}",
    "zh-CN": "已生成语音：{p0}"
  },
  "pi-adapter.no_api_key_configured_for_video_provider": {
    "en": "No API key configured for video provider {p0}",
    "zh-CN": "视频生成渠道 {p0} 没有配置 API Key"
  },
  "pi-adapter.video_result_storage_is_not_initialized": {
    "en": "Video result storage is not initialized",
    "zh-CN": "视频结果保存功能未初始化"
  },
  "pi-adapter.video_generated": {
    "en": "Video generated: {p0}",
    "zh-CN": "已生成视频：{p0}"
  },
  "pi-attachments.could_not_read_local_attachment": {
    "en": "Could not read local attachment: {p0}",
    "zh-CN": "无法读取本地附件：{p0}"
  },
  "pi-attachments.folder_attachment_no_readable_local_path_attach_it_again": {
    "en": "[Folder attachment {p0}: no readable local path; attach it again]",
    "zh-CN": "[文件夹附件 {p0}：没有可读取的本地路径，请重新附加]"
  },
  "pi-attachments.attachment_no_readable_local_path_attach_it_again_from": {
    "en": "[Attachment {p0}: no readable local path; attach it again from disk to use file tools]",
    "zh-CN": "[附件 {p0}：没有可读取的本地路径，如需使用文件工具读取请从本地重新附加]"
  },
  "pi-attachments.please_analyze_the_attachment": {
    "en": "Please analyze the attachment.",
    "zh-CN": "请分析附件。"
  },
  "reach-podcast-tools.audio_segmentation_failed": {
    "en": "Audio segmentation failed: {p0}",
    "zh-CN": "音频分段失败：{p0}"
  },
  "reach-podcast-tools.ffmpeg_exit_code": {
    "en": "FFmpeg exit code {p0}",
    "zh-CN": "FFmpeg 退出码 {p0}"
  },
  "reach-podcast-tools.the_number_of_audio_segments_is_outside_the_supported": {
    "en": "The number of audio segments is outside the supported range",
    "zh-CN": "音频分段数量超出支持范围"
  },
  "reach-podcast-tools.invalid_audio_file": {
    "en": "Invalid audio file",
    "zh-CN": "音频文件无效"
  },
  "reach-podcast-tools.audio_requires_segmentation_or_conversion_but_ffmpeg_is_unavailable": {
    "en": "Audio requires segmentation or conversion, but FFmpeg is unavailable",
    "zh-CN": "音频需要分段或格式转换，但 FFmpeg 不可用"
  },
  "reach-podcast-tools.the_audio_segment_exceeds_groq_s_25_mb_upload": {
    "en": "The audio segment exceeds Groq's 25 MB upload limit",
    "zh-CN": "音频片段超过 Groq 的 25 MB 上传上限"
  },
  "reach-podcast-tools.groq_transcription_failed_http_segment": {
    "en": "Groq transcription failed: HTTP {p0} (segment {p1}/{p2})",
    "zh-CN": "Groq 转写失败：HTTP {p0}（第 {p1}/{p2} 段）"
  },
  "reach-podcast-tools.groq_returned_no_transcription_for_segment": {
    "en": "Groq returned no transcription for segment {p0}",
    "zh-CN": "Groq 未返回第 {p0} 段的转写文本"
  },
  "reach-podcast-tools.xiaoyuzhou_audio_transcription": {
    "en": "Xiaoyuzhou · Audio transcription",
    "zh-CN": "小宇宙 · 音频转写"
  },
  "reach-podcast-tools.configure_a_groq_api_key_in_the_xiaoyuzhou_card": {
    "en": "Configure a Groq API key in the Xiaoyuzhou card on the Apps page first",
    "zh-CN": "请先在应用页的小宇宙卡片配置 Groq API Key"
  },
  "reach-podcast-tools.invalid_xiaoyuzhou_episode_id_format": {
    "en": "Invalid Xiaoyuzhou episode ID format",
    "zh-CN": "小宇宙单集 ID 格式无效"
  },
  "reach-podcast-tools.opencli_did_not_successfully_download_the_audio_file": {
    "en": "OpenCLI did not successfully download the audio file",
    "zh-CN": "OpenCLI 未成功下载音频文件"
  },
  "reach-podcast-tools.opencli_returned_an_invalid_audio_path": {
    "en": "OpenCLI returned an invalid audio path",
    "zh-CN": "OpenCLI 返回了无效的音频路径"
  },
  "reach-podcast-tools.transcription_truncated": {
    "en": "{p0}\n[Transcription truncated]",
    "zh-CN": "{p0}\n[转写结果已截断]"
  },
  "reach-public-tools.only_public_website_http_s_urls_are_allowed": {
    "en": "Only public website HTTP(S) URLs are allowed",
    "zh-CN": "只允许访问公开网站的 HTTP(S) 地址"
  },
  "reach-public-tools.the_website_resolved_to_a_private_network_address": {
    "en": "The website resolved to a private network address",
    "zh-CN": "网站解析到了私有网络地址"
  },
  "reach-public-tools.the_website_redirect_has_no_target_url": {
    "en": "The website redirect has no target URL",
    "zh-CN": "网站重定向缺少目标地址"
  },
  "reach-public-tools.requests_carrying_credentials_cannot_redirect_to_another_origin": {
    "en": "Requests carrying credentials cannot redirect to another origin",
    "zh-CN": "带有凭据的请求不能跨站重定向"
  },
  "reach-public-tools.website_request_failed_http": {
    "en": "Website request failed: HTTP {p0}",
    "zh-CN": "网站请求失败：HTTP {p0}"
  },
  "reach-public-tools.website_response_is_too_large": {
    "en": "Website response is too large",
    "zh-CN": "网站响应过大"
  },
  "reach-public-tools.unsupported_website_content_type": {
    "en": "Unsupported website content type: {p0}",
    "zh-CN": "不支持的网站内容类型：{p0}"
  },
  "reach-public-tools.too_many_website_redirects": {
    "en": "Too many website redirects",
    "zh-CN": "网站重定向次数过多"
  },
  "reach-public-tools.result_truncated": {
    "en": "{p0}\n[Result truncated]",
    "zh-CN": "{p0}\n[结果已截断]"
  },
  "reach-public-tools.this_is_not_a_valid_rss_or_atom_feed": {
    "en": "This is not a valid RSS or Atom feed",
    "zh-CN": "这不是有效的 RSS 或 Atom 订阅源"
  },
  "reach-public-tools.tool_execution_timed_out": {
    "en": "Tool execution timed out",
    "zh-CN": "工具执行超时"
  },
  "reach-public-tools.tool_output_is_too_large": {
    "en": "Tool output is too large",
    "zh-CN": "工具输出过大"
  },
  "reach-public-tools.tool_exit_code": {
    "en": "Tool exit code {p0}",
    "zh-CN": "工具退出码 {p0}"
  },
  "reach-public-tools.a_node_name_or_topic_id_is_required": {
    "en": "A node name or topic ID is required",
    "zh-CN": "缺少节点名或主题 ID"
  },
  "reach-public-tools.invalid_github_repository_or_username": {
    "en": "Invalid GitHub repository or username",
    "zh-CN": "GitHub 仓库或用户名无效"
  },
  "reach-public-tools.enter_owner_repo": {
    "en": "Enter owner/repo",
    "zh-CN": "请输入 owner/repo"
  },
  "reach-public-tools.bilibili_search_failed": {
    "en": "Bilibili search failed: {p0}",
    "zh-CN": "B站搜索失败：{p0}"
  },
  "reach-public-tools.yt_dlp_is_unavailable_check_the_youtube_backend_status": {
    "en": "yt-dlp is unavailable; check the YouTube backend status on the Apps page",
    "zh-CN": "yt-dlp 尚不可用；请在应用页查看 YouTube 后端状态"
  },
  "reach-public-tools.the_youtube_tool_only_accepts_youtube_video_urls": {
    "en": "The YouTube tool only accepts YouTube video URLs",
    "zh-CN": "YouTube 工具只接受 YouTube 视频地址"
  },
  "skill-catalog.skill_catalog_request_failed": {
    "en": "Skill catalog request failed",
    "zh-CN": "云库请求失败"
  },
  "skill-catalog.skill_catalog_request_failed_http": {
    "en": "Skill catalog request failed: HTTP {p0}",
    "zh-CN": "云库请求失败：HTTP {p0}"
  },
  "skill-catalog.invalid_skill_catalog_page_number": {
    "en": "Invalid skill catalog page number",
    "zh-CN": "云库页码无效"
  },
  "skill-catalog.the_search_query_is_too_long": {
    "en": "The search query is too long",
    "zh-CN": "搜索内容过长"
  },
  "skill-catalog.the_skill_catalog_returned_invalid_data": {
    "en": "The skill catalog returned invalid data",
    "zh-CN": "云库返回了无效数据"
  },
  "skill-catalog.the_skill_file_response_is_empty": {
    "en": "The skill file response is empty",
    "zh-CN": "Skill 文件响应为空"
  },
  "skill-catalog.the_skill_file_size_does_not_match_the_repository": {
    "en": "The skill file size does not match the repository manifest",
    "zh-CN": "Skill 文件大小与仓库清单不符"
  },
  "skill-catalog.invalid_skill_source": {
    "en": "Invalid skill source",
    "zh-CN": "Skill 来源无效"
  },
  "skill-catalog.could_not_determine_the_skill_repository_revision": {
    "en": "Could not determine the skill repository revision",
    "zh-CN": "无法确定 Skill 仓库版本"
  },
  "skill-catalog.the_skill_repository_file_tree_is_incomplete": {
    "en": "The skill repository file tree is incomplete",
    "zh-CN": "Skill 仓库文件树不完整"
  },
  "skill-catalog.the_skill_was_not_found_in_the_repository": {
    "en": "The skill was not found in the repository",
    "zh-CN": "仓库中找不到该 Skill"
  },
  "skill-catalog.the_skill_file_count_or_size_exceeds_the_limit": {
    "en": "The skill file count or size exceeds the limit",
    "zh-CN": "Skill 文件数量或大小超限"
  },
  "skill-catalog.the_skill_is_missing_skill_md": {
    "en": "The skill is missing SKILL.md",
    "zh-CN": "Skill 缺少 SKILL.md"
  },
  "skill-catalog.skill_file_download_failed_http": {
    "en": "Skill file download failed: HTTP {p0}",
    "zh-CN": "Skill 文件下载失败：HTTP {p0}"
  },
  "skill-catalog.invalid_downloaded_skill_format": {
    "en": "Invalid downloaded skill format",
    "zh-CN": "下载的 Skill 格式无效"
  },
  "skill-catalog.invalid_skill_name": {
    "en": "Invalid skill name",
    "zh-CN": "Skill 名称无效"
  },
  "skill-catalog.skill_is_already_installed": {
    "en": "Skill {p0} is already installed",
    "zh-CN": "Skill {p0} 已安装"
  },
  "skills.skill_names_may_only_contain_lowercase_letters_numbers_and": {
    "en": "Skill names may only contain lowercase letters, numbers, and hyphens",
    "zh-CN": "Skill 名称只能使用小写字母、数字和连字符"
  },
  "skills.the_skill_description_cannot_be_empty": {
    "en": "The skill description cannot be empty",
    "zh-CN": "Skill 描述不能为空"
  },
  "skills.the_skill_instructions_cannot_be_empty": {
    "en": "The skill instructions cannot be empty",
    "zh-CN": "Skill 指令不能为空"
  },
  "skills.the_skill_file_is_empty_or_exceeds_2_mb": {
    "en": "The skill file is empty or exceeds 2 MB",
    "zh-CN": "Skill 文件为空或超过 2 MB"
  },
  "skills.invalid_skill_file_format": {
    "en": "Invalid skill file format",
    "zh-CN": "Skill 文件格式无效"
  },
  "skills.the_skill_name_does_not_match_the_creation_form": {
    "en": "The skill name does not match the creation form",
    "zh-CN": "Skill 名称与创建表单不一致"
  },
  "subagent-runner.complete_the_delegated_task_parent_context_is_provided_for": {
    "en": "Complete the delegated task; parent context is provided for reference only.",
    "zh-CN": "完成委派任务；父级上下文仅供参考。"
  },
  "subagent-runner.continue_the_previous_task_and_describe_the_new_results": {
    "en": "Continue the previous task and describe the new results from this run.",
    "zh-CN": "继续完成之前的任务，并说明本轮新增结果。"
  },
  "subagent-tools.a_subagent_receiving_a_temporary_video_file_must_wait": {
    "en": "A subagent receiving a temporary video file must wait for completion and cannot run in the background",
    "zh-CN": "传递临时视频文件的子代理必须等待完成，不能在后台运行"
  },
  "subagent-tools.mediapath_must_be_a_media_path_just_retrieved_by": {
    "en": "mediaPath must be a media path just retrieved by the current subagent",
    "zh-CN": "mediaPath 必须是当前子代理刚取得的媒体路径"
  },
} as const;
