# 本地运行与联调

当前是单机、单 Node.js 进程的集成实现。SQLite WAL 保存不可变知识包、业务状态、租约、入站去重、通知记录及审计；不用于多机或生产容量承诺。Node.js 24.13+ 的 SQLite API 仍带实验性标记。

## 合成演示

```sh
npm ci
npm run demo
WIKIBOT_DEMO=1 npm run dev
```

访问 `http://127.0.0.1:3000`。`.local/demo-access.json` 的 `member` 用于成员、`admin` 用于维护、`operator` 仅用于平台配置。文件和数据库已忽略，不提交 Git。演示使用合成流程与固定模型，不连接企微或公司模型；令牌 24 小时后过期。demo 拒绝覆盖已有数据库。真实环境使用独立 DATABASE_PATH，不能混入演示资格和评估。

```sh
npm run typecheck
npm test
npm run build
WIKIBOT_DEMO=1 npm start
```

生产构建包含 dist/web。服务默认监听回环地址；公开监听要求公司 JWT 验证及 HTTPS 外部地址，TLS 由可信反向代理终止。当前尚未通过真实试点验收。

## 真实配置

参考 `.env.example`，将配置放入被忽略的 `.env` 或受控运行时。真实密钥不放入命令参数、快照、日志、评估或 Git。直接 API 模型使用 `glm-5.3`，不传 CC 的 `[1m]`。模型传输层为 `@earendil-works/pi-ai`（固定 `0.87.1`，经 `createProvider` 与 Anthropic Messages API 适配指向 `ANTHROPIC_BASE_URL`，令牌以 Bearer 头注入；`pi-agent-core` 与设计 4.2 工具循环未引入）。普通请求默认原始期限 15 秒（ANSWER_DEADLINE_MS），SDK 禁止自动重试；协议/引用校验后才能展示正文，未校验模型增量不可当作有效首段。15 秒期限不替代 3 秒/10 秒联合 SLO。

公司身份需配置 issuer、audience、JWKS、OAuth 授权/令牌端点和 client ID。网页使用授权码和 PKCE，验证访问令牌后签发最多 15 分钟的 HttpOnly、SameSite 会话，HTTPS 下启用 Secure；领域权限每次操作核验。配置外部身份后禁止签发本地成员令牌。平台操作员由 PLATFORM_SUBJECTS 的确切 subject 指定，本身不具有领域知识访问权。目录撤权与跨端身份需真实联调。

创建、发布、工单及修订等命令需要 Idempotency-Key，更新还要求 expectedVersion 或发布 epoch。开发令牌签发为一次性凭据发放，不缓存可重放的明文；丢失时重新签发。具体请求字段见 src 中的 Zod 契约。

## 发布

1. 生成页面清单草稿：`npm run manifest -- <wiki 根目录> <子目录> MANIFEST.json`（遍历 .md、计算哈希；中文路径段会转为 slug 并追加路径哈希避免碰撞），再手工补写金样例 `cases`（真实问题 + 期望引用页面）和 `config.model`。
2. 快照：`npm run snapshot -- <知识根目录> MANIFEST.json SNAPSHOT.json`。清单不含正文；工具读取声明的 Markdown、校验哈希、拒绝符号链接/穿越/超限，二次读取检测捕获期间变化。维护者仍须停止所有外部编辑。
3. 平台操作员通过 `POST /api/models/qualify` 记录真实模型资格证据。未知模型默认不合格；资格不代替领域评估。
4. 管理员提交 `/api/domains/:domain/submissions`，逐个金样例调用 `.../releases/:id/evaluations`（执行真实检索与模型回答，记录引用命中）。失败不改变线上版本；重复幂等键不重复调用。
5. 管理员核对正文、范围、引用命中和评估输出，再执行 review。结构校验不能代替业务事实核验。
6. activate 在一个事务中核对基线、哈希、审批人资格、模型 epoch 并切换；其他旧候选失效。
7. revoke 永久撤回目标。rollback-candidate 只从有效 retired 版本创建新候选，再走当前评估审批；revoked 永不恢复。

回答链路（ADR-0004）：服务端中文词法检索取 top-K 页面（默认 6、实际序列化 UTF-8 预算 60KB）→ 单次模型调用输出纯 JSON 回答与引用 → 引用白名单校验；检索无命中返回 `KNOWLEDGE_COVERAGE_GAP`，不调用模型。有命中但证据不足或需澄清时，模型可显式返回相应 outcome；协议错误不补造引用。正文只在最终校验后交付，等待提示不算有效首段。答案期限默认 15 秒（`ANSWER_DEADLINE_MS`），不替代原 SLO。多跳受限工具读取（pi-agent-core）及嵌入检索仍为后续范围。

## Wiki 维护

现有真实 Wiki 是一个可配置来源实例，源目录默认只读。真实正文已在 retrieval-pivot.md 记录的首跑中发送给公司模型；“未发送”只适用于更早的只读盘点和合成实验。原 llm-wiki 技能真实可用性仍待验证；本轮受控来源助手的实现和隔离副本实验见 D 的专属报告，不等同于原技能往返通过。

管理员在网页或单聊保存修订，提交为 sync_pending。草稿固定旧哈希和更正依据；维护者取得获准技能后，在人工维护窗口暂停全部写者，另存更正记录，通过原技能更新，再提交快照和 sourceEvidence 关联候选。不得直接覆盖只读 source-docs。

```sh
npm run snapshot -- WORKSPACE_ROOT MANIFEST.json NEW_SNAPSHOT.json
```

只读快照要求 manifest 声明页面路径与预期哈希，正文从工作区读取并回填；拒绝符号链接、穿越、超限和哈希冲突。支持稳定 frontmatter ID、受控 redirect、纯文本来源摘录及明确批准的静态 PNG/JPEG 附件；未知格式、SVG/HTML/脚本拒绝。完整真实来源矩阵仍待原技能验证。维护者须停止所有外部编辑；二次读取不是跨进程原子锁。

## 企微单聊

WECOM_ENABLED=1 才连接，使用 runtime Bot ID/Secret、固定领域及已核实成员映射。管理员通过授权配置指定，不硬编码测试成员为管理员。映射不授予领域资格。

`WECOM_MEMBERS_JSON` 的键必须是可信消息回调中实际的 `from.userid`，值才是已核实的公司身份 subject。真实联调发现，向 `rubychen` 主动发送成功，并不表示其入站 `from.userid` 也是 `rubychen`；该租户回传另一串不透明标识。请依据受控联调/公司目录核对映射，不按消息自报姓名自动绑定，不通过取消白名单检查解决无回复。

`tools/wecom-dialogue-smoke.ts` 是限时双向联调助手，使用独立内存测试数据和合成模型。标准输入的一行 JSON 包含 botId、botSecret、userId（实际回调标识）及 minutes（1–30，默认 20）。必须通过管道提供凭据，或在启动前关闭终端回显（`stty -echo`，完成后用 `stty echo` 恢复）；`readline` 本身不负责关闭终端回显。就绪后仅接受指定 bot、单聊和确切回调标识，记录脱敏事件及回执，不读取真实 Wiki。标准输入发送 `status` 查看连接，发送 `stop` 关闭，也会在期限到达后自动关闭。示例模型延迟用于命中取消窗口，当前默认应用期限15秒；必须记录实际期限和延迟。这不是公司模型性能测试，历史10秒实验保留其原始语义。

采用[企业微信官方 SDK](https://github.com/WecomTeam/aibot-node-sdk)，一个数据库的同 bot 只有一个有效连接租约。默认服务器未配置可信完整群目录，即使 allowlist 有群也拒绝群回答；适配 provider 必须返回完整当前受众，发送前重验全部成员。单聊例子：

```text
示例流程怎么做？
其中第二步需要哪些材料？

/登记 问题完整说明
/帮助
换成客户乙时有哪些注意事项？
/取消
/答案
/偏好
/偏好 技术 熟练
/清除偏好
/通知
/重试通知 通知编号@版本
/工单 工单编号
/反馈 答案编号 具体反馈
/补充 工单编号@版本 补充内容
/确认 工单编号@版本
/重开 工单编号@版本 再次出现的情况
/修订
/修订状态 修订编号
/提交修订 修订编号@版本
```

当前使用自由文本和追问，不使用 `/条件`、`/继续`。历史只用于理解指代，必须通过当前授权、版本有效性和已交付范围检查；当前问题/更正优先。`/偏好 业务|技术 入门|熟练` 才保存长期偏好，与网页共用本人记录；不改变领域资格。`/取消 [答案编号]` 默认为本次单聊最近答案，停止后续生成及正文发送，不能撤销已经在途的消息。`/答案 [答案编号]` 分别显示生成、已确认正文块及企微交付状态。

调用、读取及实际交付前检查权限。发送先落盘 unknown，确认回执后更新已交付范围，unknown 不自动重发；正文最长 UTF-8 20,480 字节，超限转认证网页，不计企微完整送达。`streamFinished` 表示渠道流结束，`complete` 才表示本次完整正文和结束回执均已确认；取消、超限和处理期限结束不计完整交付。网页链接不带令牌。业务调用前持久化命令键，业务提交同事务记录脱敏结果索引；重启只读关联已提交对象，不重放、不重建旧回调、不补发。`/投递` 可区分业务已提交与交付未知。无结果索引的旧记录或歧义保持 unknown，需人工核对后决定新请求，不可认为从未执行。

### 工单与更正通知

设置 `WECOM_NOTIFICATIONS_ENABLED=1` 启用主动状态通知，并配置独立核实的 `WECOM_NOTIFICATION_RECIPIENTS_JSON`（subject → 主动接收地址）。缺少映射保持 pending；不从入站 callback ID 推断。分发器与单聊共用 bot 租约；发送前重新检查领域资格、原对象归属和唯一接收人映射。通知只含稳定编号、对象编号和状态，不含标题、评论、内部备注、解决正文或旧答案。模型待复核/失效通知只发给有原答案交付确认的本人；后续迟到成功回执仍可建立该事实。撤回后允许不含正文的更正，恢复隔离期间禁止外发。

`GET /api/domains/:domain/notices` 或 `/通知` 查看本人状态及版本。SDK 明确成功为 acked，服务端明确拒绝为 failed，超时或断线为 unknown；ACK 不证明人已阅读。断线、缺少/歧义映射或原答案交付未确认保持 pending 并记录原因，超过 24 小时过期。撤权或接收人变化为 suppressed。

只有服务端明确拒绝的 failed 可以由本人调用 `POST .../notices/:id/retry`（`expectedVersion`、幂等键）或 `/重试通知 编号@版本` 重试。每个事件最多 3 次尝试、仍受 24 小时期限约束，重试沿用同一通知编号，重新检查权限且不重复执行业务命令。unknown 不自动或手动盲目重发；当前尚无平台送达查询证据来安全恢复它。重启保留 unknown；从备份恢复时，旧 pending/failed/unknown 均转为不可重试的 unknown。

本地回归覆盖公开 HTTP/单聊事件及官方 SDK 对本地 WebSocket 的真实帧交互；不替代 rubychen 的真实客户端往返、真实租户限流、滚动更新和传播延时抽样。

## 备份和恢复

```sh
npm run backup -- .local/wikibot.sqlite NEW_BACKUP.sqlite
RECOVERY_MODE=1 npm start
```

备份使用 SQLite online backup，不直接拷贝运行中的主文件。恢复必须显式配置 RECOVERY_MODE=1；系统无法判断运维是否把旧文件冒充正常重启。该模式隔离所有领域、作废备份中的会话和令牌、终止未知任务、封锁未经独立证实的历史交付。恢复操作身份来自当前运行时 bootstrap 或当前公司身份验证，不能沿用旧备份令牌。

平台通过 `/api/operations/recover/:domain` 调用独立 RECOVERY_PROOF_URL 获取本次 nonce 的签名证明，验证指定 issuer/JWKS/audience；证明时间须在 60 秒内，包含完整当前 grants、可信 active ID/哈希、模型资格和 epoch、独立 evidenceId。缺包或证据不足保持关闭，未列出的版本全部隔离，旧历史交付保持未确认。证明服务必须独立于备份，不能简单对备份内容重新签名。

`/api/operations/status` 查询状态，`/api/domains/:domain/audit` 查询审计。运维接口记录请求编号和稳定错误码，不记录正文或令牌；提供卡死任务、未知答案/通知投递等告警条目，尚无真实生产告警投递及 RPO/RTO 演练。只有同时配置 `OPERATIONAL_RETENTION_MS` 与获批准的 `OPERATIONAL_RETENTION_POLICY` 才启用相应清理策略；清理范围为运维元数据及过期认证材料，不删除业务正文、审计或幂等记录。

## 受控配置与本轮验收

平台通过 `PUT /api/domains/:domain/members/:subject` 配置 `{role:"member"|"admin",tags:["business","technical"],expectedVersion}`；可选 enabled 控制撤权。不传 tags 保留原标签，空数组清除。标签兼有默认 technical，本轮选择和保存偏好优先；清除偏好后回到标签默认。标签不授予管理权限。网页平台配置页可管理这些字段；`GET .../capabilities` 或 bot `/身份` 查看本人角色/标签。

领域管理员通过 `PUT .../source-workspace` 配置绝对 root、独立 helperSubject、adapter 与 expectedVersion；具体来源助手维护窗口、租约和恢复步骤见[来源维护报告](../.scratch/wikibot-v0.4/evidence/parallel-source-maintenance.md)。普通成员不能指定路径；配置变化使旧租约失效，未知写入必须人工核对后恢复。来源附件白名单默认空，工单附件则使用独立的平台 `ticket-attachment-policy`（enabled、maxBytes、retentionDays），二者不能混用。

同进程多 bot 使用 `WECOM_BOTS_JSON` 数组，设置后替代单 bot 配置。每项为 `{botId,domain,secretEnv,members,notifications?,notificationRecipients?,groups?}`，secretEnv 指向运行时密钥变量名称。重复 botId 启动失败；每 bot 使用独立映射与租约，不能用绑定扩大成员领域权限。合成非广告配置与测试见 [second-domain](../examples/second-domain/README.md)，真实第二领域仍待负责人批准。

发布 config 可包含 domainLabel 及 answerTemplates 的 business/technical/beginner/experienced 四项，模板进入不可变发布描述并参与评估。评估 complete 只表示执行完成，机器 verdict=pass 才满足机器门禁，之后仍需人工复核。

离线 SLO 统计可运行 `npm run acceptance:report -- examples/acceptance-run.synthetic.json`。真实运行前冻结普通请求 ID 清单及范围/并发/配额，填写实际 descriptorHash 和批准记录引用。usefulFirstMs 必须是有效且已验证引用的内容交付时间，等待提示、空首段或尚无引用的正文不算；completeMs 是完整交付时间，success 还须满足预先约定的质量条件。未观测填 null，不删除失败请求。报告 accepted 仅表示输入数据的 SLO 算术条件成立，不验证输入来源，也不代表试点或完整验收通过。真实 ≥1000 请求的配额与负载尚未执行。

历史联调报告按当时版本解读。当前分工证据见 `.scratch/wikibot-v0.4/evidence/parallel-spec-alignment.md` 及各 parallel 报告；真实公司身份、群目录、来源技能、专家题集和负载验收分别记录。
