# D 知识维护（进行中）

固定基线 `75c6dc026fe8c2f91e5ff329cc2fce6615f5b48b`；基于工作区既有 ADR-0004 实现增量修改；未暂存、未提交。

## 给 F 的接口预告

- `registerRevisions` 内注册新增 `registerSourceMaintenance(app, store)`；无需新增 AppOptions 或 app.ts 注册。
- 管理员 `PUT /api/domains/:domain/source-workspace` body `{expectedVersion,root,helperSubject,enabled,adapter:{kind:"manual"|"isolated-markdown",version}}`。root 为管理员配置的绝对目录，API 仅保存绑定，不执行文件读取。每领域唯一工作区；重配使旧租约失效，有已开始/未知写入时先人工核对恢复。GET 同路径仅管理员可见。
- 管理员 `POST .../source-workspace/window` body `{expectedVersion,durationSeconds:0..3600,evidence}`，记录暂停所有编辑与摄入的人工维护窗口。自身锁不冒充全系统锁。
- helper 为独立认证 subject，不授予任何 member/admin grant；需部署使用当前认证机制给独立 subject 发凭据。POST `.../revisions/:id/claim {expectedVersion,workspaceVersion}`、`start {leaseId}`、`lease {leaseId}`、`source-result {leaseId,state:"applied"|"conflict"|"recovery_required",journalHash,evidence}`。所有写动作带 idempotency-key。
- **请 F 在 E 完成 publication.ts 后集成**：现有 `submissions` 的 authorize 回调允许管理员原路径，独立 helper 路径调用 `authorizeSourceUpload(store,actor,domain,bundle)`（`src/source-maintenance.ts` 导出）；保持现有提交事务/validateBundle，不另建候选服务。helper 授权同时验证现在线上基线、绑定版本、窗口、租约与已应用修订内容，不得授予 review/evaluate/activate 权限。helper 的未知写入结果允许仅回报 recovery_required；撤权后不能上传。
- 管理员 `reconcile` 需要人工逐文件核对日志/真实哈希，body `{expectedVersion,outcome:"baseline_restored"|"applied",journalHash,evidence}`。baseline_restored 允许重新领取；applied 允许重新快照。不会自动重放未知写入。
- 现有 `/revisions/:id/snapshot` 仍管理员执行，校验 candidate 来源基线及变更哈希；实际激活才显示 released。

## 原入口检查

真实目录只读检查发现 `wiki/CLAUDE.md` 与 `.claude/skills/advert-knowledge/SKILL.md`，明确支持手工 JSON frontmatter Markdown 编辑、稳定 id、redirect 与 lint/query。CLAUDE 明确写明旧 wiki-init/ingest/query 未随快照提供，不能声称执行。本地已有广告维护说明不等于原 llm-wiki 技能固定版本。原技能往返验收继续未完成。

## 实现完成与安全边界

本报告后续段落取代文首“进行中”。原 spec 文案中的 ProcedureSpec 依 ADR-0004 不恢复。

- 每领域唯一可配置来源根目录、固定适配器 kind/version、独立 helper subject、管理员指定静态附件类型（`approvedAttachmentTypes` 默认空）；配置只给管理员和配对助手读取，不接受成员任意路径读取。目录改变失效旧绑定；正在写入/结果未知先恢复。
- 管理员显式开启最多一小时人工维护窗口；每次领取/开始/续租/上传检查当前配对管理员和窗口管理员资格、根绑定版本、领域 epoch、线上基线、租约。helper 不授予成员/管理员角色。领域恢复后 epoch 变化使旧租约失效。
- 控制台/网页已有修订 API 保留；修订编辑时检查最初基线，快照关联检查本修订基线和更正哈希。只在候选实际 active 时显示 released，额外返回 candidateState。超时 writing 在查询中显示 recovery_required。
- 新增受控助手命令行，以独立环境令牌连接当前服务；只能上传该修订变化（页面全集、未改页面哈希、原配置/题集/附件必须保留）。候选提交复用 publication，按修订和最终包哈希使用固定幂等键；不能评估、复核或激活。需要调整金样例/附件时由管理员提交最终包再复核。
- 写入前保存独立 0700 记录目录中的 0600 更正记录与追加 `.events` 历史，含原文、替代文、依据、范围、负责人、适配器版本、每步状态与哈希；该目录不得在来源内部或来源祖先目录。本轮无自动清理更正记录。
- 全部页面预检查与整个可见目录清单前后对照；原始 `source-docs` 禁止更正覆盖。部分写入、权限撤销或未知结果停止后续动作；不重放。独立锁只防本助手并发，不能替代人工暂停其他编辑/摄入；不声称文件系统原子多文件事务或跨系统撤权回滚。
- 本地 reconcile 同样获取助手锁。进程被强制杀死留下锁时，维护者须先停止旧进程与所有外部写者、核对每个文件和事件记录，再人工移除空 `.source-lock` 目录；不能仅因租约过期删除锁并重写。`baseline_restored` 逐文件符合原哈希后才批准一次新尝试；`applied` 全部符合目标哈希后才准重快照。
- 更正独立保留，重新导入后在快照前后验证；保留原生 JSON frontmatter ID；无原生 ID 时复用既有清单、唯一内容哈希或显式改名映射。更正后改名使用修订后的内容哈希恢复旧平台 ID；旧更正记录的原路径与原文仍保留。

## 来源格式/附件矩阵

| 项目 | 实现及验证范围 |
|---|---|
| UTF-8 Markdown、JSON frontmatter | 原生稳定 ID；未知/YAML frontmatter 拒绝，不声称通用 YAML 支持 |
| 无 frontmatter Markdown | 前次清单稳定 ID；改名通过唯一内容哈希或显式 oldPath→newPath 映射，歧义拒绝 |
| 内联 Markdown 链接、Wiki 链接 | 包内相对路径正规化，缺页/缺附件/穿越/外链拒绝；简单 Markdown 标题锚点存在性检查 |
| 引用式 Markdown 链接、HTML href/src | 明确拒绝 `UNSUPPORTED_SOURCE_LINK_FORMAT`，后续政策确认后再实现 |
| 来源摘录 | `.txt` / `.md` UTF-8，text/plain；单份 200KB，独立 ID/hash |
| 静态附件 | PNG/JPEG 仅在领域管理员白名单中接入，扩展名/文件签名/base64/哈希一致，单份 1MB；默认白名单空 |
| 总限制 | 最多 100 来源对象，解码后总 2MB，最终整个包 4MB |
| SVG/HTML/脚本/PDF/Office/其他格式 | 不接入；类型、大小和展示政策仍待确认，不按“完整格式”任意扩大 |

附件与摘录保存于不可变知识包，纳入最终 descriptorHash。下载从包读取，不读服务器任意目录；检查当前领域资格、指定版本/对象和撤回状态，使用 attachment 下载与 nosniff。工单附件是 C 的独立模块，未混用。

## 适配器与人工交接命令

示例配置仅包含受权运维配置，不含凭据：`{"server":"http://127.0.0.1:PORT","domain":"DOMAIN","root":"/ABS/WIKI/KNOWLEDGE","records":"/ABS/INDEPENDENT-RECORDS"}`。

1. 管理员配对 workspace（`manual/contract-1` 或 `isolated-markdown/1`）并开启人工窗口；平台/SSO 为独立 helper subject 提供认证凭据，不赋领域 grant。
2. `WIKIBOT_SOURCE_TOKEN` 通过受控环境注入，运行 `npx tsx tools/source-helper.ts CONFIG.json REVISION_ID apply`。隔离适配器只允许根目录存在 `.wikibot-isolated-copy` 且内容为 `isolated experiment` 的副本。真实维护根默认选 manual：先保留计划/原文/拟改及更正记录，输出 recovery_required，维护者按实际已核对的广告维护说明手动完成；不假装调用原技能。
3. 维护者核对来源与记录、确认旧执行者停止；用管理员环境 `WIKIBOT_MAINTAINER_TOKEN` 运行 `npx tsx tools/source-reconcile.ts CONFIG.json REVISION_ID applied EVIDENCE.txt`，或原文完整恢复时 `baseline_restored`。本地逐文件哈希及服务器版本/权限均检查。EVIDENCE 至少 30 字；不写入凭据。
4. helper 运行 `npx tsx tools/source-helper.ts CONFIG.json REVISION_ID snapshot`，验证独立更正、构造一致清单、重复上传返回相同未激活候选。现有管理员 `/revisions/:id/snapshot` 关联候选，再运行原问题/相邻金样例、复核最终包并激活。工单仍须按 C 的状态与报告人确认流程处理，发布不自动关闭。
5. 手工清单工具可用 `npx tsx tools/manifest.ts ROOT SUBDIR OUT [PREVIOUS_MANIFEST] [RENAMES_JSON]`；保留既有 cases/config/sourceArtifacts，输出不覆盖现有文件。快照命令可增加独立策略 JSON `{approvedAttachmentTypes,correctionStore}`；正式维护应使用来源助手，避免漏掉更正检查。

## 实际验证与证据分类

### 确定性合成测试

已跑 `npx tsx --test test/revisions.test.ts test/snapshot.test.ts test/source-maintenance.test.ts test/controlled-source.test.ts test/source-formats.test.ts test/source-helper.test.ts`。覆盖管理员/成员/助手边界、撤权、维护窗口、未知结果不得重领、旧租约失效、原基线冲突、部分写入、显式恢复、独立目录、更正重导入丢失、原生及非原生稳定 ID 改名、附件包转换/哈希/链接/下载授权与撤回、来源→候选→评估→复核→激活。

`test/source-helper.test.ts` 使用真正 CLI 子进程和临时本地 HTTP 端口（非共享服务器），完整执行配对/领取/写回；实际将无 frontmatter 的更正页改名再重快照；重复上传取得同 candidate；线上旧版本不变，helper 无发布权。这是合成契约实验，不是企微或业务验收。

`npm run typecheck` 通过。全套 `npm test` 在本轮共享工作区曾为 **98/98 通过，约 9.2 秒**；之后新增链接格式回归及改名 CLI 覆盖，定向测试和类型检查继续通过；最终全量以 F 交接后的结果为准。初始类型错误来自其他并行任务未完成文件，后来已消失。`git diff --check` 通过。

### 真实目录的隔离副本实验（不写真实源）

运行 `npx tsx tools/source-roundtrip-probe.ts /Users/rubychen/Desktop/credit-market-advert/wiki`：读取真实 knowledge 目录 161 页，161 唯一原生 ID；复制到系统临时目录，只在副本给一页添加明确标注的合成实验文字。通过受控适配器写入、改名保持 ID、独立更正核验；模拟旧导入覆盖时拒绝，再恢复更正通过。没有把测试标记冒充业务专家更正。

- 原源清单前后同哈希：`aae7ac57b6d0c356bd30ee6acdd966c55b1b3ae6692e3996632cd29b1144f549`。
- 改动页身份哈希：`eb2807e51b0c7875b2f0300d229bf749208258023c730d952dbafee7d5959408`。
- 原文哈希：`42c385202753f2dbacad2ca6c85d7da8ca272324c5622e26ff35ae60be8ecc42`；副本实验文哈希：`bd229aeb9e9cabf4c0c2f26871e8044019c8f830026fb3c2bf68f8b53e081794`。
- 临时副本和真实正文更正记录由 finally 清理，报告仅保留计数和哈希。真实 Wiki 未写入；无原始业务正文、凭据或账号映射加入本证据。

该实验验证本地适配/稳定身份/独立更正保留，不包含真实 161 页完整来源链接包的重新发布，也没有调用原 wiki-init/ingest skill。新严格链接门禁会要求真实 Wiki 显式打包链接依赖或完成格式适配；旧首跑 161 页成功不能替代任务 23 验收。

## 双轴审查

固定点及未提交差异如文首，按 code-review 两个独立子代理审查，未暂存提交。

**Standards：** 初审 2 项：目录分离判断错误地接受 `..records` 子目录；包→清单转换分散导致附件重快照失败。已以严格父目录判断和共享 bundleManifest 修复并补回归，复查 0 遗留。追加本地 reconcile 获取相同锁，仍需人工停止未知旧执行者。

**Spec：** 初审 3 项：附件正文误入严格清单、省略附件字段绕过断链、更正后改名仍读旧路径。全部修复；限定复查再指出旧平台 ID 的 CLI 更正后改名映射，已合入本次修订后的哈希并以真实 CLI 子进程测试通过。最终附件参与 validateBundle，不能因省略字段绕过链接检查。

## 精确缺口与后续工作

**外部验收未完成：** 原 llm-wiki 固定版本/可执行入口未提供；公司附件类型/大小最终政策；真实维护者暂停编辑与摄入、业务专家更正结论、原问题/相邻问题正式金样例复核；真实企微维护闭环由 C 负责。可配置管理员/根目录已实现，不再把“未指定某个人”作为开发阻断。

**仍需开发/集成，不能算外部验收：** 现有广告 Wiki 的复杂链接/来源映射与完整依赖包整理，以及未来若批准的引用式链接/HTML 链接/其他附件格式适配；真实目录页面迁移的 redirect、入链批量更新不由助手自动执行（当前必须维护者完成并通过最终断链检查）；原技能一旦可用，需要实现并固定该技能适配器版本，而非继续使用隔离适配器。简单标题锚点支持不等于任意 Markdown 扩展/重复标题锚点完整兼容。管理网页对 workspace/window/reconcile 的专用表单不在 D 文件范围，目前 API/CLI 可执行，后续由 C/F 决定界面接线。

**F 接线状态：** helper submission authorization、validateSourceSubmission、bundle sourceArtifacts schema 与无条件 validateSourceLinks 已在共享文件接入；D 无需 AppOptions 新注册。请最终全量测试并检查网页维护配置/状态展示是否要在本轮接线；不要把 API 已有当作专用界面已有。

## D 文件清单

已有文件：src/revisions.ts、src/snapshot.ts、tools/manifest.ts、tools/snapshot.ts、test/revisions.test.ts、test/snapshot.test.ts。
新增：src/source-maintenance.ts、src/source-files.ts、src/controlled-source.ts、src/source-formats.ts、src/source-artifacts.ts、src/source-artifact-routes.ts；tools/source-helper.ts、tools/source-reconcile.ts、tools/source-roundtrip-probe.ts；test/source-maintenance.test.ts、test/controlled-source.test.ts、test/source-formats.test.ts、test/source-helper.test.ts；本证据。

仅写上述 D 范围，没有暂存/提交、推送、GitHub Issue/PR、共享服务重启或真实源写入。

最终 D 定向回归：**16/16 通过**，类型检查和差异空白检查通过。Spec 最后一轮限定复查确认三项全部修复、0 剩余发现；Standards 复查同为 0 遗留。D 已完成交接并停止修改，最后全量及统一提交由 F 执行。
