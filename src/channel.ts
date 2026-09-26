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
import type { Inbound, WecomTransport } from "./adapters/wecom.js";
export interface WecomOptions {
  botId: string;
  domain: string;
  members: Record<string, string>;
  transport: WecomTransport;
}
interface Receipt extends Entity {
  owner: string;
  messageId: string;
  state: "processing" | "acked" | "failed" | "unknown";
  answerId?: string;
  through: number;
  complete: boolean;
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
  let heartbeat: NodeJS.Timeout,
    stopping = false;
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
    method: "POST" | "GET",
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
    const subject = options.members[event.userId];
    if (!subject) return;
    const actor = { subject, platform: false },
      domain = options.domain,
      rid = hash([options.botId, event.id]);
    let receipt: Receipt | undefined;
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
          state: "processing",
          through: 0,
          complete: false,
        });
      });
      if (!receipt) return;
      const base = `/api/domains/${encodeURIComponent(domain)}`;
      async function send(
        text: string,
        finish: boolean,
        through = 0,
        answerId?: string,
      ) {
        own();
        access(store, actor, domain);
        if (answerId) {
          const current = answers.read(actor, domain, answerId, false);
          requireThat(current.review === "clear", 503, "DELIVERY_PAUSED");
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
          answerId,
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
            answerId,
            state: "acked",
            through,
            complete: finish,
            version: current.version + 1,
          });
        });
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
          `工单 ${ticket.id}\n${plain(ticket.title)}\n状态：${ticket.state}\n${plain(ticket.resolution ?? "等待处理")}`,
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
      const objectId = event.text
        .match(/(?:^|\n)对象[：:]([^\n]+)/)?.[1]
        ?.trim();
      const inputs: Record<string, string | boolean> = {};
      for (const pair of (
        event.text.match(/(?:^|\n)条件[：:]([^\n]+)/)?.[1] ?? ""
      ).split(/[；;,，]/)) {
        const [k, v] = pair.split("=");
        if (k && v)
          inputs[k.trim()] =
            v.trim() === "true"
              ? true
              : v.trim() === "false"
                ? false
                : v.trim();
      }
      const answer = await command(actor, event, "POST", `${base}/answers`, {
        question: event.text.slice(0, 4000),
        sessionId: `wecom:${hash([options.botId, event.userId])}`,
        objectId,
        inputs,
      });
      receipt = store.put<Receipt>("inbox", {
        ...receipt,
        answerId: answer.id,
        version: receipt.version + 1,
      });
      let previous = "",
        finished = false;
      while (!stopping && Date.now() < answer.deadline) {
        const a = answers.read(actor, domain, answer.id);
        requireThat(a.review === "clear", 503, "DELIVERY_PAUSED");
        const finish = !["queued", "running"].includes(a.state);
        const status = finish
          ? a.state === "complete"
            ? "生成完成"
            : "回答未完整完成"
          : "生成中";
        const content = `答案 ${a.id}\n${a.blocks.map((b) => plain(b.text) + (b.citations.length ? `\n依据：${b.citations.join("、")}` : "")).join("\n\n")}\n${status}`;
        if (Buffer.byteLength(content, "utf8") > 20000) {
          await send(
            `答案 ${a.id}\n企微正文未完整交付。请登录网页查看完整答案：${origin ?? "请联系管理员提供网页地址"}${origin ? `/#answer=${a.id}&domain=${domain}` : ""}`,
            true,
            0,
          );
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
      if (!finished) {
        answers.cancel(actor, domain, answer.id, `deadline:${rid}`);
        const terminal = previous
          ? previous.replace(/\n生成中$/, "\n回答未完整完成：已到达处理时限。")
          : `答案 ${answer.id}\n回答未完整完成：已到达处理时限。`;
        await send(terminal, true, receipt.through, answer.id);
        receipt = store.put<Receipt>("inbox", {
          ...receipt,
          complete: false,
          version: receipt.version + 1,
        });
      }
    } catch (error) {
      if (receipt) {
        const current = store.get<Receipt>("inbox", receipt.id)!;
        store.put("inbox", {
          ...current,
          state: current.state === "processing" ? "failed" : current.state,
          version: current.version + 1,
        });
        if (current.state === "processing")
          try {
            own();
            access(store, actor, domain);
            store.put("inbox", {
              ...current,
              state: "unknown",
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
              complete: false,
              version: current.version + 3,
            });
          } catch {}
      }
      // Never retry an uncertain send or reveal a protected body in an error reply.
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
  });
  app.addHook("preClose", async () => {
    stopping = true;
    clearInterval(heartbeat);
    options.transport.close();
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
