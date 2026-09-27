import { useEffect, useRef, useState } from "../../vendor/hooks.module.js";
import { html } from "../html.js";
import { api, base } from "../api.js";
import {
  releaseStateLabels,
  releaseStateVariants,
  revisionStateLabels,
} from "../labels.js";
import {
  Badge,
  Card,
  DialogForm,
  EmptyState,
  toast,
  toastError,
} from "../ui.js";

export default function Admin({ domain, knowledge, dataVersion }) {
  const [revisions, setRevisions] = useState(null);
  const [releases, setReleases] = useState(null);
  const [runs, setRuns] = useState({});
  const [dialog, setDialog] = useState(null);
  const bundleInputRef = useRef(null);

  useEffect(() => {
    setRevisions(null);
    setReleases(null);
    reload();
  }, [domain, dataVersion]);

  const reload = async () => {
    try {
      setRevisions(await api(`${base(domain)}/revisions`));
      setReleases(await api(`${base(domain)}/releases`));
    } catch (e) {
      toastError(e);
    }
  };
  const rememberRun = (releaseId, run) =>
    setRuns((all) => ({
      ...all,
      [releaseId]: { ...(all[releaseId] ?? {}), [run.caseId]: run },
    }));

  const createRevision = async (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    const page = (knowledge?.pages ?? []).find(
      (p) => p.id === String(data.get("page")),
    );
    if (!page) return toast("请选择要修订的页面");
    try {
      await api(`${base(domain)}/revisions`, "POST", {
        title: String(data.get("title") ?? ""),
        scope: String(data.get("scope") ?? ""),
        reason: String(data.get("reason") ?? ""),
        changes: [
          {
            pageId: page.id,
            baseHash: page.hash,
            content: String(data.get("content") ?? ""),
            source: String(data.get("source") ?? ""),
          },
        ],
      });
      e.target.reset();
      toast("修订草稿已保存", "ok");
      setRevisions(await api(`${base(domain)}/revisions`));
    } catch (err) {
      toastError(err);
    }
  };
  const submitRevision = async (r) => {
    try {
      await api(`${base(domain)}/revisions/${r.id}/submit`, "POST", {
        expectedVersion: r.version,
      });
      toast("修订已提交，等待来源写回", "ok");
      reload();
    } catch (e) {
      toastError(e);
    }
  };
  const submitBundle = async (e) => {
    e.preventDefault();
    const file = bundleInputRef.current?.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) return toast("快照超过 4 MiB 限制");
    try {
      await api(
        `${base(domain)}/submissions`,
        "POST",
        JSON.parse(await file.text()),
      );
      toast("快照已提交，等待评估与复核", "ok");
      reload();
    } catch (err) {
      toastError(err);
    }
  };
  const runEvaluations = async (r) => {
    try {
      for (const c of r.bundle.cases) {
        const run = await api(
          `${base(domain)}/releases/${r.id}/evaluations`,
          "POST",
          {
            caseId: c.id,
            descriptorHash: r.descriptorHash,
          },
        );
        rememberRun(r.id, run);
      }
      toast("评估已运行，请核对结果后复核", "ok");
    } catch (e) {
      toastError(e);
    }
  };
  const review = (r) => setDialog(r);
  const submitReview = async (r, values) => {
    try {
      await api(`${base(domain)}/releases/${r.id}/review`, "POST", {
        expectedVersion: r.version,
        descriptorHash: r.descriptorHash,
        evidence: values.evidence,
        approved: true,
      });
      toast("复核已记录", "ok");
      setDialog(null);
      reload();
    } catch (e) {
      toastError(e);
    }
  };
  const activate = async (r) => {
    try {
      await api(`${base(domain)}/releases/${r.id}/activate`, "POST", {
        expectedVersion: r.version,
        expectedEpoch: r.baseEpoch,
        expectedActive: r.baseActive,
        descriptorHash: r.descriptorHash,
      });
      toast("新版本已激活", "ok");
      reload();
    } catch (e) {
      toastError(e);
    }
  };

  return html`<div class="admin-view">
    <details class="reveal">
      <summary>新建知识修订</summary>
      <form class="reveal-body" onSubmit=${createRevision}>
        <div class="field-grid">
          <label class="field">
            页面
            <select name="page" required>
              ${(knowledge?.pages ?? []).map(
                (p) =>
                  html`<option key=${p.id} value=${p.id}>${p.title}</option>`,
              )}
            </select>
          </label>
          <label class="field">修订标题<input name="title" required /></label>
        </div>
        <label class="field">影响范围<input name="scope" required /></label>
        <label class="field">
          更正理由<textarea name="reason" required minlength="10"></textarea>
        </label>
        <label class="field">
          更正后的完整正文<textarea name="content" required></textarea>
        </label>
        <label class="field">
          来源依据<textarea name="source" required minlength="10"></textarea>
        </label>
        <button class="btn btn-primary">保存草稿</button>
      </form>
    </details>

    <h2 class="section-title">修订记录</h2>
    ${
      revisions === null
        ? html`<div class="empty">正在加载…</div>`
        : revisions.length === 0
          ? html`<${EmptyState}
              >还没有修订草稿。需要更正知识时，在上方新建修订。<//
            >`
          : html`<div class="stack">
              ${revisions.map(
                (r) =>
                  html`<${Card}
                    key=${r.id}
                    title=${r.title}
                    sub=${`修订 ${r.id}`}
                    actions=${
                      r.state === "draft" &&
                      html`<button
                        type="button"
                        class="btn btn-soft"
                        onClick=${() => submitRevision(r)}
                      >
                        提交来源写回
                      </button>`
                    }
                  >
                    <div class="card-head-badges">
                      <${Badge}
                        variant=${r.state === "snapshot_ready" ? "ok" : "neutral"}
                        >${revisionStateLabels[r.state] ?? r.state}<//
                      >
                    </div>
                    ${
                      r.blocker &&
                      html`<div class="callout c-warn">阻塞：${r.blocker}</div>`
                    }
                    ${r.changes.map((c, i) => {
                      const title =
                        (knowledge?.pages ?? []).find((p) => p.id === c.pageId)
                          ?.title ?? c.pageId;
                      return html`<div key=${i}>
                        <h3>${title}</h3>
                        <p class="meta">依据：${c.source}</p>
                        <div class="diff-grid">
                          <div>
                            <div class="diff-label">原文</div>
                            <div class="pre">
                              ${
                                r.originalPages?.find((p) => p.id === c.pageId)
                                  ?.content ?? ""
                              }
                            </div>
                          </div>
                          <div>
                            <div class="diff-label">拟改</div>
                            <div class="pre">${c.content}</div>
                          </div>
                        </div>
                      </div>`;
                    })}
                  <//>`,
              )}
            </div>`
    }

    <details class="reveal">
      <summary>提交已维护好的快照</summary>
      <form class="reveal-body" onSubmit=${submitBundle}>
        <label class="field">
          快照文件
          <input
            type="file"
            accept=".json,application/json"
            required
            ref=${bundleInputRef}
          />
        </label>
        <button class="btn btn-primary">校验并提交</button>
      </form>
    </details>

    <h2 class="section-title">发布版本</h2>
    ${
      releases === null
        ? html`<div class="empty">正在加载…</div>`
        : releases.length === 0
          ? html`<${EmptyState}>还没有发布版本。提交快照后开始评估与复核。<//>`
          : html`<div class="stack">
              ${releases.map((r) => {
                const releaseRuns = runs[r.id] ?? {};
                return html`<${Card}
                  key=${r.id}
                  title=${r.id.slice(0, 8)}
                  sub=${`指纹 ${r.descriptorHash.slice(0, 16)}…`}
                  actions=${html`${
                    r.state === "submitted" &&
                    html`<button
                        type="button"
                        class="btn btn-soft"
                        onClick=${() => runEvaluations(r)}
                      >
                        运行金样例问答评估
                      </button>
                      <button
                        type="button"
                        class="btn btn-ghost"
                        onClick=${() => review(r)}
                      >
                        核对结果并复核
                      </button>`
                  }
                  ${
                    r.state === "ready" &&
                    html`<button
                      type="button"
                      class="btn btn-primary"
                      onClick=${() => activate(r)}
                    >
                      激活此版本
                    </button>`
                  }`}
                >
                  <div class="card-head-badges">
                    <${Badge}
                      variant=${releaseStateVariants[r.state] ?? "neutral"}
                      >${releaseStateLabels[r.state] ?? r.state}<//
                    >
                  </div>
                  <div class="group-title">金样例评估</div>
                  ${r.bundle.cases.map((c) => {
                    const run = releaseRuns[c.id];
                    return html`<div key=${c.id}>
                      <div class="eval-row">
                        <span class="row-main">
                          <span class="row-title">${c.question}</span>
                        </span>
                        ${
                          !run
                            ? html`<${Badge}>未评估<//>`
                            : run.state === "running"
                              ? html`<${Badge} variant="info">评估中<//>`
                              : run.verdict === "pass"
                                ? html`<${Badge} variant="ok">通过<//>`
                                : html`<${Badge} variant="danger">未通过<//>
                                    <span class="meta"
                                      >${
                                        run.failures?.join("、") ||
                                        run.code ||
                                        "评估未完成"
                                      }</span
                                    >`
                        }
                      </div>
                      ${
                        run?.output?.answer &&
                        html`<div class="pre">${run.output.answer.text}</div>
                          <p class="meta">
                            依据：${run.output.answer.citations.join("、") || "无"}
                          </p>`
                      }
                    </div>`;
                  })}
                  <details>
                    <summary>查看快照内容</summary>
                    <div class="pre mono">
                      ${JSON.stringify(r.bundle, null, 2)}
                    </div>
                  </details>
                <//>`;
              })}
            </div>`
    }
    ${
      dialog &&
      html`<${DialogForm}
        title="核对结果并复核"
        description="记录事实依据、样本核验结果和支持范围（至少 10 字）。"
        fields=${[
          {
            name: "evidence",
            label: "复核说明",
            textarea: true,
            required: true,
            minlength: 10,
            placeholder:
              "例如：已核对两个样例的回答与引用，与来源一致，支持范围见快照说明",
          },
        ]}
        confirm="确认复核"
        onSubmit=${(values) => submitReview(dialog, values)}
        onCancel=${() => setDialog(null)}
      />`
    }
  </div>`;
}
