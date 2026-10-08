# v0.5 运行、迁移与故障处理

实现及实测范围见 [交付记录](handoff/v0.5-implementation.md)。接口沿用 Bearer 身份、领域权限、`Idempotency-Key` 和 `expectedVersion`。不得把文件写入或 Python 完成视为知识已发布。

## 环境与锁定依赖

要求 Node >=24.13、Python 3.12、Git。已验证 Windows / Node 24.19 / Python 3.12.10；Linux 部署须在目标环境重跑下述命令。Node 22 不支持本仓库需要的 SQLite API。

```sh
npm ci
uv venv --python 3.12 .local/normalizer-env
uv pip sync --python .local/normalizer-env/bin/python --require-hashes python/normalizer/requirements.lock
uv venv --python 3.12 .local/evaluation-env
uv pip sync --python .local/evaluation-env/bin/python --require-hashes python/evaluation/requirements.lock
npm run typecheck
npm run build
npm test
```

Windows 使用 `Scripts/python.exe`。Docling 的原生 PDF 动态资源加载器在中文虚拟环境路径下可能失败；把 normalizer 环境放在 ASCII 路径，例如 `C:/wikibot-runtime/normalizer`，原件和仓库可在中文路径。锁文件由 uv 0.7.3 `pip compile --python-version 3.12 --universal --generate-hashes` 生成；不要用无版本 `pip install` 覆盖环境。

复制 `.env.example` 为本地 `.env`，至少配置数据库、资产目录、normalizer Python 绝对路径和解析 profile。`npm run dev` 或构建后 `npm start` 同时启动 Fastify 和串行后台解析监督器。单实例拥有 SQLite 写入权；Python 只读任务目录并写产物，不访问数据库。在线问答不运行解析或 judge。关闭时等待当前后台工作结束；强制退出由租约/完整清单恢复。

默认 `config/normalizer.native.json` 使用真实 Docling 的 native PDF 管线，适合带文本 PDF，并实际支持 DOCX/PPTX/XLSX；无需模型下载。扫描页、图片、无法保持语义的表格、公式和隐藏工作表产生警告及 partial，不假装完整。表格不自动成为事实，管理员须核对原件。宏、加密、过大解压内容和格式不匹配拒绝处理；公式和外链不执行。

需要 OCR 时，在受控环境预置 Docling 权重，设置 `DOCLING_ARTIFACTS_PATH`，复制 profile 并改 `pipeline=standard`、`ocr=true`。`modelArtifactsHash` 是按相对 POSIX 路径排序的 `{path,rawSha256}` 数组经 `python/common.py` 的 `wire_hash` 计算的摘要；profile 整体同样入哈希。运行时禁止联网取权重。OCR profile 在本轮未做真实权重验收，启用前必须重跑真实扫描件验证。

DeepEval 位于独立 dev/test 环境。需要评测的受控服务实例配置 `EVALUATION_PYTHON` 和 `JUDGE_PROFILE_PATH`；在线专用实例可不配置这两项。复制 `config/judge.example.json`，填写实际模型 ID 和经资格确认的 revision。judge 经现有 TS PiGateway 使用公司端点和服务端凭证，Python 只通过 stdio 请求 JSON schema 响应；不接收 API key、不自动加载 dotenv、不上传遥测。先通过原有 `/api/models/qualify` 确认答案模型和 judge 模型的资格。

## 可独立运行的合成端到端

在上述两个隔离环境装完锁定依赖后，设置它们的绝对路径：

```powershell
$env:NORMALIZER_PYTHON='C:/wikibot-runtime/normalizer/Scripts/python.exe'
$env:EVALUATION_PYTHON='C:/wikibot-runtime/evaluation/Scripts/python.exe'
$env:PYTHONUTF8='1'
& $env:NORMALIZER_PYTHON python/normalizer/verify_samples.py .local/docling-proof config/normalizer.native.json
npm run test:e2e:v05
```

POSIX 使用 `export` 和 `bin/python`。样本脚本生成四格式正常、边界、损坏文件共 12 个，实际调用 Docling；输出 `report.json`。端到端生成独立 `.local/v05/e2e-<时间戳>`，实际通过 Fastify API 完成上传、后台解析、取证、事实批准、无变化构建复用、V1/V2 发布、DeepEval 四指标、版本内成员问答、四风格候选、V1 回滚以及缺资产恢复隔离。保存完整 `report.json`、可供管理界面导入的 `build-request.json`、SQLite、资产和备份。

此脚本的公司模型是明确标记的合成 schema 替身，目的是使真正的 DeepEval 算法、judge 适配及报告门禁可离线重复运行，不能证明实际模型质量。没有真实企微消息发送。不要把这些随机测试身份或数据库用于生产。

旧演示仍可 `npm run demo` 后 `WIKIBOT_DEMO=1 npm run dev`；用户名为 `demo-admin` / `demo-member`，独立随机密码在 `.local/demo-access.json` 的 `passwords` 中。不再接受历史共享默认密码。已有明文 credential 启动时迁移为 scrypt；新本地账户由平台操作员通过 `PUT /api/identities/:subject/password` 提供不少于 12 字符的密码和版本号，生产优先使用已有 OIDC。

## 来源到发布

1. 管理员网页“知识维护 → 来源与解析”上传原件并排队。可查看完整/部分/失败状态、警告、定位、结构化产物，下载原件，重试失败任务。
2. 从可核对块“据此提出事实”，明确主体、属性、限定条件、值和事实有效期，填写核对依据。未知有效期保持 unknown，不推测日期。可按页面选择或变更批次批量批准，未发布事实不会进入成员问答。
3. `GET /api/domains/:domain/claims?validAt=<毫秒>&knownAt=<毫秒>` 支持事实时间和记录时间历史查询。更正时 `POST claims` 提供原 `claimId` 和 Claim 的 `expectedVersion`，生成新的 ClaimVersion；限定条件变化创建新 Claim 并填 `relatedClaimId`。旧事实、旧原件和发布快照保留。
4. 同范围重叠互斥值生成冲突，必须用精确版本成员、期望版本和理由裁决；不能“最新写入自动胜出”。`additionalEvidence` 可加入 `{evidenceId,relation:context|contradicts}`，反证生成冲突。裁决可拒绝指定事实版本，或对反证提供完整 `dismissEvidenceIds` 和理由。关联和反证不会删除。
5. 管理员导入构建请求：`{base,mode,mapping,evalPolicy,cases}`；`mapping` 为 pageId 到已批准 ClaimVersion ID 数组，**不是 Evidence ID**。base 为完整 V1/V2 包，mode 为 page/mixed/claims。端到端的 `build-request.json` 是合成实例；迁往另一数据库要替换全部领域内 ID。`POST knowledge-builds` 创建页面、sidecar、完整清单及依赖边；无变化仅复用重新核验过的完整 generation。
6. 提交 generation 中的 bundle，运行全题确定性评测及语义评测，在“评测与发布”查看完整报告，复核精确 descriptor 后激活。可沿用现有 API `submissions`、`releases/:id/evaluations`、`semantic-evaluations`、`review`、`activate`。证据失效、未决冲突或 sidecar 不一致会阻断新候选。

机器人管理员命令 `/知识来源`、`/解析来源 来源ID 版本ID`、`/知识任务 任务ID` 使用相同 API 授权；原件、事实裁决、变更和评测报告转认证网页。普通成员只能经自己的答案/发布版本查已发布证据；不能读管理草稿。分组受众验证和原有企微发送资格检查继续生效。

## 增量与 Code Wiki

复制 `config/repositories.example.json` 到受控配置，设置 `CODE_REPOSITORIES_PATH`。键为 `domain:repoId`，root/ref/白名单仅运维可配；接口不能提供路径、任意 shell 命令或读其他领域仓库。建议配置固定 SHA；即使配置 ref，取证前也会解析为固定 commit。只运行 Git 对象读取，不 checkout、不执行项目脚本、不读取 submodule/symlink/秘密路径/生成目录。

网页读取固定提交后提供文件声明索引和精确片段的待复核 Code Wiki。首版没有自动猜测跨文件业务语义：负责人补充并核对陈述，按 `pageEvidence` 中的 Evidence ID 提出 Claim，再把批准后的 ClaimVersion IDs 放入构建 mapping。随后进入相同评测/复核发布链路。

来源变更后提交 `knowledge-builds/impact`：`{bundle,pages,sourceVersionIds}`。输入本次完整来源清单，缺失旧来源代表删除；返回变更/新增/删除/可信改名、受影响页面/题集和失效证据。实际 Git 测试覆盖连续提交中的插行、改名、删除。行号漂移不偷偷改旧定位；重新创建固定版本 Evidence。失效状态只影响新候选，历史发布内快照保持可追溯。

数据库是授权、批准、任务、冲突和候选状态的权威；sidecar 是带哈希的导出投影。不能编辑 sidecar 来批准事实或修复数据库。完整 generation 清单最后写入，业务事务之后才引用它；中断留下的无引用目录是孤立产物，不会成为有效发布。资产无自动 GC，勿在备份进行时手工删除。

## 评测校准与失败处理

四项指标为真实 DeepEval Faithfulness、AnswerRelevancy、必要事实 GEval、禁止结论 GEval。保留协议/权限/引用/必需事实 ID 等确定性检查。每份报告绑定候选、descriptorHash、答案 modelEpoch、judge profile 与 epoch、题集/策略、每题实际输出/上下文/确定性轮次、任务 token 和截止时间。重跑答案、缺题、指标失败、超时、过期、撤权或版本变动不能沿用旧报告。

初始 `evalPolicy.mode=shadow`：必须完整执行并导入四项结果，低分只供观察；确定性规则和人工复核仍阻断。不得把默认 8000/10000 当作已验证阈值。业务专家先积累与目标题集/judge 一致的正反例报告；`POST evaluation-calibrations` 提交 `{id,policy,reason,samples:[{runId,caseId,humanPass,rationale}]}`，至少四条不同报告/题目组合，含正例和反例，阈值判定须与人工标签一致。正式采用新版本 blocking 策略，绑定该 calibrationId。变更题集（包括风格克隆）或 judge 后重新校准；接口不会暗中降回 shadow。

网页可查看报告；需要详细人工校准时使用上述管理 API。报告 raw pass 字段不是授权凭证，服务端重新检查绑定。真实业务样本的正反例覆盖、阈值效用和 judge 稳定性仍需专家验收。

## 数据迁移、备份与恢复

1. 停止旧服务，备份现有 SQLite（包括 WAL 一致性，用原备份工具或 SQLite backup API），记录旧代码提交及 `PRAGMA user_version`。不要只复制运行中 `.sqlite` 主文件。
2. 部署 v0.5 代码和锁定环境，指定原数据库与独立资产目录。启动自动在原 Store 连接中事务迁移到 user_version=4，增加知识专表和索引；旧业务数据和 V1 JSON/哈希不改写。迁移可重入；未来未知版本拒绝启动。
3. 跑 V1 旧包读取/发布回归，再接入 V2。不要把数据库版本号手工改回 3。业务回滚通过退休版本的 rollback-candidate，重新评测、复核、激活；软件回滚必须恢复迁移前完整备份及兼容代码。
4. v0.5 一致备份（目标目录必须不存在）：

```sh
npm run knowledge:backup -- backup .local/wikibot.sqlite .local/knowledge-assets .local/backups/v05-001
npm run knowledge:backup -- verify .local/backups/v05-001/database.sqlite .local/backups/v05-001/assets
```

先 SQLite backup，再复制不可变资产，核验原件、解析清单、已发布/退休 generation；最后写 `complete.json`。只有完整验证的备份可恢复。可以在线备份，但单写入实例和不删除不可变文件是前提；运维维护窗口更易控制。

5. 将数据库和整组 assets 恢复到新目录，以 `RECOVERY_MODE=1` 启动；接入原有独立可信恢复服务 `RECOVERY_PROOF_URL/ISSUER/JWKS_URL`，平台操作员调用 `POST /api/operations/recover/:domain`。系统核验发布工件及当前可信权限/模型信息，撤销旧 token、隔离旧 worker、取消不确定执行。仅有备份中的“以前通过”不构成恢复批准。缺 generation/原件时保持维护，补齐对应哈希资产后重新验证，不能跳过检查。

## 故障处置

| 状态/错误 | 处理 |
|---|---|
| partial | 下载原件核对警告和定位；只为已人工核对块创建证据，不把部分解析当完整 |
| `PARSER_TIMEOUT` / 资源超限 | 检查文件/profile和进程内存；调整受控 profile 会改变哈希并创建新工作；不得直接改任务成功状态 |
| `EXECUTION_UNKNOWN` / `JOB_FENCED` | 旧尝试失去资格；管理员按当前 version 重试。已完成完整清单在租约有效期内可由重启 worker 校验导入 |
| `ARTIFACT_MISMATCH` / `GENERATION_INCOMPLETE` | 恢复精确原资产或重建新 generation；孤立半成品不激活 |
| `EVIDENCE_PROJECTION_MISMATCH` / 冲突 | 重新取证、核对事实和影响范围，重建候选 |
| 语义缺题/超时/过期/judge变更 | 查看每题指标和失败码，修复配置后重新跑完整套题；结果不手工改 pass |
| `EVALUATION_INPUT_STALE` | 确定性答案已重跑，重新执行绑定当前输出的 DeepEval |
| 模型协议/引用失败 | 答案失败或知识缺口，不伪造第一命中页面引用；原始预览不作为正式企微回复 |

正式块的校验和持久化早于交付；`firstValidatedAt`、`generationCompletedAt` 和 `deliveryCompletedAt` 分开记录。当前 Pi 返回模型身份和停止原因在流结束时，因此 V2 正式块暂在整次生成完成且身份核验后提交，不能据预览声称首块延迟 SLO 已达标。

## 生产验收仍需提供

公司答案模型/judge 的真实 endpoint 与资格记录、脱敏业务样本及负责人、实际 OCR 权重（如启用）、受控只读仓库范围、独立恢复权威服务、企微 Bot/成员/群受众映射和回执环境。运行真实题集与专家校准、撤权/故障演练、Windows或Linux目标主机压测，分别记录首正式块、生成、交付、质量和成本。技术合成测试不能替代 M5 业务/运维签字。
