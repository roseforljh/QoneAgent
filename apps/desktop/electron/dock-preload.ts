// 内置浏览器网页的预加载脚本（沙箱、隔离上下文）。只做一件事：拦下通行密钥。
// 内置浏览器里通行密钥既弹不出系统窗口（main.ts 已关原生接口），AI 也完成不了；
// 不拦的话请求会一直挂着，页面和 AI 都干等。这里让请求立刻失败，并告诉主进程「页面要求登录」。
import { contextBridge, ipcRenderer } from "electron";

contextBridge.executeInMainWorld({
  // 在页面主世界、页面脚本之前执行；函数会被序列化，不能引用外部变量。
  func: (reportPasskeyRequest: () => void) => {
    const credentials = navigator.credentials;
    if (!credentials) return;
    for (const name of ["get", "create"] as const) {
      const original = credentials[name].bind(credentials);
      Object.defineProperty(credentials, name, {
        configurable: true,
        value: (options?: CredentialRequestOptions & CredentialCreationOptions) => {
          if (!options?.publicKey) return original(options);
          // 条件式请求是页面加载时静默挂起的自动填充，不代表要登录，只拒绝不上报。
          if (options.mediation !== "conditional") reportPasskeyRequest();
          return Promise.reject(new DOMException("Passkeys are not available in this browser.", "NotAllowedError"));
        },
      });
    }
    // 让网站直接走账号密码等其他登录方式，不再发起自动填充式的通行密钥请求。
    if (typeof PublicKeyCredential !== "undefined") {
      PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
      PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
    }
  },
  args: [() => ipcRenderer.send("dock:passkey-request")],
});
