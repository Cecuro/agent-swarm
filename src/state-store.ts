import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { AgentRecord, SwarmRecord } from "./types.js";

type RunRecord = {
  id: string;
  swarmId: string;
  agentId: string;
  generation: number;
  status: "running" | "completed" | "failed";
  exitCode: number | null;
  startedAt: string;
  completedAt: string | null;
};

type SwarmState = {
  version: 1;
  swarm: SwarmRecord;
  agents: AgentRecord[];
  runs: RunRecord[];
};

export class StateStore {
  readonly dataDir: string;
  private readonly states = new Map<string, SwarmState>();
  private readonly agentSwarms = new Map<string, string>();
  private readonly runSwarms = new Map<string, string>();

  private constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    mkdirSync(this.swarmsDir, { recursive: true });
    this.load();
  }

  static open(dataDir: string): StateStore {
    return new StateStore(dataDir);
  }

  close(): void {}

  createSwarm(input: Omit<SwarmRecord, "createdAt" | "modelRef" | "maxConcurrency" | "timeoutMs" | "bucketContainerId" | "auditContainerId" | "bucketEndpoint"> &
    Partial<Pick<SwarmRecord, "modelRef" | "maxConcurrency" | "timeoutMs" | "bucketContainerId" | "auditContainerId" | "bucketEndpoint">>): SwarmRecord {
    if (this.states.has(input.id)) throw new Error(`swarm '${input.id}' already exists`);
    const swarm: SwarmRecord = {
      ...input,
      modelRef: input.modelRef ?? null,
      maxConcurrency: input.maxConcurrency ?? 4,
      timeoutMs: input.timeoutMs ?? 1_800_000,
      bucketContainerId: input.bucketContainerId ?? null,
      auditContainerId: input.auditContainerId ?? null,
      bucketEndpoint: input.bucketEndpoint ?? null,
      createdAt: now(),
    };
    this.states.set(swarm.id, { version: 1, swarm, agents: [], runs: [] });
    this.persist(swarm.id);
    return swarm;
  }

  getSwarm(id: string): SwarmRecord | undefined {
    return this.states.get(id)?.swarm;
  }

  setSwarmBucketCredentials(id: string, credentials: { bucketName: string; accessKey: string; secretKey: string }): void {
    const state = this.requireState(id);
    state.swarm = {
      ...state.swarm,
      bucketName: credentials.bucketName,
      bucketAccessKey: credentials.accessKey,
      bucketSecretKey: credentials.secretKey,
    };
    this.persist(id);
  }

  setSwarmBucket(id: string, bucket: { bucketContainerId: string; auditContainerId: string; endpoint: string }): void {
    const state = this.requireState(id);
    state.swarm = {
      ...state.swarm,
      bucketContainerId: bucket.bucketContainerId,
      auditContainerId: bucket.auditContainerId,
      bucketEndpoint: bucket.endpoint,
    };
    this.persist(id);
  }

  addAgent(record: Omit<AgentRecord, "createdAt" | "generation" | "status">): AgentRecord {
    const state = this.requireState(record.swarmId);
    if (this.agentSwarms.has(record.id)) throw new Error(`agent '${record.id}' already exists`);
    const agent: AgentRecord = { ...record, status: "ready", generation: 0, createdAt: now() };
    state.agents.push(agent);
    state.agents.sort((left, right) => left.ordinal - right.ordinal);
    this.agentSwarms.set(agent.id, record.swarmId);
    this.persist(record.swarmId);
    return agent;
  }

  listAgents(swarmId: string): AgentRecord[] {
    return this.requireState(swarmId).agents.map((agent) => ({ ...agent }));
  }

  nextAgentOrdinal(swarmId: string): number {
    return Math.max(0, ...this.requireState(swarmId).agents.map((agent) => agent.ordinal)) + 1;
  }

  setAgentState(id: string, status: AgentRecord["status"], generation?: number): void {
    const swarmId = this.agentSwarms.get(id);
    if (!swarmId) throw new Error(`unknown agent '${id}'`);
    const state = this.requireState(swarmId);
    const agent = state.agents.find((candidate) => candidate.id === id);
    if (!agent) throw new Error(`unknown agent '${id}'`);
    agent.status = status;
    if (generation !== undefined) agent.generation = generation;
    this.persist(swarmId);
  }

  startRun(swarmId: string, agentId: string, generation: number): string {
    const state = this.requireState(swarmId);
    const id = randomUUID();
    state.runs.push({
      id,
      swarmId,
      agentId,
      generation,
      status: "running",
      exitCode: null,
      startedAt: now(),
      completedAt: null,
    });
    this.runSwarms.set(id, swarmId);
    this.persist(swarmId);
    return id;
  }

  finishRun(id: string, result: { exitCode: number }): void {
    const swarmId = this.runSwarms.get(id);
    if (!swarmId) throw new Error(`unknown run '${id}'`);
    const state = this.requireState(swarmId);
    const run = state.runs.find((candidate) => candidate.id === id);
    if (!run) throw new Error(`unknown run '${id}'`);
    run.status = result.exitCode === 0 ? "completed" : "failed";
    run.exitCode = result.exitCode;
    run.completedAt = now();
    this.persist(swarmId);
  }

  getOpenRun(agentId: string, generation: number): { id: string; startedAt: string } | undefined {
    const swarmId = this.agentSwarms.get(agentId);
    if (!swarmId) return undefined;
    return this.requireState(swarmId).runs
      .filter((run) => run.agentId === agentId && run.generation === generation && run.status === "running")
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map((run) => ({ id: run.id, startedAt: run.startedAt }))[0];
  }

  private get swarmsDir(): string {
    return join(this.dataDir, "swarms");
  }

  private load(): void {
    for (const entry of readdirSync(this.swarmsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(this.swarmsDir, entry.name, "state.json");
      if (!existsSync(path)) continue;
      const state = JSON.parse(readFileSync(path, "utf8")) as SwarmState;
      if (state.version !== 1 || state.swarm.id !== entry.name) {
        throw new Error(`invalid swarm state at ${path}`);
      }
      state.swarm.contextDir ??= null;
      this.states.set(state.swarm.id, state);
      for (const agent of state.agents) this.agentSwarms.set(agent.id, state.swarm.id);
      for (const run of state.runs) this.runSwarms.set(run.id, state.swarm.id);
    }
  }

  private requireState(id: string): SwarmState {
    const state = this.states.get(id);
    if (!state) throw new Error(`unknown swarm '${id}'`);
    return state;
  }

  private persist(id: string): void {
    const state = this.requireState(id);
    const dir = join(this.swarmsDir, id);
    const path = join(dir, "state.json");
    const temporary = join(dir, `.state-${randomUUID()}.tmp`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  }
}

function now(): string {
  return new Date().toISOString();
}
