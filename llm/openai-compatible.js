import OpenAI from "openai";

export function createOpenAICompatibleRuntime(options = {}) {
  const client = new OpenAI({
    baseURL: options.baseURL || process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
    apiKey: options.apiKey || process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
    timeout: options.timeout ?? 5 * 60 * 1000,
  });

  return {
    name: "openai-compatible",
    async createChatCompletion(request) {
      return client.chat.completions.create(request);
    },
  };
}
