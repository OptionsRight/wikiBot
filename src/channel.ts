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
}
interface Receipt extends Entity {
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
        "idempotency-key": `wecom:${hash([options.botId, event.id, url, payload])}`,
        "content-type": "application/json",
      },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const value = response.json();
    if (response.statusCode >= 400)
      throw new Fault(
        response.statusCode,
        value.error?.code ?? "REQUEST_FAILED",
      );
    return value;
  }
  async function receive(event: Inbound) {
    if (
      stopping ||
      event.botId !== options.botId ||
      event.chatType !== "single" ||
      event.text.length > 16000
    )
      return;
    const subject = Object.hasOwn(options.members, event.userId)
      ? options.members[event.userId]
      : undefined;
    if (!subject) return;
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
      const base = `/api/domains/${encodeURIComponent(domain)}`;
      const conversationId = hash([
        domain,
        options.botId,
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
      const answerControl = event.text.match(
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
      if (event.text === "/帮助") {
        await send(
          "提问格式：流程名称\n对象：客户或策略\n条件：字段=值\n补充上一轮：/条件 字段=值 或 /继续 后另起一行填写对象、条件、流程编号\n/取消 [答案编号] 停止生成和后续正文发送\n/答案 [答案编号] 查看状态\n/偏好 查看；/偏好 业务|技术 入门|熟练 保存；/清除偏好 恢复默认\n/通知 查看通知状态；/重试通知 编号@版本 仅重试明确失败的通知\n/登记 问题描述；/工单 编号；/反馈 答案编号 描述",
          true,
        );
        return;
      }
      if (
        event.text === "/偏好" ||
        event.text === "/清除偏好" ||
        event.text.startsWith("/偏好 ")
      ) {
        let preference = await command(
          actor,
          event,
          "GET",
          `${base}/preferences`,
        );
        if (event.text === "/清除偏好")
          preference = await command(
            actor,
            event,
            "DELETE",
            `${base}/preferences`,
            { expectedVersion: preference.version },
          );
        else if (event.text !== "/偏好") {
          const selected = event.text.match(/^\/偏好 (业务|技术) (入门|熟练)$/);
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
      if (event.text === "/通知") {
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
      const retryNotice = event.text.match(
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
      if (event.text.startsWith("/登记 ")) {
        const description = event.text.slice(4).trim(),
          ticket = await command(actor, event, "POST", `${base}/tickets`, {
            title: description.slice(0, 100),
            description,
            category: "question",
          });
        await send(`问题已登记：${ticket.id}\n状态：${ticket.state}`, true);
        return;
      }
      if (event.text.startsWith("/工单 ")) {
        const tid = event.text.slice(4).trim();
        requireThat(/^[a-zA-Z0-9-]+$/.test(tid), 400, "INVALID_ID");
        const ticket = await command(
          actor,
          event,
          "GET",
          `${base}/tickets/${tid}`,
        );
        await send(
          `工单 ${ticket.id}@${ticket.version}\n${plain(ticket.title)}\n状态：${ticket.state}\n${plain(ticket.resolution ?? "等待处理")}`,
          true,
        );
        return;
      }
      if (event.text.startsWith("/反馈 ")) {
        const parts = event.text.slice(4).trim().split(/\s+/),
          answerId = parts.shift()!,
          description = parts.join(" ");
        const ticket = await command(actor, event, "POST", `${base}/tickets`, {
          title: "答案反馈",
          description,
          category: "knowledge",
          answerId,
        });
        await send(`反馈已登记：${ticket.id}`, true);
        return;
      }
      const ticketAction = event.text.match(
        /^\/(补充|确认|重开|撤回|分诊|开始|解决|请求材料) ([a-zA-Z0-9-]+)@(\d+)(?:\s+([\s\S]+))?$/,
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
            text: ticketAction[4],
          },
        );
        await send(
          `工单 ${ticket.id}@${ticket.version}\n状态：${ticket.state}`,
          true,
        );
        return;
      }
      const revisionInput = event.text.match(
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
      const revisionSubmit = event.text.match(
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
      if (event.text === "/修订") {
        access(store, actor, domain, true);
        await send(
          `可发送以下格式保存草稿：\n/修订 页面编号\n范围：受影响场景\n依据：更正理由与来源（至少十字）\n正文：更正后的完整正文\n\n也可使用认证网页：${origin ?? "请联系管理员提供网页地址"}`,
          true,
        );
        return;
      }
      if (event.text.startsWith("/修订状态 ")) {
        const revision = await command(
          actor,
          event,
          "GET",
          `${base}/revisions/${encodeURIComponent(event.text.slice(6).trim())}`,
        );
        await send(
          `修订 ${revision.id}\n状态：${revision.state}\n${revision.blocker ?? ""}`,
          true,
        );
        return;
      }
      const continuing =
        /^\/(条件 |继续(?:\n|$))/.test(event.text) ||
        /^(对象|条件)[：:]/.test(event.text);
      requireThat(
        !event.text.startsWith("/") || continuing,
        400,
        "UNKNOWN_COMMAND_USE_HELP",
      );
      const text = event.text
        .replace(/^\/条件 /, "条件：")
        .replace(/^\/继续(?:\n|$)/, "");
      const prior = continuing
        ? store.get<Conversation>("channel-conversation", conversationId)
        : undefined;
      requireThat(!continuing || prior, 409, "NO_PREVIOUS_CONSULTATION");
      const previousAnswer = prior
        ? answers.read(actor, domain, prior.answerId, false)
        : undefined;
      requireThat(
        !previousAnswer || previousAnswer.review === "clear",
        409,
        "DELIVERY_PAUSED",
      );
      const objectId =
        text.match(/(?:^|\n)对象[：:]([^\n]+)/)?.[1]?.trim() ??
        previousAnswer?.objectId ??
        undefined;
      const selectedProcedure = text
        .match(/(?:^|\n)流程[：:]([^\n]+)/)?.[1]
        ?.trim();
      let procedureId =
        selectedProcedure ?? previousAnswer?.procedureId ?? undefined;
      if (selectedProcedure) {
        const knowledge = await command(
          actor,
          event,
          "GET",
          `${base}/knowledge`,
        );
        const matches = knowledge.procedures.filter(
          (p: { id: string; title: string; aliases: string[] }) =>
            [p.id, p.title, ...p.aliases].includes(selectedProcedure),
        );
        if (matches.length === 1) procedureId = matches[0].id;
      }
      const inputs: Record<string, string | boolean> = {};
      for (const pair of (
        text.match(/(?:^|\n)条件[：:]([^\n]+)/)?.[1] ?? ""
      ).split(/[；;,，]/)) {
        if (!pair.trim()) continue;
        const [k, v, extra] = pair.split("=");
        requireThat(
          k?.trim() && v?.trim() && extra === undefined,
          400,
          "CONDITION_FORMAT_REQUIRED",
        );
        if (k && v)
          inputs[k.trim()] =
            v.trim() === "true"
              ? true
              : v.trim() === "false"
                ? false
                : v.trim();
      }
      const answer = await command(actor, event, "POST", `${base}/answers`, {
        question: continuing
          ? previousAnswer!.question
          : text
              .replace(/^(对象|条件|流程)[：:][^\n]*\n?/gm, "")
              .trim()
              .slice(0, 4000) || "流程咨询",
        sessionId: `wecom:${hash([options.botId, event.userId])}`,
        objectId,
        procedureId,
        inputs,
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
          await send(
            `答案 ${a.id}\n已取消，后续正文发送已停止。`,
            true,
            0,
            a.id,
          );
          finished = true;
          break;
        }
        const finish = !["queued", "running"].includes(a.state);
        const status = finish
          ? a.state === "complete"
            ? "生成完成"
            : `回答未完整完成：${a.code}`
          : "生成中";
        const content = `答案 ${a.id}\n${a.blocks.map((b) => plain(b.text) + (b.citations.length ? `\n依据：${b.citations.join("、")}` : "")).join("\n\n")}\n${status}`;
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
          await send(
            `答案 ${answer.id}\n已取消，后续正文发送已停止。`,
            true,
            0,
            answer.id,
          );
          return;
        }
        const terminal = previous
          ? previous.replace(/\n生成中$/, "\n回答未完整完成：已到达处理时限。")
          : `答案 ${answer.id}\n回答未完整完成：已到达处理时限。`;
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
              `本次请求未完成：${error instanceof Fault ? error.code : "REQUEST_FAILED"}。可在认证网页查看知识、补充条件或登记问题。`,
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
        store.put<Receipt>("inbox", {
          ...receipt,
          state: receipt.state === "processing" ? "failed" : receipt.state,
          code: receipt.code ?? "CHANNEL_INTERRUPTED",
          complete: false,
          version: receipt.version + 1,
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
