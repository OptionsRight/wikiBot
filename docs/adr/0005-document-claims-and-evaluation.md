# ADR-0005：从现有检索式 wikiBot 增量引入文档、Claim 与评测能力

日期：2026-10-07\
状态：选型已按用户要求确定；下列接口与迁移设计待实现、验证。\
基线：`cbc47424012f6841e07ca26131e70092b230c783`。\
完整设计：[v0.5](../handoff/domain-knowledge-bot-design-v0.5.md)。

## 背景

当前仓库已具备 Fastify/Preact、SQLite、Pi 模型传输、检索页面后单次生成、发布评测/复核、角色工单和企微交付。原始办公文档解析、结构化事实治理、版本化 Code Wiki 尚未形成完整能力；现有自动评测主要核对回答类别和预期引用。

本版从这些实现继续演进。ADR-0004 的检索优先、ADR-0002 的可信恢复和 ADR-0003 的模型变更门禁继续有效。

## 决策

1. Docling 作为后台 Python normalizer 的运行依赖，输出标准化文档及来源定位；在线 Node 问答不等待解析。
2. 在 TS/SQLite 自研轻量 Claim Layer，包含 ClaimVersion、Evidence、双时间和 Conflict；保留既有领域/对象授权，不依赖外部记忆服务的 namespace。
3. 借鉴 OpenWiki 的 sidecar、证据 resolver 和增量检查；Code Wiki 使用只读 commit/blob 来源，并经过同一候选发布流程。
4. DeepEval 作为隔离 Python eval 环境的 dev/test 依赖；报告绑定候选、模型、题集和策略，发布服务消费可信结果，最终复核仍由管理员执行。
5. TS 保持数据库单写者；Python 子进程只读任务资产、写临时产物，回传受限结果。sidecar 是受控投影，不能与数据库形成两个可独立修改的权威。
6. Bundle V2 显式版本化，新描述绑定来源/Claim/sidecar/评测。V1 原包原哈希保持可读，先兼容读取再迁移构建。
7. 现有页面逐步补 Claim。混合模式明确区分页面引用与事实举证；不恢复人工 ProcedureSpec，不将整页伪装成一条原子 Claim。
8. 协议降级不得自动把第一命中页认作答案证据；正式流式块须完成本块协议和引用范围检查，原始预览单独统计。

## 后果

新增 Python 环境、解析模型工件、后台作业、Claim 专用表和质量评测预算。可以复用现有应用、授权、事务、工单、来源维护与渠道逻辑。Docling 的格式支持和 DeepEval 的评分均需要真实样本验证，不能当作文档无损或事实正确性的证明。

实现按 M0–M5 分阶段推进，先关键页面，后完整增量和 Code Wiki。现有实现/历史验收记录不自动升级为新能力通过；早期从零成本估算不再代表本轮剩余工作量。

## 参考

- [现有检索决策](0004-retrieval-first-answers.md)
- [Docling 格式](https://docling-project.github.io/docling/usage/supported_formats/)
- [HL-Mem 架构](https://github.com/lohr13/hl_mem/blob/main/docs/architecture.md)
- [OpenWiki Claims](https://github.com/langchain-ai/openwiki/blob/main/openwiki/concepts/grounded-claims.md)
- [DeepEval](https://deepeval.com/docs/introduction)
