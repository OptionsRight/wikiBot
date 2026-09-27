const labels = {
  business: "业务",
  technical: "技术",
  beginner: "入门",
  experienced: "熟练",
};
const fields = Object.keys(labels);
const $ = (id) => document.getElementById(id);
function node(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}
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

export function createAnswerStylePanel({ api, domain, onPublished, onBusy }) {
  let state,
    runs = [],
    dirty = false,
    busy = false,
    root = "";
  const status = (text) => {
    $("answer-style-status").textContent = text;
  };
  const latest = (caseId) =>
    runs
      .filter((r) => r.caseId === caseId)
      .sort((a, b) => (b.attempt ?? 0) - (a.attempt ?? 0))[0];
  function canPublish() {
    const c = state?.candidate;
    return (
      !dirty &&
      c &&
      c.baseActive === state.active.id &&
      ["submitted", "ready"].includes(c.state) &&
      c.caseIds.length === 4 &&
      c.caseIds.every((id) => latest(id)?.verdict === "pass")
    );
  }
  function controls() {
    $("answer-style-fields").disabled = busy;
    $("answer-style-publish-fields").disabled = busy || !canPublish();
  }
  function renderPreviews() {
    const holder = $("answer-style-previews");
    holder.replaceChildren();
    const c = state?.candidate;
    if (!c) {
      holder.append(
        node("p", "保存并生成预览后，这里会显示四种实际回答。", "meta"),
      );
      return;
    }
    for (const id of c.caseIds) {
      const sample = c.cases.find((item) => item.id === id);
      const r = latest(id);
      const card = node("article", "");
      card.append(
        node("h3", `${labels[sample.style]} · ${labels[sample.depth]}`),
      );
      card.append(node("p", sample.question, "meta"));
      const passed = r?.state === "complete" && r.verdict === "pass";
      const resultLabel = !r
        ? "等待生成"
        : r.state === "running"
          ? "正在生成"
          : passed
            ? c.state === "active"
              ? "引用检查通过 · 已复核并发布"
              : c.state === "ready"
                ? "引用检查通过 · 已复核，待发布"
                : "引用检查通过 · 待人工核对表达"
            : `检查未通过：${errors[r.code] ?? r.code ?? (r.failures?.join("、") || r.state)}`;
      card.append(node("p", resultLabel, passed ? "meta" : "warning"));
      if (r?.output?.answer) {
        card.append(node("div", r.output.answer.text, "pre"));
        card.append(
          node(
            "p",
            `依据：${r.output.answer.citations.join("、") || "无"}`,
            "meta",
          ),
        );
      }
      holder.append(card);
    }
  }
  async function load() {
    root = `/api/domains/${encodeURIComponent(domain())}`;
    const next = await api(`${root}/answer-style`);
    const nextRuns = next.candidate
      ? await api(`${root}/releases/${next.candidate.id}/evaluations`)
      : [];
    state = next;
    runs = nextRuns;
    dirty = false;
    const draftCurrent = state.draft?.baseReleaseId === state.active.id;
    const templates = draftCurrent
      ? state.draft.templates
      : (state.publishedTemplates ?? state.recommendedTemplates);
    for (const field of fields) $(`template-${field}`).value = templates[field];
    $("answer-style-case").replaceChildren(
      ...state.cases.map((c) => {
        const option = node("option", c.question);
        option.value = c.id;
        return option;
      }),
    );
    if (draftCurrent) $("answer-style-case").value = state.draft.caseId;
    $("answer-style-confirm").checked = false;
    $("answer-style-evidence").value = "";
    if (state.candidate?.state === "active")
      status("当前已启用这套话术，新问题会根据用户偏好选择表达方式。");
    else if (state.draft && !draftCurrent)
      status(
        "知识版本已更新。表单已载入当前话术，旧草稿与预览不能直接发布，请重新保存并预览。",
      );
    else if (draftCurrent)
      status("已载入保存的草稿，尚未对用户生效。请对比四种回答后发布。");
    else
      status(
        state.publishedTemplates
          ? "当前已启用自定义话术。修改后需要预览并发布。"
          : "当前仅按视角和深度标签回答。已为你填入推荐话术，预览并发布后生效。",
      );
    renderPreviews();
    controls();
  }
  async function action(fn) {
    if (busy) return;
    busy = true;
    controls();
    onBusy(true);
    try {
      await fn();
    } catch (error) {
      status(errors[error.message] ?? `操作未完成：${error.message}`);
    } finally {
      busy = false;
      controls();
      onBusy(false);
    }
  }
  function markDirty() {
    dirty = true;
    $("answer-style-confirm").checked = false;
    status(
      "有未保存的修改。已有预览不会包含这些修改，请重新保存并预览后发布。",
    );
    controls();
  }
  async function save() {
    if (!state) throw new Error("请重新加载当前知识版本。");
    const templates = Object.fromEntries(
      fields.map((f) => [f, $(`template-${f}`).value.trim()]),
    );
    if (Object.values(templates).some((text) => !text))
      throw new Error("请填写全部四段话术，内容不能只有空格。");
    const draft = await api(`${root}/answer-style/draft`, "PUT", {
      expectedVersion: state.draft?.version ?? 0,
      baseReleaseId: state.active.id,
      templates,
      caseId: $("answer-style-case").value,
    });
    state.draft = draft;
    state.candidate = null;
    runs = [];
    dirty = false;
    renderPreviews();
    status("话术草稿已保存，机器人仍使用已发布版本。下一步可预览四种回答。");
  }
  $("answer-style-form").addEventListener("input", markDirty);
  $("answer-style-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void action(save);
  });
  $("answer-style-defaults").onclick = () => {
    if (!state) return;
    for (const f of fields)
      $(`template-${f}`).value = state.recommendedTemplates[f];
    markDirty();
  };
  $("answer-style-reload").onclick = () => action(load);
  $("answer-style-preview").onclick = () => {
    if (!$("answer-style-form").reportValidity()) return;
    void action(async () => {
      if (
        dirty ||
        !state?.draft ||
        state.draft.baseReleaseId !== state.active.id
      )
        await save();
      if (
        !state.candidate ||
        !["submitted", "ready"].includes(state.candidate.state)
      ) {
        await api(`${root}/answer-style/submissions`, "POST", {
          expectedVersion: state.draft.version,
        });
        await load();
      }
      const c = state.candidate;
      for (let i = 0; i < c.caseIds.length; i++) {
        const id = c.caseIds[i];
        if (latest(id)?.verdict === "pass") continue;
        status(`正在生成第 ${i + 1} / 4 种回答，请稍候…`);
        runs.push(
          await api(`${root}/releases/${c.id}/evaluations`, "POST", {
            caseId: id,
            descriptorHash: c.descriptorHash,
          }),
        );
        renderPreviews();
      }
      status(
        canPublish()
          ? "四种回答已生成，引用检查通过。请核对事实与表达效果后，在下方填写复核说明并发布。"
          : "部分预览未通过检查，暂时不能发布。可查看结果后再次生成，或修改话术。 ",
      );
    });
  };
  $("answer-style-publish-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const evidence = $("answer-style-evidence").value.trim();
    if (
      !canPublish() ||
      !$("answer-style-confirm").checked ||
      evidence.length < 10
    )
      return;
    void action(async () => {
      let c = state.candidate;
      if (c.state === "submitted") {
        for (let i = 0; i < c.cases.length; i++) {
          const sample = c.cases[i];
          if (latest(sample.id)?.verdict === "pass") continue;
          status(
            `正在检查知识样例 ${i + 1} / ${c.cases.length}，全部通过后才会发布…`,
          );
          const result = await api(
            `${root}/releases/${c.id}/evaluations`,
            "POST",
            { caseId: sample.id, descriptorHash: c.descriptorHash },
          );
          runs.push(result);
          if (result.verdict !== "pass")
            throw new Error(
              `样例“${sample.question}”检查未通过，当前话术保持不变。`,
            );
        }
        const ready = await api(`${root}/releases/${c.id}/review`, "POST", {
          expectedVersion: c.version,
          descriptorHash: c.descriptorHash,
          approved: true,
          evidence,
        });
        c = state.candidate = {
          ...c,
          state: ready.state,
          version: ready.version,
        };
      }
      await api(`${root}/releases/${c.id}/activate`, "POST", {
        expectedVersion: c.version,
        expectedEpoch: c.baseEpoch,
        expectedActive: c.baseActive,
        descriptorHash: c.descriptorHash,
      });
      await onPublished();
      status(
        "话术已发布。新的网页和企微问题会按成员标签与个人偏好使用新表达，已有答案保持原样。",
      );
    });
  });
  return {
    load,
    clear() {
      state = undefined;
      runs = [];
      dirty = false;
      renderPreviews();
      controls();
    },
  };
}
