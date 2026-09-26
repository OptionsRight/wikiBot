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

参考 `.env.example`，将配置放入被忽略的 `.env` 或受控运行时。真实密钥不放入命令参数、快照、日志、评估或 Git。直接 API 模型使用 `glm-5.3`，不传 CC 的 `[1m]`。普通请求原始期限 10 秒，SDK 禁止自动重试；程序清单可先交付，模型解释须完整 JSON 校验后展示。

公司身份需配置 issuer、audience、JWKS、OAuth 授权/令牌端点和 client ID。网页使用授权码和 PKCE，验证访问令牌后签发最多 15 分钟的 HttpOnly、SameSite 会话，HTTPS 下启用 Secure；领域权限每次操作核验。配置外部身份后禁止签发本地成员令牌。平台操作员由 PLATFORM_SUBJECTS 的确切 subject 指定，本身不具有领域知识访问权。目录撤权与跨端身份需真实联调。

创建、发布、工单及修订等命令需要 Idempotency-Key，更新还要求 expectedVersion 或发布 epoch。开发令牌签发为一次性凭据发放，不缓存可重放的明文；丢失时重新签发。具体请求字段见 src 中的 Zod 契约。

## 发布

1. 准备包含 pages、procedures、cases、config 的 JSON bundle，示例见 test/helpers.ts。每条批准分支至少一个回归用例；页面/流程哈希一致，全部内容固定进 descriptorHash。
2. 平台操作员通过 `POST /api/models/qualify` 记录真实模型资格证据。未知模型默认不合格；资格不代替领域评估。
3. 管理员提交 `/api/domains/:domain/submissions`，逐个 case 调用 `.../releases/:id/evaluations`。执行精确配置模型，失败不改变线上版本；重复幂等键不重复调用。未知结果需人工发起新的评估请求。
4. 管理员核对正文、范围、路径、来源和评估输出，再执行 review。结构校验不能代替业务事实核验。
5. activate 在一个事务中核对基线、哈希、审批人资格、模型 epoch 并切换；其他旧候选失效。
6. revoke 永久撤回目标。rollback-candidate 只从有效 retired 版本创建新候选，再走当前评估审批；revoked 永不恢复。

当前尚未实现复杂二次工具读取、任意版本模板、全文检索或附件格式，不能用有限实现声称完整设计验收通过。

## Wiki 维护

源目录 `/Users/rubychen/Desktop/credit-market-advert/wiki` 本次未修改，也未把真实正文发送给模型。用户确认 llm-wiki 技能暂不可用，故技能助手领取、真实写回、部分写入恢复与重导入未实现/验证。

管理员在网页或单聊保存修订，提交为 sync_pending。草稿固定旧哈希和更正依据；维护者取得获准技能后，在人工维护窗口暂停全部写者，另存更正记录，通过原技能更新，再提交快照和 sourceEvidence 关联候选。不得直接覆盖只读 source-docs。

```sh
npm run snapshot -- WORKSPACE_ROOT MANIFEST.json NEW_SNAPSHOT.json
```

只读文本快照工具要求 manifest 是完整 bundle，并有预期页面哈希。仅读取声明的 Markdown；拒绝符号链接、穿越、超限和哈希冲突，二次读取检测捕获期间变化。维护者仍须停止所有外部编辑；二次读取不是跨进程原子锁。尚不支持附件、完整来源矩阵和自动改名追踪。

## 企微单聊

WECOM_ENABLED=1 才连接，使用 runtime Bot ID/Secret、固定领域及已核实成员映射。用户已确认 ID 是字段标签、实际值从 aib 开始；测试成员为 rubychen（陈诚），尚未指定知识管理员。映射不授予领域资格，不自动赋予管理员角色。

采用[企业微信官方 SDK](https://github.com/WecomTeam/aibot-node-sdk)，一个数据库的同 bot 只有一个有效连接租约。群事件默认拒绝；不接受用户声称的领域或角色。单聊例子：

```text
示例流程怎么做
对象：客户甲
条件：scenario=new

/登记 问题完整说明
/工单 工单编号
/反馈 答案编号 具体反馈
/补充 工单编号@版本 补充内容
/确认 工单编号@版本
/重开 工单编号@版本 再次出现的情况
/修订
/修订状态 修订编号
/提交修订 修订编号@版本
```

调用、读取及实际交付前检查权限。发送先落盘 unknown，确认回执后更新已交付范围，unknown 不自动重发；正文最长 UTF-8 20,480 字节，超限转认证网页，不计企微完整送达。网页链接不带令牌。进程重启不重建旧回调上下文，未确认入站保守停止。后台工单/更正通知已记 outbox，主动推送分发器尚未实现；可通过网页和查询命令查看。

## 备份和恢复

```sh
npm run backup -- .local/wikibot.sqlite NEW_BACKUP.sqlite
RECOVERY_MODE=1 npm start
```

备份使用 SQLite online backup，不直接拷贝运行中的主文件。恢复必须显式配置 RECOVERY_MODE=1；系统无法判断运维是否把旧文件冒充正常重启。该模式隔离所有领域、作废备份中的会话和令牌、终止未知任务、封锁未经独立证实的历史交付。恢复操作身份来自当前运行时 bootstrap 或当前公司身份验证，不能沿用旧备份令牌。

平台通过 `/api/operations/recover/:domain` 调用独立 RECOVERY_PROOF_URL 获取本次 nonce 的签名证明，验证指定 issuer/JWKS/audience；证明时间须在 60 秒内，包含完整当前 grants、可信 active ID/哈希、模型资格和 epoch、独立 evidenceId。缺包或证据不足保持关闭，未列出的版本全部隔离，旧历史交付保持未确认。证明服务必须独立于备份，不能简单对备份内容重新签名。

`/api/operations/status` 查询状态，`/api/domains/:domain/audit` 查询审计。尚无生产告警投递、保留清理、真实 RPO/RTO 演练或负载容量结论。
