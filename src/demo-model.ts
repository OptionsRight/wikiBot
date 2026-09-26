import type { ModelGateway } from "./adapters/model.js";
export const demoModel: ModelGateway = {
  async generate(request) {
    return {
      text: JSON.stringify({
        text: "这是本地演示使用的合成内容。请先准备材料，再依照选定路径核对；不代表真实业务规范。",
        citations: ["guide"],
      }),
      model: request.model,
      inputTokens: 0,
      outputTokens: 0,
      firstTextMs: 1,
      totalMs: 1,
      stopReason: "end_turn",
    };
  },
};
