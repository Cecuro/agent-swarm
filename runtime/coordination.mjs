import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MESSAGE_PREFIX = "coordination/messages/";
const DEFAULT_CURSOR_ROOT = "/workspace/swarm/coordination/cursors";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGES_PER_READ = 100;
let lastMessageTimestamp = 0;

export function createCoordinationClient(options = {}) {
  const env = options.env ?? process.env;
  const bucket = options.bucket ?? env.SWARM_BUCKET;
  const worker = options.worker ?? env.SWARM_WORKER_ID ?? env.SWARM_AGENT_ID;
  if (!bucket) throw new Error("SWARM_BUCKET is not set");
  if (!worker) throw new Error("SWARM_WORKER_ID or SWARM_AGENT_ID is not set");

  const store = options.store ?? createS3Store({ bucket, env });
  const cursorRoot = options.cursorRoot ?? DEFAULT_CURSOR_ROOT;
  const roster = parseRoster(options.roster ?? env.SWARM_AGENT_ROSTER);

  return {
    async listAgents() {
      return {
        self: worker,
        total: roster.length,
        agents: roster,
      };
    },

    async sendMessage(input) {
      const body = input?.body?.trim();
      if (!body) throw new Error("message body is required");
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        throw new Error("message body exceeds 16 KiB");
      }
      const to = normalizeRecipients(input.to);
      const tags = normalizeTags(input.tags);
      const timestamp = nextMessageTimestamp();
      const id = `${timestamp.toString().padStart(13, "0")}-${randomUUID()}`;
      const message = {
        id,
        from: worker,
        to,
        body,
        tags,
        replyTo: input.replyTo?.trim() || null,
        createdAt: new Date(timestamp).toISOString(),
      };
      await store.put(`${MESSAGE_PREFIX}${id}.json`, `${JSON.stringify(message)}\n`);
      return message;
    },

    async readMessages(input = {}) {
      const all = input.all === true;
      const limit = positiveLimit(input.limit);
      const keys = (await store.list(MESSAGE_PREFIX)).sort();
      const seen = all ? new Set() : await readCursor(cursorRoot, worker);
      const processed = new Set(seen);
      const messages = [];

      for (const key of keys) {
        const id = key.slice(MESSAGE_PREFIX.length, -".json".length);
        if (!all && seen.has(id)) continue;
        const message = validateMessage(JSON.parse(await store.get(key)), key);
        if (!all) processed.add(message.id);
        if (isRecipient(message, worker)) messages.push(message);
        if (!all && messages.length >= limit) break;
      }

      if (!all) await writeCursor(cursorRoot, worker, processed);
      const selected = all ? messages.slice(-limit) : messages;
      return {
        self: worker,
        messages: selected,
        text: formatMessages(selected),
      };
    },
  };
}

export function createS3Store({ bucket, env = process.env, awsCli = env.SWARM_AWS_CLI ?? "/usr/local/bin/aws" }) {
  const run = async (args, options = {}) => {
    const result = await execFileAsync(awsCli, args, {
      env,
      encoding: options.encoding ?? "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout;
  };

  return {
    async list(prefix) {
      const output = await run([
        "s3api",
        "list-objects-v2",
        "--bucket",
        bucket,
        "--prefix",
        prefix,
        "--output",
        "json",
      ]);
      const result = JSON.parse(output || "{}");
      return (result.Contents ?? []).map((entry) => entry.Key).filter(Boolean);
    },
    async get(key) {
      return run(["s3", "cp", `s3://${bucket}/${key}`, "-"]);
    },
    async put(key, body) {
      const directory = await mkdtemp(join(tmpdir(), "swarm-message-"));
      const path = join(directory, "message.json");
      try {
        await writeFile(path, body, { encoding: "utf8", mode: 0o600 });
        await run(["s3", "cp", path, `s3://${bucket}/${key}`]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

export function formatMessages(messages) {
  if (messages.length === 0) return "No unread messages.";
  return messages
    .map((message) => {
      const tags = message.tags.map((tag) => `#${tag}`).join(" ");
      const recipients = message.to.join(",");
      const lines = [`[${message.id}] ${message.from} -> ${recipients}${tags ? ` ${tags}` : ""}`, message.body];
      if (message.replyTo) lines.push(`reply-to: ${message.replyTo}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function parseRoster(value) {
  if (!value) return [];
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new Error("SWARM_AGENT_ROSTER must be valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("SWARM_AGENT_ROSTER must be an array");
  return parsed.map((entry) => {
    if (typeof entry === "string") return { id: entry };
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      throw new Error("each roster entry must contain an agent id");
    }
    return {
      id: entry.id,
      ...(typeof entry.status === "string" ? { status: entry.status } : {}),
      ...(Number.isInteger(entry.generation) ? { generation: entry.generation } : {}),
    };
  });
}

function normalizeRecipients(value) {
  const recipients = value === undefined ? ["all"] : value;
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error("to must contain at least one recipient");
  }
  return [...new Set(recipients.map((recipient) => {
    if (typeof recipient !== "string" || !recipient.trim()) throw new Error("recipients must be non-empty strings");
    return recipient.trim();
  }))];
}

function normalizeTags(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("tags must be an array");
  return [...new Set(value.map((tag) => {
    if (typeof tag !== "string" || !tag.trim() || tag.length > 100) throw new Error("tags must be short strings");
    return tag.trim();
  }))];
}

function positiveLimit(value) {
  if (value === undefined) return MAX_MESSAGES_PER_READ;
  if (!Number.isInteger(value) || value < 1 || value > MAX_MESSAGES_PER_READ) {
    throw new Error(`limit must be an integer from 1 to ${MAX_MESSAGES_PER_READ}`);
  }
  return value;
}

function nextMessageTimestamp() {
  lastMessageTimestamp = Math.max(Date.now(), lastMessageTimestamp + 1);
  return lastMessageTimestamp;
}

function validateMessage(message, key) {
  if (
    !message ||
    typeof message !== "object" ||
    typeof message.id !== "string" ||
    typeof message.from !== "string" ||
    !Array.isArray(message.to) ||
    typeof message.body !== "string" ||
    !Array.isArray(message.tags)
  ) {
    throw new Error(`invalid coordination message at ${key}`);
  }
  return message;
}

function isRecipient(message, worker) {
  return message.to.includes("all") || message.to.includes(worker) || message.from === worker;
}

function cursorPath(root, worker) {
  return join(root, `${worker.replaceAll(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

async function readCursor(root, worker) {
  try {
    const value = JSON.parse(await readFile(cursorPath(root, worker), "utf8"));
    return new Set(Array.isArray(value.seen) ? value.seen.filter((id) => typeof id === "string") : []);
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
}

async function writeCursor(root, worker, seen) {
  await mkdir(root, { recursive: true });
  await writeFile(cursorPath(root, worker), `${JSON.stringify({ seen: [...seen] })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
