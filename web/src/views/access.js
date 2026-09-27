import { useEffect, useState } from "../../vendor/hooks.module.js";
import { html } from "../html.js";
import { api, base } from "../api.js";
import { DialogForm, EmptyState, Spinner, toast, toastError } from "../ui.js";

const TAGS = [
  ["business", "业务"],
  ["technical", "技术"],
];

export default function Members({ domain, dataVersion }) {
  const [members, setMembers] = useState(null);
  const [saving, setSaving] = useState("");
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const reload = () =>
    api(`${base(domain)}/members`)
      .then(setMembers)
      .catch(toastError);
  useEffect(() => {
    setMembers(null);
    reload();
  }, [domain, dataVersion]);

  const patch = async (m, changes) => {
    if (saving) return;
    setSaving(m.subject);
    try {
      const updated = await api(
        `${base(domain)}/members/${encodeURIComponent(m.subject)}`,
        "PUT",
        {
          role: m.role,
          enabled: m.enabled,
          tags: m.tags ?? [],
          expectedVersion: m.version,
          ...changes,
        },
      );
      setMembers((list) =>
        list.map((x) => (x.subject === updated.subject ? updated : x)),
      );
      toast("已保存", "ok");
    } catch (e) {
      if (e.message === "VERSION_CONFLICT")
        toast("该成员配置刚被其他管理员更新，已重新加载，请重试一次");
      else toastError(e);
      reload();
    } finally {
      setSaving("");
    }
  };
  const toggleTag = (m, tag) =>
    patch(m, {
      tags: (m.tags ?? []).includes(tag)
        ? (m.tags ?? []).filter((t) => t !== tag)
        : [...(m.tags ?? []), tag],
    });

  const addMember = async (values) => {
    try {
      const created = await api(
        `${base(domain)}/members/${encodeURIComponent(values.subject)}`,
        "PUT",
        {
          role: values.role,
          enabled: true,
          tags: [
            values.business ? "business" : null,
            values.technical ? "technical" : null,
          ].filter(Boolean),
          expectedVersion: 0,
        },
      );
      setMembers((list) => [...list, created]);
      setAdding(false);
      setQuery("");
      setPage(Math.max(1, Math.ceil((members?.length ?? 0) + 1) / pageSize));
      toast("成员已添加", "ok");
    } catch (e) {
      toast(
        e.message === "VERSION_CONFLICT"
          ? "该账号已是领域成员，列表已刷新"
          : e.message,
      );
      reload();
    }
  };

  const keyword = query.trim().toLowerCase();
  const visible = (members ?? []).filter((m) =>
    m.subject.toLowerCase().includes(keyword),
  );
  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = visible.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  return html`<div class="members-view">
    <div class="member-toolbar">
      <input
        class="member-search"
        type="search"
        placeholder="搜索账号"
        value=${query}
        onInput=${(e) => {
          setQuery(e.target.value);
          setPage(1);
        }}
      />
      <button
        type="button"
        class="btn btn-soft btn-s"
        onClick=${() => setAdding(true)}
      >
        添加成员
      </button>
    </div>
    <div class="card member-table">
      ${
        members === null
          ? html`<div class="member-loading">
              <${Spinner} /><span class="muted">正在加载成员…</span>
            </div>`
          : html`<div class="member-thead">
                <span>账号</span><span>角色</span><span>标签</span
                ><span>状态</span>
              </div>
              ${
                visible.length === 0
                  ? html`<${EmptyState}
                      >${
                        keyword
                          ? `没有匹配「${query.trim()}」的成员`
                          : "还没有领域成员，点击右上角「添加成员」开始"
                      }<//
                    >`
                  : pageItems.map((m) => {
                      const busy = saving === m.subject;
                      return html`<div key=${m.subject} class="member-tr">
                        <span class="member-name mono">${m.subject}</span>
                        <label class="role-select">
                          <select
                            aria-label="角色"
                            disabled=${busy}
                            value=${m.role}
                            onChange=${(e) => patch(m, { role: e.target.value })}
                          >
                            <option value="member">普通成员</option>
                            <option value="admin">知识管理员</option>
                          </select>
                        </label>
                        <span class="tag-group">
                          ${TAGS.map(([tag, label]) => {
                            const on = (m.tags ?? []).includes(tag);
                            return html`<button
                              key=${tag}
                              type="button"
                              aria-label=${`标签：${label}`}
                              class=${on ? "chip toggle on" : "chip toggle"}
                              disabled=${busy}
                              onClick=${() => toggleTag(m, tag)}
                            >
                              ${label}
                            </button>`;
                          })}
                          ${busy && html`<${Spinner} />`}
                        </span>
                        <label class="switch member-status">
                          <input
                            type="checkbox"
                            aria-label="启用领域资格"
                            checked=${m.enabled}
                            disabled=${busy}
                            onChange=${(e) =>
                              patch(m, { enabled: e.target.checked })}
                          />
                          <span class="track" aria-hidden="true"></span>
                          <span class="switch-label"
                            >${m.enabled ? "启用" : "停用"}</span
                          >
                        </label>
                      </div>`;
                    })
              }`
      }
    </div>
    ${
      members !== null &&
      visible.length > 0 &&
      html`<div class="pager">
        <span class="meta">共 ${visible.length} 人</span>
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
              (n) => html`<option key=${n} value=${String(n)}>${n} 人</option>`,
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
      adding &&
      html`<${DialogForm}
        title="添加成员"
        description="输入成员账号并设置初始角色与表达标签，保存后可随时调整。"
        fields=${[
          {
            name: "subject",
            label: "成员账号",
            required: true,
            placeholder: "例如 zhang.san",
          },
          {
            name: "role",
            label: "角色",
            type: "select",
            options: [
              { value: "member", label: "普通成员" },
              { value: "admin", label: "知识管理员" },
            ],
          },
          { name: "business", label: "业务标签", type: "checkbox" },
          { name: "technical", label: "技术标签", type: "checkbox" },
        ]}
        confirm="添加"
        onSubmit=${addMember}
        onCancel=${() => setAdding(false)}
      />`
    }
  </div>`;
}
