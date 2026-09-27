# B 问答质量交接

2026-09-27；基线 `75c6dc026fe8c2f91e5ff329cc2fce6615f5b48b`。读取协调文件、CONTEXT、ADR-0004、各负责 spec 和 Pi/检索/企微历史证据后，基于已有未提交改动增量实施。未切分支、暂存、提交或推送；未修改真实 Wiki；未连接企微。旧结构流程、/条件、/继续 未恢复。

## 实施结果

1. **执行与质量分离**：Evaluation.state 只描述 running/complete/failed；新增 verdict=pass/fail、failures、humanReview=required。`complete` 不再等同通过。发布只认可同 release/descriptor/modelEpoch/case 的最新 attempt 已 complete 且 pass；失败/进行中复跑不能借用旧成功结果。旧 complete 无 verdict 也不能放行。
2. **机器判定的明确范围**：cases.expectedOutcome=answer|knowledge_gap|clarification，缺省 answer；答案题要求非空 expectedCitations 且全部包含于实际引用。检索零命中、模型主动缺口和澄清按预期类型比较。错误引用、协议失败、错误模型与不完整终态属于执行失败，不产生质量通过。机器检查不证明引文支持每项事实、步骤完整或业务正确，人工发布复核仍独立必需，未伪造专家批准。
3. **协议与流式**：删除自动首篇引用兜底，严格解析完整 JSON（兼容整段 Markdown 围栏），失败为 MODEL_PROTOCOL_INVALID。模型仍可流式接收，答案服务仅在模型标识、完整终态、协议、引用及取消信号全部校验后持久化一个不可变正文块，再交付。不再逐字覆写 sequence=1，因此旧 ACK 不会被误算成后续追加全文的交付。累计 exposedThrough/deliveredThrough 事实保留；等待提示不计有效首段。
4. **无答案与追问**：模型可返回可选 outcome，缺省 answer；knowledge_gap/clarification 可无引用，分别成为 KNOWLEDGE_COVERAGE_GAP/CLARIFICATION_REQUIRED 状态块。不会为了完整外观编造引用。模型语义判断本身仍需业务评估，非程序证明。
5. **历史可见范围**：调用模型时重新选取同 owner/session/release、当前可访问、模型 epoch 有效、complete、clear、未取消、已确认交付的 ANSWER 或 CLARIFICATION_REQUIRED。只取 deliveredThrough 范围内内容，最多三轮、每轮答案 600 字；未知回执和仅 exposed 不算已交付。知识正常换版也保守清空旧版本上下文。旧持久化 history 字段不返回客户端、不复用；不把历史答案升级为依据。澄清回复“前者”等可通过已交付澄清恢复原问题检索。
6. **实际上下文预算**：RetrievedPage.content 是预算内片段，page 保留完整不可变来源。检索与提示共用 contextPage 投影，预算包含 JSON 页面数组、字段、UTF-8 与转义开销；默认 60,000 bytes。按 Unicode 码点截断，不割裂代理对；完整 prompt 保留 120,000 bytes 最终门禁。
7. **标签与偏好**：消费 E 的 defaultStyle(access(...))，本次 style > 显式 preference > tags 默认；双标签 technical。删除偏好保留版本化 cleared 记录，之后动态回退当前标签默认，避免删除后固定 business。表达标签不授予权限。
8. **领域模板**：config.domainLabel 可选；answerTemplates 可选，定义时须包含 business/technical/beginner/experienced 四项，随发布描述绑定。cases 可选 style/depth，默认 business/beginner，实际传入模型。自定义模板发布要求四组合各至少一个 answer 类型金样例，并且全部题最新运行通过；缺覆盖报 TEMPLATE_EVALUATION_COVERAGE_REQUIRED。模板的事实一致性仍需人工复核。
9. **评估恢复**：每次运行绑定 deadline、lease、version 和 attempt。独立超时即使模型忽略取消也使请求 failed/EVALUATION_TIMEOUT；周期恢复将过期或旧无 deadline 的 running 标 EXECUTION_UNKNOWN，禁止自动重跑。导出 recoverEvaluations(store, force=false)，force=true 供独立恢复边界使用。最终回写核对 running/version/lease，恢复后的迟到结果不会复活为通过；最终权限丢失会留下失败记录再拒绝响应。
10. **D/F 接口整合**：Bundle 支持可选 sourceArtifacts，并校验哈希、类型结构、唯一性及包内链接。staticSourceTypes 在此仅作格式检查；领域附件批准由 D/E 的 validateSourceSubmission 按 SourceWorkspace.approvedAttachmentTypes 默认拒绝执行，不能把结构检查当批准。未添加重复的 config 附件白名单。

## 验证与证据分类

### 合成测试

按 implement/tdd 的公开接口边界实施。先观察失败再修复的反例包括：缺知识仍过发布门禁、裸 Markdown 被自动加引用、未验证流可读、未 ACK 历史被复用、预算超限、偏好删除未回退标签、失败复跑沿用旧成功。新增回归覆盖恢复迟到结果、忽略取消的模型、四组合模板门禁、澄清评估和多轮回复、换版隔离、非法引用/换模/截断/取消不可回调正文。没有把内部模型替身当真实业务验收。

最终共享工作区快照：

- `npm run typecheck`：通过。
- `npm test`：92 tests，92 pass，0 fail，约 7.35 秒；包含所有并行任务当时已落地代码。
- `git diff --check`：通过。
- 定向运行过 answers/context/evaluations/procedures/retrieval/text-stream；全套结果包括模型传输、撤回、恢复、交付等已有回归。
- 中途 D 文件尚未完成时曾有 controlled-source 缺文件及 snapshot 隐式类型错误；最终已消失，未绕过类型检查。

### 本轮真实模型实验

现有 `.env` 受控凭据由运行时读取，不打印或写入证据。命令 `npx tsx --env-file=.env tools/answer-quality-probe.ts`；只发送一页明确标为合成测试的三步指南，没有发送真实 Wiki 或用户对话。

2026-09-27T03:34:38.589Z：glm-5.3，complete，stopReason=end_turn；输入 337 token、输出 73 token；首字 1521 ms、整答 2364 ms（外层 2368 ms）；引用仅 synthetic，预期三动作词均出现。模型标识/完整终态/严格协议/引用白名单通过。该单次结果不是专家质量通过，也不是 95%/1000 请求 SLO，不能证明真实领域泛化能力。工具只输出受限指标与错误类别，不打印上游原始错误或凭据。

### 可审核题集

[36 题机器草稿](answer-quality/questions-draft.json)：新渠道接入、腾讯广告新增代理商、腾讯 RTA 新增策略各 12 题；覆盖完整问题、缺材料、范围外、无答案、历史版本、禁止结论、对象切换、多轮、视角及更正回归。格式含候选来源路径、预期结果/引用/事实、禁止结论、reviewer/evidence、release/descriptor/modelEpoch/runId/verdict；未确认字段保持空值，不填伪造答案。该格式是审核工作表，不能直接作为发布 cases。

只读核对真实 Wiki 时，相关页前置元数据显示 draft、verified_at=null，并声明迁移原文不代表当前部署；腾讯新增代理商完整流程未在已读资料中确认。题目仅机器拟定，不是 36 条真实用户问题，不是专家金样例。没有复制源正文、账户或凭据进入题集。

## 双轴审查

按 code-review 以固定点及当前未提交差异进行两位独立代理只读审查（共享目录安排优先，不为审查暂存或提交）。

**Standards**：初审 0 硬违规、2 判断性建议：onPartial 名称与最终交付行为不符；预算/发送页面投影重复。已改 onValidatedAnswer 并共用 contextPage。限定复查 0 遗留。

**Spec**：初审 3 个 P2：删除偏好未回退标签、遗漏已交付澄清历史、缺少 clarification 预期；已修复并加回归。复查另发现自定义模板评估仅业务入门，已增加显式组合及四组合发布覆盖门禁，实际网关捕获四种视角/深度证明参数进入调用。最终限定复查 0 遗留。人工事实复核仍开放。

## 文件与交接

本轮实际编辑：src/answers.ts、src/explanation.ts、src/retrieval.ts、src/evaluations.ts、src/procedures.ts；test/answers.test.ts、test/context.test.ts、test/evaluations.test.ts、test/procedures.test.ts、test/retrieval.test.ts、test/text-stream.test.ts；tools/answer-quality-probe.ts；本报告和 answer-quality/questions-draft.json。src/adapters/model.ts、src/demo-model.ts 的已有未提交变更已检查并保留，非本轮新增修改。未编辑总 spec、总证据或共享 package/server/helpers。

F/E：恢复服务需要在独立恢复边界调用 recoverEvaluations(store,true)；普通启动仅清过期执行，未过期执行保留到原 deadline。保留最新 attempt 和失败记录。第二领域自定义模板应配四组合 cases；已有通过 helper 仅检查 complete 的地方建议同时检查 verdict（真正发布门禁已强制）。D/E 领域附件白名单校验须在公共提交路径实际执行；B 的格式校验不替代该授权。C：逐字正文暂缓交付是契约修正，不以等待提示冒充有效首段；clarification 状态仍是自由文本对话，不恢复旧 /条件 指令。

## 精确未验收项（A/F 不应直接关闭整票）

- 01：供应方服务类型、额度/取消保证、部署固定性、长流/中断真实样本；本轮单次合成模型实验仅补契约证据。
- 06–09：负责人批准当前真实知识、逐题事实/引文支持与流程完整性、多轮对象切换语义、真实用户端到端；机器引用检查不证明这些质量。
- 10：定制模板四组合程序门禁已落地；业务事实一致性和负责人模板批准未取得。
- 11、17–18：本地输出/历史/恢复竞争回归通过；跨系统真实撤回传播、客户端展示、在途消息及公司独立身份事实仍由对应任务验收。
- 20：36 题草稿已有，但来源当前适用性、真实用户问题收集、三领域范围、预期答案及专家签字缺失。腾讯新增代理商完整知识尚待负责人指出/批准；不自行填规则。
- 全局：3 秒有效首段/10 秒整答 SLO 与当前 15 秒运行 deadline 的差异仍存在；无 1000 请求真实负载或试点业务观察。本轮没有宣称上线验收通过。
