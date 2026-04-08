import { preflightRuntime } from "../llm/runtime.js";

async function main() {
  const mode = process.env.LLM_RUNTIME || "openai-chat";
  console.log(`=== Meridian runtime smoke (${mode}) ===`);
  const result = await preflightRuntime({ mode });
  console.log(JSON.stringify({ ok: true, mode, result }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
