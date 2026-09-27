import { useEffect, useState } from "../../vendor/hooks.module.js";
import { html } from "../html.js";
import { api, base } from "../api.js";
import { toast, toastError } from "../ui.js";

function SourceRepos({ domain, dataVersion }) {
  const [version, setVersion] = useState(0);
  const [wiki, setWiki] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api(`${base(domain)}/source-repos`)
      .then((r) => {
        if (!alive) return;
        setVersion(r.version);
        setWiki(r.wikiRepository);
        setCode(r.codeRepository);
      })
      .catch(toastError)
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [domain, dataVersion]);
  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const saved = await api(`${base(domain)}/source-repos`, "PUT", {
        wikiRepository: wiki,
        codeRepository: code,
        expectedVersion: version,
      });
      setVersion(saved.version);
      toast("来源仓库配置已保存", "ok");
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };
  return html`<form onSubmit=${save}>
    <div class="field-grid">
      <label class="field">
        Wiki 知识仓库
        <input
          placeholder="例如 git@git.example.com:team/ads-wiki.git"
          value=${wiki}
          disabled=${loading || saving}
          onInput=${(e) => setWiki(e.target.value)}
        />
        <span class="meta">领域知识页面与金样例问答的维护仓库。</span>
      </label>
      <label class="field">
        代码仓库
        <input
          placeholder="例如 git@git.example.com:team/ads-service.git"
          value=${code}
          disabled=${loading || saving}
          onInput=${(e) => setCode(e.target.value)}
        />
        <span class="meta">业务系统代码仓库，用于技术视角回答与知识核对。</span>
      </label>
    </div>
    <div class="form-actions">
      <span class="meta">版本 ${version}</span>
      <span class="spacer"></span>
      <button
        class="btn btn-primary"
        type="submit"
        disabled=${loading || saving}
      >
        ${saving ? "保存中…" : "保存来源仓库"}
      </button>
    </div>
  </form>`;
}

export default function Manage({ domain, dataVersion }) {
  return html`<div class="manage-view">
    <h2 class="section-title first">领域设置</h2>
    <p class="meta">
      领域由 1～2
      名管理员维护：配置知识来源仓库；人员在「人员与标签」、话术在「回答风格」单独维护。
    </p>
    <div class="card">
      <div class="group-title">来源仓库</div>
      <${SourceRepos} domain=${domain} dataVersion=${dataVersion} />
    </div>
  </div>`;
}
