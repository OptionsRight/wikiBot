import { useEffect, useState } from "../vendor/hooks.module.js";
import { html } from "./html.js";

/* ---------- 图标（内联 SVG，描边风格） ---------- */
const icon =
  (paths, extras = "") =>
  (cls) =>
    html`<svg
      class="icon ${cls ?? ""}"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML=${{ __html: paths + extras }}
    ></svg>`;
export const icons = {
  ask: icon(
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  ),
  tickets: icon(
    '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><path d="m4.9 4.9 2.8 2.8"/><path d="m14.3 14.3 2.8 2.8"/><path d="m14.3 9.7 2.8-2.8"/><path d="m4.9 19.1 2.8-2.8"/>',
  ),
  knowledge: icon(
    '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  ),
  admin: icon(
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  ),
  access: icon(
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  ),
  style: icon(
    '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>',
  ),
  logout: icon(
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  ),
  plus: icon('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  refresh: icon(
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  ),
  download: icon(
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  ),
  upload: icon(
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  ),
  check: icon('<path d="M20 6 9 17l-5-5"/>'),
  close: icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  alert: icon(
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  ),
  logo: icon(
    '<path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/>',
  ),
};

/* ---------- 轻提示 ---------- */
let toastSeq = 0,
  toasts = [];
const toastListeners = new Set();
const emitToasts = () => {
  for (const fn of toastListeners) fn();
};
export function toast(text, variant = "danger") {
  const id = ++toastSeq;
  toasts = [...toasts, { id, text, variant }];
  emitToasts();
  setTimeout(
    () => {
      toasts = toasts.filter((t) => t.id !== id);
      emitToasts();
    },
    variant === "danger" ? 8000 : 3500,
  );
}
export function toastError(e) {
  toast(e?.message || String(e), "danger");
}
export function ToastStack() {
  const [, update] = useState(0);
  useEffect(() => {
    const fn = () => update((n) => n + 1);
    toastListeners.add(fn);
    return () => toastListeners.delete(fn);
  }, []);
  return html`<div class="toast-stack">
    ${toasts.map(
      (t) =>
        html`<div key=${t.id} class="toast t-${t.variant}">
          ${t.variant === "danger" ? icons.alert() : icons.check()}<span
            >${t.text}</span
          >
        </div>`,
    )}
  </div>`;
}

/* ---------- 通用组件 ---------- */
export function Badge({ variant = "neutral", dot = true, children }) {
  return html`<span class="badge b-${variant}"
    >${
      dot && html`<span class="badge-dot" aria-hidden="true"></span>`
    }${children}</span
  >`;
}
export function Card({ title, sub, actions, children, className }) {
  return html`<div class="card ${className ?? ""}">
    ${
      (title || actions) &&
      html`<div class="card-head">
        <div class="card-head-main">
          <div class="card-title">${title}</div>
          ${sub && html`<div class="card-sub">${sub}</div>`}
        </div>
        ${actions && html`<div class="card-actions btn-row">${actions}</div>`}
      </div>`
    }
    ${children}
  </div>`;
}
export function PageHead({ title, sub, actions }) {
  return html`<div class="page-head">
    <div class="page-head-main">
      <h1>${title}</h1>
      ${sub && html`<p class="muted">${sub}</p>`}
    </div>
    ${actions && html`<div class="page-actions">${actions}</div>`}
  </div>`;
}
export function EmptyState({ children }) {
  return html`<div class="empty">
    ${icons.alert()}
    <div>${children}</div>
  </div>`;
}
export function Spinner() {
  return html`<span class="spinner" aria-label="加载中"></span>`;
}
export function DialogForm({
  title,
  description,
  fields,
  confirm = "确定",
  danger = false,
  onSubmit,
  onCancel,
}) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  const submit = (e) => {
    e.preventDefault();
    const data = new FormData(e.target),
      values = {};
    for (const f of fields)
      values[f.name] =
        f.type === "checkbox"
          ? data.get(f.name) === "on"
          : String(data.get(f.name) ?? "").trim();
    onSubmit(values);
  };
  return html`<div
    class="modal-backdrop"
    onMouseDown=${(e) => {
      if (e.target === e.currentTarget) onCancel();
    }}
  >
    <div class="modal">
      <form
        onSubmit=${submit}
        ref=${(node) => node && node.querySelector("input, textarea")?.focus()}
      >
        <h2 class="modal-title">${title}</h2>
        ${description && html`<p class="modal-desc">${description}</p>`}
        ${fields.map(
          (f) =>
            html`${
              f.type === "checkbox"
                ? html`<label class="field check">
                    <input
                      type="checkbox"
                      name=${f.name}
                      checked=${!!f.value}
                    />
                    ${f.label}
                  </label>`
                : html`<label class="field">
                    ${f.label}
                    ${
                      f.type === "select"
                        ? html`<select name=${f.name} required=${f.required}>
                            ${(f.options ?? []).map(
                              (o) =>
                                html`<option value=${o.value}>
                                  ${o.label}
                                </option>`,
                            )}
                          </select>`
                        : f.textarea
                          ? html`<textarea
                              name=${f.name}
                              placeholder=${f.placeholder || ""}
                              required=${f.required}
                              minlength=${f.minlength || undefined}
                            >
${f.value || ""}</textarea>`
                          : html`<input
                              name=${f.name}
                              placeholder=${f.placeholder || ""}
                              required=${f.required}
                              value=${f.value || ""}
                            />`
                    }
                  </label>`
            }`,
        )}
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" onClick=${onCancel}>
            取消
          </button>
          <button
            type="submit"
            class=${danger ? "btn btn-danger" : "btn btn-primary"}
          >
            ${confirm}
          </button>
        </div>
      </form>
    </div>
  </div>`;
}
