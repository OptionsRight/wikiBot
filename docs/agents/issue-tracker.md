# 本地任务追踪

用户已选择本地 Markdown，不使用外部 issue tracker。实施规格为 `.scratch/wikibot-v0.4/spec.md`，一项任务一个文件，位于 `.scratch/wikibot-v0.4/issues/`；依赖及验收映射见同目录 `plan.json`。

任务状态采用 ready-for-agent、in-progress、blocked、done。ready-for-agent 仍受依赖与外部前提约束；实现或模拟测试不等于真实环境验收通过。任务关闭须链接实际证据，外部条件未满足时记录原因。

实施审查固定点为本次实施前保存的规划基线提交；来源是当前规格、领域术语及 accepted ADR。当前任务包括用户授权提交实现，不包含向 GitHub 发布。
