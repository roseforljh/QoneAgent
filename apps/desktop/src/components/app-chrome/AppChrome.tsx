import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, ArrowRight, PanelRight } from "lucide-react";
import { Dialog, Menubar } from "radix-ui";
import { useLocale } from "../../localization";
import { useStore } from "../../store";
import { useAppNavigation } from "./use-app-navigation";
import "./app-chrome.css";

type AppChromeProps = { path: string; children: ReactNode };

const emit = (name: string) => window.dispatchEvent(new Event(name));
const toggleDock = (view: string) => window.dispatchEvent(new CustomEvent("qone-toggle-dock-view", { detail: view }));
const isNative = () => Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

export function AppChrome({ path, children }: AppChromeProps) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const navigation = useAppNavigation(path);
  const newSession = useStore((state) => state.newSession);
  const chooseWorkspace = useStore((state) => state.chooseWorkspace);
  const [helpOpen, setHelpOpen] = useState(false);
  const native = isNative();
  const windowHandle = native ? getCurrentWindow() : null;
  const close = () => { void windowHandle?.close(); };
  const minimize = () => { void windowHandle?.minimize(); };
  const maximize = () => { void windowHandle?.toggleMaximize(); };
  const label = (chinese: string, english: string) => zh ? chinese : english;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!native || !event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        emit("qone-toggle-sidebar");
      } else if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        newSession();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [native, newSession]);

  return (
    <div className="q-app-frame">
      <header className="q-app-titlebar" aria-label={label("应用顶栏", "Application title bar")} onDoubleClick={(event) => {
        if (event.target === event.currentTarget) maximize();
      }}>
        <div className="q-app-titlebar-navigation">
          <button type="button" aria-label={label("后退", "Back")} title={label("后退", "Back")} disabled={!navigation.canGoBack} onClick={navigation.goBack}><ArrowLeft size={17} /></button>
          <button type="button" aria-label={label("前进", "Forward")} title={label("前进", "Forward")} disabled={!navigation.canGoForward} onClick={navigation.goForward}><ArrowRight size={17} /></button>
        </div>
        <Menubar.Root className="q-app-menubar" aria-label={label("应用菜单", "Application menu")}>
          <Menubar.Menu>
            <Menubar.Trigger>{label("文件", "File")}</Menubar.Trigger>
            <Menubar.Portal><Menubar.Content className="q-app-menu" align="start" sideOffset={5}>
              <Menubar.Item onSelect={newSession}>{label("新建会话", "New chat")}<span>Ctrl+N</span></Menubar.Item>
              <Menubar.Item onSelect={chooseWorkspace}>{label("导入项目", "Open project")}</Menubar.Item>
              <Menubar.Separator />
              <Menubar.Item onSelect={() => emit("qone-open-settings")}>{label("设置", "Settings")}</Menubar.Item>
              {native && <><Menubar.Separator /><Menubar.Item onSelect={close}>{label("关闭窗口", "Close window")}</Menubar.Item></>}
            </Menubar.Content></Menubar.Portal>
          </Menubar.Menu>
          <Menubar.Menu>
            <Menubar.Trigger>{label("编辑", "Edit")}</Menubar.Trigger>
            <Menubar.Portal><Menubar.Content className="q-app-menu" align="start" sideOffset={5}>
              <Menubar.Item onSelect={() => emit("qone-open-search")}>{label("搜索会话", "Search chats")}<span>Ctrl+K</span></Menubar.Item>
              <Menubar.Item onSelect={() => {
                const selected = window.getSelection()?.toString();
                if (selected) void navigator.clipboard.writeText(selected);
              }}>{label("复制选中内容", "Copy selection")}</Menubar.Item>
            </Menubar.Content></Menubar.Portal>
          </Menubar.Menu>
          <Menubar.Menu>
            <Menubar.Trigger>{label("视图", "View")}</Menubar.Trigger>
            <Menubar.Portal><Menubar.Content className="q-app-menu" align="start" sideOffset={5}>
              <Menubar.Item onSelect={() => emit("qone-toggle-sidebar")}>{label("切换侧边栏", "Toggle sidebar")}<span>Ctrl+B</span></Menubar.Item>
              <Menubar.Item onSelect={() => toggleDock("terminal")}>{label("终端", "Terminal")}</Menubar.Item>
              <Menubar.Item onSelect={() => toggleDock("git")}>{label("Git 变更", "Git changes")}</Menubar.Item>
            </Menubar.Content></Menubar.Portal>
          </Menubar.Menu>
          <Menubar.Menu>
            <Menubar.Trigger>{label("帮助", "Help")}</Menubar.Trigger>
            <Menubar.Portal><Menubar.Content className="q-app-menu" align="start" sideOffset={5}>
              <Menubar.Item onSelect={() => setHelpOpen(true)}>{label("快捷键", "Keyboard shortcuts")}</Menubar.Item>
            </Menubar.Content></Menubar.Portal>
          </Menubar.Menu>
        </Menubar.Root>
        <div className="q-app-titlebar-drag" data-tauri-drag-region onDoubleClick={maximize} />
        <button type="button" className="q-app-dock-toggle" aria-label={label("展开或收起右侧面板", "Expand or collapse right panel")} title={label("展开或收起右侧面板", "Expand or collapse right panel")} onClick={() => emit("qone-toggle-dock-panel")}><PanelRight size={16} /></button>
        {native && <div className="q-app-window-controls">
          <button type="button" aria-label={label("最小化", "Minimize")} onClick={minimize}><span aria-hidden="true" className="q-app-window-glyph q-app-window-glyph-minimize" /></button>
          <button type="button" aria-label={label("最大化或还原", "Maximize or restore")} onClick={maximize}><span aria-hidden="true" className="q-app-window-glyph q-app-window-glyph-maximize" /></button>
          <button type="button" className="q-app-window-close" aria-label={label("关闭", "Close")} onClick={close}><span aria-hidden="true" className="q-app-window-glyph q-app-window-glyph-close" /></button>
        </div>}
      </header>
      <div className="q-app-content">{children}</div>
      <Dialog.Root open={helpOpen} onOpenChange={setHelpOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="q-app-help-overlay" />
          <Dialog.Content className="q-app-help-dialog">
            <Dialog.Title>{label("快捷键", "Keyboard shortcuts")}</Dialog.Title>
            <p>Ctrl+N — {label("新建会话", "New chat")}</p>
            <p>Ctrl+K — {label("搜索会话", "Search chats")}</p>
            <p>Ctrl+B — {label("切换侧边栏", "Toggle sidebar")}</p>
            <Dialog.Close className="q-app-help-close">{label("关闭", "Close")}</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
