import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { StateStore } from "../src/state-store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("swarm state store", () => {
  it("persists swarm, agent, run, and bucket state as JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-swarm-state-"));
    dirs.push(dir);
    let state = StateStore.open(dir);
    state.createSwarm({
      id: "swarm-test",
      goal: "test",
      repoUrl: "https://example.com/repo.git",
      contextDir: null,
      agentImage: "agent-swarm-agent:local",
      modelRef: "azure-openai-responses/gpt-5.6-luna",
      timeoutMs: 3_600_000,
      bucketName: "swarm-test",
      bucketAccessKey: "access",
      bucketSecretKey: "secret",
      passedEnvNames: [],
    });
    state.setSwarmBucket("swarm-test", {
      bucketContainerId: "bucket-container",
      auditContainerId: "audit-container",
      endpoint: "http://bucket:9000",
    });
    const agent = state.addAgent({
      id: "swarm-test:agent-1",
      swarmId: "swarm-test",
      ordinal: 1,
      containerId: "agent-container",
    });
    const run = state.startRun("swarm-test", agent.id, 1);
    state.finishRun(run, { exitCode: 0 });
    state.close();

    state = StateStore.open(dir);
    const swarm = state.getSwarm("swarm-test");
    expect(swarm?.repoUrl).toBe("https://example.com/repo.git");
    expect(swarm?.timeoutMs).toBe(3_600_000);
    expect(swarm?.bucketEndpoint).toBe("http://bucket:9000");
    expect(state.listAgents("swarm-test")).toHaveLength(1);
    expect(state.getOpenRun(agent.id, 1)).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, "swarms", "swarm-test", "state.json"), "utf8")).version).toBe(1);
    state.close();
  });
});
