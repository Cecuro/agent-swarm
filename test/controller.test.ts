import { exec as execCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rename as renameFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { SwarmController } from "../src/controller.js";
import { StateStore } from "../src/state-store.js";
import type { CommandResult, SandboxBackend, SandboxHandle } from "../src/types.js";

const exec = promisify(execCallback);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("swarm controller", () => {
  it("runs concurrent generations with a minimal shared-bucket prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-swarm-controller-"));
    dirs.push(dir);
    const state = StateStore.open(join(dir, "data"));
    const backend = new FakeBackend(join(dir, "sandboxes"));
    const controller = new SwarmController(state, backend);

    const swarm = await controller.create({
      goal: "investigate independently",
      repoUrl: "https://example.com/repo.git",
      agents: 2,
      passedEnvNames: [],
      timeoutMs: 60_000,
    });
    await controller.run(swarm.id, 2);

    const firstAgent = state.listAgents(swarm.id)[0]!;
    const prompt = await backend.connect(firstAgent.containerId).then((sandbox) =>
      sandbox.read("/workspace/swarm/PROMPT.md"),
    );
    expect(prompt).toContain(`You are ${firstAgent.id}, generation 2`);
    expect(prompt).toContain(`s3://${swarm.id}`);
    expect(prompt).toContain("investigate independently");
    expect(prompt).toContain("Other agents are independently working on the same task");
    expect(prompt).toContain("Use agents_list to see the other workers");

    const [later] = await controller.addAgents(swarm.id, 1);
    await controller.run(swarm.id, 1);
    expect(state.listAgents(swarm.id).find((agent) => agent.id === later!.id)?.generation).toBe(1);
    expect(backend.runEnvironments[0]).toMatchObject({
      SWARM_AGENT_ID: expect.stringContaining(":agent-"),
      SWARM_WORKER_ID: expect.stringContaining(":agent-"),
      SWARM_AGENT_ROSTER: expect.any(String),
      SWARM_BUCKET: swarm.id,
      AWS_ENDPOINT_URL: `http://bucket-${swarm.id}:9000`,
      AWS_ENDPOINT_URL_S3: `http://bucket-${swarm.id}:9000`,
      AWS_ACCESS_KEY_ID: expect.stringMatching(/^swarm/),
      AWS_SECRET_ACCESS_KEY: expect.any(String),
      AWS_DEFAULT_REGION: "us-east-1",
      AWS_EC2_METADATA_DISABLED: "true",
    });
    expect(JSON.parse(backend.runEnvironments[0]!.SWARM_AGENT_ROSTER!)).toHaveLength(2);
    const prepared = await backend.connect(firstAgent.containerId);
    await expect(prepared.read("/workspace/swarm/coordination.mjs")).resolves.toContain(
      "createCoordinationClient",
    );
    await expect(
      prepared.read("/workspace/swarm/pi-config/extensions/coordination.js"),
    ).resolves.toContain("messages_read");
    expect(await readFile(join(
      state.dataDir,
      "artifacts",
      swarm.id,
      "bucket",
      "audit.jsonl",
    ), "utf8")).toBe("");
    state.close();
  });

  it("copies supplementary context into every agent workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-swarm-context-"));
    dirs.push(dir);
    const context = join(dir, "context");
    await mkdir(join(context, "references"), { recursive: true });
    await writeFile(join(context, "brief.md"), "program rules\n");
    await writeFile(join(context, "references", "scope.md"), "in scope\n");
    const state = StateStore.open(join(dir, "data"));
    const backend = new FakeBackend(join(dir, "sandboxes"));
    const controller = new SwarmController(state, backend);

    const swarm = await controller.create({
      goal: "inspect supplementary context",
      repoUrl: "https://example.com/repo.git",
      contextDir: context,
      agents: 2,
      passedEnvNames: [],
      timeoutMs: 60_000,
    });

    for (const agent of state.listAgents(swarm.id)) {
      const sandbox = await backend.connect(agent.containerId);
      await expect(sandbox.read("/workspace/context/brief.md")).resolves.toBe("program rules\n");
      await expect(sandbox.read("/workspace/context/references/scope.md")).resolves.toBe("in scope\n");
    }
    state.close();
  });

  it("limits the number of concurrently running top-level agents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-swarm-concurrency-"));
    dirs.push(dir);
    const state = StateStore.open(join(dir, "data"));
    const backend = new FakeBackend(join(dir, "sandboxes"));
    const controller = new SwarmController(state, backend);

    const swarm = await controller.create({
      goal: "test concurrency",
      repoUrl: "https://example.com/repo.git",
      agents: 5,
      maxConcurrency: 2,
      passedEnvNames: [],
      timeoutMs: 60_000,
    });
    await controller.run(swarm.id, 1);

    expect(backend.maxRunning).toBe(2);
    state.close();
  });

  it("prepares agent sandboxes with the configured concurrency", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-swarm-provisioning-"));
    dirs.push(dir);
    const state = StateStore.open(join(dir, "data"));
    const backend = new SlowCreateBackend(join(dir, "sandboxes"));
    const controller = new SwarmController(state, backend);

    await controller.create({
      goal: "test provisioning concurrency",
      repoUrl: "https://example.com/repo.git",
      agents: 5,
      maxConcurrency: 2,
      passedEnvNames: [],
      timeoutMs: 60_000,
    });

    expect(backend.maxCreating).toBe(2);
    state.close();
  });

  it("retries transient sandbox reconnect failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-swarm-reconnect-"));
    dirs.push(dir);
    const state = StateStore.open(join(dir, "data"));
    const backend = new FlakyConnectBackend(join(dir, "sandboxes"));
    const controller = new SwarmController(state, backend);

    const swarm = await controller.create({
      goal: "test reconnect retries",
      repoUrl: "https://example.com/repo.git",
      agents: 1,
      passedEnvNames: [],
      timeoutMs: 60_000,
    });
    backend.failNextConnects(2);

    await controller.run(swarm.id, 1);

    expect(backend.connectAttempts).toBe(4);
    expect(state.listAgents(swarm.id)[0]?.status).toBe("paused");
    state.close();
  });

  it("inherits the swarm timeout when a run does not override it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-swarm-timeout-"));
    dirs.push(dir);
    const state = StateStore.open(join(dir, "data"));
    const backend = new FakeBackend(join(dir, "sandboxes"));
    const controller = new SwarmController(state, backend);

    const swarm = await controller.create({
      goal: "test persisted timeout",
      repoUrl: "https://example.com/repo.git",
      agents: 1,
      passedEnvNames: [],
      timeoutMs: 3_600_000,
    });
    await controller.run(swarm.id, 1);

    expect(state.getSwarm(swarm.id)?.timeoutMs).toBe(3_600_000);
    expect(backend.connectTimeouts.filter((value) => value !== undefined)).toEqual([3_720_000]);
    expect(backend.runTimeouts).toEqual([3_660_000]);
    state.close();
  });

  it("recovers a finished agent after the controller disconnects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-swarm-recovery-"));
    dirs.push(dir);
    const state = StateStore.open(join(dir, "data"));
    const backend = new FakeBackend(join(dir, "sandboxes"));
    const controller = new SwarmController(state, backend);
    const swarm = await controller.create({
      goal: "test controller recovery",
      repoUrl: "https://example.com/repo.git",
      agents: 1,
      passedEnvNames: [],
      timeoutMs: 60_000,
    });
    const [agent] = state.listAgents(swarm.id);
    state.setAgentState(agent!.id, "running", 1);
    state.startRun(swarm.id, agent!.id, 1);
    const sandbox = await backend.connect(agent!.containerId);
    await sandbox.write("/workspace/swarm/results/generation-1.json", JSON.stringify({
      exitCode: 0,
      stdout: "completed while the controller was unavailable\n",
      stderr: "",
    }));
    await sandbox.write("/workspace/swarm/transcripts/generation-1/.keep", "");

    await expect(controller.recover(swarm.id)).resolves.toEqual([
      { agentId: agent!.id, state: "recovered" },
    ]);
    expect(state.listAgents(swarm.id)[0]?.status).toBe("paused");
    expect(state.getOpenRun(agent!.id, 1)).toBeUndefined();
    expect(await readFile(join(
      state.dataDir,
      "artifacts",
      swarm.id,
      "agent-1",
      "generation-1",
      "stdout.log",
    ), "utf8")).toContain("completed while the controller was unavailable");
    state.close();
  });
});

class FakeBackend implements SandboxBackend {
  private readonly handles = new Map<string, FakeHandle>();
  private next = 1;
  private running = 0;
  maxRunning = 0;
  connectTimeouts: Array<number | undefined> = [];
  runTimeouts: Array<number | undefined> = [];
  runEnvironments: Array<Record<string, string>> = [];

  constructor(private readonly root: string) {}

  async create(): Promise<SandboxHandle> {
    const id = `fake-${this.next++}`;
    const handle = new FakeHandle(
      id,
      join(this.root, id),
      (timeoutMs, env) => {
        this.running += 1;
        this.maxRunning = Math.max(this.maxRunning, this.running);
        this.runTimeouts.push(timeoutMs);
        this.runEnvironments.push(env);
      },
      () => {
        this.running -= 1;
      },
    );
    this.handles.set(id, handle);
    return handle;
  }

  async provisionBucket(options: {
    swarmId: string;
    bucketName: string;
    accessKey: string;
    secretKey: string;
    clientImage: string;
    auditServerSource: string;
  }): Promise<{ bucketContainerId: string; auditContainerId: string; endpoint: string }> {
    const bucket = await this.create();
    const audit = await this.create();
    await audit.write("/workspace/swarm/audit/audit.jsonl", "");
    return {
      bucketContainerId: bucket.id,
      auditContainerId: audit.id,
      endpoint: `http://bucket-${options.swarmId}:9000`,
    };
  }

  async connect(id: string, options: { timeoutMs?: number } = {}): Promise<SandboxHandle> {
    this.connectTimeouts.push(options.timeoutMs);
    const handle = this.handles.get(id);
    if (!handle) throw new Error(`missing fake sandbox '${id}'`);
    return handle;
  }
}

class FlakyConnectBackend extends FakeBackend {
  private remainingFailures = 0;
  connectAttempts = 0;

  failNextConnects(count: number): void {
    this.remainingFailures = count;
  }

  override async connect(id: string, options: { timeoutMs?: number } = {}): Promise<SandboxHandle> {
    this.connectAttempts += 1;
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error("transient Docker reconnect failure");
    }
    return super.connect(id, options);
  }
}

class SlowCreateBackend extends FakeBackend {
  private creating = 0;
  maxCreating = 0;

  override async create(): Promise<SandboxHandle> {
    this.creating += 1;
    this.maxCreating = Math.max(this.maxCreating, this.creating);
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      return await super.create();
    } finally {
      this.creating -= 1;
    }
  }
}

class FakeHandle implements SandboxHandle {
  constructor(
    readonly id: string,
    private readonly root: string,
    private readonly onRunStart: (timeoutMs: number | undefined, env: Record<string, string>) => void,
    private readonly onRunEnd: () => void,
  ) {}

  async write(path: string, data: string | Uint8Array): Promise<void> {
    const local = this.local(path);
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, data);
  }

  read(path: string): Promise<string> {
    return readFile(this.local(path), "utf8");
  }

  async list(path: string): Promise<Array<{ name: string; isFile: boolean }>> {
    const entries = await readdir(this.local(path), { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, isFile: entry.isFile() }));
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const destination = this.local(newPath);
    await mkdir(dirname(destination), { recursive: true });
    await renameFile(this.local(oldPath), destination);
  }

  remove(path: string): Promise<void> {
    return unlink(this.local(path));
  }

  async cloneRepo(
    _url: string,
    path: string,
    options: { ref?: string; expectedCommit?: string } = {},
  ): Promise<CommandResult> {
    await this.write(`${path}/.git/HEAD`, `ref: refs/heads/${options.ref ?? "main"}\n`);
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async run(
    command: string,
    options: { env?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    if (command.startsWith("npm install --prefix")) return { exitCode: 0, stdout: "", stderr: "" };
    if (command === "node /workspace/swarm/pi-agent.mjs") {
      this.onRunStart(options.timeoutMs, options.env ?? {});
      try {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
        return {
          exitCode: 0,
          stdout: `Synthetic Pi run from ${options.env?.SWARM_AGENT_ID}, generation ${options.env?.SWARM_GENERATION}.\n`,
          stderr: "",
        };
      } finally {
        this.onRunEnd();
      }
    }

    const rewritten = command.replaceAll("/workspace", this.local("/workspace"));
    const env = Object.fromEntries(Object.entries(options.env ?? {}).map(([name, value]) => [
      name,
      value.replaceAll("/workspace", this.local("/workspace")),
    ]));
    try {
      const result = await exec(rewritten, {
        cwd: this.local("/workspace/repo"),
        env: { ...process.env, ...env },
        timeout: options.timeoutMs,
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const result = error as Error & { code?: number; stdout?: string; stderr?: string };
      return { exitCode: result.code ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? result.message };
    }
  }

  async listProcesses(): Promise<Array<{ pid: number; command: string }>> {
    return [];
  }

  async pause(): Promise<void> {}
  async kill(): Promise<void> {}

  private local(path: string): string {
    return join(this.root, path.replace(/^\/workspace\/?/, ""));
  }
}
