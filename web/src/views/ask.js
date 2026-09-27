import { useEffect, useRef, useState } from "../../vendor/hooks.module.js";
import { html } from "../html.js";
import { api, base } from "../api.js";
import { answerStateLabels, answerStateVariants } from "../labels.js";
import { Badge, Spinner, toast, toastError } from "../ui.js";

export default function Ask({
  domain,
  dataVersion,
  initialAnswerId,
  onInitialAnswerConsumed,
  bumpTickets,
}) {
  const [preferences, setPreferences] = useState(null);
  const prefVersion = useRef(0);
  const sessionRef = useRef(crypto.randomUUID());
  const [question, setQuestion] = useState("");
  const [remember, setRemember] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [answerId, setAnswerId] = useState(null);
  const [answer, setAnswer] = useState(null);
  const [evidence, setEvidence] = useState([]);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const sigRef = useRef("");

  useEffect(() => {
    sessionRef.current = crypto.randomUUID();
  }, [domain]);

  useEffect(() => {
    let alive = true;
    setPreferences(null);
    api(`${base(domain)}/preferences`)
      .then((p) => {
        if (!alive) return;
        prefVersion.current = p.version;
        setPreferences({ style: p.style, depth: p.depth });
      })
      .catch(toastError);
    return () => {
      alive = false;
    };
  }, [domain, dataVersion]);

  useEffect(() => {
    if (initialAnswerId) {
      setAnswerId(initialAnswerId);
      onInitialAnswerConsumed?.();
    }
  }, [initialAnswerId]);

  useEffect(() => {
    if (!answerId || !domain) return;
    let alive = true,
      timer = 0;
    const tick = async () => {
      try {
        const a = await api(`${base(domain)}/answers/${answerId}`);
        if (!alive) return;
        const signature = JSON.stringify([
          a.id,
          a.state,
          a.code,
          a.review,
          a.blocks,
        ]);
        if (sigRef.current !== signature) {
          sigRef.current = signature;
          setAnswer(a);
          if (
            a.review === "clear" &&
            a.blocks.length &&
            a.deliveredThrough < a.blocks.at(-1).sequence
          )
            api(`${base(domain)}/answers/${answerId}/ack`, "POST", {
              through: a.blocks.at(-1).sequence,
            }).catch(() => {});
        }
        timer = setTimeout(
          tick,
          ["queued", "running"].includes(a.state) ? 300 : 5000,
        );
      } catch (e) {
        if (!alive) return;
        setAnswer({ unreadable: true });
        toastError(e);
      }
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [answerId, domain]);

  const style = preferences?.style ?? "business";
  const depth = preferences?.depth ?? "beginner";
  const hint =
    `${style === "technical" ? "技术：关注实现、配置与异常边界" : "业务：关注目标、步骤与结果"}；` +
    `${depth === "experienced" ? "熟练：结论先行，精简背景" : "入门：解释必要背景与术语"}。` +
    `只调整表达，不改变权限和知识依据。`;

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      if (remember) {
        const p = await api(`${base(domain)}/preferences`, "PATCH", {
          style,
          depth,
          expectedVersion: prefVersion.current,
        });
        prefVersion.current = p.version;
      }
      setAnswer({ loading: true });
      const a = await api(`${base(domain)}/answers`, "POST", {
        question,
        sessionId: sessionRef.current,
        style,
        depth,
      });
      setEvidence([]);
      setFeedbackSent(false);
      sigRef.current = "";
      setAnswerId(a.id);
      location.hash = `answer=${a.id}&domain=${domain}`;
    } catch (err) {
      toastError(err);
      setAnswer(null);
    } finally {
      setSubmitting(false);
    }
  };
  const cancel = async () => {
    try {
      await api(`${base(domain)}/answers/${answerId}/cancel`, "POST", {});
      sigRef.current = "";
    } catch (e) {
      toastError(e);
    }
  };
  const clearPreferences = async () => {
    try {
      const p = await api(`${base(domain)}/preferences`, "DELETE", {
        expectedVersion: prefVersion.current,
      });
      prefVersion.current = p.version;
      setPreferences({ style: p.style, depth: p.depth });
      setRemember(false);
      toast("已清除保存的偏好", "ok");
    } catch (e) {
      toastError(e);
    }
  };
  const openCitation = async (citation) => {
    try {
      const page = await api(
        `${base(domain)}/releases/${encodeURIComponent(answer.releaseId)}/pages/${encodeURIComponent(citation)}`,
      );
      setEvidence((list) => [
        ...list.filter((e) => e.key !== citation),
        {
          key: citation,
          title: page.title,
          release: answer.releaseId.slice(0, 8),
          content: page.content,
        },
      ]);
    } catch (e) {
      toastError(e);
    }
  };
  const sendFeedback = async (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    try {
      await api(`${base(domain)}/tickets`, "POST", {
        title: "答案反馈",
        description: String(data.get("text") ?? ""),
        category: String(data.get("category") ?? "question"),
        answerId,
      });
      e.target.reset();
      setFeedbackSent(true);
      toast("已登记反馈工单，可在「工单」中跟进", "ok");
      bumpTickets();
    } catch (err) {
      toastError(err);
    }
  };

  const running = answer && ["queued", "running"].includes(answer.state);

  return html`<div class="ask-view">
    <form class="card" onSubmit=${submit}>
      <label class="field">
        问题
        <textarea
          required
          placeholder="直接描述你的问题，机器人会检索已发布知识并回答"
          value=${question}
          onInput=${(e) => setQuestion(e.target.value)}
        ></textarea>
      </label>
      <div class="field-grid">
        <label class="field">
          视角
          <select
            value=${style}
            onChange=${(e) =>
              setPreferences((p) => ({ ...p, style: e.target.value }))}
          >
            <option value="business">业务视角</option>
            <option value="technical">技术视角</option>
          </select>
        </label>
        <label class="field">
          深度
          <select
            value=${depth}
            onChange=${(e) =>
              setPreferences((p) => ({ ...p, depth: e.target.value }))}
          >
            <option value="beginner">入门</option>
            <option value="experienced">熟练</option>
          </select>
        </label>
      </div>
      <p class="callout c-info">${hint}</p>
      <div class="form-actions">
        <label class="field check">
          <input
            type="checkbox"
            checked=${remember}
            onChange=${(e) => setRemember(e.target.checked)}
          />保存为我的偏好
        </label>
        <span class="spacer"></span>
        <button type="button" class="btn btn-ghost" onClick=${clearPreferences}>
          清除已保存偏好
        </button>
        <button class="btn btn-primary" type="submit" disabled=${submitting}>
          ${submitting ? "提交中…" : "提问"}
        </button>
      </div>
    </form>

    ${
      answer?.loading &&
      html`<div class="card answer-loading">
        <${Spinner} /><span class="muted">正在生成…</span>
      </div>`
    }
    ${
      answer?.unreadable &&
      html`<div class="card">
        <div class="callout c-warn">
          当前答案不可读取；权限、知识有效性或服务状态已变化。
        </div>
      </div>`
    }
    ${
      answer &&
      !answer.loading &&
      !answer.unreadable &&
      html`<article class="card answer">
        <div class="answer-head">
          <${Badge} variant=${answerStateVariants[answer.state] ?? "neutral"}
            >${answerStateLabels[answer.state] ?? answer.state}<//
          >
          <span class="meta mono">答案 ${answer.id}</span>
          ${answer.code && html`<span class="meta">${answer.code}</span>`}
        </div>
        ${
          answer.review === "pending" &&
          html`<div class="callout c-warn">
            模型验证待确认：仅展示此前确认收到的内容。
          </div>`
        }
        ${
          ["incomplete", "failed"].includes(answer.state) &&
          html`<div class="callout c-warn">
            这份回答未完整完成，请不要将其视为完整指导。
          </div>`
        }
        ${answer.blocks.map(
          (b) =>
            html`<div key=${b.sequence}>
              <div class="block">${b.text}</div>
              ${
                b.citations.length > 0 &&
                html`<div class="cite-row">
                  <span class="meta">依据</span>
                  ${b.citations.map(
                    (c) =>
                      html`<button
                        key=${c}
                        type="button"
                        class="chip"
                        onClick=${() => openCitation(c)}
                      >
                        查看依据 ${c}
                      </button>`,
                  )}
                </div>`
              }
            </div>`,
        )}
        ${evidence.map(
          (e) =>
            html`<details key=${e.key} open>
              <summary>${e.title} · ${e.release}</summary>
              <div class="pre">${e.content}</div>
            </details>`,
        )}
        ${
          answer.finishedAt &&
          html`<div class="meta">
            ${answer.state === "complete" ? "生成完成，" : ""}耗时
            ${((answer.finishedAt - answer.createdAt) / 1000).toFixed(1)} 秒
          </div>`
        }
        <div class="btn-row">
          ${
            running &&
            html`<button class="btn btn-soft" onClick=${cancel}>
              停止生成
            </button>`
          }
        </div>
      </article>`
    }
    ${
      answer &&
      !answer.loading &&
      !answer.unreadable &&
      html`<form class="card" onSubmit=${sendFeedback}>
        <div class="group-title">针对这份答案登记问题</div>
        <div class="field-grid">
          <label class="field">
            处理类型
            <select name="category">
              <option value="question">回答疑问或表达问题</option>
              <option value="knowledge">来源知识需要更正</option>
            </select>
          </label>
        </div>
        <label class="field">
          反馈说明
          <textarea name="text" required></textarea>
        </label>
        <button class="btn btn-soft">
          ${feedbackSent ? "再登记一条" : "登记问题"}
        </button>
      </form>`
    }
  </div>`;
}
