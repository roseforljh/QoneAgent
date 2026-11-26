import { BaseWindow, WebContentsView, type BaseWindowConstructorOptions, type WebContents, type WebPreferences } from "electron";

/**
 * 主窗口：BaseWindow + 承载主界面的 WebContentsView（hubView）。
 * BrowserWindow 的主界面就是根视图，子视图只能叠在它上面；单独成视图后，内置浏览器
 * 才能在弹窗打开时沉到主界面之下，从主界面挖出的透明区域透出实时网页（见 BrowserDockManager.setUnderlay）。
 */
export class AppWindow extends BaseWindow {
  readonly hubView: WebContentsView;
  private readonly surfaceColor: string;

  constructor(options: BaseWindowConstructorOptions, webPreferences: WebPreferences) {
    super(options);
    this.surfaceColor = options.backgroundColor ?? "#1e1e1e";
    this.hubView = new WebContentsView({ webPreferences });
    this.hubView.setBackgroundColor(this.surfaceColor);
    this.contentView.addChildView(this.hubView);
    const fit = () => {
      if (this.isDestroyed()) return;
      const [width, height] = this.getContentSize();
      // Windows 最小化时读到 0x0，恢复时会再触发一次。
      if (width > 0 && height > 0) this.hubView.setBounds({ x: 0, y: 0, width, height });
    };
    fit();
    this.on("resize", fit);
    this.contentView.on("bounds-changed", fit);
    // BaseWindow 关闭不会销毁子视图的 webContents，不关会留下一个渲染进程。
    this.on("closed", () => {
      if (!this.hubView.webContents.isDestroyed()) this.hubView.webContents.close();
    });
  }

  get webContents(): WebContents {
    return this.hubView.webContents;
  }

  /** 主界面透明时，网页未绘制的区域透出下层视图；平时保持不透明，省去整窗混合。 */
  setHubTransparent(transparent: boolean): void {
    if (!this.hubView.webContents.isDestroyed()) this.hubView.setBackgroundColor(transparent ? "#00000000" : this.surfaceColor);
  }
}
