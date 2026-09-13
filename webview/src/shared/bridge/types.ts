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
  ): Promise<unknown>;
  /**
   * 订阅主机广播的事件。handler 拿到的是判别联合：按 `msg.event` 判断之后，
   * `msg.data` 会自动收窄到该事件的 payload 类型。
   */
  onEvent(handler: (msg: AnyEventMessage) => void): () => void;
}
