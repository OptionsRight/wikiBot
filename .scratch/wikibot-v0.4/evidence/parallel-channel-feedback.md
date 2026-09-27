# C：渠道与工单实施（进行中）

2026-09-27。基线 75c6dc026fe8c2f91e5ff329cc2fce6615f5b48b。保留本轮开始时所有已有未提交内容，不暂存、不提交；本报告会在验证后更新。

## F 集成接口（先行交接）

- `WecomOptions` 仍是一 bot/一 domain 对象；`AppOptions.wecom` 仍单对象。不要直接重复 `registerChannel`（会重复注册 channel-receipts HTTP 路由）。第二领域目前可部署独立进程/端口/数据库与独立 bot；单进程多 bot 需 F 提取一次性 receipts 路由，并支持数组注册各 bot，botId 不得重复。当前 C 不改共享 app/server。
- 新增 `notificationRecipients?: Record<subject, proactiveAddress>`，与 `members: Record<callbackId, subject>` 完全独立；缺失时通知留 pending / RECIPIENT_UNMAPPED。F 在 server 添加可选 `WECOM_NOTIFICATION_RECIPIENTS_JSON` 配置（或多 bot 对象字段），不得从回调 ID 猜主动发送地址。
- 新增 `groupAudience(chatId)` 返回 `{userIds, complete, expiresAt}` 或 undefined，必须来自可信完整目录。无 provider 时即使配置 groups 也不发送。生产没有真实目录，保持关闭。
- 工单附件由 `registerTickets` 内注册，无共享 app 改动。平台 API `PUT /api/domains/:domain/ticket-attachment-policy` 配置 `{enabled,maxBytes,retentionDays,expectedVersion}`；默认 disabled。明确选择保留策略后才启用，当前仅 UTF-8 text/plain，最大 1MiB。GET 同路由给有领域资格用户读取配置。
- 网页成员配置消费 E/F 的 GET members + PUT members/:subject + capabilities tags/defaultStyle。平台用户无需领域资格即可进入配置页；bot 的 /身份 只展示领域角色/标签，修改引导认证网页，企微 callback 身份不直接提升为平台身份。

## 已完成实现

1. **群受众门禁**：新增可信完整目录接口；未知目录、过期结果、未映射成员、失去资格一律拒绝。每次交付重新核验且比对受众快照；受众 hash 纳入群问答 session，合法新成员加入也不会沿用旧受众下历史。群内所有命令及显式反馈/登记转个人入口，不能用 `/工单`、`/答案`、修订命令公开私人内容。没有可信生产目录，所以真实群仍关闭。
2. **当前自由文本闭环**：保留检索问题、自然追问、显式偏好与生成中取消；问题超过 4000 字不再静默截断，交给公开 API 明确拒绝。普通答案反馈默认 question，可直接解释解决；网页可选择“来源知识需要更正”走 knowledge 类别与发布约束。企微 `/工单` 显示经过权限过滤的处理记录，支持补充、本人确认与重开；较长处理记录展示有限末尾并明确转网页，绝不冒充完整内容。增加 `/身份`、`/附件`、`/投递`，补处理人的备注/合并/拒绝/指派命令。
3. **通知地址隔离**：主动发送地址与 callback identity 独立配置；只有回调映射时不发送。保留发送前授权、明确失败与 unknown 区分、unknown 不重发、状态通知不含正文。旧合成联调工具增加可选 `notifyUserId`，未提供不猜地址。
4. **工单附件**：平台配置后可启用 UTF-8 文本上传/下载，默认禁用；大小、文件名、规范 base64、UTF-8、NUL 与期望版本校验；上传幂等。独立对象绑定 ticket/domain，合并不扩大权限，内部附件仅管理员可见。下载强制 attachment/octet-stream、nosniff、sandbox、private/no-store，无公开链接或内联 HTML 预览。到期立即不可读，启动及每分钟清理过期对象。关闭策略后不再读取正文。其他媒体类型未开放，不假称已完成通用附件验收。
5. **网页配置与体验**：平台可查看/配置领域成员资格、管理员身份及 business/technical 多标签；展示标签和领域权限分离。平台无领域 grant 时仍能进入成员配置，不因此获得知识权限。增加清除偏好、工单合并/拒绝/指派、附件上传/下载和内部附件选项；切域清空旧答案按钮和签名，避免残留反馈目标；修复 waiting_reporter 状态文案。
6. **恢复与日志**：删除完整企微帧调试输出。重启遇到 processing 入站记录标记 `unknown / CHANNEL_INTERRUPTED_OUTCOME_UNKNOWN`，不再误称确定失败，也不自动重复业务创建。成员可以 `/投递` 查询不确定状态。**仍有明确缺口**：入站意图与 app.inject 业务命令不是单一事务，崩溃可能留下已建工单但收据未关联的窗口；业务幂等键持久化且旧 messageId 不重跑，但尚无跨事务自动对账。F/E 应继续设计幂等命令结果关联恢复，不能将 unknown 当作“业务未执行”。
7. **多 bot 集成**：按 F 请求，用 `app.hasRoute` 保护共享 receipts 路由避免重复注册；F 的 two-bot 独立映射测试已本地通过。上方先行交接中单对象描述是当时状态，E/F 正在推进 AppOptions 数组化，以其最终共享实现为准。

## 验证分层

### 真实企微（本轮有限通过）

运行 `npx tsx --env-file=.env tools/wecom-current-probe.ts`。启动前只读核对：未发现运行中的 src/server.ts 进程，未发现 node 监听服务；未杀任何已有服务。只读备份当前本地数据库到临时目录，使用当前生产渠道代码和真实 PiGateway 配置；不改真实 Wiki，不改原数据库，不创建公司管理员身份。测试成员只从忽略的 `.local/wecom-test-member.json` 核对，回调身份与主动地址分别使用；不输出原标识、正文或凭据。

- 2026-09-27 03:36:35 UTC：WebSocket 认证成功；向原测试成员发送明确标明联调测试的邀请，服务端 ACK。
- 60 秒窗口内 **0 个入站消息、0 条回答 ACK**；03:37:35 UTC 已关闭连接，临时数据库已删除。
- 证据：[wecom-current-1790480194881.json](wecom-current-1790480194881.json)。仅证明连接与主动测试消息 ACK，不证明阅读，不证明真实检索问答、自然追问、取消或工单闭环通过。本轮没有发起模型问答，不能把配置了真实模型写成“模型真实调用通过”。
- 工具可重复使用，默认 60 秒，`WECOM_PROBE_SECONDS` 允许 10–300 秒。先确认无人占用 bot，然后让原测试成员在窗口内依次实际提问、追问、取消、反馈、登记、查询和确认/重开；需要处理人的步骤在隔离库中用授权本地测试身份完成，不冒充公司 SSO。证据只保留 hash/字节/状态。

### 本地自动化与浏览器

- 红→绿：群 allowlist 无目录时原实现确实发送正文，新增回归初跑失败、修复后通过；附件路由不存在时初跑失败、实现后通过。
- 渠道/工单公开入口验证覆盖：重复消息、累计 ACK、deadline、生成中取消、最终发送在途取消、反馈证据快照、公开回复/内部备注过滤、本人确认/重开、群默认拒绝/受众变化/历史隔离、独立通知地址、unknown 恢复与重试边界、合并/附件越权、类型大小/版本冲突/撤权。
- `npm run typecheck` 最后检查通过；`node --check web/app.js` 与范围内 `git diff --check` 通过。并行过程中曾因 D 尚未创建 source-artifacts/source-formats 文件及临时 pages 类型错误出现失败，随后最后检查恢复通过。
- 初次完整 `npm test`：74 测试，73 通过、1 失败，失败为 B 范围 `deleting a saved preference restores the current tag default`（预期 technical，实际 business），已准确保留，不越界修改。末次全套结果在下方补记。
- 隔离内存数据库、合成知识、localhost:3138 浏览器烟测：平台本地测试身份无领域 grant，仍正确进入成员配置；点击 alice 后显示账号、普通成员权限、版本 1。没有修改任何真实账号。临时页面与测试服务已关闭。这只证明 UI 展示/回填，不代替公司 SSO 或完整网页人工验收。

## Standards

独立子代理初审：硬违规 0，判断型异味 1（附件列表与单附件可见性重复）；提取共享 `visible` 后复查关闭。基线完整企微帧日志风险也已删除，限定复查通过。

## Spec

独立子代理初审 4 项：群历史未绑定原受众；普通反馈被强制修订；企微查询不显示公开处理内容；网页不能删除偏好。均修复；长处理记录超限的复查意见也已补网页降级。限定复查四项均关闭。复查不代表真实业务验收。

两轴遗留：Standards 0；Spec 本次审查发现 0。外部验收与上文入站/业务跨事务恢复缺口单独保留。

## 文件与剩余边界

本任务写入：`src/channel.ts`、`src/tickets.ts`、`src/ticket-attachments.ts`、`src/notifications.ts`、`src/adapters/wecom.ts`、`web/app.js`、`web/index.html`；`test/channel-controls.test.ts`、`test/channel-group.test.ts`、`test/ticket-attachments.test.ts`、`test/notifications.test.ts`、`test/wecom.test.ts`；`tools/wecom-current-probe.ts`、`tools/wecom-dialogue-smoke.ts`；本报告与本轮脱敏真实证据。初始已有文件改动均保留，未暂存或提交。

尚未关闭：真实自由文本双向全流程与多端同身份验收；公司 SSO 实际配置验证；可信群目录/获准群成员变更真实实验；附件业务批准的类型/保留策略（所以默认禁用）；通用图片/PDF 等附件；浏览器完整操作矩阵；入站业务命令崩溃对账。管理员与标签“可配置”的开发已完成，不要求预先固定某个人名；技术标签不会赋管理权限。工单正文与附件不等于 D 的知识来源附件。

## 最终验证补记

末次完整 `npm test`：**89 测试通过、0 失败**，约 7.32 秒（运行期间包含其他任务已落地的新增测试）；此前标签默认值回归在 B 集成后恢复。最后一次 `npm run typecheck`、网页语法检查和 C 范围差异空白检查全部通过。仅可将这些记为本地自动化通过，不可替代上文列出的真实验收缺口。C 当前实现交接完成，F 可以开始本范围最终集成修复；无代码暂存/提交，无真实连接遗留。
