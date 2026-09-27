# wikiBot v0.4 本地实施任务

2026-09-27：按 [ADR-0004](../../docs/adr/0004-retrieval-first-answers.md) 采用检索式问答。当前已有实现与真实首跑，26项整体验收均未关闭。管理员/表达标签/Wiki目录可配置，双标签默认技术视角、显式偏好优先。

规范入口：[spec.md](spec.md)、[plan.json](plan.json)、[规格核对与交接](evidence/parallel-spec-alignment.md)、[总实施证据](evidence/implementation.md)。历史报告按当时版本理解，不把合成测试、真实接口实验与业务验收混为一谈。

## 任务与依赖

依赖表示验收先决条件，不强迫实现串行；blocked票仍可完成不依赖外部输入的工作。保留基线状态，F收齐并行证据后更新。

| 任务 | 状态 | 直接前置 | 本轮负责 |
|---|---|---|---|
| [01 验证公司模型的真实问答契约](issues/01-model-compatibility.md) | in-progress | 无 | B |
| [02 验证企微身份、消息与交付协议](issues/02-wecom-identity-delivery-probe.md) | in-progress | 无 | C |
| [03 验证 llm_wiki 知识往返与来源更正](issues/03-wiki-roundtrip-probe.md) | blocked | 无 | D |
| [04 成员登录并进入有资格访问的领域](issues/04-authorized-domain-entry.md) | in-progress | 02 | E/C |
| [05 维护者提交页面快照并查看最终差异](issues/05-snapshot-review.md) | in-progress | 03, 04 | D |
| [06 发布首个检索式知识版本并供成员浏览](issues/06-publish-first-procedure.md) | in-progress | 01, 05 | B/E |
| [07 网页自由文本问答与版本化引用](issues/07-web-grounded-answer.md) | in-progress | 06 | B |
| [08 知识不足、来源冲突与必要澄清](issues/08-exclusive-guidance-paths.md) | in-progress | 07 | B |
| [09 使用当前可用历史理解自由文本追问](issues/09-guidance-context.md) | in-progress | 08 | B/E |
| [10 切换回答视角与深度并管理偏好](issues/10-response-preferences.md) | in-progress | 07 | B/C/E |
| [11 网页回答在重试、断线和崩溃后保持可查](issues/11-durable-web-answer.md) | in-progress | 07 | B/E |
| [12 企微单聊接入同一问答与交付服务](issues/12-wecom-single-chat.md) | in-progress | 10, 11 | C |
| [13 成员登记独立问题并跟踪处理](issues/13-standalone-question-ticket.md) | in-progress | 04 | C |
| [14 跨端登记、反馈并关联最小工单证据](issues/14-answer-feedback.md) | in-progress | 12, 13 | C |
| [15 管理员通过 bot 发起并跟踪知识修订](issues/15-bot-maintenance-draft.md) | in-progress | 14 | C/D |
| [16 更正写回来源并经复核发布生效](issues/16-source-correction-release.md) | blocked | 15 | D |
| [17 并发发布、紧急撤回与安全回滚](issues/17-publication-revoke-rollback.md) | in-progress | 12 | E |
| [18 模型变更暂停服务并标记历史答案](issues/18-model-change-gates.md) | in-progress | 17 | E/B |
| [19 部署后从可信状态恢复服务](issues/19-trusted-recovery-operations.md) | in-progress | 16, 18 | E |
| [20 三类广告流程通过真实知识评估](issues/20-three-advertising-flows.md) | blocked | 09, 16 | B/F |
| [21 完成受控试点验收并给出上线结论](issues/21-controlled-pilot-acceptance.md) | blocked | 19, 20 | F |
| [22 向获准群受众回答并安全引用历史](issues/22-authorized-group-chat.md) | blocked | 18 | C |
| [23 完整来源格式、改名与静态附件往返](issues/23-wiki-formats-attachments.md) | blocked | 16 | D |
| [24 工单合并、内部备注和附件保持隔离](issues/24-advanced-ticket-visibility.md) | in-progress | 14 | C |
| [25 通过配置接入第二个非广告领域](issues/25-second-domain-configuration.md) | blocked | 08, 16 | F |
| [26 完成完整范围联合验收](issues/26-full-scope-acceptance.md) | blocked | 21, 22, 23, 24, 25 | F |

## 验收责任映射

保留全部30个ID；Q系列及W-02已按检索式方案改写，不恢复互斥路径或字段语义引擎。

| ID | 当前场景 | 责任任务 | 复验任务 |
|---|---|---|---|
| Q-01 | 引用合法但缺关键事实/必要步骤 | 07 | 20, 21, 26 |
| Q-02 | 证据不足时伪装澄清输出操作建议 | 08 | 20, 21, 26 |
| Q-03 | 装配时知识/模板切换 | 07 | 21, 26 |
| Q-04 | 检索页面结论冲突 | 08 | 20, 21, 26 |
| Q-05 | 无命中与有命中但证据不足 | 08 | 20, 21, 26 |
| Q-06 | 自由文本对象切换/不明 | 09 | 20, 21, 26 |
| Q-07 | 承诺范围内检索或回答失败不得改分母 | 08 | 20, 21, 26 |
| Q-08 | 历史快照后撤回/换模或发布更新 | 09 | 20, 21, 26 |
| Q-09 | 未交付/unknown历史与旧回复恢复已纠正事实 | 09 | 20, 21, 26 |
| P-01 | 同 epoch 候选竞争 | 17 | 21, 26 |
| P-02 | 候选检查与撤回竞争 | 17 | 21, 26 |
| P-03 | 撤回后的空指针修复 | 17 | 21, 26 |
| R-01 | 入站接收事务崩溃重放 | 11 | 12, 21, 26 |
| R-02 | 旧 worker 迟到结果 | 11 | 18, 21, 26 |
| R-03 | 模型已调用但结果未保存 | 11 | 21, 26 |
| R-04 | 通知发送后丢失回执 | 12 | 14, 21, 24, 26 |
| R-05 | 恢复到撤回/撤权之前 | 19 | 21, 26 |
| R-06 | 旧 pending 的执行未知 | 19 | 21, 26 |
| M-01 | 已知模型变化的新调用/激活 | 18 | 21, 26 |
| M-02 | 历史已交付/未交付范围 | 18 | 19, 21, 22, 26 |
| M-03 | 变更后进行中/迟到结果 | 18 | 21, 26 |
| M-04 | 新回归不清除历史警示 | 18 | 19, 21, 26 |
| A-01 | 伪造角色/工具/旧按钮 | 04 | 10, 15, 21, 26 |
| A-02 | 跨域或他人私人对话 | 04 | 14, 15, 21, 22, 25, 26 |
| A-03 | 提交之后管理员撤权 | 16 | 17, 21, 26 |
| A-04 | 合并/附件/内部备注隔离 | 24 | 26 |
| C-01 | 撤回时排队正文/网页重连 | 17 | 18, 21, 22, 26 |
| C-02 | 多块/迟到回执/最终超限 | 12 | 21, 22, 26 |
| W-01 | 来源冲突/部分写入/再导入 | 16 | 20, 21, 23, 26 |
| W-02 | 页面、金样例与发布配置同步复核 | 16 | 20, 21, 23, 26 |

## 验收边界

试点21包括三广告主题批准范围、网页/真实企微单聊、风格与角色、工单反馈、bot维护、受控来源更正、发布/撤回/回滚、换模与可信恢复。26另含受控群聊、完整来源/附件、高级工单、真实第二领域及交叉组合。未启用项明确未验，不标通过。

默认15秒答案期限不是新SLO。原≥95%普通请求同时满足有用首段≤3秒、完整交付≤10秒和成功不变；至少1000真实普通请求及30–50条专家真题仍须按原口径取得证据。运行complete不是质量通过，ACK不是人已阅读。

本地Markdown追踪，不发GitHub Issue/PR、不推送。A–E不暂存提交，F最终统一检查提交；真实Wiki源默认只读，凭据/真实bundle/私人对话不入库。
