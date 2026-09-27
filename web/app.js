const $ = (id) => document.getElementById(id);
let token = "",
  me,
  domain = "",
  knowledge,
  currentGrant,
  prefVersion = 0,
  answerId,
  poll,
  session = crypto.randomUUID();
function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function error(e) {
  $("error").textContent = e.message || String(e);
  $("error").hidden = false;
}
async function api(url, method = "GET", payload) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (method !== "GET") {
    headers["Idempotency-Key"] = crypto.randomUUID();
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error?.code || `请求失败 ${response.status}`);
  return data;
}
const base = () => `/api/domains/${encodeURIComponent(domain)}`;
function bind(id, action) {
  $(id).addEventListener("submit", async (event) => {
    event.preventDefault();
    $("error").hidden = true;
    const button = event.target.querySelector("button");
    button.disabled = true;
    try {
      await action();
    } catch (e) {
      error(e);
    } finally {
      button.disabled = false;
    }
  });
}
function button(text, action) {
  const b = el("button", text);
  b.type = "button";
  b.onclick = async () => {
    b.disabled = true;
    try {
      await action();
    } catch (e) {
      error(e);
    } finally {
      b.disabled = false;
    }
  };
  return b;
}
async function login() {
  me = await api("/api/me");
  const domains = await api("/api/domains");
  $("domain").replaceChildren(
    ...domains.map((d) => {
      const o = el("option", d.name);
      o.value = d.id;
      return o;
    }),
  );
  $("identity").textContent = me.subject;
  $("workspace").hidden = false;
  $("login").hidden = true;
  $("logout").hidden = false;
  const h = new URLSearchParams(location.hash.slice(1));
  if (domains.some((d) => d.id === h.get("domain")))
    $("domain").value = h.get("domain");
  domain = $("domain").value;
  if (domain) await changeDomain();
  else error(new Error("当前账号尚未获准访问领域，请联系平台管理员。"));
  if (
    h.get("domain") === domain &&
    /^[a-f0-9-]{36}$/.test(h.get("answer") ?? "")
  ) {
    answerId = h.get("answer");
    await readAnswer();
  }
  if (
    h.get("domain") === domain &&
    /^[a-f0-9-]{36}$/.test(h.get("ticket") ?? "")
  ) {
    document.querySelector('[data-view="tickets"]').click();
    await showTicket(h.get("ticket"));
  }
}
bind("token-login", async () => {
  token = $("token").value;
  $("token").value = "";
  await login();
});
$("logout").onclick = async () => {
  token = "";
  clearTimeout(poll);
  await fetch("/auth/logout", { method: "POST" });
  location.assign("/");
};
$("domain").onchange = async () => {
  domain = $("domain").value;
  session = crypto.randomUUID();
  clearTimeout(poll);
  answerId = undefined;
  $("answer").replaceChildren();
  delete $("answer").dataset.signature;
  $("cancel").hidden = true;
  $("feedback").hidden = true;
  try {
    await changeDomain();
  } catch (e) {
    error(e);
  }
};
async function changeDomain() {
  $("access-nav").hidden = !me.platform;
  if (me.platform) await listMembers();
  let grant;
  try {
    grant = await api(`${base()}/capabilities`);
  } catch (e) {
    if (!me.platform) throw e;
    $("admin-nav").hidden = true;
    $("access-nav").click();
    return;
  }
  currentGrant = grant;
  $("identity").textContent =
    `${me.subject} · ${grant.role === "admin" ? "知识管理员" : "成员"} · ${(grant.tags ?? []).map((t) => (t === "technical" ? "技术" : "业务")).join(" / ") || "未设置表达标签"}`;
  $("admin-nav").hidden = grant.role !== "admin";
  const pref = await api(`${base()}/preferences`);
  prefVersion = pref.version;
  $("style").value = pref.style;
  $("depth").value = pref.depth;
  try {
    knowledge = await api(`${base()}/knowledge`);
  } catch (e) {
    knowledge = { pages: [] };
    error(e);
  }
  renderKnowledge();
  await listTickets();
  if (grant.role === "admin") await listAdmin();
}
for (const b of document.querySelectorAll("[data-view]"))
  b.onclick = () => {
    for (const s of document.querySelectorAll(".view"))
      s.hidden = s.id !== b.dataset.view;
    for (const n of document.querySelectorAll("[data-view]"))
      n.classList.toggle("active", n === b);
  };
function renderKnowledge() {
  $("revision-page").replaceChildren(
    ...knowledge.pages.map((p) => {
      const o = el("option", p.title);
      o.value = p.id;
      return o;
    }),
  );
  $("page-list").replaceChildren(
    ...knowledge.pages.map((p) =>
      button(p.title, async () => {
        const fresh = await api(
          `${base()}/releases/${knowledge.release.id}/pages/${p.id}`,
        );
        $("page-content").replaceChildren(
          el("h2", fresh.title),
          el("div", fresh.content, "pre"),
        );
      }),
    ),
  );
}
bind("question-form", async () => {
  if ($("remember").checked) {
    const p = await api(`${base()}/preferences`, "PATCH", {
      style: $("style").value,
      depth: $("depth").value,
      expectedVersion: prefVersion,
    });
    prefVersion = p.version;
  }
  $("answer").replaceChildren(el("p", "正在生成…"));
  const a = await api(`${base()}/answers`, "POST", {
    question: $("question").value,
    sessionId: session,
    style: $("style").value,
    depth: $("depth").value,
  });
  answerId = a.id;
  location.hash = `answer=${a.id}&domain=${domain}`;
  await readAnswer();
});
async function readAnswer() {
  clearTimeout(poll);
  const id = answerId,
    d = domain;
  try {
    const a = await api(`${base()}/answers/${id}`);
    if (id !== answerId || d !== domain) return;
    const signature = JSON.stringify([
      a.id,
      a.state,
      a.code,
      a.review,
      a.blocks,
    ]);
    if ($("answer").dataset.signature === signature) {
      poll = setTimeout(
        () => readAnswer(),
        ["queued", "running"].includes(a.state) ? 300 : 5000,
      );
      return;
    }
    $("answer").dataset.signature = signature;
    $("answer").replaceChildren(
      el("div", `答案 ${a.id} · ${a.state} · ${a.code}`, "meta"),
    );
    if (a.review === "pending")
      $("answer").append(
        el("div", "模型验证待确认：仅展示此前确认收到的内容。", "warning"),
      );
    if (a.state === "incomplete" || a.state === "failed")
      $("answer").append(
        el("div", "这份回答未完整完成，请不要将其视为完整指导。", "warning"),
      );
    for (const b of a.blocks) {
      $("answer").append(
        el("div", b.text, "block"),
        el(
          "div",
          b.citations.length ? `依据：${b.citations.join("、")}` : "",
          "meta",
        ),
      );
      for (const citation of b.citations)
        $("answer").append(
          button(`查看依据 ${citation}`, async () => {
            const page = await api(
              `${base()}/releases/${a.releaseId}/pages/${encodeURIComponent(citation)}`,
            );
            const detail = el("details");
            detail.open = true;
            detail.append(
              el("summary", `${page.title} · ${a.releaseId.slice(0, 8)}`),
              el("div", page.content, "pre"),
            );
            $("answer").append(detail);
          }),
        );
    }
    if (a.finishedAt)
      $("answer").append(
        el(
          "div",
          `${a.state === "complete" ? "生成完成，" : ""}耗时 ${((a.finishedAt - a.createdAt) / 1000).toFixed(1)} 秒`,
          "meta",
        ),
      );
    $("cancel").hidden = !["queued", "running"].includes(a.state);
    $("feedback").hidden = false;
    if (
      a.review === "clear" &&
      a.blocks.length &&
      a.deliveredThrough < a.blocks.at(-1).sequence
    )
      await api(`${base()}/answers/${id}/ack`, "POST", {
        through: a.blocks.at(-1).sequence,
      });
    poll = setTimeout(
      () => readAnswer(),
      ["queued", "running"].includes(a.state) ? 300 : 5000,
    );
  } catch (e) {
    $("answer").replaceChildren(
      el(
        "div",
        "当前答案不可读取；权限、知识有效性或服务状态已变化。",
        "warning",
      ),
    );
    error(e);
  }
}
$("cancel").onclick = async () => {
  try {
    await api(`${base()}/answers/${answerId}/cancel`, "POST", {});
    await readAnswer();
  } catch (e) {
    error(e);
  }
};
$("clear-preferences").onclick = async () => {
  try {
    const p = await api(`${base()}/preferences`, "DELETE", {
      expectedVersion: prefVersion,
    });
    prefVersion = p.version;
    $("style").value = p.style;
    $("depth").value = p.depth;
    $("remember").checked = false;
  } catch (e) {
    error(e);
  }
};
bind("feedback", async () => {
  const t = await api(`${base()}/tickets`, "POST", {
    title: "答案反馈",
    description: $("feedback-text").value,
    category: $("feedback-category").value,
    answerId,
  });
  $("feedback").append(el("p", `已登记工单 ${t.id}`));
  await listTickets();
});
bind("ticket-form", async () => {
  await api(`${base()}/tickets`, "POST", {
    title: $("ticket-title").value,
    description: $("ticket-description").value,
    category: $("ticket-category").value,
  });
  $("ticket-form").reset();
  await listTickets();
});
const ticketStateLabels = {
  submitted: "待受理",
  triaged: "已分诊",
  in_progress: "处理中",
  waiting_reporter: "待补充材料",
  resolved: "已解决待确认",
  closed: "已关闭",
  withdrawn: "已撤回",
  rejected: "已拒绝",
  duplicate: "重复",
};
const ticketCategoryLabels = { question: "咨询问题", knowledge: "知识更正" };
const fmtTime = (ms) => new Date(ms).toLocaleString("zh-CN", { hour12: false });
async function listTickets() {
  const tickets = await api(`${base()}/tickets`);
  $("ticket-list").replaceChildren(
    ...tickets.map((t) =>
      button(
        `${ticketCategoryLabels[t.category] ?? t.category}｜${t.title}｜${ticketStateLabels[t.state] ?? t.state}｜${t.owner}｜${fmtTime(t.createdAt)}`,
        () => showTicket(t.id),
      ),
    ),
  );
}
async function showTicket(id) {
  const t = await api(`${base()}/tickets/${id}`),
    area = $("ticket-detail");
  area.replaceChildren(
    el("h2", `${ticketCategoryLabels[t.category] ?? t.category}：${t.title}`),
    el("p", t.description),
    el(
      "p",
      `状态：${ticketStateLabels[t.state] ?? t.state}（${t.state}） · 版本 ${t.version}`,
    ),
    el(
      "p",
      `上报人：${t.owner} · 登记：${fmtTime(t.createdAt)} · 最后更新：${fmtTime(t.updatedAt)}`,
    ),
  );
  if (t.evidence) {
    const evidence = el("details");
    evidence.append(el("summary", "反馈针对的原答案（证据快照）"));
    if (t.evidence.question)
      evidence.append(el("p", `原问题：${t.evidence.question}`));
    evidence.append(
      el("p", `依据知识版本：${t.evidence.releaseId.slice(0, 8)}`, "meta"),
    );
    for (const b of t.evidence.blocks ?? []) {
      evidence.append(el("div", b.text, "pre"));
      if (b.citations?.length)
        evidence.append(el("p", `引用页面：${b.citations.join("、")}`, "meta"));
    }
    area.append(evidence);
  } else if (t.answerId)
    area.append(el("p", `关联答案：${t.answerId}`, "meta"));
  if (t.evidenceWarning)
    area.append(el("p", `注意：${t.evidenceWarning}`, "warning"));
  if (t.comments.length) {
    area.append(el("h3", "处理记录"));
    for (const c of t.comments)
      area.append(
        el(
          "p",
          `${fmtTime(c.at)} · ${c.author}${c.internal ? "（内部备注）" : ""}：${c.text}`,
        ),
      );
  }
  const text = el("textarea");
  text.placeholder = "补充材料、回复或可核验处理结果";
  area.append(text);
  if (currentGrant.role === "admin")
    area.append(
      el(
        "p",
        "处理流程：先分诊受理，再开始处理；需要时向用户请求材料或公开回复。知识更正须先在「知识」页提交修订并发布新版本，然后点“提交解决结果”并填入新版本 ID；用户确认后才关闭。",
        "meta",
      ),
    );
  const actions =
    t.owner === me.subject
      ? [
          ["reply", "补充说明"],
          ["close", "确认解决"],
          ["withdraw", "撤回"],
          ["reopen", "重开"],
        ]
      : [];
  if (currentGrant.role === "admin")
    actions.push(
      ["triage", "分诊（受理）"],
      ["start", "开始处理"],
      ["request_info", "请求用户补充材料"],
      ["reply", "公开回复用户"],
      ["note", "内部备注（仅管理员可见）"],
      ["resolve", "提交解决结果（知识更正须填新版本 ID）"],
      ["merge", "合并为重复工单"],
      ["reject", "拒绝受理（须说明原因）"],
      ["assign", "指定处理人"],
    );
  for (const [action, label] of actions)
    area.append(
      button(label, async () => {
        const releaseId =
          action === "resolve" && t.category === "knowledge"
            ? prompt("实际更正发布版本 ID")
            : undefined;
        const targetId =
          action === "merge"
            ? prompt("目标工单 ID（不会向报告人开放目标内容）")
            : undefined;
        const assignee =
          action === "assign"
            ? prompt("具备本领域管理员资格的处理人账号")
            : undefined;
        if (
          (action === "merge" && !targetId) ||
          (action === "assign" && !assignee)
        )
          return;
        await api(`${base()}/tickets/${id}/actions`, "POST", {
          targetId,
          assignee,
          action,
          expectedVersion: t.version,
          text: text.value || undefined,
          releaseId: releaseId || undefined,
        });
        await showTicket(id);
        await listTickets();
      }),
    );
  const policy = await api(`${base()}/ticket-attachment-policy`);
  if (policy.enabled) {
    area.append(
      el("h3", "工单附件"),
      el(
        "p",
        `仅支持 UTF-8 文本，最大 ${policy.maxBytes} 字节，保存 ${policy.retentionDays} 天；下载前再次验证权限。`,
      ),
    );
    const attachments = await api(`${base()}/tickets/${id}/attachments`);
    for (const a of attachments)
      area.append(
        button(
          `${a.filename}${a.internal ? "（内部）" : ""} · 下载`,
          async () => {
            const response = await fetch(
              `${base()}/tickets/${id}/attachments/${a.id}`,
              { headers: token ? { Authorization: `Bearer ${token}` } : {} },
            );
            if (!response.ok) throw new Error("附件不可读取或已过期");
            const url = URL.createObjectURL(await response.blob()),
              link = el("a");
            link.href = url;
            link.download = a.filename;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          },
        ),
      );
    const file = el("input");
    file.type = "file";
    file.accept = ".txt,text/plain";
    const internal = el("input");
    internal.type = "checkbox";
    area.append(file);
    if (currentGrant.role === "admin") {
      const label = el("label", "内部附件（仅管理员可见）");
      label.append(internal);
      area.append(label);
    }
    area.append(
      button("上传附件", async () => {
        const selected = file.files[0];
        if (!selected) throw new Error("请选择文本附件");
        if (selected.size > policy.maxBytes)
          throw new Error("附件超过大小限制");
        const bytes = new Uint8Array(await selected.arrayBuffer());
        let binary = "";
        for (const b of bytes) binary += String.fromCharCode(b);
        await api(`${base()}/tickets/${id}/attachments`, "POST", {
          filename: selected.name,
          mediaType: "text/plain",
          data: btoa(binary),
          internal: internal.checked,
          expectedVersion: t.version,
        });
        await showTicket(id);
      }),
    );
  }
}
async function listMembers() {
  const members = await api(`${base()}/members`);
  $("member-list").replaceChildren(
    ...members.map((m) =>
      button(
        `${m.subject} · ${m.role} · ${(m.tags ?? []).join(" / ")} · ${m.enabled ? "启用" : "停用"}`,
        () => {
          $("member-subject").value = m.subject;
          $("member-version").value = m.version;
          $("member-role").value = m.role;
          $("member-enabled").checked = m.enabled;
          $("member-business").checked = (m.tags ?? []).includes("business");
          $("member-technical").checked = (m.tags ?? []).includes("technical");
        },
      ),
    ),
  );
}
bind("member-form", async () => {
  await api(
    `${base()}/members/${encodeURIComponent($("member-subject").value)}`,
    "PUT",
    {
      role: $("member-role").value,
      enabled: $("member-enabled").checked,
      tags: [
        $("member-business").checked ? "business" : null,
        $("member-technical").checked ? "technical" : null,
      ].filter(Boolean),
      expectedVersion: Number($("member-version").value),
    },
  );
  await listMembers();
});
bind("revision-form", async () => {
  const page = knowledge.pages.find((p) => p.id === $("revision-page").value);
  await api(`${base()}/revisions`, "POST", {
    title: $("revision-title").value,
    scope: $("revision-scope").value,
    reason: $("revision-reason").value,
    changes: [
      {
        pageId: page.id,
        baseHash: page.hash,
        content: $("revision-content").value,
        source: $("revision-source").value,
      },
    ],
  });
  await listAdmin();
});
bind("release-form", async () => {
  const file = $("bundle").files[0];
  if (file.size > 4 * 1024 * 1024) throw new Error("快照超过 4 MiB 限制");
  await api(`${base()}/submissions`, "POST", JSON.parse(await file.text()));
  await listAdmin();
});
async function listAdmin() {
  const revisions = await api(`${base()}/revisions`);
  $("revision-list").replaceChildren(
    ...revisions.map((r) => {
      const d = el("details"),
        s = el("summary", `${r.title} · ${r.state}`);
      d.append(s, el("div", r.blocker || r.id, "meta"));
      for (const c of r.changes) {
        d.append(
          el("h3", c.pageId),
          el("p", `依据：${c.source}`),
          el(
            "div",
            `原文：\n${r.originalPages?.find((p) => p.id === c.pageId)?.content ?? ""}`,
            "pre",
          ),
          el("div", `拟改：\n${c.content}`, "pre"),
        );
      }
      if (r.state === "draft")
        d.append(
          button("提交来源写回", async () => {
            await api(`${base()}/revisions/${r.id}/submit`, "POST", {
              expectedVersion: r.version,
            });
            await listAdmin();
          }),
        );
      return d;
    }),
  );
  const releases = await api(`${base()}/releases`);
  $("release-list").replaceChildren(
    ...releases.map((r) => {
      const d = el("details");
      d.append(
        el("summary", `${r.id.slice(0, 8)} · ${r.state}`),
        el("div", r.descriptorHash, "meta"),
        el("div", JSON.stringify(r.bundle, null, 2), "pre"),
      );
      if (r.state === "submitted") {
        d.append(
          button("运行金样例问答评估", async () => {
            for (const c of r.bundle.cases) {
              const e = await api(
                `${base()}/releases/${r.id}/evaluations`,
                "POST",
                { caseId: c.id, descriptorHash: r.descriptorHash },
              );
              d.append(el("div", JSON.stringify(e, null, 2), "pre"));
            }
          }),
          button("核对结果并复核", async () => {
            const evidence = prompt(
              "记录事实依据、样本核验结果和支持范围（至少 10 字）",
            );
            if (!evidence) return;
            await api(`${base()}/releases/${r.id}/review`, "POST", {
              expectedVersion: r.version,
              descriptorHash: r.descriptorHash,
              evidence,
              approved: true,
            });
            await listAdmin();
          }),
        );
      }
      if (r.state === "ready")
        d.append(
          button("激活此版本", async () => {
            await api(`${base()}/releases/${r.id}/activate`, "POST", {
              expectedVersion: r.version,
              expectedEpoch: r.baseEpoch,
              expectedActive: r.baseActive,
              descriptorHash: r.descriptorHash,
            });
            await changeDomain();
          }),
        );
      return d;
    }),
  );
}
(async () => {
  const cfg = await (await fetch("/auth/config")).json();
  $("sso").hidden = !cfg.sso;
  $("token-login").hidden = cfg.sso;
  try {
    await login();
  } catch {}
})();
