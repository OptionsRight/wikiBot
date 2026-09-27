import { useEffect, useState } from "../vendor/hooks.module.js";
import { html } from "./html.js";
import { api, setToken } from "./api.js";
import { ToastStack, icons, toast, toastError } from "./ui.js";
import Login from "./views/login.js";
import Ask from "./views/ask.js";
import Tickets from "./views/tickets.js";
import Members from "./views/access.js";
import AnswerStyle from "./views/answer-style.js";
import Manage from "./views/manage.js";

const UUID_RE = /^[a-f0-9-]{36}$/;

const NAV = [
  { view: "ask", label: "问答", icon: "ask" },
  { view: "tickets", label: "工单", icon: "tickets" },
  { view: "members", label: "人员与标签", icon: "access", manageOnly: true },
  { view: "answer-style", label: "回答风格", icon: "style", adminOnly: true },
  { view: "manage", label: "管理", icon: "admin", manageOnly: true },
];
const VIEW_TITLES = {
  ask: ["这次想了解什么？", "检索已发布知识并生成有依据的回答"],
  tickets: ["问题与反馈", "登记问题、跟进处理进度"],
  members: ["人员与标签", "为成员设置角色与表达标签，点击即保存"],
  "answer-style": ["回答风格", "为不同人群设置讲解方式，预览并发布后生效"],
  manage: ["管理", "配置领域的来源仓库"],
};

export default function App() {
  const [booted, setBooted] = useState(false);
  const [sso, setSso] = useState(false);
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState(null);
  const [domains, setDomains] = useState([]);
  const [domain, setDomain] = useState("");
  const [grant, setGrant] = useState(null);
  const [knowledge, setKnowledge] = useState(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [ticketsVersion, setTicketsVersion] = useState(0);
  const [view, setView] = useState("ask");
  const [pendingAnswer, setPendingAnswer] = useState(null);
  const [pendingTicket, setPendingTicket] = useState(null);

  const loadDomain = async (name = domain, actor = me) => {
    let next;
    try {
      next = await api(`/api/domains/${encodeURIComponent(name)}/capabilities`);
    } catch (e) {
      setGrant(null);
      setKnowledge({ pages: [] });
      setDataVersion((v) => v + 1);
      if (actor?.platform) {
        setView("manage");
        return;
      }
      toastError(e);
      return;
    }
    setGrant(next);
    try {
      setKnowledge(
        await api(`/api/domains/${encodeURIComponent(name)}/knowledge`),
      );
    } catch (e) {
      setKnowledge({ pages: [] });
      toastError(e);
    }
    setDataVersion((v) => v + 1);
  };

  const login = async () => {
    const meData = await api("/api/me");
    const domainsData = await api("/api/domains");
    const h = new URLSearchParams(location.hash.slice(1));
    const picked =
      domainsData.some((d) => d.id === h.get("domain")) && h.get("domain")
        ? h.get("domain")
        : (domainsData[0]?.id ?? "");
    setMe(meData);
    setDomains(domainsData);
    setDomain(picked);
    if (!picked) {
      toast("当前账号尚未获准访问领域，请联系平台管理员。");
      return;
    }
    await loadDomain(picked, meData);
    if (h.get("domain") === picked) {
      if (UUID_RE.test(h.get("answer") ?? ""))
        setPendingAnswer(h.get("answer"));
      if (UUID_RE.test(h.get("ticket") ?? "")) {
        setView("tickets");
        setPendingTicket(h.get("ticket"));
      }
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const cfg = await (await fetch("/auth/config")).json();
        setSso(Boolean(cfg.sso));
      } catch {}
      try {
        await login();
      } catch {}
      setBooted(true);
    })();
  }, []);

  // 已登录状态下响应地址栏深链接（#/ticket=…、#/answer=…&domain=…）
  useEffect(() => {
    const onHashChange = () => {
      const h = new URLSearchParams(location.hash.slice(1));
      if (h.get("domain") !== domain || !me) return;
      if (UUID_RE.test(h.get("answer") ?? ""))
        setPendingAnswer(h.get("answer"));
      if (UUID_RE.test(h.get("ticket") ?? "")) {
        setView("tickets");
        setPendingTicket(h.get("ticket"));
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  });

  const handleLogin = async (subject, password) => {
    setBusy(true);
    try {
      const response = await fetch("/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject, password }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error?.code || `登录失败 ${response.status}`);
      setToken(data.token);
      await login();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    setToken("");
    await fetch("/auth/logout", { method: "POST" });
    location.assign("/");
  };
  const switchDomain = async (name) => {
    setDomain(name);
    setGrant(null);
    setKnowledge(null);
    setPendingAnswer(null);
    setPendingTicket(null);
    await loadDomain(name);
  };

  if (!booted) return html`<div class="boot-screen"><${ToastStack} /></div>`;
  if (!me)
    return html`<div>
      <${ToastStack} />
      <${Login} sso=${sso} onLogin=${handleLogin} busy=${busy} />
    </div>`;

  const isAdmin = grant?.role === "admin";
  const canManage = isAdmin || me.platform;
  const nav = NAV.filter(
    (n) => !(n.manageOnly && !canManage) && !(n.adminOnly && !isAdmin),
  );
  const active = nav.some((n) => n.view === view) ? view : nav[0].view;
  const [title, sub] = VIEW_TITLES[active] ?? ["", ""];
  const identity = grant
    ? `${grant.role === "admin" ? "知识管理员" : "成员"} · ${
        (grant.tags ?? [])
          .map((t) => (t === "technical" ? "技术" : "业务"))
          .join(" / ") || "未设置表达标签"
      }`
    : me.platform
      ? "平台管理员"
      : me.subject;

  return html`<div class="shell">
    <${ToastStack} />
    <aside class="sidebar">
      <div class="side-brand">
        <span class="side-mark">${icons.logo()}</span>
        <div>
          <div class="side-name">wikiBot</div>
          <div class="side-tag">有依据的业务指导</div>
        </div>
      </div>
      <nav class="side-nav">
        ${nav.map(
          (n) =>
            html`<button
              key=${n.view}
              type="button"
              class="nav-item ${active === n.view ? "active" : ""}"
              onClick=${() => setView(n.view)}
            >
              ${icons[n.icon]()}<span>${n.label}</span>
            </button>`,
        )}
      </nav>
      <div class="side-foot">
        <div class="user-block">
          <span class="avatar">${me.subject.slice(0, 1).toUpperCase()}</span>
          <div class="user-meta">
            <div class="user-name">${me.subject}</div>
            <div class="user-role">${identity}</div>
          </div>
        </div>
        <button type="button" class="nav-item" onClick=${logout}>
          ${icons.logout()}<span>退出</span>
        </button>
      </div>
    </aside>
    <main class="main-area">
      <div class="page-head">
        <div class="page-head-main">
          <h1>${title}</h1>
          ${sub && html`<p class="muted">${sub}</p>`}
        </div>
        <label class="domain-picker">
          领域
          <select
            value=${domain}
            onChange=${(e) => switchDomain(e.target.value)}
          >
            ${domains.map(
              (d) => html`<option key=${d.id} value=${d.id}>${d.name}</option>`,
            )}
          </select>
        </label>
      </div>
      <div class="view-holder">
        <section class="view" hidden=${active !== "ask"}>
          <${Ask}
            domain=${domain}
            dataVersion=${dataVersion}
            initialAnswerId=${pendingAnswer}
            onInitialAnswerConsumed=${() => setPendingAnswer(null)}
            bumpTickets=${() => setTicketsVersion((v) => v + 1)}
          />
        </section>
        <section class="view" hidden=${active !== "tickets"}>
          <${Tickets}
            domain=${domain}
            me=${me}
            grant=${grant}
            dataVersion=${dataVersion}
            ticketsVersion=${ticketsVersion}
            initialTicketId=${pendingTicket}
            onInitialTicketConsumed=${() => setPendingTicket(null)}
          />
        </section>
        ${
          canManage &&
          html`<section class="view" hidden=${active !== "members"}>
              <${Members} domain=${domain} dataVersion=${dataVersion} />
            </section>
            <section class="view" hidden=${active !== "manage"}>
              <${Manage} domain=${domain} dataVersion=${dataVersion} />
            </section>`
        }
        ${
          isAdmin &&
          html`<section class="view" hidden=${active !== "answer-style"}>
            <${AnswerStyle}
              domain=${domain}
              grant=${grant}
              dataVersion=${dataVersion}
              onPublished=${() => loadDomain()}
            />
          </section>`
        }
      </div>
    </main>
  </div>`;
}
