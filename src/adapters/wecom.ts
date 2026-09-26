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
  close(): void;
}
export class WecomSocket implements WecomTransport {
  private client: InstanceType<typeof AiBot.WSClient>;
  constructor(botId: string, secret: string) {
    this.client = new AiBot.WSClient({
      botId,
      secret,
      maxReconnectAttempts: 5,
      requestTimeout: 3000,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    this.client.on("error", () => {});
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
    const ack = await this.client.replyStream(
      event.replyContext as WsFrame,
      stream,
      text,
      finish,
    );
    if (ack.errcode !== 0) throw new Error("WECOM_ACK_UNCONFIRMED");
  }
  close() {
    this.client.disconnect();
  }
}
