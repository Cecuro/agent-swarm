import { resolve } from "node:path";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

describe("managed Pi runtime", () => {
  it("loads the normal Pi base resources plus the standard subagent extension", async () => {
    const agentDir = resolve("runtime/pi-config");
    const loader = new DefaultResourceLoader({
      cwd: resolve("."),
      agentDir,
      settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
      noContextFiles: true,
      additionalExtensionPaths: [
        resolve("node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts"),
      ],
    });

    await loader.reload();

    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().extensions).toHaveLength(2);
    expect(loader.getAppendSystemPrompt().join("\n")).toContain("## Swarm environment");
  });
});
