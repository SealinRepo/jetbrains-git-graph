import type {
  AnyEventMessage,
  Bridge,
  CommandType,
  RequestMessage,
  ResponseMessage,
} from "./types";

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export function createVSCodeBridge(): Bridge {
  const vscode = acquireVsCodeApi();
  const pendingRequests = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  const eventHandlers = new Set<(msg: AnyEventMessage) => void>();

  window.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data;
    if (msg.type === "response") {
      const resp = msg as ResponseMessage;
      const pending = pendingRequests.get(resp.id);
      if (pending) {
        pendingRequests.delete(resp.id);
        if (resp.success) {
          pending.resolve(resp.data);
        } else {
          pending.reject(new Error(resp.error?.message ?? "Unknown error"));
        }
      }
    } else if (msg.type === "event") {
      const evt = msg as AnyEventMessage;
      for (const h of eventHandlers) {
        h(evt);
      }
    }
  });

  return {
    request(command, params = {}, opts) {
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const timeout = setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error(`Request '${command}' timed out`));
        }, timeoutMs);

        pendingRequests.set(id, {
          resolve: (v) => {
            clearTimeout(timeout);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timeout);
            reject(e);
          },
        });

        const msg: RequestMessage = {
          type: "request",
          id,
          command: command as CommandType,
          params,
        };
        vscode.postMessage(msg);
      });
    },
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => {
        eventHandlers.delete(handler);
      };
    },
  };
}
