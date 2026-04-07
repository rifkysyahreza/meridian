import OpenAI from "openai";

function normalizeAssistantMessage(message = {}) {
  return {
    role: "assistant",
    content: message.content ?? null,
    toolCalls: Array.isArray(message.tool_calls)
      ? message.tool_calls.map((toolCall) => ({
          id: toolCall.id,
          type: toolCall.type || "function",
          name: toolCall.function?.name,
          arguments: toolCall.function?.arguments ?? "{}",
        }))
      : [],
  };
}

function toProviderMessage(message) {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content ?? null,
      ...(message.toolCalls?.length
        ? {
            tool_calls: message.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: toolCall.type || "function",
              function: {
                name: toolCall.name,
                arguments: toolCall.arguments ?? "{}",
              },
            })),
          }
        : {}),
    };
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

export function createRuntime(options = {}) {
  const mode = options.mode || process.env.LLM_RUNTIME || "openai-chat";

  if (mode !== "openai-chat") {
    throw new Error(`Unsupported LLM runtime: ${mode}`);
  }

  const client = new OpenAI({
    baseURL: options.baseURL || process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
    apiKey: options.apiKey || process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
    timeout: options.timeout ?? 5 * 60 * 1000,
  });

  return {
    mode,
    async complete({ model, messages, tools, toolChoice, temperature, maxTokens }) {
      const response = await client.chat.completions.create({
        model,
        messages: messages.map(toProviderMessage),
        tools,
        tool_choice: toolChoice,
        temperature,
        max_tokens: maxTokens,
      });

      return {
        raw: response,
        message: normalizeAssistantMessage(response.choices?.[0]?.message),
      };
    },
  };
}
