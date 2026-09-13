import type * as vscode from "vscode";
import type {
  AnyEventMessage,
  EventPayloads,
  EventType,
  RequestMessage,
  ResponseMessage,
} from "../../shared/protocol";

export type CommandHandler = (
  params: Record<string, unknown>,
) => Promise<unknown>;

export class MessageRouter {
  private webviews = new Set<vscode.Webview>();
  private handlers = new Map<string, CommandHandler>();
  private broadcastListeners = new Set<(msg: AnyEventMessage) => void>();

  /** 注册一个命令处理器 */
  handle(command: string, handler: CommandHandler): void {
    this.handlers.set(command, handler);
  }

  /**
   * 订阅"广播了一个事件"这件事本身（不关心具体是哪个 webview 收到的）。
   * 用于跟某个具体 webview 无关、但需要感知"git 状态可能变了"的场景，
   * 比如活动栏角标——不需要给 MessageRouter 加任何跟角标相关的知识，
   * 它只负责在有广播发生时通知订阅者。
   */
  onBroadcast(listener: (msg: AnyEventMessage) => void): vscode.Disposable {
    this.broadcastListeners.add(listener);
    return {
      dispose: () => {
        this.broadcastListeners.delete(listener);
      },
    };
  }

  /** 注册一个 webview，使其能接收事件、处理请求 */
  registerWebview(webview: vscode.Webview): vscode.Disposable {
    this.webviews.add(webview);

    const messageDisposable = webview.onDidReceiveMessage(
      (msg: RequestMessage) => this.handleRequest(webview, msg),
    );

    return {
      dispose: () => {
        this.webviews.delete(webview);
        messageDisposable.dispose();
      },
    };
  }

  /** 向所有已注册的 webview 广播一个事件 */
  broadcastEvent<E extends EventType>(event: E, data: EventPayloads[E]): void {
    const msg = { type: "event", event, data } as AnyEventMessage;
    for (const webview of this.webviews) {
      webview.postMessage(msg);
    }
    for (const listener of this.broadcastListeners) {
      listener(msg);
    }
  }

  private async handleRequest(
    webview: vscode.Webview,
    msg: RequestMessage,
  ): Promise<void> {
    if (msg.type !== "request") {
      return;
    }

    const handler = this.handlers.get(msg.command);
    if (!handler) {
      this.sendResponse(webview, msg.id, false, undefined, {
        message: `Unknown command: ${msg.command}`,
      });
      return;
    }

    try {
      const data = await handler(msg.params);
      this.sendResponse(webview, msg.id, true, data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendResponse(webview, msg.id, false, undefined, { message });
    }
  }

  private sendResponse(
    webview: vscode.Webview,
    id: string,
    success: boolean,
    data?: unknown,
    error?: { message: string },
  ): void {
    const response: ResponseMessage = {
      type: "response",
      id,
      success,
      data,
      error,
    };
    webview.postMessage(response);
  }
}
