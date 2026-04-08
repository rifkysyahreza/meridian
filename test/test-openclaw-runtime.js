import fs from "fs";
import os from "os";
import path from "path";
import { createOpenClawCodexRuntime } from "../llm/openclaw-codex.js";

async function withFakeBridge(handlerSource, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-openclaw-"));
  const scriptPath = path.join(dir, "fake-openclaw");
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node\n${handlerSource}`);
  fs.chmodSync(scriptPath, 0o755);
  try {
    await fn(scriptPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testParsesNoisyJsonl() {
  await withFakeBridge(`
console.error("bridge starting...");
console.log(JSON.stringify({
  payloads: [
    {
      text: JSON.stringify({
        content: "ok",
        tool_calls: [],
      }),
    },
  ],
  stopReason: "stop",
  meta: { agentMeta: { provider: "fake", model: "fake-model" } },
}));
`, async (scriptPath) => {
    const runtime = createOpenClawCodexRuntime({
      command: scriptPath,
      extraArgs: [],
      timeout: 5000,
      maxRetries: 1,
      sessionPrefix: "test-openclaw",
    });

    const response = await runtime.createChatCompletion({
      model: "fake-model",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });

    if (response.choices?.[0]?.message?.content !== "ok") {
      throw new Error(`Expected parsed content 'ok', got ${JSON.stringify(response.choices?.[0]?.message)}`);
    }
  });
}

async function testEmptyLogicalResultFails() {
  await withFakeBridge(`
console.log(JSON.stringify({
  payloads: [{ text: JSON.stringify({ content: null, tool_calls: [] }) }],
  stopReason: "stop",
  meta: { agentMeta: { provider: "fake", model: "fake-model" } },
}));
`, async (scriptPath) => {
    const runtime = createOpenClawCodexRuntime({
      command: scriptPath,
      extraArgs: [],
      timeout: 5000,
      maxRetries: 1,
      sessionPrefix: "test-openclaw",
    });

    let sawExpectedError = false;
    try {
      await runtime.createChatCompletion({
        model: "fake-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      });
    } catch (error) {
      sawExpectedError = /parsed but empty assistant turn/i.test(error.message);
    }

    if (!sawExpectedError) {
      throw new Error("Expected parsed-but-empty result to fail");
    }
  });
}

async function testAuthErrorMessage() {
  await withFakeBridge(`
console.error("Unauthorized: not logged in to OpenClaw yet");
process.exit(1);
`, async (scriptPath) => {
    const runtime = createOpenClawCodexRuntime({
      command: scriptPath,
      extraArgs: [],
      timeout: 5000,
      maxRetries: 1,
      sessionPrefix: "test-openclaw",
    });

    let sawExpectedError = false;
    try {
      await runtime.createChatCompletion({
        model: "fake-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      });
    } catch (error) {
      sawExpectedError = /authentication failed/i.test(error.message) && /logged in\/paired/i.test(error.message);
    }

    if (!sawExpectedError) {
      throw new Error("Expected auth/pairing guidance error from fake bridge");
    }
  });
}

async function main() {
  console.log("=== Testing OpenClaw bridge runtime ===");
  await testParsesNoisyJsonl();
  console.log("✓ parses noisy JSON output");
  await testEmptyLogicalResultFails();
  console.log("✓ rejects parsed but empty logical result");
  await testAuthErrorMessage();
  console.log("✓ surfaces auth guidance");
  console.log("=== OpenClaw bridge tests passed ===");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
