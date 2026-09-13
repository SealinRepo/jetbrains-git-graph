import * as vscode from "vscode";
import type { MessageRouter } from "../messages/messageRouter";
import type { GitStateSink } from "../state/domains";
import { getWebviewHtml } from "./html";

export class CommitViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "git-brains.commitPanel";

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly messageRouter: MessageRouter,
    private readonly notifier: GitStateSink,
  ) {}

  /** 在活动栏图标上显示/更新改动数量角标，count 为 0 时隐藏角标。 */
  setBadge(count: number): void {
    if (!this.view) return;
    this.view.badge =
      count > 0
        ? {
            value: count,
            tooltip: `${count} changed file${count === 1 ? "" : "s"}`,
          }
        : undefined;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    const webview = webviewView.webview;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };

    webview.html = getWebviewHtml(webview, this.extensionUri, "commit");

    const routerDisposable = this.messageRouter.registerWebview(webview);
    webviewView.onDidDispose(() => {
      routerDisposable.dispose();
      if (this.view === webviewView) this.view = undefined;
    });

    // 首次打开：延迟一段时间后聚焦到 git log 面板
    setTimeout(() => {
      if (webviewView.visible) {
        void vscode.commands.executeCommand("git-brains.gitLog.focus");
        // 面板刚打开，不知道离开期间变了什么，全域刷新
        this.notifier.notifyAll();
      }
    }, 200);

    // Commit 面板变为可见时，同步显示 Git Log 面板并刷新两者
    // 隐藏时（再次点击收起）也把 Git Log 面板一起隐藏
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        // 稍微延迟一下，确保面板都准备好了
        setTimeout(() => {
          void vscode.commands.executeCommand("git-brains.gitLog.focus");
          // 面板重新可见，不知道隐藏期间变了什么，全域刷新
          this.notifier.notifyAll();
        }, 100);
      } else {
        void vscode.commands.executeCommand("workbench.action.closePanel");
      }
    });
  }
}
