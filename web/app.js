const $ = (id) => document.getElementById(id);
let token = "",
  me,
  domain = "",
  knowledge,
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
  $("answer").replaceChildren();
  try {
    await changeDomain();
  } catch (e) {
    error(e);
  }
};
async function changeDomain() {
  const grant = await api(`${base()}/capabilities`);
  $("admin-nav").hidden = grant.role !== "admin";
  const pref = await api(`${base()}/preferences`);
  prefVersion = pref.version;
  $("style").value = pref.style;
  $("depth").value = pref.depth;
  try {
    knowledge = await api(`${base()}/knowledge`);
  } catch (e) {
    knowledge = { pages: [], procedures: [] };
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
  $("procedure").replaceChildren(
    ...knowledge.procedures.map((p) => {
      const o = el("option", p.title);
      o.value = p.id;
      return o;
    }),
  );
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
  renderInputs();
}
function renderInputs() {
  const p = knowledge.procedures.find((p) => p.id === $("procedure").value);
  $("inputs").replaceChildren(
    ...(p?.inputs ?? []).map((f) => {
      const label = el("label", f.question),
        select = el("select");
      select.dataset.field = f.id;
      select.append(el("option", "请选择"));
      select.firstChild.value = "";
      for (const v of f.values) {
        const o = el("option", String(v));
        o.value = JSON.stringify(v);
        select.append(o);
      }
      label.append(select);
      return label;
    }),
  );
}
$("procedure").onchange = renderInputs;
$("object").onchange = renderInputs;
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
  const inputs = {};
  for (const s of $("inputs").querySelectorAll("select"))
    if (s.value) inputs[s.dataset.field] = JSON.parse(s.value);
  const a = await api(`${base()}/answers`, "POST", {
    question: $("question").value,
    procedureId: $("procedure").value || undefined,
    sessionId: session,
    objectId: $("object").value || undefined,
    inputs,
    mode: $("mode").value,
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
bind("feedback", async () => {
  const t = await api(`${base()}/tickets`, "POST", {
    title: "答案反馈",
    description: $("feedback-text").value,
    category: "knowledge",
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
async function listTickets() {
  const tickets = await api(`${base()}/tickets`);
  $("ticket-list").replaceChildren(
    ...tickets.map((t) =>
      button(`${t.title} · ${t.state}`, () => showTicket(t.id)),
    ),
  );
}
async function showTicket(id) {
  const t = await api(`${base()}/tickets/${id}`),
    area = $("ticket-detail");
  area.replaceChildren(
    el("h2", t.title),
    el("p", t.description),
    el("p", `状态 ${t.state} · 版本 ${t.version}`),
  );
  for (const c of t.comments)
    area.append(
      el("p", `${c.internal ? "内部备注 · " : ""}${c.author}：${c.text}`),
    );
  const text = el("textarea");
  text.placeholder = "补充材料、回复或可核验处理结果";
  area.append(text);
  const actions =
    t.owner === me.subject
      ? [
          ["reply", "补充"],
          ["close", "确认解决"],
          ["withdraw", "撤回"],
          ["reopen", "重开"],
        ]
      : [
          ["triage", "分诊"],
          ["start", "开始处理"],
          ["request_info", "请求材料"],
          ["reply", "公开回复"],
          ["note", "内部备注"],
          ["resolve", "提交解决结果"],
        ];
  for (const [action, label] of actions)
    area.append(
      button(label, async () => {
        const releaseId =
          action === "resolve" && t.category === "knowledge"
            ? prompt("实际更正发布版本 ID")
            : undefined;
        await api(`${base()}/tickets/${id}/actions`, "POST", {
          action,
          expectedVersion: t.version,
          text: text.value || undefined,
          releaseId: releaseId || undefined,
        });
        await showTicket(id);
        await listTickets();
      }),
    );
}
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
          button("运行固定回归样本", async () => {
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
