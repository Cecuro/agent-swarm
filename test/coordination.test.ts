import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCoordinationClient } from "../runtime/coordination.mjs";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("S3-backed swarm coordination", () => {
  it("lists the roster and routes broadcasts and direct messages with independent cursors", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarm-coordination-"));
    dirs.push(root);
    const store = memoryStore();
    const roster = [
      { id: "agent-1", status: "running", generation: 1 },
      { id: "agent-2", status: "paused", generation: 0 },
      { id: "agent-3", status: "paused", generation: 0 },
    ];
    const agent1 = createCoordinationClient({ bucket: "test", worker: "agent-1", roster, store, cursorRoot: root });
    const agent2 = createCoordinationClient({ bucket: "test", worker: "agent-2", roster, store, cursorRoot: root });
    const agent3 = createCoordinationClient({ bucket: "test", worker: "agent-3", roster, store, cursorRoot: root });

    await expect(agent2.listAgents()).resolves.toMatchObject({ self: "agent-2", total: 3, agents: roster });
    await agent1.sendMessage({ body: "I am checking liquidation", tags: ["working"] });
    await agent1.sendMessage({ to: ["agent-2"], body: "Can you validate this path?", tags: ["question"] });
    await agent3.sendMessage({ to: ["agent-1"], body: "Private note for agent 1" });

    const first = await agent2.readMessages();
    expect(first.messages.map((message: { body: string }) => message.body)).toEqual([
      "I am checking liquidation",
      "Can you validate this path?",
    ]);
    await expect(agent2.readMessages()).resolves.toMatchObject({ messages: [], text: "No unread messages." });

    const agent1Messages = await agent1.readMessages();
    expect(agent1Messages.messages.map((message: { body: string }) => message.body)).toEqual([
      "I am checking liquidation",
      "Can you validate this path?",
      "Private note for agent 1",
    ]);
    const history = await agent2.readMessages({ all: true });
    expect(history.messages).toHaveLength(2);
  });

  it("does not lose later unread messages when a read limit is used", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarm-coordination-limit-"));
    dirs.push(root);
    const store = memoryStore();
    const sender = createCoordinationClient({ bucket: "test", worker: "agent-1", roster: ["agent-1", "agent-2"], store, cursorRoot: root });
    const reader = createCoordinationClient({ bucket: "test", worker: "agent-2", roster: ["agent-1", "agent-2"], store, cursorRoot: root });

    await sender.sendMessage({ body: "one" });
    await sender.sendMessage({ body: "two" });
    await sender.sendMessage({ body: "three" });

    expect((await reader.readMessages({ limit: 2 })).messages.map((message: { body: string }) => message.body)).toEqual([
      "one",
      "two",
    ]);
    expect((await reader.readMessages()).messages.map((message: { body: string }) => message.body)).toEqual(["three"]);
  });
});

function memoryStore() {
  const objects = new Map<string, string>();
  return {
    async list(prefix: string) {
      return [...objects.keys()].filter((key) => key.startsWith(prefix));
    },
    async get(key: string) {
      const value = objects.get(key);
      if (value === undefined) throw new Error(`missing object ${key}`);
      return value;
    },
    async put(key: string, value: string) {
      objects.set(key, value);
    },
  };
}
