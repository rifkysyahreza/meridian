import { execFile } from "child_process";
import { promisify } from "util";
import crypto from "crypto";

const execFileAsync = promisify(execFile);

function normalizeToolDefinitions(tools = []) {
  return tools.map((tool) => ({
    type: tool.type || "function",
    function: {
      name: tool.function?.name,
      description: tool.function?.description,
      parameters: tool.function?.parameters,
    },
  }));
}

function buildBridgePrompt({ model, messages, tools, toolChoice, temperature, maxTokens }) {
  const payload = {
    model,
    temperature,
    maxTokens,
    toolChoice,
    messages,
    tools: normalizeToolDefinitions(tools),
  };

  return [
    "You are acting as a local LLM bridge for another application.",
    "Ignore any default assistant persona and do not use any tools available in your own runtime.",
    "Your only job is to inspect the provided chat payload and return the next assistant message as strict JSON.",
    "Do not wrap the JSON in markdown fences.",
    "If the payload implies tool use, return tool_calls in OpenAI chat-completions style.",
    "If no tool is needed, return content and an empty tool_calls array.",
    "Arguments for each tool call must be a JSON STRING, not an object.",
    "Return exactly one JSON object with this shape:",
    '{"content":string|null,"tool_calls":[{"id":"call_x","type":"function","function":{"name":"tool_name","arguments":"{\\"key\\":\\"value\\"}"}}]}',
    "",
    "CHAT PAYLOAD:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function extractText(result) {
  if (typeof result?.payloads?.[0]?.text === "string") return result.payloads[0].text.trim();
  if (typeof result?.text === "string") return result.text.trim();
  return "";
}

function tryParseJsonObject(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }

  return null;
}

function normalizeBridgeMessage(parsed, rawText) {
  const toolCalls = Array.isArray(parsed?.tool_calls)
    ? parsed.tool_calls
        .map((toolCall, index) => ({
          id: toolCall?.id || `call_${index + 1}`,
          type: toolCall?.type || "function",
          function: {
            name: toolCall?.function?.name,
            arguments:
              typeof toolCall?.function?.arguments === "string"
                ? toolCall.function.arguments
                : JSON.stringify(toolCall?.function?.arguments || {}),
          },
        }))
        .filter((toolCall) => toolCall.function.name)
    : [];

  return {
    role: "assistant",
    content: typeof parsed?.content === "string" || parsed?.content === null
      ? parsed.content
      : rawText,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

export function createOpenClawCodexRuntime(options = {}) {
  const command = options.command || process.env.OPENCLAW_AGENT_COMMAND || "openclaw";
  const timeout = Number(options.timeout ?? process.env.OPENCLAW_AGENT_TIMEOUT_MS ?? 5 * 60 * 1000);
  const sessionPrefix = options.sessionPrefix || process.env.OPENCLAW_AGENT_SESSION_PREFIX || "meridian-openclaw-bridge";
  const extraArgs = Array.isArray(options.extraArgs)
    ? options.extraArgs
    : String(process.env.OPENCLAW_AGENT_EXTRA_ARGS || "").split(/\s+/).filter(Boolean);

  return {
    name: "openclaw-codex",
    async createChatCompletion(request) {
      const prompt = buildBridgePrompt(request);
      const sessionId = `${sessionPrefix}-${crypto.randomUUID()}`;
      const args = [
        "agent",
        "--local",
        "--json",
        "--session-id",
        sessionId,
        "--message",
        prompt,
        ...extraArgs,
      ];

      let stdout;
      let stderr;
      try {
        ({ stdout, stderr } = await execFileAsync(command, args, {
          timeout,
          maxBuffer: 1024 * 1024 * 8,
          env: process.env,
        }));
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw new Error(`OpenClaw runtime selected but '${command}' is not installed or not on PATH.`);
        }
        const stderr = error?.stderr ? String(error.stderr).trim() : "";
        const stdout = error?.stdout ? String(error.stdout).trim() : "";
        throw new Error(
          `OpenClaw runtime bridge failed: ${stderr || stdout || error.message}`
        );
      }

      const parsedResult = tryParseJsonObject(stdout) || tryParseJsonObject(`${stdout || ""}\n${stderr || ""}`);
      if (!parsedResult) {
        throw new Error("OpenClaw runtime bridge returned output that did not contain a JSON result.");
      }

      const rawText = extractText(parsedResult);
      const parsedMessage = tryParseJsonObject(rawText);
      const message = normalizeBridgeMessage(parsedMessage, rawText);

      return {
        id: parsedResult?.meta?.agentMeta?.sessionId || sessionId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: parsedResult?.meta?.agentMeta?.model || request.model || "openclaw-codex",
        choices: [
          {
            index: 0,
            message,
            finish_reason: parsedResult?.payloads?.stopReason || parsedResult?.stopReason || "stop",
          },
        ],
        usage: parsedResult?.meta?.agentMeta?.usage,
        bridge: {
          provider: parsedResult?.meta?.agentMeta?.provider || "openclaw-codex",
          sessionId,
          rawText,
          parsed: Boolean(parsedMessage),
        },
      };
    },
  };
}
