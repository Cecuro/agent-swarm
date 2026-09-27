#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const [vaultName, envFile = ".env"] = process.argv.slice(2);
if (!vaultName) throw new Error("usage: push-secrets VAULT_NAME [ENV_FILE]");
process.loadEnvFile(resolve(envFile));
loadPiAzureCredential();
if (!process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_BASE_URL) {
  process.env.AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_BASE_URL;
}
if (!process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_KEY) {
  process.env.AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_KEY;
}

const secrets = new Map([
  ["azure-openai-api-key", "AZURE_OPENAI_API_KEY"],
  ["azure-openai-endpoint", "AZURE_OPENAI_ENDPOINT"],
  ["azure-openai-deployment-name-map", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP"],
  ["azure-openai-api-version", "AZURE_OPENAI_API_VERSION"],
]);

for (const [secretName, environmentName] of secrets) {
  const value = process.env[environmentName];
  if (!value) continue;
  const result = spawnSync("az", [
    "keyvault", "secret", "set",
    "--vault-name", vaultName,
    "--name", secretName,
    "--value", value,
    "--output", "none",
  ], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`could not store ${environmentName}`);
  process.stdout.write(`Stored ${environmentName} as ${secretName}.\n`);
}

function loadPiAzureCredential() {
  const path = join(homedir(), ".pi", "agent", "auth.json");
  if (!existsSync(path)) return;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const credential = parsed["azure-openai-responses"];
  if (!credential || credential.type !== "api_key" || !credential.key) return;
  process.env.AZURE_OPENAI_API_KEY ||= credential.key;
  for (const [name, value] of Object.entries(credential.env ?? {})) {
    if (typeof value === "string" && value) process.env[name] ||= value;
  }
}
