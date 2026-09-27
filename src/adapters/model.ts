import {
  createModels,
  createProvider,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";

export interface GenerationRequest {
  model: string;
  system: string;
  prompt: string;
  signal: AbortSignal;
  maxTokens?: number;
  /** Streaming hook: invoked with each raw text delta as it arrives. */
  onText?: (delta: string) => void;
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

const providerId = "company";
// pi-ai stopReason vocabulary mapped to the Anthropic-native values the
// explanation gate compares against; rawStopReason wins when the endpoint
// reports one.
const stopReasons: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
};

export class PiGateway implements ModelGateway {
  private readonly baseURL: string;
  private readonly models = createModels();
  private readonly disableThinking: boolean;
  constructor(config: { baseURL: string; token: string; disableThinking?: boolean }) {
    this.baseURL = config.baseURL;
    this.disableThinking = config.disableThinking ?? false;
    this.models.setProvider(
      createProvider({
        id: providerId,
        name: "Company model gateway",
        auth: {
          apiKey: {
            name: "Company model bearer token",
            resolve: async () => ({
              auth: { headers: { authorization: `Bearer ${config.token}` } },
              source: "ANTHROPIC_AUTH_TOKEN",
            }),
          },
        },
        models: [],
        api: anthropicMessagesApi(),
      }),
    );
  }
  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const start = performance.now();
    let text = "",
      firstTextMs: number | null = null;
    const model: Model<"anthropic-messages"> = {
      id: request.model,
      name: request.model,
      api: "anthropic-messages",
      provider: providerId,
      baseUrl: this.baseURL,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    };
    const stream = this.models.streamSimple(
      model,
      {
        systemPrompt: request.system,
        messages: [
          { role: "user", content: request.prompt, timestamp: Date.now() },
        ],
      },
      {
        signal: request.signal,
        maxRetries: 0,
        maxTokens: request.maxTokens ?? 1024,
        // The company endpoint burns reasoning tokens by default; disabling
        // thinking cuts first-text latency ~2.5x for grounded answers.
        ...(this.disableThinking
          ? {
              onPayload: (payload: unknown) => ({
                ...(payload as object),
                thinking: { type: "disabled" },
              }),
            }
          : {}),
      },
    );
    let final: AssistantMessage | undefined;
    for await (const event of stream) {
      if (event.type === "text_delta") {
        if (firstTextMs === null) firstTextMs = performance.now() - start;
        text += event.delta;
        request.onText?.(event.delta);
      }
      if (event.type === "done") final = event.message;
      if (event.type === "error") {
        if (event.reason === "aborted")
          throw request.signal.reason ?? new Error("MODEL_ABORTED");
        throw new Error(event.error.errorMessage || "MODEL_FAILED");
      }
    }
    if (!final || final.stopReason === "pending")
      throw new Error("MODEL_STREAM_INCOMPLETE");
    return {
      text,
      // responseModel is set only when the endpoint echoes a different id,
      // preserving the MODEL_ID_CHANGED gate against server-side swaps.
      model: final.responseModel ?? final.model,
      inputTokens: final.usage.input,
      outputTokens: final.usage.output,
      firstTextMs,
      totalMs: performance.now() - start,
      stopReason: final.rawStopReason ?? stopReasons[final.stopReason] ?? final.stopReason,
    };
  }
}
