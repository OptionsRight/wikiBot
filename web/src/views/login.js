import { html } from "../html.js";
import { icons } from "../ui.js";

export default function Login({ sso, onLogin, busy }) {
  const submit = async (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    await onLogin(
      String(data.get("subject") ?? ""),
      String(data.get("password") ?? ""),
    );
  };
  return html`<div class="login-wrap">
    <div class="login-hero">
      <span class="login-mark">${icons.logo()}</span>
      <div class="login-name">wikiBot</div>
      <div class="login-tag">有依据的业务指导</div>
    </div>
    <div class="card login-card">
      <h1>进入你的知识领域</h1>
      <p class="muted">使用公司身份，查看获准使用的知识与本人工单。</p>
      ${
        sso
          ? html`<a class="btn btn-primary btn-block" href="/auth/login"
              >公司账号登录</a
            >`
          : html`<form onSubmit=${submit}>
              <label class="field">
                用户名
                <input
                  name="subject"
                  required
                  autocomplete="username"
                  placeholder="例如 demo-admin"
                />
              </label>
              <label class="field">
                密码
                <input
                  name="password"
                  type="password"
                  required
                  autocomplete="current-password"
                  placeholder="默认 1213456"
                />
              </label>
              <button
                class="btn btn-primary btn-block"
                type="submit"
                disabled=${busy}
              >
                ${busy ? "正在进入…" : "进入"}
              </button>
            </form>`
      }
    </div>
    <p class="login-hint">知识指导不代表实际业务操作已完成。</p>
  </div>`;
}
