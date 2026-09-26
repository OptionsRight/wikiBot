# wikiBot v0.4 任务拆分

2026-09-26 · in-progress · 用户已选择仅保存为本地 Markdown。

[实施规格](spec.md)包含 50 条用户故事。下列 26 项每项独立成文，写明交付结果、依赖、外部前提、验收条件和验证方式。当前已有单机集成实现及最小真实连通性证据；未完成试点验收。详见 [实施状态](evidence/implementation.md)。

2026-09-26 用户已补充智谱 CC 模型接入参考，已纳入[任务 01](issues/01-model-compatibility.md)：优先验证 glm-5.3，并独立评估 glm-5.3-flash。入口及模型线索已具备，实际标准 API 服务、鉴权、配额与兼容性仍待实测；密钥未保存到文档或仓库。任务依赖与草稿状态保持不变。

同日用户明确第一阶段支持企业微信机器人，并提供 Bot 接入凭据，已纳入[任务 02](issues/02-wecom-identity-delivery-probe.md)与[任务 12](issues/12-wecom-single-chat.md)。首阶段包含单聊问答、基本工单/反馈及 bot 维护入口；认证连接、成员身份映射和交付协议仍待验证。文档仅记录凭据已提供，不保存实际值；修正 Bot ID 后鉴权已成功，尚未发送业务消息。

用户已提供广告 Wiki 本地目录，并确认由 llm-wiki skills 更新，已更新[任务 03](issues/03-wiki-roundtrip-probe.md)及完整设计/交接。见 [Wiki 接入准备](wiki-readiness.md)：已有 98 个知识 Markdown 文件，内容版本 v2.4.2；发布助手沿用技能维护入口，具体技能定义与版本仍待定位，当前 Git 子模块指针目标缺失。源 Wiki 未修改，目录盘点不代表往返验证通过。

## 审阅要点

建议采用公开业务行为作为主要测试边界：认证请求/渠道事件进入后，验证用户可观察结果、持久化业务状态和交付。模型、企微、Wiki 仅在窄适配边界替换测试实现，并另做真实联调。用户已通过 implement 指令确认这些边界、粒度和依赖。

执行中的票标 in-progress，缺必要外部能力的票标 blocked。ready-for-agent 表示可被执行者领取，仍须检查依赖是否完成、外部账号/资料是否可用。每完成一项保存证据并标 done，再推进新可执行任务。

## 任务清单

只列直接前置任务；传递依赖不重复列出。无任务依赖也仍受该票外部前提约束。

1. **[验证公司模型的真实问答契约](issues/01-model-compatibility.md)**（阶段 0）\
   **Blocked by：** 无任务依赖。**交付：** 用公司批准的真实模型服务完成一条带引用的流程回答与一次受限工具读取，给出可采用的适配方式、限制和失败证据。

2. **[验证企微身份、消息与交付协议](issues/02-wecom-identity-delivery-probe.md)**（阶段 0）\
   **Blocked by：** 无任务依赖。**交付：** 在真实测试租户走通单聊入站、企业身份映射和累计流式回复，并确认群受众是否具备可核验条件。

3. **[验证 llm_wiki 知识往返与来源更正](issues/03-wiki-roundtrip-probe.md)**（阶段 0）\
   **Blocked by：** 无任务依赖。**交付：** 用真实小工作区完成导出、改名、引用、来源更正和重新导入，证明平台可以保留稳定身份及更正依据。

4. **[成员登录并进入有资格访问的领域](issues/04-authorized-domain-entry.md)**（试点）\
   **Blocked by：** [02](issues/02-wecom-identity-delivery-probe.md)。**交付：** 平台配置人员开通一个待发布领域，成员通过公司身份进入该领域并看到准确的待发布状态；无资格者无法读取。

5. **[维护者提交快照并查看最终差异](issues/05-snapshot-review.md)**（试点）\
   **Blocked by：** [03](issues/03-wiki-roundtrip-probe.md)、[04](issues/04-authorized-domain-entry.md)。**交付：** 维护者手动提交一个领域的文本知识快照，管理员在网页查看最终正文、来源与流程结构差异。

6. **[发布一条固定流程并供成员浏览](issues/06-publish-first-procedure.md)**（试点）\
   **Blocked by：** [01](issues/01-model-compatibility.md)、[05](issues/05-snapshot-review.md)。**交付：** 管理员复核、评估并激活一条固定流程，成员通过稳定入口读取同一版本的完整原文和引用。

7. **[网页问答返回完整流程与可信引用](issues/07-web-grounded-answer.md)**（试点）\
   **Blocked by：** [06](issues/06-publish-first-procedure.md)。**交付：** 成员在网页询问已发布固定流程，得到程序呈现的必需清单、模型补充解释和可核对引用；单步问题获得适当简答。

8. **[按支持范围澄清并选择唯一完整路径](issues/08-exclusive-guidance-paths.md)**（试点）\
   **Blocked by：** [07](issues/07-web-grounded-answer.md)。**交付：** 对有分支的流程先确认必要条件，只有在批准支持范围内唯一命中完整路径时才给操作清单；复杂问题可在预算内补读依据。

9. **[按咨询对象继承输入并按语义重确认](issues/09-guidance-context.md)**（试点）\
   **Blocked by：** [08](issues/08-exclusive-guidance-paths.md)。**交付：** 成员同对象追问可复用有效条件，换对象或知识规则变化时只要求重新确认受影响条件。

10. **[切换回答视角与深度并管理偏好](issues/10-response-preferences.md)**（试点）\
   **Blocked by：** [07](issues/07-web-grounded-answer.md)。**交付：** 成员切换业务/技术视角和入门/熟练深度，明确要求时保存或删除长期偏好，必要流程步骤保持一致。

11. **[网页回答在重试、断线和崩溃后保持可查](issues/11-durable-web-answer.md)**（试点）\
   **Blocked by：** [07](issues/07-web-grounded-answer.md)。**交付：** 网页重复提交、重连或取消仍指向准确答案；服务崩溃后不产生重复业务对象，也不拼接另一轮模型生成。

12. **[企微单聊接入同一问答与交付服务](issues/12-wecom-single-chat.md)**（试点）\
   **Blocked by：** [10](issues/10-response-preferences.md)、[11](issues/11-durable-web-answer.md)。**交付：** 已认证成员在真实企微单聊取得与网页一致的答案、偏好与引用，能区分完整送达、超限转网页和投递未知。

13. **[成员登记独立问题并跟踪处理](issues/13-standalone-question-ticket.md)**（试点）\
   **Blocked by：** [04](issues/04-authorized-domain-entry.md)。**交付：** 成员无需既有答案即可在网页主动登记问题，处理人分诊并给结果，由报告人确认关闭、撤回或重开。

14. **[跨端登记、反馈并关联最小工单证据](issues/14-answer-feedback.md)**（试点）\
   **Blocked by：** [12](issues/12-wecom-single-chat.md)、[13](issues/13-standalone-question-ticket.md)。**交付：** 成员在网页或企微单聊主动登记问题、反馈有权查看的答案并跟踪本人工单；处理人只看到定位所需证据。

15. **[管理员通过 bot 发起并跟踪知识修订](issues/15-bot-maintenance-draft.md)**（试点）\
   **Blocked by：** [14](issues/14-answer-feedback.md)。**交付：** 管理员在企微单聊主动修订知识或从工单发起修订，取得草稿编号、网页差异预览和真实的待写回状态。

16. **[更正写回来源并经复核发布生效](issues/16-source-correction-release.md)**（试点）\
   **Blocked by：** [15](issues/15-bot-maintenance-draft.md)。**交付：** 维护者应用管理员修订到唯一维护源，重新提交一致快照，经复核评估发布；工单得到真实版本与回归证据。

17. **[并发发布、紧急撤回与安全回滚](issues/17-publication-revoke-rollback.md)**（试点）\
   **Blocked by：** [12](issues/12-wecom-single-chat.md)。**交付：** 管理员在并发更新或错误知识事件中得到唯一发布结果，能够撤回并发布修复，网页和企微停止后续失效正文。

18. **[模型变更暂停服务并标记历史答案](issues/18-model-change-gates.md)**（试点）\
   **Blocked by：** [17](issues/17-publication-revoke-rollback.md)。**交付：** 登记已知模型变化后，受影响生成和旧评估发布立即受控；原受众仅能查看已交付部分并看到“模型验证待确认”。

19. **[部署后从可信状态恢复服务](issues/19-trusted-recovery-operations.md)**（试点）\
   **Blocked by：** [16](issues/16-source-correction-release.md)、[18](issues/18-model-change-gates.md)。**交付：** 运维能部署并观测试点，在恢复旧备份后核对独立当前状态，安全处理旧作业，再按范围恢复开放。

20. **[三类广告流程通过真实知识评估](issues/20-three-advertising-flows.md)**（试点）\
   **Blocked by：** [09](issues/09-guidance-context.md)、[16](issues/16-source-correction-release.md)。**交付：** 知识负责人批准三个广告流程的明确支持范围，成员可在这些范围内完成完整问答，且真实题集经专家核对。

21. **[完成受控试点验收并给出上线结论](issues/21-controlled-pilot-acceptance.md)**（试点验收）\
   **Blocked by：** [19](issues/19-trusted-recovery-operations.md)、[20](issues/20-three-advertising-flows.md)。**交付：** 以固定范围、负载和版本验证一个广告领域的三流程、网页/企微单聊和维护闭环，形成可追溯的通过或阻断结论。

22. **[向获准群受众回答并安全引用历史](issues/22-authorized-group-chat.md)**（完整范围）\
   **Blocked by：** [18](issues/18-model-change-gates.md)。**交付：** 只有群受众可核验且全部有资格时提供群答案，引用历史答案不带出个人上下文、未交付内容或失效正文。

23. **[完整来源格式、改名与静态附件往返](issues/23-wiki-formats-attachments.md)**（完整范围）\
   **Blocked by：** [16](issues/16-source-correction-release.md)。**交付：** 维护者提交包含改名、来源摘录、内部链接和获准静态附件的知识，成员看到稳定引用，更正后重新导入仍一致。

24. **[工单合并、内部备注和附件保持隔离](issues/24-advanced-ticket-visibility.md)**（完整范围）\
   **Blocked by：** [14](issues/14-answer-feedback.md)。**交付：** 成员与管理员在网页/企微处理完整工单交互，合并重复工单、补充附件或内部备注时仍保持各自可见范围。

25. **[通过配置接入第二个非广告领域](issues/25-second-domain-configuration.md)**（完整范围）\
   **Blocked by：** [08](issues/08-exclusive-guidance-paths.md)、[16](issues/16-source-correction-release.md)。**交付：** 第二领域负责人通过现有配置、发布入口、角色及 bot 绑定接入同一框架，成员取得本领域知识并与广告领域隔离。

26. **[完成完整范围联合验收](issues/26-full-scope-acceptance.md)**（完整验收）\
   **Blocked by：** [21](issues/21-controlled-pilot-acceptance.md)、[22](issues/22-authorized-group-chat.md)、[23](issues/23-wiki-formats-attachments.md)、[24](issues/24-advanced-ticket-visibility.md)、[25](issues/25-second-domain-configuration.md)。**交付：** 在试点已验证基础上，群聊、完整来源/附件、高级工单与第二领域均有真实证据，给出完整 v0.4 范围的验收结论。

## 推进方式

第一批为 01、02、03 三项真实契约验证，可由具备相应环境的人并行开展。各验证缺什么就记录具体阻断；禁止以 mock 通过替代真实证据。三项合计沿用阶段 0 的 4–6 人日量级，完成后校准估算。

04 起随完整业务路径建立服务、身份、持久化与界面。13 的独立问题工单只依赖 04，可与知识问答链路并行。08/09 的分支与对象上下文、10 的风格、11 的恢复分别验证后汇合。来源维护与版本安全链路分别推进，在 19/20 汇合为 21 试点验收。

22–25 在各自前置任务就绪后即可推进，不人为依赖试点验收完成；26 才同时要求 21 与所有完整范围扩展通过。顺序编号不是一条串行排期，外部专家资料可提前准备。

试点 21 包含一个广告领域的三个已批准流程范围、网页和企微单聊、视角/深度、两种领域角色、跨端基本工单与反馈、bot 维护、来源更正及发布、撤回/回滚、模型门禁与可信恢复。群聊、完整来源/附件、高级工单和第二领域在 26 验收，未启用内容不得借试点通过宣称完成。

50–75 人日为试点、85–125 人日为完整累计量级，沿用原估算，未按任务数量线性分摊，也未承诺固定交付日期。每项按一次独立实施上下文组织；遇到真实接口证据推翻假设，先记录影响，再调整任务或回到相应设计决定。

## 最小验收矩阵责任映射

责任任务实现并证明该行为，复验任务验证真实业务及跨功能组合；映射表示验收责任，绝非已经通过。所有 30 个设计验收 ID 均保留。

| ID | 行为 | 责任任务 | 复验任务 |
|---|---|---|---|
| Q-01 | 引用合法仍漏必要节点 | [07](issues/07-web-grounded-answer.md) | [20](issues/20-three-advertising-flows.md)、[21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| Q-02 | 模型伪装澄清输出操作建议 | [08](issues/08-exclusive-guidance-paths.md) | [20](issues/20-three-advertising-flows.md)、[21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| Q-03 | 装配时知识/模板切换 | [07](issues/07-web-grounded-answer.md) | [21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| Q-04 | 重叠条件与多命中 | [08](issues/08-exclusive-guidance-paths.md) | [20](issues/20-three-advertising-flows.md)、[21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| Q-05 | 零命中或 unknown 的区别 | [08](issues/08-exclusive-guidance-paths.md) | [20](issues/20-three-advertising-flows.md)、[21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| Q-06 | 咨询对象切换/不明 | [09](issues/09-guidance-context.md) | [20](issues/20-three-advertising-flows.md)、[21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| Q-07 | 支持范围内空洞/范围外 | [08](issues/08-exclusive-guidance-paths.md) | [20](issues/20-three-advertising-flows.md)、[21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| Q-08 | 跨版本字段语义兼容 | [09](issues/09-guidance-context.md) | [20](issues/20-three-advertising-flows.md)、[21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| Q-09 | 旧摘要恢复失效输入 | [09](issues/09-guidance-context.md) | [20](issues/20-three-advertising-flows.md)、[21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| P-01 | 同 epoch 候选竞争 | [17](issues/17-publication-revoke-rollback.md) | [21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| P-02 | 候选检查与撤回竞争 | [17](issues/17-publication-revoke-rollback.md) | [21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| P-03 | 撤回后的空指针修复 | [17](issues/17-publication-revoke-rollback.md) | [21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| R-01 | 入站接收事务崩溃重放 | [11](issues/11-durable-web-answer.md) | [12](issues/12-wecom-single-chat.md)、[21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| R-02 | 旧 worker 迟到结果 | [11](issues/11-durable-web-answer.md) | [18](issues/18-model-change-gates.md)、[21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| R-03 | 模型已调用但结果未保存 | [11](issues/11-durable-web-answer.md) | [21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| R-04 | 通知发送后丢失回执 | [12](issues/12-wecom-single-chat.md) | [14](issues/14-answer-feedback.md)、[21](issues/21-controlled-pilot-acceptance.md)、[24](issues/24-advanced-ticket-visibility.md)、[26](issues/26-full-scope-acceptance.md) |
| R-05 | 恢复到撤回/撤权之前 | [19](issues/19-trusted-recovery-operations.md) | [21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| R-06 | 旧 pending 的执行未知 | [19](issues/19-trusted-recovery-operations.md) | [21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| M-01 | 已知模型变化的新调用/激活 | [18](issues/18-model-change-gates.md) | [21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| M-02 | 历史已交付/未交付范围 | [18](issues/18-model-change-gates.md) | [19](issues/19-trusted-recovery-operations.md)、[21](issues/21-controlled-pilot-acceptance.md)、[22](issues/22-authorized-group-chat.md)、[26](issues/26-full-scope-acceptance.md) |
| M-03 | 变更后进行中/迟到结果 | [18](issues/18-model-change-gates.md) | [21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| M-04 | 新回归不清除历史警示 | [18](issues/18-model-change-gates.md) | [19](issues/19-trusted-recovery-operations.md)、[21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| A-01 | 伪造角色/工具/旧按钮 | [04](issues/04-authorized-domain-entry.md) | [10](issues/10-response-preferences.md)、[15](issues/15-bot-maintenance-draft.md)、[21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| A-02 | 跨域或他人私人对话 | [04](issues/04-authorized-domain-entry.md) | [14](issues/14-answer-feedback.md)、[15](issues/15-bot-maintenance-draft.md)、[21](issues/21-controlled-pilot-acceptance.md)、[22](issues/22-authorized-group-chat.md)、[25](issues/25-second-domain-configuration.md)、[26](issues/26-full-scope-acceptance.md) |
| A-03 | 提交之后管理员撤权 | [16](issues/16-source-correction-release.md) | [17](issues/17-publication-revoke-rollback.md)、[21](issues/21-controlled-pilot-acceptance.md)、[26](issues/26-full-scope-acceptance.md) |
| A-04 | 合并/附件/内部备注隔离 | [24](issues/24-advanced-ticket-visibility.md) | [26](issues/26-full-scope-acceptance.md) |
| C-01 | 撤回时排队正文/网页重连 | [17](issues/17-publication-revoke-rollback.md) | [18](issues/18-model-change-gates.md)、[21](issues/21-controlled-pilot-acceptance.md)、[22](issues/22-authorized-group-chat.md)、[26](issues/26-full-scope-acceptance.md) |
| C-02 | 多块/迟到回执/最终超限 | [12](issues/12-wecom-single-chat.md) | [21](issues/21-controlled-pilot-acceptance.md)、[22](issues/22-authorized-group-chat.md)、[26](issues/26-full-scope-acceptance.md) |
| W-01 | 来源冲突/部分写入/再导入 | [16](issues/16-source-correction-release.md) | [20](issues/20-three-advertising-flows.md)、[21](issues/21-controlled-pilot-acceptance.md)、[23](issues/23-wiki-formats-attachments.md)、[26](issues/26-full-scope-acceptance.md) |
| W-02 | 正文和流程结构同步复核 | [16](issues/16-source-correction-release.md) | [20](issues/20-three-advertising-flows.md)、[21](issues/21-controlled-pilot-acceptance.md)、[23](issues/23-wiki-formats-attachments.md)、[26](issues/26-full-scope-acceptance.md) |

试点未启用合并、附件和内部备注时，A-04 标明“不适用/未启用”，不能标通过；其完整验收由 24、26 承担。其余 ID 在启用的试点路径均需证据；群聊和完整附件带来的新组合另在 22–26 验证。

## 来源与可追溯性

以当前工作区经过访谈修订的[完整设计](../../docs/handoff/domain-knowledge-bot-design-v0.4.md)、[交接](../../docs/handoff/development-handoff.md)、[领域术语](../../CONTEXT.md)及三个已接受 ADR 为依据。七项访谈决定见[审查记录](../../reviews/wikiBot-v0.4-grill-2026-09-26/REVIEW.md)。

远端基线为 ab250d6159f5fef40b238334627b2ccfc1d3faf2，仍不包含当前全部本地修订。[机器可读索引](plan.json)记录规范来源 SHA-256、任务依赖、50 条用户故事映射和 30 项验收映射；用于核对拆分依据，不代表已冻结或已运行验证。实现提交携带规格、任务与相关已确认设计。

新实施上下文应先阅读规格、所领取单票、领域术语及其相关 ADR，并检查前置任务的真实证据。每项票据均交付可观察行为，避免把“写表结构”“搭接口”当独立已完成业务。
