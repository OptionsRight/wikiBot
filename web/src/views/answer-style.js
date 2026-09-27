import { useEffect, useState } from "../../vendor/hooks.module.js";
import { html } from "../html.js";
import { api, base } from "../api.js";
import { Badge, Spinner, toast, toastError } from "../ui.js";

const fieldLabels = {
  business: "业务",
  technical: "技术",
  beginner: "入门",
  experienced: "熟练",
};
const fields = Object.keys(fieldLabels);
const errors = {
  BASELINE_STALE: "知识版本已变化。请重新加载，再基于当前版本保存并预览。",
  VERSION_CONFLICT: "另一位管理员更新了草稿，请重新加载后再修改。",
  STYLE_ANSWER_CASE_REQUIRED: "请先配置至少一道有预期依据的问答样例。",
  STYLE_CASE_LIMIT_EXCEEDED:
    "当前样例数量过多，无法加入四种表达对比，请先整理样例。",
  MODEL_REVALIDATION_REQUIRED: "模型待复核，暂时不能生成预览或发布。",
  KNOWLEDGE_UNAVAILABLE: "请先发布知识，再配置回答话术。",
  FORBIDDEN: "需要当前领域的知识管理员权限。",
  EVALUATION_REQUIRED: "样例检查尚未全部通过，请查看结果后重试。",
  EVALUATION_FAILED: "模型未能完成本次检查，请重试。",
};

const latestIn = (list, id) =>
  list
    .filter((r) => r.caseId === id)
    .sort((a, b) => (b.attempt ?? 0) - (a.attempt ?? 0))[0];
const canPublishWith = (s, list, dirtyNow) => {
  const c = s?.candidate;
  return (
    !dirtyNow &&
    c &&
    c.baseActive === s.active.id &&
    ["submitted", "ready"].includes(c.state) &&
    c.caseIds.length === 4 &&
    c.caseIds.every((id) => latestIn(list, id)?.verdict === "pass")
  );
};

export default function AnswerStyle({
  domain,
  grant,
  dataVersion,
  onPublished,
}) {
  const [state, setState] = useState(undefined);
  const [runs, setRuns] = useState([]);
  const [templates, setTemplates] = useState({});
  const [caseId, setCaseId] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ text: "", variant: "info" });
  const [evidence, setEvidence] = useState("");
  const [confirmChecked, setConfirmChecked] = useState(false);
  const root = () => base(domain);
  const isAdmin = grant?.role === "admin";

  const latest = (id) => latestIn(runs, id);
  const canPublish = () => canPublishWith(state, runs, dirty);

  const load = async () => {
    const next = await api(`${root()}/answer-style`);
    const nextRuns = next.candidate
      ? await api(`${root()}/releases/${next.candidate.id}/evaluations`)
      : [];
    setState(next);
    setRuns(nextRuns);
    setDirty(false);
    const draftCurrent = next.draft?.baseReleaseId === next.active.id;
    const values = draftCurrent
      ? next.draft.templates
      : (next.publishedTemplates ?? next.recommendedTemplates);
    setTemplates({ ...values });
    setCaseId(draftCurrent ? next.draft.caseId : (next.cases[0]?.id ?? ""));
    setConfirmChecked(false);
    setEvidence("");
    if (next.candidate?.state === "active")
      setStatus({
        text: "当前已启用这套话术，新问题会根据用户偏好选择表达方式。",
        variant: "info",
      });
    else if (next.draft && !draftCurrent)
      setStatus({
        text: "知识版本已更新。表单已载入当前话术，旧草稿与预览不能直接发布，请重新保存并预览。",
        variant: "warn",
      });
    else if (draftCurrent)
      setStatus({
        text: "已载入保存的草稿，尚未对用户生效。请对比四种回答后发布。",
        variant: "info",
      });
    else
      setStatus({
        text: next.publishedTemplates
          ? "当前已启用自定义话术。修改后需要预览并发布。"
          : "当前仅按视角和深度标签回答。已为你填入推荐话术，预览并发布后生效。",
        variant: "info",
      });
    return next;
  };

  useEffect(() => {
    if (!isAdmin) return;
    load().catch((e) => {
      const text =
        e.message === "KNOWLEDGE_UNAVAILABLE"
          ? "请先发布知识，再配置回答话术。"
          : `无法载入话术配置：${e.message}`;
      setStatus({ text, variant: "warn" });
      toast(text, "danger");
    });
  }, [domain, dataVersion, isAdmin]);

  const markDirty = () => {
    setDirty(true);
    setConfirmChecked(false);
    setStatus({
      text: "有未保存的修改。已有预览不会包含这些修改，请重新保存并预览后发布。",
      variant: "warn",
    });
  };
  const save = async () => {
    if (!state) throw new Error("请重新加载当前知识版本。");
    const values = Object.fromEntries(
      fields.map((f) => [f, (templates[f] ?? "").trim()]),
    );
    if (Object.values(values).some((text) => !text))
      throw new Error("请填写全部四段话术，内容不能只有空格。");
    const draft = await api(`${root()}/answer-style/draft`, "PUT", {
      expectedVersion: state.draft?.version ?? 0,
      baseReleaseId: state.active.id,
      templates: values,
      caseId,
    });
    const next = { ...state, draft, candidate: null };
    setState(next);
    setRuns([]);
    setDirty(false);
    setStatus({
      text: "话术草稿已保存，机器人仍使用已发布版本。下一步可预览四种回答。",
      variant: "ok",
    });
    return next;
  };
  const preview = async () => {
    let s = state,
      list = runs,
      dirtyNow = dirty;
    if (dirtyNow || !s?.draft || s.draft.baseReleaseId !== s.active.id) {
      s = await save();
      dirtyNow = false;
    }
    if (!s.candidate || !["submitted", "ready"].includes(s.candidate.state)) {
      await api(`${root()}/answer-style/submissions`, "POST", {
        expectedVersion: s.draft.version,
      });
      s = await load();
      // 新候选版本的评估从零开始；闭包里的旧 runs 属于上一个候选，不能复用
      list = [];
    }
    const c = s.candidate;
    for (let i = 0; i < c.caseIds.length; i++) {
      const id = c.caseIds[i];
      if (latestIn(list, id)?.verdict === "pass") continue;
      setStatus({
        text: `正在生成第 ${i + 1} / 4 种回答，请稍候…`,
        variant: "info",
      });
      const run = await api(`${root()}/releases/${c.id}/evaluations`, "POST", {
        caseId: id,
        descriptorHash: c.descriptorHash,
      });
      list = [...list, run];
      setRuns(list);
    }
    const ok = canPublishWith(s, list, dirtyNow);
    setStatus({
      text: ok
        ? "四种回答已生成，引用检查通过。请核对事实与表达效果后，在下方填写复核说明并发布。"
        : "部分预览未通过检查，暂时不能发布。可查看结果后再次生成，或修改话术。",
      variant: ok ? "ok" : "warn",
    });
  };
  const publish = async () => {
    let s = state,
      list = runs;
    let c = s.candidate;
    if (c.state === "submitted") {
      for (let i = 0; i < c.cases.length; i++) {
        const sample = c.cases[i];
        if (latest(sample.id)?.verdict === "pass") continue;
        setStatus({
          text: `正在检查知识样例 ${i + 1} / ${c.cases.length}，全部通过后才会发布…`,
          variant: "info",
        });
        const result = await api(
          `${root()}/releases/${c.id}/evaluations`,
          "POST",
          { caseId: sample.id, descriptorHash: c.descriptorHash },
        );
        list = [...list, result];
        setRuns(list);
        if (result.verdict !== "pass")
          throw new Error(
            `样例“${sample.question}”检查未通过，当前话术保持不变。`,
          );
      }
      const ready = await api(`${root()}/releases/${c.id}/review`, "POST", {
        expectedVersion: c.version,
        descriptorHash: c.descriptorHash,
        approved: true,
        evidence: evidence.trim(),
      });
      c = { ...c, state: ready.state, version: ready.version };
      setState({ ...s, candidate: c });
    }
    await api(`${root()}/releases/${c.id}/activate`, "POST", {
      expectedVersion: c.version,
      expectedEpoch: c.baseEpoch,
      expectedActive: c.baseActive,
      descriptorHash: c.descriptorHash,
    });
    await onPublished();
    setStatus({
      text: "话术已发布。新的网页和企微问题会按成员标签与个人偏好使用新表达，已有答案保持原样。",
      variant: "ok",
    });
  };

  const run = (fn) => async (event) => {
    event?.preventDefault?.();
    if (busy) return;
    setBusy(true);
    try {
      await fn(event);
    } catch (e) {
      const text = errors[e.message] ?? `操作未完成：${e.message}`;
      setStatus({ text, variant: "warn" });
      // 状态栏在页面顶部，操作按钮在表单底部——同时弹 toast 保证报错可见
      toast(text, "danger");
    } finally {
      setBusy(false);
    }
  };

  const publishable = canPublish();
  const candidate = state?.candidate;

  return html`<div class="answer-style-view">
    ${
      status.text &&
      html`<p
        class="callout c-${status.variant}"
        role="status"
        aria-live="polite"
      >
        ${status.text}
      </p>`
    }
    <form class="card" onSubmit=${run(save)}>
      <fieldset disabled=${busy} id="answer-style-fields">
        <legend>1. 编辑回答话术</legend>
        <p class="meta">
          保存草稿不会影响正在使用的机器人。以下四段话术会按用户的视角与深度组合使用。
        </p>
        <div class="field-grid">
          ${fields.map(
            (f) =>
              html`<label class="field" key=${f}>
                ${f === "business" ? "业务人员" : f === "technical" ? "技术人员" : f === "beginner" ? "入门深度" : "熟练深度"}
                <textarea
                  maxlength="2000"
                  required
                  value=${templates[f] ?? ""}
                  onInput=${(e) => {
                    setTemplates({ ...templates, [f]: e.target.value });
                    markDirty();
                  }}
                ></textarea>
                <span class="meta"
                  >${
                    f === "business"
                      ? "强调业务目标、操作和结果，少用实现术语。"
                      : f === "technical"
                        ? "强调处理链路、接口、配置和异常边界。"
                        : f === "beginner"
                          ? "补充必要背景，解释首次出现的术语。"
                          : "结论先行，精简背景，保留必要条件与步骤。"
                  }</span
                >
              </label>`,
          )}
        </div>
        <label class="field">
          用于对比的知识问题
          <select
            required
            value=${caseId}
            onChange=${(e) => setCaseId(e.target.value)}
          >
            ${(state?.cases ?? []).map(
              (c) =>
                html`<option key=${c.id} value=${c.id}>${c.question}</option>`,
            )}
          </select>
        </label>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit" disabled=${busy}>
            保存话术草稿
          </button>
          <button
            type="button"
            class="btn btn-ghost"
            disabled=${busy || !state}
            onClick=${run(() => {
              setTemplates({ ...state.recommendedTemplates });
              markDirty();
            })}
          >
            填入推荐话术
          </button>
          <button
            type="button"
            class="btn btn-ghost"
            disabled=${busy}
            onClick=${run(load)}
          >
            重新加载
          </button>
          <button
            type="button"
            class="btn btn-soft"
            disabled=${busy}
            onClick=${run(preview)}
          >
            保存并预览四种回答
          </button>
        </div>
      </fieldset>
    </form>

    <h2 class="section-title">2. 对比实际回答</h2>
    <p class="meta">
      使用同一道知识问题和同一版本资料调用模型。自动检查会核对回答状态与预期引用；仍需你核对事实、必要步骤、术语和口吻。
    </p>
    ${busy && html`<div class="answer-loading"><${Spinner} /><span class="muted">正在处理…</span></div>`}
    <div class="preview-grid">
      ${
        !candidate
          ? html`<p class="meta">保存并生成预览后，这里会显示四种实际回答。</p>`
          : candidate.caseIds.map((id) => {
              const sample = candidate.cases.find((item) => item.id === id);
              const r = latest(id);
              const passed = r?.state === "complete" && r.verdict === "pass";
              let label,
                variant = "neutral";
              if (!r) label = "等待生成";
              else if (r.state === "running") {
                label = "正在生成";
                variant = "info";
              } else if (passed) {
                variant = "ok";
                label =
                  candidate.state === "active"
                    ? "引用检查通过 · 已复核并发布"
                    : candidate.state === "ready"
                      ? "引用检查通过 · 已复核，待发布"
                      : "引用检查通过 · 待人工核对表达";
              } else {
                variant = "danger";
                label = `未通过：${errors[r.code] ?? r.code ?? (r.failures?.join("、") || r.state)}`;
              }
              return html`<article key=${id} class="card preview-card">
                <div class="preview-head">
                  <h3>
                    ${fieldLabels[sample.style]} · ${fieldLabels[sample.depth]}
                  </h3>
                  <${Badge} variant=${variant}>${label}<//>
                </div>
                <p class="meta">${sample.question}</p>
                ${
                  r?.output?.answer &&
                  html`<div class="pre">${r.output.answer.text}</div>
                    <div class="cite-row">
                      <span class="meta">依据</span>
                      ${(r.output.answer.citations.length
                        ? r.output.answer.citations
                        : [null]
                      ).map(
                        (c, i) =>
                          html`<span key=${i} class="chip">${c ?? "无"}</span>`,
                      )}
                    </div>`
                }
              </article>`;
            })
      }
    </div>

    <form class="card" onSubmit=${run(publish)}>
      <fieldset
        id="answer-style-publish-fields"
        disabled=${busy || !publishable}
      >
        <legend>3. 检查并发布</legend>
        <label class="field check">
          <input
            type="checkbox"
            required
            checked=${confirmChecked}
            onChange=${(e) => setConfirmChecked(e.target.checked)}
          />我已核对四种回答的表达、必要步骤和知识依据
        </label>
        <label class="field">
          复核说明
          <textarea
            minlength="10"
            maxlength="2000"
            required
            placeholder="记录本次检查结果，例如术语准确、业务步骤完整，四种表达均适合对应人群"
            value=${evidence}
            onInput=${(e) => setEvidence(e.target.value)}
          ></textarea>
        </label>
        <button class="btn btn-primary">检查其余样例并发布话术</button>
        <p class="meta">
          发布前会检查该知识版本的全部样例。发布后，新问题使用新话术；已有答案保留原版本。
        </p>
      </fieldset>
    </form>
  </div>`;
}
