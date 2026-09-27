#!/usr/bin/env node

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";

const port = positiveInteger(process.env.SWARM_AUDIT_PORT ?? "4318", "SWARM_AUDIT_PORT");
const token = requiredEnv("SWARM_AUDIT_TOKEN");
const outputPath = process.env.SWARM_AUDIT_PATH ?? "/workspace/swarm/audit/audit.jsonl";

mkdirSync(dirname(outputPath), { recursive: true });
const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200).end("ok\n");
      return;
    }
    if (request.method !== "POST" || request.url !== "/audit") {
      response.writeHead(404).end("not found\n");
      return;
    }
    const authorization = request.headers.authorization ?? "";
    if (authorization !== token && authorization !== `Bearer ${token}`) {
      response.writeHead(401).end("unauthorized\n");
      return;
    }
    const body = await requestBody(request, 16 * 1024 * 1024);
    const payload = JSON.parse(body);
    for (const event of Array.isArray(payload) ? payload : [payload]) {
      appendFileSync(outputPath, `${JSON.stringify(event)}\n`, "utf8");
    }
    response.writeHead(200).end("ok\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    response.writeHead(400).end("invalid audit event\n");
  }
});

server.listen(port, "0.0.0.0", () => {
  if (process.env.SWARM_AUDIT_READY_PATH) {
    writeFileSync(process.env.SWARM_AUDIT_READY_PATH, `${process.pid}\n`, "utf8");
  }
});

async function requestBody(request, maximumBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) throw new Error("audit request is too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
