import Anthropic from "@anthropic-ai/sdk";

export interface GenerationRequest {
  model: string;
  system: string;
  prompt: string;
  signal: AbortSignal;
  maxTokens?: number;
}
export interface GenerationResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  firstTextMs: number | null;
  totalMs: number;
  stopReason: string | null;
}
export interface ModelGateway {
  generate(request: GenerationRequest): Promise<GenerationResult>;
}

export class AnthropicGateway implements ModelGateway {
  private client: Anthropic;
  constructor(config: { baseURL: string; token: string }) {
    this.client = new Anthropic({
      baseURL: config.baseURL,
      authToken: config.token,
      apiKey: null,
      maxRetries: 0,
    });
  }
  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const start = performance.now();
    let text = "",
      model = request.model,
      inputTokens = 0,
      outputTokens = 0;
    let firstTextMs: number | null = null,
      stopReason: string | null = null;
    const stream = await this.client.messages.create(
      {
        model: request.model,
        system: request.system,
        messages: [{ role: "user", content: request.prompt }],
        max_tokens: request.maxTokens ?? 1024,
        stream: true,
      },
      { signal: request.signal },
    );
    for await (const event of stream) {
      if (event.type === "message_start") {
        model = event.message.model;
        inputTokens = event.message.usage.input_tokens;
      }
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        if (event.delta.text && firstTextMs === null)
          firstTextMs = performance.now() - start;
        text += event.delta.text;
      }
      if (event.type === "message_delta") {
        outputTokens = event.usage.output_tokens;
        stopReason = event.delta.stop_reason;
      }
    }
    if (!stopReason) throw new Error("MODEL_STREAM_INCOMPLETE");
    return {
      text,
      model,
      inputTokens,
      outputTokens,
      firstTextMs,
      totalMs: performance.now() - start,
      stopReason,
    };
  }
}
