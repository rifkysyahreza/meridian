import { execFile } from "child_process";
import { promisify } from "util";
import crypto from "crypto";
import fs from "fs";
import { log } from "../logger.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_BUFFER = 1024 * 1024 * 8;
const TRANSIENT_BRIDGE_ERROR = /\b(ECONNRESET|ETIMEDOUT|timeout|timed out|429|502|503|504|529|rate limit|temporar(?:y|ily)|unavailable|network|socket hang up)\b/i;
const AUTH_BRIDGE_ERROR = /\b(auth|login|unauthori[sz]ed|forbidden|api[_ -]?key|token|pairing required|bootstrap token|not logged in|expired)\b/i;
const MALFORMED_BRIDGE_ERROR = /\b(empty stdout|empty stderr|empty output|unexpected end|unterminated|stringify|json|parse|invalid response|malformed|truncated|maxbuffer|max buffer)\b/i;

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

function shellSplit(input = "") {
  const text = String(input || "").trim();
  if (!text) return [];

  const parts = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const char of text) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += "\\";
  if (current) parts.push(current);
  return parts;
}

function collectText(value, acc = []) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) acc.push(trimmed);
    return acc;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectText(item, acc);
    return acc;
  }

  if (value && typeof value === "object") {
    if (typeof value.text === "string") collectText(value.text, acc);
    if (typeof value.content === "string") collectText(value.content, acc);
    if (Array.isArray(value.content)) collectText(value.content, acc);
    if (Array.isArray(value.payloads)) collectText(value.payloads, acc);
    if (Array.isArray(value.messages)) collectText(value.messages, acc);
  }

  return acc;
}

function extractText(result) {
  return collectText(result).join("\n").trim();
}

function findJsonObjectCandidates(text) {
  if (!text) return [];
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaping = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (char === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          candidates.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  return candidates;
}

function tryParseJsonObject(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  const candidates = findJsonObjectCandidates(text);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(candidates[i]);
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

function buildBridgeError(message, context = {}) {
  const error = new Error(message);
  error.bridge = context;
  return error;
}

function classifyBridgeFailure(text) {
  if (AUTH_BRIDGE_ERROR.test(text)) return "auth";
  if (TRANSIENT_BRIDGE_ERROR.test(text)) return "transient";
  if (MALFORMED_BRIDGE_ERROR.test(text)) return "malformed";
  return "fatal";
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function validateSessionPrefix(prefix) {
  const safe = String(prefix || "").trim();
  if (!safe) {
    throw new Error("OPENCLAW_AGENT_SESSION_PREFIX must be a non-empty string.");
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(safe)) {
    throw new Error("OPENCLAW_AGENT_SESSION_PREFIX may only contain letters, numbers, dot, underscore, and dash.");
  }
  return safe;
}

function formatBridgeFailure(baseMessage, details, context = {}) {
  const trimmedDetails = String(details || "").trim();
  const sessionNote = context.sessionId ? ` [session=${context.sessionId}]` : "";
  return `${baseMessage}${sessionNote}${trimmedDetails ? `: ${trimmedDetails}` : ""}`;
}

export function validateOpenClawRuntimeConfig(options = {}) {
  const command = options.command || process.env.OPENCLAW_AGENT_COMMAND || "openclaw";
  const timeout = toPositiveInt(options.timeout ?? process.env.OPENCLAW_AGENT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const sessionPrefix = validateSessionPrefix(
    options.sessionPrefix || process.env.OPENCLAW_AGENT_SESSION_PREFIX || "meridian-openclaw-bridge",
  );
  const maxRetries = Math.max(1, toPositiveInt(options.maxRetries ?? process.env.OPENCLAW_AGENT_MAX_RETRIES, 2));

  const resolved = command.includes("/")
    ? (fs.existsSync(command) ? command : null)
    : (process.env.PATH || "")
        .split(":")
        .map((dir) => dir && `${dir}/${command}`)
        .find((candidate) => candidate && fs.existsSync(candidate));

  if (!resolved) {
    throw new Error(`OpenClaw command '${command}' was not found on PATH.`);
  }

  return { command, timeout, sessionPrefix, maxRetries };
}

export async function preflightOpenClawRuntime(options = {}) {
  const { command, timeout, sessionPrefix } = validateOpenClawRuntimeConfig(options);
  const sessionId = `${sessionPrefix}-preflight-${crypto.randomUUID()}`;
  const args = [
    "agent",
    "--local",
    "--json",
    "--session-id",
    sessionId,
    "--message",
    'Return exactly {"content":"ok","tool_calls":[]} as JSON.',
  ];
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout: Math.min(timeout, 60_000),
    maxBuffer: DEFAULT_MAX_BUFFER,
    env: process.env,
  });
  const parsed = tryParseJsonObject(stdout) || tryParseJsonObject(`${stdout || ""}\n${stderr || ""}`);
  const rawText = extractText(parsed);
  const inner = tryParseJsonObject(rawText);
  const message = normalizeBridgeMessage(inner, rawText);
  const hasUseful =
    (typeof message.content === "string" && message.content.trim().length > 0) ||
    (Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
  if (!parsed || !hasUseful) {
    throw buildBridgeError("OpenClaw preflight returned no usable assistant message.", {
      sessionId,
      stdout: String(stdout || "").slice(0, 500),
      stderr: String(stderr || "").slice(0, 500),
    });
  }
  return { sessionId, message };
}

export function createOpenClawCodexRuntime(options = {}) {
  const validated = validateOpenClawRuntimeConfig(options);
  const command = validated.command;
  const timeout = validated.timeout;
  const sessionPrefix = validated.sessionPrefix;
  const extraArgs = Array.isArray(options.extraArgs)
    ? options.extraArgs
    : shellSplit(process.env.OPENCLAW_AGENT_EXTRA_ARGS || "");
  const maxRetries = validated.maxRetries;

  return {
    name: "openclaw-codex",
    async createChatCompletion(request) {
      const prompt = buildBridgePrompt(request);
      const toolsCount = Array.isArray(request?.tools) ? request.tools.length : 0;
      let lastError = null;

      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
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

        const startedAt = Date.now();
        log("bridge", `OpenClaw request starting (attempt ${attempt}/${maxRetries}, model=${request.model || "openclaw-codex"}, tools=${toolsCount}, session=${sessionId})`);

        let stdout = "";
        let stderr = "";
        try {
          ({ stdout, stderr } = await execFileAsync(command, args, {
            timeout,
            maxBuffer: DEFAULT_MAX_BUFFER,
            env: process.env,
          }));
        } catch (error) {
          if (error?.code === "ENOENT") {
            throw buildBridgeError(
              `OpenClaw runtime selected but '${command}' is not installed or not on PATH.`,
              { code: error.code, sessionId, attempt, command }
            );
          }

          const details = [error?.stderr, error?.stdout, error?.message].filter(Boolean).join("\n").trim();
          const failureType = classifyBridgeFailure(details || `${error?.code || ""} ${error?.signal || ""}`);
          const durationMs = Date.now() - startedAt;
          log(failureType === "auth" ? "bridge_error" : failureType === "transient" ? "bridge_warn" : "bridge_error", `OpenClaw bridge exec failed after ${durationMs}ms (attempt ${attempt}/${maxRetries}, session=${sessionId}): ${details || error.message}`);

          if (failureType === "auth") {
            throw buildBridgeError(
              formatBridgeFailure(
                "OpenClaw runtime bridge authentication failed. Make sure the local OpenClaw runtime is logged in/paired and any required API key or auth flow is complete",
                details,
                { sessionId }
              ),
              { type: failureType, sessionId, attempt, details }
            );
          }

          if ((failureType === "transient" || failureType === "malformed") && attempt < maxRetries) {
            const waitMs = attempt * 1500;
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            continue;
          }

          lastError = buildBridgeError(
            formatBridgeFailure("OpenClaw runtime bridge failed", details, { sessionId }),
            { type: failureType, sessionId, attempt, details }
          );
          break;
        }

        const parsedResult = tryParseJsonObject(stdout) || tryParseJsonObject(`${stdout || ""}\n${stderr || ""}`);
        if (!parsedResult) {
          const combined = `${stdout || ""}\n${stderr || ""}`.trim();
          const failureType = classifyBridgeFailure(combined);
          const durationMs = Date.now() - startedAt;
          log(failureType === "transient" ? "bridge_warn" : "bridge_error", `OpenClaw bridge returned non-JSON output after ${durationMs}ms (attempt ${attempt}/${maxRetries}, session=${sessionId}): ${combined.slice(0, 500) || "<empty>"}`);

          if ((failureType === "transient" || failureType === "malformed") && attempt < maxRetries) {
            const waitMs = attempt * 1500;
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            continue;
          }

          if (failureType === "auth") {
            throw buildBridgeError(
              formatBridgeFailure(
                "OpenClaw runtime returned an authentication/setup error instead of JSON. Verify the local runtime is ready before using bridge mode",
                combined,
                { sessionId }
              ),
              { type: failureType, sessionId, attempt, details: combined }
            );
          }

          lastError = buildBridgeError(
            formatBridgeFailure(
              "OpenClaw runtime bridge returned output that did not contain a JSON result",
              combined || "empty stdout/stderr",
              { sessionId }
            ),
            { type: failureType, sessionId, attempt, details: combined }
          );
          break;
        }

        const rawText = extractText(parsedResult);
        const parsedMessage = tryParseJsonObject(rawText);
        const message = normalizeBridgeMessage(parsedMessage, rawText);
        const hasUsefulMessage =
          (typeof message.content === "string" && message.content.trim().length > 0) ||
          (Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
        const durationMs = Date.now() - startedAt;

        if (!hasUsefulMessage) {
          const details = `Bridge produced no usable assistant content or tool calls. rawText=${String(rawText || "").slice(0, 300) || "<empty>"}`;
          log("bridge_warn", `OpenClaw request produced empty logical result in ${durationMs}ms (attempt ${attempt}/${maxRetries}, session=${sessionId})`);
          if (attempt < maxRetries) {
            const waitMs = attempt * 1500;
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            continue;
          }
          throw buildBridgeError(
            formatBridgeFailure("OpenClaw runtime bridge returned a parsed but empty assistant turn", details, { sessionId }),
            { type: "malformed", sessionId, attempt, details }
          );
        }

        log("bridge", `OpenClaw request completed in ${durationMs}ms (attempt ${attempt}/${maxRetries}, parsed=${Boolean(parsedMessage)}, session=${sessionId})`);

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
            stderr: String(stderr || "").trim() || undefined,
          },
        };
      }

      throw lastError || new Error("OpenClaw runtime bridge failed for an unknown reason.");
    },
  };
}
