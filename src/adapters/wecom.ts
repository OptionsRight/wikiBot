import AiBot, { type WsFrame } from "@wecom/aibot-node-sdk";
export interface Inbound {
  id: string;
  botId: string;
  userId: string;
  chatType: "single" | "group";
  text: string;
  replyContext: unknown;
}
export interface WecomTransport {
  start(handler: (event: Inbound) => Promise<void>): void;
  reply(
    event: Inbound,
    stream: string,
    text: string,
    finish: boolean,
  ): Promise<void>;
  notify?(userId: string, text: string): Promise<NoticeReceipt>;
  ready?(): boolean;
  close(): void;
}
export type NoticeReceipt =
  { state: "acked" } | { state: "failed"; code: string } | { state: "unknown" };
export class WecomRejection extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
function refusal(error: unknown): WecomRejection | undefined {
  // SDK 1.0.7 rejects a server refusal with the original ACK frame.
  // Errors from timeout, disconnect or local failure prove no outcome.
  if (
    error &&
    typeof error === "object" &&
    "errcode" in error &&
    Number.isInteger(error.errcode) &&
    error.errcode !== 0 &&
    "headers" in error &&
    typeof (error.headers as { req_id?: unknown })?.req_id === "string"
  )
    return new WecomRejection(`WECOM_REJECTED_${error.errcode}`);
}
export class WecomSocket implements WecomTransport {
  private client: InstanceType<typeof AiBot.WSClient>;
  private authenticated = false;
  constructor(botId: string, secret: string, options: { wsUrl?: string } = {}) {
    this.client = new AiBot.WSClient({
      botId,
      secret,
      wsUrl: options.wsUrl,
      maxReconnectAttempts: 5,
      requestTimeout: 3000,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    this.client.on("error", () => {});
    this.client.on("authenticated", () => {
      this.authenticated = true;
    });
    this.client.on("disconnected", () => {
      this.authenticated = false;
    });
    this.client.on("reconnecting", () => {
      this.authenticated = false;
    });
    this.client.on("event.disconnected_event", () => {
      this.authenticated = false;
    });
  }
  start(handler: (event: Inbound) => Promise<void>) {
    this.client.on("message.text", (frame) => {
      const m = frame.body;
      if (!m?.msgid || !m.from?.userid || typeof m.text?.content !== "string")
        return;
      void handler({
        id: m.msgid,
        botId: m.aibotid,
        userId: m.from.userid,
        chatType: m.chattype,
        text: m.text.content,
        replyContext: frame,
      }).catch(() => {});
    });
    this.client.connect();
  }
  async reply(event: Inbound, stream: string, text: string, finish: boolean) {
    try {
      const ack = await this.client.replyStream(
        event.replyContext as WsFrame,
        stream,
        text,
        finish,
      );
      if (ack.errcode !== 0) throw new Error("WECOM_ACK_UNCONFIRMED");
    } catch (error) {
      throw refusal(error) ?? new Error("WECOM_ACK_UNCONFIRMED");
    }
  }
  ready() {
    return this.authenticated && this.client.isConnected;
  }
  async notify(userId: string, text: string): Promise<NoticeReceipt> {
    try {
      const ack = await this.client.sendMessage(userId, {
        msgtype: "markdown",
        markdown: { content: text },
      });
      return ack.errcode === 0 ? { state: "acked" } : { state: "unknown" };
    } catch (error) {
      const rejected = refusal(error);
      if (rejected) return { state: "failed", code: rejected.code };
      return { state: "unknown" };
    }
  }
  close() {
    this.authenticated = false;
    this.client.disconnect();
  }
}
