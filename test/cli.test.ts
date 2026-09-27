import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CLI argument validation", () => {
  it("rejects unknown options instead of silently using defaults", async () => {
    await expect(run(process.execPath, [
      "--import", "tsx",
      resolve("src/cli.ts"),
      "init", "--goal", "test", "--repo", "https://example.com/repo.git", "--timeot-ms", "3600000",
    ])).rejects.toMatchObject({ stderr: expect.stringContaining("unknown option '--timeot-ms'") });
  });

  it("requires one repository URL and validates context directories", async () => {
    await expect(run(process.execPath, [
      "--import", "tsx", resolve("src/cli.ts"), "init", "--goal", "test",
    ])).rejects.toMatchObject({ stderr: expect.stringContaining("init needs --repo URL") });
    await expect(run(process.execPath, [
      "--import", "tsx", resolve("src/cli.ts"), "init", "--goal", "test",
      "--repo", "https://example.com/repo.git", "--context", "missing-context",
    ])).rejects.toMatchObject({ stderr: expect.stringContaining("--context is not a directory") });
  });

  it("rejects the removed board interface", async () => {
    await expect(run(process.execPath, [
      "--import", "tsx",
      resolve("src/cli.ts"),
      "board", "swarm-test",
    ])).rejects.toMatchObject({ stderr: expect.stringContaining("unknown command 'board'") });
  });

  it("accepts common options before the swarm id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-swarm-cli-"));
    dirs.push(dir);
    const dataDir = join(dir, "data");
    await expect(run(process.execPath, [
      "--import", "tsx",
      resolve("src/cli.ts"),
      "agents", "--data-dir", dataDir, "swarm-missing",
    ])).rejects.toMatchObject({ stderr: expect.stringContaining("unknown swarm 'swarm-missing'") });
  });
});
