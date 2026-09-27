#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { SwarmController } from "./controller.js";
import { DockerBackend } from "./docker-backend.js";
import { StateStore } from "./state-store.js";

if (existsSync(resolve(".env"))) process.loadEnvFile(resolve(".env"));
const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const commands = new Set(["init", "add", "run", "recover", "agents", "artifacts", "pause", "destroy"]);
if (command === "help" || command === "--help" || command === "-h") {
  help();
  process.exit(0);
}
if (!commands.has(command)) {
  process.stderr.write(`unknown command '${command}'\n`);
  process.exit(1);
}
try {
  validateArguments(command);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
const dataDir = resolve(option("--data-dir") ?? ".swarm");
const state = StateStore.open(dataDir);
const controller = new SwarmController(state, new DockerBackend());

try {
  switch (command) {
    case "init":
      await init();
      break;
    case "add":
      await add();
      break;
    case "run":
      await run();
      break;
    case "recover":
      await recover();
      break;
    case "agents":
      agents();
      break;
    case "artifacts":
      artifacts();
      break;
    case "pause":
      await pause();
      break;
    case "destroy":
      await destroy();
      break;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  state.close();
}

async function init(): Promise<void> {
  const goal = option("--goal") ?? readOptionalFile(option("--goal-file"));
  if (!goal?.trim()) throw new Error("init needs --goal TEXT or --goal-file PATH");
  const modelRef = option("--model") ?? "azure-openai-responses/gpt-5.4";
  const repoUrl = option("--repo");
  if (!repoUrl) throw new Error("init needs --repo URL");
  const contextDir = localDirectory(option("--context"));
  const agentImage = option("--image") ?? configuredImage();
  const agentCount = positiveInt(option("--agents") ?? "4", "--agents");
  const passedEnvNames = csv(option("--pass-env"));
  passedEnvNames.push(...providerEnvNames(modelRef));
  const swarm = await controller.create({
    goal: goal.trim(),
    repoUrl,
    contextDir,
    agents: agentCount,
    modelRef,
    maxConcurrency: positiveInt(option("--max-concurrency") ?? String(agentCount), "--max-concurrency"),
    agentImage,
    passedEnvNames: [...new Set(passedEnvNames)],
    timeoutMs: positiveInt(option("--timeout-ms") ?? "1800000", "--timeout-ms"),
  });
  process.stdout.write(`${swarm.id}\n`);
  process.stdout.write(`Created ${swarm.id}. Agent containers are stopped. Run: npm run swarm -- run ${swarm.id}\n`);
}

async function add(): Promise<void> {
  const swarmId = positional(1, "add needs a swarm id");
  const created = await controller.addAgents(
    swarmId,
    positiveInt(option("--agents") ?? "1", "--agents"),
    option("--timeout-ms") ? positiveInt(option("--timeout-ms")!, "--timeout-ms") : undefined,
  );
  for (const agent of created) process.stdout.write(`${agent.id} ${agent.containerId}\n`);
}

async function run(): Promise<void> {
  const swarmId = positional(1, "run needs a swarm id");
  await controller.run(
    swarmId,
    positiveInt(option("--rounds") ?? "1", "--rounds"),
    option("--timeout-ms") ? positiveInt(option("--timeout-ms")!, "--timeout-ms") : undefined,
    {
      ...(option("--max-concurrency") ? {
        maxConcurrency: positiveInt(option("--max-concurrency")!, "--max-concurrency"),
      } : {}),
    },
  );
}

async function recover(): Promise<void> {
  const swarmId = positional(1, "recover needs a swarm id");
  const results = await controller.recover(swarmId);
  if (results.length === 0) {
    process.stdout.write(`No running agents to recover for ${swarmId}.\n`);
    return;
  }
  for (const result of results) {
    process.stdout.write(`${result.agentId}\t${result.state}\n`);
  }
}

function agents(): void {
  const swarmId = positional(1, "agents needs a swarm id");
  for (const agent of state.listAgents(swarmId)) {
    process.stdout.write(`${agent.id}\t${agent.status}\tgen:${agent.generation}\t${agent.containerId}\n`);
  }
}

function artifacts(): void {
  const swarmId = positional(1, "artifacts needs a swarm id");
  if (!state.getSwarm(swarmId)) throw new Error(`unknown swarm '${swarmId}'`);
  process.stdout.write(`${resolve(state.dataDir, "artifacts", swarmId)}\n`);
}

async function pause(): Promise<void> {
  const swarmId = positional(1, "pause needs a swarm id");
  await controller.pause(swarmId);
  process.stdout.write(`Paused ${swarmId}.\n`);
}

async function destroy(): Promise<void> {
  const swarmId = positional(1, "destroy needs a swarm id");
  await controller.destroy(swarmId);
  process.stdout.write(`Removed all Docker containers and workspaces for ${swarmId}. The state and artifacts remain.\n`);
}

function option(name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

function positional(index: number, error: string): string {
  const values: string[] = [];
  for (let cursor = 1; cursor < argv.length; cursor += 1) {
    const value = argv[cursor]!;
    if (value.startsWith("--")) {
      cursor += 1;
      continue;
    }
    values.push(value);
  }
  const value = values[index - 1];
  if (!value) throw new Error(error);
  return value;
}

function validateArguments(name: string): void {
  const common = ["--data-dir"];
  const allowedByCommand: Record<string, string[]> = {
    init: [
      "--goal", "--goal-file", "--repo", "--context", "--agents",
      "--model", "--max-concurrency", "--pass-env", "--image",
      "--timeout-ms",
    ],
    add: ["--agents", "--timeout-ms"],
    run: ["--rounds", "--timeout-ms", "--max-concurrency"],
    recover: [],
    agents: [],
    artifacts: [],
    pause: [],
    destroy: [],
  };
  const allowed = new Set([...common, ...(allowedByCommand[name] ?? [])]);
  const seen = new Set<string>();
  let positionalCount = 0;
  for (let cursor = 1; cursor < argv.length; cursor += 1) {
    const value = argv[cursor]!;
    if (!value.startsWith("--")) {
      positionalCount += 1;
      continue;
    }
    if (!allowed.has(value)) throw new Error(`unknown option '${value}' for ${name}`);
    if (seen.has(value)) throw new Error(`option '${value}' was provided more than once`);
    seen.add(value);
    const optionValue = argv[cursor + 1];
    if (!optionValue || optionValue.startsWith("--")) throw new Error(`${value} needs a value`);
    cursor += 1;
  }
  const expected = name === "init" ? 0 : 1;
  if (positionalCount !== expected) {
    throw new Error(name === "init" ? "init does not accept positional arguments" : `${name} needs exactly one swarm id`);
  }
}

function positiveInt(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

function providerEnvNames(modelRef: string): string[] {
  const provider = modelRef.split("/", 1)[0];
  if (provider === "azure-openai-responses") {
    const key = firstSet("AZURE_OPENAI_API_KEY", "AZURE_OPENAI_KEY");
    const endpoint = firstSet("AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_ENDPOINT");
    if (!key || !endpoint) {
      throw new Error(
        "Azure Pi agents need AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT " +
        "(AZURE_OPENAI_KEY and AZURE_OPENAI_BASE_URL aliases also work)",
      );
    }
    return [
      key,
      endpoint,
      ...["AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP", "AZURE_OPENAI_RESOURCE_NAME"]
        .filter((name) => Boolean(process.env[name])),
    ];
  }
  if (provider === "openai") return [requireEnvName("OPENAI_API_KEY", provider)];
  if (provider === "anthropic") return [requireEnvName("ANTHROPIC_API_KEY", provider)];
  return [];
}

function firstSet(...names: string[]): string | undefined {
  return names.find((name) => Boolean(process.env[name]));
}

function requireEnvName(name: string, provider: string): string {
  if (!process.env[name]) throw new Error(`${name} is not set for Pi provider '${provider}'`);
  return name;
}

function csv(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function readOptionalFile(path: string | undefined): string | undefined {
  return path ? readFileSync(resolve(path), "utf8") : undefined;
}

function localDirectory(path: string | undefined): string | null {
  if (!path) return null;
  const absolute = resolve(path);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new Error(`--context is not a directory: ${absolute}`);
  }
  return absolute;
}

function configuredImage(): string {
  return process.env.SWARM_AGENT_IMAGE || "agent-swarm-agent:local";
}

function help(): void {
  process.stdout.write(`agent-swarm

Commands:
  init     Create a swarm and stopped Docker agent containers
  add      Add more isolated agents to an existing swarm
  run      Run agents with configured concurrency for one or more rounds
  recover  Reconcile agents left marked running after controller interruption
  agents   Show agent and container state
  artifacts Print the host directory containing logs and Pi transcripts
  pause    Stop all live agent containers
  destroy  Remove all containers and private workspaces; keep state and artifacts

Examples:
  npm run swarm -- init --goal "Inspect the repository" --repo https://github.com/org/repo --agents 4
  npm run swarm -- run swarm-12345678 --rounds 3
  npm run swarm -- add swarm-12345678 --agents 2

init options:
  --goal TEXT | --goal-file PATH
  --repo URL                 repository cloned into every agent workspace
  --context DIR              copy a local directory to /workspace/context in every agent workspace
  --agents N                 default: 4
  --model PROVIDER/MODEL     default: azure-openai-responses/gpt-5.4
  --max-concurrency N        running top-level agents; default: --agents
  --pass-env NAME,NAME       explicit host env vars passed to agents
  --image DOCKER_IMAGE       default: SWARM_AGENT_IMAGE or agent-swarm-agent:local
  --timeout-ms N             default: 1800000 (30 minutes); persisted with the swarm

run and add inherit the swarm timeout unless --timeout-ms is supplied. run also accepts
--max-concurrency as a one-run override.

All commands accept --data-dir PATH. Default: .swarm
`);
}
