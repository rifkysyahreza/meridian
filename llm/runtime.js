import { createOpenAICompatibleRuntime } from "./openai-compatible.js";
import { createOpenClawCodexRuntime, validateOpenClawRuntimeConfig, preflightOpenClawRuntime } from "./openclaw-codex.js";

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

function resolveMode(mode) {
  switch ((mode || "").toLowerCase()) {
    case "":
    case "openai-chat":
    case "openai-compatible":
      return "openai-chat";
    case "openclaw":
    case "openclaw-codex":
      return "openclaw-codex";
    default:
      throw new Error(`Unsupported LLM runtime: ${mode}`);
  }
}

export async function preflightRuntime(options = {}) {
  const mode = resolveMode(options.mode || process.env.LLM_RUNTIME || "openai-chat");
  if (mode === "openclaw-codex") {
    validateOpenClawRuntimeConfig(options);
    return await preflightOpenClawRuntime(options);
  }
  return { ok: true, mode };
}

export function createRuntime(options = {}) {
  const mode = resolveMode(options.mode || process.env.LLM_RUNTIME || "openai-chat");

  const provider = mode === "openclaw-codex"
    ? createOpenClawCodexRuntime(options)
    : createOpenAICompatibleRuntime(options);

  return {
    mode,
    provider: provider.name,
    async complete({ model, messages, tools, toolChoice, temperature, maxTokens }) {
      const response = await provider.createChatCompletion({
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
