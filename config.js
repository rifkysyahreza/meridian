import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

function readUserConfig() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
  } catch (error) {
    console.error(`[CONFIG_ERROR] Failed to parse user-config.json: ${error.message}`);
    return {};
  }
}

const u = readUserConfig();

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl) process.env.RPC_URL ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmRuntime) process.env.LLM_RUNTIME ||= u.llmRuntime;
if (u.llmModel) process.env.LLM_MODEL ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL ||= u.llmBaseUrl;
if (u.llmApiKey) process.env.LLM_API_KEY ||= u.llmApiKey;
if (u.openClawAgentCommand) process.env.OPENCLAW_AGENT_COMMAND ||= u.openClawAgentCommand;
if (u.openClawAgentTimeoutMs) process.env.OPENCLAW_AGENT_TIMEOUT_MS ||= String(u.openClawAgentTimeoutMs);
if (u.openClawAgentSessionPrefix) process.env.OPENCLAW_AGENT_SESSION_PREFIX ||= u.openClawAgentSessionPrefix;
if (u.openClawAgentExtraArgs) process.env.OPENCLAW_AGENT_EXTRA_ARGS ||= u.openClawAgentExtraArgs;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions: u.maxPositions ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl: u.minTvl ?? 10_000,
    maxTvl: u.maxTvl ?? 150_000,
    minVolume: u.minVolume ?? 500,
    minOrganic: u.minOrganic ?? 60,
    minHolders: u.minHolders ?? 500,
    minMcap: u.minMcap ?? 150_000,
    maxMcap: u.maxMcap ?? 10_000_000,
    minBinStep: u.minBinStep ?? 80,
    maxBinStep: u.maxBinStep ?? 125,
    timeframe: u.timeframe ?? "5m",
    category: u.category ?? "trending",
    minTokenFeesSol: u.minTokenFeesSol ?? 30,
    maxBundlePct: u.maxBundlePct ?? 30,
    maxBotHoldersPct: u.maxBotHoldersPct ?? 30,
    maxTop10Pct: u.maxTop10Pct ?? 60,
    blockedLaunchpads: u.blockedLaunchpads ?? [],
    minTokenAgeHours: u.minTokenAgeHours ?? null,
    maxTokenAgeHours: u.maxTokenAgeHours ?? null,
    athFilterPct: u.athFilterPct ?? null,
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount: u.minClaimAmount ?? 5,
    autoSwapAfterClaim: u.autoSwapAfterClaim ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours: u.oorCooldownHours ?? 12,
    minVolumeToRebalance: u.minVolumeToRebalance ?? 1000,
    stopLossPct: u.stopLossPct ?? u.emergencyPriceDropPct ?? -50,
    takeProfitFeePct: u.takeProfitFeePct ?? 5,
    minFeePerTvl24h: u.minFeePerTvl24h ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60,
    minSolToOpen: u.minSolToOpen ?? 0.55,
    deployAmountSol: u.deployAmountSol ?? 0.5,
    gasReserve: u.gasReserve ?? 0.2,
    positionSizePct: u.positionSizePct ?? 0.35,
    trailingTakeProfit: u.trailingTakeProfit ?? true,
    trailingTriggerPct: u.trailingTriggerPct ?? 3,
    trailingDropPct: u.trailingDropPct ?? 1.5,
    pnlSanityMaxDiffPct: u.pnlSanityMaxDiffPct ?? 5,
    solMode: u.solMode ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy: u.strategy ?? "bid_ask",
    binsBelow: u.binsBelow ?? 69,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin: u.managementIntervalMin ?? 10,
    screeningIntervalMin: u.screeningIntervalMin ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    runtime: u.llmRuntime ?? process.env.LLM_RUNTIME ?? "openai-chat",
    temperature: u.temperature ?? 0.373,
    maxTokens: u.maxTokens ?? 4096,
    maxSteps: u.maxSteps ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? process.env.OPENCLAW_MODEL ?? "openrouter/healer-alpha",
    screeningModel: u.screeningModel ?? process.env.LLM_MODEL ?? process.env.OPENCLAW_MODEL ?? "openrouter/hunter-alpha",
    generalModel: u.generalModel ?? process.env.LLM_MODEL ?? process.env.OPENCLAW_MODEL ?? "openrouter/healer-alpha",
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL: "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
};

export function computeDeployAmount(walletSol) {
  const reserve = config.management.gasReserve ?? 0.2;
  const pct = config.management.positionSizePct ?? 0.35;
  const floor = config.management.deployAmountSol;
  const ceil = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic = deployable * pct;
  const result = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

export function reloadScreeningThresholds() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return;
  try {
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minOrganic != null) s.minOrganic = fresh.minOrganic;
    if (fresh.minHolders != null) s.minHolders = fresh.minHolders;
    if (fresh.minMcap != null) s.minMcap = fresh.minMcap;
    if (fresh.maxMcap != null) s.maxMcap = fresh.maxMcap;
    if (fresh.minTvl != null) s.minTvl = fresh.minTvl;
    if (fresh.maxTvl != null) s.maxTvl = fresh.maxTvl;
    if (fresh.minVolume != null) s.minVolume = fresh.minVolume;
    if (fresh.minBinStep != null) s.minBinStep = fresh.minBinStep;
    if (fresh.maxBinStep != null) s.maxBinStep = fresh.maxBinStep;
    if (fresh.timeframe != null) s.timeframe = fresh.timeframe;
    if (fresh.category != null) s.category = fresh.category;
    if (fresh.minTokenAgeHours !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct !== undefined) s.athFilterPct = fresh.athFilterPct;
    if (fresh.maxBundlePct != null) s.maxBundlePct = fresh.maxBundlePct;
    if (fresh.maxBotHoldersPct != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
  } catch (error) {
    console.error(`[CONFIG_WARN] Failed to reload screening thresholds: ${error.message}`);
  }
}
