import type { ModelGateway } from "./adapters/model.js";
export const demoModel: ModelGateway = {
  async generate(request) {
    // Cite the first retrieved page so demo/evaluation stays inside the
    // retrieval whitelist without a real model.
    const pages = (JSON.parse(request.prompt).pages ?? []) as {
      id: string;
    }[];
    return {
      text: JSON.stringify({
        text: "这是本地演示使用的合成内容，仅供联调，不代表真实业务知识。",
        citations: pages.slice(0, 1).map((p) => p.id),
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
