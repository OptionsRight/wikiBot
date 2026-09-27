import { access, Fault, type Store } from "./core.js";
import {
  NOTICE_TTL_MS,
  NOTICE_MAX_ATTEMPTS,
  type Notice,
} from "./governance.js";
import type { Answer } from "./answers.js";
import type { Ticket } from "./tickets.js";
import type { WecomOptions } from "./channel.js";

// Status events contain no answer body, title, comment, reason or resolution.
// The stable event ID identifies duplicates; an SDK ACK is not a read receipt.
export function startNotifications(
  store: Store,
  options: WecomOptions,
  own: () => void,
) {
  let stopping = false,
    work: Promise<void> | undefined;
  async function dispatch() {
    if (!options.transport.notify) return;
    for (const candidate of store.list<Notice>("notice", options.domain)) {
      const notice = store.get<Notice>("notice", candidate.id);
      if (stopping || !notice || notice.state !== "pending") continue;
      const update = (fields: Partial<Notice>) =>
        store.put<Notice>("notice", {
          ...notice,
          ...fields,
          version: notice.version + 1,
        });
      const waitFor = (code: string) => {
        if (notice.code !== code) update({ code });
      };
      if (Date.now() - notice.createdAt >= NOTICE_TTL_MS) {
        update({ state: "failed", code: "NOTICE_EXPIRED", retryable: false });
        continue;
      }
      let text: string;
      try {
        own();
        access(
          store,
          { subject: notice.owner, platform: false },
          notice.domain,
        );
        if (
          notice.kind === "TICKET_SUBMITTED" ||
          notice.kind === "TICKET_UPDATED"
        ) {
          const ticket = store.get<Ticket>("ticket", notice.objectId);
          if (
            !ticket ||
            ticket.domain !== notice.domain ||
            ticket.owner !== notice.owner
          ) {
            update({ state: "suppressed", code: "OBJECT_UNAVAILABLE" });
            continue;
          }
          text = `工单 ${ticket.id}${notice.ticketVersion ? `@${notice.ticketVersion}` : ""} 有更新。${notice.ticketState ? `\n事件状态：${notice.ticketState}` : ""}\n请使用 /工单 ${ticket.id} 查看当前状态。`;
        } else if (
          [
            "MODEL_REVALIDATION_REQUIRED",
            "ANSWER_INVALIDATED",
            "RELEASE_REVOKED",
          ].includes(notice.kind)
        ) {
          const answer = store.get<Answer>("answer", notice.objectId);
          if (
            !answer ||
            answer.domain !== notice.domain ||
            answer.owner !== notice.owner
          ) {
            update({ state: "suppressed", code: "OBJECT_UNAVAILABLE" });
            continue;
          }
          // A late ACK may still establish prior delivery. Keep waiting, without
          // sending anything to an audience whose original delivery is unknown.
          if (answer.deliveredThrough === 0) {
            waitFor("ORIGINAL_DELIVERY_UNCONFIRMED");
            continue;
          }
          if (answer.review === "clear") {
            update({ state: "suppressed", code: "STATUS_OBSOLETE" });
            continue;
          }
          text = `答案 ${answer.id}\n${answer.review === "invalid" ? "原答案或其知识依据已失效，请停止使用原指导。" : "模型验证待确认。已收到的内容需要复核，请暂停据此操作。"}\n此通知不包含原答案正文。`;
        } else {
          update({ state: "suppressed", code: "UNSUPPORTED_NOTICE_KIND" });
          continue;
        }
      } catch (error) {
        if (error instanceof Fault && error.code === "FORBIDDEN")
          update({ state: "suppressed", code: "ACCESS_REVOKED" });
        else waitFor(error instanceof Fault ? error.code : "NOTICE_BLOCKED");
        continue;
      }
      const recipients = Object.entries(
        options.notificationRecipients ?? {},
      ).filter(([subject, address]) => subject === notice.owner && address);
      if (recipients.length !== 1) {
        waitFor("RECIPIENT_UNMAPPED");
        continue;
      }
      const recipient = { botId: options.botId, userId: recipients[0]![1] };
      if (
        notice.recipient &&
        (notice.recipient.botId !== recipient.botId ||
          notice.recipient.userId !== recipient.userId)
      ) {
        update({ state: "suppressed", code: "RECIPIENT_CHANGED" });
        continue;
      }
      // No await separates the permission/lease check and actual SDK invocation.
      own();
      if (options.transport.ready?.() === false) {
        waitFor("CHANNEL_DISCONNECTED");
        continue;
      }
      const intent = update({
        state: "unknown",
        recipient,
        attempts: (notice.attempts ?? 0) + 1,
        attemptedAt: Date.now(),
        code: "ACK_UNCONFIRMED",
        retryable: false,
      });
      const ack = await options.transport
        .notify(recipient.userId, `通知 ${notice.id}\n${text}`)
        .catch(() => ({ state: "unknown" as const }));
      const current = store.get<Notice>("notice", intent.id)!;
      if (current.version !== intent.version || current.state !== "unknown")
        continue;
      // Record the observed result even after shutdown/authorization changes;
      // this fact never grants permission for a new send.
      store.put<Notice>("notice", {
        ...current,
        state: ack.state,
        code:
          ack.state === "failed"
            ? ack.code
            : ack.state === "unknown"
              ? "ACK_UNCONFIRMED"
              : undefined,
        acknowledgedAt: ack.state === "acked" ? Date.now() : undefined,
        retryable:
          ack.state === "failed" && intent.attempts! < NOTICE_MAX_ATTEMPTS,
        version: current.version + 1,
      });
    }
  }
  const timer = setInterval(() => {
    if (!stopping && !work)
      work = dispatch()
        .catch(() => {})
        .finally(() => {
          work = undefined;
        });
  }, 100);
  timer.unref();
  return async () => {
    stopping = true;
    clearInterval(timer);
    await work;
  };
}
