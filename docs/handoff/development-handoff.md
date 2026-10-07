# wikiBot 开发交接：v0.5 增量设计

更新日期：2026-10-07\
代码基线：`cbc47424012f6841e07ca26131e70092b230c783`。\
目标规格：[完整设计 v0.5](domain-knowledge-bot-design-v0.5.md)；决策：[ADR-0005](../adr/0005-document-claims-and-evaluation.md)。\
交付状态：本轮为设计；没有实现或安装 Docling、Claim Layer、Code Wiki、DeepEval，也没有重新运行产品测试。

## 1. 从已存在的代码继续

当前已有 TypeScript/Fastify API、Preact 网页、SQLite Store、Pi 公司模型适配、中文词法检索、单次生成、权限/工单、知识修订与发布、企微连接和投递状态，以及对应测试。

保留 ADR-0004 的检索路线。现有 llm-wiki skills 管理来源，真实维护 adapter 仍须核对；不要把隔离 Markdown 实验当作生产来源写回通过。

已有 26 项任务与历史证据仍保持各自提交/环境的适用范围。本次新增需求不得直接记在历史 done/验收记录里。

## 2. 实施顺序

| 阶段 | 重点 | 退出证据 |
|---|---|---|
| M0 | 复跑基线、版本与哈希协议、四种格式样本、人工金样例 | 明确现有结果及边界，形成兼容性样例 |
| M1 | Docling Python worker、原始资产、标准化产物和定位 | PDF/DOCX/PPTX/XLSX 正常和边界样本；失败/partial/重试/授权验证 |
| M2 | Evidence、ClaimVersion、双时间、Conflict、sidecar、Bundle V2 | 一条事实从来源到已发布引用可复查；纠错不丢历史，V1 可读 |
| M3 | DeepEval、可信结果、门禁、回答证据上下文和协议 V2 | 缺题/超时不通过；不补假引用；风格/权限/恢复回归通过 |
| M4 | 依赖图、增量、只读 Git resolver 与 Code Wiki | no-op、变化、删除、改名和证据失效均正确影响候选 |
| M5 | 新旧知识共存的受控试点与恢复/负载 | 业务专家、渠道与运维分别验收，报告真实 SLO |

先选少量易变/易错页面建立 Claim，不要求为全部历史页面重新手写结构。旧 50–75/85–125 人日是早期从零估算，不应拿来直接计算本次剩余成本；在 M0/M1 后更新增量排期。

## 3. 文件落点

- 业务主干：src/core.ts、procedures.ts、publication.ts、governance.ts。
- 来源：src/snapshot.ts、source-formats.ts、source-artifacts.ts、source-maintenance.ts、controlled-source.ts 和 tools/manifest.ts。
- 问答：src/retrieval.ts、answers.ts、explanation.ts、adapters/model.ts。
- 评测：src/evaluations.ts、tools/acceptance-report.ts。
- 新模块：src/knowledge/ 下 Claim、Evidence、Conflict、sidecar、增量、resolver 和 job。
- Python：python/normalizer/ 运行 Docling；python/evaluation/ 在 dev/test 环境运行 DeepEval。
- 契约：contracts/knowledge/ 下版本化 JSON Schema 与跨语言哈希样例。
- 网页：沿用 web/src/views 管理页面，增加来源、事实、冲突、影响与质量报告视图。

上述新增路径是计划，不表示已有实现。旧 procedures.ts 实际保存 Bundle schema，本次先兼容升级，避免为改名而扩大变更。

## 4. 实施必须守住的约束

1. Node/TS 单写 SQLite；耗时解析、模型和网络调用在事务外，Python 无主库写权限。
2. 原始档案不可变，Docling 产物与解析配置版本化；来源定位不完整时如实标记。
3. Claim/Conflict 与页面修订一起治理；sidecar 只是受控投影，不能直接编辑即生效。
4. valid time、recorded time、published time 分别建模；草稿从不进入普通问答。
5. 领域权限、工单/私人历史隔离及模型变化门禁继续生效。
6. 对相同候选、来源、模板、评测策略固定摘要；评测报告不能错配版本。
7. V1/V2 分流解析，V1 原 hash 不改；当前字符串 hash 不等于原始字节 SHA-256。
8. 增量先复查证据，再判断 no-op；旧 worker、半成品和基线变化均不能激活。
9. 正式回答只包含允许的已校验块；第一检索页不是可以自动补上的答案证据。
10. 真实来源更新仍走受控维护 adapter；Code Wiki 只读源码，不执行仓库命令或改业务代码。
11. DeepEval complete 与 pass 分开，语义分数不替代确定性权限/版本检查与人工复核。
12. 15 秒是当前请求 deadline，原 3/10 秒联合 SLO 仍需实测，不在本轮假设已经达到。

## 5. 验证要求与输入

四种格式需要脱敏样本与人工对照；首个 Code Wiki 仓库和允许目录需明确；公司 judge 的接口、配额及可用模型需要验证。依赖和 OCR 模型工件在试验后精确锁定。

新用例至少覆盖：双时间迟到更正、同值不同限定条件、冲突与证据删除、sidecar 半写、改名/行号变化、来源哈希算法、旧版本恢复、权限撤销、模型变化、报告缺题、协议失败和未知投递。完整矩阵见设计第 12 节。

真实基线测试在具备 Node 和依赖后运行 npm test/typecheck/build；测试环境不得自动连接真实企微群或生产来源写入。CI/离线样例结果与真实渠道/业务验收分别记录。

## 6. 文档与运行入口

- [完整设计 v0.5](domain-knowledge-bot-design-v0.5.md)
- [本版 ADR](../adr/0005-document-claims-and-evaluation.md)
- [现有运行手册](../operations.md)：仍描述 cbc4742 已有应用，新 Python/Claim 能力实现时再补运行步骤。
- [历史 v0.4 设计](domain-knowledge-bot-design-v0.4.md)
- [历史集成证据](../../.scratch/wikibot-v0.4/evidence/parallel-integration-acceptance.md)
