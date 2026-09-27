import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
const processes: ChildProcess[] = [];

afterEach(() => {
  for (const process of processes.splice(0)) process.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bucket audit sink", () => {
  it("persists authenticated MinIO events as JSONL", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-swarm-audit-"));
    dirs.push(root);
    const output = join(root, "audit.jsonl");
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const child = spawn(process.execPath, [resolve("runtime/audit-server.mjs")], {
      env: {
        ...process.env,
        SWARM_AUDIT_PORT: String(port),
        SWARM_AUDIT_TOKEN: "test-token",
        SWARM_AUDIT_PATH: output,
      },
      stdio: "ignore",
    });
    processes.push(child);
    const url = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        if ((await fetch(`${url}/health`)).ok) break;
      } catch {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
    }

    const response = await fetch(`${url}/audit`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ api: { name: "PutObject", bucket: "swarm-test", object: "result.md" } }),
    });
    expect(response.status).toBe(200);
    expect(readFileSync(output, "utf8").trim()).toBe(
      JSON.stringify({ api: { name: "PutObject", bucket: "swarm-test", object: "result.md" } }),
    );
  });
});
