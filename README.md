# wikiBot

面向不同业务领域的企业知识 Bot：复用现有 llm-wiki skills 维护的知识库，使用公司模型，提供企业微信与网页问答、不同人群的回答风格、按角色开放的能力、反馈及问题登记，以及管理员知识修订和复核发布。

## 当前状态

v0.5 已增加真实 Docling 文档标准化、Claim/Evidence 双时间与冲突复核、V2 sidecar 与增量 Code Wiki、真实 DeepEval 影子/校准门禁和版本内正式回答块。保留 V1 包及旧哈希、现有工单、权限、Pi ModelGateway 和企微交付。

先看 [v0.5 运行与迁移](docs/operations-v0.5.md) 和 [实施与验证记录](docs/handoff/v0.5-implementation.md)。合成端到端真实运行 Docling/DeepEval；公司模型 judge、业务专家校准、真实企微和负载是独立验收条件，不能由合成结果代替。

```sh
npm ci
npm run demo
WIKIBOT_DEMO=1 npm run dev
```

访问 `http://127.0.0.1:3000`，使用用户名 `demo-admin` / `demo-member` 和 `.local/demo-access.json` 中 `passwords.admin` / `passwords.member` 的随机密码（同文件令牌供 API 使用）。演示仅含合成知识和固定模型。配置、发布、企微及恢复步骤见[运行手册](docs/operations.md)。

## 阅读入口

| 文档 | 用途 |
|---|---|
| [增量完整设计 v0.5](docs/handoff/domain-knowledge-bot-design-v0.5.md) | 基于最新代码的 Docling、Claim/Evidence、双时间、Conflict、sidecar、Code Wiki 和 DeepEval 设计 |
| [v0.5 技术决策](docs/adr/0005-document-claims-and-evaluation.md) | 复用边界、兼容迁移和依赖部署方式 |
| [开发交接](docs/handoff/development-handoff.md) | 开工顺序、先决条件、交付物与完成标准 |
| [历史成本估算](docs/handoff/domain-knowledge-bot-cost-estimate-v0.3.md) | 早期从零方案的预算假设，不代表当前剩余投入 |
| [独立设计审查](reviews/wikiBot-design-review-2026-09-25/REVIEW.md) | F1–F5 的原始问题、反例和验证要求 |
| [v0.4 设计访谈](reviews/wikiBot-v0.4-grill-2026-09-26/REVIEW.md) | 两轮已确认的设计取舍、收口后的设计树和待验证事项 |
| [领域语言](CONTEXT.md) | 领域、权限、表达标签、知识支持范围与工单术语 |
| [实施规格与任务](.scratch/wikibot-v0.4/README.md) | 本地实施规格、26 项独立任务、依赖与验收映射 |

2026-09-26 两轮访谈 Q1–Q7 已纳入 v0.4，本轮审查树已收口，尚待实现及真实验证。结构化路径已由 [检索式 ADR](docs/adr/0004-retrieval-first-answers.md) 替代；继续有效的约束见 [恢复 ADR](docs/adr/0002-verify-state-before-restoring-service.md) 和[模型验证 ADR](docs/adr/0003-revalidate-known-model-changes.md)。

## 设计摘要

- 同一个领域的获准成员查询同一套已发布知识；私人对话、工单、草稿分别授权。
- 业务/技术视角与入门/熟练深度控制表达方式；普通成员/知识管理员控制操作能力。
- 普通成员可以自由文本提问、反馈、登记和跟踪本人问题。
- 管理员可以处理领域工单，通过 bot 发起修订，经来源写回、最终复核和发布生效。
- 回答由服务端中文词法检索取证据页面、公司模型单次组织生成，引用固定在不可变发布版本；质量由金样例评估与反馈闭环管理（ADR-0004）。
- 采用模块化 TypeScript 服务、关系数据库、不可变知识包及异步任务；公司模型经 `ModelGateway` 适配层接入，传输层为固定版本的 `@earendil-works/pi-ai`，受限工具循环（设计 4.2）仍为预留。

## 开发入口

2026-10-07 以 `cbc4742` 为代码基线重新设计。保留现有检索优先、SQLite、Pi、网页/企微与权限工单，按 v0.5 的 M0–M5 接入文档标准化、轻量 Claim、证据 sidecar、增量 Code Wiki 与质量门禁。新增能力目前仅有设计，尚未安装依赖或实现。

旧成本估算对应只有文档时的从零开发范围；本次基于现有代码计算增量，在四种格式样本和最小 Claim 链路验证后更新排期。

## 历史材料

- [v0.4 设计及后续修订](docs/handoff/domain-knowledge-bot-design-v0.4.md)
- [v0.3 人群、权限与问题登记修订](docs/handoff/domain-knowledge-bot-design-v0.3.md)
- [v0.2 设计](docs/handoff/domain-knowledge-bot-design-v0.2.md)
- [v0.2 聚焦复查](docs/handoff/domain-knowledge-bot-review-v0.2.md)
- [历史 HTML](docs/handoff/domain-knowledge-bot-design.html)

当前实现事实以代码为准；新增目标以 v0.5 与 ADR-0005 为准。ADR-0002/0003/0004 继续有效，历史记录不自动代表新能力已经实现或验收。

管理员权限、用户表达标签和 Wiki 来源目录均按领域受控配置；business/technical 可以并存，兼有默认技术视角，显式偏好优先。默认15秒答案期限是运行终止边界，原3秒首段/10秒整答联合 SLO 仍待真实验收。本轮加入受控来源更正、隔离附件、恢复与渠道崩溃对账、多 bot 配置及[第二领域合成示例](examples/second-domain/README.md)。最终验证和逐票剩余项见[集成验收](.scratch/wikibot-v0.4/evidence/parallel-integration-acceptance.md)，不据此宣称试点或完整 v0.4 验收通过。
