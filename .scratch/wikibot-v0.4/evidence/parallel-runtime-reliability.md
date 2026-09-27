# E 运行可靠性（实施中）

基线：`75c6dc026fe8c2f91e5ff329cc2fce6615f5b48b`，保留本轮开始时的未提交检索改造；本报告不代表真实业务验收。

## 供 B/C/F 立即消费的成员配置契约

- `Grant.tags?: ("business" | "technical")[]`，旧记录兼容无标签。
- `core.defaultStyle(grant)`：含 technical 则 technical，否则 business。B 在 answers/preference 默认处按显式输入 > 已存偏好 > defaultStyle(access(...)) 消费；E 不编辑 answers.ts。
- 原平台配置 API `PUT /api/domains/:domain/members/:subject` 增加可选 tags 数组（最多两个、去重），不传则保留既有标签，`[]` 清空标签。role 仍为 member/admin，与标签分离；需 platform 身份、幂等键、expectedVersion。
- `GET /api/domains/:domain/members` 仅 platform 可用，列出授权记录、tags、defaultStyle；普通管理员不能隐含配置平台资格。
- `GET /api/domains/:domain/capabilities` 增加 tags/defaultStyle，返回当前成员授权。
- 独立恢复证明 grants 条目支持 tags；没有当前标签证明时恢复为空，不能从旧备份推断当前表达标签。

最终验证、故障矩阵和缺口将在完成后补充。

## 最终实施结果（2026-09-27）

E 实施完成并交接；04/11/17–19 **不据此关闭真实业务验收**。没有启动共享机器人、读取/修改真实 Wiki、调用公司模型、发布 GitHub 内容、暂存或提交。

### 变更

- 恢复不能只相信数据库中保存的 descriptorHash：用实际 bundle/pages 重算哈希，不一致返回 `RESTORED_BUNDLE_CORRUPT` 并保持维护。
- 恢复命令绑定独立 cycleId，同键跨第二次恢复返回 `IDEMPOTENCY_CONFLICT`，避免返回旧成功但实际未开放。当前恢复记录保存隔离时间、旧指针/epoch、原交付边界、独立证明引用及覆盖模型、授权数/摘要、当前确认者和开放时间；旧周期归档，不因隔离时置零交付可见范围丢失原事实。旧备份中的“已交付”只作为历史记录，不自动恢复为当前可补发资格。
- 接入 B 的 `recoverEvaluations(store,true)`：先完成领域维护/答案停止事务，再强制结束旧评估。该接口自带事务，不能嵌套在 Store.tx 内。D 来源执行资格已绑定领域 epoch，恢复开放会递增 epoch；真实恢复仍要求旧实例停止和当前独立证明。
- Cookie 写请求在可信 publicOrigin 缺失时明确拒绝；修复旧持久会话在配置缺失后因两个 undefined 相等而获得写入的问题。
- `AppOptions.wecom` 支持单配置或配置数组；打开数据库前拒绝重复 botId（`DUPLICATE_BOT_CONFIGURATION`）。F 负责 server 环境配置及多领域场景。
- 与 D 交接：submissions 无 grant 的主体调用 `authorizeSourceUpload`，任何已有 grant 仍走原管理员检查；不会赋予 helper review/evaluate/activate 能力。validateBundle 后调用 `validateSourceSubmission`，批准附件白名单来自领域配置，默认拒绝未批准类型。
- SQLite 迁移版本从 2→3，增加独立 operational_events 表与时间索引；没有删除旧对象、审计和命令。

### 运维接口与保留边界

全部接口要求 platform 身份。领域 admin 没有隐含运维权限。

- `GET /api/operations/status`：领域 readiness、queued/running/unknown 数、卡死答案 ID/domain/deadline/leaseUntil、未知投递定位、来源冲突/需要核对项、当前与历史恢复记录、告警列表。未知投递同时包含 Inbox 和 Notice。
- `GET /api/operations/events`：最近最多 200 条稳定错误码、状态码、路由模板、请求编号和时间。不会记录请求正文、Authorization、Cookie、原始平台消息 ID；来源错误不复制凭据。拒绝日志写入失败不改变原来的拒绝结果。
- 告警涵盖 `JOBS_STALLED`、`DELIVERY_UNKNOWN`、`ACCESS_REJECTED`、`REVOKED_CONTENT_SUPPRESSED`、`SOURCE_CONFLICT`、`SOURCE_RECOVERY_REQUIRED`。拒绝/撤回事件窗口为最近 15 分钟且最多 200 条，响应明确给出窗口与 limit，**不是精确全量统计或联合 SLO**。轮询接口已具备；公司告警接收人、升级流程、告警平台接入仍需部署配置。
- `AppOptions.operationalRetention?: {eventRetentionMs:number,policyId:string}`：只有明确注入正整数保留时长与政策标识后，`POST /api/operations/cleanup`（body `{}`、幂等键）才工作；未配置返回 `RETENTION_POLICY_REQUIRED`。响应包含政策引用、实际截止时间、事件/过期 token/过期登录状态删除计数。
- 此清理只删除过期认证材料和过期运维事件。**不删除会话/答案、偏好、工单证据、修订、恢复历史、审计和幂等结果**。现有偏好删除由 B 管理的公开接口负责。公司各类内容保留时长、法律/工单留存例外、幂等重放窗口未确认，因此不能把元数据清理称为全部业务保留实现。未来业务删除必须同时处理 commands 中的历史结果与幂等墓碑，不能只删 Answer 行使重放泄漏旧正文或新建重复对象。

## 可重复故障矩阵

全部数据与身份为合成数据，SQLite 使用独立 mkdtemp 目录；OIDC 测试服务使用随机本地端口。数据库实验是真实 SQLite/进程实验，不是真实公司系统验收。

| 边界 / 注入 | 预期和实际结果 | 可重复证据 |
|---|---|---|
| Store.command 写对象后、提交前子进程直接退出 73 | 未提交对象/命令一起回滚，同键重试可完成；异摘要冲突 | durability：process death before commit… |
| Store.command 提交后子进程退出 74 | 重试返回已提交原结果，不再执行业务创建 | 同上 |
| 公开 Answer 请求已进入模型调用时子进程退出 72 | 真实租约约 5 秒后 failed/EXECUTION_UNKNOWN；0 次重新调用，deadline 不变 | durability：worker killed during a model call… |
| 已完成答案关闭并重开应用 | 同一答案正文可查，不再次生成 | durability 原有重启回归，按当前检索式更新 |
| 在线 SQLite backup 后，原库撤权/撤回/换模，恢复备份 | 独立证明替身指定 active=null、空授权、新 modelEpoch；旧 token 401，知识 readiness 为 unavailable | recovery：actual SQLite backup… |
| 备份正文被改但保留声明哈希 | 恢复 409，仍维护；修复前实际错误为 200 | recovery：corrupted restored bundle |
| 有 ACK 的答案→恢复开放→再次恢复 | 保留首轮交付边界与证明/确认者归档，旧恢复幂等键 409 | recovery：previous recovery command… |
| 两个同基线、已评估批准候选同时 activate | 只有一个 200，另一 409；成员看到唯一胜出版本 | publication：two approved candidates… |
| 撤回活动版本、重试撤回、回滚撤回目标 | 重试原结果；读原文 410；回滚撤回目标 409；空指针可经全新评估复核发布 | revocation.test.ts |
| 已知模型变化与迟到 ACK/历史读取 | 新生成关闭、历史仅已交付范围、迟到交付不能恢复被拒正文 | model-change/late-ack/citations 原有回归 |
| 平台设置双标签，领域 admin 尝试同设置 | platform 成功、admin 403；双标签默认 technical 且仍是 member，无知识管理权 | access 新增回归 |
| 可信 publicOrigin 缺失、复用旧 cookie session 写操作 | 403 ORIGIN_NOT_ALLOWED；修复前实际 201 | auth 新增回归 |
| 持久化 Inbox unknown 与来源 conflict | operator 状态可定位；无私人成员/平台消息原文 | operations 新增回归 |
| 未提供政策 / 提供合成毫秒级政策执行 cleanup | 无政策 503；有政策清理事件，业务命令幂等结果仍保留；不接受 deleteAnswers 参数 | operations 新增回归 |

注意：Store.command 崩溃实验验证接收事务这一存储边界，**不证明当前渠道先写 Inbox、后调用业务 API 的两个事务已经合并**。渠道初始窗口仍属于 C/F 交接范围，不能用此实验消除该缺口。

## 验证命令与结果

工作目录 `/Users/rubychen/Documents/ChatGPT/wikibot`。

```sh
npx tsx --test test/access.test.ts test/auth.test.ts test/citations.test.ts test/durability.test.ts test/late-ack.test.ts test/model-change.test.ts test/recovery.test.ts test/publication.test.ts test/revocation.test.ts test/operations.test.ts
npm run typecheck
npm run build
npm test
git diff --check -- src/core.ts src/app.ts src/operations.ts src/publication.ts test/access.test.ts test/auth.test.ts test/durability.test.ts test/recovery.test.ts test/publication.test.ts test/operations.test.ts test/revocation.test.ts
```

- E 最终定向测试：**21 通过，0 失败**，约 6.42 秒（包括真实子进程退出及租约等待）。
- 最后一次 typecheck：通过；build：通过；E 所有修改 diff whitespace 检查：通过。
- 本轮运行了完整测试。并行修改期间先后出现 D 文件尚未生成/临时类型未就绪、B 测试先行而实现未完成的中间失败，均未修改他人文件规避。
- 最近完整快照：**89 项，88 通过，1 失败**。唯一失败为 B 新加 `a failed rerun cannot reuse an older passing result for approval`，期望 409、实际 200；已交 F/B 修复。F 必须在全部任务交接后再跑全量，不能引用 E 的 21 项定向通过宣称全量通过。
- 合成恢复微型用例的执行时间不是公司 RTO，临时数据库零内容损失也不是公司 RPO；未承诺任何公司指标。

## 审查

按 implement/tdd/code-review 执行；用户指定共享目录不提交的安排覆盖技能中提交要求。固定点为本报告开头 SHA，用户要求未提交协作，审查使用固定点至工作区的限定文件 diff，新增文件单独读取。

### Standards

独立初审及限定复查均 0 项；无规范硬性违反或需要报告的 Fowler 异味。

### Spec

初审发现 2 项：P1 重复恢复覆盖原交付事实/证明；P2 Inbox 未知投递未进入告警。均已按先失败后修复处理，独立复查 0 遗留，审查者实际运行 operations/recovery/auth 的 10 项回归全部通过。其后只追加来源冲突只读观测、D 批准附件门禁接线及撤回公开行为回归；对应定向测试和类型检查通过。真实公司接入和完整业务保留政策缺口保留。

## F 最终集成建议与外部前提

1. 成员 tags/defaultStyle 契约见开头，B 消费默认值，C 展示与配置；已有显式 preference 优先。F server 可添加显式运维保留配置并将其注入 AppOptions.operationalRetention；不得赋默认公司政策或硬编码管理员。
2. app 已支持多 bot 且拒绝重复 botId，F 用 WECOM_BOTS_JSON 配置并补同进程领域隔离回归。publication 两项 D 接线已经完成；需结合 D 的最终 helper/附件端到端用例复核。
3. 收件去重/业务创建崩溃窗口必须由 C/F 最终处理或保留未完成：当前 Inbox processing 先落盘后业务创建，启动时改 unknown 只能拒绝自动重放，不能证明任务未丢失；需持久化可安全恢复的业务意图、同事务关联或明确新的用户重试结果。不要直接自动重放执行未知的消息。
4. 公司 OIDC issuer/audience/JWKS、客户端配置、当前 operator 目录、SSO 与企微稳定映射仍须真实验证。当前 JWT 是本地签名/JWKS 契约测试，没有声称公司登录成功。
5. 独立当前证明服务必须由受信部署配置提供，并覆盖当前授权、知识有效性、模型版本/资格与历史交付复核范围；不能从恢复库里的审计/自签文件自证。现有接口证明覆盖 active/grants/models；历史投递未得到当前独立确认时保持 pending 和禁止补发，尚无开放历史交付的证明协议。
6. 恢复点的实际备份时间/存储位置、外部不可变包方案、部署负责人、告警接收人、联合 SLO、业务各类保留政策、RPO/RTO、真实渠道撤回传播和网络未知回执演练仍需外部给定并真实验收。当前 bundle/pages 内联 SQLite、检索索引从固定 bundle 重算；并未假装独立对象存储恢复已验证。
7. 本轮 E 修改：src/core.ts、src/app.ts、src/operations.ts、src/publication.ts（保留原有检索改造）；test/access.test.ts、test/auth.test.ts、test/durability.test.ts（保留检索变更）、test/recovery.test.ts、test/publication.test.ts；新增 test/operations.test.ts、test/revocation.test.ts；本报告。src/auth.ts 未改。其余既有/并行改动未撤销，未执行 git add/commit。
