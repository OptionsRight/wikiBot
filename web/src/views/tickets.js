import { useEffect, useState } from "../../vendor/hooks.module.js";
import { html } from "../html.js";
import { api, base, downloadAttachment } from "../api.js";
import {
  ticketCategoryLabels,
  ticketStateLabels,
  ticketStateVariants,
  fmtTime,
} from "../labels.js";
import {
  Badge,
  DialogForm,
  EmptyState,
  icons,
  Spinner,
  toast,
  toastError,
} from "../ui.js";

const dialogSpecs = {
  resolve: (t) => ({
    title: "提交解决结果",
    description:
      "知识更正须先在「管理 → 知识发布」提交修订并发布新版本，然后填入实际更正的发布版本 ID。",
    fields: [
      {
        name: "releaseId",
        label: "实际更正发布版本 ID",
        required: t.category === "knowledge",
        placeholder: "例如 d56cb6fe-4911-4e39-a863-c67c0ba4f515",
      },
    ],
    confirm: "提交解决结果",
  }),
  merge: () => ({
    title: "合并为重复工单",
    description: "目标工单不会向报告人开放本工单内容。",
    fields: [{ name: "targetId", label: "目标工单 ID", required: true }],
    confirm: "合并",
  }),
  assign: () => ({
    title: "指定处理人",
    fields: [
      {
        name: "assignee",
        label: "具备本领域管理员资格的处理人账号",
        required: true,
      },
    ],
    confirm: "指定",
  }),
};

export default function Tickets({
  domain,
  me,
  grant,
  dataVersion,
  ticketsVersion,
  initialTicketId,
  onInitialTicketConsumed,
}) {
  const [tickets, setTickets] = useState(null);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selected, setSelected] = useState(null);
  const [attachments, setAttachments] = useState(null);
  const [policy, setPolicy] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [creating, setCreating] = useState(false);
  const isAdmin = grant?.role === "admin";

  const refresh = () =>
    api(`${base(domain)}/tickets`)
      .then(setTickets)
      .catch(toastError);

  useEffect(() => {
    setTickets(null);
    setSelected(null);
    refresh();
  }, [domain, dataVersion, ticketsVersion]);

  useEffect(() => {
    if (initialTicketId) {
      openTicket(initialTicketId);
      onInitialTicketConsumed?.();
    }
  }, [initialTicketId]);

  const openTicket = async (id) => {
    setAttachments(null);
    try {
      const t = await api(`${base(domain)}/tickets/${id}`);
      setSelected(t);
      const p = await api(`${base(domain)}/ticket-attachment-policy`);
      setPolicy(p);
      if (p.enabled)
        setAttachments(await api(`${base(domain)}/tickets/${id}/attachments`));
    } catch (e) {
      toastError(e);
    }
  };
  const closeTicket = () => {
    setSelected(null);
    if (location.hash.includes("ticket=")) location.hash = "";
  };

  const runAction = async (t, action, text) => {
    const spec =
      action === "resolve" && t.category !== "knowledge"
        ? undefined
        : dialogSpecs[action];
    if (spec) {
      setDialog({ ...spec(t), t, action, text });
      return;
    }
    await submitAction(t, action, text, {});
  };
  const submitAction = async (t, action, text, extra) => {
    try {
      await api(`${base(domain)}/tickets/${t.id}/actions`, "POST", {
        targetId: extra.targetId,
        assignee: extra.assignee,
        action,
        expectedVersion: t.version,
        text: text || undefined,
        releaseId: extra.releaseId,
      });
      toast("操作已提交", "ok");
      await openTicket(t.id);
      refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setDialog(null);
    }
  };
  const createTicket = async (values) => {
    try {
      await api(`${base(domain)}/tickets`, "POST", {
        title: values.title,
        description: values.description,
        category: values.category,
      });
      setCreating(false);
      toast("问题已登记", "ok");
      refresh();
    } catch (e) {
      toastError(e);
    }
  };
  const upload = async (t, input, internal) => {
    const file = input.files[0];
    if (!file) return toast("请选择文本附件");
    if (file.size > policy.maxBytes) return toast("附件超过大小限制");
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    try {
      await api(`${base(domain)}/tickets/${t.id}/attachments`, "POST", {
        filename: file.name,
        mediaType: "text/plain",
        data: btoa(binary),
        internal,
        expectedVersion: t.version,
      });
      toast("附件已上传", "ok");
      openTicket(t.id);
    } catch (e) {
      toastError(e);
    }
  };

  const keyword = query.trim().toLowerCase();
  const visible = (tickets ?? []).filter(
    (t) =>
      (!stateFilter || t.state === stateFilter) &&
      (!ownerFilter || t.owner === ownerFilter) &&
      (!keyword || t.title.toLowerCase().includes(keyword)),
  );
  const owners = [...new Set((tickets ?? []).map((t) => t.owner))].sort();
  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = visible.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const changeFilter = (setter) => (e) => {
    setter(e.target.value);
    setPage(1);
  };

  return html`<div class="tickets-view">
    <div class="tickets-toolbar">
      <input
        class="ticket-search"
        type="search"
        placeholder="搜索标题"
        value=${query}
        onInput=${(e) => {
          setQuery(e.target.value);
          setPage(1);
        }}
      />
      <label class="filter-item">
        上报人
        <select value=${ownerFilter} onChange=${changeFilter(setOwnerFilter)}>
          <option value="">全部</option>
          ${owners.map((o) => html`<option key=${o} value=${o}>${o}</option>`)}
        </select>
      </label>
      <label class="filter-item">
        状态
        <select value=${stateFilter} onChange=${changeFilter(setStateFilter)}>
          <option value="">全部</option>
          ${Object.entries(ticketStateLabels).map(
            ([value, label]) =>
              html`<option key=${value} value=${value}>${label}</option>`,
          )}
        </select>
      </label>
      <span class="spacer"></span>
      <button
        type="button"
        class="btn btn-soft btn-s"
        onClick=${() => setCreating(true)}
      >
        登记新问题
      </button>
    </div>
    <div class="card ticket-table">
      ${
        tickets === null
          ? html`<div class="member-loading">
              <${Spinner} /><span class="muted">正在加载工单…</span>
            </div>`
          : visible.length === 0
            ? html`<${EmptyState}
                >${
                  keyword || stateFilter || ownerFilter
                    ? "没有符合筛选条件的工单"
                    : "还没有登记过问题，点击右上角「登记新问题」开始"
                }<//
              >`
            : html`<div class="ticket-thead">
                  <span>标题</span><span>类型</span><span>状态</span>
                </div>
                ${pageItems.map((t) => {
                  return html`<button
                    key=${t.id}
                    type="button"
                    class="ticket-tr ${selected?.id === t.id ? "selected" : ""}"
                    onClick=${() => openTicket(t.id)}
                  >
                    <span class="ticket-title-cell">
                      <span class="ticket-title">${t.title}</span>
                      <span class="row-sub"
                        >${t.owner} · ${fmtTime(t.updatedAt)}</span
                      >
                    </span>
                    <span class="ticket-type"
                      >${ticketCategoryLabels[t.category] ?? t.category}</span
                    >
                    <span class="ticket-state">
                      <${Badge}
                        variant=${ticketStateVariants[t.state] ?? "neutral"}
                        >${ticketStateLabels[t.state] ?? t.state}<//
                      >
                    </span>
                  </button>`;
                })}`
      }
    </div>
    ${
      tickets !== null &&
      visible.length > 0 &&
      html`<div class="pager">
        <span class="meta">共 ${visible.length} 条</span>
        <span class="spacer"></span>
        <label class="filter-item">
          每页
          <select
            value=${String(pageSize)}
            onChange=${(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
          >
            ${[10, 20, 50].map(
              (n) => html`<option key=${n} value=${String(n)}>${n} 条</option>`,
            )}
          </select>
        </label>
        <button
          type="button"
          class="btn btn-ghost btn-s pager-btn"
          disabled=${currentPage <= 1}
          aria-label="上一页"
          onClick=${() => setPage(currentPage - 1)}
        >
          ‹
        </button>
        <span class="meta">第 ${currentPage} / ${totalPages} 页</span>
        <button
          type="button"
          class="btn btn-ghost btn-s pager-btn"
          disabled=${currentPage >= totalPages}
          aria-label="下一页"
          onClick=${() => setPage(currentPage + 1)}
        >
          ›
        </button>
      </div>`
    }
    ${
      selected &&
      html`<${TicketDrawer}
        t=${selected}
        me=${me}
        isAdmin=${isAdmin}
        attachments=${attachments}
        policy=${policy}
        onClose=${closeTicket}
        onAction=${runAction}
        onUpload=${upload}
      />`
    }
    ${
      creating &&
      html`<${DialogForm}
        title="登记新问题"
        fields=${[
          { name: "title", label: "标题", required: true },
          {
            name: "category",
            label: "类型",
            type: "select",
            options: [
              { value: "question", label: "咨询问题" },
              { value: "knowledge", label: "知识更正" },
            ],
          },
          {
            name: "description",
            label: "说明",
            textarea: true,
            required: true,
            minlength: 5,
          },
        ]}
        confirm="登记"
        onSubmit=${createTicket}
        onCancel=${() => setCreating(false)}
      />`
    }
    ${
      dialog &&
      html`<${DialogForm}
        title=${dialog.title}
        description=${dialog.description}
        fields=${dialog.fields}
        confirm=${dialog.confirm}
        onSubmit=${(values) =>
          submitAction(dialog.t, dialog.action, dialog.text, values)}
        onCancel=${() => setDialog(null)}
      />`
    }
  </div>`;
}

function TicketDrawer({
  t,
  me,
  isAdmin,
  attachments,
  policy,
  onClose,
  onAction,
  onUpload,
}) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !document.querySelector(".modal-backdrop"))
        onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  const [text, setText] = useState("");
  const [internal, setInternal] = useState(false);
  let fileInput = null;
  const ownerActions = [
    ["reply", "补充说明"],
    ["close", "确认解决"],
    ["withdraw", "撤回"],
    ["reopen", "重开"],
  ];
  const adminActions = [
    ["triage", "分诊（受理）"],
    ["start", "开始处理"],
    ["request_info", "请求用户补充材料"],
    ["reply", "公开回复用户"],
    ["note", "内部备注（仅管理员可见）"],
    ["resolve", "提交解决结果"],
    ["merge", "合并为重复工单"],
    ["reject", "拒绝受理（须说明原因）"],
    ["assign", "指定处理人"],
  ];
  return html`<div
    class="drawer-backdrop"
    onMouseDown=${(e) => {
      if (e.target === e.currentTarget) onClose();
    }}
  >
    <aside class="drawer" role="dialog" aria-label="工单详情">
      <div class="drawer-head">
        <h2 class="drawer-title">${t.title}</h2>
        <button
          type="button"
          class="btn btn-ghost btn-s drawer-close"
          onClick=${onClose}
        >
          ${icons.close()}关闭
        </button>
      </div>
      <div class="detail-head">
        <${Badge} variant="info"
          >${ticketCategoryLabels[t.category] ?? t.category}<//
        >
        <${Badge} variant=${ticketStateVariants[t.state] ?? "neutral"}
          >${ticketStateLabels[t.state] ?? t.state}<//
        >
      </div>
      <div class="meta-line">
        <span>上报人：${t.owner}</span>
        <span>登记：${fmtTime(t.createdAt)}</span>
        <span>最后更新：${fmtTime(t.updatedAt)}</span>
        <span class="mono">版本 ${t.version}</span>
      </div>
      <p class="detail-desc">${t.description}</p>
      ${
        t.evidence
          ? html`<details>
              <summary>反馈针对的原答案（证据快照）</summary>
              ${t.evidence.question && html`<p>原问题：${t.evidence.question}</p>`}
              <p class="meta mono">
                依据知识版本：${t.evidence.releaseId.slice(0, 8)}
              </p>
              ${(t.evidence.blocks ?? []).map((b, i) => {
                return html`<div key=${i}>
                  <div class="pre">${b.text}</div>
                  ${
                    b.citations?.length &&
                    html`<p class="meta">
                      引用页面：${b.citations.join("、")}
                    </p>`
                  }
                </div>`;
              })}
            </details>`
          : t.answerId && html`<p class="meta mono">关联答案：${t.answerId}</p>`
      }
      ${
        t.evidenceWarning &&
        html`<div class="callout c-warn">注意：${t.evidenceWarning}</div>`
      }
      ${
        t.comments.length > 0 &&
        html`<div class="group-title">处理记录</div>
          <div class="timeline">
            ${t.comments.map((c, i) => {
              return html`<div key=${i} class="tl-item">
                <div class="tl-meta">
                  <span class="mono">${fmtTime(c.at)} · ${c.author}</span>
                  ${c.internal && html`<${Badge} variant="warn">内部备注<//>`}
                </div>
                <div class="tl-text">${c.text}</div>
              </div>`;
            })}
          </div>`
      }
      <div class="ticket-actions">
        <div class="group-title">处理说明（可选，随下方操作一起提交）</div>
        <textarea
          class="action-text"
          placeholder="补充材料、回复或可核验处理结果"
          value=${text}
          onInput=${(e) => setText(e.target.value)}
        ></textarea>
        ${
          t.owner === me.subject &&
          html`<div class="group-title">你的操作</div>
            <div class="btn-row">
              ${ownerActions.map(([action, label]) => {
                return html`<button
                  key=${action}
                  type="button"
                  class="btn btn-soft btn-s"
                  onClick=${() => onAction(t, action, text)}
                >
                  ${label}
                </button>`;
              })}
            </div>`
        }
        ${
          isAdmin &&
          html`<div class="group-title">管理员处理</div>
            <p class="meta">
              处理流程：先分诊受理，再开始处理；需要时向用户请求材料或公开回复。知识更正须先发布新版本，再提交解决结果；用户确认后才关闭。
            </p>
            <div class="btn-row">
              ${adminActions.map(([action, label]) => {
                return html`<button
                  key=${action}
                  type="button"
                  class=${
                    action === "reject"
                      ? "btn btn-danger btn-s"
                      : "btn btn-soft btn-s"
                  }
                  onClick=${() => onAction(t, action, text)}
                >
                  ${label}
                </button>`;
              })}
            </div>`
        }
        ${
          policy?.enabled &&
          html`<div>
            <div class="group-title">工单附件</div>
            <p class="meta">
              仅支持 UTF-8 文本，最大 ${policy.maxBytes} 字节，保存
              ${policy.retentionDays} 天；下载前再次验证权限。
            </p>
            ${(attachments ?? []).map((a) => {
              return html`<div key=${a.id} class="attach-row">
                <span class="name">${a.filename}</span>
                ${a.internal && html`<${Badge} variant="warn">内部<//>`}
                <button
                  type="button"
                  class="btn btn-ghost btn-s"
                  onClick=${() =>
                    downloadAttachment(
                      `${base(t.domain)}/tickets/${t.id}/attachments/${a.id}`,
                      a.filename,
                    ).catch(toastError)}
                >
                  下载
                </button>
              </div>`;
            })}
            <div class="attach-row">
              <input
                type="file"
                accept=".txt,text/plain"
                ref=${(node) => (fileInput = node)}
              />
              ${
                isAdmin &&
                html`<label class="field check">
                  <input
                    type="checkbox"
                    checked=${internal}
                    onChange=${(e) => setInternal(e.target.checked)}
                  />内部附件（仅管理员可见）
                </label>`
              }
              <button
                type="button"
                class="btn btn-soft btn-s"
                onClick=${() => onUpload(t, fileInput, internal)}
              >
                上传附件
              </button>
            </div>
          </div>`
        }
      </div>
    </aside>
  </div>`;
}
