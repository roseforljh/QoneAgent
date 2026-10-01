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
  "bilibili-fallback.bilibili_cli_returned_no_data": {
    "en": "bilibili-cli returned no data",
    "zh-CN": "bilibili-cli 未返回资料"
  },
  "bilibili-fallback.bilibili_cli_returned_invalid_json": {
    "en": "bilibili-cli returned invalid JSON",
    "zh-CN": "bilibili-cli 未返回有效 JSON"
  },
  "bilibili-fallback.invalid_bilibili_cli_response_format": {
    "en": "Invalid bilibili-cli response format",
    "zh-CN": "bilibili-cli 返回格式无效"
  },
  "bilibili-fallback.bilibili_cli_failed_to_retrieve_data": {
    "en": "bilibili-cli failed to retrieve data: {p0}",
    "zh-CN": "bilibili-cli 获取资料失败：{p0}"
  },
  "bilibili-fallback.this_is_not_a_bilibili_video_url": {
    "en": "This is not a Bilibili video URL",
    "zh-CN": "不是 B 站视频链接"
  },
  "bilibili-fallback.bilibili_cli_is_not_installed": {
    "en": "bilibili-cli is not installed",
    "zh-CN": "bilibili-cli 未安装"
  },
  "bilibili-fallback.could_not_retrieve_the_full_bilibili_video_subtitles_audio": {
    "en": "Could not retrieve the full Bilibili video, subtitles, audio, or summary. {p0}",
    "zh-CN": "无法取得 B 站完整视频、字幕、音频或摘要。{p0}"
  },
  "browser-sync.opencli_operation_timed_out": {
    "en": "OpenCLI operation timed out",
    "zh-CN": "OpenCLI 操作超时"
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
  "browser-sync.google_chrome_was_not_found_unable_to_launch_the": {
    "en": "Google Chrome was not found; unable to launch the current browser profile",
    "zh-CN": "未找到 Google Chrome，无法启动当前浏览器配置"
  },
  "browser-sync.opencli_returned_no_available_adapter_commands": {
    "en": "OpenCLI returned no available adapter commands",
    "zh-CN": "OpenCLI 没有返回可用适配器命令"
  },
  "browser-sync.browser_connection_released_only_the_browser_started_by_qone": {
    "en": "Browser connection released; only the browser started by Qone was closed.",
    "zh-CN": "浏览器连接已释放；仅关闭了 Qone 自己启动的浏览器。"
  },
  "generated-artifacts.invalid_media_file_format": {
    "en": "Invalid media file format",
    "zh-CN": "无效的媒体文件格式"
  },
  "generated-artifacts.the_media_generation_api_returned_an_empty_file": {
    "en": "The media generation API returned an empty file",
    "zh-CN": "媒体生成接口返回了空文件"
  },
  "google-media.invalid_local_media_attachment_reference": {
    "en": "Invalid local media attachment reference",
    "zh-CN": "无效的本地媒体附件引用"
  },
  "google-media.invalid_local_media_attachment_path_or_type": {
    "en": "Invalid local media attachment path or type",
    "zh-CN": "无效的本地媒体附件路径或类型"
  },
  "google-media.gemini_file_upload_returned_an_invalid_result": {
    "en": "Gemini file upload returned an invalid result",
    "zh-CN": "Gemini 文件上传返回了无效结果"
  },
  "google-media.gemini_file_upload_returned_no_file_uri": {
    "en": "Gemini file upload returned no file URI",
    "zh-CN": "Gemini 文件上传缺少文件 URI"
  },
  "google-media.gemini_files_api_http": {
    "en": "Gemini Files API HTTP {p0}: {p1}",
    "zh-CN": "Gemini 文件接口 HTTP {p0}: {p1}"
  },
  "google-media.gemini_files_api_http_details_1": {
    "en": "Gemini Files API HTTP {p0}",
    "zh-CN": "Gemini 文件接口 HTTP {p0}"
  },
  "google-media.gemini_could_not_process_this_audio_or_video_file": {
    "en": "Gemini could not process this audio or video file{p0}",
    "zh-CN": "Gemini 无法处理这个音视频文件{p0}"
  },
  "google-media.gemini_audio_video_processing_timed_out_please_try_again": {
    "en": "Gemini audio/video processing timed out; please try again later",
    "zh-CN": "Gemini 音视频处理超时，请稍后重试"
  },
  "google-media.gemini_video_has_not_been_uploaded_files_api_returned": {
    "en": "Gemini video has not been uploaded: Files API {p0} returned an HTTP {p1} HTML page instead of an upload session. Verify that the gateway supports the Gemini Files API and upload routes; support for text or YouTube links does not imply file upload support.",
    "zh-CN": "Gemini 视频尚未上传：Files API {p0} 返回 HTTP {p1} HTML 网页，未返回上传会话。请核实网关是否支持 Gemini Files API 及上传路由；支持文本或 YouTube 链接不代表支持文件上传。"
  },
  "google-media.gemini_files_api_returned_no_upload_url_http_content": {
    "en": "Gemini Files API returned no upload URL ({p0}, HTTP {p1}, Content-Type: {p2}){p3}",
    "zh-CN": "Gemini 文件接口未返回上传地址（{p0}，HTTP {p1}，Content-Type: {p2}）{p3}"
  },
  "google-media.not_provided": {
    "en": "not provided",
    "zh-CN": "未提供"
  },
  "google-media.the_local_media_attachment_is_no_longer_a_file": {
    "en": "The local media attachment is no longer a file",
    "zh-CN": "本地媒体附件已不是文件"
  },
  "google-media.the_current_model_lacks_the_required_media_input_capability": {
    "en": "[The current model lacks the required media input capability; delegate to a subagent]",
    "zh-CN": "[当前模型未配置对应媒体输入能力；请委派子代理]"
  },
  "google-media.the_previous_session_s_media_reference_has_expired_provide": {
    "en": "[The previous session's media reference has expired; provide it again to analyze it]",
    "zh-CN": "[先前会话的媒体引用已失效；如需分析，请重新提供]"
  },
  "google-media.previously_processed_temporary_media_has_been_cleaned_up_retrieve": {
    "en": "[Previously processed temporary media has been cleaned up; retrieve it again to analyze it]",
    "zh-CN": "[先前处理的媒体临时文件已清理；如需再次分析，请重新获取]"
  },
  "google-media.media_files_are_attached_after_the_tool_result": {
    "en": "[Media files are attached after the tool result]",
    "zh-CN": "[媒体文件已附在工具结果后]"
  },
  "google-media.previously_downloaded_temporary_media_has_been_cleaned_up_download": {
    "en": "[Previously downloaded temporary media has been cleaned up; download it again to analyze it]",
    "zh-CN": "[先前下载的媒体临时文件已清理；如需再次分析，请重新下载]"
  },
  "google-media.gemini_audio_video_upload_requires_an_api_key": {
    "en": "Gemini audio/video upload requires an API key",
    "zh-CN": "Gemini 音视频上传需要 API Key"
  },
  "google-media.gemini_files_api_returned_no_file_uri": {
    "en": "Gemini Files API returned no file URI",
    "zh-CN": "Gemini 文件接口未返回文件 URI"
  },
  "google-video-generation.google_veo_api_http": {
    "en": "Google Veo API HTTP {p0}: {p1}",
    "zh-CN": "Google Veo 接口 HTTP {p0}: {p1}"
  },
  "google-video-generation.invalid_google_veo_api_response_format": {
    "en": "Invalid Google Veo API response format",
    "zh-CN": "Google Veo 接口返回格式无效"
  },
  "google-video-generation.google_veo_api_returned_no_valid_operation_name": {
    "en": "Google Veo API returned no valid operation name",
    "zh-CN": "Google Veo 接口未返回有效任务名称"
  },
  "google-video-generation.the_google_veo_model_has_no_api_url": {
    "en": "The Google Veo model has no API URL",
    "zh-CN": "Google Veo 模型缺少 API 地址"
  },
  "google-video-generation.google_veo_video_generation_failed": {
    "en": "Google Veo video generation failed: {p0}",
    "zh-CN": "Google Veo 视频生成失败：{p0}"
  },
  "google-video-generation.google_veo_finished_but_returned_no_video_url": {
    "en": "Google Veo finished but returned no video URL",
    "zh-CN": "Google Veo 生成完成但未返回视频地址"
  },
  "google-video-generation.google_veo_returned_an_unsupported_download_url": {
    "en": "Google Veo returned an unsupported download URL",
    "zh-CN": "Google Veo 返回了不支持的下载地址"
  },
  "google-video-generation.google_veo_video_download_redirect_has_no_url": {
    "en": "Google Veo video download redirect has no URL",
    "zh-CN": "Google Veo 视频下载重定向缺少地址"
  },
  "google-video-generation.invalid_google_veo_video_download_redirect_url": {
    "en": "Invalid Google Veo video download redirect URL",
    "zh-CN": "Google Veo 视频下载重定向地址无效"
  },
  "google-video-generation.too_many_google_veo_video_download_redirects": {
    "en": "Too many Google Veo video download redirects",
    "zh-CN": "Google Veo 视频下载重定向过多"
  },
  "google-video-generation.google_veo_video_download_http": {
    "en": "Google Veo video download HTTP {p0}: {p1}",
    "zh-CN": "Google Veo 视频下载 HTTP {p0}: {p1}"
  },
  "google-video-generation.google_veo_video_download_returned_content_other_than_mp4": {
    "en": "Google Veo video download returned content other than MP4: {p0}",
    "zh-CN": "Google Veo 视频下载返回了非 MP4 内容：{p0}"
  },
  "google-video-generation.google_veo_video_download_returned_no_file": {
    "en": "Google Veo video download returned no file",
    "zh-CN": "Google Veo 视频下载没有返回文件"
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
  "media-attachments.video_attachment_has_no_readable_local_path_or_base64": {
    "en": "Video attachment {p0} has no readable local path or Base64 data",
    "zh-CN": "视频附件 {p0} 没有可读取的本地路径或 Base64 数据"
  },
  "media-tool.video_retrieved_through_local_file_choose_timestamps_as_needed": {
    "en": "Video retrieved through {p0}. Local file: {p1}. {p2}. Choose timestamps as needed, then call qone_video_use_file with path and timestamps (seconds) to read frames; use mode=audio on the same path to read audio. No frames or audio have been read yet.",
    "zh-CN": "已通过 {p0} 获取视频。本地文件：{p1}。{p2}。按任务需要选择时间点，再调用 qone_video_use_file，传 path 和 timestamps（秒）读取画面；需要声音时对相同路径设置 mode=audio。当前尚未读取画面或声音。"
  },
  "media-tool.video_duration_unknown": {
    "en": "Video duration unknown",
    "zh-CN": "视频时长未知"
  },
  "media-tool.video_duration_seconds": {
    "en": "Video duration: {p0} seconds",
    "zh-CN": "视频时长 {p0} 秒"
  },
  "media-tool.video_retrieved_through_frames_read_at_the_selected_timestamps": {
    "en": "Video retrieved through {p0}; {p1} frames read at the selected timestamps. The model has read these still frames, not the full video or its audio. Local file: {p2}. To read audio, call qone_video_use_file on this path with mode=audio; no new download is needed.",
    "zh-CN": "已通过 {p0} 获取视频并按所选时间点读取 {p1} 帧。模型实际读取的是这些静态画面，不是完整视频，也未读取声音。本地文件：{p2}。需要声音时可对这个路径调用 qone_video_use_file 并设置 mode=audio；无需重新下载。"
  },
  "media-tool.frame_timestamp_seconds": {
    "en": "Frame timestamp: {p0} seconds",
    "zh-CN": "画面时间：{p0} 秒"
  },
  "media-tool.no_media_recognition_task_is_available": {
    "en": "No media recognition task is available",
    "zh-CN": "没有可用的媒体识别任务"
  },
  "media-tool.the_current_model_has_no_audio_input_configured_delegate": {
    "en": "The current model has no audio input configured; delegate the original attachment",
    "zh-CN": "当前模型未配置音频输入；请委派原始附件"
  },
  "media-tool.the_current_api_format_does_not_support_audio_attachments": {
    "en": "The current API format does not support audio attachments; delegate the original attachment",
    "zh-CN": "当前 API 格式尚未接入音频附件输入；请委派原始附件"
  },
  "media-tool.no_video_attachment_reference_was_found_for_the_current": {
    "en": "No video attachment reference was found for the current task",
    "zh-CN": "未找到当前任务的视频附件引用"
  },
  "media-tool.temporary_file_management_for_audio_extraction_is_not_initialized": {
    "en": "Temporary file management for audio extraction is not initialized",
    "zh-CN": "音轨提取的临时文件管理尚未初始化"
  },
  "media-tool.could_not_extract_audio_from_the_video_attachment": {
    "en": "Could not extract audio from the video attachment",
    "zh-CN": "无法从视频附件提取音轨"
  },
  "media-tool.audio_extracted_from_the_user_s_video_attachment_no": {
    "en": "Audio extracted from the user's video attachment; no frames have been read. Audio input: {p0}",
    "zh-CN": "已从用户视频附件提取声音；未读取画面。音频输入：{p0}"
  },
  "media-tool.the_current_model_cannot_read_video_frames_through_the": {
    "en": "The current model cannot read video frames through the image protocol; delegate the original attachment",
    "zh-CN": "当前模型无法通过图像协议读取视频画面；请委派原始附件"
  },
  "media-tool.temporary_file_management_for_frame_extraction_is_not_initialized": {
    "en": "Temporary file management for frame extraction is not initialized",
    "zh-CN": "画面提取的临时文件管理尚未初始化"
  },
  "media-tool.read_frames_from_attachment_at_the_specified_timestamps_no": {
    "en": "Read {p1} frames from attachment {p0} at the specified timestamps; no audio or full video has been read.",
    "zh-CN": "已从附件 {p0} 按指定时间点读取 {p1} 帧；未读取声音或完整视频。"
  },
  "media-tool.attachment_choose_timestamps_as_needed_and_call_this_tool": {
    "en": "Attachment {p0}: {p1}. Choose timestamps as needed and call this tool again with timestamps (seconds). No frames or audio have been read yet.",
    "zh-CN": "附件 {p0}：{p1}。请按任务需要选择时间点，带 timestamps（秒）再次调用本工具。当前未读取画面或声音。"
  },
  "media-tool.no_video_recognition_task_is_available": {
    "en": "No video recognition task is available",
    "zh-CN": "没有可用的视频识别任务"
  },
  "media-tool.the_current_api_format_cannot_read_full_videos_or": {
    "en": "The current API format cannot read full videos or video frames; configure image input or delegate the original URL to read frames",
    "zh-CN": "当前 API 格式无法读取完整视频或画面帧；需要画面时请配置图像输入，或委派原始链接"
  },
  "media-tool.the_current_model_or_api_format_cannot_read_audio": {
    "en": "The current model or API format cannot read audio; delegate the original URL",
    "zh-CN": "当前模型或 API 格式无法读取音频；请委派原始链接"
  },
  "media-tool.gemini_can_recognize_youtube_urls_directly_no_download_is": {
    "en": "Gemini can recognize YouTube URLs directly; no download is needed",
    "zh-CN": "Gemini 可直接识别 YouTube 链接，无需下载"
  },
  "media-tool.audio_download_failed_full_video_download_failed": {
    "en": "Audio download failed: {p0}; full video download failed: {p1}",
    "zh-CN": "音轨下载失败：{p0}；完整视频下载失败：{p1}"
  },
  "media-tool.video_retrieval_failed_yt_dlp_bilibili_cli_opencli_fallback": {
    "en": "Video retrieval failed: yt-dlp: {p0}; bilibili-cli/OpenCLI fallback data: {p1}",
    "zh-CN": "视频获取失败：yt-dlp: {p0}；bilibili-cli/OpenCLI 降级资料: {p1}"
  },
  "media-tool.fallback_analysis_the_full_video_was_not_retrieved_do": {
    "en": "Fallback analysis: the full video was not retrieved; do not claim to have recognized its frames. Data source: {p0}.",
    "zh-CN": "降级分析：未取得完整视频，不能声称识别了画面。资料来源：{p0}。"
  },
  "media-tool.available_audio_path": {
    "en": "Available audio path: {p0}",
    "zh-CN": "可用音频路径：{p0}"
  },
  "media-tool.audio_input": {
    "en": "Audio input: {p0}",
    "zh-CN": "音频输入：{p0}"
  },
  "media-tool.the_current_model_has_no_audio_input_configured_delegate_details_0": {
    "en": "The current model has no audio input configured; delegate to an audio subagent with mediaPath if audio analysis is required.",
    "zh-CN": "当前模型未配置音频输入；需要声音分析时委派音频子代理并传 mediaPath。"
  },
  "media-tool.no_readable_audio_file_was_retrieved": {
    "en": "No readable audio file was retrieved.",
    "zh-CN": "未取得可读取的音频文件。"
  },
  "media-tool.used_to_no_frames_have_been_read_audio_path": {
    "en": "Used {p0} to {p1}; no frames have been read. Audio path: {p2}\nAudio input: {p3}",
    "zh-CN": "已通过 {p0} {p1}；未读取画面。音频路径：{p2}\n音频输入：{p3}"
  },
  "media-tool.retrieve_audio_directly": {
    "en": "retrieve audio directly",
    "zh-CN": "直接获取音频"
  },
  "media-tool.retrieve_the_video_and_extract_audio": {
    "en": "retrieve the video and extract audio",
    "zh-CN": "获取视频并提取音频"
  },
  "media-tool.video_downloaded_through_local_path_media_input_actual_source": {
    "en": "Video downloaded through {p0}; local path: {p1}\nMedia input: {p2}\nActual source: full video file.",
    "zh-CN": "已通过 {p0} 下载视频，本地路径：{p1}\n媒体输入：{p2}\n实际来源：完整视频文件。"
  },
  "media-tool.the_current_model_cannot_process_video_or_audio_delegate": {
    "en": "The current model cannot process video or audio; delegate the original URL without downloading it first",
    "zh-CN": "当前模型无法处理视频或音频；请委派原始链接，勿提前下载"
  },
  "media-tool.temporary_download_directory_after_downloading_call_qone_video_use": {
    "en": "Temporary download directory: {p0}. After downloading, call qone_video_use_file with the actual media file path.",
    "zh-CN": "临时下载目录：{p0}。下载完成后调用 qone_video_use_file，传入实际媒体文件路径。"
  },
  "media-tool.an_absolute_media_file_path_is_required": {
    "en": "An absolute media file path is required",
    "zh-CN": "需要媒体文件的绝对路径"
  },
  "media-tool.the_media_path_is_not_a_file": {
    "en": "The media path is not a file",
    "zh-CN": "媒体路径不是文件"
  },
  "media-tool.could_not_identify_the_media_file_format": {
    "en": "Could not identify the media file format",
    "zh-CN": "无法识别媒体文件格式"
  },
  "media-tool.mode_video_requires_a_video_file_the_current_path": {
    "en": "mode=video requires a video file; the current path is an audio file",
    "zh-CN": "mode=video 需要视频文件；当前路径是音频文件"
  },
  "media-tool.mode_audio_requires_an_audio_or_video_file": {
    "en": "mode=audio requires an audio or video file",
    "zh-CN": "mode=audio 需要音频或视频文件"
  },
  "media-tool.the_current_api_format_cannot_read_full_videos_or_details_0": {
    "en": "The current API format cannot read full videos or video frames; configure image input or delegate the original attachment",
    "zh-CN": "当前 API 格式无法读取完整视频或画面帧；请配置图像输入或委派原始附件"
  },
  "media-tool.the_current_model_or_api_format_cannot_read_audio_details_0": {
    "en": "The current model or API format cannot read audio; delegate the original attachment",
    "zh-CN": "当前模型或 API 格式无法读取音频；请委派原始附件"
  },
  "media-tool.the_media_file_must_be_in_the_current_task": {
    "en": "The media file must be in the current task's temporary download directory or have been created by its download tool",
    "zh-CN": "媒体文件必须位于当前任务的临时下载目录，或由当前任务的下载工具生成"
  },
  "media-tool.audio_extracted_from_the_file_no_frames_have_been": {
    "en": "Audio extracted from the file; no frames have been read. Audio input: {p0}",
    "zh-CN": "已从文件提取音频，未读取画面。音频输入：{p0}"
  },
  "media-tool.the_current_model_has_no_input_configured_delegate_to": {
    "en": "The current model has no {p0} input configured; delegate to a suitable subagent with mediaPath={p1}.",
    "zh-CN": "当前模型未配置{p0}输入；请用 mediaPath={p1} 委派合适的子代理。"
  },
  "media-tool.video": {
    "en": "video",
    "zh-CN": "视频"
  },
  "media-tool.audio": {
    "en": "audio",
    "zh-CN": "音频"
  },
  "media-tool.actual_source_local_downloaded_file_media_input": {
    "en": "Actual source: local downloaded file {p0}. Media input: {p1}",
    "zh-CN": "实际来源：本地下载文件 {p0}。媒体输入：{p1}"
  },
  "openai-audio.chat_completions_audio_input_requires_mp3_wav_ffmpeg_was": {
    "en": "Chat Completions audio input requires MP3/WAV; FFmpeg was not found to convert {p0}",
    "zh-CN": "Chat Completions 音频输入需要 MP3/WAV；转换 {p0} 时未找到 FFmpeg"
  },
  "openai-audio.the_previous_session_s_media_reference_has_expired_provide": {
    "en": "[The previous session's media reference has expired; provide it again]",
    "zh-CN": "[先前会话的媒体引用已失效；请重新提供]"
  },
  "openai-audio.chat_completions_has_no_general_native_video_file_input": {
    "en": "Chat Completions has no general native video file input; a download path cannot be sent as video content",
    "zh-CN": "Chat Completions API 格式没有通用的原生视频文件输入；不能把下载路径当作视频内容发送"
  },
  "openai-audio.the_current_model_has_no_audio_input_capability_configured": {
    "en": "[The current model has no audio input capability configured; delegate to a subagent]",
    "zh-CN": "[当前模型未配置音频输入能力；请委派子代理]"
  },
  "openai-audio.the_media_file_was_cleaned_up_or_is_missing": {
    "en": "[The media file was cleaned up or is missing; provide it again]",
    "zh-CN": "[媒体文件已清理或不存在；请重新提供]"
  },
  "openai-audio.audio_is_attached_to_a_subsequent_message": {
    "en": "[Audio is attached to a subsequent message]",
    "zh-CN": "[音频已附于后续消息]"
  },
  "openai-audio.the_current_api_format_does_not_support_video_file": {
    "en": "[The current API format does not support video file input; delegate to a subagent that can process video]",
    "zh-CN": "[当前 API 格式未接通视频文件输入；请委派能处理视频的子代理]"
  },
  "pi-adapter.use_these_configured_capabilities_to_determine_whether_media_can": {
    "en": "<runtime-media-capabilities input=\"{p0}\" output=\"{p1}\">Use these configured capabilities to determine whether media can be processed. If a capability is missing, delegate the original URL or attachment based on enabled subagent descriptions; do not download it first. If no suitable subagent exists, explain the missing capability and stop; do not pretend to have recognized the media.</runtime-media-capabilities>",
    "zh-CN": "<runtime-media-capabilities input=\"{p0}\" output=\"{p1}\">按这些勾选项判断能否处理媒体。缺少能力时先按已启用子代理的描述委派原始链接或附件；不要提前下载。没有合适子代理则说明缺少的能力并停止，不能假装已识别。</runtime-media-capabilities>"
  },
  "pi-adapter.the_current_model_cannot_directly_read_some_attachments_only": {
    "en": "<media-routing-candidates>{p0}</media-routing-candidates>\nThe current model cannot directly read some attachments. Only if their content is required, select a suitable enabled subagent using the descriptions above and delegate the original attachments. If no suitable subagent exists, state that the task cannot be completed; do not guess attachment content.",
    "zh-CN": "<media-routing-candidates>{p0}</media-routing-candidates>\n当前模型不能直接读取部分附件。仅在任务需要其内容时，按上述已启用子代理的描述选择合适代理，委派原始附件；没有合适代理则明确说明无法完成，不要猜测附件内容。"
  },
  "pi-adapter.the_current_model_cannot_directly_read_some_attachments_and": {
    "en": "The current model cannot directly read some attachments and cannot delegate further at this execution depth. If their content is required, explain that the task cannot be completed; do not guess.",
    "zh-CN": "当前模型不能直接读取部分附件，且当前执行层级无法继续委派。任务需要这些附件内容时须明确说明无法完成，不要猜测。"
  },
  "pi-adapter.the_current_api_format_has_no_general_video_file": {
    "en": "The current API format has no general video file field, and the model has no image input configured; delegate the original video attachment if frames are needed.",
    "zh-CN": "当前 API 格式没有通用的视频文件字段，且当前模型未配置图像输入；需要画面时请委派原始视频附件。"
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
  "pi-attachments.delegate_original_attachments_without_preprocessing_if_the_executing_agent": {
    "en": "<runtime-video-attachments>\n{p0}\nDelegate original attachments without preprocessing. If the executing agent uses an API other than Gemini and has video and image input configured, call qone_media_extract_frames to read the duration, then pass timestamps to read still frames as needed. If only audio is needed and audio input is configured, call qone_media_extract_audio. Pass attachmentId to either tool.\n</runtime-video-attachments>",
    "zh-CN": "<runtime-video-attachments>\n{p0}\n需要委派时直接传原始附件，勿提前处理。最终执行代理若使用非 Gemini API 格式且配置了视频和图像输入，先用 qone_media_extract_frames 读取时长，再传 timestamps 按需读取静态画面；只需声音且配置了音频输入时，可调用 qone_media_extract_audio。两者都传 attachmentId。\n</runtime-video-attachments>"
  },
  "pi-attachments.could_not_read_local_attachment": {
    "en": "Could not read local attachment: {p0}",
    "zh-CN": "无法读取本地附件：{p0}"
  },
  "pi-attachments.folder_attachment_no_readable_local_path_attach_it_again": {
    "en": "[Folder attachment {p0}: no readable local path; attach it again]",
    "zh-CN": "[文件夹附件 {p0}：没有可读取的本地路径，请重新附加]"
  },
  "pi-attachments.image_attachment_the_current_model_has_no_image_input": {
    "en": "[Image attachment {p0}: the current model has no image input configured; delegate to a subagent that can process images]",
    "zh-CN": "[图片附件 {p0}：当前模型未配置图像输入能力，需交给能处理图片的子代理]"
  },
  "pi-attachments.the_current_api_format_has_no_direct_video_file": {
    "en": "The current API format has no direct video file input; the executing agent must read video frames as needed",
    "zh-CN": "当前 API 格式没有直接的视频文件输入；需要画面时由最终执行代理按需读取画面帧"
  },
  "pi-attachments.the_current_model_can_call_qone_media_extract_audio": {
    "en": "The current model can call qone_media_extract_audio to read audio as needed; delegate the original attachment if frames are required",
    "zh-CN": "当前模型可按需调用 qone_media_extract_audio 读取声音；若任务需要画面，请委派原始附件"
  },
  "pi-attachments.the_current_model_cannot_read_this_media_directly_delegate": {
    "en": "The current model cannot read this media directly; delegate to a subagent that can process it",
    "zh-CN": "当前模型无法直接读取，需交给能处理该媒体的子代理"
  },
  "pi-attachments.media_attachment": {
    "en": "[Media attachment {p0} ({p1}): {p2}]",
    "zh-CN": "[媒体附件 {p0}（{p1}）：{p2}]"
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
  "reach-public-tools.xueqiu_api": {
    "en": "Xueqiu · API",
    "zh-CN": "雪球 · API"
  },
  "reach-public-tools.configure_a_cookie_in_the_xueqiu_card_on_the": {
    "en": "Configure a cookie in the Xueqiu card on the Apps page first",
    "zh-CN": "请先在应用页的雪球卡片配置 Cookie"
  },
  "reach-public-tools.enter_a_stock_symbol_or_search_term": {
    "en": "Enter a stock symbol or search term",
    "zh-CN": "请输入股票代码或搜索词"
  },
  "reach-public-tools.invalid_stock_symbol_format": {
    "en": "Invalid stock symbol format",
    "zh-CN": "股票代码格式无效"
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
  "speech-generation.gemini_speech_api_returned_no_valid_audio_data": {
    "en": "Gemini speech API returned no valid audio data",
    "zh-CN": "Gemini 语音接口未返回有效音频数据"
  },
  "speech-generation.gemini_speech_api_returned_an_unsupported_audio_format": {
    "en": "Gemini speech API returned an unsupported audio format: {p0}",
    "zh-CN": "Gemini 语音接口返回了未接入的音频格式：{p0}"
  },
  "speech-generation.audio_returned_by_the_gemini_speech_api_has_no": {
    "en": "Audio returned by the Gemini speech API has no WAV header",
    "zh-CN": "Gemini 语音接口返回的音频缺少 WAV 文件头"
  },
  "speech-generation.speech_generation_requires_text_to_read_aloud": {
    "en": "Speech generation requires text to read aloud",
    "zh-CN": "语音生成缺少待朗读文本"
  },
  "speech-generation.the_current_api_format_does_not_support_speech_generation": {
    "en": "The current API format does not support speech generation",
    "zh-CN": "当前 API 格式尚未接入语音生成接口"
  },
  "speech-generation.speech_generation_requires_a_voice_in_the_model_parameters": {
    "en": "Speech generation requires a voice in the model parameters",
    "zh-CN": "语音生成需要在模型参数中填写 voice"
  },
  "speech-generation.the_speech_generation_model_has_no_api_url": {
    "en": "The speech generation model has no API URL",
    "zh-CN": "语音生成模型缺少 API 地址"
  },
  "speech-generation.gemini_speech_api_http": {
    "en": "Gemini speech API HTTP {p0}: {p1}",
    "zh-CN": "Gemini 语音接口 HTTP {p0}: {p1}"
  },
  "speech-generation.speech_generation_api_http": {
    "en": "Speech generation API HTTP {p0}: {p1}",
    "zh-CN": "语音生成接口 HTTP {p0}: {p1}"
  },
  "speech-generation.speech_generation_api_returned_no_audio": {
    "en": "Speech generation API returned no audio: {p0}",
    "zh-CN": "语音生成接口未返回音频：{p0}"
  },
  "speech-generation.speech_generation_api_returned_no_audio_data": {
    "en": "Speech generation API returned no audio data",
    "zh-CN": "语音生成接口没有返回音频数据"
  },
  "speech-generation.speech_generation_api_returned_an_unsupported_audio_format": {
    "en": "Speech generation API returned an unsupported audio format: {p0}",
    "zh-CN": "语音生成接口返回了不支持的音频格式：{p0}"
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
  "video-download.the_video_url_must_use_http_or_https": {
    "en": "The video URL must use HTTP or HTTPS",
    "zh-CN": "视频地址必须是 HTTP 或 HTTPS 链接"
  },
  "video-download.yt_dlp_was_not_found_cannot_download_the_video": {
    "en": "yt-dlp was not found; cannot download the video",
    "zh-CN": "未找到 yt-dlp，无法下载视频"
  },
  "video-download.audio_download_requires_ffmpeg_to_create_a_standard_mp3": {
    "en": "Audio download requires FFmpeg to create a standard MP3 file",
    "zh-CN": "音频下载需要 FFmpeg 来生成通用 MP3 文件"
  },
  "video-download.yt_dlp_returned_no_downloaded_file_path": {
    "en": "yt-dlp returned no downloaded file path",
    "zh-CN": "yt-dlp 未返回下载文件路径"
  },
  "video-download.yt_dlp_did_not_create_a_video_file": {
    "en": "yt-dlp did not create a video file",
    "zh-CN": "yt-dlp 未生成视频文件"
  },
  "video-download.could_not_identify_the_downloaded_format": {
    "en": "Could not identify the downloaded {p0} format: {p1}",
    "zh-CN": "无法识别下载的{p0}格式：{p1}"
  },
  "video-download.no_extension": {
    "en": "no extension",
    "zh-CN": "无扩展名"
  },
  "video-download.ffmpeg_was_not_found_cannot_extract_audio_from_the": {
    "en": "FFmpeg was not found; cannot extract audio from the video",
    "zh-CN": "未找到 FFmpeg，无法从视频中提取音频"
  },
  "video-download.the_video_file_no_longer_exists_cannot_extract_audio": {
    "en": "The video file no longer exists; cannot extract audio",
    "zh-CN": "视频文件已不存在，无法提取音频"
  },
  "video-download.ffmpeg_did_not_create_an_audio_file": {
    "en": "FFmpeg did not create an audio file",
    "zh-CN": "FFmpeg 未生成音频文件"
  },
  "video-frames.the_video_file_no_longer_exists_cannot_read_frames": {
    "en": "The video file no longer exists; cannot read frames",
    "zh-CN": "视频文件已不存在，无法读取画面"
  },
  "video-frames.video_understanding_outside_gemini_requires_ffmpeg_to_read_frames": {
    "en": "Video understanding outside Gemini requires FFmpeg to read frames",
    "zh-CN": "非 Gemini 视频理解需要 FFmpeg 来读取画面"
  },
  "video-frames.ffmpeg_could_not_read_the_video_file": {
    "en": "FFmpeg could not read the video file: {p0}",
    "zh-CN": "FFmpeg 无法读取视频文件：{p0}"
  },
  "video-frames.unknown_error": {
    "en": "unknown error",
    "zh-CN": "未知错误"
  },
  "video-frames.video_understanding_outside_gemini_requires_ffmpeg_to_extract_frames": {
    "en": "Video understanding outside Gemini requires FFmpeg to extract frames",
    "zh-CN": "非 Gemini 视频理解需要 FFmpeg 来提取画面帧"
  },
  "video-frames.provide_non_negative_video_timestamps_in_seconds": {
    "en": "Provide non-negative video timestamps in seconds",
    "zh-CN": "请提供要读取的非负视频时间点（秒）"
  },
  "video-frames.no_readable_video_frame_at_seconds": {
    "en": "No readable video frame at {p0} seconds",
    "zh-CN": "视频在 {p0} 秒处没有可读取的画面"
  },
  "video-generation.video_generation_api_http": {
    "en": "Video generation API HTTP {p0}: {p1}",
    "zh-CN": "视频生成接口 HTTP {p0}: {p1}"
  },
  "video-generation.invalid_video_generation_api_response_format": {
    "en": "Invalid video generation API response format",
    "zh-CN": "视频生成接口返回格式无效"
  },
  "video-generation.video_generation_requires_a_prompt": {
    "en": "Video generation requires a prompt",
    "zh-CN": "视频生成缺少提示词"
  },
  "video-generation.google_veo_video_generation_requires_the_google_api_format": {
    "en": "Google Veo video generation requires the Google API format",
    "zh-CN": "Google Veo 视频接口需要 Google API 格式"
  },
  "video-generation.select_a_video_generation_api_format_for_the_video": {
    "en": "Select a video generation API format for the video output model",
    "zh-CN": "视频输出模型需要选择视频生成接口格式"
  },
  "video-generation.the_video_generation_model_has_no_api_url": {
    "en": "The video generation model has no API URL",
    "zh-CN": "视频生成模型缺少 API 地址"
  },
  "video-generation.video_generation_api_returned_no_task_id": {
    "en": "Video generation API returned no task ID",
    "zh-CN": "视频生成接口未返回任务 ID"
  },
  "video-generation.video_generation_failed": {
    "en": "Video generation failed: {p0}",
    "zh-CN": "视频生成失败：{p0}"
  },
  "video-generation.video_generation_completed_but_the_api_returned_no_video": {
    "en": "Video generation completed but the API returned no video URL",
    "zh-CN": "视频生成完成但接口未返回视频 URL"
  },
  "video-generation.video_generation_api_returned_an_unsupported_download_url": {
    "en": "Video generation API returned an unsupported download URL",
    "zh-CN": "视频生成接口返回了不支持的下载地址"
  },
  "video-generation.generated_video_download_failed_http": {
    "en": "Generated video download failed HTTP {p0}: {p1}",
    "zh-CN": "生成视频下载失败 HTTP {p0}: {p1}"
  },
  "video-generation.video_generation_api_returned_no_video_file": {
    "en": "Video generation API returned no video file",
    "zh-CN": "视频生成接口未返回视频文件"
  },
  "video-generation.video_generation_api_returned_no_video_file_details_1": {
    "en": "Video generation API returned no video file: {p0}",
    "zh-CN": "视频生成接口未返回视频文件：{p0}"
  },
  "video-generation.could_not_identify_the_generated_video_format": {
    "en": "Could not identify the generated video format: {p0}",
    "zh-CN": "无法识别生成视频的格式：{p0}"
  },
  "video-generation.content_type_not_provided": {
    "en": "Content-Type not provided",
    "zh-CN": "未提供 Content-Type"
  }
} as const;
