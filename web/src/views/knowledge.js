import { useEffect, useState } from "../../vendor/hooks.module.js";
import { html } from "../html.js";
import { api, base, downloadAttachment } from "../api.js";
import { toast, toastError } from "../ui.js";

const labels = {
  queued: "等待解析",
  running: "处理中",
  succeeded: "解析完整",
  partial: "部分解析，需核对",
  failed: "失败",
  cancelled: "已取消",
  proposed: "待核对",
  approved: "已批准",
  rejected: "已拒绝",
  submitted: "待评测与复核",
  ready: "已复核待发布",
  active: "已发布",
  retired: "已退役",
  stale: "基线已变化",
  revoked: "已撤回",
  complete: "已完成",
  blocked: "受阻",
  no_change: "无变化",
  needs_review: "需复核",
};
const label = (s) => labels[s] ?? s;
function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function manualProfileHash() {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(["manual", 1])),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export default function Knowledge({ domain }) {
  const [data, setData] = useState(null),
    [tab, setTab] = useState("sources"),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState(null),
    [selected, setSelected] = useState([]),
    [report, setReport] = useState(null);
  const load = async () => {
    const [sources, claims, builds, releases, code] = await Promise.all(
      ["sources", "claims", "knowledge-builds", "releases", "code-sources"].map(
        (p) => api(`${base(domain)}/${p}`),
      ),
    );
    setData({ sources, claims, builds, releases, code });
  };
  useEffect(() => {
    setData(null);
    setPreview(null);
    setSelected([]);
    setReport(null);
    load().catch(toastError);
  }, [domain]);
  const run = async (action) => {
    setBusy(true);
    try {
      await action();
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const post = (p, input) => api(`${base(domain)}/${p}`, "POST", input);
  const upload = (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    run(async () => {
      const file = f.get("file");
      if (!file?.size) throw Error("请选择文档");
      const source = await post("sources", {
        id: crypto.randomUUID(),
        title: String(f.get("title") || file.name),
      });
      const version = await post(`sources/${source.id}/files`, {
        expectedVersion: source.version,
        format: file.name.split(".").pop().toLowerCase(),
        content: await fileBase64(file),
      });
      await post(`sources/${source.id}/normalize`, {
        sourceVersionId: version.id,
      });
      toast("已保存原件并加入解析队列", "ok");
    });
  };
  const propose = (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    run(async () => {
      const evidence = await post("evidence/document", {
        jobId: preview.job.id,
        blockId: preview.block.blockId,
        ...(preview.job.state === "partial" || !preview.block.extractionAllowed
          ? { partialReviewReason: String(form.get("reason")) }
          : {}),
      });
      await post("claims", {
        expectedVersion: 0,
        subjectId: String(form.get("subject")),
        predicate: String(form.get("predicate")),
        qualifiers: {
          scope: String(form.get("scope") || "明确限定范围待核对"),
        },
        statement: String(form.get("statement")),
        typedValue: String(form.get("value")),
        validityKind: form.get("from") ? "known" : "unknown",
        validFrom: form.get("from")
          ? Date.parse(String(form.get("from")) + "T00:00:00Z")
          : null,
        validTo: form.get("to")
          ? Date.parse(String(form.get("to")) + "T00:00:00Z")
          : null,
        evidenceIds: [evidence.id],
        extractionProfileHash: await manualProfileHash(),
        batchId: preview.job.id,
        reason: String(form.get("reason")),
      });
      toast("事实提议已保存，尚未发布", "ok");
      setTab("claims");
      setPreview(null);
    });
  };
  const batch = (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    run(async () => {
      await post("claims/review-batch", {
        versions: selected.map((id) => {
          const c = data.claims.versions.find((c) => c.id === id);
          return { id, expectedVersion: c.version };
        }),
        reason: String(f.get("reason")),
      });
      setSelected([]);
      toast("已批量核对，需随页面构建候选后发布", "ok");
    });
  };
  const importFile = (path) => async (e) => {
    const file = e.target.files[0];
    if (file)
      run(async () => {
        const r = await post(path, JSON.parse(await file.text()));
        setReport(r);
        toast("已保存，未自动发布", "ok");
      });
  };
  const evaluate = (r) =>
    run(async () => {
      for (const c of r.bundle.cases)
        await post(`releases/${r.id}/evaluations`, {
          caseId: c.id,
          descriptorHash: r.descriptorHash,
        });
      if (r.bundle.schemaVersion === 2)
        setReport(
          await post(`releases/${r.id}/semantic-evaluations`, {
            descriptorHash: r.descriptorHash,
          }),
        );
      else setReport(await api(`${base(domain)}/releases/${r.id}/evaluations`));
    });
  const review = (e, r) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    run(() =>
      post(`releases/${r.id}/review`, {
        expectedVersion: r.version,
        descriptorHash: r.descriptorHash,
        evidence: String(f.get("reason")),
        approved: true,
      }),
    );
  };
  if (!data) return html`<p>读取本领域知识维护记录…</p>`;
  return html`<div class="manage-view">
    <div class="form-actions">
      ${[
        ["sources", "来源与解析"],
        ["claims", "事实与冲突"],
        ["builds", "变更与构建"],
        ["releases", "评测与发布"],
      ].map(
        ([id, title]) =>
          html`<button
            class="btn ${tab === id ? "btn-primary" : ""}"
            onClick=${() => setTab(id)}
          >
            ${title}
          </button>`,
      )}<button class="btn" disabled=${busy} onClick=${() => run(load)}>
        刷新
      </button>
    </div>
    ${
      tab === "sources" &&
      html`<div class="card">
        <h2>原始文档</h2>
        <p class="meta">
          PDF、DOCX、PPTX、XLSX 原件按版本保留。解析完成后仍需事实核对和发布。
        </p>
        <form onSubmit=${upload}>
          <label class="field"
            >来源名称<input name="title" required maxlength="300" /></label
          ><label class="field"
            >文件<input
              name="file"
              type="file"
              accept=".pdf,.docx,.pptx,.xlsx"
              required /></label
          ><button
            class="btn btn-primary"
            disabled=${busy || !data.sources.configured}
          >
            上传并解析
          </button>
        </form>
        ${data.sources.jobs.map(
          (j) =>
            html`<article class="card">
              <strong
                >${data.sources.sources.find((s) => data.sources.versions.find((v) => v.id === j.sourceVersionId)?.sourceId === s.id)?.title ?? "文档"}</strong
              >
              <p>${label(j.state)} ${j.code ?? ""}</p>
              ${j.result?.warnings.map((w) => html`<p class="meta">${w}</p>`)}
              ${["failed", "cancelled"].includes(j.state) && html`<button class="btn" disabled=${busy} onClick=${() => run(() => post(`knowledge-jobs/${j.id}/retry`, { expectedVersion: j.version }))}>重试</button>`}
              ${j.result?.blocks.map(
                (b) =>
                  html`<details>
                    <summary>
                      ${b.kind} · ${b.locator.sheet ?? ""}
                      ${b.locator.range ?? ""}
                      ${b.locator.page ? `第 ${b.locator.page} 页/张` : b.locator.pointer}
                    </summary>
                    <pre style="white-space:pre-wrap">${b.text}</pre>
                    <button
                      class="btn"
                      onClick=${() => setPreview({ job: j, block: b })}
                    >
                      据此提出事实
                    </button>
                  </details>`,
              )}
              <button
                class="btn"
                onClick=${() => {
                  const v = data.sources.versions.find(
                    (v) => v.id === j.sourceVersionId,
                  );
                  downloadAttachment(
                    `${base(domain)}/sources/${v.sourceId}/files/${v.id}`,
                    `${v.id}.${v.format}`,
                  ).catch(toastError);
                }}
              >
                下载原件
              </button>
              ${j.artifacts?.["document.json"] && html`<button class="btn" onClick=${() => downloadAttachment(`${base(domain)}/knowledge-jobs/${j.id}/artifacts/document.json`, "document.json").catch(toastError)}>下载结构化结果</button>`}
            </article>`,
        )}
      </div>`
    }
    ${
      preview &&
      html`<form class="card" onSubmit=${propose}>
        <h2>核对事实与原件</h2>
        <blockquote>${preview.block.text}</blockquote>
        <div class="field-grid">
          <label class="field">事实主体<input name="subject" required /></label
          ><label class="field">属性<input name="predicate" required /></label
          ><label class="field"
            >适用范围（渠道、币种、环境等）<input
              name="scope"
              required /></label
          ><label class="field">值<input name="value" required /></label
          ><label class="field"
            >生效日期（未知则留空）<input type="date" name="from" /></label
          ><label class="field"
            >截止日期（不含当天）<input type="date" name="to"
          /></label>
        </div>
        <label class="field"
          >事实陈述<textarea
            name="statement"
            required
            defaultValue=${preview.block.text}
          /></label
        ><label class="field"
          >核对依据与解析边界<textarea
            name="reason"
            required
            minlength="10"
          /></label
        ><button class="btn btn-primary" disabled=${busy}>保存待审核事实</button
        ><button class="btn" type="button" onClick=${() => setPreview(null)}>
          关闭
        </button>
      </form>`
    }
    ${
      tab === "claims" &&
      html`<form class="card" onSubmit=${batch}>
          <h2>按批次核对事实</h2>
          ${data.claims.versions.map(
            (c) =>
              html`<article class="card">
                <label
                  ><input
                    type="checkbox"
                    disabled=${c.status !== "proposed" || c.recordedTo !== null}
                    checked=${selected.includes(c.id)}
                    onChange=${(e) => setSelected(e.target.checked ? [...selected, c.id] : selected.filter((id) => id !== c.id))}
                  />
                  ${c.statement}</label
                >
                <p class="meta">
                  ${label(c.status)} · ${c.subjectId} / ${c.predicate} ·
                  ${Object.values(c.qualifiers).join("，")}
                </p>
                <p class="meta">
                  适用：${c.validFrom === null ? "未知/开放起点" : new Date(c.validFrom).toISOString()}
                  —
                  ${c.validTo === null ? "无截止" : new Date(c.validTo).toISOString()}；记录于
                  ${new Date(c.recordedFrom).toLocaleString()}
                </p>
                ${c.evidenceIds.map(
                  (id) =>
                    html`<details>
                      <summary>查看证据</summary>
                      <pre style="white-space:pre-wrap">
${data.claims.evidence.find((e) => e.id === id)?.excerpt ?? "证据不可用"}</pre>
                    </details>`,
                )}
              </article>`,
          )}<label class="field"
            >本批核对结论<textarea
              name="reason"
              minlength="10"
              required
            /></label
          ><button class="btn btn-primary" disabled=${busy || !selected.length}>
            批准选中的 ${selected.length} 条事实
          </button>
        </form>
        <div class="card">
          <h2>知识冲突</h2>
          ${data.claims.conflicts.map(
            (c) =>
              html`<form
                class="card"
                onSubmit=${(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  run(() =>
                    post(`conflicts/${c.id}/resolve`, {
                      expectedVersion: c.version,
                      members: c.members,
                      rejectVersionIds:
                        f.get("reject") === "dismiss"
                          ? []
                          : [String(f.get("reject"))],
                      ...(f.get("reject") === "dismiss"
                        ? { dismissEvidenceIds: c.evidenceIds }
                        : {}),
                      reason: String(f.get("reason")),
                    }),
                  );
                }}
              >
                <p>${label(c.state)} · ${c.reason}</p>
                ${c.members.map((id) => html`<label class="field"><input type="radio" name="reject" value=${id} required /> 拒绝：${data.claims.versions.find((v) => v.id === id)?.statement ?? id}</label>`)}${c.evidenceIds?.length && html`<label class="field"><input type="radio" name="reject" value="dismiss" required /> 经核对排除这些反证（须说明原因）</label>`}<label
                  class="field"
                  >裁决依据<textarea
                    name="reason"
                    minlength="10"
                    required
                  /></label
                ><button class="btn" disabled=${busy || c.state !== "open"}>
                  保存裁决
                </button>
              </form>`,
          )}
        </div>`
    }
    ${
      tab === "builds" &&
      html`<div class="card">
        <h2>Code Wiki</h2>
        ${data.code.repositories.map((repo) => html`<button class="btn" disabled=${busy} onClick=${() => run(() => post(`code-sources/${encodeURIComponent(repo.split(":").pop())}/snapshots`, {}))}>读取 ${repo} 的固定提交</button>`)}${data.code.drafts.map(
          (d) =>
            html`<details>
              <summary>待复核草稿 · ${d.pages.length} 页</summary>
              ${d.pages.map((p) => html`<pre style="white-space:pre-wrap">${p.content}</pre>`)}
            </details>`,
        )}
        <h2>构建与变更影响</h2>
        <p class="meta">
          导入工具生成的构建请求；事实和页面必须匹配。无变化时复用已核验产物。
        </p>
        <label class="field"
          >构建请求文件<input
            type="file"
            accept=".json"
            disabled=${busy}
            onChange=${importFile("knowledge-builds")} /></label
        ><label class="field"
          >变更检查请求<input
            type="file"
            accept=".json"
            disabled=${busy}
            onChange=${importFile("knowledge-builds/impact")}
        /></label>
        ${data.builds.impacts.map(
          (i) =>
            html`<article>
              <strong>${label(i.state)}</strong>
              <p>
                影响页面：${i.affectedPages.join("、") || "无"}；失效证据：${i.invalidEvidence.length}；删除来源：${i.deleted.length}
              </p>
            </article>`,
        )}
        ${data.builds.generations.map((g) => html`<article class="card"><strong>${g.bundle.pages.length} 页 · ${label(g.state)}</strong><button class="btn" disabled=${busy} onClick=${() => run(() => post("submissions", g.bundle))}>提交候选以供评测</button></article>`)}
      </div>`
    }
    ${
      tab === "releases" &&
      html`<div class="card">
        <h2>候选、评测与发布</h2>
        <label class="field"
          >导入知识包<input
            type="file"
            accept=".json"
            disabled=${busy}
            onChange=${importFile("submissions")} /></label
        >${data.releases.map(
          (r) =>
            html`<article class="card">
              <strong>${r.id} · ${label(r.state)}</strong>
              <p class="meta">
                ${r.bundle.schemaVersion === 2 ? `${r.bundle.groundingManifest.mode} 依据模式；语义策略 ${r.bundle.evalPolicy.mode === "shadow" ? "影子观察，不作为语义通过证明" : "已启用阻断"}` : "V1 页面依据"}
              </p>
              <button
                class="btn"
                disabled=${busy || r.state !== "submitted"}
                onClick=${() => evaluate(r)}
              >
                运行全部评测</button
              ><button
                class="btn"
                onClick=${() => run(async () => setReport(await api(`${base(domain)}/releases/${r.id}/${r.bundle.schemaVersion === 2 ? "semantic-evaluations" : "evaluations"}`)))}
              >
                查看报告
              </button>
              ${
                r.state === "submitted" &&
                html`<form onSubmit=${(e) => review(e, r)}>
                  <label class="field"
                    >人工复核记录<textarea
                      name="reason"
                      required
                      minlength="10"
                    /></label
                  ><button class="btn" disabled=${busy}>批准复核</button>
                </form>`
              }
              ${r.state === "ready" && html`<button class="btn btn-primary" disabled=${busy} onClick=${() => run(() => post(`releases/${r.id}/activate`, { expectedVersion: r.version, expectedEpoch: r.baseEpoch, expectedActive: r.baseActive, descriptorHash: r.descriptorHash }))}>发布此版本</button>`}
            </article>`,
        )}
      </div>`
    }
    ${
      report &&
      html`<details class="card" open>
        <summary>本次操作结果与完整报告</summary>
        <pre style="white-space:pre-wrap;overflow-wrap:anywhere">
${JSON.stringify(report, null, 2)}</pre>
        <button class="btn" onClick=${() => setReport(null)}>关闭</button>
      </details>`
    }
  </div>`;
}
