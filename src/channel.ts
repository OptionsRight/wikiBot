import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  Store,
  access,
  id,
  hash,
  requireThat,
  Fault,
  type Entity,
  type Identity,
} from "./core.js";
import type { AnswerService, Answer } from "./answers.js";
import {
  WecomRejection,
  type Inbound,
  type WecomTransport,
} from "./adapters/wecom.js";
import { startNotifications } from "./notifications.js";
export interface WecomOptions {
  botId: string;
  domain: string;
  members: Record<string, string>;
  transport: WecomTransport;
  notifications?: boolean;
  /** Independently verified subject -> proactive single-chat address mapping. */
  notificationRecipients?: Record<string, string>;
  /** Allowed group chat ids; other groups are silently ignored. */
  groups?: string[];
  /** Trusted directory must return the complete current audience, never a partial page. */
  groupAudience?: (
    chatId: string,
  ) => Promise<
    { userIds: string[]; complete: boolean; expiresAt: number } | undefined
  >;
}
interface Receipt extends Entity {
  commands?: {
    key: string;
    state: "pending" | "committed" | "unknown";
    operation?: string;
    objectId?: string;
  }[];
  botId?: string;
  owner: string;
  messageId: string;
  state: "processing" | "acked" | "failed" | "unknown";
  answerId?: string;
  through: number;
  complete: boolean;
  streamFinished?: boolean;
  code?: string;
}
interface Conversation extends Entity {
  answerId: string;
}
interface Lease extends Entity {
  owner: string;
  expires: number;
}
function plain(text: string) {
  return text.replace(/[\\`*_{}\[\]()#+.!<>|]/g, "\\$&");
}
// The WeCom chat bubble renders only a markdown subset (inline code and
// quotes render; headings, bold, fenced blocks do not). Normalize the
// model's full markdown to what this surface displays cleanly.
function wecomFormat(text: string) {
  return text
    .replace(/^#{1,6}\s*(.+)$/gm, "【$1】")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1（$2）")
    .replace(/^[-*]\s+/gm, "· ")
    .replace(/^---+\s*$/gm, "———")
    .replace(/```\w*\n([\s\S]*?)```/g, (_match, code: string) => code.trim());
}
export function registerChannel(
  app: FastifyInstance,
  store: Store,
  answers: AnswerService,
  options: WecomOptions,
  credentials: Map<string, Identity>,
  origin?: string,
) {
  const owner = id(),
    leaseId = options.botId,
    working = new Set<Promise<void>>(),
    tokens = new Map<string, string>();
  const turns = new Map<string, Promise<void>>();
  let heartbeat: NodeJS.Timeout,
    stopping = false;
  let stopNotifications: (() => Promise<void>) | undefined;
  function own() {
    const lease = store.get<Lease>("bot-lease", leaseId);
    requireThat(
      lease?.owner === owner && lease.expires > Date.now(),
      503,
      "BOT_LEASE_LOST",
    );
  }
  async function command(
    actor: Identity,
    event: Inbound,
    method: "POST" | "GET" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
  ) {
    own();
    access(store, actor, options.domain);
    const commandKey = `wecom:${hash([options.botId, event.id, url, payload])}`;
    const receiptId = hash([options.botId, event.id]);
    if (method !== "GET")
      store.tx(() => {
        const receipt = store.get<Receipt>("inbox", receiptId);
        requireThat(
          receipt?.owner === actor.subject && receipt.domain === options.domain,
          409,
          "INBOUND_INTENT_REQUIRED",
        );
        store.put<Receipt>("inbox", {
          ...receipt,
          version: receipt.version + 1,
          commands: [
            ...(receipt.commands ?? []).filter((c) => c.key !== commandKey),
            { key: commandKey, state: "pending" },
          ],
        });
      });
    let token = tokens.get(actor.subject);
    if (!token) {
      token = randomBytes(32).toString("base64url");
      tokens.set(actor.subject, token);
      credentials.set(token, actor);
    }
    const response = await app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": commandKey,
        "content-type": "application/json",
      },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const value = response.json();
    if (method !== "GET") reconcileCommands(receiptId);
    if (response.statusCode >= 400)
      throw new Fault(
        response.statusCode,
        value.error?.code ?? "REQUEST_FAILED",
      );
    return value;
  }
  function reconcileCommands(receiptId: string) {
    const receipt = store.get<Receipt>("inbox", receiptId);
    if (!receipt?.commands?.length) return;
    const actor = { subject: receipt.owner, platform: false };
    store.put<Receipt>("inbox", {
      ...receipt,
      version: receipt.version + 1,
      commands: receipt.commands.map((command) => {
        const outcome = store.commandReceipt(
          actor,
          receipt.domain,
          command.key,
        );
        return {
          key: command.key,
          state: outcome ? "committed" : "unknown",
          ...outcome,
        };
      }),
    });
  }
  async function verifyAudience(event: Inbound) {
    if (event.chatType !== "group") return;
    requireThat(
      event.chatId &&
        options.groups?.includes(event.chatId) &&
        options.groupAudience,
      403,
      "GROUP_AUDIENCE_UNKNOWN",
    );
    const audience = await options.groupAudience(event.chatId);
    requireThat(
      audience?.complete &&
        audience.expiresAt > Date.now() &&
        audience.userIds.length > 0 &&
        audience.userIds.includes(event.userId),
      403,
      "GROUP_AUDIENCE_UNKNOWN",
    );
    for (const userId of audience.userIds) {
      const subject = Object.hasOwn(options.members, userId)
        ? options.members[userId]
        : undefined;
      requireThat(subject, 403, "GROUP_AUDIENCE_UNAUTHORIZED");
      access(store, { subject, platform: false }, options.domain);
    }
    return hash([...new Set(audience.userIds)].sort());
  }
  async function receive(event: Inbound) {
    if (stopping || event.botId !== options.botId || event.text.length > 16000)
      return;
    let audienceKey: string | undefined;
    let audienceUnavailable = false;
    if (event.chatType === "group") {
      // Group answers are visible to everyone: only allowlisted groups,
      // only messages that mention the bot, and only mapped members.
      if (!event.chatId || !options.groups?.includes(event.chatId)) return;
      if (!/^@\S+\s+/.test(event.text)) return;
      try {
        audienceKey = await verifyAudience(event);
      } catch {
        // Record the request and send only fixed, public guidance below.
        // Missing audience verification must never reach knowledge generation.
        audienceUnavailable = true;
      }
    } else if (event.chatType !== "single") return;
    const subject = Object.hasOwn(options.members, event.userId)
      ? options.members[event.userId]
      : undefined;
    if (!subject) return;
    const messageText =
      event.chatType === "group"
        ? event.text.replace(/^@\S+\s*/, "").trim()
        : event.text;
    const actor = { subject, platform: false },
      domain = options.domain,
      rid = hash([options.botId, event.id]);
    let receipt: Receipt | undefined;
    let releaseTurn = () => {};
    try {
      receipt = store.tx(() => {
        own();
        access(store, actor, domain);
        if (store.get("inbox", rid)) return;
        return store.put<Receipt>("inbox", {
          id: rid,
          domain,
          owner: subject,
          version: 1,
          messageId: event.id,
          botId: options.botId,
          state: "processing",
          through: 0,
          complete: false,
        });
      });
      if (!receipt) return;
      requireThat(!audienceUnavailable, 403, "GROUP_AUDIENCE_UNKNOWN");
      const base = `/api/domains/${encodeURIComponent(domain)}`;
      const conversationId = hash([
        domain,
        options.botId,
        event.chatId ?? "",
        event.userId,
        subject,
      ]);
      const previousTurn = turns.get(conversationId);
      let unlock!: () => void;
      const turn = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      turns.set(conversationId, turn);
      releaseTurn = () => {
        unlock();
        if (turns.get(conversationId) === turn) turns.delete(conversationId);
      };
      await previousTurn;
      own();
      access(store, actor, domain);
      async function send(
        text: string,
        finish: boolean,
        through = 0,
        answerId?: string,
      ) {
        releaseTurn();
        requireThat(
          (await verifyAudience(event)) === audienceKey,
          403,
          "GROUP_AUDIENCE_CHANGED",
        );
        own();
        access(store, actor, domain);
        let complete = finish;
        if (answerId) {
          const current = answers.read(actor, domain, answerId, false);
          requireThat(current.review === "clear", 503, "DELIVERY_PAUSED");
          requireThat(
            !through || !current.deliveryCancelledAt,
            409,
            "DELIVERY_CANCELLED",
          );
          complete =
            finish &&
            current.state === "complete" &&
            !current.deliveryCancelledAt &&
            through === current.blocks.length;
        }
        requireThat(
          Buffer.byteLength(text, "utf8") <= 20480,
          413,
          "CHANNEL_BODY_TOO_LARGE",
        );
        // Commit the uncertain send boundary before entering an external network.
        receipt = store.get<Receipt>("inbox", rid)!;
        const intent = store.put<Receipt>("inbox", {
          ...receipt!,
          state: "unknown",
          code: "ACK_UNCONFIRMED",
          answerId: answerId ?? receipt!.answerId,
          version: receipt!.version + 1,
        });
        await options.transport.reply(event, rid, text, finish);
        receipt = store.tx(() => {
          own();
          const current = store.get<Receipt>("inbox", intent.id)!;
          requireThat(
            current.version === intent.version && current.state === "unknown",
            409,
            "DELIVERY_FENCE_LOST",
          );
          // A successful SDK receipt proves this specific pre-authorized send happened,
          // even if model eligibility changed while the network acknowledgment was in flight.
          if (answerId) {
            const a = store.get<Answer>("answer", answerId)!;
            complete = complete && !a.deliveryCancelledAt;
            requireThat(
              a.owner === actor.subject &&
                a.domain === domain &&
                through <= a.blocks.length,
              409,
              "INVALID_DELIVERY_RECEIPT",
            );
            store.put("answer", {
              ...a,
              deliveredThrough: Math.max(a.deliveredThrough, through),
              version: a.version + 1,
            });
          }
          return store.put<Receipt>("inbox", {
            ...current,
            answerId: answerId ?? current.answerId,
            state: "acked",
            through: Math.max(current.through, through),
            complete,
            code:
              answerId &&
              store.get<Answer>("answer", answerId)?.deliveryCancelledAt
                ? "DELIVERY_CANCELLED"
                : undefined,
            streamFinished: finish,
            version: current.version + 1,
          });
        });
      }
      if (
        event.chatType === "group" &&
        /^(?:\/|反馈[：:\s]|登记[：:\s]|我要登记|帮我登记)/.test(messageText)
      ) {
        await send(
          `个人答案、工单与维护操作请使用机器人单聊或认证网页：${origin ?? "请联系管理员获取地址"}`,
          true,
        );
        return;
      }
      const answerControl = messageText.match(
        /^\/(取消|答案)(?: ([a-zA-Z0-9-]+))?$/,
      );
      if (answerControl) {
        const answerId =
          answerControl[2] ??
          store.get<Conversation>("channel-conversation", conversationId)
            ?.answerId;
        requireThat(answerId, 404, "NO_PREVIOUS_CONSULTATION");
        const a = await command(
          actor,
          event,
          answerControl[1] === "取消" ? "POST" : "GET",
          `${base}/answers/${answerId}${answerControl[1] === "取消" ? "/cancel" : ""}`,
          answerControl[1] === "取消" ? {} : undefined,
        );
        const deliveries = store
          .list<Receipt>("inbox", domain)
          .filter(
            (r) =>
              r.answerId === a.id &&
              r.owner === subject &&
              r.botId === options.botId,
          );
        const delivery = deliveries.at(-1);
        const result =
          answerControl[1] === "取消"
            ? "已取消后续生成和正文发送。已在途的消息仍可能送达。"
            : `生成状态：${a.state}；原因：${a.code}；已确认正文块：${a.deliveredThrough}。${a.review === "pending" ? "模型验证待确认。" : ""}${delivery ? `\n企微投递：${delivery.state}；完整交付：${delivery.complete ? "是" : "否"}${delivery.code ? `；原因：${delivery.code}` : ""}` : ""}`;
        await send(
          `答案 ${a.id}\n${result}${origin ? `\n认证网页：${origin}/#answer=${a.id}&domain=${encodeURIComponent(domain)}` : ""}`,
          true,
        );
        return;
      }
      if (messageText === "/帮助") {
        await send(
          "直接发送问题即可，机器人会检索已发布知识并回答（回复支持 Markdown 排版，附依据页面编号）。\n反馈最近答案：回复“反馈 问题描述”\n登记新问题：回复“登记 问题描述”\n/取消 停止生成；/答案 [编号] 查看状态\n/偏好 查看；/偏好 业务|技术 入门|熟练 保存；/清除偏好 恢复默认\n/通知 查看通知状态；/重试通知 编号@版本 仅重试明确失败的通知\n/工单 编号 查看处理进度；/附件 编号 转网页\n/身份 查看资格标签；/投递 查看未知回执\n处理人：/备注、/拒绝 编号@版本 说明；/合并 编号@版本 目标编号；/指派 编号@版本 处理人",
          true,
        );
        return;
      }
      if (
        messageText === "/偏好" ||
        messageText === "/清除偏好" ||
        messageText.startsWith("/偏好 ")
      ) {
        let preference = await command(
          actor,
          event,
          "GET",
          `${base}/preferences`,
        );
        if (messageText === "/清除偏好")
          preference = await command(
            actor,
            event,
            "DELETE",
            `${base}/preferences`,
            { expectedVersion: preference.version },
          );
        else if (messageText !== "/偏好") {
          const selected = messageText.match(
            /^\/偏好 (业务|技术) (入门|熟练)$/,
          );
          requireThat(selected, 400, "PREFERENCE_FORMAT_REQUIRED");
          preference = await command(
            actor,
            event,
            "PATCH",
            `${base}/preferences`,
            {
              style: selected[1] === "技术" ? "technical" : "business",
              depth: selected[2] === "熟练" ? "experienced" : "beginner",
              expectedVersion: preference.version,
            },
          );
        }
        await send(
          `当前偏好：${preference.style === "technical" ? "技术" : "业务"} / ${preference.depth === "experienced" ? "熟练" : "入门"}。仅影响表达，不改变权限。`,
          true,
        );
        return;
      }
      if (messageText === "/投递") {
        const receipts = (
          await command(actor, event, "GET", `${base}/channel-receipts`)
        ).filter(
          (r: Receipt) => r.owner === subject && r.botId === options.botId,
        );
        await send(
          receipts
            .slice(-10)
            .map(
              (r: Receipt) =>
                `${r.answerId ? `答案 ${r.answerId}` : "请求"}：${r.state}${r.code ? `（${r.code}）` : ""}${
                  r.commands?.some((c) => c.state === "committed")
                    ? `；业务已提交 ${r.commands
                        .filter((c) => c.state === "committed")
                        .map((c) => c.objectId ?? "操作")
                        .join("、")}`
                    : ""
                }`,
            )
            .join("\n") || "暂无投递记录。",
          true,
        );
        return;
      }
      if (messageText === "/通知") {
        const notices = await command(actor, event, "GET", `${base}/notices`);
        await send(
          notices.length
            ? notices
                .slice(-10)
                .map(
                  (n: {
                    id: string;
                    version: number;
                    state: string;
                    code?: string;
                  }) =>
                    `${n.id}@${n.version}：${n.state}${n.code ? `（${n.code}）` : ""}`,
                )
                .join("\n")
            : "暂无通知。",
          true,
        );
        return;
      }
      const retryNotice = messageText.match(
        /^\/重试通知 ([a-zA-Z0-9-]+)@(\d+)$/,
      );
      if (retryNotice) {
        const n = await command(
          actor,
          event,
          "POST",
          `${base}/notices/${retryNotice[1]}/retry`,
          { expectedVersion: Number(retryNotice[2]) },
        );
        await send(`通知 ${n.id}：${n.state}。业务操作不会重复执行。`, true);
        return;
      }
      const registration = messageText.match(
        /^(?:\/登记|登记|我要登记|帮我登记)[：:\s]+([\s\S]+)$/,
      );
      if (registration) {
        const description = registration[1]!.trim(),
          ticket = await command(actor, event, "POST", `${base}/tickets`, {
            title: description.slice(0, 100),
            description,
            category: "question",
          });
        await send(
          `问题已登记：${ticket.id}\n状态：${ticket.state}\n处理进度可发送 /工单 ${ticket.id} 查看。`,
          true,
        );
        return;
      }
      if (messageText === "/身份") {
        const grant = await command(
          actor,
          event,
          "GET",
          `${base}/capabilities`,
        );
        await send(
          `领域权限：${grant.role === "admin" ? "知识管理员" : "普通成员"}；表达标签：${(grant.tags ?? []).join(" / ") || "未设置"}；默认视角：${grant.defaultStyle ?? "business"}。标签不授予管理权限。成员配置请由平台管理员在认证网页处理。`,
          true,
        );
        return;
      }
      const attachmentLink = messageText.match(/^\/附件 ([a-zA-Z0-9-]+)$/);
      if (attachmentLink) {
        await command(
          actor,
          event,
          "GET",
          `${base}/tickets/${attachmentLink[1]}`,
        );
        await send(
          `附件需在认证网页上传和下载：${origin ?? "请联系管理员提供地址"}。进入工单 ${attachmentLink[1]} 查看，内部附件仅管理员可见。`,
          true,
        );
        return;
      }
      if (messageText.startsWith("/工单 ")) {
        const tid = messageText.slice(4).trim();
        requireThat(/^[a-zA-Z0-9-]+$/.test(tid), 400, "INVALID_ID");
        const ticket = await command(
          actor,
          event,
          "GET",
          `${base}/tickets/${tid}`,
        );
        const details = [
          ticket.resolution ?? "等待处理",
          ...(ticket.comments ?? []).map(
            (c: { internal: boolean; text: string }) =>
              `${c.internal ? "内部备注：" : "处理记录："}${c.text}`,
          ),
        ].join("\n");
        const preview = [...details].slice(-3000).join("");
        await send(
          `工单 ${ticket.id}@${ticket.version}\n${plain(ticket.title)}\n状态：${ticket.state}\n${details.length > preview.length ? "仅展示末尾记录，完整内容请在认证网页查看。\n" : ""}${plain(preview)}\n补充或确认：/补充 ${ticket.id}@${ticket.version} 说明；/确认 ${ticket.id}@${ticket.version}；/重开 ${ticket.id}@${ticket.version} 原因；附件：/附件 ${ticket.id}${origin ? `\n认证网页：${origin}/#ticket=${ticket.id}&domain=${encodeURIComponent(domain)}` : ""}`,
          true,
        );
        return;
      }
      const feedback = messageText.match(
        /^(?:\/反馈|反馈)[：:\s]+(?:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\s+)?([\s\S]+)$/,
      );
      if (feedback) {
        const answerId =
          feedback[1] ??
          store.get<Conversation>("channel-conversation", conversationId)
            ?.answerId;
        requireThat(answerId, 404, "NO_PREVIOUS_CONSULTATION");
        const ticket = await command(actor, event, "POST", `${base}/tickets`, {
          title: "答案反馈",
          description: feedback[2]!.trim(),
          category: "question",
          answerId,
        });
        await send(
          `反馈已登记：${ticket.id}\n知识负责人处理后可在此跟踪进度（/工单 ${ticket.id}）。`,
          true,
        );
        return;
      }
      const ticketAction = messageText.match(
        /^\/(补充|确认|重开|撤回|分诊|开始|解决|请求材料|备注|合并|拒绝|指派) ([a-zA-Z0-9-]+)@(\d+)(?:\s+([\s\S]+))?$/,
      );
      if (ticketAction) {
        const action = (
          {
            补充: "reply",
            确认: "close",
            重开: "reopen",
            撤回: "withdraw",
            分诊: "triage",
            开始: "start",
            解决: "resolve",
            请求材料: "request_info",
            备注: "note",
            合并: "merge",
            拒绝: "reject",
            指派: "assign",
          } as Record<string, string>
        )[ticketAction[1]!]!;
        const ticket = await command(
          actor,
          event,
          "POST",
          `${base}/tickets/${ticketAction[2]}/actions`,
          {
            action,
            expectedVersion: Number(ticketAction[3]),
            text: ["merge", "assign"].includes(action)
              ? undefined
              : ticketAction[4],
            targetId: action === "merge" ? ticketAction[4]?.trim() : undefined,
            assignee: action === "assign" ? ticketAction[4]?.trim() : undefined,
          },
        );
        await send(
          `工单 ${ticket.id}@${ticket.version}\n状态：${ticket.state}`,
          true,
        );
        return;
      }
      const revisionInput = messageText.match(
        /^\/修订 ([a-zA-Z0-9_-]+)\n范围[：:]([^\n]+)\n依据[：:]([^\n]+)\n正文[：:]([\s\S]+)$/,
      );
      if (revisionInput) {
        access(store, actor, domain, true);
        const knowledge = await command(
          actor,
          event,
          "GET",
          `${base}/knowledge`,
        );
        const page = knowledge.pages.find(
          (p: { id: string }) => p.id === revisionInput[1],
        );
        requireThat(page, 404, "PAGE_NOT_FOUND");
        const revision = await command(
          actor,
          event,
          "POST",
          `${base}/revisions`,
          {
            title: `更正 ${page.title}`,
            scope: revisionInput[2],
            reason: revisionInput[3],
            changes: [
              {
                pageId: page.id,
                baseHash: page.hash,
                content: revisionInput[4],
                source: revisionInput[3],
              },
            ],
          },
        );
        await send(
          `修订草稿 ${revision.id}@${revision.version}\n已保存，尚未写回或发布。请在网页核对原文和拟改正文。`,
          true,
        );
        return;
      }
      const revisionSubmit = messageText.match(
        /^\/提交修订 ([a-zA-Z0-9-]+)@(\d+)$/,
      );
      if (revisionSubmit) {
        const revision = await command(
          actor,
          event,
          "POST",
          `${base}/revisions/${revisionSubmit[1]}/submit`,
          { expectedVersion: Number(revisionSubmit[2]) },
        );
        await send(
          `修订 ${revision.id}\n状态：${revision.state}，等待维护者写回来源。`,
          true,
        );
        return;
      }
      if (messageText === "/修订") {
        access(store, actor, domain, true);
        await send(
          `可发送以下格式保存草稿：\n/修订 页面编号\n范围：受影响场景\n依据：更正理由与来源（至少十字）\n正文：更正后的完整正文\n\n也可使用认证网页：${origin ?? "请联系管理员提供网页地址"}`,
          true,
        );
        return;
      }
      if (messageText.startsWith("/修订状态 ")) {
        const revision = await command(
          actor,
          event,
          "GET",
          `${base}/revisions/${encodeURIComponent(messageText.slice(6).trim())}`,
        );
        await send(
          `修订 ${revision.id}\n状态：${revision.state}\n${revision.blocker ?? ""}`,
          true,
        );
        return;
      }
      requireThat(
        !messageText.startsWith("/"),
        400,
        "UNKNOWN_COMMAND_USE_HELP",
      );
      const answer = await command(actor, event, "POST", `${base}/answers`, {
        question: messageText.trim(),
        sessionId: `wecom:${hash([
          options.botId,
          event.chatId ?? "",
          audienceKey ?? "",
          event.userId,
        ])}`,
      });
      const conversation = store.get<Conversation>(
        "channel-conversation",
        conversationId,
      );
      store.put<Conversation>("channel-conversation", {
        id: conversationId,
        domain,
        version: (conversation?.version ?? 0) + 1,
        answerId: answer.id,
      });
      receipt = store.get<Receipt>("inbox", rid)!;
      receipt = store.put<Receipt>("inbox", {
        ...receipt,
        answerId: answer.id,
        version: receipt.version + 1,
      });
      // Serialize context mutations, not long-running generation or network ACKs.
      // Cancellation and clarification remain responsive during the prior stream.
      releaseTurn();
      let previous = "",
        finished = false;
      while (!stopping && Date.now() < answer.deadline) {
        const a = answers.read(actor, domain, answer.id);
        requireThat(a.review === "clear", 503, "DELIVERY_PAUSED");
        if (a.deliveryCancelledAt) {
          await send("已取消，后续正文发送已停止。", true, 0, a.id);
          finished = true;
          break;
        }
        const finish = !["queued", "running"].includes(a.state);
        const status = finish
          ? a.state === "complete"
            ? `生成完成${a.finishedAt ? `，耗时 ${((a.finishedAt - a.createdAt) / 1000).toFixed(1)} 秒` : ""}`
            : `回答未完整完成：${a.code}`
          : "生成中";
        const body = a.blocks
          .map(
            (b) =>
              wecomFormat(b.text) +
              (b.citations.length ? `\n依据：${b.citations.join("、")}` : ""),
          )
          .join("\n\n");
        const guidance =
          event.chatType === "group"
            ? "\n——\n反馈或登记请使用机器人单聊。"
            : "\n——\n反馈本条答案：回复“反馈 问题描述”；登记新问题：回复“登记 问题描述”。";
        const content = finish
          ? `${body}\n${status}${guidance}`
          : `${body}\n${status}`;
        if (Buffer.byteLength(content, "utf8") > 20000) {
          await send(
            `答案 ${a.id}\n企微正文未完整交付。请登录网页查看完整答案：${origin ?? "请联系管理员提供网页地址"}${origin ? `/#answer=${a.id}&domain=${domain}` : ""}`,
            true,
            0,
          );
          receipt = store.put<Receipt>("inbox", {
            ...receipt,
            complete: false,
            code: "CHANNEL_BODY_TOO_LARGE",
            version: receipt.version + 1,
          });
          finished = true;
          break;
        }
        if (content !== previous && (a.blocks.length || finish)) {
          await send(content, finish, a.blocks.at(-1)?.sequence ?? 0, a.id);
          previous = content;
        }
        if (finish) {
          finished = true;
          break;
        }
        await delay(100);
      }
      if (!finished && !stopping) {
        answers.expire(actor, domain, answer.id, `deadline:${rid}`);
        const final = answers.read(actor, domain, answer.id, false);
        if (final.deliveryCancelledAt) {
          await send("已取消，后续正文发送已停止。", true, 0, answer.id);
          return;
        }
        const terminal = previous
          ? previous.replace(/\n生成中$/, "\n回答未完整完成：已到达处理时限。")
          : "回答未完整完成：已到达处理时限。";
        await send(terminal, true, receipt.through, answer.id);
        receipt = store.put<Receipt>("inbox", {
          ...receipt,
          complete: false,
          code: "CHANNEL_DEADLINE_EXCEEDED",
          version: receipt.version + 1,
        });
      }
    } catch (error) {
      if (receipt) {
        const current = store.get<Receipt>("inbox", receipt.id)!;
        const code =
          error instanceof Fault || error instanceof WecomRejection
            ? error.code
            : "ACK_UNCONFIRMED";
        store.put("inbox", {
          ...current,
          state:
            current.state === "processing" || error instanceof WecomRejection
              ? "failed"
              : current.state,
          code,
          complete: false,
          version: current.version + 1,
        });
        if (current.state === "processing")
          try {
            own();
            access(store, actor, domain);
            store.put("inbox", {
              ...current,
              state: "unknown",
              code: "ACK_UNCONFIRMED",
              version: current.version + 2,
            });
            await options.transport.reply(
              event,
              rid,
              // A group error can mean the audience is no longer authorized.
              // This fixed notice contains no question, answer, ID or private URL.
              event.chatType === "group"
                ? "当前无法在群内回答。群成员访问资格需要完整核验，请在机器人单聊中提问。"
                : `本次请求未完成：${error instanceof Fault ? error.code : "REQUEST_FAILED"}。可在认证网页查看知识、补充条件或登记问题。`,
              true,
            );
            store.put("inbox", {
              ...current,
              state: "acked",
              code,
              complete: false,
              streamFinished: true,
              version: current.version + 3,
            });
          } catch {}
      }
      // Never retry an uncertain send or reveal a protected body in an error reply.
    } finally {
      releaseTurn();
    }
  }
  app.addHook("onReady", async () => {
    store.tx(() => {
      const old = store.get<Lease>("bot-lease", leaseId);
      requireThat(!old || old.expires < Date.now(), 409, "BOT_ALREADY_OWNED");
      store.put<Lease>("bot-lease", {
        id: leaseId,
        domain: options.domain,
        version: (old?.version ?? 0) + 1,
        owner,
        expires: Date.now() + 15000,
      });
      for (const receipt of store.list<Receipt>("inbox", options.domain)) {
        if (receipt.botId !== options.botId || receipt.streamFinished) continue;
        reconcileCommands(receipt.id);
        const reconciled = store.get<Receipt>("inbox", receipt.id)!;
        store.put<Receipt>("inbox", {
          ...reconciled,
          state: receipt.state === "processing" ? "unknown" : receipt.state,
          code: receipt.code ?? "CHANNEL_INTERRUPTED_OUTCOME_UNKNOWN",
          complete: false,
          version: reconciled.version + 1,
        });
      }
    });
    heartbeat = setInterval(() => {
      try {
        store.tx(() => {
          own();
          const lease = store.get<Lease>("bot-lease", leaseId)!;
          store.put("bot-lease", {
            ...lease,
            expires: Date.now() + 15000,
            version: lease.version + 1,
          });
        });
      } catch {
        stopping = true;
        options.transport.close();
      }
    }, 5000);
    heartbeat.unref();
    options.transport.start((event) => {
      const work = receive(event);
      working.add(work);
      void work.finally(() => working.delete(work));
      return work;
    });
    if (options.notifications)
      stopNotifications = startNotifications(store, options, own);
  });
  app.addHook("preClose", async () => {
    stopping = true;
    clearInterval(heartbeat);
    options.transport.close();
    await stopNotifications?.();
    await Promise.allSettled(working);
    for (const token of tokens.values()) credentials.delete(token);
    const lease = store.get<Lease>("bot-lease", leaseId);
    if (lease?.owner === owner) store.remove("bot-lease", leaseId);
  });
  if (
    !app.hasRoute({
      method: "GET",
      url: "/api/domains/:domain/channel-receipts",
    })
  )
    app.get("/api/domains/:domain/channel-receipts", async (request) => {
      const grant = access(
        store,
        request.actor,
        (request.params as { domain: string }).domain,
      );
      return store
        .list<Receipt>("inbox", (request.params as { domain: string }).domain)
        .filter(
          (r) => r.owner === request.actor.subject || grant.role === "admin",
        );
    });
}
