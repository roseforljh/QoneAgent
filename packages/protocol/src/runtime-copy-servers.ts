/** SSH server copy: setup, connection and server tools. */
export const runtimeCopyServers = {
  "servers.not_found": { "en": "This server no longer exists", "zh-CN": "这台服务器已被删除" },
  "servers.host_key_changed": { "en": "The host key of {p0} changed. Confirm it in Settings > Servers before connecting again.", "zh-CN": "{p0} 的主机密钥变了，请先到设置里的「服务器」确认后再连接。" },
  "servers.auth_failed": { "en": "Sign-in failed: check the user name and password or key", "zh-CN": "登录失败：请检查用户名和密码或密钥" },
  "servers.connect_failed": { "en": "Cannot connect to {p0}: {p1}", "zh-CN": "连不上 {p0}：{p1}" },
  "servers.key_install_failed": { "en": "Could not install the Qone key on the server: {p0}", "zh-CN": "无法在服务器上安装 Qone 专用密钥：{p0}" },
  "servers.key_verify_failed": { "en": "The Qone key was installed but sign-in with it failed: {p0}", "zh-CN": "专用密钥已安装，但用它登录失败：{p0}" },
  "servers.key_remove_failed": { "en": "Could not revoke the dedicated server key. The server and local key were kept so you can retry: {p0}", "zh-CN": "未能撤销服务器上的专用公钥，已保留服务器记录和本地私钥，修复连接后可重试：{p0}" },
  "servers.terminal_missing": { "en": "This terminal is closed; open a new one", "zh-CN": "这个终端已关闭，请重新打开" },
  "servers.choose": { "en": "Choose a server: {p0}", "zh-CN": "请指定服务器：{p0}" },
  "servers.file_too_large": { "en": "The file is too large to edit in place; use server_exec", "zh-CN": "文件太大，不能直接编辑，请用 server_exec" },
  "servers.edit_not_unique": { "en": "oldText must appear exactly once: {p0}", "zh-CN": "oldText 必须在文件中恰好出现一次：{p0}" },
  "servers.edit_overlap": { "en": "Edits must not overlap", "zh-CN": "多处替换不能重叠" },
} as const;
