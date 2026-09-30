# Codex 26.928 右侧面板与终端/浏览器生命周期静态分析报告

分析目标：`C:\Program Files\WindowsApps\OpenAI.Codex_26.928.1915.0_x64__2p2nqsd0c76g0\app\resources\app.asar`  
临时分析提取目录：`C:\Users\33039\AppData\Local\Temp\codex_reverse`  
提取审查的核心文件与大小：
- `.vite/build/main-BGDKyzfM.js` (3,707,231 bytes)
- `webview/assets/app-initial-7e7a15e7e995.js` (11,140,102 bytes)
- `webview/assets/app-shared-6472dfc83b38.js` (7,712,976 bytes)
- `webview/assets/app-primary-ce6eb321deed.js` (2,300,105 bytes)
- `webview/assets/runtime-84440ffcd7c8.js` (8,783 bytes)
- `webview/assets/terminal-panel-f2067a4b2cfd.js` (16,058 bytes)
- `webview/assets/terminal-tab-5a51c39be4d1.js` (16,528 bytes)
- `webview/assets/local-conversation-page-dd457e5f2050.js` (55,872 bytes)

---

## 1. 架构事实一：ThreadScope 与面板开关默认状态

### 1.1 作用域定义
在 `webview/assets/app-shared-6472dfc83b38.js`（字符偏移 `3565468`）：
```javascript
nY = wit("ThreadScope", {
  key: e => e.clientThreadId,
  parent: Q,
  retain: { max: 20 }
})
```
`nY` 即 `ThreadScope`（在 `app-initial` 中作为 `Cu` 导入），所有属于当前会话的标签与面板状态均在此作用域下生命周期隔离，最多保留 20 个会话的活跃作用域缓存。

### 1.2 右侧栏控制器与默认开关状态
在 `webview/assets/app-initial-7e7a15e7e995.js`：
- 字符偏移 `1338124`：
  ```javascript
  cC = hFt({
    panelId: "right",
    getPanelOpenSignal: () => FS,
    singleTab: !1,
    setPanelOpen: (e, t) => xS(e, t, { animate: !t && e.get(Qx) != null ? !1 : void 0 })
  })
  ```
- 字符偏移 `1308324`：
  ```javascript
  FS = Kp(Cu, !1); // 右侧栏开关信号，Scoped 到 Cu (ThreadScope)，初始值为 false
  MS = Kp(Cu, !1); // 底栏开关信号，Scoped 到 Cu (ThreadScope)，初始值为 false
  ```
- 字符偏移 `1316333`（`hFt` 控制器定义内部）：
  `i = Kp(Cu, [])`（当前会话的 `tabIds$` 列表，默认空数组）；  
  `o = u(Cu, e => null)`（当前会话的 `tabById$` 表）；  
  `m = Kp(Cu, null)`（当前会话激活的 `activeTabId$`）。

**结论**：在 Codex 原始架构中，右侧栏开关 `FS` 与标签集合严格属于当前 `ThreadScope`。任何新打开的会话，其 `FS` 初始值均为 `false`，标签列表初始为空，绝不会继承上一个会话的打开状态。

---

## 2. 架构事实二：普通会话切换与 Checkpoint 恢复生命周期

### 2.1 路由监听与会话恢复挂载
在 `webview/assets/app-primary-ce6eb321deed.js`（字符偏移 `1514503`），普通会话切换时驱动 `gdt` 组件重挂载：
```javascript
function gdt(e) {
  let { conversationId: n } = e,
      r = A(Fh); // RouteScope
  let [a] = useState(i),
      o = J(nn, n);
  useLayoutEffect(() => {
    if (o) return wpe(r, n, a); // wpe 即 app-initial 导出的 JF (内部符号 nKo)
  }, [n, o, r, a]);
  return null;
}
```

### 2.2 恢复守卫与异步竞态防护
在 `webview/assets/app-initial-7e7a15e7e995.js`（字符偏移 `7795920`），`nKo` 实现了完善的代数与断开守卫：
```javascript
function nKo(e, t, n = e.get(eS)) {
  let r = !1,
      i = Symbol();
  e.set(VCn, i);
  let a = () => r || e.get(VCn) !== i, // 断开与跨会话切换代数守卫
      o = () => void 0,
      s = pm(e),
      c = e.get(FA, t),                // 从 FA 获取该会话持久化的 ThreadTabRoute Checkpoint
      l = PA(c);
  (c == null || l != null) && (l = THo(t, l));
  let u = WGo(t, {
    scope: e,
    isDisconnected: a,
    ready: (async () => {
      if (e.get(IA) !== t && l != null)
        try {
          if (await iKo(e, l, a, { selectionVersion: n, onlyMissingTabs: e.get(HGo) && !e.get(H4) }), a())
            return !1;
        } catch (e) {
          return Bg.error("Failed to restore persisted tab routes", { safe: {}, sensitive: { error: e } }), !1;
        }
      return !a() && (
        e.set(IA, t),
        e.set(UCn, !1),
        e.set(H4, !0),
        o = uKo(e, { browserConversationId: s, checkpoint: l, conversationId: t, initiallySuppressPersistence: c != null && l == null, isDisconnected: a }),
        !0
      );
    })()
  });
  return () => { r = !0, u(), o(); }; // cleanup: 立即将 r 标记为 true，丢弃已过期的异步恢复
}
```

### 2.3 布局与打开状态恢复
在字符偏移 `7798606`（`sKo` 函数）：
```javascript
function sKo(e, t) {
  let n = cKo(e, cC, t.topology.right.tabIds),
      r = cKo(e, lC, t.topology.bottom.tabIds);
  if (e.get(UCn)) return;
  cC.activateTab(e, lKo(e, cC, n, t.topology.right.activeTabId));
  lC.activateTab(e, lKo(e, lC, r, t.topology.bottom.activeTabId));
  let i = n.length > 0,
      a = r.length > 0;
  xS(e, t.topology.right.open && i, { animate: !1 }); // 严格依赖本会话 checkpoint 中记录的 open 状态且存在 tabs
  yS(e, t.topology.bottom.open && a, { animate: !1 });
}
```
**结论**：在普通会话切换时，若目标会话未曾打开过右侧栏（`checkpoint` 为空或记录为关闭），右侧栏坚决保持关闭；若在恢复中途迅速切走，`a()`（`isDisconnected`）立即生效，异步恢复被丢弃，绝不会污染新会话。

---

## 3. 架构事实三：显式 Fork / Worktree 派生的 Tab 复制机制

在 `webview/assets/app-initial-7e7a15e7e995.js`（字符偏移 `5628769`）：
Codex 提供了明确的会话派生流程（`forkConversationIntoWorktree` / `MDn` / `Dma`），用于在当前任务基础上分裂出独立分支或新建 Worktree：
1. `Dma` 通过 `jma(e, sourceConversationId)` 抓取源会话当前已展开的右侧栏标签和拓扑。
2. 在目标会话初始化时，`Ima` 调用 `Lma`（字符偏移 `5580824`）：
   ```javascript
   function Lma(e, t, n) {
     if (e.kind === "terminal") {
       let e = use.createSessionId(); // 显式 fork 时为目标会话分配全新 terminalSessionId
       return { tabId: mra(e), terminalSessionId: e };
     }
     ...
   }
   ```
3. 随后在 `local-conversation-page-dd457e5f2050.js` 的 `xs` 组件触发 `Ama` -> `Bma` -> `Hma`，通过 `Pe` (`seedSessionForConversation`) 在新会话中预置标签，并通过 `xS(e, t.rightPanelOpen && n)` 恢复布局。

**关键界定**：这是 Codex 在**用户显式执行 Fork / 分支任务工作流**时的特化逻辑（旨在继承工作上下文的同时隔离物理终端进程，防止两个会话向同一个 PTY 写入混乱），**普通左侧会话列表切换绝不走此路径**。

---

## 4. 架构事实四：Terminal 前端 Renderer 释放 vs 主进程 PTY Close

### 4.1 前端组件卸载：具名 Session 绝不调用 Close
在 `webview/assets/terminal-panel-f2067a4b2cfd.js` 的 `Ee` 组件（字符偏移 `13753`）：
```javascript
return () => {
  f = !0;
  b != null && (cancelAnimationFrame(b), b = null);
  x != null && clearTimeout(x);
  N.disconnect();
  e.removeEventListener("input", w, !0);
  e.removeEventListener("paste", w, !0);
  j.dispose();
  M.dispose();
  d && a.preserveAlternateScreen(o, y.buffer.active.type === "alternate" || v.isRestoringAlternateScreen);
  ne(); // 注销 register 监听
  O();
  v.onOutput = null;
  a.releaseRenderer(o, v); // 仅销毁 Xterm.js 渲染器，释放 DOM
  me.current = null;
  he.current = null;
  L.current = !1;
  d || a.close(o); // ！！！具名终端（存在 d 即 sessionId）绝不调用 close！只有无 sessionId 的临时会话才 close
  I.current = null;
};
```

### 4.2 releaseRenderer 的实际行为
在 `webview/assets/app-shared-6472dfc83b38.js`（字符偏移 `3057860` 附近）：
```javascript
releaseRenderer(e, t) {
  if (this.renderers.get(e) === t) {
    let n = t.getRenderedOutput();
    this.sessionSnapshots.has(e) && n != null && this.lastRenderedOutputBySessionId.set(e, n);
    this.renderers.delete(e);
  }
  t.dispose(); // 只销毁 xterm Terminal 实例与 Canvas
}
```
此时后端的 node-pty 进程完全不受影响，内存中的 `sessionSnapshots`（包含终端历史输出 ring buffer）持续保留。切回原会话时，前端直接复用已有的 `sessionId`（`a.isSessionStarted(d)` 为 `true`），通过 `a.getOrCreateRenderer` 挂载新 Xterm 实例并回放 buffer，无需重新 spawn。

### 4.3 Be 函数的作用域保护
在 `webview/assets/runtime-84440ffcd7c8.js`（字符偏移 `6416`）：
```javascript
function Be(e, t, n) {
  let r = C(n),        // 当前 ThreadScope 对应的 panelController (cC 或 lC)
      i = new Set(t),  // 当前会话允许存在的有效 sessionIds
      a = !1;
  for (let t of e.get(r.tabs$)) {
    let n = G(t.tabId);
    n != null && !i.has(n) && !J.has(n) && !ve(e, r, t.tabId) && (
      e.set(P, n, null),
      r.closeTab(e, t.tabId, { recordCloseUndo: !1 }),
      a = !0
    );
  }
  a && e.get(r.tabs$).length === 0 && w(e, n);
}
```
`Be` 严格在当前会话的 `ThreadScope` 下核对属于该会话自身的 tabs，被用户显式关闭或彻底移出会话的 tab 才会清理，不会跨会话误杀其他会话的活跃终端。

---

## 5. 架构事实五：主进程 TerminalManager 的会话守护与 PendingCreates Abort

在 `.vite/build/main-BGDKyzfM.js` 的 `FGe` 类：
- 字符偏移 `3072715`：类定义 `var FGe = class { ... sessions = new Map; pendingCreates = new Map; ... }`
- 字符偏移 `3072974`（PendingCreates Abort 控制）：
  ```javascript
  let i = `${e.id}:${n}`, a = new AbortController;
  this.pendingCreates.get(i)?.abort(); // 创建前若发现同一会话有未决创建，立即 abort
  this.pendingCreates.set(i, a);
  ```
  在快速切换或重复触发创建时，未决的创建请求会被主动取消，避免多进程孤儿泄漏。
- 字符偏移 `3073955`（会话复用逻辑）：
  ```javascript
  getExistingSessionId(e) {
    if (e.sessionId && this.sessions.has(e.sessionId)) return e.sessionId;
    if (e.allowConversationSessionFallback && e.conversationId) {
      let t = this.sessionsByWindowConversation.get(a5(e.ownerId, String(e.conversationId)));
      if (t) return t;
    }
  }
  ```
  只要具名 `sessionId` 依然在主进程持有列表中，它就不会被重新创建，直接复用既有 PTY。

---

## 6. 架构事实六：Browser Tab 生命周期隔离

在 `webview/assets/app-initial-7e7a15e7e995.js`（字符偏移 `3765502`）：
```javascript
uH = new NJr; // 全局 BrowserTab 调度单例
```
- 所有浏览器页面状态、快照与设备工具栏状态均以 `${conversationId}\0${browserTabId}` 作为严格命名空间隔离。
- 只有在显式关闭会话或会话被完全移除时，才调用 `removeConversationTabs(conversationId)`，批量清理该会话命名空间下的所有 key。普通路由切换不会销毁其他会话的浏览器标签页状态。

---

## 7. Qone 对照诊断与根修指引

用户反馈的故障现象：
> 打开终端 -> 切换到无关会话 -> 右侧栏依旧打开且成为新终端 -> 切回原会话终端重置

**已证实非 Codex 架构行为**，而是 Qone 自身前端架构在实现右侧栏与终端时存在的重大漏洞。

### 7.1 现状审查与辨析
实际经代码审查，Qone 的 `openTabs` 与 `activeTabId` 在 `workspace-dock.tsx` 中为组件级 local state（`const [openTabs, setOpenTabs] = useState<DockTab[]>([])`），并非未经实测便断言的全局状态提升。

造成会话切换异常的真实原因在于：
1. 单实例 Dock 挂载在主应用视图中，未根据 `currentSessionId` 进行会话级状态隔离与实例解耦。
2. 切换会话时，若重新挂载 Dock 会导致 local state 丢失，导致原本处于某一子路径的终端重新开出；若未切换 Dock 实例，则上一会话的 local tabs 与激活态会在新会话中悬挂残留。
3. 终端与浏览器的后端常驻/保活机制未与视图层的挂载/卸载彻底解耦。

### 7.2 架构对照表

| 维度 | Codex 正确实现 | Qone 现状与对齐目标 |
| :--- | :--- | :--- |
| **右侧栏与 Tab 状态** | `FS = Kp(Cu, !1)` 绑定到 `ThreadScope`，标签集合按会话隔离，新会话默认关闭 | 每个会话独立 `WorkspaceDock`，其本地标签状态不会串到其他会话 |
| **会话切换 Tab 保持** | 保持会话生命周期，组件 unmount 不销毁后端进程 | 改造为保持已有 Tab 组件持续 mounted，非活跃会话时仅置 `active = false` |
| **终端/Browser 进程生命周期** | `d || a.close(o)` 具名终端不关闭；PTY 进程与 Browser webview 后台常驻 | 必须与 React 组件 unmount 完全解耦，仅在显式关闭 Tab 时销毁底层进程 |
| **前端渲染器释放与重连** | 切走仅销毁前端渲染器（releaseRenderer），切回直接 attach 现有 session 并回放 buffer | Native webview 在 `active = false` 时调用 `browser_visible(false)` 隐藏，切回时置 `visible(true)` |
| **工作目录 CWD** | 具名终端保持原进程，shell 内部的 `cd` 路径随进程一直存活 | 保持 PTY 后台常驻，避免重新 spawn 导致子目录路径跌回根路径 |

### 7.3 Qone 根修与集成准则
1. **按会话隔离 Dock（Session-Scoped Dock）**：通过 `ScopedWorkspaceDocks` 为每个有标签的会话保留独立 `WorkspaceDock` 实例。当前会话无标签时右侧栏默认关闭；终端/浏览器在普通会话切换时保持 mounted，只把非活跃会话置为不可见。
2. **Native 串行安全与按需激活**：保持全局 `nativeQueue` 串行执行，确保 Tauri child list 操作安全；未激活打开的后台 Tab 绝不创建 native webview。
3. **Await Race 彻底消除**：在 `browser_bounds` 或 `browser_visible` 等待期间发生隐藏时，必须通过循环收敛将最终状态 flush 到 `visible: false`，绝不残留可见 native 层。
4. **请求路由携带会话**：`BrowserDockRequest` 支持可选 `sessionId`，为上层 caller 精准路由到目标会话 Dock 奠定基础，同时保持无全局 store 循环依赖。

---

## 8. 本次补齐与审查结果

静态核对版本：`app.asar` SHA-256 `86729CD40329FE33B668E0C76BDD405B93EA50DC8A1D30B939524D5DFA783E06`。重新读取提取的 `app-shared` 字符偏移 `3565468`、`app-initial` 偏移 `1308324` 与 `7798606`、`terminal-panel` 偏移 `13753`，分别核实 `ThreadScope` 键、右栏默认关闭、checkpoint 恢复必须有标签、具名终端卸载不 close。以上是 Codex 静态证据，不是 Qone 的运行验收。

| 审查点 | Qone 原因或风险 | 本次处理 |
|---|---|---|
| 会话切换与开关 | 单个 `WorkspaceDock` 的 `openTabs`、`activeTabId`、`collapsed` 属于同一组件，跨会话沿用 | 一个会话一个 Dock 实例；无标签会话保持关闭；空的非活跃实例清理 |
| 终端 CWD 与进程 | 旧实现组件卸载即 `terminal_kill`，切回会从工作区根目录重新 spawn | 复用已存在的 `dock-terminal-resource`，普通切换保持组件和 PTY；显式关闭标签、删除会话时才销毁 |
| 浏览器 WebView2 | 异步显示可能在切换后覆盖新会话 | 每会话保留浏览器标签，非活跃时 `active=false`；Markdown 链接与代码预览携带当前会话 ID，native 队列与隐藏收敛测试通过 |
| 文件树与 Git | 视图读取全局 `workspaceFiles` / `gitDiffView`，同一工作区不同标签会互相覆盖 | 接入已有的 `workspace-view-state`，用标签 ID 隔离选择、内容和请求代数；刷新仅影响当前标签 |
| 关闭与迟到回包 | 标签关闭后旧响应可能命中新建的同 ID 视图，或错误落入全局状态 | 关闭时提升 owner epoch；未决请求保留 owner 身份直至响应/错误，届时再清理 |
| 草稿会话 | 同工作区新草稿若共用 key，可能继承旧草稿右栏 | 新草稿分配新的 `draftDockId`，离开草稿后清理其 Dock |

Qone 与 Codex 的实现差异：Codex 在切换时释放前端终端 renderer、保留命名 PTY；Qone 保留非活跃终端的 Xterm 实例与 DOM，以原样保留滚动内容并避免重新创建。两者都不会因普通会话切换重启 PTY。Qone 的面板与标签目前只在当前应用运行期保留；没有实现 Codex 的持久化 `ThreadTabRoute` checkpoint，因此重启应用后不会恢复标签。该差异不影响本次会话切换故障的根修，但仍需独立设计持久化格式与恢复守卫。

验证：`bunx tsc --noEmit -p apps/desktop/tsconfig.json` 通过；`bun test` 针对 Dock 作用域、浏览器、终端、工作区视图与布局的 33 个测试通过。按项目约束未启动浏览器、Tauri 开发窗口或安装包构建。
