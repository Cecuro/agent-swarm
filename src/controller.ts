import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentRecord,
  SandboxBackend,
  SandboxHandle,
  SwarmRecord,
} from "./types.js";
import { StateStore } from "./state-store.js";

const PI_AGENT_PATH = "/workspace/swarm/pi-agent.mjs";
const COORDINATION_PATH = "/workspace/swarm/coordination.mjs";
const PI_PACKAGE_PATH = "/workspace/swarm/package.json";
const PI_CONFIG_DIR = "/workspace/swarm/pi-config";
const PI_APPEND_SYSTEM_PATH = `${PI_CONFIG_DIR}/APPEND_SYSTEM.md`;
const PI_COORDINATION_EXTENSION_PATH = `${PI_CONFIG_DIR}/extensions/coordination.js`;
const PROMPT_PATH = "/workspace/swarm/PROMPT.md";
const TEMPLATE_MARKER_PATH = "/workspace/swarm/.agent-swarm-template-v1";
const PI_VERSION = "0.84.4";
const AGENT_CLEANUP_GRACE_MS = 60_000;
const auditServerSource = readFileSync(
  fileURLToPath(new URL("../runtime/audit-server.mjs", import.meta.url)),
  "utf8",
);
const piAgentSource = readFileSync(
  fileURLToPath(new URL("../runtime/pi-agent.mjs", import.meta.url)),
  "utf8",
);
const coordinationSource = readFileSync(
  fileURLToPath(new URL("../runtime/coordination.mjs", import.meta.url)),
  "utf8",
);
const piCoordinationExtensionSource = readFileSync(
  fileURLToPath(
    new URL(
      "../runtime/pi-config/extensions/coordination.js",
      import.meta.url,
    ),
  ),
  "utf8",
);
const piAppendSystemSource = readFileSync(
  fileURLToPath(
    new URL("../runtime/pi-config/APPEND_SYSTEM.md", import.meta.url),
  ),
  "utf8",
);
const piAgentConfigSources = ["scout", "planner", "reviewer", "worker"].map(
  (name) => ({
    path: `${PI_CONFIG_DIR}/agents/${name}.md`,
    source: readFileSync(
      fileURLToPath(
        new URL(`../runtime/pi-config/agents/${name}.md`, import.meta.url),
      ),
      "utf8",
    ),
  }),
);
const piPackage =
  JSON.stringify(
    {
      private: true,
      type: "module",
      dependencies: {
        "@earendil-works/pi-coding-agent": PI_VERSION,
        typebox: "1.3.7",
      },
    },
    null,
    2,
  ) + "\n";

export class SwarmController {
  constructor(
    private readonly state: StateStore,
    private readonly backend: SandboxBackend,
  ) {}

  async create(input: {
    goal: string;
    repoUrl?: string;
    contextDir?: string | null;
    agents: number;
    modelRef?: string;
    maxConcurrency?: number;
    agentImage?: string;
    passedEnvNames: string[];
    timeoutMs: number;
  }): Promise<SwarmRecord> {
    let swarm = this.state.createSwarm({
      id: `swarm-${randomUUID().slice(0, 8)}`,
      goal: input.goal,
      repoUrl: input.repoUrl ?? null,
      contextDir: input.contextDir ?? null,
      agentImage: input.agentImage ?? "agent-swarm-agent:local",
      modelRef: input.modelRef ?? "azure-openai-responses/gpt-5.4",
      maxConcurrency: input.maxConcurrency ?? input.agents,
      timeoutMs: input.timeoutMs,
      bucketName: "",
      bucketAccessKey: "",
      bucketSecretKey: "",
      passedEnvNames: input.passedEnvNames,
    });
    const bucketName = swarm.id;
    const accessKey = `swarm${randomUUID().replaceAll("-", "").slice(0, 14)}`;
    const secretKey = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
    this.state.setSwarmBucketCredentials(swarm.id, {
      bucketName,
      accessKey,
      secretKey,
    });
    swarm = {
      ...swarm,
      bucketName,
      bucketAccessKey: accessKey,
      bucketSecretKey: secretKey,
    };
    const bucket = await this.backend.provisionBucket({
      swarmId: swarm.id,
      bucketName,
      accessKey,
      secretKey,
      clientImage: swarm.agentImage,
      auditServerSource,
    });
    this.state.setSwarmBucket(swarm.id, bucket);
    swarm = {
      ...swarm,
      bucketContainerId: bucket.bucketContainerId,
      auditContainerId: bucket.auditContainerId,
      bucketEndpoint: bucket.endpoint,
    };
    try {
      await this.addAgents(swarm.id, input.agents, input.timeoutMs);
    } catch (error) {
      await this.destroyBucketContainers(swarm).catch(() => undefined);
      throw error;
    }
    return swarm;
  }

  async addAgents(
    swarmId: string,
    count: number,
    timeoutMs?: number,
  ): Promise<AgentRecord[]> {
    const swarm = this.requireSwarm(swarmId);
    const effectiveTimeoutMs = timeoutMs ?? swarm.timeoutMs;
    const firstOrdinal = this.state.nextAgentOrdinal(swarmId);
    const created: AgentRecord[] = [];
    const handles: SandboxHandle[] = [];
    const results = new Array<AgentRecord>(count);
    let next = 0;
    let failure: unknown;
    try {
      const workers = Array.from(
        { length: Math.min(swarm.maxConcurrency, count) },
        async () => {
          while (!failure) {
            const index = next++;
            if (index >= count) return;
            try {
              const ordinal = firstOrdinal + index;
              const id = `${swarm.id}:agent-${ordinal}`;
              const sandbox = await this.backend.create({
                image: swarm.agentImage,
                timeoutMs: effectiveTimeoutMs,
                env: {},
                metadata: {
                  project: "agent-swarm",
                  swarm: swarm.id,
                  agent: id,
                },
              });
              handles.push(sandbox);
              await this.prepareSandbox(sandbox, swarm);
              const agent = this.state.addAgent({
                id,
                swarmId,
                ordinal,
                containerId: sandbox.id,
              });
              await sandbox.pause();
              this.state.setAgentState(id, "paused");
              const paused = { ...agent, status: "paused" as const };
              created.push(paused);
              results[index] = paused;
            } catch (error) {
              failure ??= error;
            }
          }
        },
      );
      await Promise.all(workers);
      if (failure) throw failure;
      return results;
    } catch (error) {
      const cleanup = new Map(
        await Promise.all(
          handles.map(async (sandbox) => {
            try {
              await sandbox.kill();
              return [sandbox.id, true] as const;
            } catch {
              return [sandbox.id, false] as const;
            }
          }),
        ),
      );
      for (const agent of created) {
        this.state.setAgentState(
          agent.id,
          cleanup.get(agent.containerId) ? "killed" : "failed",
        );
      }
      throw error;
    }
  }

  async run(
    swarmId: string,
    rounds: number,
    timeoutMs?: number,
    overrides: { maxConcurrency?: number } = {},
  ): Promise<void> {
    const stored = this.requireSwarm(swarmId);
    const effectiveTimeoutMs = timeoutMs ?? stored.timeoutMs;
    const sandboxLifetimeMs = effectiveTimeoutMs + 2 * AGENT_CLEANUP_GRACE_MS;
    const swarm: SwarmRecord = {
      ...stored,
      maxConcurrency: overrides.maxConcurrency ?? stored.maxConcurrency,
    };
    const agents = this.state
      .listAgents(swarmId)
      .filter((agent) => agent.status !== "killed");
    if (agents.length === 0) throw new Error("swarm has no live agents");
    if (!Number.isInteger(swarm.maxConcurrency) || swarm.maxConcurrency < 1) {
      throw new Error("max concurrency must be a positive integer");
    }

    for (let round = 0; round < rounds; round += 1) {
      const results = await mapConcurrent(
        agents,
        swarm.maxConcurrency,
        async (agent) => {
          let sandbox: SandboxHandle | undefined;
          try {
            sandbox = await retry(
              () =>
                this.backend.connect(agent.containerId, {
                  timeoutMs: sandboxLifetimeMs,
                }),
              3,
              (error, attempt, attempts) => {
                process.stderr.write(
                  `  warning: reconnect ${attempt}/${attempts} failed for ${agent.id}; retrying: ${errorMessage(error)}\n`,
                );
              },
            );
            await this.refreshRuntime(sandbox, swarm);
            agent.generation += 1;
            return await this.runAgent(
              swarm,
              agent,
              sandbox,
              agent.generation,
              effectiveTimeoutMs,
            );
          } catch (error) {
            agent.status = "failed";
            this.state.setAgentState(agent.id, "failed");
            process.stderr.write(
              `${agent.id}: ${error instanceof Error ? error.message : String(error)}\n`,
            );
            return false;
          } finally {
            if (sandbox) {
              try {
                await sandbox.pause();
                if (agent.status !== "failed") {
                  agent.status = "paused";
                  this.state.setAgentState(agent.id, "paused");
                }
              } catch {
                agent.status = "failed";
                this.state.setAgentState(agent.id, "failed");
              }
            }
          }
        },
      );
      await this.snapshotBucketAudit(swarm);
      const failures = results.filter((ok) => !ok).length;
      if (failures > 0)
        throw new Error(
          `${failures} agent${failures === 1 ? "" : "s"} failed in this round`,
        );
    }
  }

  async recover(
    swarmId: string,
  ): Promise<
    Array<{ agentId: string; state: "running" | "recovered" | "unrecoverable" }>
  > {
    const swarm = this.requireSwarm(swarmId);
    const candidates = this.state
      .listAgents(swarmId)
      .filter((agent) => agent.status === "running");
    const recovered: Array<{
      agentId: string;
      state: "running" | "recovered" | "unrecoverable";
    }> = [];
    for (const agent of candidates) {
      try {
        const sandbox = await retry(
          () => this.backend.connect(agent.containerId),
          3,
        );
        const pid = await this.readAgentPid(sandbox, agent.generation);
        const processes = await sandbox.listProcesses?.();
        if (
          pid !== undefined &&
          processes?.some((process) => process.pid === pid)
        ) {
          recovered.push({ agentId: agent.id, state: "running" });
          continue;
        }
        const run = this.state.getOpenRun(agent.id, agent.generation);
        if (!run) {
          recovered.push({ agentId: agent.id, state: "unrecoverable" });
          continue;
        }
        const transcriptDir = `/workspace/swarm/transcripts/generation-${agent.generation}`;
        const result = await this.recoveryResult(
          swarm,
          agent,
          run.startedAt,
          sandbox,
          transcriptDir,
        );
        if (!result) {
          recovered.push({ agentId: agent.id, state: "unrecoverable" });
          continue;
        }
        await this.persistArtifacts(
          swarm,
          agent,
          agent.generation,
          run.id,
          result,
          transcriptDir,
          sandbox,
          swarm.timeoutMs,
        );
        this.state.finishRun(run.id, result);
        agent.status = result.exitCode === 0 ? "ready" : "failed";
        this.state.setAgentState(agent.id, agent.status, agent.generation);
        await sandbox.pause();
        if (agent.status === "ready") {
          agent.status = "paused";
          this.state.setAgentState(agent.id, "paused", agent.generation);
        }
        recovered.push({ agentId: agent.id, state: "recovered" });
      } catch (error) {
        process.stderr.write(
          `  warning: recovery failed for ${agent.id}: ${errorMessage(error)}\n`,
        );
        recovered.push({ agentId: agent.id, state: "unrecoverable" });
      }
    }
    await this.snapshotBucketAudit(swarm);
    return recovered;
  }

  async pause(swarmId: string): Promise<void> {
    const swarm = this.requireSwarm(swarmId);
    await this.forEachLiveAgent(swarmId, async (agent, sandbox) => {
      await sandbox.pause();
      this.state.setAgentState(agent.id, "paused");
    });
    await this.snapshotBucketAudit(swarm);
  }

  async destroy(swarmId: string): Promise<void> {
    const swarm = this.requireSwarm(swarmId);
    await this.snapshotBucketAudit(swarm);
    const agents = this.state
      .listAgents(swarmId)
      .filter((agent) => agent.status !== "killed");
    const failures: string[] = [];
    await Promise.all(
      agents.map(async (agent) => {
        try {
          const sandbox = await retry(
            () => this.backend.connect(agent.containerId),
            3,
          );
          await sandbox.kill();
          this.state.setAgentState(agent.id, "killed");
        } catch (error) {
          if (isMissingSandbox(error)) {
            this.state.setAgentState(agent.id, "killed");
            return;
          }
          failures.push(`${agent.id}: ${errorMessage(error)}`);
          this.state.setAgentState(agent.id, "failed");
        }
      }),
    );
    try {
      await this.destroyBucketContainers(swarm);
    } catch (error) {
      if (!isMissingSandbox(error))
        failures.push(`bucket: ${errorMessage(error)}`);
    }
    if (failures.length > 0)
      throw new Error(
        `could not destroy every container:\n${failures.join("\n")}`,
      );
  }

  private async runAgent(
    swarm: SwarmRecord,
    agent: AgentRecord,
    sandbox: SandboxHandle,
    generation: number,
    timeoutMs: number,
  ): Promise<boolean> {
    this.state.setAgentState(agent.id, "running", generation);
    const runId = this.state.startRun(swarm.id, agent.id, generation);
    const transcriptDir = `/workspace/swarm/transcripts/generation-${generation}`;
    const resultPath = `/workspace/swarm/results/generation-${generation}.json`;
    let result;
    try {
      await sandbox.write(
        PROMPT_PATH,
        renderPrompt(swarm, agent.id, generation),
      );
      await sandbox.write(`${transcriptDir}/.keep`, "");
      await sandbox.write("/workspace/swarm/results/.keep", "");
      const env = {
        ...selectedEnv(swarm.passedEnvNames),
        SWARM_ID: swarm.id,
        SWARM_AGENT_ID: agent.id,
        SWARM_WORKER_ID: agent.id,
        SWARM_AGENT_ROSTER: JSON.stringify(
          this.state
            .listAgents(swarm.id)
            .filter((candidate) => candidate.status !== "killed")
            .map((candidate) => ({
              id: candidate.id,
              status: candidate.status,
              generation: candidate.generation,
            })),
        ),
        SWARM_GENERATION: String(generation),
        SWARM_PROMPT_FILE: PROMPT_PATH,
        PI_CODING_AGENT_DIR: PI_CONFIG_DIR,
        SWARM_BUCKET: swarm.bucketName,
        AWS_ENDPOINT_URL: swarm.bucketEndpoint ?? "",
        AWS_ENDPOINT_URL_S3: swarm.bucketEndpoint ?? "",
        AWS_ACCESS_KEY_ID: swarm.bucketAccessKey,
        AWS_SECRET_ACCESS_KEY: swarm.bucketSecretKey,
        AWS_DEFAULT_REGION: "us-east-1",
        AWS_EC2_METADATA_DISABLED: "true",
        SWARM_TRANSCRIPT_DIR: transcriptDir,
        SWARM_RESULT_PATH: resultPath,
        SWARM_MODEL_REF: swarm.modelRef ?? "",
        SWARM_AGENT_TIMEOUT_MS: String(timeoutMs),
      };
      result = await sandbox.run("node /workspace/swarm/pi-agent.mjs", {
        env,
        timeoutMs: timeoutMs + AGENT_CLEANUP_GRACE_MS,
      });
    } catch (error) {
      result = {
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      await this.persistArtifacts(
        swarm,
        agent,
        generation,
        runId,
        result,
        transcriptDir,
        sandbox,
        timeoutMs,
      );
    } catch (error) {
      process.stderr.write(
        `  warning: could not persist artifacts for ${agent.id}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    this.state.finishRun(runId, result);
    this.state.setAgentState(
      agent.id,
      result.exitCode === 0 ? "ready" : "failed",
      generation,
    );
    agent.status = result.exitCode === 0 ? "ready" : "failed";

    process.stdout.write(
      `${agent.id} generation ${generation}: ${result.exitCode === 0 ? "done" : "failed"}\n`,
    );
    if (result.stdout.trim())
      process.stdout.write(indent(result.stdout.trim()) + "\n");
    if (result.stderr.trim())
      process.stderr.write(indent(result.stderr.trim()) + "\n");
    return result.exitCode === 0;
  }

  private async prepareSandbox(
    sandbox: SandboxHandle,
    swarm: SwarmRecord,
  ): Promise<void> {
    try {
      if (!swarm.repoUrl) throw new Error("swarm has no repository URL");
      const result = await sandbox.cloneRepo(swarm.repoUrl, "/workspace/repo");
      if (result.exitCode !== 0)
        throw new Error(`git clone failed: ${result.stderr || result.stdout}`);
    } catch (error) {
      throw new Error(
        `workspace setup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      if (swarm.contextDir) await this.copyContext(sandbox, swarm.contextDir);
      await retry(() => sandbox.write(PI_AGENT_PATH, piAgentSource));
      await retry(() => sandbox.write(COORDINATION_PATH, coordinationSource));
      await retry(() => sandbox.write(PI_PACKAGE_PATH, piPackage));
      await this.writePiConfig(sandbox);
      if (!(await this.hasCompatibleTemplateRuntime(sandbox))) {
        const install = await sandbox.run(
          "npm install --prefix /workspace/swarm --omit=dev --no-audit --no-fund",
          {
            timeoutMs: 300_000,
          },
        );
        if (install.exitCode !== 0)
          throw new Error(install.stderr || install.stdout);
        await retry(() =>
          sandbox.write(
            TEMPLATE_MARKER_PATH,
            `${JSON.stringify({ piVersion: PI_VERSION })}\n`,
          ),
        );
      }
    } catch (error) {
      throw new Error(
        `could not prepare the Pi runtime: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async refreshRuntime(
    sandbox: SandboxHandle,
    swarm: SwarmRecord,
  ): Promise<void> {
    await retry(() => sandbox.write(PI_AGENT_PATH, piAgentSource));
    await retry(() => sandbox.write(COORDINATION_PATH, coordinationSource));
    await this.writePiConfig(sandbox);
  }

  private async copyContext(
    sandbox: SandboxHandle,
    sourceDir: string,
  ): Promise<void> {
    for (const file of contextFiles(sourceDir)) {
      await retry(() =>
        sandbox.write(
          `/workspace/context/${file.destination}`,
          readFileSync(file.source),
        ),
      );
    }
  }

  private async writePiConfig(sandbox: SandboxHandle): Promise<void> {
    await retry(() =>
      sandbox.write(PI_APPEND_SYSTEM_PATH, piAppendSystemSource),
    );
    await Promise.all(
      piAgentConfigSources.map(({ path, source }) =>
        retry(() => sandbox.write(path, source)),
      ),
    );
    await retry(() =>
      sandbox.write(
        PI_COORDINATION_EXTENSION_PATH,
        piCoordinationExtensionSource,
      ),
    );
  }

  private async hasCompatibleTemplateRuntime(
    sandbox: SandboxHandle,
  ): Promise<boolean> {
    try {
      const marker = JSON.parse(await sandbox.read(TEMPLATE_MARKER_PATH)) as {
        piVersion?: string;
      };
      const installed = JSON.parse(
        await sandbox.read(
          "/workspace/swarm/node_modules/@earendil-works/pi-coding-agent/package.json",
        ),
      ) as { version?: string };
      return (
        marker.piVersion === PI_VERSION && installed.version === PI_VERSION
      );
    } catch {
      return false;
    }
  }

  private async persistArtifacts(
    swarm: SwarmRecord,
    agent: AgentRecord,
    generation: number,
    runId: string,
    result: { exitCode: number; stdout: string; stderr: string },
    transcriptDir: string,
    sandbox: SandboxHandle,
    timeoutMs: number,
  ): Promise<void> {
    const dir = join(
      this.state.dataDir,
      "artifacts",
      swarm.id,
      `agent-${agent.ordinal}`,
      `generation-${generation}`,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stdout.log"), result.stdout, "utf8");
    writeFileSync(join(dir, "stderr.log"), result.stderr, "utf8");
    writeFileSync(
      join(dir, "run.json"),
      `${JSON.stringify(
        {
          runId,
          swarmId: swarm.id,
          agentId: agent.id,
          generation,
          model: swarm.modelRef,
          timeoutMs,
          maxConcurrency: swarm.maxConcurrency,
          bucket: swarm.bucketName,
          exitCode: result.exitCode,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    let entries: Array<{ name: string; isFile: boolean }> = [];
    try {
      entries = await sandbox.list(transcriptDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
      const name = basename(entry.name).replaceAll(/[^A-Za-z0-9._-]/g, "_");
      writeFileSync(
        join(dir, name),
        await sandbox.read(`${transcriptDir}/${entry.name}`),
        "utf8",
      );
    }
  }

  private async recoveryResult(
    swarm: SwarmRecord,
    agent: AgentRecord,
    startedAt: string,
    sandbox: SandboxHandle,
    transcriptDir: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string } | undefined> {
    try {
      const stored = JSON.parse(
        await sandbox.read(
          `/workspace/swarm/results/generation-${agent.generation}.json`,
        ),
      ) as {
        exitCode?: number;
        stdout?: string;
        stderr?: string;
      };
      if (Number.isInteger(stored.exitCode)) {
        return {
          exitCode: stored.exitCode!,
          stdout: stored.stdout ?? "",
          stderr: stored.stderr ?? "",
        };
      }
    } catch {
      // Older runs do not have an outcome file; fall back to their final Pi transcript.
    }
    try {
      const mainName = `${safeFileName(agent.id)}.jsonl`;
      const transcript = await sandbox.read(`${transcriptDir}/${mainName}`);
      const messages = transcript
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              type?: string;
              message?: {
                role?: string;
                stopReason?: string;
                content?: Array<{ type?: string; text?: string }>;
              };
            },
        );
      const final = messages.findLast(
        (entry) =>
          entry.type === "message" &&
          entry.message?.role === "assistant" &&
          entry.message.stopReason === "stop",
      );
      if (final) {
        const stdout = (final.message?.content ?? [])
          .filter((content) => content.type === "text")
          .map((content) => content.text ?? "")
          .join("");
        return {
          exitCode: 0,
          stdout,
          stderr: "Recovered after the host controller disconnected.\n",
        };
      }
    } catch {
      // A missing or incomplete transcript is handled as a timeout below when its deadline has passed.
    }
    if (Date.now() - Date.parse(startedAt) >= swarm.timeoutMs) {
      return {
        exitCode: 124,
        stdout: "",
        stderr:
          "Agent process ended without a final result after its deadline.\n",
      };
    }
    return undefined;
  }

  private async readAgentPid(
    sandbox: SandboxHandle,
    generation: number,
  ): Promise<number | undefined> {
    try {
      const value = Number(
        (
          await sandbox.read(
            `/workspace/swarm/results/generation-${generation}.json.pid`,
          )
        ).trim(),
      );
      return Number.isInteger(value) && value > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async snapshotBucketAudit(swarm: SwarmRecord): Promise<void> {
    if (!swarm.auditContainerId) return;
    try {
      const audit = await this.backend.connect(swarm.auditContainerId);
      const data = await audit.read("/workspace/swarm/audit/audit.jsonl");
      const dir = join(this.state.dataDir, "artifacts", swarm.id, "bucket");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "audit.jsonl"), data, "utf8");
    } catch (error) {
      process.stderr.write(
        `  warning: could not snapshot bucket audit: ${errorMessage(error)}\n`,
      );
    }
  }

  private async destroyBucketContainers(swarm: SwarmRecord): Promise<void> {
    const failures: string[] = [];
    if (swarm.bucketContainerId) {
      try {
        const bucket = await retry(
          () => this.backend.connect(swarm.bucketContainerId!),
          3,
        );
        await bucket.kill();
      } catch (error) {
        if (!isMissingSandbox(error))
          failures.push(`${swarm.bucketContainerId}: ${errorMessage(error)}`);
      }
    }
    await delay(250);
    await this.snapshotBucketAudit(swarm);
    if (swarm.auditContainerId) {
      try {
        const audit = await retry(
          () => this.backend.connect(swarm.auditContainerId!),
          3,
        );
        await audit.kill();
      } catch (error) {
        if (!isMissingSandbox(error))
          failures.push(`${swarm.auditContainerId}: ${errorMessage(error)}`);
      }
    }
    if (failures.length > 0) throw new Error(failures.join("\n"));
  }

  private requireSwarm(id: string): SwarmRecord {
    const swarm = this.state.getSwarm(id);
    if (!swarm) throw new Error(`unknown swarm '${id}'`);
    return swarm;
  }

  private async forEachLiveAgent(
    swarmId: string,
    fn: (agent: AgentRecord, sandbox: SandboxHandle) => Promise<void>,
  ): Promise<void> {
    this.requireSwarm(swarmId);
    const agents = this.state
      .listAgents(swarmId)
      .filter((agent) => agent.status !== "killed");
    await Promise.all(
      agents.map(async (agent) =>
        fn(agent, await this.backend.connect(agent.containerId)),
      ),
    );
  }
}

function renderPrompt(
  swarm: SwarmRecord,
  agentId: string,
  generation: number,
): string {
  return `# Task

You are ${agentId}, generation ${generation}.

You need to perform a task given below.

Other agents are independently working on the same task. They can read and write the same shared S3-compatible bucket at s3://${swarm.bucketName}.

Use agents_list to see the other workers. Read messages before choosing work, announce the bounded area you are investigating, share useful discoveries and ruled-out paths, and check messages again before reporting. message_send broadcasts when to is omitted and can address one or more agent IDs when to is provided.

Investigate the target for issues relevant to the task. There may be no qualifying finding. Test competing hypotheses and keep the evidence standard high; do not report unsupported findings.

The shared submissions folder is already bootstrapped at s3://${swarm.bucketName}/submissions/. Read it before reporting. Submit each finding to s3://${swarm.bucketName}/submissions/submission-XX/ where XX is a number. Make sure to communicate and coordinate with the other agents to work most effective

${swarm.contextDir ? "Additional shared reference material is available at /workspace/context/.\n" : ""}

Complete the task by recording evidence-based results in the shared submissions folder and summarizing what you checked.

${swarm.goal.trim()}
`;
}

function contextFiles(
  sourceDir: string,
): Array<{ source: string; destination: string }> {
  const files: Array<{ source: string; destination: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(source);
      } else if (entry.isFile()) {
        files.push({ source, destination: relative(sourceDir, source) });
      } else {
        throw new Error(`context contains a non-file entry: ${source}`);
      }
    }
  };
  visit(sourceDir);
  return files;
}

function selectedEnv(names: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (!value)
      throw new Error(`required environment variable '${name}' is not set`);
    values[name] = value;
  }
  return values;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function safeFileName(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, "_");
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("max concurrency must be a positive integer");
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await fn(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  onRetry?: (error: unknown, failedAttempt: number, attempts: number) => void,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        onRetry?.(error, attempt, attempts);
        await delay(attempt * 500);
      }
    }
  }
  throw lastError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingSandbox(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("no such container") ||
    message.includes("container not found")
  );
}
