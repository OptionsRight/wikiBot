# 剩余 spec 并行实施协调

用户于 2026-09-27 要求开多个任务完成剩余工作。本轮使用现有 wikibot 本地项目，所有任务共享工作区。当前 Git HEAD 为 `75c6dc026fe8c2f91e5ff329cc2fce6615f5b48b`；其后的 Pi、检索式问答、真实 Wiki 接入、多轮上下文和流式相关改动尚在工作区，属于必须保留并纳入检查的既有工作。

## 已启动任务

所有任务位于 wikibot 本地项目，hostId 为 local。

| 编号 | 任务名称 | Thread ID |
|---|---|---|
| A | 同步检索式方案与剩余 spec | `01a0e0e7-497e-7ad2-9bf6-09efda80ebb6` |
| B | 完善检索问答与质量评估 | `01a0e0e7-4c6d-7d93-a3f0-62b437b8d537` |
| C | 完成企微问答与工单闭环 | `01a0e0e7-4f0b-7b81-9d4a-b1dfe10086c5` |
| D | 完成知识修订与来源写回 | `01a0e0e7-52ee-7c50-944a-e57f9088b484` |
| E | 完善权限与运行恢复机制 | `01a0e0e7-55d4-7a40-92fa-19d76a544ba6` |
| F | 集成剩余 spec 并完成验收 | `01a0e0e8-dcdb-7bf3-b4f4-444feab79d4d` |

## 共同基线

- 先读取 CONTEXT.md、docs/agents/issue-tracker.md、docs/adr/0004-retrieval-first-answers.md 和自己的本地 spec。ADR-0004 已接受检索式问答，旧结构化流程清单与分支穷举不再是实现目标；旧 spec 正由规格任务统一更新。
- 阅读 evidence/pi-transport.md、retrieval-pivot.md、wecom-dialogue.md。区分历史版本证据和当前实现；不能把旧合成企微实验直接算成新检索链路的真实验收。
- 用户要求本地 Markdown 追踪，不发布 GitHub Issues、PR 或推送。任务全量验收必须有实际证据。公司身份、业务专家、知识管理员、原维护技能等缺口如实记录，继续完成不依赖它们的开发。
- 已有真实 Wiki 位于 `/Users/rubychen/Desktop/credit-market-advert/wiki`。源正文默认只读；来源写回开发先用隔离副本。不得把既有真实 Wiki bundle、原始对话、账号映射或凭据批量加入 Git。
- 只有企微任务负责真实 bot 连接和对用户发消息；其他任务使用本地替身/临时端口。不要重启共享服务或夺取 bot 连接。未得到用户确认的知识管理员或公司 SSO 身份不能自定。

## 协作规则

1. 不切换分支，不 reset/clean/stash，不撤销其他人的改动。各任务先记录负责文件的初始状态，基于现有内容增量修改。
2. 写入范围见下表。共享文件 `.env.example`、`package.json`、`package-lock.json`、`src/server.ts`、`test/helpers.ts` 由集成任务负责；需要调整时在自己的 evidence 报告中写明接口和精确修改建议。不为集成方便复制另一套生产实现。
3. 所有 spec、plan.json、CONTEXT.md、ADR、README.md、docs/operations.md、总 implementation.md 由规格任务负责。其他任务只写自己的专属证据文件，并给规格任务留下状态与验收建议。
4. 各实现任务运行适合变更的定向测试和类型检查，保存命令与结果。共享代码暂未就绪导致失败时准确标注依赖，完成可独立验证部分。集成任务在实现任务结束后统一补接口、运行完整测试、双轴审查和提交。
5. 实现任务期间不执行 Git 暂存或提交，防止混入并行变更；此轮由集成任务统一提交。本规则是当前共享目录的具体实施安排。每项任务最后写清完成内容、剩余项、测试结果、文件列表与交接建议。
6. 不把外部前提缺失变成所有工作的阻塞，也不通过弱化授权、编造引用、改统计分母或把运行完成当作质量通过来关闭验收。

## 文件责任和任务范围

| 任务 | spec 范围 | 独占写入范围 | 交付证据 |
|---|---|---|---|
| A 规格同步 | 全部 01–26 的当前语义、依赖、验收映射 | `.scratch/wikibot-v0.4/spec.md`、`plan.json`、`issues/`、README、wiki-readiness、总 implementation；CONTEXT、docs/adr、docs/handoff Markdown、docs/operations、仓库 README | `evidence/parallel-spec-alignment.md` |
| B 问答质量 | 01、06–11 的问答/评估部分，17–18 历史内容边界，20 题集工具 | `src/answers.ts`、`src/explanation.ts`、`src/retrieval.ts`、`src/evaluations.ts`、`src/procedures.ts`、`src/adapters/model.ts`、`src/demo-model.ts`；answers/model/evaluations/procedures/context/text-stream 测试及新增独立检索测试；专属题集草稿/评估工具 | `evidence/parallel-answer-quality.md` |
| C 企微与工单 | 02、04 跨端映射部分、10、12–14、15 bot 入口、22、24 | `src/channel.ts`、`src/adapters/wecom.ts`、`src/tickets.ts`、`src/notifications.ts`、`web/`；channel/wecom/notifications/tickets/visibility 测试；企微诊断工具和新增渠道/工单附件模块 | `evidence/parallel-channel-feedback.md` |
| D 知识维护 | 03、05、15–16 维护服务、23 | `src/snapshot.ts`、`src/revisions.ts`、`tools/manifest.ts`、`tools/snapshot.ts`；snapshot/revisions 测试；新增受控来源助手、来源格式/附件模块及其独立测试 | `evidence/parallel-source-maintenance.md` |
| E 运行可靠性 | 04 身份服务、11 存储/恢复部分、17–19 | `src/core.ts`、`src/app.ts`、`src/auth.ts`、`src/publication.ts`、`src/operations.ts`；access/auth/citations/durability/late-ack/model-change/recovery/publication/revocation 测试；新增运维模块/工具 | `evidence/parallel-runtime-reliability.md` |
| F 集成验收 | 各接口整合、20–21、25–26 | 共享文件和独立集成/验收工具、第二领域配置；其他任务结束并交接后可修复全局接口与测试，最后同步总状态 | `evidence/parallel-integration-acceptance.md` |

A–E 之间需要越过文件边界的修改先记录给 F，由 F 在文件拥有者结束后执行。D 管知识来源附件，C 管工单附件，二者授权和保留范围不可混淆。B 管 Answer 状态与历史，E 对其提出恢复/撤回测试要求，避免同时编辑 answers.ts。

## 首要交付

- A：同步检索式方案，重写 08/09；将 15 秒答案期限与原 3 秒首段/10 秒整答 SLO 的差异写清，不自行宣布 SLO 通过。
- B：修复评估只运行不判定、协议失败自动挂首篇引用、历史未按当前有效性和交付范围过滤三个问题；核对最新流式改动是否会提前泄露未校验内容。
- C：完成自由文本、追问、取消、超限、反馈登记/查询的当前链路；有条件时补真实企微证据。群目录不可信时保留关闭，工单附件须有对象级鉴权。
- D：完成可执行的受控更正与再发布交接、冲突/部分写入恢复及隔离副本往返；原技能不可用时把适配缺口留明，不能假冒原技能已通过。
- E：验证崩溃、租约、撤回/换模竞争、备份恢复、可观测与保留清理；公司独立证明和 RPO/RTO 未知时保留外部验收。
- F：收集各报告、补共享接口、做完整回归与独立双轴审查、整合第二领域配置，给出逐 spec 的实现/验收/外部阻断清单。真实 1000 请求、专家结论和业务观察不能用合成测试代替。

## 用户追加要求：可配置身份、标签与 Wiki 目录

用户已回答：管理员可配置，Wiki 目录可配置，用户的角色标签可配置；同一用户可以同时是业务人员与技术人员，兼有时按技术人员。无需再要求现在指定固定管理员或固定 Wiki 路径才能开发。

本轮据此落地：

- 领域知识管理员与普通成员资格由受权配置管理，不硬编码 rubychen 或任一账户为管理员。
- 每个领域的 Wiki 工作区根目录和来源适配入口可配置；现有真实目录仅作实例，不写死在业务代码。目录变更须重新校验来源绑定、基线与访问边界，不能允许普通成员传任意文件路径。
- 用户允许同时拥有 business、technical 两种表达标签；技术优先决定默认回答视角。表达标签不授予知识管理、平台管理或跨域访问权限。
- 保留既有显式回答偏好能力；标签用于默认值，多标签默认 technical。若用户随后要求不同的显式偏好优先级，再同步规格与实现。
- A 负责定义并同步配置契约；E 负责身份/资格/标签配置的服务端模型与管理授权；B 消费配置计算回答默认值；C 提供网页/bot 的授权管理及展示交互；D 实现可配置 Wiki 工作区；F 负责跨模块集成和配置示例。
- 这解决“配置如何实现”的需求，原 llm-wiki skill 的实际定义与真实往返兼容性仍需据实检查，不能把路径可配置等同于技能已安装。
