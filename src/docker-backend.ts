import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import Docker from "dockerode";

import type { CommandResult, SandboxBackend, SandboxHandle } from "./types.js";

const BUCKET_PORT = 9000;
const AUDIT_PORT = 4318;
const COMMAND_POLL_MS = 1_000;
const COMMAND_EXIT_GRACE_POLLS = 3;
const MANAGED_LABEL = "agent-swarm.managed";
const WORKSPACE_LABEL = "agent-swarm.workspace";
const ROLE_LABEL = "agent-swarm.role";

export class DockerBackend implements SandboxBackend {
  private readonly docker: Docker;
  private readonly workspaceRoot: string;
  private readonly hostWorkspaceRoot: string;
  private readonly networkName: string;
  private readonly controllerImage: string;
  private readonly bucketImage: string;

  constructor(options: {
    docker?: Docker;
    workspaceRoot?: string;
    hostWorkspaceRoot?: string;
    networkName?: string;
    controllerImage?: string;
    bucketImage?: string;
  } = {}) {
    this.docker = options.docker ?? new Docker();
    this.workspaceRoot = resolve(options.workspaceRoot ?? process.env.SWARM_WORKSPACE_DIR ?? ".swarm/workspaces");
    this.hostWorkspaceRoot = resolve(
      options.hostWorkspaceRoot ?? process.env.SWARM_HOST_WORKSPACE_DIR ?? this.workspaceRoot,
    );
    this.networkName = options.networkName ?? process.env.SWARM_DOCKER_NETWORK ?? "agent-swarm-runtime";
    this.controllerImage = options.controllerImage ?? process.env.SWARM_CONTROLLER_IMAGE ?? "agent-swarm-controller:local";
    this.bucketImage = options.bucketImage ?? process.env.SWARM_MINIO_IMAGE ?? "quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z";
  }

  async create(options: {
    image: string;
    timeoutMs: number;
    env: Record<string, string>;
    metadata: Record<string, string>;
  }): Promise<SandboxHandle> {
    await this.requireImage(options.image);
    await this.ensureNetwork();
    const key = `agents/${safePart(options.metadata.agent ?? randomUUID())}-${randomUUID().slice(0, 8)}`;
    await this.prepareWorkspace(key);
    const container = await this.docker.createContainer({
      name: `agent-swarm-${safePart(options.metadata.agent ?? randomUUID())}-${randomUUID().slice(0, 8)}`,
      Image: options.image,
      Env: environment(options.env),
      Labels: {
        [MANAGED_LABEL]: "true",
        [WORKSPACE_LABEL]: key,
        [ROLE_LABEL]: "agent",
        ...Object.fromEntries(Object.entries(options.metadata).map(([name, value]) => [`agent-swarm.${name}`, value])),
      },
      HostConfig: {
        AutoRemove: false,
        Binds: [`${this.hostPath(key)}:/workspace`],
        CapDrop: ["ALL"],
        NetworkMode: this.networkName,
        PidsLimit: 4096,
        SecurityOpt: ["no-new-privileges:true"],
      },
    });
    try {
      await container.start();
      await this.waitForFile(join(this.localPath(key), "swarm", ".agent-swarm-image-ready"), container, 15_000);
      return new DockerHandle(this.docker, container.id, key, this.workspaceRoot, this.hostWorkspaceRoot);
    } catch (error) {
      await container.remove({ force: true }).catch(() => undefined);
      await rm(this.localPath(key), { recursive: true, force: true });
      throw error;
    }
  }

  async connect(id: string): Promise<SandboxHandle> {
    const container = this.docker.getContainer(id);
    const info = await container.inspect();
    const key = info.Config.Labels?.[WORKSPACE_LABEL];
    if (!key) throw new Error(`container '${id}' is not an agent-swarm container`);
    if (!info.State.Running) await container.start();
    return new DockerHandle(this.docker, id, key, this.workspaceRoot, this.hostWorkspaceRoot);
  }

  async provisionBucket(options: {
    swarmId: string;
    bucketName: string;
    accessKey: string;
    secretKey: string;
    clientImage: string;
    auditServerSource: string;
  }): Promise<{ bucketContainerId: string; auditContainerId: string; endpoint: string }> {
    await Promise.all([
      this.requireImage(this.controllerImage),
      this.requireImage(this.bucketImage),
      this.requireImage(options.clientImage),
    ]);
    await this.ensureNetwork();

    const auditKey = `audits/${safePart(options.swarmId)}`;
    const auditRoot = await this.prepareWorkspace(auditKey);
    await mkdir(join(auditRoot, "swarm", "audit"), { recursive: true });
    await chmod(join(auditRoot, "swarm", "audit"), 0o777);
    await writeFile(join(auditRoot, "swarm", "audit-server.mjs"), options.auditServerSource, "utf8");
    const auditReady = join(auditRoot, "swarm", "audit", "ready");
    await unlink(auditReady).catch(() => undefined);
    const auditToken = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
    const auditName = `agent-swarm-audit-${safePart(options.swarmId)}`;
    const audit = await this.docker.createContainer({
      name: auditName,
      Image: this.controllerImage,
      Cmd: ["node", "/workspace/swarm/audit-server.mjs"],
      Env: environment({
        SWARM_AUDIT_PORT: String(AUDIT_PORT),
        SWARM_AUDIT_TOKEN: auditToken,
        SWARM_AUDIT_PATH: "/workspace/swarm/audit/audit.jsonl",
        SWARM_AUDIT_READY_PATH: "/workspace/swarm/audit/ready",
      }),
      Labels: {
        [MANAGED_LABEL]: "true",
        [WORKSPACE_LABEL]: auditKey,
        [ROLE_LABEL]: "audit",
        "agent-swarm.swarm": options.swarmId,
      },
      HostConfig: {
        AutoRemove: false,
        Binds: [`${this.hostPath(auditKey)}:/workspace`],
        CapDrop: ["ALL"],
        NetworkMode: this.networkName,
        PidsLimit: 256,
        ReadonlyRootfs: true,
        SecurityOpt: ["no-new-privileges:true"],
      },
    });

    const bucketKey = `buckets/${safePart(options.swarmId)}`;
    const bucketRoot = await this.prepareWorkspace(bucketKey);
    await mkdir(join(bucketRoot, "data"), { recursive: true });
    await chmod(join(bucketRoot, "data"), 0o777);
    const bucketName = `agent-swarm-bucket-${safePart(options.swarmId)}`;
    const endpoint = `http://${bucketName}:${BUCKET_PORT}`;
    const bucket = await this.docker.createContainer({
      name: bucketName,
      Image: this.bucketImage,
      Cmd: ["server", "/data", "--address", `:${BUCKET_PORT}`],
      Env: environment({
        MINIO_ROOT_USER: options.accessKey,
        MINIO_ROOT_PASSWORD: options.secretKey,
        MINIO_AUDIT_WEBHOOK_ENABLE_SWARM: "on",
        MINIO_AUDIT_WEBHOOK_ENDPOINT_SWARM: `http://${auditName}:${AUDIT_PORT}/audit`,
        MINIO_AUDIT_WEBHOOK_AUTH_TOKEN_SWARM: auditToken,
      }),
      Labels: {
        [MANAGED_LABEL]: "true",
        [WORKSPACE_LABEL]: bucketKey,
        [ROLE_LABEL]: "bucket",
        "agent-swarm.swarm": options.swarmId,
      },
      HostConfig: {
        AutoRemove: false,
        Binds: [`${this.hostPath(bucketKey)}/data:/data`],
        CapDrop: ["ALL"],
        NetworkMode: this.networkName,
        PidsLimit: 1024,
        SecurityOpt: ["no-new-privileges:true"],
      },
    });

    try {
      await audit.start();
      await this.waitForFile(auditReady, audit, 15_000);
      await bucket.start();
      await this.initializeBucket(options, endpoint);
      return { bucketContainerId: bucket.id, auditContainerId: audit.id, endpoint };
    } catch (error) {
      await Promise.all([
        bucket.remove({ force: true }).catch(() => undefined),
        audit.remove({ force: true }).catch(() => undefined),
      ]);
      await Promise.all([
        rm(bucketRoot, { recursive: true, force: true }),
        rm(auditRoot, { recursive: true, force: true }),
      ]);
      throw error;
    }
  }

  private async initializeBucket(
    options: { swarmId: string; bucketName: string; accessKey: string; secretKey: string; clientImage: string },
    endpoint: string,
  ): Promise<void> {
    const command = [
      "set -e",
      "ready=0",
      "for attempt in $(seq 1 60); do",
      `  if aws --endpoint-url ${shellQuote(endpoint)} s3api create-bucket --bucket ${shellQuote(options.bucketName)} 2>/tmp/create.err; then ready=1; break; fi`,
      `  if aws --endpoint-url ${shellQuote(endpoint)} s3api head-bucket --bucket ${shellQuote(options.bucketName)} 2>/dev/null; then ready=1; break; fi`,
      "  sleep 1",
      "done",
      "if [ \"$ready\" -ne 1 ]; then cat /tmp/create.err >&2; exit 1; fi",
      `aws --endpoint-url ${shellQuote(endpoint)} s3api put-bucket-versioning --bucket ${shellQuote(options.bucketName)} --versioning-configuration Status=Enabled`,
      "printf '%s\\n' 'Shared submissions belong under submissions/submission-XX/. Read existing reports before creating or revising one.' >/tmp/submissions-readme.md",
      `aws --endpoint-url ${shellQuote(endpoint)} s3 cp /tmp/submissions-readme.md s3://${options.bucketName}/submissions/README.md`,
    ].join("\n");
    const initializer = await this.docker.createContainer({
      Image: options.clientImage,
      Cmd: ["bash", "-lc", command],
      Env: environment({
        AWS_ACCESS_KEY_ID: options.accessKey,
        AWS_SECRET_ACCESS_KEY: options.secretKey,
        AWS_DEFAULT_REGION: "us-east-1",
      }),
      Labels: {
        [MANAGED_LABEL]: "true",
        [ROLE_LABEL]: "bucket-initializer",
        "agent-swarm.swarm": options.swarmId,
      },
      HostConfig: {
        AutoRemove: false,
        NetworkMode: this.networkName,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
      },
    });
    try {
      await initializer.start();
      const result = await initializer.wait({ condition: "not-running" });
      if (result.StatusCode !== 0) {
        const logs = await initializer.logs({ stdout: true, stderr: true });
        throw new Error(`bucket initialization failed (${result.StatusCode}): ${logs.toString("utf8")}`);
      }
    } finally {
      await initializer.remove({ force: true }).catch(() => undefined);
    }
  }

  private async prepareWorkspace(key: string): Promise<string> {
    const root = this.localPath(key);
    await mkdir(join(root, "repo"), { recursive: true });
    await mkdir(join(root, "swarm"), { recursive: true });
    await chmod(root, 0o777);
    await chmod(join(root, "repo"), 0o777);
    await chmod(join(root, "swarm"), 0o777);
    return root;
  }

  private localPath(key: string): string {
    return safeJoin(this.workspaceRoot, key);
  }

  private hostPath(key: string): string {
    return safeJoin(this.hostWorkspaceRoot, key);
  }

  private async requireImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
    } catch {
      throw new Error(`Docker image '${image}' is not available; build the swarm images first`);
    }
  }

  private async ensureNetwork(): Promise<void> {
    const networks = await this.docker.listNetworks({ filters: { name: [this.networkName] } });
    if (networks.some((network) => network.Name === this.networkName)) return;
    try {
      await this.docker.createNetwork({
        Name: this.networkName,
        Driver: "bridge",
        CheckDuplicate: true,
        Labels: { [MANAGED_LABEL]: "true" },
      });
    } catch (error) {
      const current = await this.docker.listNetworks({ filters: { name: [this.networkName] } });
      if (!current.some((network) => network.Name === this.networkName)) throw error;
    }
  }

  private async waitForFile(path: string, container: Docker.Container, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await readFile(path);
        return;
      } catch {
        const info = await container.inspect();
        if (!info.State.Running) {
          throw new Error(`container ${container.id.slice(0, 12)} stopped during startup: ${info.State.Error || info.State.Status}`);
        }
        await delay(100);
      }
    }
    throw new Error(`container ${container.id.slice(0, 12)} did not become ready within ${timeoutMs} ms`);
  }
}

class DockerHandle implements SandboxHandle {
  private readonly container: Docker.Container;
  private readonly root: string;

  constructor(
    private readonly docker: Docker,
    readonly id: string,
    key: string,
    workspaceRoot: string,
    private readonly hostWorkspaceRoot: string,
  ) {
    this.container = docker.getContainer(id);
    this.root = safeJoin(workspaceRoot, key);
  }

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
    await rename(this.local(oldPath), destination);
  }

  remove(path: string): Promise<void> {
    return unlink(this.local(path));
  }

  async cloneRepo(
    url: string,
    path: string,
    options: { ref?: string; expectedCommit?: string } = {},
  ): Promise<CommandResult> {
    const clone = await this.run(
      `git clone --depth 1 ${options.ref ? `--branch ${shellQuote(options.ref)} ` : ""}${shellQuote(url)} ${shellQuote(path)}`,
      { timeoutMs: 300_000 },
    );
    if (clone.exitCode !== 0 || !options.expectedCommit) return clone;
    if (!/^[0-9a-f]{7,64}$/i.test(options.expectedCommit)) {
      return { exitCode: 1, stdout: clone.stdout, stderr: "expectedCommit must be a hexadecimal Git commit" };
    }
    const head = await this.run(`git -C ${shellQuote(path)} rev-parse HEAD`, { timeoutMs: 30_000 });
    if (head.exitCode !== 0) return head;
    if (head.stdout.trim().toLowerCase() !== options.expectedCommit.toLowerCase()) {
      return {
        exitCode: 1,
        stdout: head.stdout,
        stderr: `repository HEAD ${head.stdout.trim()} does not match expected commit ${options.expectedCommit}`,
      };
    }
    return clone;
  }

  async run(
    command: string,
    options: { env?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    await this.ensureRunning();
    const timeoutMs = options.timeoutMs ?? 600_000;
    const deadline = Date.now() + timeoutMs;
    const commandId = randomUUID();
    const commandDir = `/workspace/swarm/commands/${commandId}`;
    const commandPath = `${commandDir}/command.sh`;
    const runnerPath = `${commandDir}/runner.sh`;
    const stdoutPath = `${commandDir}/stdout.log`;
    const stderrPath = `${commandDir}/stderr.log`;
    const outcomePath = `${commandDir}/outcome.json`;
    const pidPath = options.env?.SWARM_RESULT_PATH ? `${options.env.SWARM_RESULT_PATH}.pid` : `${commandDir}/pid`;
    await this.write(commandPath, command);
    await this.write(runnerPath, detachedRunner(commandPath, stdoutPath, stderrPath, outcomePath, pidPath));

    const execution = await this.container.exec({
      Cmd: ["setsid", "--wait", "bash", runnerPath],
      Env: environment(options.env ?? {}),
      WorkingDir: "/workspace/repo",
      AttachStdout: false,
      AttachStderr: false,
    });
    const launch = await execution.start({ Detach: true });
    await new Promise<void>((resolveLaunch, reject) => {
      launch.once("end", resolveLaunch);
      launch.once("error", reject);
      launch.resume();
    });

    let missingProcessPolls = 0;
    while (Date.now() < deadline) {
      const outcome = await this.readOutcome(outcomePath, stdoutPath, stderrPath);
      if (outcome) return outcome;
      try {
        const info = await execution.inspect();
        if (info.Running) {
          missingProcessPolls = 0;
        } else {
          missingProcessPolls += 1;
          if (missingProcessPolls >= COMMAND_EXIT_GRACE_POLLS) {
            const lateOutcome = await this.readOutcome(outcomePath, stdoutPath, stderrPath);
            if (lateOutcome) return lateOutcome;
            return {
              exitCode: 1,
              stdout: await this.readOrEmpty(stdoutPath),
              stderr: `${await this.readOrEmpty(stderrPath)}\nContainer command ended without an outcome.\n`.trimStart(),
            };
          }
        }
      } catch {
        // A controller restart can lose the exec object while the process keeps running.
      }
      await delay(Math.min(COMMAND_POLL_MS, Math.max(1, deadline - Date.now())));
    }

    const pid = Number((await this.readOrEmpty(pidPath)).trim());
    if (Number.isInteger(pid) && pid > 0) await this.signalProcessGroup(pid).catch(() => undefined);
    return {
      exitCode: 124,
      stdout: await this.readOrEmpty(stdoutPath),
      stderr: `${await this.readOrEmpty(stderrPath)}\nContainer command exceeded its ${timeoutMs} ms controller deadline.\n`.trimStart(),
    };
  }

  async listProcesses(): Promise<Array<{ pid: number; command: string }>> {
    const results = join(this.root, "swarm", "results");
    let entries: string[] = [];
    try {
      entries = await readdir(results);
    } catch {
      return [];
    }
    const processes: Array<{ pid: number; command: string }> = [];
    for (const entry of entries.filter((name) => name.endsWith(".pid"))) {
      const pid = Number((await readFile(join(results, entry), "utf8")).trim());
      if (Number.isInteger(pid) && pid > 0 && await this.processIsRunning(pid)) {
        processes.push({ pid, command: entry });
      }
    }
    return processes;
  }

  async pause(): Promise<void> {
    const info = await this.container.inspect();
    if (info.State.Running) await this.container.stop({ t: 10 });
  }

  async kill(): Promise<void> {
    await this.container.remove({ force: true, v: true });
    await rm(this.root, { recursive: true, force: true });
  }

  private async ensureRunning(): Promise<void> {
    const info = await this.container.inspect();
    if (!info.State.Running) await this.container.start();
  }

  private async processIsRunning(pid: number): Promise<boolean> {
    await this.ensureRunning();
    const execution = await this.container.exec({ Cmd: ["kill", "-0", String(pid)] });
    const stream = await execution.start({ Detach: false });
    stream.resume();
    await new Promise<void>((resolveStream, reject) => {
      stream.once("end", resolveStream);
      stream.once("error", reject);
    });
    return (await execution.inspect()).ExitCode === 0;
  }

  private async signalProcessGroup(pid: number): Promise<void> {
    const execution = await this.container.exec({
      Cmd: ["bash", "-lc", `kill -TERM -- -${pid} 2>/dev/null || true; sleep 2; kill -KILL -- -${pid} 2>/dev/null || true`],
    });
    const stream = await execution.start({ Detach: false });
    stream.resume();
    await new Promise<void>((resolveStream) => stream.once("end", resolveStream));
  }

  private async readOutcome(
    outcomePath: string,
    stdoutPath: string,
    stderrPath: string,
  ): Promise<CommandResult | undefined> {
    try {
      const stored = JSON.parse(await this.read(outcomePath)) as { exitCode?: unknown };
      if (!Number.isInteger(stored.exitCode)) return undefined;
      return {
        exitCode: stored.exitCode as number,
        stdout: await this.readOrEmpty(stdoutPath),
        stderr: await this.readOrEmpty(stderrPath),
      };
    } catch {
      return undefined;
    }
  }

  private async readOrEmpty(path: string): Promise<string> {
    try {
      return await this.read(path);
    } catch {
      return "";
    }
  }

  private local(path: string): string {
    if (path !== "/workspace" && !path.startsWith("/workspace/")) {
      throw new Error(`container file path must be under /workspace: '${path}'`);
    }
    return safeJoin(this.root, path.slice("/workspace".length));
  }
}

function detachedRunner(
  commandPath: string,
  stdoutPath: string,
  stderrPath: string,
  outcomePath: string,
  pidPath: string,
): string {
  const temporaryOutcomePath = `${outcomePath}.tmp`;
  return `#!/usr/bin/env bash
set +e
printf '%s\\n' "$$" >${shellQuote(pidPath)}
bash ${shellQuote(commandPath)} >${shellQuote(stdoutPath)} 2>${shellQuote(stderrPath)}
exit_code=$?
printf '{"exitCode":%s}\\n' "$exit_code" >${shellQuote(temporaryOutcomePath)}
mv ${shellQuote(temporaryOutcomePath)} ${shellQuote(outcomePath)}
rm -f ${shellQuote(pidPath)}
exit "$exit_code"
`;
}

function environment(values: Record<string, string>): string[] {
  return Object.entries(values).map(([name, value]) => `${name}=${value}`);
}

function safePart(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9_.-]/g, "-").replaceAll(/^-+|-+$/g, "").slice(0, 80) || "worker";
}

function safeJoin(root: string, path: string): string {
  if (isAbsolute(path)) path = path.replace(/^\/+/, "");
  const candidate = resolve(root, path);
  const fromRoot = relative(resolve(root), candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
    throw new Error(`path escapes workspace root: '${path}'`);
  }
  return candidate;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
