import { existsSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const workspace = "/workspace/repo";
const agentDir = process.env.PI_CODING_AGENT_DIR || "/workspace/swarm/pi-config";
const subagentExtensionPath =
  "/workspace/swarm/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts";
const piCliPath = "/usr/local/bin/pi";
// Pi's standard subagent extension re-launches the current CLI script. This
// harness embeds Pi through the SDK, so point that relaunch at the real Pi CLI.
if (existsSync(piCliPath)) process.argv[1] = piCliPath;
const promptPath = requiredEnv("SWARM_PROMPT_FILE");
const modelRef = process.env.SWARM_MODEL_REF || "azure-openai-responses/gpt-5.4";
const generation = positiveInt(process.env.SWARM_GENERATION, 1);
const agentTimeoutMs = positiveInt(process.env.SWARM_AGENT_TIMEOUT_MS, 1_800_000);
const transcriptDir = process.env.SWARM_TRANSCRIPT_DIR;
const resultPath = process.env.SWARM_RESULT_PATH;
const modelRetryMax = 10;
const modelRetryBaseDelayMs = 2_000;
const opaqueRetryMaxDelayMs = 60_000;
const finalizationFraction = 0.85;

normalizeAzureEnv(process.env);
requireProviderConfig(modelRef, process.env);

const runtime = await ModelRuntime.create({ refreshOnCreate: false });
const resolved = resolveCliModel({ cliModel: modelRef, modelRuntime: runtime });
if (resolved.error || !resolved.model) {
  throw new Error(resolved.error || `could not resolve Pi model '${modelRef}'`);
}

const prompt = await readFile(promptPath, "utf8");
const deadline = new AbortController();
let timedOut = false;
const deadlineTimer = setTimeout(() => {
  timedOut = true;
  deadline.abort();
}, agentTimeoutMs);
const hardDeadlineTimer = setTimeout(() => {
  process.stderr.write("Agent did not stop within 30 seconds of its timeout; forcing exit with checkpointed transcripts.\n");
  writeOutcomeSync({ exitCode: 124, stdout: "", stderr: "Hard timeout after graceful abort did not finish.\n" });
  process.exit(124);
}, agentTimeoutMs + 30_000);
let result;
let failure;
try {
  result = await runSession({
    prompt,
    worker: requiredEnv("SWARM_AGENT_ID"),
    signal: deadline.signal,
  });
} catch (error) {
  failure = error;
} finally {
  clearTimeout(deadlineTimer);
  clearTimeout(hardDeadlineTimer);
}
if (failure) {
  await writeOutcome({ exitCode: 1, stdout: "", stderr: failure instanceof Error ? failure.message : String(failure) });
  throw failure;
}
process.stdout.write(result.trim() ? `${result.trim()}\n` : "Pi agent returned no final text.\n");
if (timedOut) {
  process.stderr.write(`Agent reached its ${agentTimeoutMs} ms timeout; transcript export completed.\n`);
  process.exitCode = 124;
}
await writeOutcome({
  exitCode: timedOut ? 124 : 0,
  stdout: result.trim(),
  stderr: timedOut ? `Agent reached its ${agentTimeoutMs} ms timeout.\n` : "",
});
async function runSession({ prompt, worker, signal = undefined }) {
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: true, maxRetries: modelRetryMax, baseDelayMs: modelRetryBaseDelayMs },
  }, { projectTrusted: false });
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    noContextFiles: true,
    additionalExtensionPaths: [subagentExtensionPath],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir,
    model: resolved.model,
    thinkingLevel: resolved.thinkingLevel,
    modelRuntime: runtime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(workspace),
    tools: [
      "read",
      "bash",
      "edit",
      "write",
      "subagent",
      "agents_list",
      "messages_read",
      "message_send",
    ],
  });

  const abort = () => void session.abort().catch(() => undefined);
  signal?.addEventListener("abort", abort, { once: true });
  const checkpointPath = transcriptDir ? join(transcriptDir, `${safeFileName(worker)}.jsonl`) : undefined;
  const checkpoint = () => {
    if (!checkpointPath) return;
    try {
      session.exportToJsonl(checkpointPath);
    } catch (error) {
      process.stderr.write(`Could not checkpoint Pi transcript for ${worker}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
  if (transcriptDir) await mkdir(transcriptDir, { recursive: true });
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_end" || event.type === "agent_end") checkpoint();
  });
  const finalizationTimer = setTimeout(() => {
    if (signal?.aborted) return;
    void session.steer(
      "The execution deadline is approaching. Finish active validation, synthesize your results, upload the required submissions, and return a final response.",
    ).catch((error) => {
      process.stderr.write(`Could not queue finalization reminder: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }, Math.max(1, Math.floor(agentTimeoutMs * finalizationFraction)));

  try {
    let initialPromptPending = true;
    let opaqueRetryAttempt = 0;
    while (true) {
      try {
        if (initialPromptPending) {
          initialPromptPending = false;
          await session.prompt(prompt, { expandPromptTemplates: false });
        } else {
          await session.agent.continue();
        }
        await session.waitForIdle();
      } catch (error) {
        if (!signal?.aborted) throw error;
      }
      if (signal?.aborted) break;

      const final = [...session.messages].reverse().find((message) => message?.role === "assistant");
      if (!isOpaqueZeroTokenFailure(final) || opaqueRetryAttempt >= modelRetryMax) break;

      opaqueRetryAttempt += 1;
      const delayMs = cappedRetryDelay(opaqueRetryAttempt);
      process.stderr.write(`${JSON.stringify({
        event: "opaque_model_retry",
        worker,
        generation,
        model: modelRef,
        attempt: opaqueRetryAttempt,
        maxRetries: modelRetryMax,
        delayMs,
        stopReason: final.stopReason,
        errorMessage: final.errorMessage,
        usage: final.usage,
      })}\n`);
      checkpoint();
      if (!await abortableDelay(delayMs, signal)) break;
      rewindOpaqueFailure(session, final);
    }

    const result = session.getLastAssistantText() || "";
    const final = [...session.messages].reverse().find((message) => message?.role === "assistant");
    if (!signal?.aborted && final?.stopReason !== "stop") {
      const reason = final?.stopReason ?? "missing assistant response";
      const detail = final?.errorMessage ? `: ${final.errorMessage}` : "";
      throw new Error(`Pi session ended with ${reason}${detail}`);
    }
    if (!signal?.aborted && !result.trim()) throw new Error("Pi session ended without final text");
    return result;
  } finally {
    clearTimeout(finalizationTimer);
    unsubscribe();
    signal?.removeEventListener("abort", abort);
    checkpoint();
    session.dispose();
  }
}

function isOpaqueZeroTokenFailure(message) {
  if (message?.role !== "assistant" || message.stopReason !== "error") return false;
  if (!/unknown error|no error details/i.test(message.errorMessage ?? "")) return false;
  const usage = message.usage;
  if (!usage) return true;
  return ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]
    .every((name) => Number(usage[name] ?? 0) === 0);
}

function cappedRetryDelay(attempt) {
  const exponential = Math.min(opaqueRetryMaxDelayMs, modelRetryBaseDelayMs * (2 ** (attempt - 1)));
  const jitter = 0.8 + (Math.random() * 0.4);
  return Math.max(1, Math.min(opaqueRetryMaxDelayMs, Math.round(exponential * jitter)));
}

function rewindOpaqueFailure(session, failure) {
  const messages = session.agent.state.messages;
  if (messages.at(-1) !== failure) {
    throw new Error("cannot retry opaque provider failure because the session tail changed");
  }
  session.agent.state.messages = messages.slice(0, -1);
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolveDelay) => {
    if (signal?.aborted) {
      resolveDelay(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolveDelay(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay(true);
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function normalizeAzureEnv(env) {
  if (!env.AZURE_OPENAI_BASE_URL && env.AZURE_OPENAI_ENDPOINT) {
    env.AZURE_OPENAI_BASE_URL = env.AZURE_OPENAI_ENDPOINT;
  }
  if (!env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_KEY) {
    env.AZURE_OPENAI_API_KEY = env.AZURE_OPENAI_KEY;
  }
}

function requireProviderConfig(ref, env) {
  if (!ref.startsWith("azure-openai-responses/")) return;
  if (!env.AZURE_OPENAI_API_KEY) {
    throw new Error("Azure Pi agents need AZURE_OPENAI_API_KEY (AZURE_OPENAI_KEY is also accepted)");
  }
  if (!env.AZURE_OPENAI_BASE_URL) {
    throw new Error("Azure Pi agents need AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_BASE_URL");
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function positiveInt(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("SWARM_AGENT_TIMEOUT_MS must be a positive integer");
  return parsed;
}

function safeFileName(value) {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, "_");
}

async function writeOutcome(value) {
  if (!resultPath) return;
  await writeFile(resultPath, `${JSON.stringify(value)}\n`, "utf8");
}

function writeOutcomeSync(value) {
  if (!resultPath) return;
  try {
    writeFileSync(resultPath, `${JSON.stringify(value)}\n`, "utf8");
  } catch {
    // The checkpointed transcript remains the final fallback.
  }
}
