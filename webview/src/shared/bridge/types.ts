import type { AnyEventMessage, CommandType } from "../../../../shared/protocol";

export type {
  AnyEventMessage,
  CommandType,
  EventMessage,
  Message,
  RequestMessage,
  ResponseMessage,
} from "../../../../shared/protocol";

export interface Bridge {
  request(
    command: CommandType | string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<unknown>;
  /**
   * 订阅主机广播的事件。handler 拿到的是判别联合：按 `msg.event` 判断之后，
   * `data` 会自动收窄到该事件的 payload 类型，不需要再 `as`。
   */
  onEvent(handler: (msg: AnyEventMessage) => void): () => void;
}
