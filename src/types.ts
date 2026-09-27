export interface SwarmRecord {
  id: string;
  goal: string;
  repoUrl: string | null;
  contextDir: string | null;
  agentImage: string;
  modelRef: string | null;
  maxConcurrency: number;
  timeoutMs: number;
  bucketContainerId: string | null;
  auditContainerId: string | null;
  bucketEndpoint: string | null;
  bucketName: string;
  bucketAccessKey: string;
  bucketSecretKey: string;
  passedEnvNames: string[];
  createdAt: string;
}

export interface AgentRecord {
  id: string;
  swarmId: string;
  ordinal: number;
  containerId: string;
  status: "ready" | "running" | "paused" | "failed" | "killed";
  generation: number;
  createdAt: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxHandle {
  id: string;
  write(path: string, data: string | Uint8Array): Promise<void>;
  read(path: string): Promise<string>;
  list(path: string): Promise<Array<{ name: string; isFile: boolean }>>;
  rename(oldPath: string, newPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  cloneRepo(
    url: string,
    path: string,
    options?: { ref?: string; expectedCommit?: string },
  ): Promise<CommandResult>;
  run(command: string, options?: { env?: Record<string, string>; timeoutMs?: number }): Promise<CommandResult>;
  listProcesses?(): Promise<Array<{ pid: number; command: string }>>;
  pause(): Promise<void>;
  kill(): Promise<void>;
}

export interface SandboxBackend {
  create(options: {
    image: string;
    timeoutMs: number;
    env: Record<string, string>;
    metadata: Record<string, string>;
  }): Promise<SandboxHandle>;
  connect(id: string, options?: { timeoutMs?: number }): Promise<SandboxHandle>;
  provisionBucket(options: {
    swarmId: string;
    bucketName: string;
    accessKey: string;
    secretKey: string;
    clientImage: string;
    auditServerSource: string;
  }): Promise<{
    bucketContainerId: string;
    auditContainerId: string;
    endpoint: string;
  }>;
}
