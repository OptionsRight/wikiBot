# 检索式问答改造与真实 Wiki 首跑

2026-09-26；用户决策：容忍回答偶发不准，质量由反馈闭环管理（见 [ADR-0004](../../../docs/adr/0004-retrieval-first-answers.md)）。本页记录结构路径移除、检索式回答链路落地及真实 Wiki（credit-market-advert，161 页）首次发布与真实模型问答。

## 变更概要

- bundle 收缩为 `pages + 金样例 cases + config`；procedures/branches/guidance 及分支穷举校验删除（git 历史保留）。
- 新增 `src/retrieval.ts`：CJK 二元组 + 拉丁词的词法评分（标题 3 倍加权、IDF、长度归一），top-K=6、约 60KB 上下文预算；纯函数、毫秒级，答案与评估共用。
- 回答链路：检索 → 单次模型调用（纯 JSON `{text, citations}`，maxTokens 2000，markdown 围栏容错）→ 引用白名单校验；无命中返回 `KNOWLEDGE_COVERAGE_GAP` 状态块，不调用模型。企微与网页一律自由文本提问；`对象/流程/条件` 语法与 `/条件`、`/继续` 移除。
- 发布门禁改为金样例问答评估（机制复用：幂等运行、modelEpoch 绑定、复核前必须完成）；`/knowledge` 只返回页面；bundleHash 只含 pages。
- 答案期限 10s → 15s（`ANSWER_DEADLINE_MS`，对设计 7.1 SLO 的已记录偏差）。
- 新增 `tools/manifest.ts`：从 wiki 目录一条命令生成清单草稿（slug+路径哈希防中文目录碰撞）。

## 验证

- `npm run typecheck`、`npm run build` 通过；`npm test` 30 通过、0 失败（移除 context 继承测试，重写 answers/wecom/procedures/snapshot/channel-controls/channel-timeout/notifications/model-change/late-ack/durability 中依赖流程语法的断言；超时测试改用 5 秒真实期限）。
- 合成演示服务器 API 冒烟：常规问题 `complete/ANSWER`（引用 guide）、范围外问题 `KNOWLEDGE_COVERAGE_GAP`。

## 真实 Wiki 首跑（用户令牌授权，真实正文首次进入公司模型）

1. `npm run manifest -- …/wiki knowledge` 生成 161 页清单（ID 全唯一）；手工补 3 个金样例（开户归因/归因配置变更/媒体曝光接入）。
2. 快照通过：161 页、923KB（限 500 页/4MB 内），哈希与二次读取校验通过。
3. 本地真实服务器（glm-5.3）：三个金样例评估全部 `complete`，检索首位均命中目标页面（如「开户归因流程」问题首位命中 `workflows-open-account-attribution-overview`，另返回 5 页相关上下文）；首次运行中一个用例因模型输出包裹 markdown 围栏解析失败（`EVALUATION_FAILED`），为解析契约加固围栏容错后复跑通过。
4. 复核、激活成功；两个真实问题经成员身份提问均 `complete/ANSWER`：
   - 「开户事件归因的处理流程有哪些步骤？」→ 引用开户归因与 tc-rcs 页面，回答含 S27441 接收、事件流水、RTA 状态转换、点击强归因等与源页面一致的步骤。
   - 「新媒体平台曝光上报怎么接入？」→ 引用媒体曝光接入与 CAP 网关页面，回答含数据链路（媒体→CAP→RMB→alms→mes）与五阶段接入。
   实测整答 5.5–10.6 秒（评估与直连样本），15 秒期限内完成但接近；SLO 未验证达标。
5. 脚本与产物在 `.scratch/real-wiki/`（manifest/bundle/publish.mjs），本地库 `.local/real.sqlite` 不入库。

## 未验证与边界

金样例仅 3 条且由实施者拟定，未经业务负责人核对；回答正确性为抽样目检，非业务验收。企微端自由文本问答、真实用户反馈闭环、检索质量系统评估（recall/precision）、并发与容量、`KNOWLEDGE_COVERAGE_GAP` 误判率均未验证。多跳受限工具读取（pi-agent-core）与嵌入检索留作后续。历史通知/单聊证据中的流程语法描述以当时版本为准。
