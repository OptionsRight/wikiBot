# wikiBot

面向不同业务领域的企业知识 Bot：复用现有 llm-wiki skills 维护的知识库，使用公司模型，提供企业微信与网页问答、不同人群的回答风格、按角色开放的能力、反馈及问题登记，以及管理员知识修订和复核发布。

## 当前状态

仓库已有可运行的 TypeScript 单机集成实现：网页与企微自由文本问答（服务端检索已发布页面 + 单次模型生成，引用经白名单校验）、知识发布、工单及状态通知、修订草稿、模型门禁和恢复隔离。2026-09-26 按 [ADR-0004](docs/adr/0004-retrieval-first-answers.md) 从结构化清单查表改为检索优先，并完成真实 Wiki（161 页）首次发布与真实模型问答。具体范围见[实施证据](.scratch/wikibot-v0.4/evidence/implementation.md)，本轮见[检索改造与真实首跑记录](.scratch/wikibot-v0.4/evidence/retrieval-pivot.md)。

```sh
npm ci
npm run demo
WIKIBOT_DEMO=1 npm run dev
```

访问 `http://127.0.0.1:3000`，使用 `.local/demo-access.json` 中的演示令牌。演示仅含合成知识和固定模型。配置、发布、企微及恢复步骤见[运行手册](docs/operations.md)。

## 阅读入口

| 文档 | 用途 |
|---|---|
| [完整设计 v0.4](docs/handoff/domain-knowledge-bot-design-v0.4.md) | 当前范围、架构、角色、知识发布、问答、工单、API、恢复、部署和验收 |
| [开发交接](docs/handoff/development-handoff.md) | 开工顺序、先决条件、交付物与完成标准 |
| [成本估算](docs/handoff/domain-knowledge-bot-cost-estimate-v0.3.md) | 人日、排期、预算假设与持续运行成本 |
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

先进行公司模型、企微身份/交付和 llm_wiki 来源往返的真实验证，再实现一个流程的完整链路。设计中的并发锁、版本描述、恢复及权限契约需要实现并验证，不能把文档补充标为已经通过。

工程预算量级：单领域受控试点 50–75 人日；完整范围 85–125 人日，均含约 20% 储备。详见成本估算，实际排期在兼容性验证后更新。

## 历史材料

- [v0.3 人群、权限与问题登记修订](docs/handoff/domain-knowledge-bot-design-v0.3.md)
- [v0.2 设计](docs/handoff/domain-knowledge-bot-design-v0.2.md)
- [v0.2 聚焦复查](docs/handoff/domain-knowledge-bot-review-v0.2.md)
- [历史 HTML](docs/handoff/domain-knowledge-bot-design.html)

历史材料出现不同规则时，以 ADR-0004 及已同步的完整设计 v0.4/实施规格为准；历史复查结论不能代替本版本的实现与验收。

管理员权限、用户表达标签和 Wiki 来源目录均按领域受控配置；business/technical 可以并存，兼有默认技术视角，显式偏好优先。默认15秒答案期限是运行终止边界，原3秒首段/10秒整答联合 SLO 仍待真实验收。本轮加入受控来源更正、隔离附件、恢复与渠道崩溃对账、多 bot 配置及[第二领域合成示例](examples/second-domain/README.md)。最终验证和逐票剩余项见[集成验收](.scratch/wikibot-v0.4/evidence/parallel-integration-acceptance.md)，不据此宣称试点或完整 v0.4 验收通过。
