# 模型传输层换装 pi-ai

2026-09-26；基线 `75c6dc026fe8c2f91e5ff329cc2fce6615f5b48b`。用户指令确认：引入 Pi 框架，范围仅模型传输层；`pi-agent-core` 与设计 4.2 受限工具循环本次不引入。

## 变更

- 依赖：移除直接 `@anthropic-ai/sdk`，新增 `@earendil-works/pi-ai@0.87.1`（精确锁定，与设计文档引用的 commit `ca7460d` 对应的发布版本一致；该包内部自带 Anthropic SDK）。
- `src/adapters/model.ts` 重写为 `PiGateway`：`ModelGateway`/`GenerationRequest`/`GenerationResult` 契约不变，所有消费方（answers、evaluations、demo、测试）零改动。公司端点经 `createProvider` + Anthropic Messages API 适配，`ANTHROPIC_AUTH_TOKEN` 以 Bearer 头注入，`maxRetries: 0`，请求级 `maxTokens`、`AbortSignal` 透传。
- 关键语义保持：stopReason 使用端点原生值（`rawStopReason`），`stop→end_turn`/`length→max_tokens` 仅作后备映射，`explanation.ts` 的 `end_turn` 门禁不变；端点回显不同模型 ID 时如实上报（`responseModel`），`MODEL_ID_CHANGED` 门禁对服务端换模仍然生效；thinking 增量不计入正文；无 `done` 终态仍抛 `MODEL_STREAM_INCOMPLETE`。
- 环境变量名不变（`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`），现有 `.env` 无需修改。`tools/probe.ts` 改用 `PiGateway`，证据记录新增 `transport` 字段标注包版本。

## 验证

- `npm run typecheck`：通过。
- `npm test`：30 通过、0 失败（原 28；移除 1 个旧 AnthropicGateway 契约测试，新增 3 个 PiGateway 契约测试：流式正文不含 thinking、token 计数与 `end_turn` 映射；端点换模 ID 上报与 `max_tokens` 映射；AbortSignal 中止传播）。
- `npm run build`：通过，`dist/src/adapters/model.js` 生成并可解析。

## 真实端点复验

用户提供令牌后经标准输入复跑 `npm run probe`（令牌不落盘、不入证据）。`@earendil-works/pi-ai@0.87.1` 传输下：glm-5.3 返回 "OK."（首字约 2.1 秒、4 输出 token），glm-5.3-flash 返回 "OK"（首字约 2.5 秒、33 输出 token），两者 stopReason 均为端点原生 `end_turn`，输入 token 计数 29；记录见 connectivity.json 最新 attempt（含 `transport` 字段）。

旧传输下 flash 曾在同样 64 token 预算内耗尽且无可用文本（`max_tokens`）；本次同预算正常收尾。差异未做归因，两侧样本各一次，不据此宣称两传输行为等价或 flash 稳定可用。

## 真实 explain() 契约冒烟

同日以一页合成知识（三步流程说明）经生产 `explain()` 路径调用真实 glm-5.3 两次（business/beginner、maxTokens 1200、30 秒信号；合成正文首次进入真实模型，真实 Wiki 正文仍未发送）。两次均通过全部硬校验：输出为严格纯 JSON（无 markdown 包裹，`JSON.parse` 直接成功）、引用 `["guide"]` 落在白名单内、stopReason 为原生 `end_turn`、模型 ID 回显一致，解释内容含风格化表达且未虚构清单。

延迟发现（样本各一次，未做负载与统计口径）：首字 8.3 秒 / 4.1 秒，整答 8.9 秒 / 5.5 秒，输出 631 / 276 token。设计 7.1 的首段模型预算为 1.8 秒、答案期限 10 秒；真实 glm-5.3 首字超预算 2–4 倍，整答逼近期限。推测与端点推理（thinking）token 先于可见文本有关（输入 186 token、输出与可见正文不匹配）。影响：生产答案在 10 秒期限下面临 `DEADLINE_EXCEEDED`/不完整风险，SLO 未验证达标。缓解选项（解释用 flash、请求关闭 thinking、期限与预算策略）属模型/业务取舍，本轮未改动，待真实发布评估时与负责人确认。

## 门禁

模型本身与提示词未变，无需 `/api/models/change`；若后续观察到输出行为差异，按 ADR-0003 走模型变更门禁。
